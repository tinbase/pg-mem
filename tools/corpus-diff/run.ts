// Differential test of pg-mem against PGlite (real Postgres) on real project migrations.
//
//   bun tools/corpus-diff/run.ts <corpusDir> [outDir] [--only p07]
//
// <corpusDir>/<project>/migrations/*.sql + optional seed.sql — one directory per project. Nothing
// from the corpus is committed: it is user project code, pulled on demand (see README.md).
//
// Every step runs on both engines and the outcomes are compared. PGlite is the oracle: a diff is a
// pg-mem gap, in either direction — rejecting SQL Postgres accepts (an app that will not boot), or
// accepting SQL Postgres rejects (a validator that waves through a migration that fails on publish).
import fs from 'node:fs';
import path from 'node:path';
import { AUTH_BOOTSTRAP, DEMO_USER_ID, REFRESH_GRANT, STRANGER_ID } from './bootstrap';
import { attempt, create, type Engine, type Outcome } from './engines';

interface Project {
  name: string;
  migrations: { path: string; sql: string }[];
  seed?: string;
  /** every literal in the project's SQL, used to tell seeded uuids from generated ones */
  text: string;
}

interface Diff {
  project: string;
  kind: string;
  table?: string;
  probe: string;
  sql?: string;
  pglite: Outcome | unknown;
  pgmem: Outcome | unknown;
}

// ── loading ────────────────────────────────────────────────────────────

function loadProject(dir: string): Project {
  const mdir = path.join(dir, 'migrations');
  const migrations = fs.existsSync(mdir)
    ? fs.readdirSync(mdir).filter((f) => f.endsWith('.sql')).map((f) => ({ path: `supabase/migrations/${f}`, sql: fs.readFileSync(path.join(mdir, f), 'utf8') }))
    : [];
  const seedPath = path.join(dir, 'seed.sql');
  const seed = fs.existsSync(seedPath) ? fs.readFileSync(seedPath, 'utf8') : undefined;
  return { name: path.basename(dir), migrations, seed, text: migrations.map((m) => m.sql).join('\n') + '\n' + (seed ?? '') };
}

// ── build: what PgSession.create() + db_seed do ───────────────────────────

interface Built {
  eng: Engine;
  /** wall clock when the seed ran: seed timestamps are now() ± an interval, compared relative to it */
  seedAt: number;
  bootstrap: Outcome[];
  migrations: (Outcome & { path: string })[];
  seed?: Outcome;
}

async function build(kind: Engine['kind'], p: Project): Promise<Built> {
  const eng = await create(kind);
  const bootstrap: Outcome[] = [];
  for (const stmt of AUTH_BOOTSTRAP) bootstrap.push(await attempt(() => eng.exec(stmt)));
  const migrations: Built['migrations'] = [];
  for (const m of [...p.migrations].sort((a, b) => a.path.localeCompare(b.path))) {
    migrations.push({ path: m.path, ...(await attempt(() => eng.exec(m.sql))) });
  }
  await attempt(() => eng.exec(REFRESH_GRANT));
  const seedAt = Date.now();
  const seed = p.seed?.trim() ? await attempt(() => eng.exec(p.seed!)) : undefined;
  return { eng, seedAt, bootstrap, migrations, seed };
}

// ── catalogue: exactly the reads PgSession.buildTableInfo() makes ─────────

const catalogQueries = (t: string) => ({
  columns: `select column_name, data_type, is_nullable, column_default from information_schema.columns
         where table_schema = 'public' and table_name = '${t}'`,
  rls: `select rowsecurity from pg_tables where schemaname = 'public' and tablename = '${t}'`,
  policies: `select * from pg_policies where tablename = '${t}'`,
  indexes: `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = '${t}'`,
  foreignKeys: `select tc.constraint_name, kcu.column_name, rc.delete_rule
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu
             on kcu.constraint_name = tc.constraint_name
           left join information_schema.referential_constraints rc
             on rc.constraint_name = tc.constraint_name
          where tc.constraint_type = 'FOREIGN KEY' and tc.table_name = '${t}'`,
  triggers: `select trigger_name, action_timing, event_manipulation
         from information_schema.triggers where event_object_table = '${t}'`,
  primaryKey: `select kcu.column_name
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu
             on kcu.constraint_name = tc.constraint_name
          where tc.constraint_type = 'PRIMARY KEY' and tc.table_name = '${t}'`,
});

