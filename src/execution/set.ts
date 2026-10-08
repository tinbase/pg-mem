import { _IStatementExecutor, _Transaction, StatementResult, GLOBAL_VARS, QueryError } from '../interfaces-private';
import { SetGlobalStatement, SetTimezone, SetNames } from 'pgsql-ast-parser';
import { ignore } from '../utils';
import { ExecHelper } from './exec-utils';

export class SetExecutor extends ExecHelper implements _IStatementExecutor {

    constructor(private p: SetGlobalStatement | SetTimezone | SetNames) {
        super(p);
        // todo handle set statements timezone ?
        // They are just ignored as of today (in order to handle pg_dump exports)
        ignore(p);
    }

    execute(t: _Transaction): StatementResult {
        const p = this.p;
        if (p.type === 'set') {
            const value = settingText(p.variable.name, p.set);
            if (value !== null) {
                t.set(GLOBAL_VARS, t.getMap(GLOBAL_VARS).set(p.variable.name, value));
            }
        }
        return this.noData(t, 'SET');
    }
}

export const DEFAULT_SEARCH_PATH = '"$user", public';

const DEFAULTS: { [name: string]: string } = {
    search_path: DEFAULT_SEARCH_PATH,
};

/**
 * The text SHOW / current_setting return for a SET value: `set search_path to '$user', public`
 * reads back as `"$user", public`, `set x to default` as the default. null: leave unchanged.
 */
function settingText(name: string, set: any): string | null {
    const items: any[] = [];
    const flatten = (v: any) => {
        if (Array.isArray(v)) {
            v.forEach(flatten);
        } else if (v && (v.type === 'identifier' || v.type === 'value')) {
            items.push(v);
        }
    };
    switch (set?.type) {
        case 'value':
            return String(set.value);
        case 'identifier':
            return set.name;
        case 'list':
            flatten(set.values);
            return items.map(v => v.type === 'identifier'
                ? v.name
                // a quoted name keeps its quotes in a list ('$user' -> "$user")
                : (/^[a-z_][a-z0-9_]*$/.test(String(v.value)) ? String(v.value) : `"${v.value}"`)).join(', ');
        case 'default':
            return DEFAULTS[name.toLowerCase()] ?? null;
    }
    return null;
}
