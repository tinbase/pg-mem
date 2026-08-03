import { _ITable, _ISelection, IValue, _IIndex, _IDb, IndexKey, setId, _ISchema } from '../../interfaces-private.ts';
import { Schema } from '../../interfaces.ts';
import { Types } from '../../datatypes/index.ts';
import { ReadOnlyTable } from '../readonly-table.ts';
import { listConstraintRows } from './constraint-rows.ts';


/**
 * information_schema.constraint_column_usage: the columns *used by* each
 * constraint.
 *
 * Not the same set as key_column_usage, and the difference is the point of the
 * view: for a foreign key, key_column_usage lists the referencing columns while
 * this lists the ones being *referenced*, so it is how a consumer resolves an fk
 * to its target. For a primary key or unique constraint the two coincide.
 *
 * This declared its columns and then enumerated nothing, so the view existed and
 * was always empty - worse than absent, since a consumer joining against it to
 * resolve foreign keys got zero rows and concluded there were no relationships
 * rather than being told to look elsewhere.
 */
export class ConstraintColumnUsage extends ReadOnlyTable implements _ITable {


    _schema: Schema = {
        name: 'constraint_column_usage',
        fields: [
            { name: 'constraint_catalog', type: Types.text() }
            , { name: 'constraint_schema', type: Types.text() }
            , { name: 'constraint_name', type: Types.text() }

            , { name: 'table_catalog', type: Types.text() }
            , { name: 'table_schema', type: Types.text() }
            , { name: 'table_name', type: Types.text() }

            , { name: 'column_name', type: Types.text() }
        ]
    };


    entropy(): number {
        return 0;
    }

    *enumerate() {
        for (const c of listConstraintRows(this.db)) {
            // A foreign key uses the columns it points at, on the referenced
            // table; a key constraint uses its own. The referenced table is
            // reported in the constraint's schema, which is right for the
            // same-schema case the constraint model carries - it holds a bare
            // table name, not a qualified one.
            const table = c.references ? c.references.table : c.table;
            const columns = c.references ? c.references.columns : c.columns;
            for (const column of columns) {
                const ret = {
                    constraint_catalog: 'pgmem',
                    constraint_schema: c.schema,
                    constraint_name: c.name,
                    table_catalog: 'pgmem',
                    table_schema: c.schema,
                    table_name: table,
                    column_name: column,
                };
                yield setId(ret, `/information_schema/constraint_column_usage/${c.schema}/${c.name}/${table}/${column}`);
            }
        }
    }


    hasItem(value: any): boolean {
        return !!value;
    }

}
