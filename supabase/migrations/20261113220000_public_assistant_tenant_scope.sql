-- P09-01: the public assistant's structured answers, FAQs, vector search, answer cache, indexing and budgets are bound to the
-- verified public tenant. A null tenant is the existing (legacy) institution and keeps its behaviour. Additive: new scoped
-- functions, a per-tenant FAQ key, and guarded patches of the SEC-18 fenced claim/commit bodies (predecessors asserted).

-- FAQs: one question per institution, not one per platform (two tenants may both answer "What are the fees?").
create unique index if not exists public_assistant_faqs_tenant_question_key
  on public.public_assistant_faqs(tenant_id, normalized_question) nulls not distinct;
do $faq$
declare c text;
begin
 select con.conname into c from pg_constraint con
  where con.conrelid='public.public_assistant_faqs'::regclass and con.contype='u'
    and con.conkey=array[(select attnum from pg_attribute where attrelid='public.public_assistant_faqs'::regclass and attname='normalized_question')]::smallint[];
 if c is not null then execute format('alter table public.public_assistant_faqs drop constraint %I', c); end if;
end; $faq$;

-- Everything the public assistant reads for one request, in one snapshot. Null for an unknown or inactive tenant (fail closed).
create or replace function public.tenant_assistant_context(p_tenant uuid) returns jsonb
language sql stable security definer set search_path=public as $$
 select case when p_tenant is not null and not exists(select 1 from public.tenants where id=p_tenant and status='active') then null
 else jsonb_build_object(
  'version', public.tenant_assistant_version(p_tenant),
  'institution', coalesce((select t.name from public.tenants t where t.id=p_tenant), 'SLIT'),
  'faqs', coalesce((select jsonb_agg(jsonb_build_object('question',f.question,'normalized_question',f.normalized_question,'aliases',f.aliases,
      'answer',f.answer,'source_url',f.source_url) order by f.normalized_question)
    from public.public_assistant_faqs f where f.tenant_id is not distinct from p_tenant and f.status='published'), '[]'::jsonb),
  'courses', coalesce((select jsonb_agg(jsonb_build_object('name',c.name,'code',c.code,'cricos',c.cricos,'duration',c.duration,'mode',c.mode,
      'fees',c.fees,'slug',c.slug) order by c.display_order, c.id)
    from public.cms_courses c where c.tenant_id is not distinct from p_tenant and c.status='Published'), '[]'::jsonb))
 end;
$$;

-- Answer cache: a key is only ever read or overwritten within its own tenant.
create or replace function public.tenant_assistant_cache_get(p_tenant uuid, p_key text, p_version text) returns jsonb
language sql stable security definer set search_path=public as $$
 select c.answer from public.public_assistant_answer_cache c
  where c.cache_key=p_key and c.tenant_id is not distinct from p_tenant and c.source_version=p_version and c.expires_at>clock_timestamp()
    and (p_tenant is null or exists(select 1 from public.tenants where id=p_tenant and status='active'));
$$;
create or replace function public.tenant_assistant_cache_put(p_tenant uuid, p_key text, p_version text, p_answer jsonb, p_ttl_seconds integer default 300)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 if p_key is null or p_key !~ '^[0-9a-f]{64}$' or nullif(p_version,'') is null or jsonb_typeof(p_answer) is distinct from 'object' then
  raise exception 'Invalid cache entry' using errcode='22023';
 end if;
 if p_tenant is not null and not exists(select 1 from public.tenants where id=p_tenant and status='active') then return false; end if;
 insert into public.public_assistant_answer_cache(cache_key,tenant_id,source_version,answer,expires_at)
  values(p_key,p_tenant,p_version,p_answer,clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_ttl_seconds,300),1),3600)))
  on conflict(cache_key) do update set source_version=excluded.source_version,answer=excluded.answer,expires_at=excluded.expires_at
  where public.public_assistant_answer_cache.tenant_id is not distinct from excluded.tenant_id;
 get diagnostics n = row_count;
 return n=1;
end; $$;

