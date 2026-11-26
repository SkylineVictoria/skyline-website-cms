-- VIEW-AS-ALL-AGENTS (owner, 2026-11-26): "Sign in as" an agent lists EVERY agent of Master Data -> Agents grouped by business
-- (was: only agents with a portal login, via agency_memberships / portal_profiles with auth_user_id), and an admin can sign in as
-- any agent, also one without a login yet (owner's choice: a real login on the agent's own email):
--   * the login is made by admin-view-as with NO password and nothing emailed, linked to the agent (agents.profile_id) and their
--     business; it is recorded in admin_view_agent_logins;
--   * when the admin goes back (admin_view_as_end), such a login with still no password is switched off again (membership
--     Inactive), so it opens no workspace until the agent is invited; the normal invitation turns it on (portal_resolve_access);
--   * the invitation is not refused for such a login (portal_invitation_create's "already an active portal user" check ignores a
--     Sign-in-as login without a password);
--   * every switch is recorded in admin_view_events with target type, agent, business, start (created_at) and end (ended_at).
-- Admins only (cms_users role Admin, Active); service role only (the admin-view-as Edge Function, admin JWT required). A CMS user
-- is never a target, so a signed-in-as session (never an admin) can never start another one.
-- Down: drop the new functions and admin_view_agent_logins; drop the four admin_view_events columns; re-apply
-- portal_invitation_create from 20261124233517.
begin;

alter table public.admin_view_events add column if not exists target_type text;
alter table public.admin_view_events add column if not exists agent_id uuid;
alter table public.admin_view_events add column if not exists business_id uuid;
alter table public.admin_view_events add column if not exists ended_at timestamptz;

