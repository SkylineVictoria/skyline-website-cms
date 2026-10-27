create function public.portal_query_applications(p_search text default '',p_status text default '',p_agency uuid default null,p_agent uuid default null,
 p_course text default '',p_intake text default '',p_sort text default 'updated',p_direction text default 'desc',p_limit integer default 25,p_offset integer default 0) returns jsonb
language plpgsql stable security invoker set search_path=public as $$
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
  from public.enrollment_applications a left join public.agencies g on g.id=a.agency_id left join public.portal_profiles p on p.id=a.assigned_agent_id
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

create function public.portal_dashboard() returns jsonb language sql stable security invoker set search_path=public as $$
 with visible as materialized(select a.* from public.enrollment_applications a where auth.uid() is not null),
 counts as(select status,count(*) n from visible group by status),
 agents as(select assigned_agent_id id,status,count(*) n from visible group by assigned_agent_id,status),
 agencies as(select agency_id id,status,count(*) n from visible group by agency_id,status)
 select jsonb_build_object('total',(select count(*) from visible),'statuses',coalesce((select jsonb_object_agg(status,n) from counts),'{}'),
 'byAgent',coalesce((select jsonb_agg(r) from (select ag.id,coalesce((select p.full_name from public.portal_profiles p where p.id=ag.id),'Unassigned') name,sum(n) total,jsonb_object_agg(status,n) statuses from agents ag group by ag.id)r),'[]'),
 'byAgency',coalesce((select jsonb_agg(r) from (select ag.id,coalesce((select a.name from public.agencies a where a.id=ag.id),'Agency') name,sum(n) total,jsonb_object_agg(status,n) statuses from agencies ag group by ag.id)r),'[]'));
$$;
revoke all on function public.portal_dashboard() from public,anon,authenticated,service_role;
grant execute on function public.portal_dashboard() to authenticated;

-- Recipient-only notifications and immutable actor/history evidence.
create policy portal_recipient_only on public.portal_notifications as restrictive for select to authenticated
using(recipient=auth.uid() and (application_id is null or public.portal_can_access_application(application_id)));
create policy portal_recipient_update on public.portal_notifications as restrictive for update to authenticated
using(recipient=auth.uid() and (application_id is null or public.portal_can_access_application(application_id)))
with check(recipient=auth.uid());
do $$ declare tab text; begin
 foreach tab in array array['enrollment_application_versions','enrollment_application_status_history','portal_audit_log'] loop
  execute format('create policy phase4_immutable_insert on public.%I as restrictive for insert to authenticated with check(false)',tab);
  execute format('create policy phase4_immutable_update on public.%I as restrictive for update to authenticated using(false) with check(false)',tab);
  execute format('create policy phase4_immutable_delete on public.%I as restrictive for delete to authenticated using(false)',tab);
 end loop;
end; $$;

create function public.portal_course_command_only() returns trigger language plpgsql security definer set search_path=public as $$
declare app uuid;
begin
 app:=case when tg_op='DELETE' then old.application_id else new.application_id end;
 if auth.uid() is not null and current_setting('portal.draft_command',true) is distinct from app::text then
  raise exception 'Use the versioned draft command for courses' using errcode='42501'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end; $$;
revoke all on function public.portal_course_command_only() from public;
create trigger portal_course_command_only before insert or update or delete on public.enrollment_application_courses for each row execute function public.portal_course_command_only();
