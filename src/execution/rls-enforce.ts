import { _ISelection, _ITable, _Transaction, IValue, Row, _Explainer, _SelectExplanation, Stats, QueryError } from '../interfaces-private';
import { FilterBase } from '../transforms/transform-base';
import { Types } from '../datatypes';
import { buildValue } from '../parser/expression-builder';
import { withSelection } from '../parser/context';
import { currentRole } from './roles';
import { Policy, policyAppliesToCommand, policyAppliesToRole } from './rls';
import { astVisitor, Expr, FromTable } from 'pgsql-ast-parser';

export type RlsCommand = 'select' | 'insert' | 'update' | 'delete';

/** tables read in a predicate's subqueries (FROM / JOIN), resolved against the table's schema */
function tablesReadBy(owner: _ITable, exprs: (Expr | null | undefined)[]): _ITable[] {
    const out = new Set<_ITable>();
    const v = astVisitor(() => ({
        fromTable: (f: FromTable) => {
            const obj = owner.ownerSchema.getThisOrSiblingFor(f.name).getObject(f.name, { nullIfNotFound: true });
            if (obj && (obj as any).type === 'table') {
                out.add(obj as _ITable);
            }
            return f;
        },
    }));
    for (const e of exprs) {
        if (e) {
            v.expr(e);
        }
    }
    return [...out];
}

/** does any of these predicates contain a subquery ("sublink")? */
function hasSubLinks(exprs: (Expr | null | undefined)[]): boolean {
    let found = false;
    const v = astVisitor(() => ({ selection: () => { found = true; return null as any; } }));
    for (const e of exprs) {
        if (e && !found) {
            v.expr(e);
        }
    }
    return found;
}

/**
 * Postgres expands the policies of the relations a query touches - and, through the subqueries in
 * those policies, of the relations they read - and refuses a cycle: a profiles policy that queries
 * profiles (the usual "admins can see everyone" attempt) is "infinite recursion detected in policy
 * for relation profiles", for any role RLS applies to and whether or not there are rows.
 *
 * Like its fireRIRrules, a relation joins the set being expanded, and is checked against it, only
 * when its applicable policies contain a subquery: an UPDATE policy reading its own table whose
 * SELECT policy is just `true` is fine. Returns the re-entered relation.
 */
function recursivePolicyRelation(table: _ITable, commands: RlsCommand[], roleName: string, expanding = new Set<_ITable>()): _ITable | null {
    if (!table.rls.enabled) {
        return null;
    }
    const exprs = table.rls.policies
        .filter(p => policyAppliesToRole(p, roleName) && commands.some(c => policyAppliesToCommand(p, c)))
        .flatMap(p => [p.using, p.withCheck]);
    if (!hasSubLinks(exprs)) {
        return null;
    }
    if (expanding.has(table)) {
        return table;
    }
    expanding.add(table);
    try {
        for (const read of tablesReadBy(table, exprs)) {
            // a subquery reads: its table's SELECT policies get expanded
            const hit = recursivePolicyRelation(read, ['select'], roleName, expanding);
            if (hit) {
                return hit;
            }
        }
        return null;
    } finally {
        expanding.delete(table);
    }
}

const recursionCache = new WeakMap<_ITable, Map<string, _ITable | null>>();

/** Throws postgres' error when expanding this table's policies for the current role recurses. */
export function assertNoPolicyRecursion(table: _ITable, command: RlsCommand, t: _Transaction, readsColumns = false): void {
    const role = currentRole(t).name;
    // an UPDATE/DELETE that reads columns (WHERE, RETURNING, SET x = <column>) needs SELECT rights,
    // so the table's SELECT policies are expanded too
    const commands: RlsCommand[] = readsColumns && command !== 'select' ? [command, 'select'] : [command];
    // policies can change (DDL): key the cache on them too
    const key = `${role}|${commands.join(',')}|${(table.ownerSchema.db as any).schemaVersion}`;
    let byKey = recursionCache.get(table);
    if (!byKey) {
        recursionCache.set(table, byKey = new Map());
    }
    let hit = byKey.get(key);
    if (hit === undefined) {
        hit = recursivePolicyRelation(table, commands, role);
        byKey.set(key, hit);
    }
    if (hit) {
        throw new QueryError(`infinite recursion detected in policy for relation "${hit.name}"`, '42P17');
    }
}