create table if not exists public.admin_view_agent_logins (
  agent_id uuid primary key references public.agents(id) on delete cascade,
  auth_user_id uuid not null,
  profile_id uuid not null references public.portal_profiles(id) on delete cascade,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
alter table public.admin_view_agent_logins enable row level security;
revoke all on public.admin_view_agent_logins from public, anon, authenticated, service_role;
grant select on public.admin_view_agent_logins to service_role;

-- Has this Auth account a way to sign in by itself (a password, or Google / another provider)?
create or replace function public.admin_view_has_login(p_auth_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_auth_user is not null and (
    exists (select 1 from auth.users u where u.id = p_auth_user and coalesce(u.encrypted_password, '') <> '')
    or exists (select 1 from auth.identities i where i.user_id = p_auth_user and i.provider <> 'email'));
$$;

create or replace function public.admin_view_require_admin(p_admin uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_name text;
begin
  select coalesce(name, '') into v_name from public.cms_users where auth_user_id = p_admin and status = 'Active' and role = 'Admin';
  if not found then raise exception 'Administrator access required' using errcode = '42501'; end if;
  return v_name;
end $$;

-- Every agent, grouped by business: [{ business: {id, name}, agents: [{id, name, email, status, hasLogin}] }]; businesses A-Z
-- ("No business" last), agents A-Z. p_query matches business name, agent name or agent email (case-insensitive). Only these fields.
create or replace function public.admin_view_as_agents(p_query text, p_admin uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(left(coalesce(p_query, ''), 80)));
begin
  perform public.admin_view_require_admin(p_admin);
  return coalesce((
    select jsonb_agg(jsonb_build_object('business', jsonb_build_object('id', g.business_id, 'name', coalesce(g.business_name, 'No business')),
                                        'agents', g.agents)
                     order by g.business_name is null, lower(coalesce(g.business_name, '')), g.business_id)
    from (
      select a.business_id, b.name as business_name,
        jsonb_agg(jsonb_build_object('id', a.id, 'name', a.full_name, 'email', a.email, 'status', a.status,
          'hasLogin', public.admin_view_has_login(p.auth_user_id)) order by lower(a.full_name), a.id) as agents
      from public.agents a
      left join public.agencies b on b.id = a.business_id
      left join public.portal_profiles p on p.id = a.profile_id
      where upper(coalesce(b.code, '')) <> 'TEST-VIEW'
        and (q = '' or strpos(lower(coalesce(b.name, 'No business')), q) > 0 or strpos(lower(a.full_name), q) > 0 or strpos(lower(a.email), q) > 0)
      group by a.business_id, b.name
    ) g), '[]'::jsonb);
end $$;

-- Signing in as an agent, step 1: who to sign in as. Answers {email, name, businessId, authUserId} where authUserId is the agent's
-- linked login (null: admin-view-as finds or makes the Auth account for this email, then calls admin_view_as_agent_link).
-- Refused: no email, a CMS user's email, an agent who is not Active and has no login.
create or replace function public.admin_view_as_agent_target(p_agent uuid, p_admin uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.agents; v_auth uuid;
begin
  perform public.admin_view_require_admin(p_admin);
  select * into a from public.agents where id = p_agent;
  if a.id is null then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  if btrim(a.email) = '' then raise exception 'Add this agent''s email first' using errcode = '22023'; end if;
  if exists (select 1 from public.cms_users c where lower(c.email) = lower(a.email)) then
    raise exception 'A CMS user cannot be signed in as' using errcode = '42501';
  end if;
  select p.auth_user_id into v_auth from public.portal_profiles p where p.id = a.profile_id;
  if v_auth is not null and exists (select 1 from public.cms_users c where c.auth_user_id = v_auth) then
    raise exception 'A CMS user cannot be signed in as' using errcode = '42501';
  end if;
  if v_auth is null and a.status <> 'Active' then
    raise exception 'This agent is % and has no login. Make them Active first.', lower(a.status) using errcode = '22023';
  end if;
  return jsonb_build_object('email', lower(a.email), 'name', a.full_name, 'businessId', a.business_id, 'authUserId', v_auth,
    'existingAuthUserId', (select u.id from auth.users u where lower(u.email) = lower(a.email) limit 1));
end $$;

-- Step 2 (only for an agent without a login): links the Auth account (no password, made by admin-view-as) to the agent: portal
-- profile, membership of the agent's business with the agent's role, agents.profile_id; recorded in admin_view_agent_logins.
create or replace function public.admin_view_as_agent_link(p_agent uuid, p_auth_user uuid, p_admin uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.agents; v_profile uuid;
begin
  perform public.admin_view_require_admin(p_admin);
  select * into a from public.agents where id = p_agent for update;
  if a.id is null then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from auth.users u where u.id = p_auth_user and lower(u.email) = lower(a.email)) then
    raise exception 'That login is not this agent''s email' using errcode = '42501';
  end if;
  if exists (select 1 from public.cms_users c where c.auth_user_id = p_auth_user) then
    raise exception 'A CMS user cannot be signed in as' using errcode = '42501';
  end if;
  if a.profile_id is not null then
    if (select auth_user_id from public.portal_profiles where id = a.profile_id) is distinct from p_auth_user then
      raise exception 'This agent is linked to another login' using errcode = '42501';
    end if;
    v_profile := a.profile_id;
  else
    select id into v_profile from public.portal_profiles where auth_user_id = p_auth_user;
    if v_profile is null then
      insert into public.portal_profiles(auth_user_id, full_name, email, status) values (p_auth_user, a.full_name, lower(a.email), 'Active')
      returning id into v_profile;
    end if;
  end if;
  update public.portal_profiles set status = 'Active' where id = v_profile and status <> 'Active';
  insert into public.agency_memberships(user_id, agency_id, role, status) values (v_profile, a.business_id, a.role, 'Active')
  on conflict (user_id) do update set agency_id = excluded.agency_id, role = excluded.role, status = 'Active', updated_at = now();
  if a.profile_id is null then update public.agents set profile_id = v_profile, updated_at = now() where id = a.id; end if;
  insert into public.admin_view_agent_logins(agent_id, auth_user_id, profile_id, created_by) values (a.id, p_auth_user, v_profile, p_admin)
  on conflict (agent_id) do nothing;
end $$;

-- Step 3: records the switch (start) and returns the email to sign in with.
create or replace function public.admin_view_as_agent_start(p_agent uuid, p_admin uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin text; a public.agents; v_auth uuid; v_email text;
begin
  v_admin := public.admin_view_require_admin(p_admin);
  select * into a from public.agents where id = p_agent;
  select p.auth_user_id into v_auth from public.portal_profiles p where p.id = a.profile_id;
  if v_auth is null then raise exception 'This agent has no login yet' using errcode = 'P0002'; end if;
  if v_auth = p_admin or exists (select 1 from public.cms_users c where c.auth_user_id = v_auth) then
    raise exception 'A CMS user cannot be signed in as' using errcode = '42501';
  end if;
  -- A Sign-in-as login switched off when an earlier session ended is switched on again for this session.
  if exists (select 1 from public.admin_view_agent_logins v where v.agent_id = a.id and v.auth_user_id = v_auth) and not public.admin_view_has_login(v_auth) then
    update public.agency_memberships m set status = 'Active', updated_at = now() from public.portal_profiles p
     where p.id = a.profile_id and m.user_id = p.id and m.status <> 'Active';
  end if;
  select u.email into v_email from auth.users u where u.id = v_auth;
  -- One open switch per admin: an earlier one left open (tab closed) ends now.
  perform public.admin_view_as_end(p_admin);
  insert into public.admin_view_events(admin_auth_user, admin_name, kind, target_type, target_auth_user, target_name, agent_id, business_id)
  values (p_admin, coalesce(v_admin, ''), 'agent', 'agent', v_auth, a.full_name, a.id, a.business_id);
  return jsonb_build_object('email', v_email, 'name', a.full_name);
end $$;

-- "Back to admin" (or the next switch): the admin's open switches end; a Sign-in-as login with still no password is switched off.
create or replace function public.admin_view_as_end(p_admin uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform public.admin_view_require_admin(p_admin);
  update public.agency_memberships m set status = 'Inactive', updated_at = now()
    from public.admin_view_events e join public.admin_view_agent_logins v on v.agent_id = e.agent_id
   where e.admin_auth_user = p_admin and e.ended_at is null and m.user_id = v.profile_id and m.status = 'Active'
     and not public.admin_view_has_login(v.auth_user_id)
     and not exists (select 1 from public.admin_view_events o where o.agent_id = e.agent_id and o.ended_at is null and o.admin_auth_user <> p_admin);
  update public.admin_view_events set ended_at = now() where admin_auth_user = p_admin and ended_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Person switches of 20261117181523 (students, staff) carry their type too.
create or replace function public.admin_view_events_type() returns trigger language plpgsql set search_path = '' as $$
begin
  new.target_type := coalesce(new.target_type, case when new.target_auth_user is null then 'test_account' else new.kind end);
  return new;
end $$;
drop trigger if exists admin_view_events_type on public.admin_view_events;
create trigger admin_view_events_type before insert on public.admin_view_events for each row execute function public.admin_view_events_type();

revoke all on function public.admin_view_has_login(uuid), public.admin_view_require_admin(uuid), public.admin_view_as_agents(text, uuid),
  public.admin_view_as_agent_target(uuid, uuid), public.admin_view_as_agent_link(uuid, uuid, uuid), public.admin_view_as_agent_start(uuid, uuid),
  public.admin_view_as_end(uuid), public.admin_view_events_type() from public, anon, authenticated;
grant execute on function public.admin_view_as_agents(text, uuid), public.admin_view_as_agent_target(uuid, uuid),
  public.admin_view_as_agent_link(uuid, uuid, uuid), public.admin_view_as_agent_start(uuid, uuid), public.admin_view_as_end(uuid) to service_role;

-- The normal invitation is not refused for a Sign-in-as login that has no password yet (the agent is still to be invited).
select public.business_rule_patch_function('public.portal_invitation_create(uuid, uuid, text, text, text, uuid)'::regprocedure,
$old$where lower(p.email) = v_email and m.status = 'Active' and p.status = 'Active') then$old$,
$new$where lower(p.email) = v_email and m.status = 'Active' and p.status = 'Active'
   and not exists (select 1 from public.admin_view_agent_logins vl where vl.profile_id = p.id and not public.admin_view_has_login(vl.auth_user_id))) then$new$);

commit;
