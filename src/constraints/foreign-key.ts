import { ISubscription, NotSupported, QueryError, DataType } from '../interfaces';
import { Expr, ExprBinary, TableConstraintForeignKey } from 'pgsql-ast-parser';
import { asTable, CreateIndexColDef, _IConstraint, _ITable, _IType, _Transaction } from '../interfaces-private';
import { nullIsh } from '../utils';
import { deferCheck } from '../execution/deferred-checks';
import { enqueueRi } from '../execution/ri-queue';
import { typeCategory } from '../datatypes';

export class ForeignKey implements _IConstraint {

    /** Marks this constraint as a foreign key for the catalogues, without an instanceof import. */
    readonly constraintKind = 'foreign key' as const;

    private unsubs: ISubscription[] = [];

    private table!: _ITable;
    private foreignTable!: _ITable;

    /**
     * The FK's shape, kept for the catalogues.
     *
     * install() has all of this in hand but previously discarded it, which is why
     * information_schema.table_constraints and referential_constraints reported no foreign keys at
     * all — the constraint worked, it was just invisible to anything introspecting the schema.
     */
    localColumns: string[] = [];
    foreignColumns: string[] = [];
    onDelete: string = 'NO ACTION';
    onUpdate: string = 'NO ACTION';
    matchType: string = 'NONE';



    get db() {
        return this.table.ownerSchema.db;
    }

    get schema() {
        return this.table.ownerSchema;
    }

    /** Names for the catalogues — the tables themselves are private. */
    get tableName() {
        return this.table.name;
    }

    get foreignTableName() {
        return this.foreignTable.name;
    }

    /** The referenced table, for dependency checks (DROP TABLE / DROP COLUMN refuse to orphan this FK). */
    get referencedTable(): _ITable {
        return this.foreignTable;
    }


    constructor(readonly name: string) {
    }

