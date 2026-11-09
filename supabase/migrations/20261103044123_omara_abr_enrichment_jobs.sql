create table public.omara_abr_jobs (
 id uuid primary key default gen_random_uuid(),
 status text not null default 'waiting_for_credentials' check(status in ('waiting_for_credentials','ready','running','failed','completed','paused')),
 lease uuid,lease_until timestamptz,error text,processed integer not null default 0,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),completed_at timestamptz
);
create table public.omara_abr_items (
 id bigint generated always as identity primary key,job_id uuid not null references public.omara_abr_jobs(id),
 business_name text not null,normalized_name text not null,state text not null default '',postcode text not null default '',country text not null default '',
 target_ids uuid[] not null,status text not null default 'pending' check(status in ('pending','matched','needs_review','no_match','skipped')),
 result jsonb,candidates jsonb,reason text,updated_at timestamptz not null default now(),
 unique(job_id,normalized_name,state,postcode,country)
);
create index omara_abr_items_pending on public.omara_abr_items(job_id,id) where status='pending';
alter table public.omara_abr_jobs enable row level security;
alter table public.omara_abr_items enable row level security;
revoke all on public.omara_abr_jobs,public.omara_abr_items from anon,authenticated;
grant all on public.omara_abr_jobs,public.omara_abr_items to service_role;
grant usage,select on sequence public.omara_abr_items_id_seq to service_role;

create function public.omara_abr_wait(p_id uuid) returns void language sql security invoker set search_path='' as $$
 update public.omara_abr_jobs set status='waiting_for_credentials',error='Set Supabase Edge Function secret ABR_AUTH_GUID before activation',updated_at=now()
 where id=p_id and status not in ('running','completed','paused');
$$;
create function public.omara_abr_claim(p_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.omara_abr_jobs; items jsonb;
begin
 update public.omara_abr_jobs set status='running',lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',error=null,updated_at=now()
 where id=p_id and status in ('ready','waiting_for_credentials','running','failed') and (lease_until is null or lease_until<now()) returning * into j;
 if j.id is null then return null; end if;
 -- Snapshot eligible records once, on first activation. One request group per business name and location.
 if not exists(select 1 from public.omara_abr_items where job_id=p_id) then
 insert into public.omara_abr_items(job_id,business_name,normalized_name,state,postcode,country,target_ids)
 select p_id,min(business_name),normalized_business_name,coalesce(state,''),coalesce(postcode,''),coalesce(country,''),array_agg(id)
 from public.omara_business_directory where source='OMARA' and business_name is not null and normalized_business_name is not null
 and normalized_business_name<>'' and abn is null and abr_match_status is null
 group by normalized_business_name,coalesce(state,''),coalesce(postcode,''),coalesce(country,'');
 end if;
 select coalesce(jsonb_agg(i),'[]'::jsonb) into items from (select * from public.omara_abr_items where job_id=p_id and status='pending' order by id limit 25) i;
 return jsonb_build_object('id',j.id,'lease',j.lease,'items',items);
end $$;

create function public.omara_abr_commit_item(p_id uuid,p_lease uuid,p_item bigint,p_status text,p_result jsonb,p_candidates jsonb,p_reason text)
returns integer language plpgsql security invoker set search_path='' as $$
declare i public.omara_abr_items; affected integer:=0;
begin
 perform 1 from public.omara_abr_jobs where id=p_id and lease=p_lease and status='running' for update;
 if not found then raise exception 'Lease lost';end if;
 select * into i from public.omara_abr_items where id=p_item and job_id=p_id and status='pending' for update;
 if not found then return 0;end if;
 if p_status not in ('matched','needs_review','no_match','skipped') then raise exception 'Invalid result';end if;
 if p_status='matched' and (p_result->>'abn' is null or p_result->>'abn' !~ '^[0-9]{11}$' or p_result->>'abr_source_url' is distinct from 'https://abr.business.gov.au/ABN/View?abn='||(p_result->>'abn')) then raise exception 'Invalid ABR identity';end if;
 -- Only enrich rows whose original OMARA business and location still match the snapshot.
 if p_status='matched' then
 update public.omara_business_directory d set
 abn=p_result->>'abn',acn=p_result->>'acn',legal_entity_name=p_result->>'legal_entity_name',entity_type=p_result->>'entity_type',
 abn_status=p_result->>'abn_status',abn_status_effective_from=(p_result->>'abn_status_effective_from')::date,
 gst_status=p_result->>'gst_status',gst_effective_from=(p_result->>'gst_effective_from')::date,
 abr_source_url=p_result->>'abr_source_url',abr_match_status='matched_exact_name_location',
 abr_match_score=(p_result->>'abr_match_score')::numeric,abr_matched_name=p_result->>'abr_matched_name',abr_last_synced_at=now(),updated_at=now()
 where d.id=any(i.target_ids) and d.abn is null and d.abr_match_status is null
 and d.normalized_business_name=i.normalized_name and coalesce(d.state,'')=i.state and coalesce(d.postcode,'')=i.postcode and coalesce(d.country,'')=i.country;
 else
 update public.omara_business_directory d set abr_match_status=p_status,abr_last_synced_at=now(),updated_at=now()
 where d.id=any(i.target_ids) and d.abn is null and d.abr_match_status is null
 and d.normalized_business_name=i.normalized_name and coalesce(d.state,'')=i.state and coalesce(d.postcode,'')=i.postcode and coalesce(d.country,'')=i.country;
 end if;
 get diagnostics affected=row_count;
 update public.omara_abr_items set status=p_status,result=p_result,candidates=p_candidates,reason=left(p_reason,1000),updated_at=now() where id=i.id;
 update public.omara_abr_jobs set processed=processed+1,updated_at=now() where id=p_id;
 return affected;
end $$;
create function public.omara_abr_release(p_id uuid,p_lease uuid,p_error text default null) returns text language plpgsql security invoker set search_path='' as $$
declare next_status text;
begin
 next_status:=case when p_error is not null then 'failed' when exists(select 1 from public.omara_abr_items where job_id=p_id and status='pending') then 'ready' else 'completed' end;
 update public.omara_abr_jobs set status=next_status,lease=null,lease_until=null,error=left(p_error,1500),updated_at=now(),completed_at=case when next_status='completed' then now() else null end
 where id=p_id and lease=p_lease and status='running';
 if not found then return 'lease_lost';end if;return next_status;
end $$;
revoke all on function public.omara_abr_wait(uuid),public.omara_abr_claim(uuid),public.omara_abr_commit_item(uuid,uuid,bigint,text,jsonb,jsonb,text),public.omara_abr_release(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.omara_abr_wait(uuid),public.omara_abr_claim(uuid),public.omara_abr_commit_item(uuid,uuid,bigint,text,jsonb,jsonb,text),public.omara_abr_release(uuid,uuid,text) to service_role;

;
