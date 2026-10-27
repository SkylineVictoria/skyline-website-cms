-- Resolve live authorization once per query, then apply the same row predicate.
-- No caller-supplied UUID selects a tenant or grants authority.
create function public.portal_scoped_applications() returns setof public.enrollment_applications
language plpgsql stable security definer set search_path=public as $$
declare t uuid:=public.tenant_current(); agency uuid:=public.portal_agency_id(); profile uuid:=public.portal_profile_id();
 reviewer boolean; agency_admin boolean; access boolean;
begin
 if auth.uid() is null then return; end if;
 if public.tenant_request_domain() is null then
  if not public.tenant_scope(null) then return; end if;
  return query select a.* from public.enrollment_applications a where a.tenant_id is null and skyline_private.legacy_application_access(a.id);
 elsif t is not null then
  reviewer:=public.tenant_has_role(t,array['tenant_admin','staff']);
  agency_admin:=public.portal_is_agency_admin();access:=public.tenant_agency_access(t,agency);
  return query select a.* from public.enrollment_applications a where a.tenant_id=t and
   (reviewer or access and a.agency_id=agency and (agency_admin or a.assigned_agent_id=profile));
 end if;
end; $$;
revoke all on function public.portal_scoped_applications() from public,anon,authenticated,service_role;
grant execute on function public.portal_scoped_applications() to authenticated;

grant execute on function public.portal_identity() to anon;

create or replace function public.portal_query_applications(p_search text default '',p_status text default '',p_agency uuid default null,p_agent uuid default null,
 p_course text default '',p_intake text default '',p_sort text default 'updated',p_direction text default 'desc',p_limit integer default 25,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare result jsonb; sort_column text;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 sort_column:=case p_sort when 'reference' then 'reference' when 'student' then 'student_name' when 'agency' then 'agency_name' when 'agent' then 'agent_name' when 'status' then 'status' when 'completion' then 'completion' when 'created' then 'created_at' else 'updated_at' end;
 if p_direction not in ('asc','desc') or p_limit not between 1 and 100 or p_offset<0 or length(p_search)>200 then raise exception 'Invalid page request' using errcode='22023'; end if;
 execute format($query$
 with filtered as materialized (
  select a.id,a.reference,a.status,a.student_name,a.student_email,a.intake,a.completion,a.agency_id,a.assigned_agent_id,
  a.created_at,a.updated_at,a.submitted_at,a.is_test,coalesce(g.name,'') agency_name,coalesce(p.full_name,'') agent_name,
  (select coalesce(jsonb_agg(jsonb_build_object('courseId',c.course_id,'code',c.course_code,'title',c.course_title,'variant',c.variant)),'[]') from public.enrollment_application_courses c where c.application_id=a.id) courses
  from public.portal_scoped_applications() a left join public.agencies g on g.id=a.agency_id left join public.portal_profiles p on p.id=a.assigned_agent_id
  where ($1='' or position(lower($1) in lower(concat_ws(' ',a.student_name,a.student_email,a.reference)))>0)
  and ($2='' or a.status=$2) and ($3 is null or a.agency_id=$3) and ($4 is null or a.assigned_agent_id=$4)
  and ($5='' or exists(select 1 from public.enrollment_application_courses c where c.application_id=a.id and c.course_code=$5))
  and ($6='' or position(lower($6) in lower(a.intake))>0)
 ), page as (select * from filtered order by %I %s,id asc limit $7 offset $8)
 select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'))
 $query$,sort_column,p_direction) into result using p_search,p_status,p_agency,p_agent,p_course,p_intake,p_limit,p_offset;
 return result;
end; $$;
revoke all on function public.portal_query_applications(text,text,uuid,uuid,text,text,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.portal_query_applications(text,text,uuid,uuid,text,text,text,text,integer,integer) to authenticated;

create or replace function public.portal_dashboard() returns jsonb language sql stable security definer set search_path=public as $$
 with visible as materialized(select a.* from public.portal_scoped_applications() a where auth.uid() is not null),
 counts as(select status,count(*) n from visible group by status),
 agents as(select assigned_agent_id id,status,count(*) n from visible group by assigned_agent_id,status),
 agencies as(select agency_id id,status,count(*) n from visible group by agency_id,status)
 select jsonb_build_object('total',(select count(*) from visible),'statuses',coalesce((select jsonb_object_agg(status,n) from counts),'{}'),
 'byAgent',coalesce((select jsonb_agg(r) from (select ag.id,coalesce((select p.full_name from public.portal_profiles p where p.id=ag.id),'Unassigned') name,sum(n) total,jsonb_object_agg(status,n) statuses from agents ag group by ag.id)r),'[]'),
 'byAgency',coalesce((select jsonb_agg(r) from (select ag.id,coalesce((select a.name from public.agencies a where a.id=ag.id),'Agency') name,sum(n) total,jsonb_object_agg(status,n) statuses from agencies ag group by ag.id)r),'[]'));
$$;
revoke all on function public.portal_dashboard() from public,anon,authenticated,service_role;
grant execute on function public.portal_dashboard() to authenticated;


create or replace function public.portal_protect_admission_state() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is not null and current_setting('role',true)='authenticated' then
  if tg_op='INSERT' then
   if new.status<>'draft' then raise exception 'New applications must start as drafts' using errcode='42501'; end if;
  elsif new.status is distinct from old.status or new.submitted_by is distinct from old.submitted_by or new.submitted_at is distinct from old.submitted_at or new.version is distinct from old.version then
   if current_setting('portal.status_command',true) is distinct from new.id::text then raise exception 'Use the admissions status command' using errcode='42501'; end if;
  end if;
 end if;
 return new;
end; $$;

create or replace function public.portal_claim_tenant_document_job(p_job uuid,p_tenant uuid) returns setof public.enrollment_document_extraction_jobs
language plpgsql security definer set search_path=public as $$
declare j public.enrollment_document_extraction_jobs;
begin
 if p_tenant is null or not exists(select 1 from public.tenants where id=p_tenant and status='active') then return; end if;
 select * into j from public.enrollment_document_extraction_jobs where id=p_job and tenant_id=p_tenant and attempt_count<3 and
 ((state='queued' and next_attempt_at<=now()) or (state='processing' and lease_expires_at<now())) for update skip locked;
 if not found or not exists(select 1 from public.enrollment_application_documents d join public.enrollment_applications a on a.id=d.application_id
  where d.id=j.document_id and d.application_id=j.application_id and d.tenant_id=p_tenant and a.tenant_id=p_tenant and d.is_current and a.status in ('draft','action_required')) then return; end if;
 update public.enrollment_document_extraction_jobs set state='processing',attempt_count=attempt_count+1,started_at=now(),updated_at=now(),
 lease_expires_at=now()+interval '4 minutes',lease_token=gen_random_uuid() where id=j.id returning * into j;
 update public.enrollment_application_documents set metadata=jsonb_set(metadata,'{extraction}',coalesce(metadata->'extraction','{}')||
 jsonb_build_object('status',case when metadata#>>'{extraction,status}'='confirmed' then 'confirmed' else 'processing' end),true) where id=j.document_id and tenant_id=p_tenant;
 return next j;
end; $$;
revoke all on function public.portal_claim_tenant_document_job(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.portal_claim_tenant_document_job(uuid,uuid) to service_role;

