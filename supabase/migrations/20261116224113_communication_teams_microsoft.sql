-- COMM-TEAMS-MS: mirror a staff team's messages to a Microsoft Teams channel (one-way). An administrator pastes the channel's webhook
-- link (a Teams Workflows "Post to a channel when a webhook request is received" URL, or a legacy Incoming Webhook URL); every new team
-- message is then posted to that channel as an Adaptive Card by pg_net from the database. No Edge Function is involved.
-- The link is a secret (anyone holding it can post to the channel): it is stored in a table with no client access and is never returned;
-- the hub only sees whether a link is set and its host. Only Microsoft webhook hosts are accepted, so the database never calls any other
-- host. Delivery is best-effort: a failed post never blocks the hub message; the per-message request id lets the thread show the result
-- while pg_net keeps responses. Replies in Teams do not come back. Additive.
-- Rollback (manual): drop trigger comm_team_messages_to_microsoft on public.comm_team_messages; drop function public.comm_team_to_microsoft(),
-- public.comm_team_microsoft_set(uuid, text), public.comm_team_microsoft_test(uuid), public.comm_team_microsoft_host_ok(text);
-- drop table public.comm_team_microsoft; alter table public.comm_team_messages drop column microsoft_request_id;
-- re-create public.comm_teams_list(boolean) and public.comm_team_thread(uuid) from 20261116213517.
begin;

create table public.comm_team_microsoft(
  team_id uuid primary key references public.comm_teams(id) on delete cascade,
  webhook_url text not null,
  connected_by uuid default auth.uid(),
  connected_at timestamptz not null default now()
);
alter table public.comm_team_microsoft enable row level security;
revoke all on public.comm_team_microsoft from public, anon, authenticated, service_role;

alter table public.comm_team_messages add column microsoft_request_id bigint;

/** Only Microsoft-hosted webhook endpoints (Teams Workflows / Power Automate, legacy Office 365 connectors). */
create function public.comm_team_microsoft_host_ok(p_url text) returns boolean language sql immutable as $$
  select coalesce(p_url, '') ~ '^https://[A-Za-z0-9.-]+(:443)?(/|\?|$)'
    and length(p_url) <= 2000
    and lower(substring(p_url from '^https://([^/?#:]+)')) ~ '(^|\.)(logic\.azure\.com|api\.powerplatform\.com|webhook\.office\.com)$';
$$;

create function public.comm_team_microsoft_card(p_team_name text, p_author text, p_body text) returns jsonb language sql immutable as $$
  select jsonb_build_object('type', 'message', 'attachments', jsonb_build_array(jsonb_build_object(
    'contentType', 'application/vnd.microsoft.card.adaptive', 'contentUrl', null,
    'content', jsonb_build_object('$schema', 'http://adaptivecards.io/schemas/adaptive-card.json', 'type', 'AdaptiveCard', 'version', '1.4',
      'body', jsonb_build_array(
        jsonb_build_object('type', 'TextBlock', 'text', p_author || ' · ' || p_team_name, 'weight', 'Bolder', 'size', 'Small', 'wrap', true),
        jsonb_build_object('type', 'TextBlock', 'text', p_body, 'wrap', true))))));
$$;

/** Sets (or with an empty link removes) the Microsoft Teams channel link of a team. Admin only; the link is never read back. */
create function public.comm_team_microsoft_set(p_team uuid, p_webhook_url text) returns void
language plpgsql security definer set search_path = public as $$
declare v text := btrim(coalesce(p_webhook_url, ''));
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can manage teams' using errcode = '42501'; end if;
  if not exists (select 1 from public.comm_teams where id = p_team) then raise exception 'Team not found' using errcode = 'P0002'; end if;
  if v = '' then delete from public.comm_team_microsoft where team_id = p_team; return; end if;
  if not public.comm_team_microsoft_host_ok(v) then
    raise exception 'Paste the Microsoft Teams channel link (it starts with https:// and comes from Teams Workflows)' using errcode = '22023';
  end if;
  insert into public.comm_team_microsoft(team_id, webhook_url) values (p_team, v)
  on conflict (team_id) do update set webhook_url = excluded.webhook_url, connected_by = auth.uid(), connected_at = now();
end;
$$;

