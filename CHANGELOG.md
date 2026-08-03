# Changelog

Notable changes to `@tinbase/pg-mem`, the tinbase fork of pg-mem.

Released from `main`, which carries the scoped package name. Upstream is tracked through the `upstream` remote (`oguimbal/pg-mem`) rather than a branch; the leftover `master` is vestigial.

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
