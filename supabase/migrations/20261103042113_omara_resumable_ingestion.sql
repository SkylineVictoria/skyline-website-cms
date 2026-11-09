
create unique index omara_directory_marn_unique on public.omara_business_directory(marn);
alter table public.omara_business_directory alter column business_name drop not null;
create table public.omara_ingestion_jobs (
 id uuid primary key default gen_random_uuid(), status text not null default 'ready' check(status in ('ready','running','failed','completed','paused')),
 cursor jsonb not null default '{"page":1,"offset":0,"records":[],"more":true}',
 processed bigint not null default 0, batches bigint not null default 0,
 lease uuid, lease_until timestamptz, error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz
);
alter table public.omara_ingestion_jobs enable row level security;
revoke all on public.omara_ingestion_jobs from anon, authenticated;
grant all on public.omara_ingestion_jobs to service_role;
create function public.omara_claim(p_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.omara_ingestion_jobs; begin
 update public.omara_ingestion_jobs set lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',status='running',updated_at=now(),error=null
 where id=p_id and status in ('ready','running','failed') and (lease_until is null or lease_until<now()) returning * into j;
 return to_jsonb(j); end $$;
create function public.omara_commit(p_id uuid,p_lease uuid,p_cursor jsonb,p_rows jsonb,p_done boolean default false,p_error text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare item jsonb; r public.omara_business_directory; j public.omara_ingestion_jobs;
begin
 select * into j from public.omara_ingestion_jobs where id=p_id for update;
 if j.lease is distinct from p_lease or j.status <> 'running' then raise exception 'Lease lost'; end if;
 if jsonb_array_length(p_rows)>100 then raise exception 'Batch too large'; end if;
 for item in select value from jsonb_array_elements(p_rows) loop
 r:=jsonb_populate_record(null::public.omara_business_directory,item);
 if r.marn is null or r.marn !~ '^[0-9]{7}$' or r.omara_contact_id is null or r.omara_source_url not like 'https://portal.mara.gov.au/search-the-register-of-migration-agents/register-of-migration-agent-details/?ContactID=%' then raise exception 'Invalid OMARA identity'; end if;
 if exists(select 1 from public.omara_business_directory d where d.marn=r.marn and d.omara_contact_id is distinct from r.omara_contact_id) then raise exception 'MARN/contact conflict: %',r.marn; end if;
 insert into public.omara_business_directory (business_name,normalized_business_name,business_email,business_phone,business_website,business_address,suburb,state,postcode,country,marn,agent_first_name,agent_family_name,agent_full_name,agent_registration_status,agent_registration_start_date,agent_phone,agent_email,agent_website,omara_contact_id,omara_source_url,omara_is_active,source,last_checked_at,omara_last_synced_at,updated_at) values (r.business_name,r.normalized_business_name,r.business_email,r.business_phone,r.business_website,r.business_address,r.suburb,r.state,r.postcode,r.country,r.marn,r.agent_first_name,r.agent_family_name,r.agent_full_name,r.agent_registration_status,r.agent_registration_start_date,r.agent_phone,r.agent_email,r.agent_website,r.omara_contact_id,r.omara_source_url,r.omara_is_active,r.source,r.last_checked_at,r.omara_last_synced_at,r.updated_at)
 on conflict(marn) do update set business_name=excluded.business_name,normalized_business_name=excluded.normalized_business_name,business_email=excluded.business_email,business_phone=excluded.business_phone,business_website=excluded.business_website,business_address=excluded.business_address,suburb=excluded.suburb,state=excluded.state,postcode=excluded.postcode,country=excluded.country,agent_first_name=excluded.agent_first_name,agent_family_name=excluded.agent_family_name,agent_full_name=excluded.agent_full_name,agent_registration_status=excluded.agent_registration_status,agent_registration_start_date=excluded.agent_registration_start_date,agent_phone=excluded.agent_phone,agent_email=excluded.agent_email,agent_website=excluded.agent_website,omara_contact_id=excluded.omara_contact_id,omara_source_url=excluded.omara_source_url,omara_is_active=excluded.omara_is_active,source=excluded.source,last_checked_at=excluded.last_checked_at,omara_last_synced_at=excluded.omara_last_synced_at,updated_at=excluded.updated_at;
 end loop;
 update public.omara_ingestion_jobs set cursor=p_cursor,processed=processed+jsonb_array_length(p_rows),batches=batches+1,
 status=case when p_error is not null then 'failed' when p_done then 'completed' else 'ready' end,
 error=left(p_error,2000),lease=null,lease_until=null,updated_at=now(),completed_at=case when p_done then now() else null end where id=p_id;
end $$;
revoke all on function public.omara_claim(uuid) from public,anon,authenticated;
revoke all on function public.omara_commit(uuid,uuid,jsonb,jsonb,boolean,text) from public,anon,authenticated;
grant execute on function public.omara_claim(uuid),public.omara_commit(uuid,uuid,jsonb,jsonb,boolean,text) to service_role;

;
