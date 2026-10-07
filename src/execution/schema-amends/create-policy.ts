import { _ISchema, _Transaction, _ITable, _IStatementExecutor, asTable, StatementResult, _IStatement, QueryError, DataType, nil } from '../../interfaces-private';
import { CreatePolicyStatement, DropPolicyStatement, Expr } from 'pgsql-ast-parser';
import { ignore } from '../../utils';
import { ExecHelper } from '../exec-utils';
import { buildValue } from '../../parser/expression-builder';
import { withSelection } from '../../parser/context';
import { assertRolesExist } from '../roles';

export class CreatePolicy extends ExecHelper implements _IStatementExecutor {
    private table: _ITable;

    constructor({ schema }: _IStatement, private p: CreatePolicyStatement) {
        super(p);
        this.table = asTable(schema.getObject(p.table));
        const cmd = p.for ?? 'all';
        if (cmd === 'insert' && p.using) {
            throw new QueryError('only WITH CHECK expression allowed for INSERT', '42601');
        }
        if ((cmd === 'select' || cmd === 'delete') && p.withCheck) {
            throw new QueryError('WITH CHECK cannot be applied to SELECT or DELETE', '42601');
        }
        // Postgres binds the predicates at CREATE POLICY: an unknown column, an operator that
        // does not exist for the operand types (auth.uid() = <text column>) or a non-boolean
        // predicate fails here, not on the first query. Compile them now to fail the same way;
        // enforcement recompiles them from the stored AST.
        const check = (expr: Expr | nil, clause: string) => {
            if (!expr) {
                return;
            }
            const v = withSelection(this.table.selection, () => buildValue(expr));
            if (v.type.primary !== DataType.bool && v.type.primary !== DataType.null) {
                throw new QueryError(`argument of POLICY ${clause} must be type boolean, not type ${v.type.name}`, '42804');
            }
        };
        check(p.using, 'USING');
        check(p.withCheck, 'WITH CHECK');
        ignore(p.using);
        ignore(p.withCheck);
        p.roles?.forEach(ignore);
    }

    execute(t: _Transaction): StatementResult {
        assertRolesExist(t, (this.p.roles ?? []).map(r => r.name));
        this.table.createPolicy({
            name: this.p.name.name,
            // postgres default is PERMISSIVE
            permissive: this.p.permissive ?? true,
            command: this.p.for ?? 'all',
            roles: (this.p.roles ?? []).map(r => r.name),
            using: this.p.using ?? null,
            withCheck: this.p.withCheck ?? null,
        });
        return this.noData(t, 'CREATE POLICY');
    }
}

export class DropPolicy extends ExecHelper implements _IStatementExecutor {
    private table: _ITable;

    constructor({ schema }: _IStatement, private p: DropPolicyStatement) {
        super(p);
        this.table = asTable(schema.getObject(p.table));
        ignore(p.ifExists);
    }

    execute(t: _Transaction): StatementResult {
        this.table.dropPolicy(this.p.name.name, !!this.p.ifExists);
        return this.noData(t, 'DROP POLICY');
    }
}
