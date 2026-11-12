-- TKT-01: email on ticket replies and status changes, through the existing notification queue and worker.
--
-- Who gets an email (one email per address, never duplicated):
--   * a reply (not an internal note): the person who opened the ticket, the person who replied, and every active CMS Admin;
--   * an internal note: the person who wrote it and every active CMS Admin (never the requester);
--   * a status change: the person who opened the ticket, the person who changed it, and every active CMS Admin.
-- Opening a ticket and priority / assignment changes send nothing new.
--
-- notification_deliveries was application-only; a ticket email has no application or outbox row, so both columns become
-- optional and support_ticket_id says which ticket it is about. The delivery worker already sends any pending row.
alter table public.notification_deliveries alter column outbox_id drop not null;
alter table public.notification_deliveries alter column application_id drop not null;
alter table public.notification_deliveries add column if not exists support_ticket_id uuid references public.support_tickets(id) on delete set null;
alter table public.notification_deliveries add constraint notification_deliveries_subject_ref
  check (application_id is not null or support_ticket_id is not null or event like 'support_ticket%') not valid;
create index if not exists notification_deliveries_support_ticket_idx on public.notification_deliveries(support_ticket_id) where support_ticket_id is not null;

-- The site the links in ticket emails point at.
create or replace function public.support_site_origin() returns text language sql immutable as $$ select 'https://skyline-website-cms.vercel.app' $$;

create or replace function public.support_ticket_email_after_message()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
  t public.support_tickets;
  v_kind text;
  v_status text;
  v_actor_email text;
  v_actor_is_staff boolean;
  v_active boolean;
  v_state text;
  v_reason text;
  v_subject text;
  v_intro text;
  v_body text;
  r record;
begin
  select * into t from public.support_tickets where id = new.ticket_id;
  if not found then return new; end if;

  if new.kind = 'message' then
    -- The first message is the ticket being opened: no email for that.
    if not exists (select 1 from public.support_ticket_messages m where m.ticket_id = new.ticket_id and m.id <> new.id) then return new; end if;
    v_kind := case when new.internal then 'note' else 'reply' end;
  elsif new.kind = 'event' and new.body ~ 'Status changed to ' then
    v_kind := 'status';
    v_status := substring(new.body from 'Status changed to ([^.]+)');
  else
    return new;  -- priority / assignment changes
  end if;

  select lower(btrim(u.email)) into v_actor_email from auth.users u where u.id = new.author_user;
  v_actor_is_staff := coalesce(new.from_staff, false);

  v_subject := case v_kind
    when 'reply'  then t.ref || ': new reply from ' || new.author_name
    when 'note'   then t.ref || ': internal note from ' || new.author_name
    else               t.ref || ': status changed to ' || coalesce(v_status, t.status) end;
  v_intro := case v_kind
    when 'reply'  then new.author_name || E' replied:\n\n' || left(new.body, 4000)
    when 'note'   then new.author_name || E' added an internal note (not visible to the requester):\n\n' || left(new.body, 4000)
    else               new.author_name || ' changed the status to ' || coalesce(v_status, t.status) || '.' end;

  v_active := exists (select 1 from public.notification_activation a where a.revoked_at is null and a.tenant_id is not distinct from t.tenant_id);
  v_state := case when v_active then 'pending' else 'suppressed' end;
  v_reason := case when v_active then null else 'legacy_scope_not_activated' end;

  for r in
    with people(email, staff) as (
      select lower(btrim(t.requester_email)), false where v_kind <> 'note'
      union all
      select v_actor_email, v_actor_is_staff
      union all
      select lower(btrim(c.email)), true from public.cms_users c where c.status = 'Active' and c.role = 'Admin'
    )
    select email, bool_or(staff) as staff from people
    where email is not null and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    group by email
  loop
    v_body := v_intro || E'\n\n'
      || 'Ticket: ' || t.ref || ' - ' || t.subject || E'\n'
      || case when v_kind = 'status' then 'New status: ' || coalesce(v_status, t.status) || E'\n' else '' end
      || 'Opened by: ' || coalesce(nullif(t.requester_name, ''), t.requester_email) || E'\n\n'
      || 'Open the ticket (sign-in required): ' || public.support_site_origin()
      || case when r.staff then '/admin/tickets/' else '/agency/tickets/' end || t.id::text || E'\n\n'
      || 'You are receiving this because you opened, answered or manage this ticket.';
    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, support_ticket_id, recipient_user, recipient_email,
      event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
    values (null, t.tenant_id, null, t.id, null, r.email,
      'support_ticket_' || v_kind, 'default', null, null, left(v_subject, 200), v_body, v_state, v_reason, clock_timestamp());
  end loop;
  return new;
end $$;

revoke all on function public.support_ticket_email_after_message() from public, anon, authenticated;

drop trigger if exists support_ticket_email on public.support_ticket_messages;
create trigger support_ticket_email after insert on public.support_ticket_messages
  for each row execute function public.support_ticket_email_after_message();
