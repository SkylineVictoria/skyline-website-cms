-- P02-08 corrective migration. No ownership assignment or tenant rollout.
create or replace function public.tenant_scope(p_tenant uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select case when p_tenant is null then public.tenant_request_domain() is null
   and not exists(select 1 from public.tenant_memberships where auth_user_id=auth.uid())
 else p_tenant=public.tenant_current() and exists(select 1 from public.tenants where id=p_tenant and status='active') end;
$$;

-- Existing service-role callers are legacy-only until their scoped adapters
-- ship in the consuming phases. An assigned job must not enter that path.
create or replace function public.public_assistant_claim_index_job() returns setof public.public_assistant_index_jobs
language plpgsql security definer set search_path=public as $$
begin
 update public.public_assistant_index_jobs set state='failed',lease_token=null,lease_expires_at=null,error_code='attempt_limit',updated_at=clock_timestamp()
 where tenant_id is null and attempt_count>=3 and ((state='processing' and lease_expires_at<clock_timestamp()) or state='queued');
 return query with candidate as (
  select id from public.public_assistant_index_jobs where tenant_id is null and attempt_count<3 and
   ((state='queued' and next_attempt_at<=clock_timestamp()) or (state='processing' and lease_expires_at<clock_timestamp()))
   order by next_attempt_at,created_at for update skip locked limit 1
 ) update public.public_assistant_index_jobs j set state='processing',attempt_count=j.attempt_count+1,
 lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp()
 from candidate where j.id=candidate.id returning j.*;
end; $$;

create or replace function public.portal_claim_document_extraction_job() returns setof public.enrollment_document_extraction_jobs
language plpgsql security definer set search_path=public as $$
declare v_job public.enrollment_document_extraction_jobs;
begin
 if not pg_try_advisory_xact_lock(9341,20261015) then return; end if;
 if exists(select 1 from public.enrollment_document_extraction_jobs where tenant_id is null and state='processing'
  and (lease_expires_at is null or lease_expires_at>=now())) then return; end if;
 select * into v_job from public.enrollment_document_extraction_jobs where tenant_id is null and
  ((state='queued' and next_attempt_at<=now()) or (state='processing' and lease_expires_at<now()))
 order by next_attempt_at,created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.enrollment_document_extraction_jobs set state='processing',attempt_count=attempt_count+1,
 started_at=now(),updated_at=now(),lease_expires_at=now()+interval '4 minutes',lease_token=gen_random_uuid()
 where id=v_job.id returning * into v_job;
 update public.enrollment_application_documents set metadata=jsonb_set(metadata,'{extraction}',
 coalesce(metadata->'extraction','{}'::jsonb)||jsonb_build_object('status',case when metadata#>>'{extraction,status}'='confirmed' then 'confirmed' else 'processing' end),true)
 where id=v_job.document_id and application_id=v_job.application_id and tenant_id is null and is_current;
 return next v_job;
end; $$;

create or replace function public.public_assistant_search_chunks(p_query extensions.vector(1536),p_query_text text,p_course_code text default null,p_limit integer default 6)
returns table(chunk_id uuid,title text,heading text,content text,canonical_url text,page_reference text,course_code text,lexical_rank real,semantic_distance real)
language sql stable security invoker set search_path=public,extensions as $$
 select * from public.tenant_assistant_search(null,p_query,p_query_text,p_course_code,p_limit);
$$;
create or replace function public.public_assistant_content_version() returns text
language sql stable security definer set search_path=public as $$
 select public.tenant_assistant_version(null);
$$;

-- Preserve the SEC-18 lock ordering/fencing bodies; assert each replacement
-- matches the recorded predecessor before making the scoped change.
do $patch$
declare body text; needle text;
begin
 body:=pg_get_functiondef('public.public_assistant_commit_index(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
 needle:='if not found then return false; end if;';
 if strpos(body,needle)=0 then raise exception 'Unexpected index commit predecessor'; end if;
 body:=replace(body,needle,'if not found or j.tenant_id is not null then return false; end if;');
 execute body;
 body:=pg_get_functiondef('public.portal_finish_document_extraction_job(uuid,uuid,jsonb,text,jsonb)'::regprocedure);
 needle:='if not found or v_job.state';
 if strpos(body,needle)=0 then raise exception 'Unexpected extraction finish predecessor'; end if;
 execute replace(body,needle,'if not found or v_job.tenant_id is not null or v_job.state');
 body:=pg_get_functiondef('public.public_assistant_queue_cms_source()'::regprocedure);
 needle:='delete from public.public_assistant_answer_cache where cache_key is not null;';
 if strpos(body,needle)=0 then raise exception 'Unexpected cache invalidation predecessor'; end if;
 execute replace(body,needle,'delete from public.public_assistant_answer_cache where tenant_id is not distinct from ((case when tg_op=''DELETE'' then to_jsonb(old) else to_jsonb(new) end)->>''tenant_id'')::uuid;');
 body:=pg_get_functiondef('public.public_assistant_finish_index_job(uuid,uuid,uuid)'::regprocedure);
 if strpos(body,needle)=0 then raise exception 'Unexpected finish cache invalidation predecessor'; end if;
 execute replace(body,needle,'delete from public.public_assistant_answer_cache where tenant_id is not distinct from (select tenant_id from public.public_assistant_sources where id=p_source);');
end; $patch$;

grant select on public.public_assistant_sources,public.public_assistant_chunks,public.public_assistant_document_text,public.public_assistant_document_pages,public.public_assistant_document_corrections,public.public_assistant_usage_events to authenticated;
create policy tenant_knowledge_read on public.public_assistant_sources for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_chunk_read on public.public_assistant_chunks for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_text_read on public.public_assistant_document_text for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_page_read on public.public_assistant_document_pages for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_correction_read on public.public_assistant_document_corrections for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin','editor']));
create policy tenant_usage_read on public.public_assistant_usage_events for select to authenticated using(public.tenant_has_role(tenant_id,array['tenant_admin']));
