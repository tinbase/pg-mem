import { _ITable, _ISelection, IValue, _IIndex, _IDb, IndexKey, setId, _Transaction, _ISchema } from '../../interfaces-private';
import { Schema, nil } from '../../interfaces';
import { toSql, DataTypeDef } from 'pgsql-ast-parser';
import { DataType } from '../../interfaces';
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
const BUILTIN = new Set<string>(Object.values(DataType));

/** Postgres' internal (pg_type) name for a type, as udt_name reports it. */
function udtName(type: IValue['type'], declared: DataTypeDef | nil): string {
    const n = (declared as any)?.name?.toLowerCase() as string | undefined;
    switch (type.primary) {
        case DataType.integer: return n === 'smallint' || n === 'int2' || n === 'smallserial' ? 'int2' : 'int4';
        case DataType.bigint: return 'int8';
        case DataType.float: return n === 'real' || n === 'float4' ? 'float4' : 'float8';
        case DataType.decimal: return 'numeric';
        case DataType.text:
            if (n === 'char' || n === 'character' || n === 'bpchar') return 'bpchar';
            return (type as any).len || n === 'varchar' || n === 'character varying' ? 'varchar' : 'text';
        case DataType.array:
            return '_' + udtName((type as any).of, declared?.kind === 'array' ? declared.arrayOf : null);
    }
    // built-ins are named by their primary (timestamptz, not 'timestamp with time zone'); enums/domains by name
    return BUILTIN.has(type.primary) ? type.primary : (type as any).name ?? type.primary;
}

/** information_schema.columns.data_type: the SQL-standard name, 'ARRAY', or 'USER-DEFINED'. */
function sqlTypeName(type: IValue['type'], declared: DataTypeDef | nil): string {
    if (type.primary === DataType.array) {
        return 'ARRAY';
    }
    if (type.primary === DataType.citext || !BUILTIN.has(type.primary)) {
        return 'USER-DEFINED';
    }
    switch (udtName(type, declared)) {
        case 'int2': return 'smallint';
        case 'int4': return 'integer';
        case 'int8': return 'bigint';
        case 'float4': return 'real';
        case 'float8': return 'double precision';
        case 'bool': return 'boolean';
        case 'bpchar': return 'character';
        case 'varchar': return 'character varying';
        case 'timestamptz': return 'timestamp with time zone';
        case 'timestamp': return 'timestamp without time zone';
        case 'timetz': return 'time with time zone';
        case 'time': return 'time without time zone';
    }
    return udtName(type, declared);
}

function columnRef(
    table: _ITable,
    columnName: string | nil
): { notNull?: boolean; default?: IValue | nil; declaredType?: DataTypeDef | nil } | nil {
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
    const pg = pgExprText(ast);
    if (pg !== null) {
        return pg;
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

const pgQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const KEYWORD_TEXT: Record<string, string> = {
    current_date: 'CURRENT_DATE', current_timestamp: 'CURRENT_TIMESTAMP', localtimestamp: 'LOCALTIMESTAMP',
    current_time: 'CURRENT_TIME', localtime: 'LOCALTIME', current_user: 'CURRENT_USER', current_role: 'CURRENT_ROLE',
    session_user: 'SESSION_USER', user: 'CURRENT_USER',
};

/**
 * A default expression as postgres' pg_get_expr prints it: literals as written (0.30, not 0.3),
 * negative numbers quoted ('-1'::integer), a binary expression wrapped once - (now() + '2 days'::interval)
 * - with bare operands, ARRAY[...], CURRENT_DATE. Null for shapes it does not know, which then go
 * through the generic toSql rendering.
 */
function pgExprText(e: any): string | null {
    const operand = (x: any) => pgExprText(x);
    switch (e?.type) {
        case 'string':
            return pgQuote(e.value);
        case 'integer':
            // negative, or too big for int4 (then typed bigint): postgres prints it quoted
            return e.value < 0 || e.value > 2147483647 ? pgQuote(String(e.valueText ?? e.value)) : String(e.valueText ?? e.value);
        case 'numeric': {
            const txt = e.raw ?? e.valueText ?? String(e.value);
            return txt.startsWith('-') ? pgQuote(txt) : txt;
        }
        case 'boolean':
            return e.value ? 'true' : 'false';
        case 'null':
            return 'NULL';
        case 'keyword':
            return KEYWORD_TEXT[e.keyword] ?? null;
        case 'call': {
            const args = (e.args ?? []).map(operand);
            if (args.some((a: string | null) => a === null) || e.distinct || e.orderBy || e.filter || e.over) {
                return null;
            }
            const fn = (e.function.schema ? e.function.schema + '.' : '') + e.function.name;
            return `${fn}(${args.join(', ')})`;
        }
        case 'cast': {
            const inner = operand(e.operand);
            return inner === null ? null : `${inner}::${toSql.dataType(e.to as any)}`;
        }
        case 'binary': {
            const l = operand(e.left), r = operand(e.right);
            return l === null || r === null ? null : `(${l} ${e.op} ${r})`;
        }
        case 'unary': {
            const v = operand(e.operand);
            if (v === null) {
                return null;
            }
            if (e.op === '-' && /^[\d.]+$/.test(v)) {
                return pgQuote('-' + v);
            }
            return e.op === 'NOT' ? `(NOT ${v})` : `(${e.op}${v})`;
        }
        case 'array': {
            const items = (e.expressions ?? []).map(operand);
            return items.some((a: string | null) => a === null) ? null : `ARRAY[${items.join(', ')}]`;
        }
    }
    return null;
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
            // The owning schema, not a hardcoded 'public' - see table-list.ts.
            // Hardcoding it merged the columns of same-named tables in different
            // schemas into one apparent table.
            table_schema: table.ownerSchema.name,
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
            data_type: sqlTypeName(t.type, columnRef(table, t.id)?.declaredType),
            character_maximum_length: (t.type as any).len ?? (udtName(t.type, columnRef(table, t.id)?.declaredType) === 'bpchar' ? 1 : null),
            numeric_precision: null, // <== todo
            numeric_precision_radix: null, // <== todo
            numeric_scale: null, // <== todo

            udt_catalog: 'pgmem',
            udt_schema: 'pg_catalog',
            udt_name: udtName(t.type, columnRef(table, t.id)?.declaredType),

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
        if (forValue?.id === 'table_name') {
            return new TableIndex(this, forValue);
        }
        return null;
    }

}
