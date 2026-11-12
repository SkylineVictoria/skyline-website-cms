-- TKT-01 Support tickets. Students and agents (agency portal) raise tickets; Skyline administrators handle them in
-- CMS > Tickets. All access goes through the support_* functions below (tables are closed to anon/authenticated).
-- Who sees what: the requester sees their own tickets; an agency admin sees every ticket of their agency; an agent sees their
-- own tickets and tickets about students assigned to them; a Skyline administrator (portal_is_slit_admin) sees and handles all.
-- Internal notes are only ever returned to administrators. Requesters get an in-app notification (portal_notifications)
-- when an administrator replies or changes the status. Attachments live in the private bucket support-attachments under
-- <uploader auth uid>/..., and can be read only by people who can see the message that lists them.

create sequence if not exists public.support_ticket_ref_seq;

create table if not exists public.support_tickets (
 id uuid primary key default gen_random_uuid(),
 ref text not null unique default ('TKT-' || lpad(nextval('public.support_ticket_ref_seq')::text, 6, '0')),
 tenant_id uuid references public.tenants(id) on delete restrict,
 requester_user uuid not null,
 requester_profile uuid references public.portal_profiles(id) on delete set null,
 requester_role text not null check (requester_role in ('student','agent','agency_admin')),
 requester_name text not null default '',
 requester_email text not null default '',
 agency_id uuid references public.agencies(id) on delete set null,
 student_id uuid references public.enrollment_students(id) on delete set null,
 category text not null check (category in ('enrolment_documents','fees_payments','course_training')),
 subject text not null check (char_length(btrim(subject)) between 3 and 200),
 priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
 status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
 assigned_to uuid,
 assigned_name text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 last_message_at timestamptz not null default now(),
 last_requester_activity_at timestamptz not null default now(),
 last_staff_activity_at timestamptz,
 requester_read_at timestamptz not null default now(),
 staff_read_at timestamptz,
 resolved_at timestamptz,
 closed_at timestamptz
);
create index if not exists support_tickets_requester_idx on public.support_tickets(requester_user, last_message_at desc);
create index if not exists support_tickets_agency_idx on public.support_tickets(agency_id, last_message_at desc);
create index if not exists support_tickets_status_idx on public.support_tickets(status, last_message_at desc);

create table if not exists public.support_ticket_messages (
 id uuid primary key default gen_random_uuid(),
 ticket_id uuid not null references public.support_tickets(id) on delete cascade,
 kind text not null default 'message' check (kind in ('message','event')),
 author_user uuid,
 author_name text not null default '',
 from_staff boolean not null default false,
 internal boolean not null default false,
 body text not null check (char_length(body) between 1 and 10000),
 attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 5),
 created_at timestamptz not null default now()
);
create index if not exists support_ticket_messages_ticket_idx on public.support_ticket_messages(ticket_id, created_at);

alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;
revoke all on public.support_tickets, public.support_ticket_messages from anon, authenticated;
revoke all on sequence public.support_ticket_ref_seq from anon, authenticated;

-- Handler = Skyline administrator on the main site, or tenant admin/staff on a tenant domain (same rule as portal_is_slit_admin).
create or replace function public.support_is_handler()
 returns boolean language sql stable security definer set search_path to 'public'
as $$ select auth.uid() is not null and coalesce(public.portal_is_slit_admin(), false) $$;

create or replace function public.support_can_view(p_ticket public.support_tickets)
 returns boolean language plpgsql stable security definer set search_path to 'public'
as $$
declare v_profile uuid; v_agency uuid;
begin
 if auth.uid() is null then return false; end if;
 if public.support_is_handler() then return p_ticket.tenant_id is not distinct from public.tenant_current() or public.tenant_request_domain() is null; end if;
 if p_ticket.requester_user = auth.uid() then return true; end if;
 v_profile := public.portal_profile_id(); v_agency := public.portal_agency_id();
 if v_profile is null or v_agency is null or p_ticket.agency_id is distinct from v_agency then return false; end if;
 if public.portal_is_agency_admin() then return true; end if;
 return p_ticket.student_id is not null and exists (
  select 1 from public.enrollment_students s join public.agents ag on ag.id = s.agent_id
  where s.id = p_ticket.student_id and s.agency_id = v_agency and ag.profile_id = v_profile);
end $$;

