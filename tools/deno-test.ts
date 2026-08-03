/**
 * Smoke test for the transpiled Deno port under .deno/.
 *
 * Run it the way `release-node` does:
 *
 *     deno run --allow-all --node-modules-dir=none tools/deno-test.ts
 *
 * `--node-modules-dir=none` matters. Without it Deno auto-discovers the repo's own
 * node_modules, where the npm alias for the parser
 * ("npm:@tinbase/pgsql-ast-parser") means the on-disk directory name and the
 * package name disagree; Deno's CJS export analysis fails on that layout and
 * reports `does not provide an export named 'toSql'`. Resolving from Deno's own
 * npm cache is also the more faithful check, since that is how a consumer gets it.
 *
 * The checks below deliberately exercise behaviours recent releases fixed, rather
 * than only that the module loads. The port is generated code, so a transpile that
 * silently dropped or mangled one of them would otherwise pass here.
 */
import { newDb } from '../.deno/mod.ts';

let failures = 0;

function check(what: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ok    ${what}`);
    } else {
        failures++;
        console.log(`  FAIL  ${what}\n          expected ${e}\n          actual   ${a}`);
    }
}

// ── the original smoke test: backup/restore round-trip ────────────────────────
{
    const db = newDb();
    db.public.none(`create table test(id text);
                    insert into test values ('value');`);
    const backup = db.backup();
    db.public.none(`update test set id='new value';`);
    backup.restore();
    check('backup/restore', db.public.many(`select * from test`), [{ id: 'value' }]);
}

// ── information_schema reports the owning schema (3.4.0) ──────────────────────
{
    const db = newDb();
    db.public.none(`create schema auth`);
    db.public.none(`create table auth.users (id text primary key)`);
    db.public.none(`create table users (id text primary key)`);
    // sorted in JS, not with `order by 1` - positional ORDER BY is silently
    // ignored by this engine, which would make the check pass or fail on
    // insertion order rather than on what it means to test
    const rows = db.public.many(
        `select table_schema from information_schema.tables where table_name = 'users'`,
    );
    check(
        'information_schema owning schema',
        rows.map((r: any) => r.table_schema).sort(),
        ['auth', 'public'],
    );
    // one row per table, not one per column
    check(
        'information_schema one row per table',
        db.public.many(`select 1 from information_schema.tables where table_name = 'users'`).length,
        2,
    );
}

// ── json builders emit numbers for numeric/bigint (3.4.0) ─────────────────────
{
    const db = newDb();
    db.public.none(`create table t (id int primary key, score numeric, big bigint, label text)`);
    db.public.none(`insert into t values (1, 98.4, 42, '12.5')`);
    check(
        'row_to_json numeric/bigint',
        db.public.many(`select row_to_json(t) as j from t`)[0].j,
        { id: 1, score: 98.4, big: 42, label: '12.5' },
    );
    check('plain select stays a string', db.public.many(`select score from t`)[0].score, '98.4');
}

// ── constraint_column_usage is populated (3.5.0) ──────────────────────────────
{
    const db = newDb();
    db.public.none(`create table authors (id int primary key)`);
    db.public.none(`create table books (id int primary key, author_id int references authors(id))`);
    check(
        'constraint_column_usage resolves an fk to its target',
        db.public.many(
            `select table_name, column_name from information_schema.constraint_column_usage
             where constraint_name = 'books_author_id_fkey'`,
        ),
        [{ table_name: 'authors', column_name: 'id' }],
    );
}

// ── integer literals past 2^53 (3.5.0) ───────────────────────────────────────
{
    const db = newDb();
    db.public.none(`create table big (id serial primary key, v bigint)`);
    db.public.none(`insert into big (v) values (9007199254740993)`);
    check('bigint literal past 2^53', db.public.many(`select v from big`)[0].v, '9007199254740993');
}

// ── positional ORDER BY / GROUP BY (3.5.0) ───────────────────────────────────
{
    const db = newDb();
    db.public.none(`create table t (a text, b int)`);
    db.public.none(`insert into t values ('c',3),('a',1),('b',2)`);
    check(
        'order by ordinal',
        db.public.many(`select a from t order by 1`).map((r: any) => r.a),
        ['a', 'b', 'c'],
    );
    // a bare integer is a position; an expression is still just a constant
    check(
        'order by constant expression sorts nothing',
        db.public.many(`select a from t order by 1 + 0`).map((r: any) => r.a),
        ['c', 'a', 'b'],
    );
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed in the Deno port`);
    Deno.exit(1);
}
console.log('\nDeno port OK');
