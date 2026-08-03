import { _ITable, setId, _ISchema } from '../../interfaces-private.ts';
import { Schema } from '../../interfaces.ts';
import { Types } from '../../datatypes/index.ts';
import { ReadOnlyTable } from '../readonly-table.ts';

/**
 * pg_trigger — the catalogue view of triggers.
 *
 * https://www.postgresql.org/docs/current/catalog-pg-trigger.html
 *
 * Companion to information_schema.triggers: same data, but one row per TRIGGER rather than per event,
 * which is what tools reaching for pg_catalog expect. `tgtype` is a bitmask in Postgres and is
 * reproduced here because that is how callers read the timing and events.
 */

// Bit meanings from Postgres' catalog/pg_trigger.h.
const TRIGGER_TYPE_ROW = 1 << 0;
const TRIGGER_TYPE_BEFORE = 1 << 1;
const TRIGGER_TYPE_INSERT = 1 << 2;
const TRIGGER_TYPE_DELETE = 1 << 3;
const TRIGGER_TYPE_UPDATE = 1 << 4;
const TRIGGER_TYPE_INSTEAD = 1 << 6;

function tgtypeOf(trig: any): number {
    let type = 0;
    if (trig.forEach !== 'statement') type |= TRIGGER_TYPE_ROW;
    if (trig.timing === 'before') type |= TRIGGER_TYPE_BEFORE;
    if (trig.timing === 'instead of') type |= TRIGGER_TYPE_INSTEAD;
    for (const event of trig.events ?? []) {
        if (event === 'insert') type |= TRIGGER_TYPE_INSERT;
        if (event === 'update') type |= TRIGGER_TYPE_UPDATE;
        if (event === 'delete') type |= TRIGGER_TYPE_DELETE;
    }
    return type;
}

export class PgTriggerTable extends ReadOnlyTable implements _ITable {

    _schema: Schema = {
        name: 'pg_trigger',
        fields: [
            { name: 'oid', type: Types.integer }
            , { name: 'tgrelid', type: Types.integer }
            , { name: 'tgname', type: Types.text() }
            , { name: 'tgfoid', type: Types.integer }
            , { name: 'tgtype', type: Types.integer }
            , { name: 'tgenabled', type: Types.text(1) }
            , { name: 'tgisinternal', type: Types.bool }
            , { name: 'tgnargs', type: Types.integer }
            // Not a real pg_trigger column, but the numeric oids above are synthetic here and
            // unusable for joins, so the table and function names are exposed directly.
            , { name: 'tgrelname', type: Types.text() }
            , { name: 'tgfname', type: Types.text() }
        ]
    };

    entropy(): number {
        return 0;
    }

    *enumerate() {
        let oid = 1;
        for (const schema of this.db.listSchemas()) {
            for (const table of schema.listTables()) {
                const triggers = (table as any).triggers?.triggers as any[] | undefined;
                for (const trig of triggers ?? []) {
                    const ret = {
                        oid: oid++,
                        tgrelid: 0,
                        tgname: trig.name,
                        tgfoid: 0,
                        tgtype: tgtypeOf(trig),
                        // 'O' = fires in origin/local mode, the default.
                        tgenabled: 'O',
                        tgisinternal: false,
                        tgnargs: trig.arguments?.length ?? 0,
                        tgrelname: table.name,
                        tgfname: trig.functionName,
                    };
                    yield setId(ret, `/schema/pg_trigger/${schema.name}/${table.name}/${trig.name}`);
                }
            }
        }
    }

    hasItem(value: any): boolean {
        return !!value;
    }
}