/** True when the current role skips RLS entirely (superuser or BYPASSRLS). */
export function bypassesRls(t: _Transaction): boolean {
    const role = currentRole(t);
    return role.superuser || role.bypassRls;
}

interface CompiledPolicy {
    policy: Policy;
    using: IValue | null;
    withCheck: IValue | null;
}

/** Compiles a policy's predicates against the table selection (once, at build time). */
function compilePolicies(selection: _ISelection, policies: Policy[]): CompiledPolicy[] {
    return withSelection(selection, () => policies.map(policy => ({
        policy,
        using: policy.using ? buildValue(policy.using).cast(Types.bool) : null,
        withCheck: policy.withCheck ? buildValue(policy.withCheck).cast(Types.bool) : null,
    })));
}

/**
 * Evaluates whether a row passes the RLS predicates applicable to the current role
 * and command. Permissive policies are OR-combined, restrictive AND-combined:
 *   (perm1 OR perm2 OR ...) AND restr1 AND restr2 ...
 * Returns false (deny) when no permissive policy applies.
 */
function rowPasses(compiled: CompiledPolicy[], kind: 'using' | 'withCheck', roleName: string, command: RlsCommand, row: Row, t: _Transaction): boolean {
    let sawPermissive = false;
    let permissiveOk = false;
    let restrictiveOk = true;
    for (const c of compiled) {
        if (!policyAppliesToRole(c.policy, roleName) || !policyAppliesToCommand(c.policy, command)) {
            continue;
        }
        // WITH CHECK falls back to USING when not specified (postgres behaviour)
        const pred = kind === 'withCheck' ? (c.withCheck ?? c.using) : c.using;
        const val = pred ? !!pred.get(row, t) : true; // no predicate = always true
        if (c.policy.permissive) {
            sawPermissive = true;
            permissiveOk = permissiveOk || val;
        } else {
            restrictiveOk = restrictiveOk && val;
        }
    }
    return sawPermissive && permissiveOk && restrictiveOk;
}

/** tables whose policies are being compiled: a policy subquery reading one of them is a policy recursion */
const compiling = new Set<_ITable>();

/** Runtime read-visibility filter: applied only when RLS is on and the role doesn't bypass. */
class RlsSelection extends FilterBase {
    /** null: built while compiling this table's own policies (recursion, reported at run time) */
    private compiled: CompiledPolicy[] | null;

    get index() {
        return null;
    }

    constructor(private sel: _ISelection, private table: _ITable, private command: RlsCommand, private readsColumns = false) {
        super(sel);
        if (compiling.has(table)) {
            // compiling would recurse forever. Postgres reports this only for the roles whose
            // policies actually recurse, so leave it to assertNoPolicyRecursion at run time.
            this.compiled = null;
            return;
        }
        compiling.add(table);
        try {
            this.compiled = compilePolicies(sel, table.rls.policies);
        } finally {
            compiling.delete(table);
        }
    }

    private policies(): CompiledPolicy[] {
        if (!this.compiled) {
            throw new QueryError(`infinite recursion detected in policy for relation "${this.table.name}"`, '42P17');
        }
        return this.compiled;
    }

    entropy(t: _Transaction) {
        return this.sel.entropy(t);
    }

    stats(): Stats | null {
        return null;
    }

