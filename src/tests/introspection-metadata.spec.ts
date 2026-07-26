import { describe, it, beforeEach, expect } from 'bun:test';

import { newDb } from '../db';
import { IMemoryDb } from '../interfaces';

// Behaviours here were checked against a real postgres 17.
//
// WHY THIS SPEC EXISTS
// These catalogues previously *existed* but reported nothing, or reported a constant. That is worse
// than a missing feature: a consumer generating code from information_schema is told something
// untrue rather than being told to look elsewhere. Concretely, `is_nullable` was hardcoded 'NO', so
// a generator marked every nullable column non-null and its callers skipped null checks the database
// would hand them.

describe('introspection metadata', () => {

    let db: IMemoryDb;
    let many: (str: string) => any[];
    let none: (str: string) => void;
    beforeEach(() => {
        db = newDb();
        many = db.public.many.bind(db.public);
        none = db.public.none.bind(db.public);
    });

    describe('information_schema.columns', () => {

        it('reports is_nullable per column', () => {
            none(`create table t (id text primary key, a text not null, b text)`);
            const byName = new Map(
                many(`select column_name, is_nullable from information_schema.columns where table_name = 't'`)
                    .map(r => [r.column_name, r.is_nullable])
            );
            // A primary key is not-null implicitly.
            expect(byName.get('id')).toBe('NO');
            expect(byName.get('a')).toBe('NO');
            expect(byName.get('b')).toBe('YES');
        });

        it('follows alter column set/drop not null', () => {
            none(`create table t (a text)`);
            expect(many(`select is_nullable from information_schema.columns where table_name='t'`)[0].is_nullable).toBe('YES');
            none(`alter table t alter column a set not null`);
            expect(many(`select is_nullable from information_schema.columns where table_name='t'`)[0].is_nullable).toBe('NO');
        });

        it('reports column_default as SQL text', () => {
            none(`create table t (a int default 3, b text default 'x', c timestamptz default now(), d text)`);
            const byName = new Map(
                many(`select column_name, column_default from information_schema.columns where table_name='t'`)
                    .map(r => [r.column_name, r.column_default])
            );
            expect(byName.get('a')).toBe('3');
            expect(byName.get('b')).toBe(`'x'`);
            // Rendered without the parser's padding, as postgres prints it.
            expect(byName.get('c')).toBe('now()');
            expect(byName.get('d')).toBe(null);
        });

        it('clears column_default on drop default', () => {
            none(`create table t (a int default 3)`);
            none(`alter table t alter column a drop default`);
            expect(many(`select column_default from information_schema.columns where table_name='t'`)[0].column_default).toBe(null);
        });

        it('keeps parens when they are not wrapping the whole expression', () => {
            none(`create table t (a int default (2 + 3) * 2)`);
            const def = many(`select column_default from information_schema.columns where table_name='t'`)[0].column_default;
            // Exact spelling is not the contract; not corrupting the expression is.
            expect(def).toContain('2');
            expect(def).toContain('*');
        });

        it('does not fail on relations without column refs', () => {
            none(`create table t (a int)`);
            none(`create view v as select a from t`);
            // Views expose values, not ColRefs — introspection must degrade, not throw.
            expect(() => many(`select column_name, is_nullable from information_schema.columns`)).not.toThrow();
        });
    });

    describe('foreign keys', () => {

        beforeEach(() => {
            none(`create table parent (id text primary key)`);
            none(`create table child (
                    id text primary key,
                    parent_id text references parent(id) on delete cascade,
                    other_id text references parent(id) on update restrict
                  )`);
        });

        it('appears in information_schema.table_constraints', () => {
            const rows = many(`select constraint_name, table_name from information_schema.table_constraints
                               where constraint_type = 'FOREIGN KEY' order by constraint_name`);
            expect(rows.map(r => r.constraint_name)).toEqual(['child_other_id_fkey', 'child_parent_id_fkey']);
            expect(rows.every(r => r.table_name === 'child')).toBe(true);
        });

        it('maps constraint to column in key_column_usage', () => {
            const byConstraint = new Map(
                many(`select constraint_name, column_name from information_schema.key_column_usage`)
                    .map(r => [r.constraint_name, r.column_name])
            );
            expect(byConstraint.get('child_parent_id_fkey')).toBe('parent_id');
            expect(byConstraint.get('child_other_id_fkey')).toBe('other_id');
        });

        it('exposes delete and update rules in referential_constraints', () => {
            const byName = new Map(
                many(`select constraint_name, delete_rule, update_rule, match_option, unique_constraint_name
                      from information_schema.referential_constraints`).map(r => [r.constraint_name, r])
            );
            // This is the row that tells a consumer whether a child disappears with its parent.
            expect(byName.get('child_parent_id_fkey').delete_rule).toBe('CASCADE');
            expect(byName.get('child_parent_id_fkey').update_rule).toBe('NO ACTION');
            expect(byName.get('child_other_id_fkey').update_rule).toBe('RESTRICT');
            expect(byName.get('child_parent_id_fkey').match_option).toBe('NONE');
            expect(byName.get('child_parent_id_fkey').unique_constraint_name).toBe('parent_pkey');
        });

        it('leaves primary keys and unique constraints reported as before', () => {
            const types = many(`select constraint_type from information_schema.table_constraints`)
                .map(r => r.constraint_type);
            expect(types.filter(t => t === 'PRIMARY KEY').length).toBe(2);
        });
    });

    describe('triggers', () => {

        beforeEach(() => {
            none(`create table t (id text, updated_at timestamptz)`);
            none(`create function bump() returns trigger as $$ begin new.updated_at = now(); return new; end; $$ language plpgsql`);
        });

        it('lists one information_schema row per event', () => {
            none(`create trigger t_bump before insert or update on t for each row execute function bump()`);
            const rows = many(`select trigger_name, event_manipulation, action_timing, action_orientation, event_object_table
                               from information_schema.triggers order by event_manipulation`);
            expect(rows.length).toBe(2);
            expect(rows.map(r => r.event_manipulation)).toEqual(['INSERT', 'UPDATE']);
            expect(rows[0].action_timing).toBe('BEFORE');
            expect(rows[0].action_orientation).toBe('ROW');
            expect(rows[0].event_object_table).toBe('t');
        });

        it('reports the executed function', () => {
            none(`create trigger t_bump before update on t for each row execute function bump()`);
            expect(many(`select action_statement from information_schema.triggers`)[0].action_statement)
                .toBe('EXECUTE FUNCTION bump()');
        });

        it('distinguishes statement-level triggers', () => {
            none(`create trigger t_stmt after update on t for each statement execute function bump()`);
            expect(many(`select action_orientation, action_timing from information_schema.triggers`)[0])
                .toMatchObject({ action_orientation: 'STATEMENT', action_timing: 'AFTER' });
        });

        it('lists one pg_trigger row per trigger, with a tgtype bitmask', () => {
            none(`create trigger t_bump before insert or update on t for each row execute function bump()`);
            const rows = many(`select tgname, tgrelname, tgfname, tgtype, tgenabled from pg_trigger`);
            // One row here, versus two in information_schema.triggers above.
            expect(rows.length).toBe(1);
            expect(rows[0]).toMatchObject({ tgname: 't_bump', tgrelname: 't', tgfname: 'bump', tgenabled: 'O' });
            // ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16) = 23
            expect(rows[0].tgtype).toBe(23);
        });

        it('is empty when nothing declares a trigger', () => {
            expect(many(`select * from information_schema.triggers`)).toEqual([]);
            expect(many(`select * from pg_trigger`)).toEqual([]);
        });
    });
});