-- Attachments: [{path,name,size,type}], each uploaded by the caller to support-attachments/<auth uid>/...
create or replace function public.support_clean_attachments(p_items jsonb)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'storage'
as $$
declare v jsonb := '[]'::jsonb; e jsonb; v_path text;
begin
 if p_items is null or jsonb_typeof(p_items) <> 'array' then return v; end if;
 if jsonb_array_length(p_items) > 5 then raise exception 'At most 5 attachments' using errcode = '22023'; end if;
 for e in select * from jsonb_array_elements(p_items) loop
  v_path := e->>'path';
  if v_path is null or split_part(v_path, '/', 1) <> auth.uid()::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'support-attachments' and o.name = v_path) then
   raise exception 'Attachment not found' using errcode = '22023';
  end if;
  v := v || jsonb_build_array(jsonb_build_object('path', v_path, 'name', left(coalesce(e->>'name', 'file'), 200),
   'size', coalesce((e->>'size')::bigint, 0), 'type', left(coalesce(e->>'type', ''), 100)));
 end loop;
 return v;
end $$;

create or replace function public.support_notify_requester(p_ticket public.support_tickets, p_title text, p_message text)
 returns void language sql security definer set search_path to 'public'
as $$
 insert into public.portal_notifications(recipient, reference, event, title, message, tenant_id)
 values (p_ticket.requester_user, p_ticket.ref, 'support_ticket', left(p_title, 200), left(p_message, 500), p_ticket.tenant_id);
$$;

create or replace function public.support_ticket_row(t public.support_tickets, p_handler boolean)
 returns jsonb language sql stable security definer set search_path to 'public'
as $$
 select jsonb_build_object('id', t.id, 'ref', t.ref, 'subject', t.subject, 'category', t.category, 'priority', t.priority,
  'status', t.status, 'requesterName', t.requester_name, 'requesterRole', t.requester_role,
  'requesterEmail', case when p_handler then t.requester_email else null end,
  'agencyName', (select a.name from public.agencies a where a.id = t.agency_id),
  'studentId', t.student_id, 'studentName', (select s.full_name from public.enrollment_students s where s.id = t.student_id),
  'assignedName', t.assigned_name, 'assignedToMe', t.assigned_to = auth.uid(),
  'createdAt', t.created_at, 'updatedAt', t.updated_at, 'lastMessageAt', t.last_message_at,
  'unread', case when p_handler then t.staff_read_at is null or t.last_requester_activity_at > t.staff_read_at
                 else t.last_staff_activity_at is not null and t.last_staff_activity_at > t.requester_read_at end);
$$;