/** Normalise a column default so cosmetic deparse differences ('x'::text vs 'x') don't count. */
/** drop one paren pair only when it wraps the whole expression ("(a)+(b)" is left alone) */
const unwrap = (x: string) => {
  if (!x.startsWith('(') || !x.endsWith(')')) return x;
  let depth = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === '(') depth++;
    else if (x[i] === ')' && --depth === 0 && i < x.length - 1) return x;
  }
  return x.slice(1, -1);
};
const normDefault = (d: any) =>
  d == null ? null : unwrap(String(d).toLowerCase().replace(/::[a-z_ ]+(\[\])?/g, '').replace(/\s+/g, '').replace(/"/g, ''));

const sortBy = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** Each catalogue facet reduced to the fields PgSession actually reads. */
const shapeCatalog: Record<string, (rows: any[]) => any> = {
  columns: (rows) => sortBy(rows.map((r) => ({ name: r.column_name, type: r.data_type, nullable: String(r.is_nullable).toUpperCase() === 'YES', default: normDefault(r.column_default) })), (c) => c.name),
  rls: (rows) => !!rows[0]?.rowsecurity,
  policies: (rows) => sortBy(rows.map((r) => ({ name: r.policyname, cmd: r.cmd ?? 'ALL', using: r.qual != null, check: r.with_check != null })), (p) => p.name),
  indexes: (rows) => rows.map((r) => r.indexname).sort(),
  foreignKeys: (rows) => sortBy(rows.map((r) => ({ column: r.column_name, onDelete: r.delete_rule ?? 'NO ACTION' })), (f) => f.column + f.onDelete),
  triggers: (rows) => [...new Set(rows.map((r) => `${r.trigger_name}:${r.action_timing}:${r.event_manipulation}`))].sort(),
  primaryKey: (rows) => rows.map((r) => String(r.column_name)).sort(),
};

// ── value normalisation for row comparison ──────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normValue(v: any, p: Project, startedAt: number): any {
  if (v == null) return null;
  if (v instanceof Date) {
    // timestamps made from now() during the run differ between engines by the ms the runs are
    // apart: compare them as an offset from that engine's own seed time, to the nearest 10s
    const off = v.getTime() - startedAt;
    return Math.abs(off) < 400 * 86400_000 ? `<now${off >= 0 ? '+' : ''}${Math.round(off / 10_000) * 10}s>` : v.toISOString();
  }
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string') {
    if (UUID.test(v)) return p.text.toLowerCase().includes(v.toLowerCase()) ? v.toLowerCase() : '<gen-uuid>';
    if (/^-?\d+(\.\d+)?$/.test(v)) return normValue(Number(v), p, startedAt); // numeric comes back as a string from PGlite
    if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(v)) {
      const t = Date.parse(v.replace(' ', 'T'));
      if (!Number.isNaN(t)) return normValue(new Date(t), p, startedAt);
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => normValue(x, p, startedAt));
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normValue(v[k], p, startedAt)]));
  return v;
}

const normRows = (rows: any[] | undefined, p: Project, t0: number) =>
  (rows ?? []).map((r) => JSON.stringify(normValue(r, p, t0))).sort();

const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

// ── SQL literal rendering (from PGlite's rows, so both engines get identical text) ──

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

