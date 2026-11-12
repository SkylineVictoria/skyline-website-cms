-- TKT-01: professional (HTML) ticket emails with the ticket summary, what changed and the full history.
-- Ticket emails are now sent by their own small Edge Function (support-ticket-mail), so the application email worker
-- (notification-delivery) and its PDF code are untouched; that worker no longer claims support_ticket_* deliveries.

alter table public.notification_deliveries add column if not exists html_body text;

create or replace function public.support_html(p text) returns text language sql immutable as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

create or replace function public.support_status_label(p text) returns text language sql immutable as $$
  select case p when 'open' then 'Open' when 'in_progress' then 'In progress' when 'waiting' then 'Waiting on requester'
    when 'resolved' then 'Resolved' when 'closed' then 'Closed' else initcap(replace(coalesce(p, ''), '_', ' ')) end
$$;

create or replace function public.support_category_label(p text) returns text language sql immutable as $$
  select case p when 'enrolment_documents' then 'Enrolment & documents' when 'fees_payments' then 'Fees & payments'
    when 'course_training' then 'Course & training' when 'other' then 'Other' else coalesce(p, '') end
$$;

create or replace function public.support_ticket_email_after_message()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
  t public.support_tickets;
  v_kind text; v_status_text text; v_status_now text;
  v_actor_email text; v_actor_is_staff boolean;
  v_active boolean; v_state text; v_reason text;
  v_tz text; v_site text := public.support_site_origin();
  v_subject text; v_headline text; v_change_text text; v_change_html text;
  v_link text; v_text text; v_html text; v_hist_text text; v_hist_html text; v_rows text;
  r record;