-- Create a ticket (students, agents, agency admins).
create or replace function public.support_ticket_create(p_category text, p_subject text, p_body text, p_priority text default 'normal',
 p_attachments jsonb default '[]'::jsonb, p_student uuid default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_id jsonb := public.portal_identity(); v_role text := v_id->>'role'; v_profile uuid := (v_id->>'profile_id')::uuid;
 v_agency uuid := (v_id->>'agency_id')::uuid; v_student uuid; v_name text; v_email text; t public.support_tickets; v_files jsonb;
begin
 if auth.uid() is null or v_role is null or v_role not in ('student','agent','agency_admin') then
  raise exception 'Only students and agents can raise tickets here' using errcode = '42501'; end if;
 if p_category not in ('enrolment_documents','fees_payments','course_training') then raise exception 'Choose a category' using errcode = '22023'; end if;
 if char_length(btrim(coalesce(p_subject, ''))) < 3 then raise exception 'Add a short subject' using errcode = '22023'; end if;
 if char_length(btrim(coalesce(p_body, ''))) < 1 then raise exception 'Describe the issue' using errcode = '22023'; end if;
 if coalesce(p_priority, 'normal') not in ('low','normal','high','urgent') then raise exception 'Invalid priority' using errcode = '22023'; end if;
 perform pg_advisory_xact_lock(hashtext('support_create:' || auth.uid()::text));
 if (select count(*) from public.support_tickets where requester_user = auth.uid() and created_at > now() - interval '1 hour') >= 10 then
  raise exception 'Too many tickets in the last hour. Try again later.' using errcode = '54000'; end if;
 if v_role = 'student' then v_student := (v_id->>'student_id')::uuid;
 elsif p_student is not null then
  if not exists (select 1 from public.enrollment_students s where s.id = p_student and s.agency_id = v_agency) then
   raise exception 'Student not found' using errcode = '22023'; end if;
  v_student := p_student;
 end if;
 select coalesce(nullif(btrim(p.full_name), ''), p.email, ''), coalesce(p.email, '') into v_name, v_email from public.portal_profiles p where p.id = v_profile;
 v_files := public.support_clean_attachments(p_attachments);
 insert into public.support_tickets(tenant_id, requester_user, requester_profile, requester_role, requester_name, requester_email, agency_id,
  student_id, category, subject, priority)
 values ((v_id->>'tenant_id')::uuid, auth.uid(), v_profile, v_role, coalesce(v_name, ''), coalesce(v_email, ''), v_agency, v_student,
  p_category, btrim(p_subject), coalesce(p_priority, 'normal')) returning * into t;
 insert into public.support_ticket_messages(ticket_id, author_user, author_name, body, attachments)
 values (t.id, auth.uid(), t.requester_name, btrim(p_body), v_files);
 return jsonb_build_object('id', t.id, 'ref', t.ref);
end $$;

-- List tickets visible to the caller. Handlers: p_scope 'all' | 'mine' (assigned to me) | 'unassigned'.
create or replace function public.support_ticket_list(p_status text default null, p_search text default null, p_scope text default 'all',
 p_limit integer default 50, p_offset integer default 0)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare v_handler boolean := public.support_is_handler(); v_search text := nullif(btrim(coalesce(p_search, '')), ''); v_total bigint; v_rows jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
 with visible as (
  select t as tk, t.last_message_at as lm from public.support_tickets t
  where public.support_can_view(t)
   and (p_status is null or p_status = '' or (p_status = 'active' and t.status in ('open','in_progress','waiting')) or t.status = p_status)
   and (not v_handler or coalesce(p_scope, 'all') = 'all' or (p_scope = 'mine' and t.assigned_to = auth.uid()) or (p_scope = 'unassigned' and t.assigned_to is null))
   and (v_search is null or t.ref ilike '%' || v_search || '%' or t.subject ilike '%' || v_search || '%' or t.requester_name ilike '%' || v_search || '%')),
 numbered as (select tk, lm, row_number() over (order by lm desc) as rn from visible)
 select count(*), coalesce(jsonb_agg(public.support_ticket_row(tk, v_handler) order by lm desc)
   filter (where rn > coalesce(p_offset, 0) and rn <= coalesce(p_offset, 0) + least(greatest(coalesce(p_limit, 50), 1), 200)), '[]'::jsonb)
 into v_total, v_rows
 from numbered;
 return jsonb_build_object('total', v_total, 'rows', v_rows, 'isHandler', v_handler);
end $$;

-- One ticket with its thread; marks it read for the caller's side.
create or replace function public.support_ticket_detail(p_ticket uuid)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare t public.support_tickets; v_handler boolean := public.support_is_handler(); v_msgs jsonb;
begin
 select * into t from public.support_tickets where id = p_ticket;
 if not found or not public.support_can_view(t) then raise exception 'Ticket not found' using errcode = 'P0002'; end if;
 if v_handler then update public.support_tickets set staff_read_at = now() where id = t.id;
 elsif t.requester_user = auth.uid() then update public.support_tickets set requester_read_at = now() where id = t.id; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'authorName', m.author_name, 'fromStaff', m.from_staff,
   'internal', m.internal, 'body', m.body, 'attachments', m.attachments, 'createdAt', m.created_at) order by m.created_at), '[]'::jsonb)
 into v_msgs from public.support_ticket_messages m where m.ticket_id = t.id and (v_handler or not m.internal);
 return jsonb_build_object('ticket', public.support_ticket_row(t, v_handler), 'messages', v_msgs, 'isHandler', v_handler,
  'isRequester', t.requester_user = auth.uid(), 'canReply', t.status <> 'closed');
end $$;

