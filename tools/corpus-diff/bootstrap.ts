// The Supabase surface RapidNative's agent validator (rapidnative-website
// src/lib/coding-agent/db/pg-session.ts, AUTH_BOOTSTRAP) installs before applying a project's
// migrations. Copied verbatim so both engines are judged on exactly what production runs.
export const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';
export const STRANGER_ID = '00000000-0000-0000-0000-0000000000ff';

export const AUTH_BOOTSTRAP = [
  `create schema if not exists auth`,
  `create table if not exists auth.users (
     id uuid primary key default gen_random_uuid(),
     aud text default 'authenticated',
     role text default 'authenticated',
     email text unique,
     encrypted_password text,
     email_confirmed_at timestamptz,
     last_sign_in_at timestamptz,
     raw_app_meta_data jsonb default '{}'::jsonb,
     raw_user_meta_data jsonb default '{}'::jsonb,
     is_super_admin boolean default false,
     created_at timestamptz default now(),
     updated_at timestamptz default now(),
     phone text unique,
     phone_confirmed_at timestamptz,
     banned_until timestamptz,
     deleted_at timestamptz,
     is_anonymous boolean default false
   )`,
  `create function auth.uid() returns uuid as $$
     select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), '${DEMO_USER_ID}')::uuid
   $$ language sql stable`,
  `create function auth.role() returns text as $$
     select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')::text
   $$ language sql stable`,
  `create role anon nologin`,
  `create role authenticated nologin`,
  `grant usage on schema public to anon, authenticated`,
  `alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated`,
  `create schema if not exists storage`,
  `create table if not exists storage.buckets (
     id text primary key,
     name text not null unique,
     owner uuid,
     owner_id text,
     public boolean default false,
     avif_autodetection boolean default false,
     file_size_limit bigint,
     allowed_mime_types text[],
     created_at timestamptz default now(),
     updated_at timestamptz default now()
   )`,
  `create table if not exists storage.objects (
     id uuid primary key default gen_random_uuid(),
     bucket_id text references storage.buckets(id),
     name text,
     owner uuid,
     owner_id text,
     metadata jsonb,
     path_tokens text[] generated always as (string_to_array(name, '/')) stored,
     version text,
     user_metadata jsonb,
     created_at timestamptz default now(),
     updated_at timestamptz default now(),
     last_accessed_at timestamptz default now()
   )`,
  `alter table storage.objects enable row level security`,
  `create function storage.foldername(name text) returns text[] as $$
     select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
   $$ language sql immutable`,
  `create function storage.filename(name text) returns text as $$
     select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
   $$ language sql immutable`,
  `create function storage.extension(name text) returns text as $$
     select reverse(split_part(reverse((string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]), '.', 1))
   $$ language sql immutable`,
  `grant usage on schema storage to anon, authenticated`,
  `grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated`,
];

/** PgSession.refresh() runs this after every schema change. */
export const REFRESH_GRANT = `grant select, insert, update, delete on all tables in schema public to anon, authenticated`;
