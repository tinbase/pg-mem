// Two engines behind one async interface, so every step of the corpus diff runs the same SQL on
// both. PGlite is real Postgres compiled to WASM and is the source of truth; pg-mem is under test.
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { newDb } from '../../src';

export interface Outcome {
  ok: boolean;
  rows?: any[];
  rowCount?: number;
  err?: string;
}

export interface Engine {
  kind: 'pglite' | 'pgmem';
  /** multi-statement, no results */
  exec(sql: string): Promise<void>;
  /** single statement with rows + affected count */
  query(sql: string): Promise<{ rows: any[]; rowCount: number }>;
  close(): Promise<void>;
}

export async function createPglite(): Promise<Engine> {
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto } });
  await db.waitReady;
  return {
    kind: 'pglite',
    exec: async (sql) => {
      await db.exec(sql);
    },
    query: async (sql) => {
      const r = await db.query(sql);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
    close: () => db.close(),
  };
}

export async function createPgmem(): Promise<Engine> {
  const db = newDb();
  return {
    kind: 'pgmem',
    exec: async (sql) => {
      db.public.none(sql);
    },
    query: async (sql) => {
      const r = db.public.query(sql);
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? r.rows?.length ?? 0 };
    },
    close: async () => {},
  };
}

export const create = (kind: Engine['kind']) => (kind === 'pglite' ? createPglite() : createPgmem());

/** First line of an error, as PgSession records it. */
export const errLine = (e: any) => String(e?.message ?? e).split('\n')[0];

export async function attempt(fn: () => Promise<any>): Promise<Outcome> {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'rows' in r) return { ok: true, rows: r.rows, rowCount: r.rowCount };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: errLine(e) };
  }
}
