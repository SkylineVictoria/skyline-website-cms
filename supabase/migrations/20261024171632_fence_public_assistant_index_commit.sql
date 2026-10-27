-- SEC-18: prepare outside the database; persist an entire owned attempt atomically.
-- Existing rows/vectors are untouched by installation. Old worker binaries must
-- be stopped before a separately authorized migration/function rollout.
create or replace function public.public_assistant_commit_index(
  p_job uuid, p_lease uuid, p_source jsonb, p_chunks jsonb, p_document jsonb default null
) returns boolean language plpgsql security definer set search_path=public,extensions as $$
declare
  j public.public_assistant_index_jobs; locked_job public.public_assistant_index_jobs;
  eligible boolean; v_source_id uuid; text_id uuid; c jsonb; pg jsonb;
  current_corrections jsonb; vector_value extensions.vector(1536);
begin
  select * into j from public.public_assistant_index_jobs where id=p_job;
  if not found then return false; end if;
  -- CMS writes acquire their row before their queue trigger locks a job. Match
  -- that order. FOR SHARE also prevents non-key publication/content updates.
  if j.source_type='page' then
    select status='Published' into eligible from public.cms_pages where id=j.source_key for share;
  elsif j.source_type='course' then
    select status='Published' into eligible from public.cms_courses where id=j.source_key for share;
    -- Section writers acquire the parent lock in the trigger below, including
    -- inserts into an empty section list (no phantom-version race).
  elsif j.source_type='document' then
    select status='Published' and assistant_publication_approved into eligible
      from public.cms_documents where id=j.source_key for share;
  else return false; end if;
  select * into locked_job from public.public_assistant_index_jobs where id=p_job for update;
  if not found or locked_job.state<>'processing' or locked_job.lease_token is distinct from p_lease
     or p_lease is null or locked_job.lease_expires_at<=clock_timestamp()
     or locked_job.lease_expires_at is null or not coalesce(eligible,false)
     or locked_job.source_type is distinct from j.source_type or locked_job.source_key is distinct from j.source_key
     or locked_job.source_version is distinct from public.public_assistant_cms_source_version(j.source_type,j.source_key)
     or p_source->>'type' is distinct from locked_job.source_type
     or p_source->>'key' is distinct from locked_job.source_key
     or p_source->>'version' is distinct from locked_job.source_version then return false;
  end if;
  if jsonb_typeof(p_chunks) is distinct from 'array' or jsonb_array_length(p_chunks) not between 1 and 512 then
    raise exception 'Invalid chunk batch' using errcode='22023';
  end if;
  if j.source_type='document' then
    if p_document is null or jsonb_typeof(p_document->'pages') is distinct from 'array'
       or jsonb_array_length(p_document->'pages') not between 1 and 120 then
      raise exception 'Invalid document pages' using errcode='22023';
    end if;
    select id into text_id from public.public_assistant_document_text
      where document_id=j.source_key and source_version=locked_job.source_version and file_hash=p_source->>'hash' for update;
    -- Serialize approved corrections with their parent text row. Compare the
    -- exact approved inputs read by this worker before allowing publication.
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'page_number',page_number,'replacement_text',replacement_text) order by id),'[]')
      into current_corrections from public.public_assistant_document_corrections
      where document_text_id=text_id and approved_at is not null;
    if current_corrections is distinct from coalesce(p_document->'corrections','[]') then return false; end if;
  elsif p_document is not null then return false;
  end if;
  insert into public.public_assistant_sources(source_type,source_key,source_version,canonical_url,title,publication_status,content_hash)
    values(j.source_type,j.source_key,locked_job.source_version,p_source->>'url',p_source->>'title','staged',p_source->>'hash')
    on conflict(source_type,source_key,source_version) do update set canonical_url=excluded.canonical_url,title=excluded.title,
      content_hash=excluded.content_hash,publication_status='staged',updated_at=clock_timestamp() returning id into v_source_id;
  -- Preserve IDs for matching chunks. Removal of obsolete chunks happens only
  -- within this owned transaction; no stale cleanup API is exposed.
  for c in select value from jsonb_array_elements(p_chunks) loop
    if jsonb_typeof(c->'embedding') is distinct from 'array' or jsonb_array_length(c->'embedding')<>1536
       or nullif(c->>'content','') is null then raise exception 'Invalid embedding chunk' using errcode='22023'; end if;
    vector_value:=(c->'embedding')::text::extensions.vector(1536);
    if extensions.vector_norm(vector_value)=0 then raise exception 'Zero embedding' using errcode='22023'; end if;
    insert into public.public_assistant_chunks(source_id,ordinal,heading,content,content_hash,page_reference,course_code,embedding,embedding_model,embedding_dimensions)
      values(v_source_id,(c->>'ordinal')::integer,c->>'heading',c->>'content',p_source->>'hash',c->>'page_reference',p_source->>'course_code',vector_value,p_source->>'model',1536)
      on conflict(source_id,ordinal,content_hash) do update set heading=excluded.heading,content=excluded.content,
        page_reference=excluded.page_reference,course_code=excluded.course_code,embedding=excluded.embedding,embedding_model=excluded.embedding_model,embedding_dimensions=1536;
  end loop;
  delete from public.public_assistant_chunks old_chunk where old_chunk.source_id=v_source_id
    and not exists(select 1 from jsonb_array_elements(p_chunks) incoming(value) where (incoming.value->>'ordinal')::integer=old_chunk.ordinal and old_chunk.content_hash=p_source->>'hash');
  if j.source_type='document' then
    insert into public.public_assistant_document_text(document_id,source_version,file_hash,original_text,cleaned_text,extraction_method,extraction_version,processing_status,warning,extracted_at)
      values(j.source_key,locked_job.source_version,p_source->>'hash',p_document->>'original',p_document->>'cleaned',p_document->>'method','public-document-extraction-v1','complete',coalesce(p_document->'warnings','[]'),clock_timestamp())
      on conflict(document_id,source_version,file_hash) do update set cleaned_text=excluded.cleaned_text,
        processing_status='complete',warning=excluded.warning,updated_at=clock_timestamp() returning id into text_id;
    for pg in select value from jsonb_array_elements(p_document->'pages') loop
      insert into public.public_assistant_document_pages(document_text_id,page_number,original_text,cleaned_text,status,warnings)
        values(text_id,(pg->>'number')::integer,pg->>'original',pg->>'cleaned',pg->>'status',coalesce(pg->'warnings','[]'))
        on conflict(document_text_id,page_number) do update set cleaned_text=excluded.cleaned_text,status=excluded.status,warnings=excluded.warnings;
    end loop;
    delete from public.public_assistant_document_pages old_page where old_page.document_text_id=text_id
      and not exists(select 1 from jsonb_array_elements(p_document->'pages') incoming(value) where (incoming.value->>'number')::integer=old_page.page_number);
  end if;
  -- Existing activation remains an internal helper. Any failure rolls back all
  -- writes above, including expiry while waiting for artifact locks.
  if not public.public_assistant_finish_index_job(p_job,p_lease,v_source_id) then
    raise exception 'Index lease expired during commit' using errcode='40001';
  end if;
  insert into public.public_assistant_usage_events(kind,model,input_tokens,request_key)
    values('embedding',p_source->>'model',greatest(0,coalesce((p_source->>'tokens')::integer,0)),p_job::text);
  return true;
