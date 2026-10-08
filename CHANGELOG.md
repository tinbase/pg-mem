# Changelog

Notable changes to `@tinbase/pg-mem`, the tinbase fork of pg-mem.

Released from `main`, which carries the scoped package name. Upstream is tracked through the `upstream` remote (`oguimbal/pg-mem`) rather than a branch; the leftover `master` is vestigial.

## 4.0.5

From a real 4-turn agent build on rapidnative-website's validator.

- Foreign keys between compatible types are accepted, as in postgres: `varchar -> text`, `integer -> bigint`, `integer -> numeric`, ... (they were rejected unless the two types were identical), and enforced, cascades included. Incompatible types (`text -> uuid`) fail with postgres' reason: `foreign key constraint "x" cannot be implemented: key columns "a" and "b" are of incompatible types: text and uuid` (was `Foreign key column type mismatch`).
- `search_path` exists: `SHOW search_path` / `current_setting('search_path')` return postgres' default `"$user", public`; `SET search_path TO a, b` and `TO DEFAULT` read back as postgres prints them. SET with a list value is stored (it was ignored).

## 4.0.4

From mutation probes and seeded reads over 120 production projects (validator on PGlite vs pg-mem).

- **Wrong results, fixed:** `sum()` over numeric/bigint concatenated the digit strings (`sum` of 10 and 32.5 was `'1032.5'`), and `avg` was computed from that; `max`/`min` compared numeric/bigint as text (`max(9, 10)` was `9`). Now exact. Enums ordered alphabetically instead of by declaration (ORDER BY, `>`/`<`, and `max`/`min`, which now accept enums).
- plpgsql: double-quoted identifiers are one token (`new."updated_at" := now()` in a trigger, quoted names in function bodies).
- JSON: dates and times in postgres' format (`"2026-05-26"`, `"2026-05-26T10:30:00"`, `"...+00:00"`), and numerics as numbers, in `row_to_json`, `json_agg`, `to_json[b]`, `json[b]_build_object`, `json[b]_build_array`.
- Postgres' wording for errors the migration validator shows: duplicate column (`column "x" of relation "t" already exists`), NOT NULL (names the relation), policy predicate type, and syntax errors (`syntax error at or near "x"` / `at end of input`, code 42601).

## 4.0.3

- A user column named after a system column (`tableoid`, `xmin`, `cmin`, `xmax`, `cmax`, `ctid`) is refused in CREATE TABLE, ADD COLUMN and RENAME COLUMN, as postgres does: `column name "xmin" conflicts with a system column name`. The migration validator accepted DDL postgres rejects.

## 4.0.2

Gaps found by running 80 production projects' migrations and seeds through the agent's validator on pg-mem and on PGlite; all 80 now match. Requires `@tinbase/pgsql-ast-parser` 12.2.1.

- **Wrong results, fixed:** an aggregate inside a select-list subquery aggregated the *outer* query (`select id, (select count(*) from c where c.p = p.id) from p` returned one row); `agg(x ORDER BY y)` ignored its ORDER BY; `json_agg` / `jsonb_agg` dropped NULL inputs (postgres keeps them as json null).
- `f(unnest(arr))` calls `f` per element (`lower(unnest(emails))` resolved to the range overload); `RETURNS SETOF <scalar>` SQL functions.
- A set-returning call in a subquery's FROM reads the outer row (`from jsonb_array_elements(outer.col)`).
- `UPDATE t alias` / `DELETE FROM t alias`: the alias names the table, in the statement and its subqueries.
- plpgsql: a `FOR rec IN <query>` record's fields are usable in SQL statements inside the loop (`update … set x = rec.col`), including nested loops.
- `json -> key` / `->>` with a column, variable or expression key.
- `ALTER COLUMN … TYPE` and `RENAME COLUMN` keep the column's position.
- `INSERT … VALUES` checks each row against the target columns first ("INSERT has more expressions than target columns").

## 4.0.1

- Comparisons across type categories fail with Postgres' own error, `operator does not exist: uuid = text` (was `cannot cast type text to uuid`), types spelled as Postgres spells them. Also for `x IN (select col ...)`. The SQL that is rejected does not change.

## 4.0.0

Postgres parity for validating real Supabase migrations: pg-mem now rejects what Postgres rejects, rolls back schema changes, and enforces row-level security on every read and write path. Found by running 250 real RapidNative projects' migrations and seeds through pg-mem and PGlite side by side (`tools/corpus-diff`); all 5 sets of 50 now match. Requires `@tinbase/pgsql-ast-parser` 12.2.0.

### Breaking changes

- **Typed values no longer cross type categories implicitly.** `uuid_col = text_col`, `bool = text`, `IN`, `COALESCE`, `LIKE` and function arguments fail as in Postgres ("operator does not exist: uuid = text"). Untyped literals and bind parameters still coerce.
- **`numeric` and `bigint` always read back as strings**, as node-postgres returns them, whatever the insert path.
- **DDL is transactional.** `ROLLBACK`, `ROLLBACK TO SAVEPOINT` or a failed call undoes schema changes, including a `ROLLBACK` inside a multi-statement call; a failed DDL statement leaves no partial schema.
- **`ON CONFLICT (cols) DO NOTHING RETURNING` returns nothing for a conflicting row** (it returned the existing row).
- `date - date` returns an integer (days), as in Postgres.

### Validation

