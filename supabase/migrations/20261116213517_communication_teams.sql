-- COMM-TEAMS: staff team groups in the Communication Hub. A team (e.g. Admissions, Trainers) has members chosen from the active CMS
-- users and a shared chat that only its members can read and post to. Any administrator can create a team and manage its members (the
-- hub is admin only); the creator joins automatically. Unread counts come from each member's last-read time. Messages are kept when a
-- team is archived; an archived team is read-only. Additive.
-- Rollback (manual): drop the comm_team* functions and tables.
begin;

create table public.comm_teams(
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index comm_teams_name on public.comm_teams(lower(btrim(name))) where archived_at is null;

create table public.comm_team_members(
  team_id uuid not null references public.comm_teams(id) on delete cascade,
  cms_user_id text not null references public.cms_users(id) on delete cascade,
  added_by uuid default auth.uid(),
  added_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (team_id, cms_user_id)
);
create index comm_team_members_user on public.comm_team_members(cms_user_id);

create table public.comm_team_messages(
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.comm_teams(id) on delete cascade,
  author_cms_user_id text references public.cms_users(id) on delete set null,
  author_name text not null,
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index comm_team_messages_team on public.comm_team_messages(team_id, created_at);

alter table public.comm_teams enable row level security;
alter table public.comm_team_members enable row level security;
alter table public.comm_team_messages enable row level security;
revoke all on public.comm_teams, public.comm_team_members, public.comm_team_messages from public, anon, authenticated, service_role;
grant select on public.comm_teams, public.comm_team_members, public.comm_team_messages to service_role;

/** The signed-in staff member's CMS user row id; null when not an active CMS user. */
create function public.comm_me() returns text language sql stable security definer set search_path = public as $$
  select id from public.cms_users where auth_user_id = auth.uid() and status = 'Active' limit 1;
$$;

/** Teams with member count, latest message and my unread count; all teams for administrators, mine marked. */
create function public.comm_teams_list(p_include_archived boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me text; v jsonb;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can use the Communication Hub' using errcode = '42501'; end if;
  v_me := public.comm_me();
  select coalesce(jsonb_agg(x order by (x->>'isMember')::boolean desc, x->>'lastAt' desc nulls last, lower(x->>'name')), '[]'::jsonb) into v from (
    select jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'archived', t.archived_at is not null,
      'memberCount', (select count(*) from public.comm_team_members m where m.team_id = t.id),
      'isMember', exists (select 1 from public.comm_team_members m where m.team_id = t.id and m.cms_user_id = v_me),
      'lastAt', (select max(created_at) from public.comm_team_messages tm where tm.team_id = t.id),
      'last', case when exists (select 1 from public.comm_team_members m where m.team_id = t.id and m.cms_user_id = v_me) then
        (select jsonb_build_object('author', tm.author_name, 'text', left(tm.body, 120)) from public.comm_team_messages tm where tm.team_id = t.id order by tm.created_at desc limit 1) end,
      'unread', coalesce((select count(*) from public.comm_team_messages tm join public.comm_team_members m on m.team_id = tm.team_id and m.cms_user_id = v_me
        where tm.team_id = t.id and tm.author_cms_user_id is distinct from v_me and tm.created_at > coalesce(m.last_read_at, '-infinity'::timestamptz)), 0)) x
    from public.comm_teams t where p_include_archived or t.archived_at is null
  ) s;
  return v;
end;
$$;

/** Active CMS users who can be team members. */
create function public.comm_staff_options() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can use the Communication Hub' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email, 'role', role) order by lower(name))
    from public.cms_users where status = 'Active'), '[]'::jsonb);
end;
$$;

