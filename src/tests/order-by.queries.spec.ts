import { describe, it, beforeEach, expect } from 'bun:test';

import { newDb } from '../db';

import { _IDb } from '../interfaces-private';
import { expectQueryError } from './test-utils';

describe('Order by', () => {

    let db: _IDb;
    let many: (str: string) => any[];
    let none: (str: string) => void;
    let one: (str: string) => any;
    beforeEach(() => {
        db = newDb() as _IDb;
        many = db.public.many.bind(db.public);
        none = db.public.none.bind(db.public);
        one = db.public.one.bind(db.public);
    });

    it('simple order by asc', () => {
        expect(many(`create table test(val text);
            insert into test values ('b'), ('a'), (null);
            select * from test order by val`))
            .toEqual([
                { val: 'a' }
                , { val: 'b' }
                , { val: null }
            ]);
    });

    it('simple order by desc', () => {
        expect(many(`create table test(val text);
            insert into test values ('b'), ('a'), (null);
            select * from test order by val desc`))
            .toEqual([
                { val: null }
                , { val: 'b' }
                , { val: 'a' }
            ]);
    });

    it('order on an aliased column', () => {
        expect(many(`create table test(val text);
            insert into test values ('b'), ('a'), (null);
            select t.val as value from test t order by t.val desc`))
            .toEqual([
                { value: null }
                , { value: 'b' }
                , { value: 'a' }
            ]);
    });

    it('can order by desc with nulls last', () => {
        expect(many(`create table test(val text);
            insert into test values ('b'), ('a'), (null);
            select t.val as value from test t order by t.val desc nulls last`))
            .toEqual([
                { value: 'b' }
                , { value: 'a' }
                , { value: null }
            ]);
    });

    it('can order by desc with nulls first', () => {
        expect(many(`create table test(val text);
            insert into test values ('b'), ('a'), (null);
            select t.val as value from test t order by t.val desc nulls first`))
            .toEqual([
                { value: null }
                , { value: 'b' }
                , { value: 'a' }
            ]);
    });

    it('can order by asc with nulls last', () => {
        expect(many(`create table test(val text);
            insert into test values ('b'), ('a'), (null);
            select t.val as value from test t order by t.val asc nulls last`))
            .toEqual([
                { value: 'a' }
                , { value: 'b' }
                , { value: null }
            ]);
    });

    it('can order by asc with nulls first', () => {
        expect(many(`create table test(val text);
            insert into test values ('b'), ('a'), (null);
            select t.val as value from test t order by t.val asc nulls first`))
            .toEqual([
                { value: null }
                , { value: 'a' }
                , { value: 'b' }
            ]);
    });

    it('order by two columns', () => {
        expect(many(`create table test(a integer, b integer);
            insert into test values (1, 13), (2, 11), (1, null), (1, 11), (2, 12), (1, 12), (null, 1), (null, 5);
            select * from test order by a, b desc`))
            .toEqual([
                { a: 1, b: null }
                , { a: 1, b: 13 }
                , { a: 1, b: 12 }
                , { a: 1, b: 11 }

                , { a: 2, b: 12 }
                , { a: 2, b: 11 }

                , { a: null, b: 5 }
                , { a: null, b: 1 }
            ]);
    });


    describe('orders jsonb values', () => {
        const trues = [
            ['{}', '>', '[]'],
            ['{}', '>', '1'],
            ['[]', '<', '1'],
            ['{"a":"b"}', '>', '{"a": "a"}'],
            ['{"a":"a", "b":"c"}', '>=', '{"a": "a"}'],
            ['{}', '>=', 'null'],
            ['1', '>=', 'null'],
            ['[]', '<', 'null'],
            ['[1, 2]', '>', '[1]'],
            ['[2, 2]', '>', '[1,2]'],
            ['null', '=', 'null'],
        ];

        const falses = [
            ['{"a":"a"}', '>', '{"a": "a"}'],
            ['{}', '<', '[]'],
            ['[]', '>=', 'null'],
            ['[1, 2]', '>', '[1,2,3]'],
            ['[2, 2]', '>', '[1,2,3]'],
            ['[2, 2]', '=', 'null'],
        ]

        for (const [l, c, r] of trues) {
            it(`✅ ${l} ${c} ${r}`, () => {
                expect(one(`select '${l}'::jsonb ${c} '${r}'::jsonb as v`))
                    .toEqual({ v: true });
            });
        }

        for (const [l, c, r] of falses) {
            it(`⛔ ${l} ${c} ${r}`, () => {
                expect(one(`select '${l}'::jsonb ${c} '${r}'::jsonb as v`))
                    .toEqual({ v: false });
            });
        }

        it('cannot compare with null', () => {
            expect(one(`select '{}'::jsonb = null as v`))
                .toEqual({ v: null });
            expect(one(`select '{}'::jsonb < null as v`))
                .toEqual({ v: null });
            expect(one(`select '{}'::jsonb > null as v`))
                .toEqual({ v: null });
            expect(one(`select '[]'::jsonb = null as v`))
                .toEqual({ v: null });
            expect(one(`select 'null'::jsonb = null as v`))
                .toEqual({ v: null });
            expect(one(`select 'null'::jsonb = null as v`))
                .toEqual({ v: null });
        })

    })

    it('can order by alias', () => {
        // fix for https://github.com/oguimbal/pg-mem/issues/216

        none(`CREATE TABLE test(field int);
                INSERT INTO test values (3),(1),(2);`);

        expect(many(`SELECT field FROM test ORDER BY field`).map(x => x.field))
            .toEqual([1, 2, 3]);

        // this used to throw
        expect(many(`SELECT field aliased FROM test ORDER BY aliased`).map(x => x.aliased))
            .toEqual([1, 2, 3]);
    })

    it('prefers aliased order when ambiguous', () => {
        none(`CREATE TABLE test(field int);
                INSERT INTO test values (3),(1),(2);`);

        expect(many(`SELECT field aliased, (-field) field FROM test ORDER BY field`).map(x => x.aliased))
            .toEqual([3, 2, 1]);
    });

    it('can order on base field computation', () => {
        none(`CREATE TABLE test(field int);
            INSERT INTO test values (3),(1),(2);`);


        expect(many(`SELECT field FROM test ORDER BY  -field`).map(x => x.field))
            .toEqual([3, 2, 1]);

    });

    it('cannot order on aliased computation', () => {
        none(`CREATE TABLE test(field int);
            INSERT INTO test values (3),(1),(2);`);

        // order on alias is just a trick... you cannot use them in actual computations.
        expectQueryError(() => many(`SELECT field aliased FROM test ORDER BY  -aliased`), /column "aliased" does not exist/);
    });

    // ORDER BY <ordinal> was built as a constant, which is the same value for
    // every row, so the clause silently did nothing and rows came back in
    // insertion order - often indistinguishable from sorted, in a small fixture.
    describe('positional (ORDER BY <ordinal>)', () => {

        beforeEach(() => {
            none(`create table t (a text, b int);
                  insert into t values ('c',3),('a',1),('b',2);`);
        });

        it('orders by the nth select-list item', () => {
            expect(many(`select a from t order by 1`).map(r => r.a)).toEqual(['a', 'b', 'c']);
            expect(many(`select a, b from t order by 2`).map(r => r.b)).toEqual([1, 2, 3]);
        });

        it('honours asc/desc on an ordinal', () => {
            expect(many(`select a from t order by 1 desc`).map(r => r.a)).toEqual(['c', 'b', 'a']);
        });

        it('resolves against the expanded columns for select *', () => {
            expect(many(`select * from t order by 1`).map(r => r.a)).toEqual(['a', 'b', 'c']);
            expect(many(`select * from t order by 2`).map(r => r.b)).toEqual([1, 2, 3]);
        });

        // Only a bare integer literal is an ordinal. `1 + 0` is an ordinary
        // constant expression, which sorts nothing in postgres either - so this
        // pins that the fix did not start treating every integer-valued
        // expression as a position.
        it('leaves a constant expression alone', () => {
            expect(many(`select a from t order by 1 + 0`).map(r => r.a)).toEqual(['c', 'a', 'b']);
        });

        it('rejects a position outside the select list', () => {
            expectQueryError(() => many(`select a from t order by 5`), /ORDER BY position 5 is not in select list/);
            expectQueryError(() => many(`select a from t order by 0`), /ORDER BY position 0 is not in select list/);
        });

        it('composes with an ordinary column term', () => {
            none(`insert into t values ('a', 0)`);
            expect(many(`select a, b from t order by 1, b desc`).map(r => [r.a, r.b]))
                .toEqual([['a', 1], ['a', 0], ['b', 2], ['c', 3]]);
        });

        it('works for GROUP BY too', () => {
            none(`insert into t values ('a', 9)`);
            expect(many(`select a from t group by 1 order by 1`).map(r => r.a)).toEqual(['a', 'b', 'c']);
        });

        it('rejects a GROUP BY position outside the select list', () => {
            expectQueryError(() => many(`select a from t group by 3`), /GROUP BY position 3 is not in select list/);
        });
    });

});