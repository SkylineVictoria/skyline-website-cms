-- Rule change: an email is unique WITHIN a role, not across roles.
-- One person may be a student, a staff member and an agent/agency admin with the same email,
-- but there can't be two students, two agents (agent + agency_admin = one role) or two staff records with one email.

drop function if exists public.identity_email_conflict(text,text,text,text,uuid,uuid);

create or replace function public.identity_email_conflict(
  p_email text, p_kind text, p_table text, p_ref text,
  p_student uuid default null, p_student_profile uuid default null, p_agency uuid default null)
returns text
language sql stable security definer
set search_path = public, hr
as $$
  with o(kind, tbl, ref, sp, stu, agency) as (
    select 'staff', 'cms_users', id::text, null::text, null::uuid, null::uuid from public.cms_users where lower(btrim(email)) = p_email
    union all select 'staff', 'staff_profiles', id::text, null, null, null from hr.staff_profiles where lower(btrim(email)) = p_email
    union all select 'agent', 'agents', id::text, null, null, business_id from public.agents where lower(btrim(email)) = p_email
    union all select 'student', 'enrollment_students', id::text, student_profile_id::text, id, agency_id from public.enrollment_students where lower(btrim(email)) = p_email
    union all select 'student', 'student_profiles', id::text, null, null, null from public.student_profiles where lower(btrim(email)) = p_email
    union all select case when role = 'student' then 'student' else 'agent' end, 'agency_invitations', id::text, null, student_id, agency_id
      from public.agency_invitations
      where lower(btrim(email)) = p_email and status = 'pending' and (expires_at is null or expires_at > now())
  )
  select o.kind from o
  where o.kind = p_kind and o.ref <> coalesce(p_ref, '') and (
        -- staff: another row in the same staff table (a CMS admin who also has an HR profile is fine)
        (p_kind = 'staff' and o.tbl = p_table)
        -- agent: another agent record (any agency)
     or (p_kind = 'agent' and p_table = 'agents' and o.tbl = 'agents')
        -- agent: a pending agent invite into a different agency
     or (p_kind = 'agent' and p_table = 'agents' and o.tbl = 'agency_invitations' and o.agency is distinct from p_agency)
        -- agent invite: already an agent, or invited, in a different agency
     or (p_kind = 'agent' and p_table = 'agency_invitations' and o.tbl in ('agents','agency_invitations') and o.agency is distinct from p_agency)
        -- student record / student invite: a different student record
     or (p_kind = 'student' and p_table in ('enrollment_students','agency_invitations') and o.tbl = 'enrollment_students' and o.stu is distinct from p_student)
        -- a different self-service student profile
     or (p_kind = 'student' and o.tbl = 'student_profiles' and p_student_profile is not null and o.ref <> p_student_profile::text)
        -- student profile vs a student record already linked to another profile
     or (p_kind = 'student' and p_table = 'student_profiles' and o.tbl = 'enrollment_students' and o.sp is not null and o.sp <> p_ref)
        -- student invite: another pending invite for a different student
     or (p_kind = 'student' and p_table = 'agency_invitations' and o.tbl = 'agency_invitations' and o.stu is distinct from p_student)
  )
  limit 1
$$;

create or replace function public.identity_email_guard()
returns trigger
language plpgsql security definer
set search_path = public, hr
as $$
declare
  n jsonb := to_jsonb(new); o jsonb;
  v_new text; v_kind text; v_student uuid; v_sp uuid; v_agency uuid; v_hit text; v_label text;
begin
  v_new := lower(btrim(coalesce(n->>'email', '')));
  if v_new = '' then return new; end if;
  if tg_op = 'UPDATE' and tg_table_name <> 'agency_invitations' then
    o := to_jsonb(old);
    if lower(btrim(coalesce(o->>'email', ''))) = v_new then return new; end if;
  end if;

  case tg_table_name
    when 'cms_users', 'staff_profiles' then v_kind := 'staff';
    when 'agents' then v_kind := 'agent'; v_agency := (n->>'business_id')::uuid;
    when 'enrollment_students' then v_kind := 'student'; v_student := (n->>'id')::uuid; v_sp := (n->>'student_profile_id')::uuid;
    when 'student_profiles' then v_kind := 'student'; v_sp := (n->>'id')::uuid;
    when 'agency_invitations' then
      if n->>'status' <> 'pending' then return new; end if;
      v_kind := case when n->>'role' = 'student' then 'student' else 'agent' end;
      v_student := (n->>'student_id')::uuid; v_agency := (n->>'agency_id')::uuid;
    else return new;
  end case;

  perform pg_advisory_xact_lock(hashtext('identity_email:' || v_new));
  v_hit := public.identity_email_conflict(v_new, v_kind, tg_table_name, n->>'id', v_student, v_sp, v_agency);
  if v_hit is not null then
    v_label := case v_hit when 'staff' then 'staff member' when 'agent' then 'agent' else 'student' end;
    raise exception 'This email is already in use. Please use a different email address.'
      using errcode = '23505',
            detail  = format('%s is already used by another %s in SLIT. Each %s needs their own email.', v_new, v_label, v_label),
            hint    = 'email_taken';
  end if;
  return new;
end $$;

-- Applications are covered through the student record, so the application trigger is no longer needed.
drop trigger if exists identity_email_guard on public.enrollment_applications;

-- Live check now needs the role: 'staff' (CMS user), 'hr_staff' (HR profile), 'agent' or 'student'.
create or replace function public.email_available(p_email text, p_kind text default null, p_ref text default null)
returns jsonb
language plpgsql stable security definer
set search_path = public, hr
as $$
declare v text := lower(btrim(coalesce(p_email,''))); v_hit text; v_kind text; v_table text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('staff','hr_staff','agent','student') then
    raise exception 'p_kind must be staff, hr_staff, agent or student' using errcode = '22023';
  end if;
  if v = '' then return jsonb_build_object('available', false, 'message', 'Enter an email address.'); end if;
  v_kind  := case when p_kind = 'hr_staff' then 'staff' else p_kind end;
  v_table := case p_kind when 'staff' then 'cms_users' when 'hr_staff' then 'staff_profiles'
                         when 'agent' then 'agents' else 'enrollment_students' end;
  v_hit := public.identity_email_conflict(v, v_kind, v_table, coalesce(p_ref, ''),
             case when p_kind = 'student' and p_ref ~ '^[0-9a-f-]{36}$' then p_ref::uuid end, null, null);
  return jsonb_build_object('available', v_hit is null,
    'message', case when v_hit is null then null else 'This email is already in use. Please use a different email address.' end);
end $$;

revoke all on function public.identity_email_conflict(text,text,text,text,uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.identity_email_guard() from public, anon, authenticated;
revoke all on function public.email_available(text,text,text) from public, anon;
grant execute on function public.email_available(text,text,text) to authenticated;
