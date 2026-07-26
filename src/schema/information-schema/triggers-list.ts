import { _ITable, setId, _ISchema } from '../../interfaces-private';
import { Schema } from '../../interfaces';
import { Types } from '../../datatypes';
import { ReadOnlyTable } from '../readonly-table';

/**
 * information_schema.triggers — one row per trigger, per event.
 *
 * https://www.postgresql.org/docs/current/infoschema-triggers.html
 *
 * The engine already models triggers completely (see execution/triggers.ts); they were simply not
 * visible to introspection, so a tool checking "does something maintain updated_at" had to parse the
 * DDL. Postgres emits one row per event, so `create trigger … before insert or update` yields two.
 */
export class TriggersList extends ReadOnlyTable implements _ITable {

    _schema: Schema = {
        name: 'triggers',
        fields: [
            { name: 'trigger_catalog', type: Types.text() }
            , { name: 'trigger_schema', type: Types.text() }
            , { name: 'trigger_name', type: Types.text() }
            , { name: 'event_manipulation', type: Types.text() }
            , { name: 'event_object_catalog', type: Types.text() }
            , { name: 'event_object_schema', type: Types.text() }
            , { name: 'event_object_table', type: Types.text() }
            , { name: 'action_order', type: Types.integer }
            , { name: 'action_condition', type: Types.text() }
            , { name: 'action_statement', type: Types.text() }
            , { name: 'action_orientation', type: Types.text() }
            , { name: 'action_timing', type: Types.text() }
        ]
    };

    entropy(): number {
        return 0;
    }

    *enumerate() {
        for (const schema of this.db.listSchemas()) {
            for (const table of schema.listTables()) {
                const triggers = (table as any).triggers?.triggers as any[] | undefined;
                if (!triggers?.length) {
                    continue;
                }
                let order = 0;
                for (const trig of triggers) {
                    order++;
                    for (const event of trig.events ?? []) {
                        const ret = {
                            trigger_catalog: 'pgmem',
                            trigger_schema: schema.name,
                            trigger_name: trig.name,
                            event_manipulation: String(event).toUpperCase(),
                            event_object_catalog: 'pgmem',
                            event_object_schema: schema.name,
                            event_object_table: table.name,
                            action_order: order,
                            // The compiled WHEN predicate cannot be rendered back to SQL, so report
                            // only whether there is one — null means unconditional, as in Postgres.
                            action_condition: trig.when ? '(condition)' : null,
                            action_statement: `EXECUTE FUNCTION ${trig.functionName}()`,
                            action_orientation: trig.forEach === 'statement' ? 'STATEMENT' : 'ROW',
                            action_timing: String(trig.timing ?? 'before').toUpperCase(),
                        };
                        yield setId(
                            ret,
                            `/information_schema/triggers/${schema.name}/${table.name}/${trig.name}/${event}`
                        );
                    }
                }
            }
        }
    }

    hasItem(value: any): boolean {
        return !!value;
    }
}
