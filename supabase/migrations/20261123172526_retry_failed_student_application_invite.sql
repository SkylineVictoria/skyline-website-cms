begin;

-- Both CRM and maintenance retries use the same published settings and send limits.
create function skyline_private.reserve_student_application_invite(
  a public.enrollment_applications, email_address text, p_hash text, p_actor uuid
) returns jsonb language plpgsql set search_path = '' as $$
declare
  invitation uuid;
  expiry int;
  send_limit int;
  sender text;
  template jsonb;
begin
  select
  -- rule-policy: business admissions.application_invite_hours Read the published validity period for the application scope.
    (coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_hours', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_hours', '{}')) #>> '{}')::int,
  -- rule-policy: business admissions.application_invite_resend_limit Read the published resend ceiling for the application scope.
    (coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_resend_limit', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_resend_limit', '{}')) #>> '{}')::int,
    coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_sender', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_sender', '{}')) #>> '{}',
    coalesce(nullif(public.business_rule_evaluate(coalesce(a.tenant_id::text, ''), 'admissions.application_invite_template', '{}'), 'null'),
       public.business_rule_evaluate('', 'admissions.application_invite_template', '{}'))
  into expiry, send_limit, sender, template;
  -- rule-policy: technical invitation-config-bounds Validate the supported range and required configuration already used by CRM.
  if expiry not between 1 and 720 or send_limit not between 1 and 30 or expiry is null or send_limit is null or not skyline_private.student_application_email_valid(sender)
     or coalesce(jsonb_typeof(template) <> 'object', true) then
    raise exception 'Publish the student invitation settings in Business Rules & Policies before sending' using errcode = '22023';
  end if;
  -- A timed-out Edge request may have reached the provider. A short lease prevents concurrent sends.
  update skyline_private.student_application_invites set state = 'failed'
  -- rule-policy: technical invitation-reservation-lease Recover a previously interrupted send through the existing fixed lease.
    where application_id = a.id and state = 'sending' and created_at < statement_timestamp() - interval '2 minutes';
  -- rule-policy: security invitation-reservation-concurrency Prevent overlapping attempts for the same application.
  if exists(select 1 from skyline_private.student_application_invites where application_id = a.id and state = 'sending') then
    raise exception 'An invitation is already sending. Check its status before trying again' using errcode = '22023';
  end if;
  -- rule-policy: business admissions.application_invite_resend_limit Enforce the published resend limit within its existing daily window.
  if (select count(*) from skyline_private.student_application_invites where application_id = a.id
       and created_at >= statement_timestamp() - interval '1 day') > send_limit then
    -- rule-policy: business admissions.application_invite_resend_limit Report that the configured daily limit has been reached.
    raise exception 'The configured daily resend limit has been reached' using errcode = '22023';
  end if;
  insert into skyline_private.student_application_invites(application_id, recipient, token_hash, state, created_by, expires_at)
  -- rule-policy: business admissions.application_invite_hours Set the token expiration from the published validity period.
    values (a.id, email_address, p_hash, 'sending', p_actor, statement_timestamp() + make_interval(hours => expiry))
    returning id into invitation;
  return jsonb_build_object('id', invitation, 'recipient', email_address, 'sender', sender, 'template', template);
end;
$$;

revoke all on function skyline_private.reserve_student_application_invite(public.enrollment_applications, text, text, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.portal_wizard_invite_begin(p_application uuid, p_hash text, p_corrected_email text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.enrollment_applications;
  s public.enrollment_students;
  email_address text;
begin
  select * into a from public.enrollment_applications where id = p_application for update;
  -- rule-policy: security invitation-crm-draft-scope Retain the verified actor and active initial draft checks.
  if auth.uid() is null or public.portal_student_id() is not null or a.id is null or not public.portal_can_access_application(a.id)
     or not public.application_student_active(a.id) or a.status <> 'draft' or a.submitted_at is not null then
    raise exception 'You cannot invite a student for this application' using errcode = '42501';
  end if;
  select * into strict s from public.enrollment_students where id = a.student_id for update;
  email_address := lower(btrim(coalesce(p_corrected_email, s.email)));
  if not skyline_private.student_application_email_valid(email_address) then
    raise exception 'Enter a valid student email address before sending the invitation' using errcode = '22023';
  end if;
  if p_corrected_email is not null and email_address is distinct from s.email then
    if exists(select 1 from public.agency_memberships m where m.student_id = s.id) then
      raise exception 'Change the student’s linked sign-in email through the existing email change workflow' using errcode = '22023';
    end if;
    -- Change the student first so the existing email propagation trigger runs outside an application UPDATE.
    perform set_config('portal.draft_command', a.id::text, true);
    update public.enrollment_students set email = email_address,
      details = coalesce(details, '{}'::jsonb) || jsonb_build_object('email', email_address, 'confirm_email', email_address)
      where id = s.id;
    select * into a from public.enrollment_applications where id = p_application;
    perform public.portal_wizard_save(a.id, a.draft_version, '{}', a.data->>'savedAt');
  end if;
  return skyline_private.reserve_student_application_invite(a, email_address, p_hash, auth.uid());
end;
$$;

create function public.portal_wizard_retry_failed_invite(p_failed_invitation uuid, p_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.enrollment_applications;
  prior skyline_private.student_application_invites;
  email_address text;
begin
  select e.* into a from public.enrollment_applications e
    join skyline_private.student_application_invites i on i.application_id = e.id
    where i.id = p_failed_invitation for update of e;
  -- rule-policy: security invitation-retry-lifecycle Require the original application to be an active initial draft.
  if a.id is null or a.status <> 'draft' or a.submitted_at is not null or not public.application_student_active(a.id) then
    raise exception 'The application is unavailable for invitation retry' using errcode = '42501';
  end if;
  -- rule-policy: security invitation-retry-idempotency Resolve only the newest attempt while holding the application lock.
  select * into prior from skyline_private.student_application_invites
    where application_id = a.id order by created_at desc, id desc limit 1;
  -- rule-policy: security invitation-retry-idempotency Retry only the latest failed attempt while holding the application lock.
  if prior.id is distinct from p_failed_invitation or prior.state <> 'failed' then
    raise exception 'Only the latest failed invitation can be retried' using errcode = '22023';
  end if;
  select lower(btrim(s.email)) into email_address from public.enrollment_students s where s.id = a.student_id for update;
  if email_address is distinct from prior.recipient or not skyline_private.student_application_email_valid(email_address) then
    raise exception 'The student email changed. Start a new invitation from CRM' using errcode = '22023';
  end if;
  return skyline_private.reserve_student_application_invite(a, email_address, p_hash, prior.created_by);
end;
$$;
revoke all on function public.portal_wizard_retry_failed_invite(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.portal_wizard_retry_failed_invite(uuid, text) to service_role;

commit;
