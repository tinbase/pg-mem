import { _ITable, _ISelection, IValue, _IIndex, _IDb, IndexKey, setId, _ISchema, _Transaction, _Explainer } from '../../interfaces-private.ts';
import { Schema, nil } from '../../interfaces.ts';
import { Types } from '../../datatypes/index.ts';
import { TableIndex } from '../table-index.ts';
import { ReadOnlyTable } from '../readonly-table.ts';

const IS_SCHEMA = Symbol('_is_schema');
export class TablesSchema extends ReadOnlyTable implements _ITable {

    get ownSymbol() {
        return IS_SCHEMA;
    }

    isOriginOf(v: IValue): boolean {
        return v.origin === this || v.origin === this.selection;
    }

    _schema: Schema = {
        name: 'tables',
        fields: [
            { name: 'table_catalog', type: Types.text() }
            , { name: 'table_schema', type: Types.text() }
            , { name: 'table_name', type: Types.text() }
            , { name: 'table_type', type: Types.text() }
            , { name: 'self_referencing_column_name', type: Types.text() }
            , { name: 'reference_generation', type: Types.text() }
            , { name: 'user_defined_type_catalog', type: Types.text() }
            , { name: 'user_defined_type_schema', type: Types.text() }
            , { name: 'user_defined_type_name', type: Types.text() }
            , { name: 'is_insertable_into', type: Types.text(3) }
            , { name: 'is_typed', type: Types.text(3) }
            , { name: 'commit_action', type: Types.text() }
        ]
    };

    entropy(t: _Transaction): number {
        return this.db.listSchemas()
            .reduce((tot, s) => tot + s.tablesCount(t), 0);
    }

    *enumerate(t: _Transaction) {
        for (const s of this.db.listSchemas()) {
            for (const it of s.listTables(t)) {
                yield this.make(it);
            }
        }
    }

    make(t: _ITable): any {
        if (!t) {
            return null;
        }
        const ret = {
            table_catalog: 'pgmem',
            // The owning schema, not a hardcoded 'public'. enumerate() already
            // walks every schema, so hardcoding this reported auth.users,
            // storage.objects and the like as though they lived in public -
            // tables nothing could then address, and two same-named tables in
            // different schemas became indistinguishable to any consumer.
            table_schema: t.ownerSchema.name,
            table_name: t.name,
            table_type: 'BASE TABLE',
            self_referencing_column_name: null,
            reference_generation: null,
            user_defined_type_catalog: null,
            user_defined_type_schema: null,
            user_defined_type_name: null,
            is_insertable_into: 'YES',
            is_typed: 'NO',
            commit_action: null,
            [IS_SCHEMA]: true,
        };
        // Schema-qualified, as columns-list already does: two same-named tables
        // in different schemas are distinct rows and must not share an id.
        setId(ret, `/schema/${t.ownerSchema.name}/table/${t.name}`);
        return ret;
    }

    /**
     * One row per matching table.
     *
     * ReadOnlyTable's inherited version yields one row per *column*, which is
     * what columns-list wants and this view does not: filtering on table_name
     * returned a table once per column it had, so a 17-column table appeared 17
     * times while an unfiltered scan of the same view was correct.
     */
    *itemsByTable(table: string | _ITable, t: _Transaction): IterableIterator<any> {
        if (typeof table === 'string') {
            for (const s of this.db.listSchemas()) {
                const got = s.getTable(table, true);
                if (got) {
                    yield this.make(got);
                }
            }
        } else {
            yield this.make(table);
        }
    }

    hasItem(value: any): boolean {
        return !!value?.[IS_SCHEMA];
    }

    getIndex(forValue: IValue): _IIndex | nil {
        if (forValue?.id === 'table_name') {
            return new TableIndex(this, forValue);
        }
        return null;
    }

}
