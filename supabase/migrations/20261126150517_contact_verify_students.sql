-- CONTACT-VERIFY (owner, 2026-11-26): one method for every onboarding link: the email and the text carry different links, the link
-- opened proves its own channel, and the other one is confirmed with a 6-digit code before the person signs or finishes.
-- Stage 1: students (student-application-invite). skyline_private.contact_verifications holds what each login has proven
-- (kind email / phone, verified_at null = still to confirm); skyline_private.contact_codes the codes (SHA-256 only, 10 minutes,
-- 5 tries, 1 a minute, 5 an hour). Shared by the later stages (businesses, employees, admin and location users).

alter table skyline_private.student_application_invites add column if not exists sms_token_hash text unique check (sms_token_hash is null or sms_token_hash ~ '^[a-f0-9]{64}$');

create table if not exists skyline_private.contact_verifications (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('email', 'phone')),
  value text not null default '',
  verified_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, kind)
);
create table if not exists skyline_private.contact_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('email', 'phone')),
  code_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz
);
create index if not exists contact_codes_user on skyline_private.contact_codes(user_id, kind, created_at desc);
revoke all on skyline_private.contact_verifications, skyline_private.contact_codes from public, anon, authenticated;

-- A channel proven (by the link it came on, or a code); logged on the application's timeline when there is one.
create or replace function skyline_private.contact_verified(p_user uuid, p_kind text, p_value text, p_application uuid default null) returns void
language plpgsql security definer set search_path to '' as $$
declare was timestamptz;
begin
  if p_user is null then return; end if;
  select verified_at into was from skyline_private.contact_verifications where user_id = p_user and kind = p_kind;
  insert into skyline_private.contact_verifications(user_id, kind, value, verified_at) values (p_user, p_kind, coalesce(p_value, ''), clock_timestamp())
  on conflict (user_id, kind) do update set value = coalesce(nullif(excluded.value, ''), contact_verifications.value), verified_at = clock_timestamp();
  if was is null and p_application is not null then
    perform skyline_private.handoff_log(p_application, case p_kind when 'email' then 'email_confirmed' else 'mobile_confirmed' end,
      jsonb_build_object('endsWith', right(regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g'), 3)), 'student', null);
  end if;
end $$;

-- A channel still to confirm (never downgrades one already proven).
create or replace function skyline_private.contact_pending(p_user uuid, p_kind text, p_value text) returns void
language sql security definer set search_path to '' as $$
  insert into skyline_private.contact_verifications(user_id, kind, value, verified_at) values (p_user, p_kind, coalesce(p_value, ''), null)
  on conflict (user_id, kind) do nothing;
$$;
revoke all on function skyline_private.contact_verified(uuid, text, text, uuid), skyline_private.contact_pending(uuid, text, text) from public, anon, authenticated;

-- Service role (student-application-invite): the text gets its own link.
create or replace function public.invite_set_sms_token(p_invitation uuid, p_hash text) returns boolean
language sql security definer set search_path to '' as $$
  update skyline_private.student_application_invites set sms_token_hash = p_hash
   where id = p_invitation and state = 'sending' and p_hash ~ '^[a-f0-9]{64}$' returning true;
$$;
revoke all on function public.invite_set_sms_token(uuid, text) from public, anon, authenticated;
grant execute on function public.invite_set_sms_token(uuid, text) to service_role;

-- The signed-in person's channel still to confirm ({email: 'a•••@x', kind}) or null.
create or replace function public.contact_pending_mine() returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('kind', c.kind, 'value', case c.kind when 'email' then regexp_replace(c.value, '^(.)[^@]*(@.*)$', '\1•••\2')
      else '•••' || right(c.value, 3) end)
  from skyline_private.contact_verifications c where c.user_id = auth.uid() and c.verified_at is null order by c.kind limit 1;
$$;
revoke all on function public.contact_pending_mine() from public, anon;
grant execute on function public.contact_pending_mine() to authenticated;

-- Service role: a new code for the signed-in person's pending channel (the Edge Function sends it); returns where to send it.
create or replace function public.contact_code_issue(p_user uuid, p_code text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare c skyline_private.contact_verifications;
begin
  select * into c from skyline_private.contact_verifications where user_id = p_user and verified_at is null order by kind limit 1;
  if c.user_id is null then raise exception 'Nothing to confirm' using errcode = '22023'; end if;
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then raise exception 'Invalid code' using errcode = '22023'; end if;
  if exists(select 1 from skyline_private.contact_codes x where x.user_id = p_user and x.created_at > clock_timestamp() - interval '1 minute') then
    raise exception 'A code was just sent. Wait a minute before asking for another' using errcode = '22023';
  end if;
  if (select count(*) from skyline_private.contact_codes x where x.user_id = p_user and x.created_at > clock_timestamp() - interval '1 hour') >= 5 then
    raise exception 'Too many codes were asked for. Try again in an hour' using errcode = '22023';
  end if;
  insert into skyline_private.contact_codes(user_id, kind, code_hash, expires_at)
  values (p_user, c.kind, encode(sha256(convert_to(p_user::text || ':' || p_code, 'UTF8')), 'hex'), clock_timestamp() + interval '10 minutes');
  return jsonb_build_object('kind', c.kind, 'to', c.value);
end $$;
revoke all on function public.contact_code_issue(uuid, text) from public, anon, authenticated;
grant execute on function public.contact_code_issue(uuid, text) to service_role;

-- The signed-in person enters the code (wrong codes are counted, so this returns {ok:false} instead of raising).
create or replace function public.contact_code_verify(p_code text, p_application uuid default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare c skyline_private.contact_codes; v skyline_private.contact_verifications;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into c from skyline_private.contact_codes x where x.user_id = auth.uid() and x.used_at is null order by x.created_at desc limit 1 for update;
  if c.id is null or c.expires_at <= clock_timestamp() then return jsonb_build_object('ok', false, 'error', 'The code has expired. Ask for a new code'); end if;
  if c.attempts >= 5 then return jsonb_build_object('ok', false, 'error', 'Too many wrong tries. Ask for a new code'); end if;
  if c.code_hash is distinct from encode(sha256(convert_to(auth.uid()::text || ':' || coalesce(p_code, ''), 'UTF8')), 'hex') then
    update skyline_private.contact_codes set attempts = attempts + 1 where id = c.id;
    return jsonb_build_object('ok', false, 'error', 'That code is not right. Check and try again');
  end if;
  update skyline_private.contact_codes set used_at = clock_timestamp() where id = c.id;
  select * into v from skyline_private.contact_verifications where user_id = auth.uid() and kind = c.kind;
  perform skyline_private.contact_verified(auth.uid(), c.kind, v.value,
    case when p_application is not null and public.portal_can_access_application(p_application) then p_application end);
  return jsonb_build_object('ok', true, 'kind', c.kind);
end $$;
revoke all on function public.contact_code_verify(text, uuid) from public, anon;
grant execute on function public.contact_code_verify(text, uuid) to authenticated;

create or replace function public.portal_wizard_invite_lookup(p_hash text)
 returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare i skyline_private.student_application_invites; a public.enrollment_applications; s public.enrollment_students; u auth.users;
begin
  select * into i from skyline_private.student_application_invites where coalesce(p_hash, '') in (token_hash, sms_token_hash);
  select * into a from public.enrollment_applications where id = i.application_id;
  select * into s from public.enrollment_students where id = a.student_id;
  if i.id is null or i.state not in ('sent', 'accepted') or i.expires_at <= statement_timestamp()
     or a.status not in ('draft', 'action_required') or (a.status = 'draft' and a.submitted_at is not null)
     or s.status <> 'Active' or i.recipient is distinct from lower(btrim(s.email))
     or coalesce(skyline_private.handoff_state(a.id), 'with_student') <> 'with_student' then
    return jsonb_build_object('valid', false);
  end if;
  select * into u from auth.users where lower(email) = i.recipient order by created_at limit 1;
  return jsonb_build_object('valid', true, 'email', i.recipient, 'via', case when p_hash = i.sms_token_hash then 'sms' else 'email' end,
    'account', case when u.id is not null and skyline_private.student_account_established(u.id, s.id) then 'login' else 'new' end,
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
    on x.application_id = e.id where fingerprint in (x.token_hash, x.sms_token_hash) for update of e;
  select * into i from skyline_private.student_application_invites where fingerprint in (token_hash, sms_token_hash) for update;
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
  -- CONTACT-VERIFY: the link proves the channel it came by. From the email: the email is confirmed. From the text: the mobile is,
  -- and the email waits for a code before the student can sign (skyline_private.student_sign).
  perform skyline_private.contact_verified(u.id, case when fingerprint = i.sms_token_hash then 'phone' else 'email' end,
    case when fingerprint = i.sms_token_hash then coalesce((public.invite_sms_target('student', i.id))->>'mobile', '') else i.recipient end, a.id);
  if fingerprint = i.sms_token_hash then perform skyline_private.contact_pending(u.id, 'email', i.recipient); end if;
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
 -- INVITE-RETURNING-STUDENT: the student has made their own password (or uses Google) before the signature counts.
 if not skyline_private.student_account_established(auth.uid(), a.student_id) then
  raise exception 'Create your password before signing, so you can sign in to your SLIT account later' using errcode='42501';
 end if;
 -- CONTACT-VERIFY: a student who opened the link from a text confirms their email with a code first.
 if exists(select 1 from skyline_private.contact_verifications c where c.user_id = auth.uid() and c.kind = 'email' and c.verified_at is null) then
  raise exception 'Confirm your email with the code we send you before signing' using errcode='42501';
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