end;
$$;
revoke all on function public.public_assistant_commit_index(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.public_assistant_commit_index(uuid,uuid,jsonb,jsonb,jsonb) to service_role;
-- BYPASSRLS does not bypass table privileges. Legacy/stale workers cannot
-- mutate artifacts/jobs or call activation outside the owned transaction.
revoke insert,update,delete,truncate,references,trigger on public.public_assistant_sources,public.public_assistant_chunks,
  public.public_assistant_document_text,public.public_assistant_document_pages,public.public_assistant_index_jobs from service_role,anon,authenticated;
revoke all on function public.public_assistant_finish_index_job(uuid,uuid,uuid) from service_role;

create or replace function public.public_assistant_lock_index_parent() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if tg_table_name='cms_course_sections' then
    perform id from public.cms_courses where id in (case when tg_op<>'INSERT' then old.course_id end,case when tg_op<>'DELETE' then new.course_id end) order by id for update;
  else
    perform id from public.public_assistant_document_text where id in (case when tg_op<>'INSERT' then old.document_text_id end,case when tg_op<>'DELETE' then new.document_text_id end) order by id for update;
  end if;
  return coalesce(new,old);
end;
$$;
revoke all on function public.public_assistant_lock_index_parent() from public,anon,authenticated,service_role;
create or replace trigger public_assistant_sections_parent_lock before insert or update or delete on public.cms_course_sections for each row execute function public.public_assistant_lock_index_parent();
create or replace trigger public_assistant_corrections_parent_lock before insert or update or delete on public.public_assistant_document_corrections for each row execute function public.public_assistant_lock_index_parent();

-- Bound repeated crashes; each claim mints a new token and at most three tries.
create or replace function public.public_assistant_claim_index_job() returns setof public.public_assistant_index_jobs
language plpgsql security definer set search_path=public as $$
begin
  update public.public_assistant_index_jobs set state='failed',lease_token=null,lease_expires_at=null,error_code='attempt_limit',updated_at=clock_timestamp()
    where attempt_count>=3 and ((state='processing' and lease_expires_at<clock_timestamp()) or state='queued');
  return query with candidate as (
    select id from public.public_assistant_index_jobs where attempt_count<3 and
      ((state='queued' and next_attempt_at<=clock_timestamp()) or (state='processing' and lease_expires_at<clock_timestamp()))
      order by next_attempt_at,created_at for update skip locked limit 1
  ) update public.public_assistant_index_jobs j set state='processing',attempt_count=j.attempt_count+1,
      lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp()
      from candidate where j.id=candidate.id returning j.*;
end;
$$;
create or replace function public.public_assistant_fail_index_job(p_job uuid,p_lease uuid,p_error text) returns boolean
language plpgsql security definer set search_path=public as $$
declare j public.public_assistant_index_jobs;
begin
  select * into j from public.public_assistant_index_jobs where id=p_job for update;
  if not found or j.state<>'processing' or j.lease_token is distinct from p_lease or p_lease is null or j.lease_expires_at<=clock_timestamp() or j.lease_expires_at is null then return false; end if;
  update public.public_assistant_index_jobs set state=case when attempt_count<3 then 'queued' else 'failed' end,
    next_attempt_at=clock_timestamp()+interval '30 seconds'*attempt_count,lease_token=null,lease_expires_at=null,
    error_code='index',error=left(p_error,500),updated_at=clock_timestamp() where id=p_job;
  return true;
end;
$$;
create or replace function public.public_assistant_cancel_index_job(p_job uuid,p_lease uuid) returns boolean
language plpgsql security definer set search_path=public as $$
declare j public.public_assistant_index_jobs;
begin
  select * into j from public.public_assistant_index_jobs where id=p_job for update;
  if not found or j.state<>'processing' or j.lease_token is distinct from p_lease or p_lease is null or j.lease_expires_at<=clock_timestamp() or j.lease_expires_at is null then return false; end if;
  update public.public_assistant_index_jobs set state='cancelled',lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where id=p_job;
  return true;
end;
$$;
