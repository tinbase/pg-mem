import { astVisitor, Expr, SelectFromStatement } from 'pgsql-ast-parser';
import { _ITable, nil } from '../interfaces-private';

/** A column a policy predicate reads. */
export interface ColumnUse {
    table: _ITable;
    column: string;
}

/**
 * The (table, column) pairs a policy's USING / WITH CHECK reads, with SQL scoping: a ref
 * qualified by an alias or table name resolves through the FROM clauses in scope, innermost
 * first; an unqualified one resolves to the innermost table that has the column, the policy's
 * own table being the outermost scope. So in a policy on `scenes`,
 * `exists (select 1 from storyboards s where s.id = storyboard_id)` reads storyboards.id and
 * scenes.storyboard_id - and not scenes.id.
 *
 * Postgres records these as dependencies: the columns cannot be dropped or retyped while the
 * policy exists.
 */
export function policyColumnUses(owner: _ITable, ...exprs: (Expr | nil)[]): ColumnUse[] {
    const schema = owner.ownerSchema;
    const scopes: Map<string, _ITable>[] = [new Map([[owner.name, owner]])];
    const uses: ColumnUse[] = [];

    const hasColumn = (t: _ITable, c: string) => {
        try {
            return !!t.getColumnRef?.(c, true);
        } catch {
            return false;
        }
    };

    const visitor = astVisitor(v => ({
        selection: (s: SelectFromStatement) => {
            const scope = new Map<string, _ITable>();
            for (const f of s.from ?? []) {
                if (f.type !== 'table') {
                    continue;
                }
                const t = schema.getObject(f.name, { nullIfNotFound: true }) as _ITable | nil;
                if (t && (t as any).type === 'table') {
                    scope.set(f.name.alias ?? f.name.name, t);
                }
            }
            scopes.push(scope);
            try {
                v.super().selection(s);
            } finally {
                scopes.pop();
            }
            return s;
        },
        ref: r => {
            if (r.name === '*') {
                return r;
            }
            for (let i = scopes.length - 1; i >= 0; i--) {
                if (r.table) {
                    const t = scopes[i].get(r.table.name);
                    if (t) {
                        uses.push({ table: t, column: r.name });
                        return r;
                    }
                    continue;
                }
                for (const t of scopes[i].values()) {
                    if (hasColumn(t, r.name)) {
                        uses.push({ table: t, column: r.name });
                        return r;
                    }
                }
            }
            return r;
        },
    }));

    for (const e of exprs) {
        if (e) {
            visitor.expr(e);
        }
    }
    return uses;
}

/** Policies, on any table of the db, that read `table.column`. */
export function policiesDependingOn(table: _ITable, column: string): { table: _ITable; policy: string }[] {
    const out: { table: _ITable; policy: string }[] = [];
    for (const schema of table.ownerSchema.db.listSchemas()) {
        for (const t of schema.listTables()) {
            for (const p of t.rls?.policies ?? []) {
                if (policyColumnUses(t, p.using, p.withCheck).some(u => u.table === table && u.column === column)) {
                    out.push({ table: t, policy: p.name });
                }
            }
        }
    }
    return out;
}