function literal(v: any, type: string): string {
  if (v == null) return 'null';
  if (v instanceof Date) return q(v.toISOString());
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (type === 'ARRAY' && Array.isArray(v)) return `${q('{' + v.map((x) => (x == null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}')}`;
  if (type === 'json' || type === 'jsonb') return q(JSON.stringify(v));
  if (typeof v === 'object') return q(JSON.stringify(v));
  return q(String(v));
}

/** A fresh value for a unique/PK column, so a template insert does not collide. */
function perturb(v: any, type: string): string {
  if (type === 'uuid') return q(crypto.randomUUID());
  if (/int|numeric|real|double/.test(type)) return String(Math.floor(Number(v ?? 0)) + 1_000_000 + Math.floor(Math.random() * 1000));
  if (type === 'text' || type.startsWith('character')) return q(`${v ?? 'x'}-probe${Math.floor(Math.random() * 1e6)}`);
  return literal(v, type);
}

// ── probes ───────────────────────────────────────────────────────────

interface Probe {
  kind: string;
  table: string;
  probe: string;
  /** statements; the last one's outcome is compared */
  sql: string[];
  role?: { as: 'anon' | 'authenticated'; uid: string };
  ddl?: boolean;
  /** compare returned rows, not just ok/rowCount */
  rows?: boolean;
}

const asRole = (r: NonNullable<Probe['role']>) => [
  `select set_config('request.jwt.claim.sub', '${r.uid}', false)`,
  `select set_config('request.jwt.claim.role', '${r.as}', false)`,
  `set role ${r.as}`,
];

const DEMO = { as: 'authenticated' as const, uid: DEMO_USER_ID };
const STRANGER = { as: 'authenticated' as const, uid: STRANGER_ID };
const ANON = { as: 'anon' as const, uid: '' };

interface TableMeta {
  name: string;
  cols: { name: string; type: string; nullable: boolean; hasDefault: boolean; generated: boolean }[];
  pk: string[];
  unique: string[][];
  fks: { cols: string[]; refTable: string }[];
  checks: { cols: string[]; def: string }[];
  policyCols: string[];
  referencedBy: number;
  sample?: Record<string, any>;
}

/** Everything probe generation needs, read from the oracle. */
async function tableMeta(eng: Engine, t: string): Promise<TableMeta> {
  const cols = (await eng.query(`select column_name, data_type, is_nullable, column_default, is_generated, is_identity
     from information_schema.columns where table_schema='public' and table_name='${t}' order by ordinal_position`)).rows.map((r) => ({
    name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', hasDefault: r.column_default != null || r.is_identity === 'YES', generated: r.is_generated === 'ALWAYS',
  }));
  const cons = (await eng.query(`select c.contype, pg_get_constraintdef(c.oid) def, c.confrelid::regclass::text reftable,
       array(select a.attname::text from unnest(c.conkey) k join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k) cols
     from pg_constraint c where c.conrelid = 'public.${ident(t)}'::regclass`)).rows;
  const policies = (await eng.query(`select qual, with_check from pg_policies where schemaname='public' and tablename='${t}'`)).rows;
  const policyText = policies.map((r) => `${r.qual ?? ''} ${r.with_check ?? ''}`).join(' ');
  const referencedBy = Number((await eng.query(`select count(*)::int n from pg_constraint where contype='f' and confrelid = 'public.${ident(t)}'::regclass and conrelid <> confrelid`)).rows[0].n);
  const sample = (await eng.query(`select * from public.${ident(t)} limit 1`)).rows[0];
  return {
    name: t,
    cols,
    pk: cons.find((c) => c.contype === 'p')?.cols ?? [],
    unique: cons.filter((c) => c.contype === 'u').map((c) => c.cols),
    fks: cons.filter((c) => c.contype === 'f').map((c) => ({ cols: c.cols, refTable: c.reftable })),
    checks: cons.filter((c) => c.contype === 'c').map((c) => ({ cols: c.cols, def: c.def })),
    policyCols: cols.map((c) => c.name).filter((n) => new RegExp(`\\b${n}\\b`).test(policyText)),
    referencedBy,
    sample,
  };
}

