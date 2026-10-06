import { _Transaction } from './interfaces-private';
import { Map as ImMap, Set as ImSet } from 'immutable';
import { NotSupported, QueryError } from './interfaces';

export class Transaction implements _Transaction {
    private origData: ImMap<symbol, any>;
    private transientData: any = {};
    /** named savepoints → the data snapshot captured when they were declared.
     * insertion order matters: rolling back to / releasing one discards later ones */
    private savepoints = new Map<string, ImMap<symbol, any>>();

    static root() {
        return new Transaction(null, ImMap());
    }

    get isChild() {
        return !!this.parent;
    }

    aborted = false;

    /** puts the schema back as it was before this transaction's first DDL (see schema-snapshot.ts) */
    schemaRestore?: () => void;

    /**
     * Called before a DDL statement runs in this transaction: this transaction and every enclosing
     * one that has not seen DDL yet record the current schema, so whichever of them rolls back
     * restores it. They all share one capture - the schema is the same for all of them right now.
     */
    checkpointSchema(capture: () => () => void): void {
        let restore: (() => void) | undefined;
        for (let x: Transaction | null = this; x && x.isChild; x = x.parent) {
            if (!x.schemaRestore) {
                x.schemaRestore = restore ??= capture();
            }
        }
    }

    /** the BEGIN block this transaction belongs to, if any */
    get explicitBlock(): Transaction | null {
        for (let x: Transaction | null = this; x; x = x.parent) {
            if (x.explicit) {
                return x;
            }
        }
        return null;
    }

    get inExplicitBlock(): boolean {
        return this.explicit || !!this.parent?.inExplicitBlock;
    }

    /**
     * When this transaction started - what now(), current_timestamp and current_date return for
     * its whole lifetime in postgres. A transaction forked from root starts now; nested ones
     * (BEGIN inside the implicit transaction of a call, savepoint-like children) inherit it.
     */
    readonly startedAt: Date;

    private constructor(private parent: Transaction | null, private data: ImMap<symbol, any>, private explicit = false) {
        this.origData = data;
        this.startedAt = parent?.isChild ? parent.startedAt : new Date();
    }


    clone() {
        return new Transaction(null, this.data);
    }

    fork(explicit = false): _Transaction {
        return new Transaction(this, this.data, explicit);
    }

    commit(): _Transaction {
        if (!this.parent) {
            return this;
        }
        if (this.parent.data !== this.origData) {
            // the parent moved on while we were open - e.g. CREATE SCHEMA registers its catalogue
            // tables straight into root. Rebase our changes onto it, key by key; only the same
            // key changed on both sides is a real conflict.
            let merged = this.parent.data;
            for (const [k, v] of this.data) {
                if (this.origData.get(k) === v) {
                    continue;
                }
                if (merged.get(k) !== this.origData.get(k)) {
                    throw new NotSupported('Concurrent transactions');
                }
                merged = merged.set(k, v);
            }
            for (const k of this.origData.keys()) {
                if (!this.data.has(k)) {
                    merged = merged.delete(k);
                }
            }
            this.parent.data = merged;
            return this.parent;
        }
        this.parent.data = this.data;
        return this.parent;
    }

    fullCommit() {
        const ret = this.commit();
        return ret.isChild
            ? ret.fullCommit()
            : ret;
    }

    rollback() {
        this.schemaRestore?.();
        return this.parent ?? this;
    }

    /** the outermost transaction of this call or block: discarding it undoes everything */
    discardAll(): void {
        let outer: Transaction | null = null;
        for (let x: Transaction | null = this; x && x.isChild; x = x.parent) {
            if (x.schemaRestore) {
                outer = x;
            }
        }
        outer?.schemaRestore?.();
    }

    savepoint(name: string, captureSchema?: () => () => void): void {
        // re-declaring a name captures the current state under it (postgres hides the
        // older savepoint of the same name; we simply overwrite - close enough for v1)
        this.savepoints.set(name, this.data);
        if (captureSchema) {
            this.savepointSchemas.set(name, captureSchema());
        }
    }

    private savepointSchemas = new Map<string, () => void>();

    rollbackTo(name: string): void {
        const saved = this.savepoints.get(name);
        if (saved === undefined) {
            throw new QueryError(`savepoint "${name}" does not exist`);
        }
        this.savepointSchemas.get(name)?.();
        this.data = saved;
        // the savepoint survives (can be rolled back to again), but any savepoints
        // established after it are discarded
        this.discardSavepointsAfter(name, false);
    }

    release(name: string): void {
        if (!this.savepoints.has(name)) {
            throw new QueryError(`savepoint "${name}" does not exist`);
        }
        this.discardSavepointsAfter(name, true);
    }

    private discardSavepointsAfter(name: string, inclusive: boolean): void {
        let reached = false;
        for (const k of [...this.savepoints.keys()]) {
            if (k === name) {
                reached = true;
                if (inclusive) {
                    this.savepoints.delete(k);
                }
                continue;
            }
            if (reached) {
                this.savepoints.delete(k);
            }
        }
    }

    delete(identity: symbol): void {
        this.data = this.data.delete(identity);
    }

    set<T>(identity: symbol, data: T): T {
        this.data = this.data.set(identity, data);
        return data;
    }

    get<T>(identity: symbol): T {
        return this.data.get(identity);
    }

    getMap<T extends ImMap<any, any>>(identity: symbol): T {
        let got = this.data.get(identity);
        if (!got) {
            this.data = this.data.set(identity, got = ImMap());
        }
        return got as any as T;
    }

    getSet<T>(identity: symbol): ImSet<T> {
        let got = this.data.get(identity);
        if (!got) {
            this.data = this.data.set(identity, got = ImSet());
        }
        return got as any;
    }

    setTransient<T>(identity: symbol, data: T): T {
        this.transientData[identity] = data as any;
        return data;
    }

    /** Set transient data, which will only exist within the scope of the current statement */
    getTransient<T>(identity: symbol): T {
        return this.transientData[identity] as T;
    }

    clearTransientData(): void {
        this.transientData = {};
    }
}
