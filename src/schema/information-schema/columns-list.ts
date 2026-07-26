import { _ITable, _ISelection, IValue, _IIndex, _IDb, IndexKey, setId, _Transaction, _ISchema } from '../../interfaces-private';
import { Schema, nil } from '../../interfaces';
import { toSql } from 'pgsql-ast-parser';
import { Types } from '../../datatypes';
import { TableIndex } from '../table-index';
import { ReadOnlyTable } from '../readonly-table';

const IS_SCHEMA = Symbol('_is_colmun');
/**
 * The column's own metadata, when the relation has any.
 *
 * Only real tables carry ColRefs; views and function-call tables expose values without column
 * definitions, so callers must tolerate nil rather than assume a table.
 */
function columnRef(
    table: _ITable,
    columnName: string | nil
): { notNull?: boolean; default?: IValue | nil } | nil {
    if (!columnName) {
        return null;
    }
    const getter = (table as any).getColumnRef;
    if (typeof getter !== 'function') {
        return null;
    }
    try {
        return getter.call(table, columnName, true) ?? null;
    } catch {
        return null;
    }
}

/**
 * Postgres reports column_default as SQL text, or null when there is none.
 *
 * Rendered from the retained AST (see ColRef.defaultExpr) — the built evaluator cannot supply it,
 * because its `hash` is a digest for anything that is not a literal.
 */
function defaultExpressionOf(table: _ITable, columnName: string | nil): string | null {
    const ref = columnRef(table, columnName);
    if (!ref?.default) {
        return null;
    }
    const ast = (ref as any).defaultExpr;
    if (!ast) {
        return null;
    }
    try {
        // toSql renders defensively — `now()` comes out as `(now () )`. Postgres reports `now()`, and
        // consumers compare these strings, so collapse the padding and drop one layer of wrapping
        // parens. Deliberately conservative: only a paren pair that encloses the WHOLE expression is
        // removed, so `(a + b) * 2` is left alone.
        const rendered = toSql
            .expr(ast)
            .replace(/\s+/g, ' ')
            .replace(/\(\s+/g, '(')
            .replace(/\s+\)/g, ')')
            // `now ()` → `now()`: toSql puts a space between a function name and its arg list.
            .replace(/([A-Za-z_][\w.]*)\s+\(/g, '$1(')
            .trim();
        return stripWrappingParens(rendered);
    } catch {
        return null;
    }
}

/** Remove one paren pair only when it wraps the entire expression. */
function stripWrappingParens(sql: string): string {
    if (!sql.startsWith('(') || !sql.endsWith(')')) {
        return sql;
    }
    let depth = 0;
    for (let i = 0; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') {
            depth--;
            // Closed before the end → the parens are not wrapping the whole thing.
            if (depth === 0 && i !== sql.length - 1) return sql;
        }
    }
    return sql.slice(1, -1).trim();
}

export class ColumnsListSchema extends ReadOnlyTable implements _ITable {

    get ownSymbol() {
        return IS_SCHEMA;
    }

