import { _IDb } from '../../interfaces-private.ts';

export interface ConstraintRow {
    schema: string;
    table: string;
    name: string;
    type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY';
    columns: string[];
    /** Foreign keys only — what this constraint references, and what happens on change. */
    references?: {
        table: string;
        columns: string[];
        onDelete: string;
        onUpdate: string;
        matchType: string;
    };
}

/** Enumerates the key constraints (primary key + unique) of every table, used to back
 * information_schema.table_constraints and key_column_usage. */
export function* listConstraintRows(db: _IDb): Iterable<ConstraintRow> {
    for (const schema of db.listSchemas()) {
        for (const table of schema.listTables()) {
            const pk = (table as any).primaryIndex as { name: string; expressions: string[] } | null;
            if (pk) {
                yield { schema: schema.name, table: table.name, name: pk.name, type: 'PRIMARY KEY', columns: pk.expressions };
            }
            for (const idx of table.listIndexes()) {
                if (!idx.unique || idx.name === pk?.name) {
                    continue;
                }
                const columns = idx.expressions.map((e: any) => e.id).filter((c: any) => !!c);
                yield { schema: schema.name, table: table.name, name: idx.name, type: 'UNIQUE', columns };
            }

            // Foreign keys. Identified by the constraint's own `constraintKind` rather than
            // instanceof, so this module stays free of a dependency on the constraints folder.
            const listConstraints = (table as any).listConstraints;
            if (typeof listConstraints !== 'function') {
                continue;
            }
            for (const wrapper of listConstraints.call(table) as any[]) {
                // Constraints are stored wrapped (see ConstraintWrapper); reach through to the real
                // one, which is what carries the FK's shape.
                const cst = wrapper?.wrapped ?? wrapper;
                if (cst?.constraintKind !== 'foreign key') {
                    continue;
                }
                yield {
                    schema: schema.name,
                    table: table.name,
                    name: cst.name,
                    type: 'FOREIGN KEY',
                    columns: cst.localColumns ?? [],
                    references: {
                        table: cst.foreignTableName,
                        columns: cst.foreignColumns ?? [],
                        onDelete: cst.onDelete ?? 'NO ACTION',
                        onUpdate: cst.onUpdate ?? 'NO ACTION',
                        matchType: cst.matchType ?? 'NONE',
                    },
                };
            }
        }
    }
}
