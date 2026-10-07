import { _ISchema, _Transaction, SchemaField, NotSupported, _ITable, _IStatementExecutor, asTable, QueryError, _IStatement } from '../../interfaces-private';
import { AlterTableStatement } from 'pgsql-ast-parser';
import { ignore } from '../../utils';
import { ExecHelper } from '../exec-utils';
import { policiesDependingOn } from '../policy-deps';

export class Alter extends ExecHelper implements _IStatementExecutor {

    private table: _ITable;

    constructor({ schema }: _IStatement, private p: AlterTableStatement) {
        super(p);
        this.table = asTable(schema.getObject(p.table));
        ignore(p.only);
    }

    execute(t: _Transaction) {

        let ignored = 0;


        for (const change of this.p.changes) {
            function ignoreChange() {
                ignore(change);
                ignored++;
            }
            switch (change.type) {
                case 'rename':
                    this.table.rename(change.to.name);
                    break;
                case 'add column': {
                    const col = this.table.selection.getColumn(change.column.name.name, true);
                    if (col) {
                        if (change.ifNotExists) {
                            ignoreChange();
                            break;
                        } else {
                            throw new QueryError(`column "${col.id}" of relation "${this.table.name}" already exists`, '42701');
                        }
                    } else {
                        ignore(change.ifNotExists);
                    }
                    this.table.addColumn(change.column, t);
                    break;
                }
                case 'drop column':
                    const col = this.table.getColumnRef(change.column.name, change.ifExists);
                    if (!col) {
                        ignoreChange();
                    } else {
                        // a foreign key into this column, or a policy reading it, depends on it:
                        // postgres refuses unless CASCADE, which drops those dependents too
                        const name = change.column.name;
                        const fks = this.table.referencingForeignKeys?.([name]) ?? [];
                        const policies = policiesDependingOn(this.table, name);
                        if (change.behaviour === 'cascade') {
                            for (const fk of fks) {
                                fk.uninstall(t);
                            }
                            for (const p of policies) {
                                p.table.dropPolicy(p.policy, true);
                            }
                        } else if (fks.length || policies.length) {
                            throw new QueryError({
                                error: `cannot drop column ${name} of table ${this.table.name} because other objects depend on it`,
                                details: [
                                    ...fks.map(fk => `constraint ${fk.name} on table ${fk.tableName} depends on column ${name} of table ${this.table.name}`),
                                    ...policies.map(p => `policy ${p.policy} on table ${p.table.name} depends on column ${name} of table ${this.table.name}`),
                                ].join('\n'),
                                hint: 'Use DROP ... CASCADE to drop the dependent objects too.',
                                code: '2BP01',
                            });
                        }
                        col.drop(t);
                    }
                    break;
                case 'drop constraint':
                    const cst = this.table.getConstraint(change.constraint.name);
                    if (change.ifExists && !cst) {
                        ignoreChange();
                        break;
                    }
                    if (!cst) {
                        throw new QueryError(`constraint "${change.constraint.name}" of relation "${this.table.name}" does not exist`, '42704')
                    }
                    cst.uninstall(t);
                    break;
                case 'rename column':
                    this.table.getColumnRef(change.column.name)
                        .rename(change.to.name, t);
                    break;
                case 'alter column':
                    this.table.getColumnRef(change.column.name)
                        .alter(change.alter, t);
                    break;
                case 'rename constraint':
                    throw new NotSupported('rename constraint');
                case 'add constraint':
                    this; this.table.addConstraint(change.constraint, t);
                    break;
                case 'owner':
                    // owner change statements are not supported.
                    // however, in order to support, pg_dump, we're just ignoring them.
                    ignoreChange();
                    break;
                case 'row level security':
                    this.table.setRowLevelSecurity(change.action);
                    break;
                default:
                    throw NotSupported.never(change, 'alter request');

            }
        }
        return this.noData(t, 'ALTER');
    }
}
