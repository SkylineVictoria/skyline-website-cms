-- STUDENT-NEW-APPLICATION-AGENT (owner, 2026-11-26: a student starting a new application is asked "Are you working with an agent?";
-- Yes = their agent preselected, another agent of the same business can be chosen; owner chose "same business only": a
-- different business, or applying without an agent while with a business, goes through SLIT Administration):
--   * portal_student_agency_options also returns the student's current business / agent ('current') and, for a student with a
--     business, that business's active agents;
--   * portal_student_change_agent(agent): the signed-in student picks another active agent of their own business (the record's
--     agent; new applications are assigned to them), audited student_changed_agent.
-- Down: drop function public.portal_student_change_agent(uuid); restore portal_student_agency_options from 20261105160000.
begin;

create or replace function public.portal_student_agency_options(p_business uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_student uuid := public.portal_student_id(); s public.enrollment_students; v_ask boolean := false; v_direct boolean := true;
 v_has_apps boolean := false; v_business uuid;
begin
 if v_student is null then raise exception 'Only a signed-in student can do this' using errcode = '42501'; end if;
 select * into s from public.enrollment_students where id = v_student;
 if s.id is not null then
  v_direct := coalesce((select a.is_direct from public.agencies a where a.id = s.agency_id), true);
  v_has_apps := exists (select 1 from public.enrollment_applications e where e.student_id = s.id);
  v_ask := v_direct and not v_has_apps;
 end if;
 -- The agents listed: the chosen business (a direct student with no application yet), else the student's own business.
 v_business := case when p_business is not null and v_ask then p_business when not v_direct then s.agency_id end;
 return jsonb_build_object(
  'ask', v_ask,
  'current', jsonb_build_object('businessId', s.agency_id, 'businessName', (select a.name from public.agencies a where a.id = s.agency_id),
    'direct', v_direct, 'agentId', s.agent_id, 'agentName', (select g.full_name from public.agents g where g.id = s.agent_id),
    'hasApplications', v_has_apps),
  'businesses', case when v_ask then coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) order by lower(a.name), a.id)
    from public.agencies a where a.status = 'Active' and not a.is_direct), '[]'::jsonb) else '[]'::jsonb end,
  'agents', case when v_business is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.full_name, 'role', g.role) order by lower(g.full_name), g.id)
    from public.agents g join public.agencies a on a.id = g.business_id
    where g.business_id = v_business and g.status = 'Active' and a.status = 'Active' and not a.is_direct), '[]'::jsonb) end);
end $$;
revoke all on function public.portal_student_agency_options(uuid) from public, anon;
grant execute on function public.portal_student_agency_options(uuid) to authenticated;

create or replace function public.portal_student_change_agent(p_agent uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_student uuid := public.portal_student_id(); s public.enrollment_students; g public.agents; p public.portal_profiles;
begin
 if v_student is null then raise exception 'Only a signed-in student can do this' using errcode = '42501'; end if;
 select * into s from public.enrollment_students where id = v_student for update;
 if not found then raise exception 'Student not found' using errcode = 'P0002'; end if;
 if coalesce((select a.is_direct from public.agencies a where a.id = s.agency_id), true) then
  raise exception 'You are not recorded with an agency. Choose the business and agent instead.' using errcode = '42501'; end if;
 select * into g from public.agents where id = p_agent;
 if not found or g.business_id is distinct from s.agency_id or g.status <> 'Active' then
  raise exception 'Choose an active agent of your agency. To change agency, ask SLIT Administration.' using errcode = '22023'; end if;
 if g.id is distinct from s.agent_id then
  update public.enrollment_students set agent_id = g.id where id = s.id;
  select * into p from public.portal_profiles where id = public.portal_profile_id();
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
   values (auth.uid(), coalesce(p.full_name, s.full_name, ''), 'student', 'student_changed_agent', 'student', s.id::text, s.agency_id,
    jsonb_build_object('fromAgentId', s.agent_id, 'agentId', g.id, 'agent', g.full_name));
 end if;
 return jsonb_build_object('agentId', g.id, 'agentName', g.full_name);
end $$;
revoke all on function public.portal_student_change_agent(uuid) from public, anon;
grant execute on function public.portal_student_change_agent(uuid) to authenticated;

commit;