    install(_t: _Transaction, cst: TableConstraintForeignKey, table: _ITable) {
        const ftable = asTable(table.ownerSchema.getObject(cst.foreignTable, { beingCreated: table }));
        const cols = cst.localColumns.map(x => table.getColumnRef(x.name));
        const fcols = cst.foreignColumns.map(x => ftable.getColumnRef(x.name));
        this.table = table;
        this.foreignTable = ftable;
        this.localColumns = cst.localColumns.map(x => x.name);
        this.foreignColumns = cst.foreignColumns.map(x => x.name);
        // Postgres spells these out in referential_constraints; 'no action' is the default.
        this.onDelete = (cst.onDelete ?? 'no action').toUpperCase();
        this.onUpdate = (cst.onUpdate ?? 'no action').toUpperCase();
        this.matchType = (cst.match ?? 'simple').toUpperCase() === 'SIMPLE' ? 'NONE' : (cst.match ?? 'simple').toUpperCase();
        if (cols.length !== fcols.length) {
            throw new QueryError('Foreign key count mismatch');
        }
        cols.forEach((c, i) => {
            // postgres needs an equality operator between the two types: varchar -> text and
            // int -> bigint are fine (the checks below compare through typed expressions),
            // text -> uuid is not
            const lt = c.expression.type, ft = fcols[i].expression.type;
            const category = typeCategory(lt);
            const compatible = lt === ft || lt.primary === ft.primary || (!!category && category === typeCategory(ft));
            if (!compatible) {
                throw new QueryError(`foreign key constraint "${this.name}" cannot be implemented: key columns "${cst.localColumns[i].name}" and "${cst.foreignColumns[i].name}" are of incompatible types: ${lt.name} and ${ft.name}`, '42804');
            }
        });

        if ((cst.match ?? 'simple') !== 'simple' && cols.length !== 1) {
            throw new NotSupported(`matching mode '${cst.match}' on mutliple columns foreign keys`);
        }

        // check that there is an unique index on this table for the given expressions
        const findex = ftable.getIndex(...fcols.map(x => x.expression));
        if (!findex?.unique) {
            throw new QueryError(`there is no unique constraint matching given keys for referenced table "${ftable.name}"`);
        }


        // auto-create indices
        if (this.db.options.autoCreateForeignKeyIndices) {
            table.createIndex(_t, {
                ifNotExists: true,
                columns: cols.map<CreateIndexColDef>(x => ({
                    value: x.expression,
                })),
            });
        }

        // ========================
        // when changing the foreign table key, check correspondances in this table
        // ========================
        const onUpdate = cst.onUpdate ?? 'no action';
        const onDelete = cst.onDelete ?? 'no action';
        this.unsubs.push(ftable.onBeforeChange(cst.foreignColumns.map(x => x.name), (old, neu, dt) => {
            if (!old) {
                return;
            }
            const oVals = fcols.map((x, i) => toType(old[x.expression.id!], x.expression.type, cols[i].expression.type));
            if (oVals.some(nullIsh)) {
                return;
            }
            // build foreign key equality expression
            const equals = cst.localColumns.map<ExprBinary>((x, i) => ({
                type: 'binary',
                op: '=',
                left: { type: 'ref', name: x.name, table: { name: table.name } },
                // hack, see #fkcheck
                right: {
                    type: 'constant',
                    value: oVals[i],
                    dataType: cols[i].expression.type as any, // hack (value already in this type)
                },
            }));
            const expr = equals.slice(1).reduce<Expr>((a, b) => ({
                type: 'binary',
                op: 'AND',
                left: a,
                right: b,
            }), equals[0]);

            // check nothing matches - as a queued RI action, see ri-queue.ts
            enqueueRi(() => {
            for (const local of [...table.selection.filter(expr).enumerate(dt)]) {
                // ====== ON DELETE
                switch (neu ? onUpdate : onDelete) {
                    case 'no action':
                    case 'restrict':
                        throw new QueryError(`update or delete on table "${ftable.name}" violates foreign key constraint "${this.name}" on table "${table.name}"`, '23503');
                    case 'cascade':
                        if (neu) {
                            for (let i = 0; i < fcols.length; i++) {
                                local[cst.localColumns[i].name] = neu[cst.foreignColumns[i].name];
                            }
                            table.update(dt, local);
                        } else {
                            table.delete(dt, local);
                        }
                        break;
                    case 'set default':
                    case 'set null':
                        for (const c of cst.localColumns) {
                            local[c.name] = null;
                        }
                        table.update(dt, local);
                        break;
                }
            }
            });
        }));

        // =====================
        //  when changing something in this table,
        //  then there must be a key match in the foreign table
        // =====================
        // DEFERRABLE INITIALLY DEFERRED postpones this existence check to commit time
        const deferred = !!cst.deferrable && !!cst.initiallyDeferred;
        this.unsubs.push(table.onBeforeChange(cst.localColumns.map(x => x.name), (_, neu, dt) => {
            if (!neu) {
                return;
            }
            const vals = cols.map((x, i) => toType((neu as any)[x.expression.id!], x.expression.type, fcols[i].expression.type));
            if (vals.some(nullIsh)) {
                return;
            }
            // build foreign key equality expression
            const equals = cst.foreignColumns.map<ExprBinary>((x, i) => ({
                type: 'binary',
                op: '=',
                left: { type: 'ref', name: x.name, table: { name: ftable.name } },
                // hack, see #fkcheck
                right: {
                    type: 'constant',
                    value: vals[i],
                    dataType: fcols[i].expression.type as any, // hack (value already in this type)
                },
            }));
            const expr = equals.slice(1).reduce<Expr>((a, b) => ({
                type: 'binary',
                op: 'AND',
                left: a,
                right: b,
            }), equals[0]);

            const check = (checkT: _Transaction) => {
                let yielded = false;
                for (const _ of ftable.selection.filter(expr).enumerate(checkT)) {
                    yielded = true;
                }
                if (!yielded) {
                    throw new QueryError(`insert or update on table "${table.name}" violates foreign key constraint "${this.name}"`, '23503');
                }
            };
            if (deferred) {
                deferCheck(dt, check);
            } else {
                check(dt);
            }
        }));


        // =====================
        //  prevent foreign table from being dropped
        // =====================
        this.unsubs.push(ftable.onDrop((t, cascade) => {
            //  (todo implement multiple drops)
            if (cascade) {
                this.uninstall(t);
            } else {
                throw new QueryError({
                    error: `cannot drop table "${ftable.name}" because other objects depend on it`,
                    details: `constraint ${this.name} on table ${table.name} depends on table "${ftable.name}"`,
                    hint: `Use DROP ... CASCADE to drop the dependent objects too.`,
                });
            }
        }));

        // =====================
        //  prevent foreign table truncation
        // =====================
        this.unsubs.push(ftable.onTruncate((t, { cascade }) => {
            if (cascade) {
                this.table.truncate(t, { cascade: true });
                return;
            }
            throw new QueryError({
                error: `cannot truncate a table referenced in a foreign key constraint`,
                details: `Table "${table.name}" references "${ftable.name}".`,
                hint: `HINT:  Truncate table "${table.name}" at the same time, or use TRUNCATE ... CASCADE.`,
            })
        }));

        // =====================
        //  when this table is dropped => remove hooks on foreign table
        // =====================
        table.onDrop(dt => {
            this.uninstall(dt);
        });

        return this;
    }

    /** set by the owning table: drops this FK from its constraint list (and so the catalogues) */
    onUninstalled?: () => void;

    uninstall(t: _Transaction): void {
        this.unsubs.forEach(x => x.unsubscribe());
        this.unsubs = [];
        // also when uninstalled from the other side (DROP TABLE <referenced> CASCADE), not only
        // via the table's own ConstraintWrapper - or the catalogues keep listing a dead FK
        this.onUninstalled?.();
    }
}

/**
 * A key value converted between the two (compatible) column types: they share a category, so
 * only the numeric representation can differ - integer/float are JS numbers, bigint/numeric
 * digit strings (bigint '1' <-> integer 1). Strings and dates are held the same way.
 */
function toType(value: any, from: _IType, to: _IType): any {
    if (nullIsh(value) || from === to || from.primary === to.primary) {
        return value;
    }
    switch (to.primary) {
        case DataType.integer:
        case DataType.float:
            return typeof value === 'number' ? value : Number(value);
        case DataType.bigint:
        case DataType.decimal:
            return typeof value === 'string' ? value : String(value);
    }
    return value;
}