function templateInsert(m: TableMeta, override: Record<string, string> = {}): string | null {
  if (!m.sample) return null;
  const keyCols = new Set([...m.pk, ...m.unique.flat()]);
  const cols = m.cols.filter((c) => !c.generated);
  const vals = cols.map((c) => {
    if (c.name in override) return override[c.name];
    if (keyCols.has(c.name)) return perturb(m.sample![c.name], c.type);
    return literal(m.sample![c.name], c.type);
  });
  return `insert into public.${ident(m.name)} (${cols.map((c) => ident(c.name)).join(', ')}) values (${vals.join(', ')})`;
}

function probesFor(m: TableMeta, all: TableMeta[]): Probe[] {
  const t = ident(m.name);
  const out: Probe[] = [];
  const P = (p: Omit<Probe, 'table'>) => out.push({ table: m.name, ...p });

  // RLS reads
  for (const [label, role] of [['anon', ANON], ['demo', DEMO], ['stranger', STRANGER]] as const) {
    P({ kind: 'rls-read', probe: `count as ${label}`, sql: [`select count(*)::int as n from public.${t}`], role, rows: true });
  }
  const anyCol = m.cols.find((c) => !c.generated && !m.pk.includes(c.name))?.name ?? m.cols[0]?.name;
  if (anyCol) {
    for (const [label, role] of [['demo', DEMO], ['stranger', STRANGER], ['anon', ANON]] as const) {
      P({ kind: 'rls-write', probe: `update as ${label}`, sql: [`update public.${t} set ${ident(anyCol)} = ${ident(anyCol)}`], role });
      P({ kind: 'rls-write', probe: `delete as ${label}`, sql: [`delete from public.${t}`], role });
    }
  }
  // updated_at trigger: inside one transaction now() is constant, so a row the trigger touched has updated_at = now()
  if (m.sample && m.cols.some((c) => c.name === 'updated_at') && anyCol && anyCol !== 'updated_at') {
    P({ kind: 'trigger', probe: 'updated_at fires on update', sql: [`update public.${t} set ${ident(anyCol)} = ${ident(anyCol)} returning (updated_at = now()) as fired`], rows: true });
  }

  // template insert (positive) and single-field corruptions (negative), superuser and per role
  const tmpl = templateInsert(m);
  if (tmpl) {
    P({ kind: 'insert', probe: 'template row', sql: [tmpl] });
    P({ kind: 'rls-write', probe: 'template insert as demo', sql: [tmpl], role: DEMO });
    P({ kind: 'rls-write', probe: 'template insert as stranger', sql: [tmpl], role: STRANGER });
    P({ kind: 'rls-write', probe: 'template insert as anon', sql: [tmpl], role: ANON });
    for (const c of m.cols.filter((c) => !c.generated)) {
      const bad: [string, string][] = [];
      if (!c.nullable) bad.push(['null into not-null', 'null']);
      if (/^(integer|bigint|smallint|numeric|real|double precision)$/.test(c.type)) bad.push(['non-numeric literal', q('abc')]);
      if (c.type === 'uuid') bad.push(['malformed uuid', q('not-a-uuid')]);
      if (c.type === 'boolean') bad.push(['malformed boolean', q('maybe')]);
      if (/^(timestamp|date|time)/.test(c.type)) bad.push(['malformed timestamp', q('not-a-date')]);
      if (c.type === 'jsonb' || c.type === 'json') bad.push(['malformed json', q('{bad')]);
      if (c.type === 'integer') bad.push(['int4 overflow', '3000000000']);
      if (c.type === 'smallint') bad.push(['int2 overflow', '70000']);
      if (/^character varying/.test(c.type)) bad.push(['varchar too long (if bounded)', q('x'.repeat(10_001))]);
      if (m.fks.some((f) => f.cols.includes(c.name))) bad.push(['dangling foreign key', c.type === 'uuid' ? q(crypto.randomUUID()) : q('no-such-parent')]);
      if (m.sample && [m.pk, ...m.unique].some((k) => k.length === 1 && k[0] === c.name)) bad.push(['duplicate key', literal(m.sample[c.name], c.type)]);
      for (const ch of m.checks.filter((ch) => ch.cols.includes(c.name))) {
        if (c.type === 'text' || c.type.startsWith('character')) bad.push([`check violation ${ch.def.slice(0, 60)}`, q('__bogus__')]);
        else if (/int|numeric|real|double/.test(c.type)) bad.push([`check violation ${ch.def.slice(0, 60)}`, '-999999']);
      }
      for (const [what, val] of bad) {
        const sql = templateInsert(m, { [c.name]: val });
        if (sql) P({ kind: 'reject', probe: `${c.name}: ${what}`, sql: [sql] });
      }
    }
  }

  // DDL the validator must judge the way Postgres does
  for (const c of m.cols) {
    if (c.type === 'text' || c.type === 'uuid') {
      P({ kind: 'ddl', probe: `policy auth.uid() = ${c.type} column (${c.name})`, sql: [`create policy zz_probe on public.${t} for select using (auth.uid() = ${ident(c.name)})`], ddl: true });
    }
  }
  P({ kind: 'ddl', probe: 'policy on missing column', sql: [`create policy zz_probe on public.${t} for select using (zz_no_such_col = 1)`], ddl: true });
  for (const c of m.policyCols) {
    P({ kind: 'ddl', probe: `alter type of policy-referenced column ${c}`, sql: [`alter table public.${t} alter column ${ident(c)} type text`], ddl: true });
  }
  P({ kind: 'ddl', probe: 'index on missing column', sql: [`create index zz_probe_idx on public.${t} (zz_no_such_col)`], ddl: true });
  if (m.cols[0]) P({ kind: 'ddl', probe: 'add existing column', sql: [`alter table public.${t} add column ${ident(m.cols[0].name)} text`], ddl: true });
  P({ kind: 'ddl', probe: 'create existing table', sql: [`create table public.${t} (id int)`], ddl: true });
  P({ kind: 'ddl', probe: 'create table if not exists (existing)', sql: [`create table if not exists public.${t} (id int)`], ddl: true });
  if (m.referencedBy > 0) P({ kind: 'ddl', probe: 'drop table with dependents', sql: [`drop table public.${t}`], ddl: true });
  if (m.pk.length === 1 && m.referencedBy > 0) P({ kind: 'ddl', probe: 'drop referenced pk column', sql: [`alter table public.${t} drop column ${ident(m.pk[0])}`], ddl: true });
  P({ kind: 'ddl', probe: 'drop policy if exists (missing)', sql: [`drop policy if exists zz_nope on public.${t}`], ddl: true });
  P({ kind: 'ddl', probe: 'drop policy (missing)', sql: [`drop policy zz_nope on public.${t}`], ddl: true });
  P({ kind: 'ddl', probe: 'trigger with missing function', sql: [`create trigger zz_trg before update on public.${t} for each row execute function public.zz_no_such_fn()`], ddl: true });
  void all;
  return out;
}