begin
  select * into t from public.support_tickets where id = new.ticket_id;
  if not found then return new; end if;

  if new.kind = 'message' then
    if not exists (select 1 from public.support_ticket_messages m where m.ticket_id = new.ticket_id and m.id <> new.id) then return new; end if;
    v_kind := case when new.internal then 'note' else 'reply' end;
  elsif new.kind = 'event' and new.body ~ 'Status changed to ' then
    v_kind := 'status';
    v_status_text := substring(new.body from 'Status changed to ([^.]+)');
  else
    return new;  -- priority / assignment changes
  end if;

  -- The status the ticket will have once this action finishes (a reply moves it on right after this row is written).
  v_status_now := case
    when v_kind = 'reply' and new.from_staff and t.status in ('open', 'in_progress') then 'waiting'
    when v_kind = 'reply' and not new.from_staff and t.status in ('waiting', 'resolved') then 'open'
    else t.status end;

  select lower(btrim(u.email)) into v_actor_email from auth.users u where u.id = new.author_user;
  v_actor_is_staff := coalesce(new.from_staff, false);
  v_tz := coalesce((select s.timezone from public.cms_settings s where s.tenant_id is not distinct from t.tenant_id limit 1), 'Australia/Sydney');

  v_subject := case v_kind
    when 'reply'  then '[' || t.ref || '] New reply: ' || t.subject
    when 'note'   then '[' || t.ref || '] Internal note: ' || t.subject
    else               '[' || t.ref || '] Status changed to ' || coalesce(v_status_text, public.support_status_label(t.status)) || ': ' || t.subject end;
  v_headline := case v_kind
    when 'reply'  then new.author_name || ' replied to ticket ' || t.ref
    when 'note'   then new.author_name || ' added an internal note to ticket ' || t.ref
    else               new.author_name || ' changed the status of ticket ' || t.ref || ' to ' || coalesce(v_status_text, public.support_status_label(t.status)) end;
  v_change_text := case when v_kind = 'status' then '' else left(new.body, 4000) end;

  v_active := exists (select 1 from public.notification_activation a where a.revoked_at is null and a.tenant_id is not distinct from t.tenant_id);
  v_state := case when v_active then 'pending' else 'suppressed' end;
  v_reason := case when v_active then null else 'legacy_scope_not_activated' end;

  for r in
    with people(email, staff) as (
      select lower(btrim(t.requester_email)), false where v_kind <> 'note'
      union all select v_actor_email, v_actor_is_staff
      union all select nr.email, true from public.support_notification_recipients nr
    )
    select email, bool_or(staff) as staff from people
    where email is not null and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    group by email
  loop
    v_link := v_site || case when r.staff then '/admin/tickets/' else '/agency/tickets/' end || t.id::text;

    -- History, newest first; internal notes only for staff copies.
    select
      string_agg(to_char(m.created_at at time zone v_tz, 'DD Mon YYYY HH24:MI') || ' - ' || m.author_name
        || case when m.internal then ' (internal note)' when m.kind = 'event' then '' else '' end || E':\n'
        || left(m.body, 2000), E'\n\n' order by m.created_at desc),
      string_agg(
        '<tr><td style="padding:12px 0;border-top:1px solid #ececec;">'
        || '<div style="font-size:13px;color:#6b7280;">' || public.support_html(to_char(m.created_at at time zone v_tz, 'DD Mon YYYY, HH24:MI'))
        || ' &middot; <strong style="color:#111827;">' || public.support_html(m.author_name) || '</strong>'
        || case when m.internal then ' <span style="background:#fef3c7;color:#92400e;border-radius:10px;padding:1px 8px;font-size:11px;">Internal note</span>'
                when m.from_staff and m.kind = 'message' then ' <span style="background:#ffedd5;color:#9a3412;border-radius:10px;padding:1px 8px;font-size:11px;">Skyline</span>'
                else '' end
        || '</div>'
        || case when m.kind = 'event'
             then '<div style="margin-top:4px;font-size:14px;color:#374151;font-style:italic;">' || public.support_html(m.body) || '</div>'
             else '<div style="margin-top:6px;font-size:14px;line-height:1.55;color:#111827;white-space:pre-wrap;">' || replace(public.support_html(left(m.body, 2000)), E'\n', '<br>') || '</div>' end
        || '</td></tr>', '' order by m.created_at desc)
    into v_hist_text, v_hist_html
    from (select * from public.support_ticket_messages x
          where x.ticket_id = t.id and (r.staff or not x.internal)
          order by x.created_at desc limit 25) m;

    v_text := v_headline || '.' || E'\n\n'
      || case when v_change_text <> '' then v_change_text || E'\n\n' else '' end
      || 'Ticket:     ' || t.ref || ' - ' || t.subject || E'\n'
      || 'Status:     ' || public.support_status_label(v_status_now) || E'\n'
      || 'Category:   ' || public.support_category_label(t.category) || E'\n'
      || 'Priority:   ' || initcap(t.priority) || E'\n'
      || 'Opened by:  ' || coalesce(nullif(t.requester_name, ''), t.requester_email) || ' on ' || to_char(t.created_at at time zone v_tz, 'DD Mon YYYY') || E'\n'
      || case when t.assigned_name is not null then 'Assigned to: ' || t.assigned_name || E'\n' else '' end
      || E'\nView the ticket (sign-in required): ' || v_link || E'\n\n'
      || E'--- Ticket history (newest first) ---\n\n' || coalesce(v_hist_text, '') || E'\n\n'
      || 'Skyline Institute of Technology' || E'\n'
      || 'You are receiving this because you opened, answered or are subscribed to this ticket.';

    v_change_html := case when v_change_text <> ''
      then '<div style="margin:16px 0 0;padding:14px 16px;background:#fff7ed;border-left:4px solid #ea6619;border-radius:6px;font-size:14px;line-height:1.6;color:#111827;white-space:pre-wrap;">'
           || replace(public.support_html(v_change_text), E'\n', '<br>') || '</div>'
      else '' end;

    v_rows := '<tr><td style="padding:6px 0;color:#6b7280;width:120px;">Ticket</td><td style="padding:6px 0;color:#111827;font-weight:600;">' || public.support_html(t.ref) || '</td></tr>'
      || '<tr><td style="padding:6px 0;color:#6b7280;">Subject</td><td style="padding:6px 0;color:#111827;">' || public.support_html(t.subject) || '</td></tr>'
      || '<tr><td style="padding:6px 0;color:#6b7280;">Status</td><td style="padding:6px 0;"><span style="background:#e0f2fe;color:#075985;border-radius:10px;padding:2px 10px;font-size:13px;font-weight:600;">' || public.support_html(public.support_status_label(v_status_now)) || '</span></td></tr>'
      || '<tr><td style="padding:6px 0;color:#6b7280;">Category</td><td style="padding:6px 0;color:#111827;">' || public.support_html(public.support_category_label(t.category)) || '</td></tr>'
      || '<tr><td style="padding:6px 0;color:#6b7280;">Priority</td><td style="padding:6px 0;color:#111827;">' || public.support_html(initcap(t.priority)) || '</td></tr>'
      || '<tr><td style="padding:6px 0;color:#6b7280;">Opened by</td><td style="padding:6px 0;color:#111827;">' || public.support_html(coalesce(nullif(t.requester_name, ''), t.requester_email)) || ' &middot; ' || public.support_html(to_char(t.created_at at time zone v_tz, 'DD Mon YYYY')) || '</td></tr>'
      || case when t.assigned_name is not null then '<tr><td style="padding:6px 0;color:#6b7280;">Assigned to</td><td style="padding:6px 0;color:#111827;">' || public.support_html(t.assigned_name) || '</td></tr>' else '' end;

    v_html := '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' || public.support_html(v_subject) || '</title></head>'
      || '<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">'
      || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">'
      || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">'
      || '<tr><td style="background:#ea6619;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700;">Skyline Institute of Technology<div style="font-size:13px;font-weight:400;opacity:.9;margin-top:2px;">Support ticket update</div></td></tr>'
      || '<tr><td style="padding:24px;">'
      || '<h1 style="margin:0;font-size:20px;line-height:1.35;color:#111827;">' || public.support_html(v_headline) || '</h1>'
      || v_change_html
      || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:20px;font-size:14px;">' || v_rows || '</table>'
      || '<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:22px;"><tr><td style="background:#ea6619;border-radius:6px;">'
      || '<a href="' || public.support_html(v_link) || '" style="display:inline-block;padding:11px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">View ticket</a></td></tr></table>'
      || '<h2 style="margin:30px 0 4px;font-size:15px;color:#111827;">Ticket history</h2>'
      || '<table role="presentation" width="100%" cellspacing="0" cellpadding="0">' || coalesce(v_hist_html, '') || '</table>'
      || '</td></tr>'
      || '<tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280;">'
      || 'You are receiving this because you opened, answered or are subscribed to this ticket. Please reply through the ticket page; replies to this email are not monitored.'
      || '<br>Skyline Institute of Technology &middot; RTO 45989 &middot; CRICOS 04114B</td></tr>'
      || '</table></td></tr></table></body></html>';

    insert into public.notification_deliveries(outbox_id, tenant_id, application_id, support_ticket_id, recipient_user, recipient_email,
      event, template_source, template_version_id, sender, subject, body, html_body, state, state_reason, created_at)
    values (null, t.tenant_id, null, t.id, null, r.email,
      'support_ticket_' || v_kind, 'default', null, null, left(v_subject, 200), v_text, v_html, v_state, v_reason, clock_timestamp());
  end loop;
  return new;