/** Posts a test card to the team's Microsoft Teams channel; returns the request id. */
create function public.comm_team_microsoft_test(p_team uuid) returns bigint
language plpgsql security definer set search_path = public, net as $$
declare v_url text; v_name text; v_id bigint;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can manage teams' using errcode = '42501'; end if;
  select m.webhook_url, t.name into v_url, v_name from public.comm_team_microsoft m join public.comm_teams t on t.id = m.team_id where m.team_id = p_team;
  if v_url is null or not public.comm_team_microsoft_host_ok(v_url) then raise exception 'This team is not connected to Microsoft Teams' using errcode = '22023'; end if;
  v_id := net.http_post(url := v_url, body := public.comm_team_microsoft_card(v_name, 'Skyline Communication Hub',
    'This channel is now connected. Messages posted in the ' || v_name || ' team will appear here.'),
    headers := jsonb_build_object('Content-Type', 'application/json'), timeout_milliseconds := 10000);
  return v_id;
end;
$$;

/** After a team message is saved: post it to the linked Microsoft Teams channel. Never blocks or fails the message. */
create function public.comm_team_to_microsoft() returns trigger
language plpgsql security definer set search_path = public, net as $$
declare v_url text; v_name text; v_id bigint;
begin
  select m.webhook_url, t.name into v_url, v_name from public.comm_team_microsoft m join public.comm_teams t on t.id = m.team_id
  where m.team_id = new.team_id and t.archived_at is null;
  if v_url is null or not public.comm_team_microsoft_host_ok(v_url) then return null; end if;
  begin
    v_id := net.http_post(url := v_url, body := public.comm_team_microsoft_card(v_name, new.author_name, new.body),
      headers := jsonb_build_object('Content-Type', 'application/json'), timeout_milliseconds := 10000);
    update public.comm_team_messages set microsoft_request_id = v_id where id = new.id;
  exception when others then
    null; -- the hub message stays saved; the Teams copy is best-effort
  end;
  return null;
end;
$$;
create trigger comm_team_messages_to_microsoft after insert on public.comm_team_messages
  for each row execute function public.comm_team_to_microsoft();

-- Lists and threads now say whether a team is connected (and the host only) and, per message, the Teams copy result while known.
create or replace function public.comm_teams_list(p_include_archived boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_me text; v jsonb;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can use the Communication Hub' using errcode = '42501'; end if;
  v_me := public.comm_me();
  select coalesce(jsonb_agg(x order by (x->>'isMember')::boolean desc, x->>'lastAt' desc nulls last, lower(x->>'name')), '[]'::jsonb) into v from (
    select jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'archived', t.archived_at is not null,
      'microsoft', exists (select 1 from public.comm_team_microsoft mm where mm.team_id = t.id),
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

create or replace function public.comm_team_thread(p_team uuid) returns jsonb
language plpgsql security definer set search_path = public, net as $$
declare v_me text; t public.comm_teams; v jsonb; v_host text;
begin
  if not coalesce(public.cms_is_admin(), false) then raise exception 'Only administrators can use the Communication Hub' using errcode = '42501'; end if;
  v_me := public.comm_me();
  select * into t from public.comm_teams where id = p_team;
  if not found then raise exception 'Team not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.comm_team_members where team_id = p_team and cms_user_id = v_me) then
    raise exception 'Only members can read this team''s messages' using errcode = '42501';
  end if;
  update public.comm_team_members set last_read_at = now() where team_id = p_team and cms_user_id = v_me;
  select lower(substring(webhook_url from '^https://([^/?#:]+)')) into v_host from public.comm_team_microsoft where team_id = p_team;
  select jsonb_build_object(
    'team', jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'archived', t.archived_at is not null,
      'microsoft', v_host is not null, 'microsoftHost', v_host),
    'me', v_me,
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email) order by lower(u.name))
      from public.comm_team_members m join public.cms_users u on u.id = m.cms_user_id where m.team_id = p_team), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'authorId', x.author_cms_user_id, 'author', x.author_name, 'body', x.body, 'at', x.created_at,
        'microsoft', case when x.microsoft_request_id is null then null
          when r.status_code between 200 and 299 then 'sent' when r.status_code is not null or r.error_msg is not null then 'failed' else 'sending' end) order by x.created_at)
      from (select * from public.comm_team_messages where team_id = p_team order by created_at desc limit 500) x
      left join net._http_response r on r.id = x.microsoft_request_id), '[]'::jsonb))
  into v;
  return v;
end;
$$;

revoke all on function public.comm_team_microsoft_host_ok(text), public.comm_team_microsoft_card(text, text, text), public.comm_team_microsoft_set(uuid, text),
  public.comm_team_microsoft_test(uuid), public.comm_team_to_microsoft() from public, anon, authenticated, service_role;
grant execute on function public.comm_team_microsoft_set(uuid, text), public.comm_team_microsoft_test(uuid) to authenticated;
revoke all on function public.comm_teams_list(boolean), public.comm_team_thread(uuid) from public, anon, service_role;
grant execute on function public.comm_teams_list(boolean), public.comm_team_thread(uuid) to authenticated;

commit;