-- Reply. Handlers may add internal notes. A handler reply moves an open ticket to 'waiting' (on requester);
-- a requester reply reopens a waiting or resolved ticket.
create or replace function public.support_ticket_reply(p_ticket uuid, p_body text, p_internal boolean default false, p_attachments jsonb default '[]'::jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare t public.support_tickets; v_handler boolean := public.support_is_handler(); v_name text; v_files jsonb; v_internal boolean := coalesce(p_internal, false);
begin
 select * into t from public.support_tickets where id = p_ticket for update;
 if not found or not public.support_can_view(t) then raise exception 'Ticket not found' using errcode = 'P0002'; end if;
 if t.status = 'closed' then raise exception 'This ticket is closed. Raise a new ticket.' using errcode = '22023'; end if;
 if char_length(btrim(coalesce(p_body, ''))) < 1 then raise exception 'Write a reply' using errcode = '22023'; end if;
 if v_internal and not v_handler then raise exception 'Only administrators can add internal notes' using errcode = '42501'; end if;
 v_files := public.support_clean_attachments(p_attachments);
 select coalesce(nullif(btrim(p.full_name), ''), auth.jwt()->>'email', 'User') into v_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1;
 if v_handler then
  v_name := coalesce((select nullif(btrim(u.name), '') from public.cms_users u where u.auth_user_id = auth.uid() limit 1), v_name, auth.jwt()->>'email', 'Skyline support');
 end if;
 insert into public.support_ticket_messages(ticket_id, author_user, author_name, from_staff, internal, body, attachments)
 values (t.id, auth.uid(), coalesce(v_name, 'User'), v_handler, v_internal, btrim(p_body), v_files);
 if v_internal then
  update public.support_tickets set updated_at = now(), staff_read_at = now() where id = t.id;
 elsif v_handler then
  update public.support_tickets set status = case when status in ('open','in_progress') then 'waiting' else status end,
   last_message_at = now(), last_staff_activity_at = now(), staff_read_at = now(), updated_at = now() where id = t.id returning * into t;
  perform public.support_notify_requester(t, 'Reply on ' || t.ref, t.subject);
 else
  update public.support_tickets set status = case when status in ('waiting','resolved') then 'open' else status end,
   resolved_at = case when status = 'resolved' then null else resolved_at end,
   last_message_at = now(), last_requester_activity_at = now(), requester_read_at = now(), updated_at = now() where id = t.id;
 end if;
 return jsonb_build_object('ok', true);
end $$;

-- Status / priority / assignment. Handlers: any status, priority, assign to me or unassign.
-- Requesters: may mark their own ticket resolved or closed.
create or replace function public.support_ticket_update(p_ticket uuid, p_status text default null, p_priority text default null, p_assign text default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare t public.support_tickets; v_handler boolean := public.support_is_handler(); v_events text[] := '{}'; v_label text;
 v_me text := coalesce((select nullif(btrim(u.name), '') from public.cms_users u where u.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', 'Administrator');
begin
 select * into t from public.support_tickets where id = p_ticket for update;
 if not found or not public.support_can_view(t) then raise exception 'Ticket not found' using errcode = 'P0002'; end if;
 if not v_handler then
  if t.requester_user <> auth.uid() or p_status is null or p_status not in ('resolved','closed') or p_priority is not null or p_assign is not null then
   raise exception 'Not authorized' using errcode = '42501'; end if;
 end if;
 if p_status is not null and p_status not in ('open','in_progress','waiting','resolved','closed') then raise exception 'Invalid status' using errcode = '22023'; end if;
 if p_priority is not null and p_priority not in ('low','normal','high','urgent') then raise exception 'Invalid priority' using errcode = '22023'; end if;
 if p_assign is not null and p_assign not in ('me','none') then raise exception 'Invalid assignment' using errcode = '22023'; end if;
 if p_status is not null and p_status <> t.status then
  v_label := case p_status when 'open' then 'Open' when 'in_progress' then 'In progress' when 'waiting' then 'Waiting on requester' when 'resolved' then 'Resolved' else 'Closed' end;
  update public.support_tickets set status = p_status, updated_at = now(),
   resolved_at = case when p_status = 'resolved' then now() when p_status in ('open','in_progress','waiting') then null else resolved_at end,
   closed_at = case when p_status = 'closed' then now() else null end,
   last_staff_activity_at = case when v_handler then now() else last_staff_activity_at end
  where id = t.id returning * into t;
  v_events := v_events || ('Status changed to ' || v_label);
  if v_handler then perform public.support_notify_requester(t, t.ref || ': ' || v_label, t.subject); end if;
 end if;
 if p_priority is not null and p_priority <> t.priority then
  update public.support_tickets set priority = p_priority, updated_at = now() where id = t.id returning * into t;
  v_events := v_events || ('Priority set to ' || initcap(p_priority));
 end if;
 if p_assign = 'me' and t.assigned_to is distinct from auth.uid() then
  update public.support_tickets set assigned_to = auth.uid(), assigned_name = v_me, updated_at = now() where id = t.id returning * into t;
  v_events := v_events || ('Assigned to ' || v_me);
 elsif p_assign = 'none' and t.assigned_to is not null then
  update public.support_tickets set assigned_to = null, assigned_name = null, updated_at = now() where id = t.id returning * into t;
  v_events := v_events || 'Unassigned'::text;
 end if;
 if array_length(v_events, 1) > 0 then
  insert into public.support_ticket_messages(ticket_id, kind, author_user, author_name, from_staff, internal, body)
  values (t.id, 'event', auth.uid(), case when v_handler then v_me else t.requester_name end, v_handler,
   p_status is null and v_handler, array_to_string(v_events, '. ') || '.');
 end if;
 return public.support_ticket_row(t, v_handler);
end $$;

-- Badge counts: handlers = active tickets with unread requester activity; others = tickets with unread staff replies.
create or replace function public.support_unread_count()
 returns integer language sql stable security definer set search_path to 'public'
as $$
 select count(*)::integer from public.support_tickets t
 where public.support_can_view(t) and case when public.support_is_handler()
   then t.status in ('open','in_progress','waiting') and (t.staff_read_at is null or t.last_requester_activity_at > t.staff_read_at)
   else t.requester_user = auth.uid() and t.last_staff_activity_at is not null and t.last_staff_activity_at > t.requester_read_at end;
$$;

-- Students an agent can raise a ticket about (agency admins: the whole agency).
create or replace function public.support_ticket_students()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare v_agency uuid := public.portal_agency_id();
begin
 if auth.uid() is null or v_agency is null or public.portal_student_id() is not null then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.full_name) order by s.full_name)
  from public.enrollment_students s where s.agency_id = v_agency and s.status = 'Active' and coalesce(btrim(s.full_name), '') <> ''), '[]'::jsonb);