- `CREATE POLICY` binds its predicates: unknown columns, bad operators, non-boolean predicates, `USING` on INSERT, `WITH CHECK` on SELECT/DELETE fail at creation.
- `ALTER COLUMN TYPE` / `DROP COLUMN` refuse columns a policy or foreign key depends on. `CREATE TRIGGER` resolves its function; `GRANT` / `CREATE POLICY ... TO` check the role exists.
- int2/int4/int8 range checks; strict text-to-number parsing.

### Row-level security

- **Security fix: RLS was skipped on index lookups** — `select ... where id = 2`, and `UPDATE` / `DELETE ... WHERE <pk>`, reached rows no policy allowed.
- **Security fix: `INSERT ... ON CONFLICT DO UPDATE`** updated rows the role could not update; the conflicting row now has to pass the UPDATE and SELECT `USING` policies, and the result UPDATE `WITH CHECK`.
- "infinite recursion detected in policy for relation", following Postgres' expansion rules, for the roles whose policies recurse.
- A policy's subqueries see the other tables' policies as they are when the query runs (not as they were at `CREATE POLICY`).
- `SECURITY DEFINER` functions run as their owner.

### Transactions

- `BEGIN ... ROLLBACK` across separate query calls rolls back; a failed statement, including one that fails to compile, aborts the block; `ROLLBACK TO SAVEPOINT` recovers an aborted block without ending it.
- Savepoints capture the schema lazily (on the first DDL after them) and release frees it.
- Referential actions run breadth-first, like Postgres RI triggers.
- `now()` / `current_date` are transaction-stable.

### Also

- plpgsql: `->>` in bodies, `%ROWTYPE` / `%TYPE`. `CREATE OR REPLACE TRIGGER`.
- `information_schema.columns` reports Postgres type names and `pg_get_expr`-style defaults; Postgres names for unnamed constraints and indexes.
- Timestamp/date arithmetic, `interval::text`, `record::text`, `jsonb ? ?| ?&`.

### Footprint (Node 24, the agent validator's workload)

| | PGlite | pg-mem |
|---|---|---|
| first ready instance | ~670 ms, +590–830 MB RSS | ~33 ms, +40 MB |
| each extra concurrent session | ~+255 MB | ~+7 MB |
| browser download (gz) | ~6.7 MB | ~0.19 MB |

## 3.3.0

Schema introspection reports what the engine actually knows.

These catalogues existed but returned a constant or nothing at all. That is worse than a missing feature: a consumer generating code from `information_schema` is told something untrue rather than being told to look elsewhere. The bug that surfaced it — generating TypeScript types from applied migrations — produced non-null types for every nullable column, so callers skipped null checks the database would hand them.

### `information_schema.columns`

- **`is_nullable`** is read from the column instead of being hardcoded `'NO'`, and follows `alter column set not null`. Relations that expose no column definitions (views, function-call tables) report `'YES'` rather than throwing.
- **`column_default`** is rendered as SQL text — `now()`, `3`, `'x'` — and cleared by `drop default`. `ColRef` now retains the default's AST alongside the built value: the evaluator cannot supply the original expression, because its `hash` is a sha1 digest for anything that is not a literal. Rendering is normalised toward Postgres' spelling (`now()`, not `(now () )`), and a wrapping paren pair is stripped only when it encloses the whole expression, so `(2 + 3) * 2` survives intact.

### Foreign keys

- Foreign keys now appear in **`information_schema.table_constraints`** and **`key_column_usage`**. `ForeignKey` records its local and foreign columns and its on-delete/on-update rules at install time; it had all of this in hand and discarded it.
- New **`information_schema.referential_constraints`** — this is where `on delete cascade` becomes readable without parsing DDL, via `delete_rule`, `update_rule` and `match_option`.
- `ConstraintWrapper` exposes the constraint it wraps. The constraint map holds wrappers, so introspection could not otherwise classify a constraint as a foreign key.
- `MemoryTable.listConstraints()` exposes a table's constraints read-only.

### Triggers

- New **`information_schema.triggers`** — one row per trigger *per event*, as Postgres does, so `before insert or update` yields two rows. Reports timing, orientation, the executed function, and whether a `WHEN` condition exists.
- New **`pg_trigger`** — one row per trigger, with a real `tgtype` bitmask (`ROW|BEFORE|INSERT|UPDATE` = 23) for callers that read timing and events the way Postgres encodes them. `tgrelname` and `tgfname` are exposed alongside the synthetic oids, which are not usable for joins here.

The engine already modelled triggers completely; they were simply invisible to introspection.

### Tests

15 assertions in `src/tests/introspection-metadata.spec.ts`, checked against Postgres 17 behaviour. Full suite: 1241 pass, 0 fail.

### Known gaps, for the record

- `pg_class.enumerate()` is commented out entirely, so `pg_class` is empty and `relrowsecurity` reports nothing. `pg_tables.rowsecurity` works and is the thing to use.
- `information_schema.routines`, `information_schema.views` and `pg_proc` report nothing for user-defined functions and views, though both are created and callable.
- `create publication` / `alter publication … add table` (Supabase realtime) and `insert into t default values` fail to **parse**. That is `pgsql-ast-parser`, not this package.
- `create extension pgcrypto` succeeds but `gen_salt()` / `crypt()` do not exist.

### Not a regression, worth stating

RLS enforcement was investigated during this work and is correct: policies filter rows for a non-owner role, and a superuser bypasses them — which is real Postgres behaviour, not a gap. A test that queries as the table owner therefore proves nothing; switch role first.

```ts
db.public.none(`select set_config('request.jwt.claim.sub', '<uuid>', false)`);
db.public.none('set role authenticated');
db.public.many('select id from workouts');   // filtered by the policy
```
