import { describe, it, beforeEach, expect } from 'bun:test';

import { newDb } from '../db';
import { IMemoryDb } from '../interfaces';
import { expectQueryError } from './test-utils';

// Gaps found by running real project migrations through pg-mem and PGlite side by side
// (tools/corpus-diff). Each case is distilled from a statement Postgres and pg-mem disagreed on.

describe('corpus parity', () => {

    let db: IMemoryDb;
    let many: (str: string) => any[];
    let none: (str: string) => void;
    beforeEach(() => {
        db = newDb();
        many = db.public.many.bind(db.public);
        none = db.public.none.bind(db.public);
    });

    describe('a transaction block spans query calls', () => {
        // Drivers send BEGIN, the work and ROLLBACK as separate round-trips. pg-mem used to
        // commit at the end of every call, so the rollback undid nothing.
        beforeEach(() => none(`create table k (id int primary key, n int); insert into k values (1, 1), (2, 2)`));
        const ns = () => many(`select n from k order by id`).map(r => r.n);

        it('ROLLBACK undoes work sent in earlier calls', () => {
            none(`begin`);
            none(`delete from k`);
            expect(many(`select count(*) from k`)).toEqual([{ count: 0 }]);
            none(`rollback`);
            expect(ns()).toEqual([1, 2]);
        });

        it('COMMIT keeps it', () => {
            none(`begin`);
            none(`update k set n = 9`);
            none(`commit`);
            expect(ns()).toEqual([9, 9]);
        });

        it('a failed statement aborts the block until it ends, and COMMIT then rolls back', () => {
            none(`begin`);
            none(`update k set n = 5`);
            expectQueryError(() => none(`insert into k values (1, 0)`), /duplicate key/);
            expectQueryError(() => none(`select 1`), /current transaction is aborted/);
            none(`commit`);
            expect(ns()).toEqual([1, 2]);
            expect(many(`select 1 as x`)).toEqual([{ x: 1 }]);
        });

        it('a statement that fails to compile aborts the block too', () => {
            none(`begin`);
            none(`insert into k values (3, 3)`);
            expectQueryError(() => many(`select * from k where nope = 1`), /nope/);
            expectQueryError(() => many(`select 1`), /current transaction is aborted/);
            none(`commit`);
            expect(ns()).toEqual([1, 2]);
        });

        it('ROLLBACK TO SAVEPOINT recovers an aborted block without ending it', () => {
            // the agent validator's attempt(): savepoint, run the model's SQL, rewind on error
            none(`begin`);
            none(`create table keep (id int); insert into k values (3, 3)`);
            for (const bad of [`create table t1 (id uuid); select * from t1 where id = 'x'::text`, `create table t2 (id int); insert into t2 values (1/0)`]) {
                none(`savepoint attempt`);
                expectQueryError(() => none(bad));
                none(`rollback to savepoint attempt`);
                none(`release savepoint attempt`);
            }
            expectQueryError(() => none(`insert into k values (4, 1/0)`));
            expectQueryError(() => none(`rollback to savepoint nope`), /savepoint "nope" does not exist/);
            expectQueryError(() => many(`select 1`), /current transaction is aborted/);
            none(`rollback`);
            none(`begin; savepoint s; insert into k values (5, 5)`);
            expectQueryError(() => none(`insert into k values (6, 1/0)`));
            none(`rollback to savepoint s; insert into k values (7, 7); commit`);
            expect(ns()).toEqual([1, 2, 7]);
            expect(many(`select table_name from information_schema.tables where table_name in ('keep', 't1', 't2')`)).toEqual([]);
        });

        it('a re-declared savepoint is the newest one', () => {
            none(`begin; savepoint s; savepoint t; savepoint s; rollback to savepoint s; release savepoint t; rollback`);
        });

        it('savepoints that see no DDL do not copy the schema', () => {
            none(`begin`);
            for (let i = 0; i < 50; i++) {
                none(`savepoint s${i}; create table x${i} (id int); rollback to savepoint s${i}; release savepoint s${i}`);
            }
            none(`savepoint a; create table kept (id int); savepoint b; create table gone (id int); rollback to savepoint b; commit`);
            expect(many(`select table_name from information_schema.tables where table_name in ('kept', 'gone', 'x0')`)).toEqual([{ table_name: 'kept' }]);
        });

        it('savepoints work across calls', () => {
            none(`begin`);
            none(`insert into k values (3, 3)`);
            none(`savepoint a`);
            none(`insert into k values (4, 4)`);
            none(`rollback to savepoint a`);
            none(`commit`);
            expect(ns()).toEqual([1, 2, 3]);
        });

        it('statements outside a block still autocommit', () => {
            none(`update k set n = 7 where id = 1`);
            none(`rollback`);
            expect(ns()).toEqual([7, 2]);
        });
    });

    describe('typed values do not cross type categories implicitly', () => {
        // pg-mem accepted `auth.uid() = <text column>`; postgres has no uuid = text operator and
        // refuses at CREATE POLICY - a shipped migration failed exactly there.
        beforeEach(() => none(`create table t (u uuid, s text, i int, bi bigint, b bool, ts timestamptz, d date, j jsonb, v varchar(10), n numeric)`));
        const rejects = (expr: string) => expectQueryError(() => many(`select 1 from t where ${expr}`));
        const accepts = (expr: string) => expect(() => many(`select 1 from t where ${expr}`)).not.toThrow();

        it('rejects comparisons postgres has no operator for', () => {
            for (const e of ['u = s', 's = u', 'b = s', 's = true', 'v = u', 'u in (s)', 'u is not distinct from s',
                'coalesce(u, s) is null', `s in ('a', 1)`, 'lower(u) = s', 's like 1', `i like 'x'`,
                'u in (select s from t)', 'u not in (select s from t)', 's in (select u from t)']) {
                rejects(e);
            }
        });

        it('says which operator does not exist, as postgres does', () => {
            expectQueryError(() => many(`select 1 from t where u = s`), /operator does not exist: uuid = text/);
            expectQueryError(() => many(`select 1 from t where b = s`), /operator does not exist: boolean = text/);
            expectQueryError(() => many(`select 1 from t where s = i`), /operator does not exist: text = integer/);
            expectQueryError(() => many(`select 1 from t where u in (select s from t)`), /operator does not exist: uuid = text/);
        });

        it('still coerces untyped literals and widens within a category', () => {
            for (const e of [`u = '00000000-0000-0000-0000-000000000001'`, `i = '1'`, 'i = bi', 'bi = i', 'i = n', 'd = ts', 'ts > d',
                'd = now()', 's = v', 'u::text = s', `s || i = 'x1'`, `j ? s`, `concat(u, 'x') = s`]) {
                accepts(e);
            }
        });

        it('binds parameters as untyped', () => {
            none(`insert into t (u) values ('00000000-0000-0000-0000-000000000001')`);
            expect(db.public.prepare('select count(*) as c from t where u = $1').bind(['00000000-0000-0000-0000-000000000001']).executeAll().rows)
                .toEqual([{ c: 1 }]);
        });

        it('has jsonb key-existence operators', () => {
            expect(many(`select '{"a":1}'::jsonb ? 'a' as x, '["a"]'::jsonb ? 'a' as y, '{"a":1}'::jsonb ?| array['z','a'] as z, '{"a":1}'::jsonb ?& array['z','a'] as w`))
                .toEqual([{ x: true, y: true, z: true, w: false }]);
        });
    });

    describe('CREATE POLICY binds its predicates', () => {
        beforeEach(() => none(`create schema auth;
            create function auth.uid() returns uuid as $$ select null::uuid $$ language sql stable;
            create table p (id text primary key, owner uuid, title text)`));

        it('rejects an operator that does not exist for the operand types', () => {
            expectQueryError(() => none(`create policy x on p for select using (auth.uid() = id)`), /cannot cast|operator does not exist/);
        });
        it('rejects an unknown column', () => {
            expectQueryError(() => none(`create policy x on p for select using (nope = 1)`), /nope/);
        });
        it('rejects a non-boolean predicate', () => {
            expectQueryError(() => none(`create policy x on p for select using (title)`), /must be type boolean/);
        });
        it('rejects USING on INSERT and WITH CHECK on SELECT/DELETE', () => {
            expectQueryError(() => none(`create policy x on p for insert using (auth.uid() = owner)`), /only WITH CHECK/);
            expectQueryError(() => none(`create policy x on p for select with check (auth.uid() = owner)`), /WITH CHECK cannot be applied/);
        });
        it('accepts a well-typed policy', () => {
            none(`create policy x on p for all using (auth.uid() = owner) with check (auth.uid() = owner)`);
        });
    });

    describe('dependency checks on DDL', () => {
        beforeEach(() => none(`create table parent (id text primary key, owner text);
            create table child (id text primary key, parent_id text references parent(id), note text);
            create policy c on child for select using (exists (select 1 from parent p where p.id = child.parent_id and p.owner = 'x'))`));

        it('refuses to retype a column any policy reads, even from another table', () => {
            expectQueryError(() => none(`alter table child alter column parent_id type text`), /used in a policy definition/);
            expectQueryError(() => none(`alter table parent alter column owner type varchar(20)`), /used in a policy definition/);
            none(`alter table child alter column note type varchar(50)`);
            // p.id in the subquery is parent.id, not child.id
            none(`alter table child alter column id type varchar(50)`);
        });
        it('refuses to drop a column a foreign key or a policy depends on, unless CASCADE', () => {
            expectQueryError(() => none(`alter table parent drop column id`), /other objects depend on it/);
            expectQueryError(() => none(`alter table parent drop column owner`), /other objects depend on it/);
            none(`alter table parent drop column owner cascade`);
            expect(many(`select policyname from pg_policies where tablename = 'child'`)).toEqual([]);
        });
        it('resolves the trigger function at CREATE TRIGGER', () => {
            expectQueryError(() => none(`create trigger t before update on child for each row execute function nope()`), /does not exist/);
            none(`create function f() returns int language sql as $$ select 1 $$`);
            expectQueryError(() => none(`create trigger t before update on child for each row execute function f()`), /must return type trigger/);
        });
    });

    describe('unnamed constraints and indexes get postgres names', () => {
        beforeEach(() => none(`create table x (id int primary key, a int check (a > 0), b int, e text, f text,
            check (a > b), check (b > 0), unique (e, f), unique (e))`));
        it('names checks <table>_<col>_check, or <table>_check over several columns', () => {
            // dropping by the postgres name is how migrations widen an enum-like check
            none(`alter table x drop constraint x_a_check`);
            none(`alter table x drop constraint x_check`);
            none(`alter table x drop constraint x_b_check`);
            none(`alter table x add check (b < 100)`);
            none(`alter table x drop constraint x_b_check`);
        });
        it('names unique constraints <table>_<cols>_key and indexes <table>_<cols>_idx', () => {
            none(`create index on x (a, b)`);
            expect(many(`select indexname from pg_indexes where tablename = 'x' order by 1`).map(r => r.indexname))
                .toEqual(['x_a_b_idx', 'x_e_f_key', 'x_e_key', 'x_pkey']);
        });
    });

    describe('three-valued IN', () => {
        it('a NULL operand passes a CHECK (col IN (...))', () => {
            none(`create table r (v text check (v in ('a', 'b')))`);
            none(`insert into r values (null)`);
            expectQueryError(() => none(`insert into r values ('c')`), /r_v_check/);
        });
        it('NULL IN / NOT IN a list holding NULL is NULL', () => {
            expect(many(`select (null in (1, 2)) is null as a, (1 not in (2, null)) is null as b, 1 in (1, null) as c`))
                .toEqual([{ a: true, b: true, c: true }]);
        });
    });

    describe('CREATE TABLE IF NOT EXISTS on an existing table', () => {
        it('is a no-op even when the new definition has constraints', () => {
            none(`create table v (id text primary key)`);
            none(`create table if not exists v (id text primary key, n int not null default 0 check (n > 0) references v(id))`);
            expect(many(`select column_name from information_schema.columns where table_name = 'v'`)).toEqual([{ column_name: 'id' }]);
        });
    });

    describe('numeric input', () => {
        beforeEach(() => none(`create table n (i int, s smallint, b bigint, d numeric(10, 2), f float)`));
        it('range-checks integers', () => {
            expectQueryError(() => none(`insert into n (i) values (3000000000)`), /integer out of range/);
            expectQueryError(() => none(`insert into n (i) values ('3000000000')`), /integer out of range/);
            expectQueryError(() => none(`insert into n (s) values (70000)`), /smallint out of range/);
            none(`insert into n (i, s, b) values (2147483647, 32767, 3000000000)`);
        });
        it('parses text strictly into the stored representation', () => {
            expectQueryError(() => none(`insert into n (i) values ('12abc')`), /invalid input syntax/);
            none(`insert into n (d, f) values ('5200.456', '1.5')`);
            expect(many(`select d, d + 1 as d1, f from n where d is not null`)).toEqual([{ d: '5200.46', d1: '5201.46', f: 1.5 }]);
        });
    });

    describe('transaction time', () => {
        it('now() and current_timestamp are constant within a transaction', () => {
            none(`begin`);
            const [{ a }] = many(`select now() as a`);
            const t0 = Date.now(); while (Date.now() - t0 < 5) { /* let the clock move */ }
            const [{ b, c }] = many(`select now() as b, current_timestamp as c`);
            none(`commit`);
            expect(b.getTime()).toBe(a.getTime());
            expect(c.getTime()).toBe(a.getTime());
        });
        it('current_date is a date (midnight), usable in a column default', () => {
            none(`create table d (x date not null default current_date, y date)`);
            none(`insert into d (y) values (current_date + 2)`);
            const [{ x, y }] = many(`select x, y from d`);
            expect(x.getUTCHours()).toBe(0);
            expect((y.getTime() - x.getTime()) / 86400_000).toBe(2);
        });
    });

    describe('information_schema.columns reports postgres type names', () => {
        it('matches data_type / udt_name', () => {
            none(`create table c (a varchar(20), b smallint, c real, d numeric, e boolean, f timestamptz, g text[], h char(3))`);
            expect(many(`select column_name, data_type, udt_name from information_schema.columns where table_name = 'c' order by ordinal_position`)
                .map(r => `${r.column_name}:${r.data_type}:${r.udt_name}`))
                .toEqual(['a:character varying:varchar', 'b:smallint:int2', 'c:real:float4', 'd:numeric:numeric', 'e:boolean:bool',
                    'f:timestamp with time zone:timestamptz', 'g:ARRAY:_text', 'h:character:bpchar']);
        });
    });

    describe('supabase function & view DDL', () => {
        it('accepts SECURITY DEFINER ... SET search_path, and DROP VIEW / DROP FUNCTION f()', () => {
            none(`create table t (id int)`);
            none(`create or replace function public.h() returns trigger language plpgsql security definer set search_path = public as $$ begin return new; end $$`);
            none(`create function g() returns int language sql stable set search_path = '' cost 5 parallel safe as $$ select 1 $$`);
            none(`create view v with (security_invoker = true) as select * from t`);
            none(`drop view if exists v; drop view if exists v; drop function if exists g() cascade`);
        });
    });

    describe('plpgsql', () => {
        beforeEach(() => none(`create table markets (id text primary key, title text, status text, meta jsonb);
            insert into markets values ('a', 'Rain?', 'open', '{"k": "v"}'), ('b', 'Snow?', 'settled', null)`));

        it('reads multi-character operators (->>) inside bodies', () => {
            none(`create function k(mid text) returns text language plpgsql as $$ begin return (select meta->>'k' from markets where id = mid); end $$`);
            expect(many(`select k('a') as x`)).toEqual([{ x: 'v' }]);
        });

        it('supports %ROWTYPE and %TYPE variables, resolved at first call', () => {
            none(`create function st(mid text) returns text language plpgsql as $$
                declare m public.markets%rowtype; s markets.status%type;
                begin select * into m from markets where id = mid; s := m.status;
                if m.status <> 'open' then return 'closed:' || m.title; end if; return 'open:' || s; end $$`);
            expect(many(`select st('a') as a, st('b') as b`)).toEqual([{ a: 'open:open', b: 'closed:Snow?' }]);
        });

        it('runs a SECURITY DEFINER body as its owner, so RLS does not filter inside it', () => {
            none(`create role authenticated;
                create table members (crew int, uid text); alter table members enable row level security;
                create policy own on members for select to authenticated using (uid = current_setting('app.uid'));
                insert into members values (1, 'me'), (1, 'you'), (2, 'you');
                create function crew_size(c int) returns int language sql stable security definer as $$ select count(*)::int from members where crew = c $$;
                create function crew_size_invoker(c int) returns int language sql stable as $$ select count(*)::int from members where crew = c $$`);
            none(`select set_config('app.uid', 'me', false)`);
            none(`set role authenticated`);
            expect(many(`select crew_size(1) as d, crew_size_invoker(1) as i, current_user as u`)).toEqual([{ d: 2, i: 1, u: 'authenticated' }]);
        });
    });

    describe('date/time and record arithmetic', () => {
        it('subtracts timestamps into an interval, and dates into days', () => {
            expect(many(`select (timestamptz '2026-01-01' - timestamptz '2026-01-02 06:30:00')::text as a,
                current_date - (current_date - 3) as b`)).toEqual([{ a: '-1 days -06:30:00', b: 3 }]);
        });
        it('renders intervals and rows as text like postgres', () => {
            expect(many(`select (interval '3 months')::text as a, (interval '0')::text as b`)).toEqual([{ a: '3 mons', b: '00:00:00' }]);
            expect(many(`select 'x-' || s as r from (values ('a b')) as s(suffix)`)).toEqual([{ r: 'x-("a b")' }]);
        });
    });

    describe('DROP and re-CREATE', () => {
        it('removes foreign keys into a table dropped with CASCADE from the catalogues', () => {
            none(`create table pr (id int primary key); create table li (u int references pr(id) on delete cascade, v int references pr(id));
                drop table pr cascade; create table pr (id int primary key)`);
            expect(many(`select constraint_name from information_schema.table_constraints where table_name = 'li' and constraint_type = 'FOREIGN KEY'`)).toEqual([]);
        });

        it('frees the dropped table index names', () => {
            none(`create table p (id int primary key, e text unique)`);
            none(`drop table if exists p cascade`);
            none(`create table p (id int primary key, e text unique)`);
        });
    });

    describe('grantees must exist', () => {
        it('rejects GRANT / CREATE POLICY ... TO an unknown role', () => {
            none(`create table p (id int)`);
            expectQueryError(() => none(`grant select on p to service_role`), /role "service_role" does not exist/);
            expectQueryError(() => none(`create policy x on p for select to service_role using (true)`), /role "service_role" does not exist/);
            expectQueryError(() => none(`grant select on nope to public`), /nope/);
            none(`create role service_role; grant all on p to service_role, public`);
        });
    });

    describe('DDL is transactional', () => {
        // expectations checked against PGlite (real Postgres)
        const n = (q: string) => many(q)[0].n;

        it('a failed multi-statement call leaves nothing behind', () => {
            expectQueryError(() => none(`create table a(x int); insert into a values (1); select nope_fn()`));
            expect(n(`select count(*)::int as n from pg_tables where tablename = 'a'`)).toBe(0);
        });
        it('ROLLBACK undoes CREATE TABLE, and restores a dropped table with its rows', () => {
            none(`begin`); none(`create table b(x int)`); none(`rollback`);
            expect(n(`select count(*)::int as n from pg_tables where tablename = 'b'`)).toBe(0);
            none(`create table c(x int primary key); insert into c values (1), (2)`);
            none(`begin`); none(`drop table c`); none(`rollback`);
            expect(n(`select count(*)::int as n from c`)).toBe(2);
        });
        it('restores a dropped foreign key, still enforced', () => {
            none(`create table p(id int primary key); create table ch(pid int constraint ch_fk references p(id))`);
            none(`begin`); none(`alter table ch drop constraint ch_fk`); none(`rollback`);
            expectQueryError(() => none(`insert into ch values (99)`), /ch_fk/);
        });
        it('undoes added columns, policies, RLS, functions, triggers and type changes', () => {
            none(`create table d(x int, y int)`);
            none(`create function d_trg() returns trigger language plpgsql as $$ begin new.y = 42; return new; end $$`);
            none(`begin`);
            none(`alter table d add column z text`);
            none(`alter table d enable row level security`);
            none(`create policy pd on d using (true)`);
            none(`create function f1() returns int language sql as $$ select 1 $$`);
            none(`create trigger tg before insert on d for each row execute function d_trg()`);
            none(`alter table d alter column x type text`);
            none(`rollback`);
            expect(n(`select count(*)::int as n from information_schema.columns where table_name = 'd'`)).toBe(2);
            expect(n(`select count(*)::int as n from pg_policies where tablename = 'd'`)).toBe(0);
            expect(many(`select rowsecurity from pg_tables where tablename = 'd'`)).toEqual([{ rowsecurity: false }]);
            expectQueryError(() => many(`select f1()`), /f1/);
            none(`insert into d (x) values (1)`);
            expect(many(`select x, y from d`)).toEqual([{ x: 1, y: null }]);
        });
        it('ROLLBACK TO SAVEPOINT undoes only the DDL after it', () => {
            none(`begin`); none(`create table h(x int)`); none(`savepoint s`);
            none(`alter table h add column y int`); none(`create index h_x on h(x)`);
            none(`rollback to savepoint s`); none(`commit`);
            expect(n(`select count(*)::int as n from information_schema.columns where table_name = 'h'`)).toBe(1);
            expect(n(`select count(*)::int as n from pg_indexes where tablename = 'h'`)).toBe(0);
            none(`create index h_x on h(x)`);
        });
        it('keeps DDL from a committed block', () => {
            none(`begin`); none(`create table i(x int)`); none(`insert into i values (5)`); none(`commit`);
            expect(many(`select x from i`)).toEqual([{ x: 5 }]);
        });
    });

    describe('referential actions run in postgres order (breadth-first)', () => {
        // outcomes checked against PGlite
        const count = (q: string) => Number(many(q)[0].n);

        it('a direct NO ACTION reference is checked before a grandchild cascade clears it', () => {
            none(`create table u (id int primary key); create table pr (id int primary key references u(id) on delete cascade);
                create table tx (id int primary key, acct int not null references pr(id) on delete cascade, by int references u(id));
                insert into u values (1); insert into pr values (1); insert into tx values (1, 1, 1)`);
            expectQueryError(() => none(`delete from u where id = 1`), /tx_by_fkey/);
            expect(count(`select (select count(*) from pr) + (select count(*) from tx) * 10 as n`)).toBe(11);
        });
        it('a direct CASCADE queued before a NO ACTION check satisfies it', () => {
            none(`create table u (id int primary key); create table a (uid int references u(id) on delete cascade, by int references u(id));
                insert into u values (1); insert into a values (1, 1)`);
            none(`delete from u where id = 1`);
            expect(count(`select count(*) as n from a`)).toBe(0);
        });
        it('a NO ACTION declared before the CASCADE fires first and fails', () => {
            none(`create table u (id int primary key); create table a (by int references u(id), uid int references u(id) on delete cascade);
                insert into u values (1); insert into a values (1, 1)`);
            expectQueryError(() => none(`delete from u where id = 1`), /a_by_fkey/);
        });
        it('cascades through chains and self references', () => {
            none(`create table t (id int primary key, parent int references t(id) on delete cascade);
                insert into t values (1, null), (2, 1), (3, 2), (4, null)`);
            none(`delete from t where id = 1`);
            expect(count(`select count(*) as n from t`)).toBe(1);
        });
    });

    describe('column_default reads like pg_get_expr', () => {
        it('prints literals as written and expressions without extra parens', () => {
            none(`create table o (a numeric default 0.30, b double precision default 0.0, d text[] default array['x','y'],
                e timestamptz default now() + interval '2 days', g int default -1, r bigint default 3000000000, i date default current_date)`);
            expect(many(`select column_name, column_default from information_schema.columns where table_name = 'o' order by ordinal_position`)
                .map(r => r.column_default))
                .toEqual(['0.30', '0.0', `ARRAY['x', 'y']`, `(now() + '2 days'::interval)`, `'-1'`, `'3000000000'`, 'CURRENT_DATE']);
        });
    });

    describe('policy expansion', () => {
        beforeEach(() => none(`create role authenticated;
            create table profiles (id int primary key, role text); alter table profiles enable row level security;
            create policy p_sel on profiles for select using (exists (select 1 from profiles p where p.id = 1 and p.role = 'admin'));
            create table cats (id int); alter table cats enable row level security;
            create policy c_sel on cats for select using (true);
            create policy c_upd on cats for update using (exists (select 1 from profiles p where p.id = 1));
            insert into cats values (1)`));

        it('fails on a policy that (indirectly) queries its own table, for roles RLS applies to', () => {
            none(`set role authenticated`);
            expectQueryError(() => many(`select * from profiles`), /infinite recursion detected in policy for relation "profiles"/);
            expectQueryError(() => none(`update cats set id = id`), /infinite recursion detected in policy for relation "profiles"/);
            expect(many(`select count(*)::int as n from cats`)).toEqual([{ n: 1 }]);
            none(`reset role`);
            expect(many(`select count(*)::int as n from profiles`)).toEqual([{ n: 0 }]);
        });
    });

    describe('a policy subquery sees the other table\'s policies as they are when it runs', () => {
        // the check CREATE POLICY runs used to leave its build cached, so enforcement reused a
        // subquery compiled under the other table's policies as they were at CREATE POLICY time
        beforeEach(() => none(`create role authenticated;
            create table members (team_id int, user_id text); create table teams (id int primary key);
            insert into teams values (1), (2); insert into members values (1, 'u1'), (2, 'u2');
            alter table teams enable row level security; alter table members enable row level security`));
        const teams = () => {
            none(`set role authenticated`);
            try {
                return many(`select id from teams order by id`).map(r => r.id);
            } finally {
                none(`reset role`);
            }
        };

        it('a policy created after the one that reads it applies', () => {
            none(`create policy t on teams for select using (exists (select 1 from members m where m.team_id = teams.id));
                create policy m on members for select using (user_id = 'u1')`);
            expect(teams()).toEqual([1]);
        });

        it('narrowing the other table\'s policy narrows the result', () => {
            none(`create policy m on members for select using (true);
                create policy t on teams for select using (exists (select 1 from members m where m.team_id = teams.id))`);
            expect(teams()).toEqual([1, 2]);
            none(`drop policy m on members; create policy m on members for select using (user_id = 'u1')`);
            expect(teams()).toEqual([1]);
            none(`alter table members disable row level security`);
            expect(teams()).toEqual([1, 2]);
        });

        it('replacing a recursive policy clears the recursion error', () => {
            none(`create policy t on teams for select using (exists (select 1 from teams x where x.id = teams.id))`);
            expectQueryError(() => teams(), /infinite recursion detected in policy for relation "teams"/);
            none(`drop policy t on teams; create policy t on teams for select using (id = 1)`);
            expect(teams()).toEqual([1]);
        });

        it('adding a recursive policy after a clean query reports the recursion', () => {
            none(`create policy t on teams for select using (id = 1)`);
            expect(teams()).toEqual([1]);
            none(`create policy t2 on teams for select using (exists (select 1 from teams x where x.id = teams.id))`);
            expectQueryError(() => teams(), /infinite recursion detected in policy for relation "teams"/);
        });
    });

    describe('RLS on INSERT ... ON CONFLICT', () => {
        // checked against PGlite: the conflicting row is subject to the UPDATE policies, and
        // DO NOTHING never hands back a row the insert did not write
        beforeEach(() => none(`create role alice;
            create table docs (id int primary key, owner text, body text);
            insert into docs values (1, 'alice', 'a1'), (2, 'bob', 'b2');
            alter table docs enable row level security;
            create policy s on docs for select using (owner = current_user);
            create policy i on docs for insert with check (owner = current_user);
            create policy u on docs for update using (owner = current_user) with check (owner = current_user);
            set role alice`));
        const rows = () => {
            none(`reset role`);
            return many(`select id, owner, body from docs order by id`);
        };

        it('DO UPDATE on a row the role may not update fails', () => {
            expectQueryError(() => many(`insert into docs values (2, 'alice', 'x') on conflict (id) do update set body = 'upserted' returning *`),
                /violates row-level security policy \(USING expression\)/);
            expect(rows()[1]).toEqual({ id: 2, owner: 'bob', body: 'b2' });
        });

        it('DO UPDATE checks the updated row against WITH CHECK, leaving it untouched on failure', () => {
            expect(many(`insert into docs values (1, 'alice', 'x') on conflict (id) do update set body = 'mine' returning body`)).toEqual([{ body: 'mine' }]);
            expectQueryError(() => none(`insert into docs values (1, 'alice', 'x') on conflict (id) do update set owner = 'bob'`),
                /violates row-level security policy/);
            expect(rows()[0]).toEqual({ id: 1, owner: 'alice', body: 'mine' });
        });

        it('DO NOTHING returns nothing for a conflicting row', () => {
            expect(many(`insert into docs values (2, 'alice', 'x') on conflict (id) do nothing returning *`)).toEqual([]);
            expect(many(`insert into docs values (2, 'alice', 'x') on conflict do nothing returning *`)).toEqual([]);
        });
    });

    describe('CREATE OR REPLACE TRIGGER', () => {
        it('replaces an existing trigger', () => {
            none(`create table o (id int, n int);
                create function f() returns trigger language plpgsql as $$ begin new.n = 1; return new; end $$;
                create function g() returns trigger language plpgsql as $$ begin new.n = 2; return new; end $$;
                create or replace trigger t before insert on o for each row execute function f();
                create or replace trigger t before insert on o for each row execute function g();
                insert into o (id) values (1)`);
            expect(many(`select n from o`)).toEqual([{ n: 2 }]);
        });
    });

    describe('RLS on index lookups', () => {
        it('applies policies to WHERE <pk> = … reads and writes', () => {
            none(`create role authenticated; create table pr (id int primary key, n text); alter table pr enable row level security;
                create policy s on pr for select using (id = 1); create policy u on pr for update using (id = 1); create policy d on pr for delete using (id = 1);
                insert into pr values (1, 'a'), (2, 'b')`);
            none(`set role authenticated`);
            expect(many(`select * from pr where id = 2`)).toEqual([]);
            expect(many(`select n from pr where id = 1`)).toEqual([{ n: 'a' }]);
            expect(db.public.query(`update pr set n = 'z' where id = 2`).rowCount).toBe(0);
            expect(db.public.query(`delete from pr where id in (2)`).rowCount).toBe(0);
            none(`reset role`);
            expect(many(`select n from pr order by id`)).toEqual([{ n: 'a' }, { n: 'b' }]);
        });
    });

    describe('policy recursion follows postgres rules', () => {
        // checked against PGlite
        beforeEach(() => none(`create role authenticated; create table pr (id int primary key, n text); alter table pr enable row level security`));
        it('an UPDATE policy reading its own table is fine when that table has no recursive SELECT policy', () => {
            none(`create policy s on pr for select using (true);
                create policy u on pr for update using (id = 1 or exists (select 1 from pr p where p.id = 2)); set role authenticated`);
            none(`update pr set n = n where id = 1`);
        });
        it('an UPDATE/DELETE that reads columns expands the recursive SELECT policy; one that does not, does not', () => {
            none(`create policy s on pr for select using (id = 1 or exists (select 1 from pr p where p.id = 2));
                create policy u on pr for update using (id = 1); create policy d on pr for delete using (id = 1); set role authenticated`);
            expectQueryError(() => none(`update pr set n = 'x' where id = 1`), /infinite recursion/);
            expectQueryError(() => none(`delete from pr where id = 1`), /infinite recursion/);
            none(`update pr set n = 'x'`);
            none(`delete from pr`);
        });
    });

    describe('CREATE OR REPLACE FUNCTION', () => {
        it('replaces a trigger function that triggers already use, in a later call', () => {
            none(`create table p (id int, updated_at timestamptz);
                create or replace function set_updated_at() returns trigger as $$ begin new.updated_at = now(); return new; end $$ language plpgsql;
                create trigger p_upd before update on p for each row execute function set_updated_at()`);
            none(`create or replace function set_updated_at() returns trigger as $$ begin new.updated_at = '2000-01-01'; return new; end $$ language plpgsql`);
            none(`insert into p (id) values (1); update p set id = 2`);
            expect(many(`select extract(year from updated_at) as y from p`)).toEqual([{ y: 2000 }]);
        });
        it('still refuses to change a return type', () => {
            none(`create function f2() returns int language sql as $$ select 1 $$`);
            expectQueryError(() => none(`create or replace function f2() returns text language sql as $$ select 'a' $$`), /cannot change return type/);
        });
    });
});