end $$;

-- Private attachment bucket (10 MB, documents and images).
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('support-attachments', 'support-attachments', false, 10485760,
 array['application/pdf','image/png','image/jpeg','image/webp','text/plain',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

create or replace function public.support_attachment_readable(p_name text)
 returns boolean language sql stable security definer set search_path to 'public'
as $$
 select auth.uid() is not null and (split_part(p_name, '/', 1) = auth.uid()::text or exists (
  select 1 from public.support_ticket_messages m join public.support_tickets t on t.id = m.ticket_id
  where m.attachments @> jsonb_build_array(jsonb_build_object('path', p_name))
   and public.support_can_view(t) and (not m.internal or public.support_is_handler())));
$$;

drop policy if exists support_attachments_insert on storage.objects;
create policy support_attachments_insert on storage.objects for insert to authenticated
 with check (bucket_id = 'support-attachments' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists support_attachments_read on storage.objects;
create policy support_attachments_read on storage.objects for select to authenticated
 using (bucket_id = 'support-attachments' and public.support_attachment_readable(name));

revoke all on function public.support_is_handler(), public.support_can_view(public.support_tickets), public.support_clean_attachments(jsonb),
 public.support_notify_requester(public.support_tickets, text, text), public.support_ticket_row(public.support_tickets, boolean),
 public.support_attachment_readable(text) from public, anon, authenticated;
grant execute on function public.support_attachment_readable(text) to authenticated;
revoke all on function public.support_ticket_create(text, text, text, text, jsonb, uuid), public.support_ticket_list(text, text, text, integer, integer),
 public.support_ticket_detail(uuid), public.support_ticket_reply(uuid, text, boolean, jsonb), public.support_ticket_update(uuid, text, text, text),
 public.support_unread_count(), public.support_ticket_students() from public, anon;
grant execute on function public.support_ticket_create(text, text, text, text, jsonb, uuid), public.support_ticket_list(text, text, text, integer, integer),
 public.support_ticket_detail(uuid), public.support_ticket_reply(uuid, text, boolean, jsonb), public.support_ticket_update(uuid, text, text, text),
 public.support_unread_count(), public.support_ticket_students() to authenticated;

-- CMS menu: Tickets (top level, after Students).
insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, permission_key, permission_scope, is_system)
values ('support_tickets', null, 'Tickets', '/admin/tickets', 'tickets', 25, 'cms.admin', 'current', true)
on conflict (id) do nothing;
