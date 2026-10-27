-- Disposable SQL harness prerequisites only. These are NOT application migrations.
-- auth schema/roles/helpers come from the pinned Supabase Postgres image.
-- Storage API is not running here; these minimal tables exercise SQL policies only.
create extension if not exists pgtap with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists vector with schema extensions;
grant usage on schema cron to postgres;
grant execute on function cron.alter_job(bigint, text, text, text, text, boolean) to postgres;
grant usage, create on schema storage to postgres;
grant usage, create on schema public to postgres;
-- Exact auth.jwt helper observed in the existing local Supabase stack.
-- The base Postgres image predates this GoTrue-managed helper.
-- Likewise, its auth.uid only understood legacy per-claim settings; PostgREST
-- supplies request.jwt.claims JSON. This body was read from the existing local
-- stack (system identifier 7696855382484680741), never inferred from test results.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
set role postgres;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text not null, owner uuid, metadata jsonb, created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable
as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1] $$;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to service_role;
grant select, insert, update, delete on storage.objects to authenticated;
-- Match local Data API grants; tests still exercise actual PostgreSQL RLS.
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant usage, select on sequences to anon, authenticated, service_role;
