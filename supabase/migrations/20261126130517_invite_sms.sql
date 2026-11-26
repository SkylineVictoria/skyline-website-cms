-- INVITE-SMS (owner, 2026-11-26): the student's application link (and a parent / guardian's signing link) also goes by text message
-- through the ClickSend connection (Integrations › Connections › ClickSend), sent by student-application-invite next to the email.
-- The link exists only inside that function, so it texts it; the database gives it the account settings and the mobile, and records
-- the outcome on the application's timeline (skyline_private.application_handoff_events: sms_sent / sms_failed / sms_skipped).
-- All three functions are service role only.

-- The organization's ClickSend account (username, API key, sender), or null when it is not connected.
create or replace function public.invite_sms_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when c.id is not null and c.status = 'connected' and nullif(btrim(coalesce(f->>'username', '')), '') is not null
      and nullif(btrim(coalesce(f->>'apiKey', '')), '') is not null
    then jsonb_build_object('username', f->>'username', 'apiKey', f->>'apiKey', 'from', nullif(btrim(coalesce(f->>'from', '')), '')) end
  from (select 1) one
  left join public.integration_connections c on c.connector_id = 'clicksend' and c.tenant_id is null
  left join lateral (select public.integration_comm_fields('clicksend') f) x on true;
$$;
revoke all on function public.invite_sms_settings() from public, anon, authenticated;
grant execute on function public.invite_sms_settings() to service_role;

-- Who a text for this invitation goes to: the student's mobile (the application's answer, else the student record), with their first
-- name; for a guardian request (p_kind 'guardian') the mobile the student entered for them.
create or replace function public.invite_sms_target(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if p_kind = 'guardian' then
    select jsonb_build_object('mobile', g.mobile, 'name', g.name, 'studentName', coalesce(nullif(btrim(a.student_name), ''), 'the student'), 'applicationId', a.id)
      into v from skyline_private.application_guardian_requests g join public.enrollment_applications a on a.id = g.application_id where g.id = p_id;
  else
    select jsonb_build_object('mobile', coalesce(nullif(btrim(a.data#>>'{values,mobile}'), ''), nullif(btrim(s.details->>'mobile'), ''), nullif(btrim(s.phone), ''), ''),
        'name', coalesce(nullif(btrim(a.data#>>'{values,first_name}'), ''), split_part(coalesce(nullif(btrim(s.full_name), ''), ''), ' ', 1)), 'applicationId', a.id)
      into v from skyline_private.student_application_invites i join public.enrollment_applications a on a.id = i.application_id
      left join public.enrollment_students s on s.id = a.student_id where i.id = p_id;
  end if;
  return v;
end $$;
revoke all on function public.invite_sms_target(text, uuid) from public, anon, authenticated;
grant execute on function public.invite_sms_target(text, uuid) to service_role;

-- The text's outcome on the application's timeline (no phone number or message body is stored, only the last three digits).
create or replace function public.invite_sms_record(p_application uuid, p_who text, p_outcome text, p_code text, p_last_digits text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_outcome not in ('sent', 'failed', 'skipped') or p_who not in ('student', 'guardian') then return; end if;
  perform skyline_private.handoff_log(p_application, 'sms_' || p_outcome,
    jsonb_strip_nulls(jsonb_build_object('to', p_who, 'code', nullif(left(regexp_replace(coalesce(p_code, ''), '[^a-z_]', '', 'g'), 40), ''),
      'endsWith', nullif(right(regexp_replace(coalesce(p_last_digits, ''), '[^0-9]', '', 'g'), 3), ''))), 'system', 'Text message');
end $$;
revoke all on function public.invite_sms_record(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.invite_sms_record(uuid, text, text, text, text) to service_role;