/** Cross-table probes. */
function globalProbes(metas: TableMeta[]): Probe[] {
  const out: Probe[] = [];
  if (!metas.length) return out;
  const counts = `select ${metas.map((m) => `(select count(*)::int from public.${ident(m.name)}) as ${ident(m.name)}`).join(', ')}`;
  out.push({ kind: 'cascade', table: '*', probe: 'delete demo user, surviving rows', sql: [`delete from auth.users where id = '${DEMO_USER_ID}'`, counts], rows: true });
  out.push({ kind: 'reject', table: 'auth.users', probe: 'pg uuid = text comparison', sql: [`select 1 where auth.uid() = 'abc'::text`] });
  return out;
}

// ── running a probe on one engine ─────────────────────────────────────────

async function runProbe(eng: Engine, p: Probe): Promise<Outcome> {
  await attempt(() => eng.exec('begin'));
  try {
    if (p.role) for (const s of asRole(p.role)) await eng.exec(s);
    let last: Outcome = { ok: true };
    for (const s of p.sql) {
      last = await attempt(() => eng.query(s));
      if (!last.ok) break;
    }
    return last;
  } finally {
    await attempt(() => eng.exec('reset role'));
    await attempt(() => eng.exec('rollback'));
  }
}

/** Row counts of every user table + auth.users — detects a rollback that did not roll back. */
async function fingerprint(eng: Engine, tables: string[]): Promise<string> {
  const parts: string[] = [];
  for (const t of ['auth.users', ...tables.map((t) => `public.${ident(t)}`)]) {
    const o = await attempt(() => eng.query(`select count(*)::int as n from ${t}`));
    parts.push(`${t}=${o.ok ? o.rows![0].n : 'ERR'}`);
  }
  const zz = await attempt(() => eng.query(`select count(*)::int as n from pg_policies where policyname = 'zz_probe'`));
  parts.push(`zz=${zz.ok ? zz.rows![0].n : '?'}`);
  return parts.join(',');
}

