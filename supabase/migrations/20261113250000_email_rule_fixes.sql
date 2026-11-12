-- Email unique within a role: three places that still disagreed with the rule (owner decisions 2026-11-12), and the public
-- staff application telling the email apart from the mobile.
--   a. hr.admin_save_person no longer refuses an HR profile whose email belongs to a CMS user (staff in the CMS and in the
--      HRMS are the same person). The HR-vs-HR duplicate checks stay.
--   b. email_available(..., 'agent', <agent id>): the agent's own business is passed on, so the agent's own pending invite in
--      that business is not "taken". A pending agent invite into another business still is.
--   c. portal_student_find: a student the caller may not start an application for is returned as {"taken": true} only (no
--      id, name, business, agent, counts or match flags). The access rule is find_student_by_email's (20261113230000).
--   d. hr_svc_apply's 'exists' answers say which field ('email' or 'phone'), so staff-register answers "account already
--      exists" for the email only. Nothing else changes in it.
-- (a) and (d) are guarded patches like 20261113240000: each fragment must occur exactly once in this database's definition.

create or replace function pg_temp.email_patch(p_function regprocedure, p_pairs text[]) returns void language plpgsql as $fn$
declare body text := pg_get_functiondef(p_function); pair text[];
begin
  foreach pair slice 1 in array p_pairs loop
    if pair[1] = '' or (length(body) - length(replace(body, pair[1], ''))) / length(pair[1]) <> 1 then
      raise exception 'Unexpected definition of %: expected exactly one "%"', p_function, pair[1];
    end if;
    body := replace(body, pair[1], pair[2]);
  end loop;
  execute body;
end $fn$;

-- a. A CMS user may also have an HR staff profile.
select pg_temp.email_patch('hr.admin_save_person(uuid,jsonb)', array[
  [$a$if exists (select 1 from public.cms_users c where hr.email_key(c.email) = v_email and c.status = 'Active') then raise exception 'This email belongs to an active admin console user.' using errcode = '23505', hint = 'email_taken'; end if;$a$,
   $b$-- A CMS user may also have an HR staff profile (email unique within a role, 20261113250000).$b$]
]);

-- b. The live check knows the agent's own business.
create or replace function public.email_available(p_email text, p_kind text default null, p_ref text default null)
returns jsonb
language plpgsql stable security definer
set search_path = public, hr
as $$
declare v text := lower(btrim(coalesce(p_email,''))); v_hit text; v_kind text; v_table text; v_agency uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('staff','hr_staff','agent','student') then
    raise exception 'p_kind must be staff, hr_staff, agent or student' using errcode = '22023';
  end if;
  if v = '' then return jsonb_build_object('available', false, 'message', 'Enter an email address.'); end if;
  v_kind  := case when p_kind = 'hr_staff' then 'staff' else p_kind end;
  v_table := case p_kind when 'staff' then 'cms_users' when 'hr_staff' then 'staff_profiles'
                         when 'agent' then 'agents' else 'enrollment_students' end;
  -- Editing an agent: their own business, so their own pending invite there is not a conflict.
  if p_kind = 'agent' and p_ref ~ '^[0-9a-f-]{36}$' then
    select g.business_id into v_agency from public.agents g where g.id = p_ref::uuid;
  end if;
  v_hit := public.identity_email_conflict(v, v_kind, v_table, coalesce(p_ref, ''),
             case when p_kind = 'student' and p_ref ~ '^[0-9a-f-]{36}$' then p_ref::uuid end, null, v_agency);
  return jsonb_build_object('available', v_hit is null,
    'message', case when v_hit is null then null else 'This email is already in use. Please use a different email address.' end);
end $$;
revoke all on function public.email_available(text,text,text) from public, anon;
grant execute on function public.email_available(text,text,text) to authenticated;

-- c. Students the caller may not start an application for are only "taken".
create or replace function public.portal_student_find(p_email text default '', p_phone text default '', p_passport text default '') returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_phone text := public.student_phone_key(p_phone);
 v_admin boolean := public.portal_is_slit_admin(); v_self uuid := public.portal_student_id(); v_agency uuid := public.portal_agency_id();
 v_agency_admin boolean := public.portal_is_agency_admin(); v_profile uuid := public.portal_profile_id();
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
 if v_email = '' and v_phone is null then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(case when s.visible then jsonb_build_object(
   'id', s.id, 'name', s.full_name, 'email', coalesce(s.email, ''), 'phone', coalesce(s.phone, ''),
   'dateOfBirth', null, 'passportNumber', '',
   'businessId', a.id, 'businessName', a.name, 'agentId', g.id, 'agentName', coalesce(g.full_name, ''),
   'applications', (select count(*) from public.enrollment_applications e where e.student_id = s.id),
   'emailMatch', v_email <> '' and lower(btrim(coalesce(s.email, ''))) = v_email,
   'phoneMatch', v_phone is not null and public.student_phone_key(s.phone) = v_phone,
   'passportMatch', false
  ) else jsonb_build_object('taken', true) end order by s.updated_at desc)
  from (
   select x.*, (v_admin or x.id = v_self or (v_self is null and v_agency is not null and x.agency_id = v_agency
     and (v_agency_admin or (v_profile is not null and exists (select 1 from public.agents y where y.id = x.agent_id and y.profile_id = v_profile))))) as visible
   from public.enrollment_students x
   where (v_email <> '' and lower(btrim(coalesce(x.email, ''))) = v_email) or (v_phone is not null and public.student_phone_key(x.phone) = v_phone)
   order by x.updated_at desc limit 10
  ) s
  left join public.agencies a on a.id = s.agency_id
  left join public.agents g on g.id = s.agent_id), '[]'::jsonb);
end $fn$;
revoke all on function public.portal_student_find(text, text, text) from public, anon;
grant execute on function public.portal_student_find(text, text, text) to authenticated;

-- d. Which field 'exists' is about (the answer and the 'already_applied' mail are otherwise unchanged).
select pg_temp.email_patch('public.hr_svc_apply(text,text,text,text,uuid,text)', array[
  [$a$and c.status = 'Active') then return jsonb_build_object('ok', false, 'reason', 'exists'); end if;$a$,
   $b$and c.status = 'Active') then return jsonb_build_object('ok', false, 'reason', 'exists', 'field', 'email'); end if;$b$],
  [$a$and s.id is distinct from p.id) then return jsonb_build_object('ok', false, 'reason', 'exists'); end if;$a$,
   $b$and s.id is distinct from p.id) then return jsonb_build_object('ok', false, 'reason', 'exists', 'field', 'phone'); end if;$b$],
  [$a$return jsonb_build_object('ok', false, 'reason', 'exists');$a$,
   $b$return jsonb_build_object('ok', false, 'reason', 'exists', 'field', 'email');$b$]
]);
