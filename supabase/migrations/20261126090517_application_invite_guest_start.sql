-- APPLICATION-INVITE-GUEST-START (owner, 2026-11-26): the student invitation link.
--   * The invited email already has a SLIT account (a password, or Google): sign in only (password, Forgot password, Google).
--   * First time: the student opens the application from the link alone (student-application-invite invite_session makes a
--     one-time sign-in for that email; the emailed link proves the address) and works in it as a guest; the password is created
--     when they sign (skyline_private.student_sign refuses a signature until the account has a password or Google).
--   portal_wizard_invite_lookup (service role) tells the page which of the two applies.

create or replace function skyline_private.has_portal_login(p_user uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists(select 1 from auth.users u where u.id = p_user and (coalesce(u.encrypted_password, '') <> ''
    or exists(select 1 from auth.identities d where d.user_id = u.id and d.provider = 'google')));
$$;
revoke all on function skyline_private.has_portal_login(uuid) from public, anon, authenticated;

-- The invitation behind a link (by its SHA-256): whether it can be opened, its email, and whether that email already has an account.
create or replace function public.portal_wizard_invite_lookup(p_hash text)
 returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare i skyline_private.student_application_invites; a public.enrollment_applications; s public.enrollment_students; u auth.users;
begin
  select * into i from skyline_private.student_application_invites where token_hash = coalesce(p_hash, '');
  select * into a from public.enrollment_applications where id = i.application_id;
  select * into s from public.enrollment_students where id = a.student_id;
  if i.id is null or i.state not in ('sent', 'accepted') or i.expires_at <= statement_timestamp()
     or a.status not in ('draft', 'action_required') or (a.status = 'draft' and a.submitted_at is not null)
     or s.status <> 'Active' or i.recipient is distinct from lower(btrim(s.email))
     or coalesce(skyline_private.handoff_state(a.id), 'with_student') <> 'with_student' then
    return jsonb_build_object('valid', false);
  end if;
  select * into u from auth.users where lower(email) = i.recipient order by created_at limit 1;
  return jsonb_build_object('valid', true, 'email', i.recipient,
    'account', case when u.id is not null and skyline_private.has_portal_login(u.id) then 'login' else 'new' end,
    'google', u.id is not null and exists(select 1 from auth.identities d where d.user_id = u.id and d.provider = 'google'),
    'studentName', coalesce(nullif(btrim(a.student_name), ''), ''));
end $function$;
revoke all on function public.portal_wizard_invite_lookup(text) from public, anon, authenticated;
grant execute on function public.portal_wizard_invite_lookup(text) to service_role;

create or replace function public.portal_wizard_invite_accept(p_token text)
 returns uuid language plpgsql security definer set search_path to '' as $function$
declare
  a public.enrollment_applications;
  i skyline_private.student_application_invites;
  s public.enrollment_students;
  u auth.users;
  p public.portal_profiles;
  m public.agency_memberships;
  fingerprint text;
  first_open boolean;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'This invitation is invalid, expired, or no longer available' using errcode = '42501';
  end if;
  fingerprint := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into u from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if not found then raise exception 'Sign in with the invited email address' using errcode = '42501'; end if;
  select e.* into a from public.enrollment_applications e join skyline_private.student_application_invites x
    on x.application_id = e.id where x.token_hash = fingerprint for update of e;
  select * into i from skyline_private.student_application_invites where token_hash = fingerprint for update;
  select * into s from public.enrollment_students where id = a.student_id for update;
  if a.id is null or i.state not in ('sent', 'accepted') or i.expires_at <= statement_timestamp()
     or i.recipient is distinct from lower(btrim(u.email)) or i.recipient is distinct from lower(btrim(s.email))
     or a.status not in ('draft', 'action_required') or (a.status = 'draft' and a.submitted_at is not null) or s.status <> 'Active'
     or not public.tenant_scope(a.tenant_id)
     or public.cms_is_admin()
     or not exists (select 1 from public.agencies g where g.id = a.agency_id and public.agency_effective_status(g) = 'Active')
     or coalesce(skyline_private.handoff_state(a.id), 'with_student') <> 'with_student' then
    raise exception 'This invitation is invalid, expired, or no longer available' using errcode = '42501';
  end if;
  -- APPLICATION-INVITE-GUEST-START: a first-time student opens the application from the emailed link alone (the link proves the
  -- email) and creates the password when they sign (skyline_private.student_sign); an existing account signs in first.
  select * into p from public.portal_profiles where auth_user_id = u.id for update;
  if p.id is null then
    insert into public.portal_profiles(auth_user_id, email, full_name, status)
    values (u.id, i.recipient, coalesce(nullif(s.full_name, ''), split_part(i.recipient, '@', 1)), 'Active') returning * into p;
  end if;
  select * into m from public.agency_memberships where user_id = p.id for update;
  if p.status <> 'Active' or (m.user_id is not null and
    (m.role <> 'student' or m.student_id is distinct from s.id or m.agency_id is distinct from a.agency_id or m.status <> 'Active')) then
    raise exception 'This invitation is unavailable for the signed-in account' using errcode = '42501';
  end if;
  if m.user_id is null then
    insert into public.agency_memberships(user_id, agency_id, role, status, student_id)
      values (p.id, a.agency_id, 'student', 'Active', s.id);
  end if;
  first_open := i.state = 'sent';
  if first_open then
    update skyline_private.student_application_invites set state = 'accepted', accepted_at = clock_timestamp() where id = i.id;
    update skyline_private.application_handoffs set opened_at = coalesce(opened_at, clock_timestamp()), updated_at = clock_timestamp()
      where application_id = a.id;
    if found then
      perform skyline_private.handoff_log(a.id, 'accepted', jsonb_build_object('recipient', i.recipient), 'student', coalesce(nullif(p.full_name, ''), i.recipient));
      perform skyline_private.handoff_notify(a.id, 'handoff_accepted', 'agent', 'Opened by the student: ' || skyline_private.application_label(a),
        'The student accepted your invitation and opened the application ' || skyline_private.application_label(a) || ' to review and sign.');
    end if;
  end if;
  return a.id;
end;
$function$;

create or replace function skyline_private.student_sign(a public.enrollment_applications, p_kind text, p_request_key text,
  p_consent jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_age int; v_ids jsonb; v_name text := skyline_private.handoff_actor_name(); v_state text;
begin
 if not skyline_private.is_application_student(a.id) then
  raise exception 'Only the student can sign and submit this application. Send it to the student to review and sign' using errcode='42501';
 end if;
 -- APPLICATION-INVITE-GUEST-START: the student's portal account is completed (a password, or Google) before the signature counts.
 if not skyline_private.has_portal_login(auth.uid()) then
  raise exception 'Create your password before signing, so you can sign in to your SLIT account later' using errcode='42501';
 end if;
 v_age := skyline_private.application_age(a.id);
 if v_age is null then raise exception 'Enter the date of birth before signing' using errcode='22023'; end if;
 v_ids := skyline_private.record_declarations(a.id, p_consent->'declarations', 'student', auth.uid(), v_name,
   skyline_private.request_ip(), skyline_private.request_user_agent());
 if p_consent->'declarations' ? 'usi_permission' then perform public.usi_consent_set(a.id, true, false); end if;
 v_state := skyline_private.handoff_state(a.id);
 if v_state is null then
  insert into skyline_private.application_handoffs(application_id, state) values (a.id, 'with_student');
 end if;
 update skyline_private.application_handoffs set signed_at = clock_timestamp(), signed_by = auth.uid(), signed_by_name = v_name,
   finalize_kind = p_kind, request_key = p_request_key, finalize_note = p_note, updated_at = clock_timestamp(),
   state = case when v_age < 18 then 'waiting_guardian' else state end
   where application_id = a.id;
 perform skyline_private.handoff_log(a.id, 'signed', jsonb_build_object('age', v_age, 'consentIds', v_ids, 'needsGuardian', v_age < 18));
 perform skyline_private.handoff_notify(a.id, 'handoff_signed', 'agent', 'Signed by the student: ' || skyline_private.application_label(a),
   'The student signed the application ' || skyline_private.application_label(a) || '.'
   || case when v_age < 18 then ' The student is under 18, so it is submitted once their parent or guardian signs.' else '' end);
 if v_age < 18 then
  return jsonb_build_object('application_id', a.id, 'state', 'waiting_guardian');
 end if;
 return skyline_private.application_finalize(a.id, auth.uid(), v_name, p_kind, p_request_key, v_ids, p_note);
end $$;