// ── per project ───────────────────────────────────────────────────────

async function diffProject(p: Project): Promise<{ diffs: Diff[]; stats: Record<string, number> }> {
  const t0 = Date.now();
  const diffs: Diff[] = [];
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  const D = (d: Omit<Diff, 'project'>) => diffs.push({ project: p.name, ...d });

  const ref = await build('pglite', p);
  let mem = await build('pgmem', p);

  ref.bootstrap.forEach((o, i) => {
    if (o.ok !== mem.bootstrap[i].ok) D({ kind: 'bootstrap', probe: AUTH_BOOTSTRAP[i].replace(/\s+/g, ' ').slice(0, 80), pglite: o, pgmem: mem.bootstrap[i] });
  });
  ref.migrations.forEach((o, i) => {
    bump('migrations');
    const m = mem.migrations[i];
    if (o.ok !== m.ok) D({ kind: o.ok ? 'migration-rejected' : 'migration-accepted', probe: o.path, pglite: o, pgmem: m });
  });
  if (ref.seed) {
    bump('seeds');
    if (ref.seed.ok !== mem.seed!.ok) D({ kind: ref.seed.ok ? 'seed-rejected' : 'seed-accepted', probe: 'seed.sql', pglite: ref.seed, pgmem: mem.seed });
  }

  // catalogue
  const tables = (await ref.eng.query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.tablename as string);
  const memTablesO = await attempt(() => mem.eng.query(`select tablename from pg_tables where schemaname = 'public' order by 1`));
  const memTables = memTablesO.ok ? memTablesO.rows!.map((r) => r.tablename as string).sort() : [];
  if (!same(tables, memTables)) D({ kind: 'catalog', table: '*', probe: 'pg_tables', pglite: tables, pgmem: memTablesO.ok ? memTables : memTablesO });

  for (const t of tables) {
    for (const [facet, sql] of Object.entries(catalogQueries(t))) {
      bump('catalog');
      const a = await attempt(() => ref.eng.query(sql));
      const b = await attempt(() => mem.eng.query(sql));
      if (!b.ok) { D({ kind: 'catalog', table: t, probe: `${facet} (query failed)`, sql, pglite: '(ok)', pgmem: b }); continue; }
      const sa = shapeCatalog[facet](a.rows!);
      const sb = shapeCatalog[facet](b.rows!);
      if (!same(sa, sb)) D({ kind: 'catalog', table: t, probe: facet, pglite: sa, pgmem: sb });
    }
    // data after seed
    bump('data');
    const a = await attempt(() => ref.eng.query(`select * from public.${ident(t)}`));
    const b = await attempt(() => mem.eng.query(`select * from public.${ident(t)}`));
    const ra = normRows(a.rows, p, ref.seedAt), rb = normRows(b.rows, p, mem.seedAt);
    if (a.ok !== b.ok || !same(ra, rb)) D({ kind: 'data', table: t, probe: 'rows after seed', pglite: a.ok ? ra.slice(0, 3) : a, pgmem: b.ok ? rb.slice(0, 3) : b });
  }

  // probes (generated from the oracle's catalogue)
  const metas: TableMeta[] = [];
  for (const t of tables) metas.push(await tableMeta(ref.eng, t));
  const probes = [...metas.flatMap((m) => probesFor(m, metas)), ...globalProbes(metas)];
  const memFp0 = await fingerprint(mem.eng, memTables);
  for (const pr of probes) {
    bump(`probe:${pr.kind}`);
    const a = await runProbe(ref.eng, pr);
    const b = await runProbe(mem.eng, pr);
    let differ = a.ok !== b.ok;
    if (!differ && a.ok && !pr.ddl) differ = (a.rowCount ?? 0) !== (b.rowCount ?? 0) && /^(update|delete|insert)/i.test(pr.sql.at(-1)!);
    if (!differ && a.ok && pr.rows) differ = !same(normRows(a.rows, p, t0), normRows(b.rows, p, t0));
    if (differ) {
      D({ kind: pr.kind, table: pr.table, probe: pr.probe, sql: pr.sql.join(';\n'), pglite: { ...a, rows: a.rows?.slice(0, 3) }, pgmem: { ...b, rows: b.rows?.slice(0, 3) } });
    }
    // pg-mem cannot roll back DDL; rebuild instead of letting one probe poison the next
    const leaked = pr.ddl ? true : (await fingerprint(mem.eng, memTables)) !== memFp0;
    if (leaked) {
      if (!pr.ddl) D({ kind: 'rollback', table: pr.table, probe: `rollback after: ${pr.probe}`, pglite: '(restored)', pgmem: '(state leaked past rollback)' });
      await mem.eng.close();
      mem = await build('pgmem', p);
    }
  }
  await ref.eng.close();
  await mem.eng.close();
  return { diffs, stats };
}

