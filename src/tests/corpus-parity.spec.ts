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
                'coalesce(u, s) is null', `s in ('a', 1)`, 'lower(u) = s', 's like 1', `i like 'x'`]) {
                rejects(e);
            }
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
});

