-- ASM-IMPORT-CHECKS (2026-11-25, owner): the AI import's reader version is part of the cache key.
--
-- A finished import used to be answered from the cache for the same file (kind + SHA-256) whatever logic read it, so a file read
-- before the verbatim / flag fixes kept its old result. Each job now records the reader version that produced its result
-- (asm-import writes READER_VERSION from supabase/functions/_shared/asm-import/pipeline.ts when it finishes), and asm_import_start
-- reuses a finished job only for a browser asking for the same version (p_reader). Jobs read before this change are version 1.
-- A browser that sends no version (the frontend before this release) asks for version 1, as before.

alter table public.asm_import_jobs add column reader_version integer not null default 1 check (reader_version between 1 and 1000);

drop index if exists public.asm_import_jobs_cache;
create index asm_import_jobs_cache on public.asm_import_jobs(kind, sha256, reader_version, finished_at desc) where state = 'done';

-- What the browser sees of a job: the reader version added.
create or replace function public.asm_import_json(j public.asm_import_jobs, p_cached boolean default false) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id', j.id, 'kind', j.kind, 'state', j.state, 'fileName', j.file_name, 'pages', j.page_count, 'scannedPages', j.scanned_pages,
  'progress', j.progress, 'summary', j.summary, 'error', j.error, 'usage', j.usage, 'provider', j.provider, 'model', j.model, 'cached', p_cached,
  'readerVersion', j.reader_version, 'createdAt', j.created_at, 'finishedAt', j.finished_at, 'result', case when j.state = 'done' then j.result end);
$$;
revoke all on function public.asm_import_json(public.asm_import_jobs, boolean) from public, anon, authenticated;

-- Start an import: the finished one for the same file, kind AND reader version when there is one, else a new job.
drop function public.asm_import_start(text, text, text, bigint, integer, integer[], boolean);
create function public.asm_import_start(p_kind text, p_sha256 text, p_file_name text, p_bytes bigint, p_pages integer, p_scanned integer[] default '{}',
  p_force boolean default false, p_reader integer default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.asm_import_jobs;
begin
 if not public.asm_is_admin() then raise exception 'Only admins and RTO managers can import assessments' using errcode = '42501'; end if;
 if p_kind not in ('workbook', 'guide') then raise exception 'Unknown import kind' using errcode = '22023'; end if;
 if coalesce(p_sha256, '') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid file fingerprint' using errcode = '22023'; end if;
 if coalesce(p_reader, 0) not between 1 and 1000 then raise exception 'Invalid reader version' using errcode = '22023'; end if;
 if not coalesce(p_force, false) then
  select * into j from public.asm_import_jobs
  where kind = p_kind and sha256 = p_sha256 and reader_version = p_reader and state = 'done' order by finished_at desc limit 1;
  if found then return public.asm_import_json(j, true); end if;
 end if;
 insert into public.asm_import_jobs(kind, sha256, file_name, bytes, page_count, scanned_pages, reader_version)
 values (p_kind, p_sha256, left(coalesce(nullif(btrim(p_file_name), ''), 'upload.pdf'), 255), p_bytes, p_pages, coalesce(p_scanned, '{}'), p_reader)
 returning * into j;
 return public.asm_import_json(j, false);
end $$;
revoke all on function public.asm_import_start(text, text, text, bigint, integer, integer[], boolean, integer) from public, anon, authenticated, service_role;
grant execute on function public.asm_import_start(text, text, text, bigint, integer, integer[], boolean, integer) to authenticated;
