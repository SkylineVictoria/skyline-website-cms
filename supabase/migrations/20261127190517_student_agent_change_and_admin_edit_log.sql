-- STUDENT-AGENT-CHANGE + ADMIN-EDIT-LOG (owner 2026-11-27). Hosted recorded 20261127030517 (student_new_application_agent) and
-- 20261127010517 (admin_edits_submitted_application) without their SQL taking effect (no portal_student_change_agent; portal_lock_draft
-- still refused SLIT admins on Submitted). Applied properly here, with the definitions the repo files give (as a fresh lab has them):
--  * public.portal_student_agency_options / public.portal_student_change_agent: a student's New application asks "Are you working
--    with an agent?" and may pick another active agent of their own business (unchanged from 20261127030517).
--  * public.portal_lock_draft: a SLIT admin may correct a Submitted / Under review application (students and agents still only Draft /
--    Action required); each such save is in portal_audit_log as before, and now every changed answer is logged with who, when, the
--    old and the new value (public.application_admin_changes: the application's answers, the student's answers, the course / intake).
-- Additive. Down: drop the log table, triggers and functions; restore portal_lock_draft from 20261025153802.

CREATE OR REPLACE FUNCTION public.portal_student_agency_options(p_business uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
revoke all on function public.portal_student_agency_options(uuid) from public, anon;
grant execute on function public.portal_student_agency_options(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.portal_student_change_agent(p_agent uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
revoke all on function public.portal_student_change_agent(uuid) from public, anon;
grant execute on function public.portal_student_change_agent(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.portal_lock_draft(p_application_id uuid, p_expected_version bigint)
 RETURNS enrollment_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications;
begin
 select * into a from public.enrollment_applications where id=p_application_id for update;
 if auth.uid() is null or not public.portal_can_access_application(a.id)
   or (a.status not in ('draft','action_required') and not (a.status in ('submitted','under_review') and public.portal_is_slit_admin())) then
  raise exception 'Application is not editable' using errcode='42501'; end if;
 if a.status in ('submitted','under_review') then
  insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, agency_id, tenant_id, detail)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', 'Administrator'), 'administrator', 'application_edited_after_submit', 'application',
    a.id::text, a.id, a.agency_id, a.tenant_id, jsonb_build_object('status', a.status, 'version', a.draft_version));
  -- ADMIN-EDIT-LOG: every answer this edit changes is logged (application_admin_changes)
  perform set_config('portal.admin_edit_after_submit', a.id::text, true);
 end if;
 if not public.application_student_active(a.id) then
  raise exception 'This student is disabled, so their applications are locked' using errcode='42501'; end if;
 -- APPLICATION-STUDENT-SIGNS: the agent is view-only while the student has it; the student while it is back with the agent.
 if skyline_private.handoff_blocks_edit(a.id) then
  raise exception '%', case when skyline_private.is_application_student(a.id)
    then 'Your agent has this application at the moment, so it is view-only'
    else 'The student has this application at the moment, so it is view-only. Take it back to edit it' end using errcode='42501';
 end if;
 if a.draft_version is distinct from p_expected_version then
  raise exception 'Another session changed this application. Reload before saving; your unsaved values remain on this page.' using errcode='PT409'; end if;
 perform set_config('portal.draft_command',a.id::text,true);
 return a;
end; $function$;

-- ---------------------------------------------------------------- the change log of admin edits after submission
create table public.application_admin_changes (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.enrollment_applications(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete restrict,
  source text not null check (source in ('application', 'student', 'course')),
  field text not null check (char_length(field) between 1 and 200),
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  changed_by_name text not null default '',
  changed_at timestamptz not null default clock_timestamp()
);
create index application_admin_changes_app on public.application_admin_changes(application_id, changed_at);
alter table public.application_admin_changes enable row level security;
revoke all on public.application_admin_changes from public, anon, authenticated;
comment on table public.application_admin_changes is 'ADMIN-EDIT-LOG: every answer a SLIT admin changed on a Submitted / Under review application (who, when, old and new value); append-only.';

create or replace function public.application_admin_changes_append_only() returns trigger language plpgsql as $$
begin raise exception 'The admin change log is append-only.' using errcode = '42501'; end $$;
create trigger application_admin_changes_append_only before update or delete on public.application_admin_changes
  for each row execute function public.application_admin_changes_append_only();

-- who is editing (the admin's name from cms_users, else the sign-in email)
create or replace function public.application_admin_change_actor() returns text language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(btrim(u.name), '') from public.cms_users u where u.auth_user_id = auth.uid() limit 1), auth.jwt() ->> 'email', 'Administrator')
$$;
revoke all on function public.application_admin_change_actor() from public, anon, authenticated;

create or replace function public.application_admin_log_diff(p_app uuid, p_source text, p_old jsonb, p_new jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  for k in select key from jsonb_each(coalesce(p_old, '{}'::jsonb)) union select key from jsonb_each(coalesce(p_new, '{}'::jsonb)) loop
    if (p_old -> k) is distinct from (p_new -> k) then
      insert into public.application_admin_changes(application_id, tenant_id, source, field, old_value, new_value, changed_by, changed_by_name)
      values (p_app, (select tenant_id from public.enrollment_applications where id = p_app), p_source, left(k, 200), p_old -> k, p_new -> k, auth.uid(), public.application_admin_change_actor());
    end if;
  end loop;
end $$;
revoke all on function public.application_admin_log_diff(uuid, text, jsonb, jsonb) from public, anon, authenticated;

-- the application's own answers
create or replace function public.application_admin_log_application() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('portal.admin_edit_after_submit', true) = new.id::text then
    perform public.application_admin_log_diff(new.id, 'application', old.data -> 'values', new.data -> 'values');
  end if;
  return null;
end $$;
revoke all on function public.application_admin_log_application() from public, anon, authenticated;
create trigger zz_application_admin_log after update of data on public.enrollment_applications
  for each row execute function public.application_admin_log_application();

-- the student's own answers (stored on the student since STUDENT-OWNS-ANSWERS), during that admin's edit of the application
create or replace function public.application_admin_log_student() returns trigger language plpgsql security definer set search_path = public as $$
declare v_app uuid;
begin
  v_app := nullif(current_setting('portal.admin_edit_after_submit', true), '')::uuid;
  if v_app is not null and exists (select 1 from public.enrollment_applications a where a.id = v_app and a.student_id = new.id) then
    perform public.application_admin_log_diff(v_app, 'student', old.details, new.details);
  end if;
  return null;
end $$;
revoke all on function public.application_admin_log_student() from public, anon, authenticated;
create trigger zz_student_admin_log after update of details on public.enrollment_students
  for each row execute function public.application_admin_log_student();

-- the course and intake chosen
create or replace function public.application_admin_log_course() returns trigger language plpgsql security definer set search_path = public as $$
declare v_app uuid := coalesce(new.application_id, old.application_id);
begin
  if current_setting('portal.admin_edit_after_submit', true) = v_app::text then
    perform public.application_admin_log_diff(v_app, 'course',
      case when tg_op = 'INSERT' then '{}'::jsonb else jsonb_build_object('course ' || coalesce(old.course_code, ''), jsonb_build_object('course', old.course_code, 'intake', old.intake_id)) end,
      case when tg_op = 'DELETE' then '{}'::jsonb else jsonb_build_object('course ' || coalesce(new.course_code, ''), jsonb_build_object('course', new.course_code, 'intake', new.intake_id)) end);
  end if;
  return null;
end $$;
revoke all on function public.application_admin_log_course() from public, anon, authenticated;
create trigger zz_course_admin_log after insert or update or delete on public.enrollment_application_courses
  for each row execute function public.application_admin_log_course();

-- the log of an application (SLIT admins)
create or replace function public.application_admin_changes_list(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.portal_is_slit_admin() then raise exception 'Only SLIT administrators can read this log.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('field', c.field, 'source', c.source, 'old', c.old_value, 'new', c.new_value,
    'by', c.changed_by_name, 'byId', c.changed_by, 'at', c.changed_at) order by c.changed_at, c.id)
    from public.application_admin_changes c where c.application_id = p_application), '[]'::jsonb);
end $$;
revoke all on function public.application_admin_changes_list(uuid) from public, anon;
grant execute on function public.application_admin_changes_list(uuid) to authenticated;
