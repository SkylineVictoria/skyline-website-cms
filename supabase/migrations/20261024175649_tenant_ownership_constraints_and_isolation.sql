-- P02-07: evidence decisions only. This migration assigns NO application row.
-- Policy/constraint enforcement and applying reviewed mappings belong to P02-08.
create table public.tenant_ownership_decisions(
 id uuid primary key default gen_random_uuid(),table_name text not null,record_key text not null,
 tenant_id uuid references public.tenants(id),status text not null check(status in ('unresolved','proposed','approved','applied')),
 evidence text not null,observed_hash text not null,proposed_by uuid not null references auth.users(id),reviewed_by uuid references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),reviewed_at timestamptz,applied_at timestamptz,
 unique(table_name,record_key),check(status='unresolved' or (tenant_id is not null and length(trim(evidence))>0))
);
alter table public.tenant_ownership_decisions enable row level security;
revoke all on public.tenant_ownership_decisions from public,anon,authenticated,service_role;
grant select on public.tenant_ownership_decisions to authenticated,service_role;
create policy tenant_ownership_review_read on public.tenant_ownership_decisions for select to authenticated using(public.tenant_is_platform_admin());
create function public.tenant_propose_ownership(p_table text,p_key text,p_tenant uuid,p_evidence text) returns uuid language plpgsql security definer set search_path=public as $$
declare fingerprint text; result uuid;
begin
 if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode='42501'; end if;
 if p_table<>all(array['cms_settings','cms_courses','cms_pages','cms_forms','cms_documents','cms_navigation_items','cms_footer','cms_seo','enrollment_applications','public_assistant_faqs']) then raise exception 'Unsupported ownership root' using errcode='22023'; end if;
 if p_tenant is not null and (not public.tenant_has_role(p_tenant) or nullif(trim(p_evidence),'') is null) then raise exception 'Evidence and active tenant required' using errcode='22023'; end if;
 execute format('select md5((to_jsonb(r)-''tenant_id'')::text) from public.%I r where id::text=$1',p_table) into fingerprint using p_key;
 if fingerprint is null then raise exception 'Ownership record not found' using errcode='22023'; end if;
 insert into public.tenant_ownership_decisions(table_name,record_key,tenant_id,status,evidence,observed_hash,proposed_by)
 values(p_table,p_key,p_tenant,case when p_tenant is null then 'unresolved' else 'proposed' end,coalesce(p_evidence,''),fingerprint,auth.uid()) returning id into result;
 insert into public.tenant_access_audit(tenant_id,actor,action,target,details) values(p_tenant,auth.uid(),'ownership_proposed',result,jsonb_build_object('table',p_table,'key',p_key));return result;
end; $$;
create function public.tenant_approve_ownership(p_decision uuid) returns void language plpgsql security definer set search_path=public as $$
declare d public.tenant_ownership_decisions; fingerprint text;
begin
 if not public.tenant_is_platform_admin() then raise exception 'Platform authorization required' using errcode='42501'; end if;
 select * into d from public.tenant_ownership_decisions where id=p_decision for update;
 if not found or d.status<>'proposed' or d.tenant_id is null then raise exception 'Explicit proposed ownership required' using errcode='22023'; end if;
 execute format('select md5((to_jsonb(r)-''tenant_id'')::text) from public.%I r where id::text=$1',d.table_name) into fingerprint using d.record_key;
 if fingerprint is distinct from d.observed_hash then raise exception 'Ownership evidence changed; review again' using errcode='40001'; end if;
 update public.tenant_ownership_decisions set status='approved',reviewed_by=auth.uid(),reviewed_at=clock_timestamp() where id=p_decision;
 insert into public.tenant_access_audit(tenant_id,actor,action,target) values(d.tenant_id,auth.uid(),'ownership_approved',d.id);
end; $$;
revoke all on function public.tenant_propose_ownership(text,text,uuid,text),public.tenant_approve_ownership(uuid) from public,anon,authenticated,service_role;
grant execute on function public.tenant_propose_ownership(text,text,uuid,text),public.tenant_approve_ownership(uuid) to authenticated;
