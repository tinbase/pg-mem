import { _ITable, _IDb, setId, _ISchema } from '../../interfaces-private.ts';
import { Schema } from '../../interfaces.ts';
import { Types } from '../../datatypes/index.ts';
import { ReadOnlyTable } from '../readonly-table.ts';
import { listConstraintRows } from './constraint-rows.ts';

/**
 * information_schema.referential_constraints — one row per foreign key.
 *
 * https://www.postgresql.org/docs/current/infoschema-referential-constraints.html
 *
 * This is where `on delete cascade` becomes readable. Tooling uses `delete_rule` to decide whether a
 * child row disappears with its parent; without the table it has to parse the DDL to find out.
 */
export class ReferentialConstraints extends ReadOnlyTable implements _ITable {

    _schema: Schema = {
        name: 'referential_constraints',
        fields: [
            { name: 'constraint_catalog', type: Types.text() }
            , { name: 'constraint_schema', type: Types.text() }
            , { name: 'constraint_name', type: Types.text() }
            , { name: 'unique_constraint_catalog', type: Types.text() }
            , { name: 'unique_constraint_schema', type: Types.text() }
            , { name: 'unique_constraint_name', type: Types.text() }
            , { name: 'match_option', type: Types.text() }
            , { name: 'update_rule', type: Types.text() }
            , { name: 'delete_rule', type: Types.text() }
        ]
    };

    entropy(): number {
        return 0;
    }

    *enumerate() {
        for (const c of listConstraintRows(this.db)) {
            if (c.type !== 'FOREIGN KEY' || !c.references) {
                continue;
            }
            const ret = {
                constraint_catalog: 'pgmem',
                constraint_schema: c.schema,
                constraint_name: c.name,
                unique_constraint_catalog: 'pgmem',
                unique_constraint_schema: c.schema,
                // Postgres names the constraint on the referenced side. The primary key is the
                // common case by far, and the FK requires a unique index there, so this is the
                // conventional name rather than a lookup.
                unique_constraint_name: `${c.references.table}_pkey`,
                match_option: c.references.matchType,
                update_rule: c.references.onUpdate,
                delete_rule: c.references.onDelete,
            };
            yield setId(ret, `/information_schema/referential_constraints/${c.schema}/${c.name}`);
        }
    }

    hasItem(value: any): boolean {
        return !!value;
    }
}
