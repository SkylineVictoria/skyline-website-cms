-- ASM-AI-IMPORT (2026-11-25, owner): AI-assisted reading of assessment workbooks and answer guides.
--
-- The browser reads the PDF's text layer page by page (and draws pages that have none), uploads the file, the page text and those
-- page images to the private bucket asm-imports under <job id>/, then queues the job. The Edge Function asm-import (service caller
-- only) reads it one step at a time: outline, then one task chunk at a time, then assembles; progress and the live counts are kept
-- on the job so the screen fills in as it goes (asm_import_status). Results are cached by file hash: the same file again costs
-- nothing (asm_import_start answers the finished job). Tokens and cost per import are kept on the job (usage).
-- Only workbooks and answer guides are ever stored or sent; never student data. Admins / RTO Managers only (asm_is_admin).

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('asm-imports', 'asm-imports', false, 52428800, array['application/pdf', 'application/json', 'image/jpeg'])
on conflict (id) do nothing;

create table public.asm_import_jobs (
 id uuid primary key default gen_random_uuid(),
 kind text not null check (kind in ('workbook', 'guide')),
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 file_name text not null check (char_length(file_name) between 1 and 255),
 bytes bigint not null check (bytes > 0 and bytes <= 52428800),
 page_count integer not null check (page_count between 1 and 600),
 scanned_pages integer[] not null default '{}',
 state text not null default 'uploading' check (state in ('uploading', 'queued', 'running', 'done', 'failed')),
 provider text,
 model text,
 outline jsonb,
 plan jsonb,
 chunk_results jsonb,
 next_chunk integer not null default 0,
 chunk_attempts integer not null default 0,
 progress jsonb not null default '{"label": "Waiting for the upload", "done": 0, "total": 1}',
 summary jsonb not null default '{}',
 result jsonb,
 usage jsonb not null default '{}',
 error text,
 lease uuid,
 lease_until timestamptz,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 started_at timestamptz,
 finished_at timestamptz
);
create index asm_import_jobs_cache on public.asm_import_jobs(kind, sha256, finished_at desc) where state = 'done';
create index asm_import_jobs_work on public.asm_import_jobs(state, lease_until) where state in ('queued', 'running');
alter table public.asm_import_jobs enable row level security;
create policy asm_import_jobs_admin_read on public.asm_import_jobs for select to authenticated using (public.asm_is_admin());
revoke all on public.asm_import_jobs from anon, authenticated;
grant select on public.asm_import_jobs to authenticated;

-- Storage: an admin uploads into the folder of an import they started that is still waiting for its upload; admins read.
create or replace function public.asm_import_storage_allowed(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = '' as $$
 select public.asm_is_admin() and exists (
  select 1 from public.asm_import_jobs j
  where j.id::text = split_part(p_name, '/', 1)
    and (not p_write or (j.state = 'uploading' and j.created_by = auth.uid()
         and split_part(p_name, '/', 2) ~ '^(source\.pdf|pages\.json|page-[0-9]{1,3}\.jpg)$'
         and array_length(string_to_array(p_name, '/'), 1) = 2)));
$$;
revoke all on function public.asm_import_storage_allowed(text, boolean) from public, anon;
grant execute on function public.asm_import_storage_allowed(text, boolean) to authenticated;

create policy asm_import_upload on storage.objects for insert to authenticated
with check (bucket_id = 'asm-imports' and public.asm_import_storage_allowed(name, true));
create policy asm_import_read on storage.objects for select to authenticated
using (bucket_id = 'asm-imports' and public.asm_import_storage_allowed(name, false));
create policy asm_import_boundary_update on storage.objects as restrictive for update to authenticated
using (bucket_id <> 'asm-imports') with check (bucket_id <> 'asm-imports');
create policy asm_import_boundary_delete on storage.objects as restrictive for delete to authenticated
using (bucket_id <> 'asm-imports');

-- What the browser sees of a job (the result only once it is done).
create or replace function public.asm_import_json(j public.asm_import_jobs, p_cached boolean default false) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id', j.id, 'kind', j.kind, 'state', j.state, 'fileName', j.file_name, 'pages', j.page_count, 'scannedPages', j.scanned_pages,
  'progress', j.progress, 'summary', j.summary, 'error', j.error, 'usage', j.usage, 'provider', j.provider, 'model', j.model, 'cached', p_cached,
  'createdAt', j.created_at, 'finishedAt', j.finished_at, 'result', case when j.state = 'done' then j.result end);
$$;
revoke all on function public.asm_import_json(public.asm_import_jobs, boolean) from public, anon, authenticated;