end $$;
revoke all on function public.support_ticket_email_after_message() from public, anon, authenticated;

-- The application worker leaves ticket emails to support-ticket-mail.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.notification_claim_delivery()'::regprocedure);
  n := replace(d, $o$where x.state = 'pending' and x.next_attempt_at <= now()$o$,
                  $o$where x.state = 'pending' and x.next_attempt_at <= now() and x.event not like 'support_ticket%'$o$);
  if n = d then raise exception 'notification_claim_delivery: anchor not found, nothing changed'; end if;
  execute n;
end $mig$;

-- Claim for support-ticket-mail: same rules as notification_claim_delivery, ticket emails only (service_role only).
create or replace function public.support_mail_claim()
 returns setof public.notification_deliveries language plpgsql security definer set search_path to 'public'
as $$
declare d public.notification_deliveries;
begin
  perform public.notification_recover_stuck();
  select * into d from public.notification_deliveries x
  where x.state = 'pending' and x.next_attempt_at <= now() and x.event like 'support_ticket%'
    and (x.tenant_id is null or exists (select 1 from public.tenants tt where tt.id = x.tenant_id and tt.status = 'active'))
    and exists (select 1 from public.notification_activation a where a.revoked_at is null and a.tenant_id is not distinct from x.tenant_id and x.created_at >= a.approved_at)
  order by x.seq for update skip locked limit 1;
  if not found then return; end if;
  update public.notification_deliveries set state = 'sending', attempt_count = attempt_count + 1, lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '3 minutes', updated_at = now(), sender = public.notification_resolve_sender(d.tenant_id)
  where id = d.id returning * into d;
  return next d;
end $$;
revoke all on function public.support_mail_claim() from public, anon, authenticated;
grant execute on function public.support_mail_claim() to service_role;

-- Every minute: call support-ticket-mail only when a ticket email is due (same service key as the application worker).
create table if not exists public.support_mail_dispatch_state (id boolean primary key default true check (id), last_request_id bigint, last_dispatched_at timestamptz);
alter table public.support_mail_dispatch_state enable row level security;
revoke all on public.support_mail_dispatch_state from anon, authenticated;

create or replace function public.support_mail_dispatch()
 returns bigint language plpgsql security definer set search_path to 'public', 'vault', 'net'
as $$
declare v_key text; v_last public.support_mail_dispatch_state; v_id bigint;
begin
  if not pg_try_advisory_xact_lock(9342, 20261112) then return null; end if;
  if not exists (select 1 from public.notification_deliveries where state = 'pending' and next_attempt_at <= now() and event like 'support_ticket%') then return null; end if;
  select * into v_last from public.support_mail_dispatch_state;
  if v_last.last_request_id is not null and v_last.last_dispatched_at > now() - interval '5 minutes'
     and not exists (select 1 from net._http_response r where r.id = v_last.last_request_id) then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'notification_service_role_key' limit 1;
  if nullif(v_key, '') is null then return null; end if;
  v_id := net.http_post(
    url := 'https://xcpydisstlvtvcsqnjob.supabase.co/functions/v1/support-ticket-mail',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
  insert into public.support_mail_dispatch_state(id, last_request_id, last_dispatched_at) values (true, v_id, now())
  on conflict (id) do update set last_request_id = excluded.last_request_id, last_dispatched_at = excluded.last_dispatched_at;
  return v_id;
end $$;
revoke all on function public.support_mail_dispatch() from public, anon, authenticated;

select cron.schedule('support-ticket-mail', '* * * * *', 'select public.support_mail_dispatch();');
