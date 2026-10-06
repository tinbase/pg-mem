# corpus-diff: pg-mem vs Postgres on real project migrations

Runs real RapidNative project migrations through pg-mem and PGlite (real Postgres in WASM) side by
side and reports every place they disagree. PGlite is the oracle: any difference is a pg-mem gap.

```bash
bun tools/corpus-diff/run.ts <corpusDir> [outDir] [--only p07]
```

`<corpusDir>/<project>/migrations/*.sql` plus an optional `seed.sql`, one directory per project.
Results land in `outDir/diffs.json` (default `<corpusDir>/../corpus-diff-out`).

**The corpus is user project code. Never commit it.** Pull it on demand into a scratch directory.

## Getting a corpus

From `rapidnative-website`, with the read-only BI credentials (see its `bi` skill). This picks a
seeded random sample of recent projects that have migrations:

```sql
select setseed(0.20261006);
select p.id from projects p
where p.created_at >= now() - interval '30 days'
  and exists (select 1 from files f where f.project_id = p.id and f.file_path like 'supabase/migrations/%.sql')
order by random() limit 50;
-- then per project:
select file_path, content from files where project_id = $1
  and (file_path like 'supabase/migrations/%.sql' or file_path = 'supabase/seed.sql') order by file_path;
```

Use the BI database connection, not the Supabase REST URL in the website's `.env`. That URL is a
different project and holds only a handful of rows.

## What is compared

Each project gets the same Supabase bootstrap the agent's validator installs (`bootstrap.ts`, copied
from rapidnative-website `pg-session.ts`), then, on both engines:

| kind | what |
|---|---|
| `bootstrap`, `migration-*`, `seed-*` | each file applies, or fails, on both. `-rejected`: pg-mem refused SQL Postgres accepts (an app that won't boot). `-accepted`: pg-mem took SQL Postgres refuses (a validator waving through a broken migration) |
| `catalog` | the exact `information_schema` / `pg_*` reads `PgSession.buildTableInfo()` makes |
| `data` | rows after the seed (generated uuids and `now()`-relative timestamps normalised) |
| `rls-read`, `rls-write` | counts and affected rows as anon, the demo user and a stranger |
| `insert`, `reject` | a copy of a seeded row must insert; single-field corruptions (bad literal, NULL into NOT NULL, int overflow, dangling FK, duplicate key, CHECK violation) must fail like Postgres |
| `ddl` | policies with mistyped operands or missing columns, retyping/dropping columns other objects depend on, triggers on missing functions |
| `trigger` | `updated_at` triggers fire |
| `cascade` | deleting the demo user: what survives |
| `rollback` | state leaking past a ROLLBACK |

Probes run in a transaction that is rolled back. pg-mem is rebuilt after DDL probes, because its
DDL is not transactional.

To cluster `diffs.json` by root cause, group on `kind`, `probe`, and the normalised error text of each side.
