-- One email = one person across SLIT (staff/admin/trainer, agent, student).
create or replace function public.identity_email_conflict(
  p_email text, p_kind text, p_table text, p_ref text,
  p_student uuid default null, p_student_profile uuid default null)
returns text
language sql stable security definer
set search_path = public, hr
as $$
  with o(kind, tbl, ref, sp) as (
    select 'staff', 'cms_users', id::text, null::text from public.cms_users where lower(btrim(email)) = p_email
    union all select 'staff', 'staff_profiles', id::text, null from hr.staff_profiles where lower(btrim(email)) = p_email
    union all select 'agent', 'agents', id::text, null from public.agents where lower(btrim(email)) = p_email
    union all select 'student', 'enrollment_students', id::text, student_profile_id::text from public.enrollment_students where lower(btrim(email)) = p_email
    union all select 'student', 'student_profiles', id::text, null from public.student_profiles where lower(btrim(email)) = p_email
    union all select case when role = 'student' then 'student' else 'agent' end, 'agency_invitations', id::text, null
      from public.agency_invitations
      where lower(btrim(email)) = p_email and status = 'pending' and (expires_at is null or expires_at > now())
  )
  select o.kind from o
  where o.kind <> p_kind
     or (p_kind in ('agent','staff') and o.tbl = p_table and o.tbl <> 'agency_invitations' and o.ref <> coalesce(p_ref, ''))
     or (p_kind = 'student' and o.tbl = 'enrollment_students' and p_student is not null and o.ref <> p_student::text)
     or (p_kind = 'student' and o.tbl = 'student_profiles' and p_student_profile is not null and o.ref <> p_student_profile::text)
     or (p_kind = 'student' and o.tbl = 'enrollment_students' and p_table = 'student_profiles' and o.sp is not null and o.sp <> p_ref)
  limit 1
$$;

create or replace function public.identity_email_guard()
returns trigger
language plpgsql security definer
set search_path = public, hr
as $$
declare
  v_new text; v_old text; v_kind text; v_ref text; v_student uuid; v_sp uuid; v_hit text;
begin
  v_new := lower(btrim(coalesce(case tg_table_name
             when 'enrollment_applications' then new.student_email else new.email end, '')));
  if v_new = '' then return new; end if;
  if tg_op = 'UPDATE' then
    v_old := lower(btrim(coalesce(case tg_table_name
               when 'enrollment_applications' then old.student_email else old.email end, '')));
    if v_old = v_new and tg_table_name <> 'agency_invitations' then return new; end if;
  end if;

  case tg_table_name
    when 'cms_users'               then v_kind := 'staff';   v_ref := new.id::text;
    when 'staff_profiles'          then v_kind := 'staff';   v_ref := new.id::text;
    when 'agents'                  then v_kind := 'agent';   v_ref := new.id::text;
    when 'enrollment_students'     then v_kind := 'student'; v_ref := new.id::text; v_student := new.id; v_sp := new.student_profile_id;
    when 'student_profiles'        then v_kind := 'student'; v_ref := new.id::text; v_sp := new.id;
    when 'enrollment_applications' then v_kind := 'student'; v_ref := new.id::text; v_student := new.student_id;
    when 'agency_invitations' then
      if new.status <> 'pending' then return new; end if;
      v_kind := case when new.role = 'student' then 'student' else 'agent' end;
      v_ref := new.id::text; v_student := new.student_id;
  end case;

  perform pg_advisory_xact_lock(hashtext('identity_email:' || v_new));
  v_hit := public.identity_email_conflict(v_new, v_kind, tg_table_name, v_ref, v_student, v_sp);
  if v_hit is not null then
    raise exception 'This email is already in use. Please use a different email address.'
      using errcode = '23505',
            detail  = format('%s is already registered in SLIT as %s. One email can belong to only one account.',
                             v_new, case v_hit when 'staff' then 'a staff member' when 'agent' then 'an agent' else 'a student' end),
            hint    = 'email_taken';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['public.cms_users','hr.staff_profiles','public.agents','public.enrollment_students','public.student_profiles','public.agency_invitations'] loop
    execute format('drop trigger if exists identity_email_guard on %s', t);
    execute format('create trigger identity_email_guard before insert or update of email%s on %s for each row execute function public.identity_email_guard()',
                   case when t = 'public.agency_invitations' then ', status' else '' end, t);
  end loop;
end $$;
drop trigger if exists identity_email_guard on public.enrollment_applications;
create trigger identity_email_guard before insert or update of student_email on public.enrollment_applications
  for each row execute function public.identity_email_guard();

-- Live "is this email free?" check for forms (signed-in users only).
create or replace function public.email_available(p_email text, p_kind text default null, p_ref text default null)
returns jsonb
language plpgsql stable security definer
set search_path = public, hr
as $$
declare v text := lower(btrim(coalesce(p_email,''))); v_hit text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if v = '' then return jsonb_build_object('available', false, 'message', 'Enter an email address.'); end if;
  v_hit := public.identity_email_conflict(v, coalesce(p_kind, '__any__'), '', coalesce(p_ref, ''),
             case when p_kind = 'student' and p_ref ~ '^[0-9a-f-]{36}$' then p_ref::uuid end, null);
  return jsonb_build_object('available', v_hit is null,
    'message', case when v_hit is null then null else 'This email is already in use. Please use a different email address.' end);
end $$;

revoke all on function public.identity_email_conflict(text,text,text,text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.identity_email_guard() from public, anon, authenticated;
revoke all on function public.email_available(text,text,text) from public, anon;
grant execute on function public.email_available(text,text,text) to authenticated;