-- Start an import: the finished one for the same file (and kind) when there is one, else a new job waiting for its upload.
create or replace function public.asm_import_start(p_kind text, p_sha256 text, p_file_name text, p_bytes bigint, p_pages integer, p_scanned integer[] default '{}', p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.asm_import_jobs;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 if p_kind not in ('workbook', 'guide') then raise exception 'Unknown import kind' using errcode = '22023'; end if;
 if coalesce(p_sha256, '') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid file fingerprint' using errcode = '22023'; end if;
 if not coalesce(p_force, false) then
  select * into j from public.asm_import_jobs where kind = p_kind and sha256 = p_sha256 and state = 'done' order by finished_at desc limit 1;
  if found then return public.asm_import_json(j, true); end if;
 end if;
 insert into public.asm_import_jobs(kind, sha256, file_name, bytes, page_count, scanned_pages)
 values (p_kind, p_sha256, left(coalesce(nullif(btrim(p_file_name), ''), 'upload.pdf'), 255), p_bytes, p_pages, coalesce(p_scanned, '{}'))
 returning * into j;
 return public.asm_import_json(j, false);
end $$;

-- The upload is in place: queue the job and wake the worker.
create or replace function public.asm_import_queue(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.asm_import_jobs;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 select * into j from public.asm_import_jobs where id = p_id and created_by = auth.uid() for update;
 if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
 if j.state <> 'uploading' then return public.asm_import_json(j, false); end if;
 if not exists (select 1 from storage.objects o where o.bucket_id = 'asm-imports' and o.name = p_id::text || '/source.pdf')
    or not exists (select 1 from storage.objects o where o.bucket_id = 'asm-imports' and o.name = p_id::text || '/pages.json') then
  raise exception 'The upload is not complete' using errcode = '22023';
 end if;
 update public.asm_import_jobs set state = 'queued', progress = '{"label": "Starting", "done": 0, "total": 1}', updated_at = now() where id = p_id returning * into j;
 begin perform public.asm_import_dispatch(); exception when others then null; end; -- the cron picks it up within a minute
 return public.asm_import_json(j, false);
end $$;

create or replace function public.asm_import_status(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare j public.asm_import_jobs;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 select * into j from public.asm_import_jobs where id = p_id;
 if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
 return public.asm_import_json(j, false);
end $$;

-- The worker's claim: one job with nothing holding it (lease free, any retry wait over).
create or replace function public.asm_import_claim() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.asm_import_jobs;
begin
 select * into j from public.asm_import_jobs
 where state in ('queued', 'running') and coalesce(lease_until, '-infinity'::timestamptz) <= now()
 order by created_at limit 1 for update skip locked;
 if not found then return null; end if;
 update public.asm_import_jobs set state = 'running', lease = gen_random_uuid(), lease_until = now() + interval '5 minutes',
   started_at = coalesce(started_at, now()), updated_at = now()
 where id = j.id returning * into j;
 return to_jsonb(j);
end $$;

-- Wakes the worker (pg_net) when there is work; jobs silent for 30 minutes fail (the browser then uses the standard reader).
create or replace function public.asm_import_dispatch() returns void
language plpgsql security definer set search_path = '' as $$
declare endpoint text; credential text; pending integer;
begin
 update public.asm_import_jobs set state = 'failed', error = 'The AI reader stopped responding.', lease = null, lease_until = null, finished_at = now(), updated_at = now()
 where state in ('queued', 'running') and updated_at < now() - interval '30 minutes';
 delete from public.asm_import_jobs where state = 'uploading' and created_at < now() - interval '1 day';
 select count(*) into pending from (select 1 from public.asm_import_jobs
   where state in ('queued', 'running') and coalesce(lease_until, '-infinity'::timestamptz) <= now() limit 4) w;
 if pending = 0 then return; end if;
 select regexp_replace(decrypted_secret, '/staff-admin$', '/asm-import') into endpoint from vault.decrypted_secrets where name = 'hr_retention_function_url';
 select decrypted_secret into credential from vault.decrypted_secrets where name = 'hr_retention_service_role_key';
 if credential is null or endpoint is null or endpoint !~ '/asm-import$' then raise exception 'Assessment import dispatch credentials are unavailable.'; end if;
 for lane in 1..pending loop
  perform net.http_post(url => endpoint, headers => jsonb_build_object('Authorization', 'Bearer ' || credential, 'Content-Type', 'application/json'),
    body => '{}'::jsonb, timeout_milliseconds => 5000);
 end loop;
end $$;

revoke all on function public.asm_import_start(text, text, text, bigint, integer, integer[], boolean), public.asm_import_queue(uuid), public.asm_import_status(uuid),
  public.asm_import_claim(), public.asm_import_dispatch() from public, anon, authenticated, service_role;
grant execute on function public.asm_import_start(text, text, text, bigint, integer, integer[], boolean), public.asm_import_queue(uuid), public.asm_import_status(uuid) to authenticated;
grant execute on function public.asm_import_claim() to service_role;
grant select, update on public.asm_import_jobs to service_role;

select cron.schedule('asm-import-worker', '* * * * *', 'select public.asm_import_dispatch()');

-- The Edge Function allowlist (browser error reports, daily health check) gains asm-import; whatever is live is kept.
do $do$
declare names text[] := public.edge_function_names();
begin
 if not ('asm-import' = any(names)) then
  names := array(select x from unnest(names || array['asm-import']) x order by x);
  execute format('create or replace function public.edge_function_names() returns text[] language sql immutable as $f$ select %L::text[] $f$', names);
 end if;
end $do$;

-- The assessment suite's rule "no asm_* function is executable by anon" (T2): asm_attempts_range (BUSINESS-RULES-LIVE batch 3)
-- was left executable by anon; only signed-in users read it.
do $do$ begin
 if to_regprocedure('public.asm_attempts_range()') is not null then
  revoke execute on function public.asm_attempts_range() from public, anon;
  grant execute on function public.asm_attempts_range() to authenticated, service_role;
 end if;
end $do$;