/** Creates (p_team null) or updates a team and sets its members. The creator is always added on create. */
create function public.comm_team_save(p_team uuid, p_name text, p_description text, p_member_ids text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_team; v_me text; v_members text[];
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can manage teams' using errcode = '42501'; end if;
  v_me := public.comm_me();
  if btrim(coalesce(p_name, '')) = '' then raise exception 'Give the team a name' using errcode = '22023'; end if;
  select array_agg(distinct u.id) into v_members from public.cms_users u where u.id = any(coalesce(p_member_ids, '{}')) and u.status = 'Active';
  if v_id is null then
    if v_me is not null then v_members := array(select distinct unnest(coalesce(v_members, '{}') || v_me)); end if;
    insert into public.comm_teams(name, description) values (btrim(p_name), btrim(coalesce(p_description, ''))) returning id into v_id;
  else
    update public.comm_teams set name = btrim(p_name), description = btrim(coalesce(p_description, '')), updated_at = now() where id = v_id and archived_at is null;
    if not found then raise exception 'Team not found or archived' using errcode = 'P0002'; end if;
  end if;
  if coalesce(cardinality(v_members), 0) = 0 then raise exception 'A team needs at least one member' using errcode = '22023'; end if;
  delete from public.comm_team_members where team_id = v_id and not (cms_user_id = any(v_members));
  insert into public.comm_team_members(team_id, cms_user_id) select v_id, unnest(v_members) on conflict do nothing;
  return v_id;
exception when unique_violation then
  raise exception 'A team with this name already exists' using errcode = '23505';
end;
$$;

create function public.comm_team_archive(p_team uuid, p_archived boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can manage teams' using errcode = '42501'; end if;
  update public.comm_teams set archived_at = case when p_archived then now() end, updated_at = now() where id = p_team;
  if not found then raise exception 'Team not found' using errcode = 'P0002'; end if;
end;
$$;

/** A team's members and messages (members only); marks the team read for me. */
create function public.comm_team_thread(p_team uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me text; t public.comm_teams; v jsonb;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can use the Communication Hub' using errcode = '42501'; end if;
  v_me := public.comm_me();
  select * into t from public.comm_teams where id = p_team;
  if not found then raise exception 'Team not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.comm_team_members where team_id = p_team and cms_user_id = v_me) then
    raise exception 'Only members can read this team''s messages' using errcode = '42501';
  end if;
  update public.comm_team_members set last_read_at = now() where team_id = p_team and cms_user_id = v_me;
  select jsonb_build_object(
    'team', jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'archived', t.archived_at is not null),
    'me', v_me,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email) order by lower(u.name))
      from public.comm_team_members m join public.cms_users u on u.id = m.cms_user_id where m.team_id = p_team), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'authorId', x.author_cms_user_id, 'author', x.author_name, 'body', x.body, 'at', x.created_at) order by x.created_at)
      from (select * from public.comm_team_messages where team_id = p_team order by created_at desc limit 500) x), '[]'::jsonb))
  into v;
  return v;
end;
$$;

create function public.comm_team_post(p_team uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me text; v_name text; v_id uuid; v_body text := btrim(coalesce(p_body, ''));
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can use the Communication Hub' using errcode = '42501'; end if;
  v_me := public.comm_me();
  if not exists (select 1 from public.comm_team_members m join public.comm_teams t on t.id = m.team_id where m.team_id = p_team and m.cms_user_id = v_me and t.archived_at is null) then
    raise exception 'Only members can post to this team (and not when it is archived)' using errcode = '42501';
  end if;
  if v_body = '' or length(v_body) > 4000 then raise exception 'Write a message (up to 4000 characters)' using errcode = '22023'; end if;
  select name into v_name from public.cms_users where id = v_me;
  insert into public.comm_team_messages(team_id, author_cms_user_id, author_name, body) values (p_team, v_me, coalesce(v_name, 'Staff'), v_body) returning id into v_id;
  update public.comm_team_members set last_read_at = now() where team_id = p_team and cms_user_id = v_me;
  return v_id;
end;
$$;

revoke all on function public.comm_me(), public.comm_teams_list(boolean), public.comm_staff_options(), public.comm_team_save(uuid, text, text, text[]),
  public.comm_team_archive(uuid, boolean), public.comm_team_thread(uuid), public.comm_team_post(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.comm_teams_list(boolean), public.comm_staff_options(), public.comm_team_save(uuid, text, text, text[]),
  public.comm_team_archive(uuid, boolean), public.comm_team_thread(uuid), public.comm_team_post(uuid, text) to authenticated;

commit;
