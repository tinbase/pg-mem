import { describe, it, beforeEach, expect } from 'bun:test';

import { newDb } from '../db';
import { IMemoryDb } from '../interfaces';

// Postgres resolves a quoted type name when it is a real pg_type.typname ("int8", "numeric",
// "float8"), and only refuses the SQL spellings ("double precision", "character varying").
// PostgREST-style builders (tinbase) cast with the quoted information_schema.udt_name, so every
// REST write to an int/numeric/float/varchar column depended on this.
describe('quoted type names', () => {

    let db: IMemoryDb;
    let many: (str: string) => any[];
    let none: (str: string) => void;
    beforeEach(() => {
        db = newDb();
        many = db.public.many.bind(db.public);
        none = db.public.none.bind(db.public);
    });

    const catalog = ['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'varchar', 'bpchar', 'bool', 'oid', 'money'];

    for (const name of catalog) {
        it(`resolves catalog name ${name} quoted and unquoted`, () => {
            many(`select null::${name} as a`);
            many(`select null::"${name}" as a`);
        });
    }

    it('casts values through quoted catalog names', () => {
        expect(many(`select '7'::"int8" as a, '3'::"int4" as b, '1.5'::"numeric" as c, '1.25'::"float8" as d, 'x'::"varchar" as e, 'true'::"bool" as f`))
            .toEqual([{ a: '7', b: 3, c: '1.5', d: 1.25, e: 'x', f: true }]);
    });

    it('still refuses quoted SQL spellings, as postgres does', () => {
        expect(() => many(`select null::"double precision" as a`)).toThrow(/does not exist/);
        expect(() => many(`select null::"character varying" as a`)).toThrow(/does not exist/);
    });

    it('round-trips an insert cast with each column\'s quoted udt_name', () => {
        none(`create table a (n numeric, i2 smallint, i4 int, i8 bigint, f4 real, f8 double precision, vc varchar(20), ch char(3), b boolean)`);
        const cols = many(`select column_name, udt_name from information_schema.columns where table_name = 'a' order by ordinal_position`);
        const vals: Record<string, string> = { n: '9.5', i2: '2', i4: '4', i8: '8', f4: '1.5', f8: '2.25', vc: 'hi', ch: 'abc', b: 'true' };
        none(`insert into a (${cols.map(c => c.column_name).join(', ')}) values (${cols.map(c => `'${vals[c.column_name]}'::"${c.udt_name}"`).join(', ')})`);
        expect(many(`select * from a`)).toEqual([{ n: '9.5', i2: 2, i4: 4, i8: '8', f4: 1.5, f8: 2.25, vc: 'hi', ch: 'abc', b: true }]);
    });
});
