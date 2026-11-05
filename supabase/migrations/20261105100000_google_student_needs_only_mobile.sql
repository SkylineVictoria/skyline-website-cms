-- A student who signs up with Google gives only their mobile: name and email come from Google, and the date of birth,
-- course and referral code are optional (the application form asks for them). Same function as migration 119 section 6,
-- except that the date of birth may be left out.
-- Rollback (manual): recreate portal_self_enrol_complete from 20261105090000.
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function public.portal_self_enrol_complete(p_input jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); u record; v_email text; v_phone text; v_email_verified boolean; v_phone_verified boolean;
 v_first text := btrim(coalesce(p_input->>'firstName', '')); v_last text := btrim(coalesce(p_input->>'lastName', '')); v_name text;
 v_dob date; v_course text := left(btrim(coalesce(p_input->>'course', '')), 200); v_ref text := btrim(coalesce(p_input->>'referralCode', ''));
 a public.agencies; s public.enrollment_students; p public.portal_profiles; v_details jsonb; v_linked boolean := false;
begin
 if v_uid is null then raise exception 'Sign in required' using errcode = '42501'; end if;
 if exists (select 1 from public.cms_users c where c.auth_user_id = v_uid) then
  raise exception 'Staff accounts cannot enrol as students.' using errcode = '42501'; end if;
 if exists (select 1 from public.portal_profiles pp join public.agency_memberships m on m.user_id = pp.id where pp.auth_user_id = v_uid) then
  raise exception 'This account is already set up. Sign in again to continue.' using errcode = '23505'; end if;
 select lower(btrim(coalesce(x.email, ''))) as email, x.email_confirmed_at, nullif(btrim(coalesce(x.phone, '')), '') as phone, x.phone_confirmed_at
  into u from auth.users x where x.id = v_uid;
 v_email_verified := u.email <> '' and u.email_confirmed_at is not null;
 v_phone_verified := u.phone is not null and u.phone_confirmed_at is not null;
 if not v_email_verified and not v_phone_verified then
  raise exception 'Confirm your email or phone number first.' using errcode = '42501'; end if;

 v_email := case when v_email_verified then u.email else lower(btrim(coalesce(p_input->>'email', ''))) end;
 v_phone := case when v_phone_verified then '+' || ltrim(u.phone, '+') else regexp_replace(coalesce(p_input->>'phone', ''), '[\s().-]', '', 'g') end;
 if v_email = '' or char_length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
  raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
 if v_phone !~ '^\+[1-9]\d{7,14}$' then raise exception 'Enter your mobile number with its country code.' using errcode = '22023'; end if;
 v_name := btrim(concat_ws(' ', nullif(v_first, ''), nullif(v_last, '')));
 if char_length(v_first) not between 1 and 100 or char_length(v_last) not between 1 and 100 or v_name ~ '[[:cntrl:]]' then
  raise exception 'Enter your first and last name.' using errcode = '22023'; end if;
 -- Date of birth is optional here (the application form asks for it); when given it must be 10 to 100 years ago.
 if nullif(btrim(coalesce(p_input->>'dateOfBirth', '')), '') is not null then
  begin v_dob := (p_input->>'dateOfBirth')::date; exception when others then v_dob := null; end;
  if v_dob is null or v_dob > current_date - interval '10 years' or v_dob < current_date - interval '100 years' then
   raise exception 'Enter a valid date of birth.' using errcode = '22023'; end if;
 end if;

 -- An existing student is linked only through what Auth verified.
 if v_email_verified then select * into s from public.enrollment_students x where lower(btrim(coalesce(x.email, ''))) = v_email order by x.created_at, x.id limit 1; end if;
 if s.id is null and v_phone_verified then select * into s from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone) order by x.created_at, x.id limit 1; end if;
 if s.id is not null then
  if s.status <> 'Active' then raise exception 'This student record is disabled. Please contact SLIT Administration.' using errcode = '22023'; end if;
  if exists (select 1 from public.agency_memberships m where m.student_id = s.id and m.status = 'Active') then
   raise exception 'This student already has a sign-in. Sign in with that account instead.' using errcode = '23505'; end if;
  select * into a from public.agencies where id = s.agency_id;
  if a.status <> 'Active' then raise exception 'Your business is not active. Please contact SLIT Administration.' using errcode = '22023'; end if;
  v_linked := true;
 else
  if exists (select 1 from public.enrollment_students x where lower(btrim(coalesce(x.email, ''))) = v_email) then
   raise exception 'A student with this email is already on record. Sign in with that email instead, or contact SLIT Administration.' using errcode = '23505'; end if;
  if exists (select 1 from public.enrollment_students x where public.student_phone_key(x.phone) = public.student_phone_key(v_phone)) then
   raise exception 'A student with this mobile number is already on record. Sign in with it instead, or contact SLIT Administration.' using errcode = '23505'; end if;
  if v_ref <> '' then
   select * into a from public.agencies where lower(code) = lower(v_ref) and status = 'Active' and not is_direct;
   if not found then raise exception 'We do not recognise that referral code. Check it with your agent, or leave it blank.' using errcode = '22023'; end if;
  else
   select * into a from public.agencies where is_direct and status = 'Active';
   if not found then raise exception 'Direct enrolment is not open right now. Please contact SLIT Administration.' using errcode = '22023'; end if;
  end if;
  v_details := jsonb_build_object('email', v_email, 'confirm_email', v_email, 'mobile', v_phone, 'first_name', v_first, 'last_name', v_last);
  if v_course <> '' then v_details := v_details || jsonb_build_object('course_of_interest', v_course); end if;
  insert into public.enrollment_students(agency_id, tenant_id, agent_id, full_name, email, phone, date_of_birth, details)
   values (a.id, null, null, v_name, v_email, v_phone, v_dob, v_details) returning * into s;
 end if;

 select * into p from public.portal_profiles where auth_user_id = v_uid;
 if p.id is null then
  insert into public.portal_profiles(auth_user_id, email, full_name, phone, status) values (v_uid, v_email, coalesce(nullif(s.full_name, ''), v_name), left(v_phone, 40), 'Active') returning * into p;
 else
  update public.portal_profiles set status = 'Active', email = v_email, phone = left(v_phone, 40), updated_at = now() where id = p.id returning * into p;
 end if;
 insert into public.agency_memberships(user_id, agency_id, role, status, student_id) values (p.id, s.agency_id, 'student', 'Active', s.id);
 -- A waiting invitation for this student is now used.
 update public.agency_invitations set status = 'accepted', accepted_at = now() where student_id = s.id and status = 'pending';
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, agency_id, detail)
  values (v_uid, coalesce(nullif(s.full_name, ''), v_name), 'student', 'self_enrol_signed_in', 'student', s.id::text, s.agency_id,
   jsonb_build_object('email', v_email, 'linkedExisting', v_linked, 'emailVerified', v_email_verified, 'phoneVerified', v_phone_verified, 'referral', v_ref <> ''));
 return jsonb_build_object('studentId', s.id, 'agencyId', s.agency_id, 'linkedExisting', v_linked);
exception when unique_violation then
 raise exception 'This email or mobile number is already on record. Sign in with it instead, or contact SLIT Administration.' using errcode = '23505';
end $$;
revoke all on function public.portal_self_enrol_complete(jsonb) from public, anon;
grant execute on function public.portal_self_enrol_complete(jsonb) to authenticated;