// ── main ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const corpus = args[0];
const outDir = args[1] && !args[1].startsWith('--') ? args[1] : path.join(corpus, '..', 'corpus-diff-out');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
if (!corpus) {
  console.error('usage: bun tools/corpus-diff/run.ts <corpusDir> [outDir] [--only <project>]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const projects = fs.readdirSync(corpus).filter((d) => fs.statSync(path.join(corpus, d)).isDirectory()).filter((d) => !only || d === only).sort();
const all: Diff[] = [];
const totals: Record<string, number> = {};
const perProject: { project: string; diffs: number; ms: number; error?: string }[] = [];
for (const name of projects) {
  const t = Date.now();
  try {
    const { diffs, stats } = await diffProject(loadProject(path.join(corpus, name)));
    all.push(...diffs);
    for (const [k, v] of Object.entries(stats)) totals[k] = (totals[k] ?? 0) + v;
    perProject.push({ project: name, diffs: diffs.length, ms: Date.now() - t });
    console.log(`${name}: ${diffs.length} diffs (${Date.now() - t}ms)`);
  } catch (e: any) {
    perProject.push({ project: name, diffs: -1, ms: Date.now() - t, error: String(e?.stack ?? e) });
    console.log(`${name}: HARNESS ERROR ${String(e?.message ?? e).split('\n')[0]}`);
  }
}
fs.writeFileSync(path.join(outDir, 'diffs.json'), JSON.stringify({ totals, perProject, diffs: all }, null, 1));
const byKind: Record<string, number> = {};
for (const d of all) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
console.log('\ntotals', totals);
console.log('diffs by kind', byKind);
console.log(`projects with ≥1 diff: ${perProject.filter((p) => p.diffs !== 0).length}/${perProject.length}`);