    hasItem(raw: Row, t: _Transaction): boolean {
        if (!this.enforced(t)) {
            return this.sel.hasItem(raw, t);
        }
        // index lookups (WHERE id = …) check rows here rather than enumerating
        assertNoPolicyRecursion(this.table, this.command, t, this.readsColumns);
        return this.sel.hasItem(raw, t)
            && rowPasses(this.policies(), 'using', currentRole(t).name, this.command, raw, t);
    }

    /**
     * WHERE on a policed table. Index-based filters (id = 1, IN, ranges) take their index from the
     * column's origin - the raw table - and become a selection over it, which silently dropped this
     * layer: under RLS, `select * from t where id = 2` returned rows no policy allowed. Filter the
     * unprotected selection (keeping index lookups) and re-apply the policies on top.
     */
    filter(where: Expr | undefined | null): _ISelection {
        if (!where) {
            return this;
        }
        return new RlsSelection(this.sel.filter(where), this.table, this.command, this.readsColumns);
    }

    private enforced(t: _Transaction): boolean {
        return this.table.rls.enabled && !bypassesRls(t);
    }

    *enumerate(t: _Transaction): Iterable<Row> {
        if (!this.enforced(t)) {
            yield* this.sel.enumerate(t);
            return;
        }
        assertNoPolicyRecursion(this.table, this.command, t, this.readsColumns);
        const roleName = currentRole(t).name;
        const compiled = this.policies();
        for (const raw of this.sel.enumerate(t)) {
            if (rowPasses(compiled, 'using', roleName, this.command, raw, t)) {
                yield raw;
            }
        }
    }

    explain(e: _Explainer): _SelectExplanation {
        return {
            id: e.idFor(this),
            _: 'seqFilter',
            filtered: this.sel.explain(e),
        };
    }
}

/** Wrap a table's selection with row-level security read enforcement. */
export function applyReadRls(table: _ITable, selection: _ISelection, command: RlsCommand, readsColumns = false): _ISelection {
    if (!table.rls.policies.length && !table.rls.enabled) {
        return selection;
    }
    return new RlsSelection(selection, table, command, readsColumns);
}

/** does an UPDATE/DELETE read the table's columns (and so need SELECT rights)? */
export function statementReadsColumns(ast: { where?: Expr | null; returning?: any; sets?: { value: Expr }[] }): boolean {
    if (ast.where || ast.returning?.length) {
        return true;
    }
    let found = false;
    const v = astVisitor(() => ({ ref: r => { found = true; return r; } }));
    for (const set of ast.sets ?? []) {
        v.expr(set.value);
    }
    return found;
}

/** Throws if a written row violates the WITH CHECK predicates for a command. */
export function checkWriteRls(table: _ITable, command: 'insert' | 'update', row: Row, t: _Transaction): void {
    if (!table.rls.enabled || bypassesRls(t)) {
        return;
    }
    assertNoPolicyRecursion(table, command, t);
    const compiled = compilePolicies(table.selection, table.rls.policies);
    if (!rowPasses(compiled, 'withCheck', currentRole(t).name, command, row, t)) {
        throw new QueryError(`new row violates row-level security policy for table "${table.name}"`, '42501');
    }
}

/**
 * ON CONFLICT DO UPDATE on an RLS table: the existing row must pass the UPDATE (and, since the
 * statement reads it, SELECT) USING policies. Postgres errors rather than skipping the row.
 */
export function checkConflictUpdateRls(table: _ITable, existing: Row, t: _Transaction): void {
    if (!table.rls.enabled || bypassesRls(t)) {
        return;
    }
    assertNoPolicyRecursion(table, 'update', t, true);
    const compiled = compilePolicies(table.selection, table.rls.policies);
    const role = currentRole(t).name;
    if (!rowPasses(compiled, 'using', role, 'update', existing, t) || !rowPasses(compiled, 'using', role, 'select', existing, t)) {
        throw new QueryError(`new row violates row-level security policy (USING expression) for table "${table.name}"`, '42501');
    }
}
