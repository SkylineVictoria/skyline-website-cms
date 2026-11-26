-- INVITE-RETURNING-STUDENT (owner, 2026-11-26): a login behind the student's email is not enough to send them to sign-in: one may
-- have been made by a portal invitation, a test or a reset without the student ever choosing a password. The invite link asks
-- for sign-in only when the student's account is established: Google, a password the student created themselves (recorded by
-- portal_my_password_created when they create it at the sign step), or an application of theirs already submitted. Everyone
-- else starts from the link and creates (or replaces) the password when signing.

create table if not exists skyline_private.portal_passwords_created (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
revoke all on skyline_private.portal_passwords_created from public, anon, authenticated;

create or replace function skyline_private.student_account_established(p_user uuid, p_student uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select p_user is not null and skyline_private.has_portal_login(p_user) and (
    exists(select 1 from auth.identities d where d.user_id = p_user and d.provider = 'google')
    or exists(select 1 from skyline_private.portal_passwords_created c where c.user_id = p_user)
    or exists(select 1 from public.enrollment_applications a where a.student_id = p_student and a.submitted_at is not null));
$$;
revoke all on function skyline_private.student_account_established(uuid, uuid) from public, anon, authenticated;

-- The signed-in user has just created their password (the sign step): recorded, so the next invite link asks them to sign in.
create or replace function public.portal_my_password_created() returns boolean
language plpgsql security definer set search_path to '' as $$
begin
  if auth.uid() is null or not exists(select 1 from auth.users u where u.id = auth.uid() and coalesce(u.encrypted_password, '') <> '') then
    return false;
  end if;
  insert into skyline_private.portal_passwords_created(user_id) values (auth.uid()) on conflict (user_id) do update set created_at = clock_timestamp();
  return true;
end $$;
revoke all on function public.portal_my_password_created() from public, anon;
grant execute on function public.portal_my_password_created() to authenticated;

-- Whether the signed-in student still has to create their password before signing this application.
create or replace function public.portal_my_signing_password_needed(p_application uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select not coalesce(skyline_private.student_account_established(auth.uid(),
    (select a.student_id from public.enrollment_applications a where a.id = p_application)), false);
$$;
revoke all on function public.portal_my_signing_password_needed(uuid) from public, anon;
grant execute on function public.portal_my_signing_password_needed(uuid) to authenticated;

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
    'account', case when u.id is not null and skyline_private.student_account_established(u.id, s.id) then 'login' else 'new' end,
    'google', u.id is not null and exists(select 1 from auth.identities d where d.user_id = u.id and d.provider = 'google'),
    'studentName', coalesce(nullif(btrim(a.student_name), ''), ''));
end $function$;
revoke all on function public.portal_wizard_invite_lookup(text) from public, anon, authenticated;
grant execute on function public.portal_wizard_invite_lookup(text) to service_role;

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
