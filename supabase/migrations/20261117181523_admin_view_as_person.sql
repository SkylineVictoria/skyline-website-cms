-- VIEW-AS-PERSON: an administrator can sign in as a chosen real student, agent or staff member (full access), as well as the
-- shared test accounts of 20261117003406. Only active CMS Admins can do it; the person must belong to the chosen workspace
-- (an active student or agent membership, or an active staff profile with a sign-in) and can never be a CMS user, so no admin
-- can sign in as another admin. Every switch is recorded in admin_view_events with the person. Service role only: the
-- admin-view-as Edge Function (admin JWT required) lists people, checks the choice and returns a one-time sign-in token.
-- Additive: two nullable columns, two functions.

alter table public.admin_view_events add column if not exists target_auth_user uuid;
alter table public.admin_view_events add column if not exists target_name text;

/** People an admin can sign in as, in one workspace, matching a search (name or email); at most 25. Service role only. */
create or replace function public.admin_view_as_people(p_kind text, p_query text, p_admin uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare q text := '%' || lower(btrim(coalesce(p_query, ''))) || '%';
begin
  if not exists (select 1 from public.cms_users where auth_user_id = p_admin and status = 'Active' and role = 'Admin') then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_kind in ('student', 'agent') then
    return coalesce((select jsonb_agg(x order by x->>'name') from (
      select distinct on (p.auth_user_id) jsonb_build_object('userId', p.auth_user_id, 'name', coalesce(nullif(btrim(p.full_name), ''), p.email),
        'email', p.email, 'detail', coalesce(a.name, '')) as x
      from public.agency_memberships m
      join public.portal_profiles p on p.id = m.user_id
      left join public.agencies a on a.id = m.agency_id
      where m.role = p_kind and m.status = 'Active' and not coalesce(m.is_test, false) and not coalesce(p.is_test, false)
        and p.auth_user_id is not null
        and not exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id)
        and (lower(coalesce(p.full_name, '')) like q or lower(coalesce(p.email, '')) like q)
      order by p.auth_user_id limit 25) s), '[]'::jsonb);
  elsif p_kind = 'staff' then
    return coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('userId', s.auth_user_id, 'name', btrim(concat_ws(' ', s.first_name, s.last_name)), 'email', s.email,
        'detail', coalesce((select string_agg(r.role, ', ') from hr.staff_roles r where r.profile_id = s.id and r.revoked_at is null), '')) as x
      from hr.staff_profiles s
      where s.status = 'active' and s.auth_user_id is not null
        and lower(coalesce(s.email, '')) <> public.admin_view_email('staff')
        and not exists (select 1 from public.cms_users c where c.auth_user_id = s.auth_user_id)
        and (lower(concat_ws(' ', s.first_name, s.last_name)) like q or lower(coalesce(s.email, '')) like q)
      order by s.first_name, s.last_name limit 25) t), '[]'::jsonb);
  end if;
  raise exception 'Unknown workspace' using errcode = '22023';
end;
$$;

/** Checks that an admin may sign in as this person in this workspace, records the switch and returns the person's sign-in email. */
create or replace function public.admin_view_as_person(p_kind text, p_target uuid, p_admin uuid) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare v_admin text; v_email text; v_name text;
begin
  select name into v_admin from public.cms_users where auth_user_id = p_admin and status = 'Active' and role = 'Admin';
  if not found then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if p_target = p_admin or exists (select 1 from public.cms_users where auth_user_id = p_target) then
    raise exception 'A CMS user cannot be signed in as' using errcode = '42501';
  end if;
  if p_kind in ('student', 'agent') then
    select p.email, coalesce(nullif(btrim(p.full_name), ''), p.email) into v_email, v_name
    from public.agency_memberships m join public.portal_profiles p on p.id = m.user_id
    where p.auth_user_id = p_target and m.role = p_kind and m.status = 'Active' limit 1;
  elsif p_kind = 'staff' then
    select s.email, btrim(concat_ws(' ', s.first_name, s.last_name)) into v_email, v_name
    from hr.staff_profiles s where s.auth_user_id = p_target and s.status = 'active' limit 1;
  else
    raise exception 'Unknown workspace' using errcode = '22023';
  end if;
  if v_email is null then raise exception 'This person is not an active % with a sign-in', p_kind using errcode = 'P0002'; end if;
  -- The sign-in uses the Auth account's own email.
  select u.email into v_email from auth.users u where u.id = p_target;
  if v_email is null then raise exception 'This person has no sign-in' using errcode = 'P0002'; end if;
  insert into public.admin_view_events(admin_auth_user, admin_name, kind, target_auth_user, target_name)
  values (p_admin, coalesce(v_admin, ''), p_kind, p_target, v_name);
  return jsonb_build_object('email', v_email, 'name', v_name);
end;
$$;

revoke all on function public.admin_view_as_people(text, text, uuid), public.admin_view_as_person(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_view_as_people(text, text, uuid), public.admin_view_as_person(text, uuid, uuid) to service_role;
