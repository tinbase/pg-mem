import { DataType, nil, _IType } from '../interfaces-private.ts';

/**
 * pg types held internally as strings that Postgres serializes as JSON *numbers*.
 *
 * numeric/decimal and bigint are kept as strings throughout pg-mem so arithmetic
 * stays exact (`98.4 * 2` is `'196.8'`, not a float), which also matches what
 * node-postgres hands a client for those types. Inside the server, though, a
 * numeric is a numeric: `to_json(98.4::numeric)` in real Postgres is the JSON
 * number `98.4`, not the string `"98.4"`. Without this conversion the json
 * builders leaked pg-mem's internal representation into their output, so a
 * consumer doing `row.score.toFixed(1)` worked against Postgres and threw here.
 */
const JSON_NUMBER_TYPES: ReadonlySet<DataType> = new Set([DataType.decimal, DataType.bigint]);

/**
 * Convert `value` for embedding in json/jsonb, given its declared `type`.
 *
 * Recurses into records and arrays so `row_to_json(t)` and `json_agg(t)` convert
 * their numeric fields, not just a bare `to_json(x)`.
 *
 * Values beyond 2^53 lose precision, since the result is a JS number: real
 * Postgres emits the exact digits in the JSON text and a JS client loses them at
 * JSON.parse instead. Indistinguishable to such a client, and the alternative
 * (emitting a raw token) is not representable in the JS value model pg-mem uses.
 */
export function toJsonValue(value: any, type: _IType | nil): any {
    if (value === null || value === undefined || !type) {
        return value;
    }

    if (JSON_NUMBER_TYPES.has(type.primary)) {
        if (typeof value === 'string') {
            const n = Number(value);
            // NaN/Infinity are not valid json numbers; leave anything unparseable
            // as-is rather than emitting null and losing the value silently.
            return Number.isFinite(n) ? n : value;
        }
        return typeof value === 'bigint' ? Number(value) : value;
    }

    if (type.primary === DataType.array || type.primary === DataType.list) {
        const of = (type as any).of as _IType | undefined;
        return Array.isArray(value) ? value.map(v => toJsonValue(v, of)) : value;
    }

    if (type.primary === DataType.record) {
        const columns = (type as any).columns as { name: string; type: _IType }[] | undefined;
        if (!columns || typeof value !== 'object' || Array.isArray(value)) {
            return value;
        }
        // Only rewrite the fields that need it, and only when something actually
        // changes, so the common all-scalar row keeps its original object.
        let out: Record<string, any> | null = null;
        for (const col of columns) {
            const before = (value as any)[col.name];
            const after = toJsonValue(before, col.type);
            if (after !== before) {
                out = out ?? { ...(value as Record<string, any>) };
                out[col.name] = after;
            }
        }
        return out ?? value;
    }

    return value;
}
