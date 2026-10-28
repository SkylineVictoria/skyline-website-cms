-- Notification log for administrators: who was (or will be) emailed, and whether it was sent. Read-only; no gate, activation or sender rule changes.
-- notification_deliveries is readable only by the service role, so the CMS reads it through these two administrator-only functions.
--   notification_log_query(...)  one page of deliveries for the caller's scope (the main site, or the institution being administered), filtered in the query:
--                                event, status group, date range and application; recipient role resolved as agent / agency admin / internal / student.
--   notification_gate_state()    the first closed gate the database can see (activation, worker, sender, vault key); edge secrets live outside the
--                                database, so a missing provider secret shows up as failed deliveries (provider_unavailable) instead.
-- Rollback / compensation (additive): drop function public.notification_log_query(text, text, timestamptz, timestamptz, uuid, integer, integer), public.notification_gate_state().
-- Apply with the normal reviewed release process; it must not be assumed applied. Until it is, the CMS pages show a "not available yet" notice.
begin;

create function public.notification_log_query(
  p_event text default '', p_status text default '', p_from timestamptz default null, p_to timestamptz default null,
  p_application uuid default null, p_limit integer default 25, p_offset integer default 0
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := public.tenant_current(); v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100); v_offset integer := greatest(coalesce(p_offset, 0), 0); v_total bigint; v_rows jsonb;
begin
  if auth.uid() is null or not public.portal_is_slit_admin() then raise exception 'Administrator access required' using errcode = '42501'; end if;
  if coalesce(p_event, '') not in ('', 'application_submitted', 'application_status_changed', 'offer_accepted', 'coe_voe_issued') then raise exception 'Unknown event' using errcode = '22023'; end if;
  if coalesce(p_status, '') not in ('', 'queued', 'sent', 'failed', 'blocked') then raise exception 'Unknown status' using errcode = '22023'; end if;
  with f as (
    select d.*, a.reference, a.student_email, a.assigned_agent_id,
      case d.state when 'pending' then 'queued' when 'sending' then 'queued' when 'sent' then 'sent' when 'delivered' then 'sent'
        when 'suppressed' then 'blocked' else 'failed' end as status_group
    from public.notification_deliveries d join public.enrollment_applications a on a.id = d.application_id
    where d.tenant_id is not distinct from v_tenant
      and (coalesce(p_event, '') = '' or d.event = p_event)
      and (p_application is null or d.application_id = p_application)
      and (p_from is null or d.created_at >= p_from) and (p_to is null or d.created_at < p_to)
  )
  select count(*) into v_total from f where coalesce(p_status, '') = '' or f.status_group = p_status;
  with f as (
    select d.*, a.reference, a.student_email,
      case d.state when 'pending' then 'queued' when 'sending' then 'queued' when 'sent' then 'sent' when 'delivered' then 'sent'
        when 'suppressed' then 'blocked' else 'failed' end as status_group
    from public.notification_deliveries d join public.enrollment_applications a on a.id = d.application_id
    where d.tenant_id is not distinct from v_tenant
      and (coalesce(p_event, '') = '' or d.event = p_event)
      and (p_application is null or d.application_id = p_application)
      and (p_from is null or d.created_at >= p_from) and (p_to is null or d.created_at < p_to)
  ), page as (
    select * from f where coalesce(p_status, '') = '' or f.status_group = p_status order by f.seq desc limit v_limit offset v_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'at', page.created_at, 'event', page.event, 'applicationId', page.application_id, 'reference', page.reference,
    'recipient', page.recipient_email,
    'role', case when page.recipient_user is not null
        then coalesce((select case when m.role = 'agency_admin' then 'agency admin' else 'agent' end from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id where p.auth_user_id = page.recipient_user limit 1), 'agent')
        when lower(page.recipient_email) = lower(coalesce(page.student_email, '')) then 'student' else 'internal' end,
    'status', page.status_group, 'state', page.state, 'reason', page.state_reason, 'attempts', page.attempt_count, 'error', page.last_error_code, 'sentAt', page.sent_at
  ) order by page.seq desc), '[]'::jsonb) into v_rows from page;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;
revoke all on function public.notification_log_query(text, text, timestamptz, timestamptz, uuid, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.notification_log_query(text, text, timestamptz, timestamptz, uuid, integer, integer) to authenticated;

create function public.notification_gate_state() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := public.tenant_current(); v_gate text := null; v_msg text := null; v_sender text; v_job boolean;
begin
  if auth.uid() is null or not public.portal_is_slit_admin() then raise exception 'Administrator access required' using errcode = '42501'; end if;
  v_sender := public.notification_resolve_sender(v_tenant) ->> 'email';
  select active into v_job from cron.job where jobname = 'notification-delivery-worker' order by jobid limit 1;
  if not exists (select 1 from public.notification_activation where tenant_id is not distinct from v_tenant and revoked_at is null) then
    v_gate := 'activation'; v_msg := 'sending has not been approved (no active activation)';
  elsif v_sender is null or not public.notification_sender_allowed(v_tenant, v_sender) then
    v_gate := 'sender'; v_msg := 'the sender address is not approved';
  elsif not exists (select 1 from vault.decrypted_secrets where name = 'notification_service_role_key') then
    v_gate := 'vault_key'; v_msg := 'the worker key is not stored';
  elsif coalesce(v_job, false) is not true then
    v_gate := 'worker'; v_msg := 'the delivery worker is switched off';
  end if;
  return jsonb_build_object('active', v_gate is null, 'blockedBy', v_gate, 'message', v_msg);
end;
$$;
revoke all on function public.notification_gate_state() from public, anon, authenticated, service_role;
grant execute on function public.notification_gate_state() to authenticated;

commit;