    _schema: Schema = {
        name: 'columns',
        fields: [
            { name: 'table_catalog', type: Types.text() }
            , { name: 'table_schema', type: Types.text() }
            , { name: 'table_name', type: Types.text() }
            , { name: 'column_name', type: Types.text() }
            , { name: 'ordinal_position', type: Types.integer }
            , { name: 'column_default', type: Types.text() }
            , { name: 'is_nullable', type: Types.text(3) }
            , { name: 'data_type', type: Types.text() }
            , { name: 'character_maximum_length', type: Types.integer }
            , { name: 'character_octet_length', type: Types.integer }
            , { name: 'numeric_precision', type: Types.integer }
            , { name: 'numeric_precision_radix', type: Types.integer }
            , { name: 'numeric_scale', type: Types.integer }
            , { name: 'datetime_precision', type: Types.integer }
            , { name: 'interval_type', type: Types.text() }
            , { name: 'interval_precision', type: Types.integer }
            , { name: 'character_set_catalog', type: Types.text() }
            , { name: 'character_set_schema', type: Types.text() }
            , { name: 'character_set_name', type: Types.text() }
            , { name: 'collation_catalog', type: Types.text() }
            , { name: 'collation_schema', type: Types.text() }
            , { name: 'collation_name', type: Types.text() }
            , { name: 'domain_catalog', type: Types.text() }
            , { name: 'domain_schema', type: Types.text() }
            , { name: 'domain_name', type: Types.text() }
            , { name: 'udt_catalog', type: Types.text() } // <====
            , { name: 'udt_schema', type: Types.text() } // <====
            , { name: 'udt_name', type: Types.text() } // <====
            , { name: 'scope_catalog', type: Types.text() } // <====
            , { name: 'scope_schema', type: Types.text() } // <====
            , { name: 'scope_name', type: Types.text() } // <====
            , { name: 'maximum_cardinality', type: Types.integer } // <====
            , { name: 'dtd_identifier', type: Types.integer } // <=== INDEX
            , { name: 'is_self_referencing', type: Types.text(3) }
            , { name: 'is_identity', type: Types.text(3) } // <==
            , { name: 'identity_generation', type: Types.text() } // <==
            , { name: 'identity_start', type: Types.text() } // <==
            , { name: 'identity_document', type: Types.text() } // <==
            , { name: 'identity_increment', type: Types.text() } // <==
            , { name: 'identity_maximum', type: Types.text() } // <==
            , { name: 'identity_minimum', type: Types.text() } // <==
            , { name: 'identity_cycle', type: Types.text(3) } // <==
            , { name: 'is_generated', type: Types.text() } // <==
            , { name: 'generation_expression', type: Types.text() } // <==
            , { name: 'is_updatable', type: Types.text(3) } // <==
        ]
    };


    entropy(t: _Transaction): number {
        return this.db.listSchemas()
            .reduce((tot, s) => tot + s.tablesCount(t) * 10, 0);
    }

    *enumerate(t: _Transaction) {
        for (const s of this.db.listSchemas()) {
            for (const it of s.listTables(t)) {
                yield* this.itemsByTable(it, t);
            }
        }
    }

    make(table: _ITable, i: number, t: IValue): any {
        if (!t) {
            return null;
        }
        let ret = {};
        for (const { name } of this._schema.fields) {
            (ret as any)[name] = null;
        }

        ret = {
            ...ret,
            table_catalog: 'pgmem',
            table_schema: 'public',
            table_name: table.name,
            column_name: t.id,
            ordinal_position: i,
            // Read from the column itself rather than hardcoded.
            //
            // These were 'NO' and null for every column, which is worse than missing: a consumer
            // generating types off information_schema would mark a nullable column non-null and its
            // callers would skip null checks the database will hand them. Tables that expose no
            // column refs (views, function-call tables) still fall back to the permissive answer.
            is_nullable: columnRef(table, t.id)?.notNull ? 'NO' : 'YES',
            column_default: defaultExpressionOf(table, t.id),
            data_type: t.type.primary, // <== todo
            numeric_precision: null, // <== todo
            numeric_precision_radix: null, // <== todo
            numeric_scale: null, // <== todo

            udt_catalog: 'pgmem',
            udt_schema: 'pg_catalog',
            udt_name: t.type.primary, // <== todo

            dtd_identifier: i, // <== todo

            is_self_referencing: 'NO',
            is_identity: 'NO',

            is_updatable: 'YES',
            is_generated: 'NEVER',
            identity_cycle: 'NO',


            [IS_SCHEMA]: true,
        };
        setId(ret, `/schema/${table.ownerSchema.name}/table/${table.name}/${i}`);
        return ret;
    }

    hasItem(value: any): boolean {
        return !!value?.[IS_SCHEMA];
    }

    getIndex(forValue: IValue): _IIndex | nil {
        if (forValue.id === 'table_name') {
            return new TableIndex(this, forValue);
        }
        return null;
    }

}
