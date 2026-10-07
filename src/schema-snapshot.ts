import { _IDb } from './interfaces-private';

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

/**
 * Transactional DDL.
 *
 * Row data lives in immutable maps inside the transaction, so rolling it back is just dropping the
 * transaction. Schema objects (tables, columns, constraints, indexes, policies, triggers, functions,
 * types) are mutable objects outside it. To make DDL roll back like it does in postgres - a failed
 * migration leaves no half-created tables - the schema metadata is captured before the first DDL of
 * a transaction and put back if that transaction rolls back.
 *
 * The capture is a copy of each schema object's own properties, with containers (Map, Set, Array,
 * plain object) copied a few levels deep and class instances kept by reference - those that are
 * themselves mutable schema objects are captured in their own right. Objects created after the
 * capture simply drop out of the restored registries.
 */
export function captureSchema(db: _IDb): () => void {
    const restorers: (() => void)[] = [];
    const seen = new Set<any>();
    const capture = (o: any, skip: string[] = []) => {
        if (!o || typeof o !== 'object' || seen.has(o)) {
            return;
        }
        seen.add(o);
        restorers.push(captureProps(o, skip));
    };

    // never part of the schema: row data and the session's open transaction
    capture(db, ['data', 'sessionTx', 'schemaVersion', 'handlers']);
    for (const schema of db.listSchemas()) {
        const s = schema as any;
        // the built-in catalogues (and their hundreds of functions) are not changed by user DDL;
        // skipping them keeps the capture cheap enough to take on every DDL transaction
        if (SYSTEM_SCHEMAS.has(s.name)) {
            continue;
        }
        capture(s, ['fns', 'ops', 'interceptors', 'db']);
        for (const resolver of [s.fns, s.ops]) {
            if (resolver?.snapshot) {
                restorers.push(resolver.snapshot());
            }
        }
        for (const rel of s.relsByNameCas?.values?.() ?? []) {
            capture(rel, ['ownerSchema', 'db']);
            const r = rel as any;
            if (r.type !== 'table') {
                continue;
            }
            capture(r.columnMgr);
            capture(r.columnMgr?.map);
            for (const col of r.columnMgr?.map?.values?.() ?? []) {
                capture(col, ['table']);
            }
            capture(r.rls);
            capture(r.triggers);
            for (const c of r.listConstraints?.() ?? []) {
                capture(c);
                capture(c.wrapped);
            }
        }
    }

    return () => {
        for (const r of restorers) {
            r();
        }
        for (const schema of db.listSchemas()) {
            for (const rel of (schema as any).relsByNameCas?.values?.() ?? []) {
                rel.columnMgr?.invalidateColumns?.();
                rel.selection?.rebuild?.();
            }
        }
        db.onSchemaChange();
    };
}

/** a captured value: containers keep their identity and remember their contents */
type Snap = { ref: any; kind: 'map' | 'set' | 'array' | 'object'; items: [any, Snap][] } | { value: any };

function snap(v: any, depth: number): Snap {
    // a frozen value cannot have changed: keep it by reference
    if (depth < 0 || !v || typeof v !== 'object' || Object.isFrozen(v)) {
        return { value: v };
    }
    if (v instanceof Map) {
        return { ref: v, kind: 'map', items: [...v].map(([k, x]) => [k, snap(x, depth - 1)]) };
    }
    if (v instanceof Set) {
        return { ref: v, kind: 'set', items: [...v].map(x => [null, snap(x, depth - 1)]) };
    }
    if (Array.isArray(v)) {
        return { ref: v, kind: 'array', items: v.map(x => [null, snap(x, depth - 1)]) };
    }
    if (Object.getPrototypeOf(v) === Object.prototype) {
        return { ref: v, kind: 'object', items: Object.keys(v).map(k => [k, snap(v[k], depth - 1)]) };
    }
    return { value: v };
}

/**
 * Put a captured value back, refilling the original container instances in place - other code
 * holds references to them (e.g. ColumnManager binds get/has to its Map), so swapping in copies
 * would orphan those.
 */
function unsnap(s: Snap): any {
    if ('value' in s) {
        return s.value;
    }
    const items = s.items.map(([k, x]) => [k, unsnap(x)] as [any, any]);
    switch (s.kind) {
        case 'map':
            s.ref.clear();
            for (const [k, v] of items) { s.ref.set(k, v); }
            break;
        case 'set':
            s.ref.clear();
            for (const [, v] of items) { s.ref.add(v); }
            break;
        case 'array':
            s.ref.length = 0;
            s.ref.push(...items.map(([, v]) => v));
            break;
        case 'object': {
            const keep = new Set(items.map(([k]) => k));
            for (const k of Object.keys(s.ref)) {
                if (!keep.has(k) && Object.getOwnPropertyDescriptor(s.ref, k)?.configurable) {
                    delete s.ref[k];
                }
            }
            for (const [k, v] of items) {
                if (s.ref[k] !== v && Object.getOwnPropertyDescriptor(s.ref, k)?.writable !== false) {
                    s.ref[k] = v;
                }
            }
            break;
        }
    }
    return s.ref;
}

function captureProps(o: any, skip: string[]): () => void {
    if (o instanceof Map || o instanceof Set) {
        const whole = snap(o, 3);
        return () => { unsnap(whole); };
    }
    const keys = Object.keys(o).filter(k => !skip.includes(k));
    const saved = new Map(keys.map(k => [k, snap(o[k], 3)]));
    return () => {
        for (const k of Object.keys(o)) {
            if (!skip.includes(k) && !saved.has(k) && Object.getOwnPropertyDescriptor(o, k)?.configurable) {
                delete o[k];
            }
        }
        for (const [k, v] of saved) {
            const val = unsnap(v);
            if (o[k] !== val && Object.getOwnPropertyDescriptor(o, k)?.writable !== false) {
                o[k] = val;
            }
        }
    };
}