revoke all on function public.tenant_assistant_context(uuid), public.tenant_assistant_cache_get(uuid,text,text),
  public.tenant_assistant_cache_put(uuid,text,text,jsonb,integer) from public, anon, authenticated;
grant execute on function public.tenant_assistant_context(uuid), public.tenant_assistant_cache_get(uuid,text,text),
  public.tenant_assistant_cache_put(uuid,text,text,jsonb,integer) to service_role;

-- Indexing: claim legacy and active-tenant jobs. A job of an inactive tenant is left untouched (tenant_bind_row refuses
-- writes to it) and is never claimed. Same lease, attempt limit and lock order as the SEC-18 body this replaces.
create or replace function public.public_assistant_claim_index_job() returns setof public.public_assistant_index_jobs
language plpgsql security definer set search_path=public as $$
begin
 update public.public_assistant_index_jobs j set state='failed',lease_token=null,lease_expires_at=null,error_code='attempt_limit',updated_at=clock_timestamp()
 where (j.tenant_id is null or exists(select 1 from public.tenants t where t.id=j.tenant_id and t.status='active'))
   and j.attempt_count>=3 and ((j.state='processing' and j.lease_expires_at<clock_timestamp()) or j.state='queued');
 return query with candidate as (
  select q.id from public.public_assistant_index_jobs q
   where (q.tenant_id is null or exists(select 1 from public.tenants t where t.id=q.tenant_id and t.status='active'))
     and q.attempt_count<3 and ((q.state='queued' and q.next_attempt_at<=clock_timestamp()) or (q.state='processing' and q.lease_expires_at<clock_timestamp()))
   order by q.next_attempt_at,q.created_at for update skip locked limit 1
 ) update public.public_assistant_index_jobs j set state='processing',attempt_count=j.attempt_count+1,
 lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp()
 from candidate where j.id=candidate.id returning j.*;
end; $$;
revoke all on function public.public_assistant_claim_index_job() from public, anon, authenticated;
grant execute on function public.public_assistant_claim_index_job() to service_role;

-- Fenced commit: accept an active tenant's job, require the CMS parent to belong to the job's tenant, and accept a document only
-- from that institution's public storage (legacy: cms-media forms/ or policies/; tenant: tenant-public-media/<tenant id>/).
-- Private buckets (enrollment-documents, staff/signing documents) can never become a public source.
do $patch$
declare body text; needle text; replacement text; pair text[];
begin
 body:=pg_get_functiondef('public.public_assistant_commit_index(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
 foreach pair slice 1 in array array[
  ['if not found or j.tenant_id is not null then return false; end if;',
   'if not found or (j.tenant_id is not null and not exists(select 1 from public.tenants where id=j.tenant_id and status=''active'')) then return false; end if;'],
  ['select status=''Published'' into eligible from public.cms_pages where id=j.source_key for share;',
   'select status=''Published'' and tenant_id is not distinct from j.tenant_id into eligible from public.cms_pages where id=j.source_key for share;'],
  ['select status=''Published'' into eligible from public.cms_courses where id=j.source_key for share;',
   'select status=''Published'' and tenant_id is not distinct from j.tenant_id into eligible from public.cms_courses where id=j.source_key for share;'],
  ['select status=''Published'' and assistant_publication_approved into eligible',
   'select status=''Published'' and assistant_publication_approved and tenant_id is not distinct from j.tenant_id and coalesce((tenant_id is null and bucket_name=''cms-media'' and (storage_path like ''forms/%'' or storage_path like ''policies/%'')) or (tenant_id is not null and bucket_name=''tenant-public-media'' and storage_path like tenant_id::text||''/%''),false) into eligible'],
  ['insert into public.public_assistant_usage_events(kind,model,input_tokens,request_key)',
   'insert into public.public_assistant_usage_events(kind,model,input_tokens,request_key,tenant_id)'],
  ['p_job::text);', 'p_job::text,j.tenant_id);']
 ] loop
  needle:=pair[1]; replacement:=pair[2];
  if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'Unexpected index commit predecessor: %', needle; end if;
  body:=replace(body,needle,replacement);
 end loop;
 execute body;
end; $patch$;
