-- VIEW-AS: administrators can open the Student, Agent and Staff workspaces as a shared test account ("Switch view").
-- Three fixed test sign-ins exist, one per workspace; they belong to a test agency / are a test staff member, so an admin sees
-- exactly what that kind of user sees without touching a real person's account. The admin-view-as Edge Function (admin JWT
-- required) creates the Auth users, calls admin_view_as_seed to create their workspace records, and returns a one-time sign-in
-- token for the chosen test account; every switch is recorded in admin_view_events. Nothing here can sign in as a real user:
-- the seed refuses any Auth user whose email is not the fixed test email of that kind.
-- Test emails use Postmark's black-hole domain, so notifications sent to them are accepted and dropped.
-- Applications created in the test agency are flagged is_test. Additive.
-- Rollback (manual): drop trigger enrollment_applications_view_as_test on public.enrollment_applications; drop the admin_view_*
-- functions and tables; delete the three test Auth users and their rows (portal_profiles.is_test, agency code TEST-VIEW, the
-- hr.staff_profiles row of view-staff@blackhole.postmarkapp.com).
begin;

create table public.admin_view_accounts(
  kind text primary key check (kind in ('student', 'agent', 'staff')),
  email text not null unique,
  auth_user_id uuid not null unique,
  created_at timestamptz not null default now()
);
create table public.admin_view_events(
  id uuid primary key default gen_random_uuid(),
  admin_auth_user uuid not null,
  admin_name text not null default '',
  kind text not null,
  created_at timestamptz not null default now()
);
alter table public.admin_view_accounts enable row level security;
alter table public.admin_view_events enable row level security;
revoke all on public.admin_view_accounts, public.admin_view_events from public, anon, authenticated, service_role;
grant select on public.admin_view_accounts, public.admin_view_events to service_role;

create function public.admin_view_email(p_kind text) returns text language sql immutable as $$
  select case p_kind when 'student' then 'view-student@blackhole.postmarkapp.com' when 'agent' then 'view-agent@blackhole.postmarkapp.com'
    when 'staff' then 'view-staff@blackhole.postmarkapp.com' end;
$$;

/** The fixed test account of a kind: its email, display name and Auth user id when it already exists. Service role only. */
create function public.admin_view_as_account(p_kind text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_email text := public.admin_view_email(p_kind);
begin
  if v_email is null then raise exception 'Unknown workspace' using errcode = '22023'; end if;
  return jsonb_build_object('email', v_email, 'name', 'Test ' || initcap(p_kind),
    'authUserId', (select u.id from auth.users u where lower(u.email) = v_email limit 1));
end;
$$;

/** Creates (once) the workspace records of a test account and records the switch. Service role only (admin-view-as). */
create function public.admin_view_as_seed(p_kind text, p_auth_user uuid, p_admin uuid) returns void
language plpgsql security definer set search_path = public, hr as $$
declare v_email text := public.admin_view_email(p_kind); v_admin text; v_agency uuid; v_profile uuid; v_student uuid; v_staff uuid;
begin
  if v_email is null then raise exception 'Unknown workspace' using errcode = '22023'; end if;
  select name into v_admin from public.cms_users where auth_user_id = p_admin and status = 'Active' and role = 'Admin';
  if not found then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users u where u.id = p_auth_user and lower(u.email) = v_email) then
    raise exception 'Not the test account of this workspace' using errcode = '42501';
  end if;
  if exists (select 1 from public.cms_users where auth_user_id = p_auth_user or lower(email) = v_email) then
    raise exception 'A test account can never be a CMS user' using errcode = '42501';
  end if;

  if p_kind in ('student', 'agent') then
    select id into v_agency from public.agencies where lower(code) = 'test-view';
    if v_agency is null then
      insert into public.agencies(name, code, status, country, primary_contact)
      values ('Test Agency (admin preview)', 'TEST-VIEW', 'Active', 'Australia', 'Test Agent') returning id into v_agency;
    end if;
    select id into v_profile from public.portal_profiles where auth_user_id = p_auth_user;
    if v_profile is null then
      insert into public.portal_profiles(auth_user_id, full_name, email, status, is_test)
      values (p_auth_user, 'Test ' || initcap(p_kind), v_email, 'Active', true) returning id into v_profile;
    end if;
    if p_kind = 'student' then
      select id into v_student from public.enrollment_students where lower(btrim(email)) = v_email;
      if v_student is null then
        insert into public.enrollment_students(agency_id, full_name, email, status) values (v_agency, 'Test Student', v_email, 'Active') returning id into v_student;
      end if;
      insert into public.agency_memberships(user_id, agency_id, role, status, is_test, student_id)
      values (v_profile, v_agency, 'student', 'Active', true, v_student) on conflict (user_id) do nothing;
    else
      insert into public.agency_memberships(user_id, agency_id, role, status, is_test)
      values (v_profile, v_agency, 'agent', 'Active', true) on conflict (user_id) do nothing;
    end if;
  else
    select id into v_staff from hr.staff_profiles where auth_user_id = p_auth_user or email = v_email;
    if v_staff is null then
      perform set_config('hr.actor_kind', 'admin', true);
      perform set_config('hr.actor', p_admin::text, true);
      insert into hr.staff_profiles(auth_user_id, first_name, last_name, email, status)
      values (p_auth_user, 'Test', 'Staff', v_email, 'active') returning id into v_staff;
    end if;
    if not exists (select 1 from hr.staff_roles where profile_id = v_staff and revoked_at is null) then
      insert into hr.staff_roles(profile_id, role, granted_by) values (v_staff, 'trainer', p_admin);
    end if;
  end if;

  insert into public.admin_view_accounts(kind, email, auth_user_id) values (p_kind, v_email, p_auth_user) on conflict (kind) do nothing;
  insert into public.admin_view_events(admin_auth_user, admin_name, kind) values (p_admin, coalesce(v_admin, ''), p_kind);
end;
$$;

-- Anything lodged from the test agency is test data.
create function public.admin_view_flag_test_application() returns trigger language plpgsql set search_path = public as $$
begin
  if new.agency_id is not null and exists (select 1 from public.agencies a where a.id = new.agency_id and lower(a.code) = 'test-view') then
    new.is_test := true;
  end if;
  return new;
end;
$$;
create trigger enrollment_applications_view_as_test before insert on public.enrollment_applications
  for each row execute function public.admin_view_flag_test_application();

revoke all on function public.admin_view_email(text), public.admin_view_as_account(text), public.admin_view_as_seed(text, uuid, uuid),
  public.admin_view_flag_test_application() from public, anon, authenticated, service_role;
grant execute on function public.admin_view_as_account(text), public.admin_view_as_seed(text, uuid, uuid) to service_role;

commit;
