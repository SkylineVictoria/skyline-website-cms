-- Event-driven dispatch with low-frequency recovery for the existing durable
-- queues.  This migration changes neither queue ownership nor RLS policies.
-- It deliberately uses stable cron job names, rather than environment-specific
-- job IDs, so it is safe to review and apply in another environment.
begin;

-- A cron invocation must not call an Edge Function merely to discover an idle
-- queue.  The indexed EXISTS predicates are also used by event dispatch.
create index if not exists enrollment_document_extraction_jobs_queued_ready_idx
  on public.enrollment_document_extraction_jobs (next_attempt_at, created_at)
  where state = 'queued';
create index if not exists enrollment_document_extraction_jobs_expired_lease_idx
  on public.enrollment_document_extraction_jobs (lease_expires_at, created_at)
  where state = 'processing';
create index if not exists public_assistant_index_jobs_queued_ready_idx
  on public.public_assistant_index_jobs (next_attempt_at, created_at)
  where state = 'queued';
create index if not exists public_assistant_index_jobs_expired_lease_idx
  on public.public_assistant_index_jobs (lease_expires_at, created_at)
  where state = 'processing';

create or replace function public.portal_dispatch_document_extraction_worker()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_worker_secret text;
begin
  -- The extraction claimant permits one live lease. Do not create an HTTP
  -- invocation that cannot claim anything while that lease is active.
  if exists (
    select 1 from public.enrollment_document_extraction_jobs
    where state = 'processing'
      and (lease_expires_at is null or lease_expires_at >= clock_timestamp())
  ) then
    return null;
  end if;

  if not exists (
    select 1 from public.enrollment_document_extraction_jobs
    where (state = 'queued' and next_attempt_at <= clock_timestamp())
       or (state = 'processing' and lease_expires_at < clock_timestamp())
  ) then
    return null;
  end if;

  select decrypted_secret into v_worker_secret
  from vault.decrypted_secrets
  where name = 'DOCUMENT_EXTRACTION_WORKER_SECRET'
  limit 1;
  if nullif(v_worker_secret, '') is null then return null; end if;

  return net.http_post(
    url := 'https://xcpydisstlvtvcsqnjob.supabase.co/functions/v1/portal-document-extract',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_worker_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end;
$$;
revoke all on function public.portal_dispatch_document_extraction_worker() from public, anon, authenticated;
grant execute on function public.portal_dispatch_document_extraction_worker() to postgres;

-- Match extraction's bounded concurrency: a burst of CMS edits may schedule
-- several HTTP requests, but only one worker can claim/index at a time.
create or replace function public.public_assistant_claim_index_job()
returns setof public.public_assistant_index_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if not pg_try_advisory_xact_lock(9341, 20261023) then return; end if;
  if exists (
    select 1 from public.public_assistant_index_jobs
    where state = 'processing'
      and (lease_expires_at is null or lease_expires_at >= clock_timestamp())
  ) then return; end if;

  return query
  with candidate as (
    select id from public.public_assistant_index_jobs
    where (state = 'queued' and next_attempt_at <= clock_timestamp())
       or (state = 'processing' and lease_expires_at < clock_timestamp())
    order by next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update public.public_assistant_index_jobs j
  set state = 'processing', attempt_count = j.attempt_count + 1,
      lease_token = gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '3 minutes',
      updated_at = clock_timestamp()
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;
revoke all on function public.public_assistant_claim_index_job() from public, anon, authenticated;
grant execute on function public.public_assistant_claim_index_job() to service_role;

create or replace function public.public_assistant_dispatch_index_worker()
returns bigint
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_worker_secret text;
begin
  if exists (
    select 1 from public.public_assistant_index_jobs
    where state = 'processing'
      and (lease_expires_at is null or lease_expires_at >= clock_timestamp())
  ) then return null; end if;
  if not exists (
    select 1 from public.public_assistant_index_jobs
    where (state = 'queued' and next_attempt_at <= clock_timestamp())
       or (state = 'processing' and lease_expires_at < clock_timestamp())
  ) then return null; end if;

  select decrypted_secret into v_worker_secret
  from vault.decrypted_secrets
  where name = 'PUBLIC_ASSISTANT_WORKER_SECRET'
  limit 1;
  if nullif(v_worker_secret, '') is null then return null; end if;
  return net.http_post(
    url := 'https://xcpydisstlvtvcsqnjob.supabase.co/functions/v1/public-assistant-index',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_worker_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end;
$$;
revoke all on function public.public_assistant_dispatch_index_worker() from public, anon, authenticated;
grant execute on function public.public_assistant_dispatch_index_worker() to postgres;

-- Version only the fields consumed by the index worker. This avoids embeddings
-- for administrative/display-only changes while detecting indexed course
-- sections, public pages, and explicitly approved public documents.
create or replace function public.public_assistant_cms_source_version(p_type text, p_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_payload jsonb;
begin
  if p_type = 'course' then
    select jsonb_build_object(
      'course', jsonb_build_object('id', c.id, 'slug', c.slug, 'code', c.code,
        'name', c.name, 'cricos', c.cricos, 'duration', c.duration, 'mode', c.mode,
        'fees', c.fees, 'full_description', c.full_description,
        'entry_requirements', c.entry_requirements, 'status', c.status),
      'sections', coalesce(jsonb_agg(jsonb_build_object('title', s.title, 'body', s.body, 'sort', s.sort) order by s.sort, s.id), '[]'::jsonb)
    ) into v_payload
    from public.cms_courses c
    left join public.cms_course_sections s on s.course_id = c.id
    where c.id = p_key
    group by c.id;
  elsif p_type = 'page' then
    select jsonb_build_object('id', id, 'slug', slug, 'title', title, 'body', body, 'status', status)
      into v_payload from public.cms_pages where id = p_key;
  elsif p_type = 'document' then
    select jsonb_build_object('id', id, 'name', name, 'url', url, 'status', status,
      'assistant_publication_approved', assistant_publication_approved, 'bucket_name', bucket_name,
      'storage_path', storage_path, 'mime_type', mime_type, 'file_size', file_size,
      'file_name', file_name, 'original_file_name', original_file_name)
      into v_payload from public.cms_documents where id = p_key;
  end if;
  return case when v_payload is null then null else md5(v_payload::text) end;
end;
$$;
revoke all on function public.public_assistant_cms_source_version(text, text) from public, anon, authenticated;

-- One current queued version per source is enough. Older queued versions are
-- cancelled before they can consume embeddings; an already-processing version
-- is allowed to finish but cannot activate if it is stale.
create or replace function public.public_assistant_enqueue_index_job(p_type text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_version text; v_state text;
begin
  v_version := public.public_assistant_cms_source_version(p_type, p_key);
  if v_version is null then return false; end if;
  update public.public_assistant_index_jobs
     set state = 'cancelled', lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
   where source_type = p_type and source_key = p_key and source_version is distinct from v_version
     and state = 'queued';
  select state into v_state from public.public_assistant_index_jobs
   where source_type = p_type and source_key = p_key and source_version = v_version
   for update;
  if v_state is null then
    insert into public.public_assistant_index_jobs(source_type, source_key, source_version)
      values (p_type, p_key, v_version);
    return true;
  end if;
  return v_state = 'queued';
end;
$$;
revoke all on function public.public_assistant_enqueue_index_job(text, text) from public, anon, authenticated;

create or replace function public.public_assistant_queue_cms_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_type text := tg_argv[0]; v_key text; v_dispatch boolean := false;
begin
  v_key := case when tg_op = 'DELETE' then old.id else new.id end;
  delete from public.public_assistant_answer_cache where cache_key is not null;
  if tg_op = 'DELETE' or coalesce(new.status, 'Draft') <> 'Published'
     or (v_type = 'document' and not coalesce(new.assistant_publication_approved, false)) then
    update public.public_assistant_sources set publication_status = 'unpublished', updated_at = clock_timestamp()
      where source_type = v_type and source_key = v_key and publication_status = 'published';
    update public.public_assistant_index_jobs set state = 'cancelled', lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
      where source_type = v_type and source_key = v_key and state = 'queued';
    return coalesce(new, old);
  end if;
  v_dispatch := public.public_assistant_enqueue_index_job(v_type, v_key);
  if v_dispatch then perform public.public_assistant_dispatch_index_worker(); end if;
  return new;
end;
$$;

-- Course source content includes sections, so section edits must enqueue the
-- parent course even when the course row itself is unchanged.
create or replace function public.public_assistant_queue_course_section()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_course_id text; v_dispatch boolean := false;
begin
  v_course_id := case when tg_op = 'DELETE' then old.course_id else new.course_id end;
  delete from public.public_assistant_answer_cache where cache_key is not null;
  if exists (select 1 from public.cms_courses where id = v_course_id and status = 'Published') then
    v_dispatch := public.public_assistant_enqueue_index_job('course', v_course_id);
    if v_dispatch then perform public.public_assistant_dispatch_index_worker(); end if;
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists public_assistant_course_sections_queue on public.cms_course_sections;
create trigger public_assistant_course_sections_queue
after insert or update or delete on public.cms_course_sections
for each row execute function public.public_assistant_queue_course_section();
revoke all on function public.public_assistant_queue_cms_source() from public, anon, authenticated;
revoke all on function public.public_assistant_queue_course_section() from public, anon, authenticated;

-- Activation must validate with the same content-aware version used at enqueue
-- time. This preserves the existing staged-source swap and stale-worker guard.
create or replace function public.public_assistant_finish_index_job(p_job uuid, p_lease uuid, p_source uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare j public.public_assistant_index_jobs; ok boolean := false; current_version text; legacy_version text;
begin
  select * into j from public.public_assistant_index_jobs
   where id = p_job and state = 'processing' and lease_token = p_lease
     and lease_expires_at > clock_timestamp()
   for update;
  if not found then return false; end if;
  if not exists (
    select 1 from public.public_assistant_sources s
    where s.id = p_source and s.source_type = j.source_type and s.source_key = j.source_key
      and s.source_version = j.source_version and s.publication_status = 'staged'
  ) then return false; end if;

  if j.source_type = 'document' then
    select status = 'Published' and assistant_publication_approved, md5(to_jsonb(d)::text) into ok, legacy_version
      from public.cms_documents d where id = j.source_key;
  elsif j.source_type = 'course' then
    select status = 'Published', md5(to_jsonb(c)::text) into ok, legacy_version from public.cms_courses c where id = j.source_key;
  elsif j.source_type = 'page' then
    select status = 'Published', md5(to_jsonb(p)::text) into ok, legacy_version from public.cms_pages p where id = j.source_key;
  else return false;
  end if;
  current_version := public.public_assistant_cms_source_version(j.source_type, j.source_key);
  if not coalesce(ok, false) or j.source_version not in (current_version, legacy_version) then return false; end if;

  update public.public_assistant_sources set publication_status = 'unpublished', updated_at = clock_timestamp()
   where source_type = j.source_type and source_key = j.source_key and publication_status = 'published';
  update public.public_assistant_sources set publication_status = 'published', effective_at = clock_timestamp(),
      indexed_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_source;
  update public.public_assistant_index_jobs set state = 'succeeded', lease_token = null,
      lease_expires_at = null, updated_at = clock_timestamp() where id = p_job;
  delete from public.public_assistant_answer_cache where cache_key is not null;
  return true;
end;
$$;
revoke all on function public.public_assistant_finish_index_job(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.public_assistant_finish_index_job(uuid, uuid, uuid) to service_role;

-- Do not recreate or delete named jobs. Alter a matching job when present;
-- schedule it only when an environment has not yet created it.
do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'portal-document-extraction-worker' order by jobid limit 1;
  if v_job_id is null then
    perform cron.schedule('portal-document-extraction-worker', '*/5 * * * *', 'select public.portal_dispatch_document_extraction_worker();');
  else
    perform cron.alter_job(v_job_id, schedule := '*/5 * * * *');
  end if;
  select jobid into v_job_id from cron.job where jobname = 'public-assistant-index-worker' order by jobid limit 1;
  if v_job_id is null then
    perform cron.schedule('public-assistant-index-worker', '*/15 * * * *', 'select public.public_assistant_dispatch_index_worker();');
  else
    perform cron.alter_job(v_job_id, schedule := '*/15 * * * *');
  end if;
end;
$$;

commit;
