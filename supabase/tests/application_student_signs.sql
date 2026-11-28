begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- APPLICATION-STUDENT-SIGNS (20261125190517): agent fills, only the student (and, under 18, a parent / guardian) signs and submits.
-- Synthetic fixtures, rolled back. Run: node scripts/lab/staff-lab.mjs sql
select plan(151);

-- Invitation settings as published on hosted (the lab has none); everything else reads the real rules.
alter function public.business_rule_evaluate(text, text, jsonb) rename to business_rule_evaluate_t0;
create function public.business_rule_evaluate(p_scope_key text, p_identifier text, p_context jsonb) returns jsonb
language sql stable security definer set search_path to '' as $$
  select case p_identifier when 'admissions.application_invite_hours' then '168'::jsonb
    when 'admissions.application_invite_resend_limit' then '3'::jsonb
    when 'admissions.application_invite_sender' then '"admissions@example.test"'::jsonb
    when 'admissions.application_invite_template' then '{"subject":"x"}'::jsonb
    else public.business_rule_evaluate_t0(p_scope_key, p_identifier, p_context) end;
$$;
-- Field completeness is tested elsewhere; here only who may sign.
create or replace function public.portal_validate_submission(p_application_id uuid) returns void language sql as $$ select $$;

-- Fixtures: an operational agency, its agent and admin, staff, two students (adult / under 18) with portal accounts.
insert into public.agencies(id, name, code) values ('a5100000-0000-0000-0000-000000000001', 'Signs Agency', 'SIGNS-A');
insert into public.business_documents(business_id, kind, file_name, storage_path)
  values ('a5100000-0000-0000-0000-000000000001', 'agent_agreement', 'a.pdf', 'fixtures/signs/agreement.pdf');
insert into auth.users(id, email, email_confirmed_at, encrypted_password) values
 ('b5100000-0000-0000-0000-000000000001', 'agent.signs@example.test', now(), 'x'),
 ('b5100000-0000-0000-0000-000000000002', 'adult.signs@example.test', now(), 'x'),
 ('b5100000-0000-0000-0000-000000000003', 'minor.signs@example.test', now(), 'x'),
 ('b5100000-0000-0000-0000-000000000004', 'staff.signs@example.test', now(), 'x'),
 ('b5100000-0000-0000-0000-000000000005', 'nopass.signs@example.test', now(), null),
 ('b5100000-0000-0000-0000-000000000006', 'aadmin.signs@example.test', now(), 'x');
insert into public.portal_profiles(id, auth_user_id, full_name, email) values
 ('c5100000-0000-0000-0000-000000000001', 'b5100000-0000-0000-0000-000000000001', 'Agent Signs', 'agent.signs@example.test'),
 ('c5100000-0000-0000-0000-000000000006', 'b5100000-0000-0000-0000-000000000006', 'Agency Admin Signs', 'aadmin.signs@example.test');
insert into public.agency_memberships(user_id, agency_id, role) values
 ('c5100000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001', 'agent'),
 ('c5100000-0000-0000-0000-000000000006', 'a5100000-0000-0000-0000-000000000001', 'agency_admin');
insert into public.cms_users(id, name, email, role, status, auth_user_id)
  values ('signs-staff', 'Staff Signs', 'staff.signs@example.test', 'Admin', 'Active', 'b5100000-0000-0000-0000-000000000004');
insert into public.enrollment_students(id, agency_id, full_name, email, status) values
 ('d5100000-0000-0000-0000-000000000002', 'a5100000-0000-0000-0000-000000000001', 'Adult Signs', 'adult.signs@example.test', 'Active'),
 ('d5100000-0000-0000-0000-000000000003', 'a5100000-0000-0000-0000-000000000001', 'Minor Signs', 'minor.signs@example.test', 'Active'),
 ('d5100000-0000-0000-0000-000000000005', 'a5100000-0000-0000-0000-000000000001', 'No Password', 'nopass.signs@example.test', 'Active');
insert into public.enrollment_applications(id, agency_id, assigned_agent_id, created_by, student_id, status, data) values
 ('e5100000-0000-0000-0000-000000000002', 'a5100000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001',
  'd5100000-0000-0000-0000-000000000002', 'draft', '{"values":{"first_name":"Adult","last_name":"Signs","dob":"1999-04-02","agent_agency":"Signs Agency","preferred_intake":"Feb 2027","mobile":"0400000000"}}'),
 ('e5100000-0000-0000-0000-000000000003', 'a5100000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001',
  'd5100000-0000-0000-0000-000000000003', 'draft', format('{"values":{"first_name":"Minor","dob":"%s"}}', (current_date - interval '16 years')::date)::jsonb),
 ('e5100000-0000-0000-0000-000000000005', 'a5100000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001',
  'd5100000-0000-0000-0000-000000000005', 'draft', '{"values":{"dob":"1990-01-01"}}');
-- Fixture only: give an application's student a complete AVETMISS record (NAT00080) and a study reason, as the wizard would, so
-- moves out of Draft / Action required pass the submit guard (enrollment_applications_avetmiss_submit, 20261126124153).
-- Only what is missing is filled: the fixture's own names and answers win.
create or replace function pg_temp.avetmiss_ready(p_app uuid) returns void language plpgsql as $$
declare v_student uuid;
begin
  select student_id into v_student from public.enrollment_applications where id = p_app;
  if v_student is null then raise exception 'fixture application % has no student', p_app; end if;
  update public.enrollment_students set sex_code = coalesce(sex_code, 'F'), birth_country_code = coalesce(birth_country_code, '1101'),
    home_language_code = coalesce(home_language_code, '1201'), indigenous_status_code = coalesce(indigenous_status_code, '4'),
    school_level_code = coalesce(school_level_code, '12'), school_level_year = coalesce(school_level_year, '2017'),
    at_school_flag = coalesce(at_school_flag, 'N'), labour_force_code = coalesce(labour_force_code, '01'),
    disability_flag = coalesce(disability_flag, 'N'), prior_education_flag = coalesce(prior_education_flag, 'N'),
    full_name = coalesce(nullif(full_name, ''), 'Fixture Student'),
    details = '{"first_name": "Fixture", "last_name": "Student", "dob": "2000-01-01", "au_street": "1 Test St", "au_suburb": "Melbourne", "au_zip": "3000", "au_state": "VIC", "study_reason": "To get a job - 01"}'::jsonb
      || jsonb_strip_nulls(coalesce(details, '{}'::jsonb))
   where id = v_student;
end $$;
select pg_temp.avetmiss_ready(id) from public.enrollment_applications where id::text like 'e5100000-%';
update public.enrollment_applications set student_email = s.email from public.enrollment_students s where s.id = enrollment_applications.student_id
  and enrollment_applications.id::text like 'e5100000%';

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, true), set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.tok(n int) returns text language sql as $$ select rpad('Tok' || n, 43, 'x') $$;
create function pg_temp.hash(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.decl() returns jsonb language sql security definer as $$
  select jsonb_object_agg(key, hash) from public.application_declaration_texts where active $$;
-- APPLICATION-DRAWN-SIGNATURE (20261126233517): the student's drawn signature (a PNG) goes with the declarations.
create function pg_temp.sig() returns text language sql immutable as $$ select 'data:image/png;base64,' || repeat('iVBORw0KGgo', 30) $$;
create function pg_temp.dv(app uuid) returns bigint language sql security definer as $$ select draft_version from public.enrollment_applications where id = app $$;
create function pg_temp.hstate(app uuid) returns text language sql security definer as $$ select state from skyline_private.application_handoffs where application_id = app $$;
create function pg_temp.inv(app uuid) returns uuid language sql security definer as $$
  select id from skyline_private.student_application_invites where application_id = app order by created_at desc, id desc limit 1 $$;
create function pg_temp.status(app uuid) returns text language sql security definer as $$ select status from public.enrollment_applications where id = app $$;
create function pg_temp.events(app uuid) returns text language sql security definer as $$
  select string_agg(event, ',' order by created_at, id) from skyline_private.application_handoff_events where application_id = app $$;
create function pg_temp.mails(app uuid) returns text language sql security definer as $$
  select string_agg(event, ',' order by created_at, id) from public.notification_deliveries where application_id = app and event like 'handoff%' $$;

-- 1. Declarations are served with their hashes.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select is(jsonb_array_length(public.portal_application_declarations()), 3, 'three declarations (ESOS, NCVER privacy + declaration, USI)');
reset role;
select is((select hash from public.application_declaration_texts where key = 'usi_permission' and active),
  encode(sha256(convert_to((select body from public.application_declaration_texts where key = 'usi_permission' and active), 'UTF8')), 'hex'), 'text hash is the SHA-256 of the body');

-- 2. Agent, agency admin and staff cannot consent / submit.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-agent', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  '42501', null, 'agent submit refused');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-agent2', '{"confirmed":true,"authorised":true,"method":"electronic","declarationVersion":"1.0"}')$$,
  '42501', null, 'agent-ticked electronic consent refused');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000006');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-aa', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  '42501', null, 'agency admin submit refused');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-staff', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  '42501', null, 'staff submit refused');
reset role;

-- 3. Agent sends to the student (invite begin + delivered); then view-only for the agent.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select lives_ok($$select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000002', pg_temp.hash(pg_temp.tok(1)))$$, 'agent sends to student');
reset role;
select ok(public.portal_wizard_invite_delivered(pg_temp.inv('e5100000-0000-0000-0000-000000000002'), true), 'invite delivered');
select is(pg_temp.hstate('e5100000-0000-0000-0000-000000000002'), 'with_student', 'handoff with the student');
select ok((select sent_snapshot->'values'->>'agent_agency' = 'Signs Agency' from skyline_private.application_handoffs where application_id = 'e5100000-0000-0000-0000-000000000002'), 'snapshot taken when sent');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select lives_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0411111111"}}')$$,
  'agent edits while the student has it (ONE-PAGE-EDIT-ALL, 20261127020517)');
select ok(public.portal_can_edit_application('e5100000-0000-0000-0000-000000000002'), 'portal_can_edit_application true for the agent while the student has it');
reset role;

-- 4. Student: a link alone is not enough (no password / Google), then accept with a password.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select lives_ok($$select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000005', pg_temp.hash(pg_temp.tok(5)))$$, 'agent sends the no-password student');
reset role;
select public.portal_wizard_invite_delivered(pg_temp.inv('e5100000-0000-0000-0000-000000000005'), true);
select pg_temp.as_user('b5100000-0000-0000-0000-000000000005');
reset role;
select is(public.portal_wizard_invite_lookup(pg_temp.hash(pg_temp.tok(5)))->>'account', 'new', 'lookup: first-time email opens as a guest');
select is(public.portal_wizard_invite_lookup(pg_temp.hash(pg_temp.tok(1)))->>'account', 'new', 'lookup: a password the student never created does not mean sign-in');
select is(public.portal_wizard_invite_lookup(pg_temp.hash(pg_temp.tok(98)))->>'valid', 'false', 'lookup: unknown link invalid');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000005');
select is(public.portal_wizard_invite_accept(pg_temp.tok(5)), 'e5100000-0000-0000-0000-000000000005'::uuid, 'first-time student opens the application without a password');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000005', pg_temp.dv('e5100000-0000-0000-0000-000000000005'), 'k-nopass', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  '42501', 'Create your password before signing, so you can sign in to your SLIT account later', 'signing needs the password first');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select is(public.portal_wizard_invite_accept(pg_temp.tok(1)), 'e5100000-0000-0000-0000-000000000002'::uuid, 'student accepts with a password');
select throws_ok($$select public.portal_wizard_invite_accept(pg_temp.tok(99))$$, '42501', null, 'unknown link refused');
reset role;
select ok(pg_temp.events('e5100000-0000-0000-0000-000000000002') = 'sent,email_confirmed,accepted', 'timeline: sent, email confirmed by the link, accepted');
select ok(pg_temp.mails('e5100000-0000-0000-0000-000000000002') like '%handoff_accepted%', 'agent told the student accepted');

-- 5. Student edits allowed fields; view-only fields refused.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select lives_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0422222222","agent_agency":"Signs Agency"}}')$$,
  'student edits contact (unchanged agency allowed)');
select lives_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"preferred_intake":"Jul 2027"}}')$$,
  'student changes the intake (STUDENT-CHANGES-COURSE, 20261126220517)');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"agent_agency":"Other"}}')$$,
  '42501', null, 'student cannot change the agency');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"courses":[{"courseId":"X","variant":""}]}')$$,
  null, null, 'a course that does not exist is still refused (the student picks only offered courses)');

-- 6. Request a change: student read-only, agent edits and sends again.
select lives_ok($$select public.portal_application_request_change('e5100000-0000-0000-0000-000000000002', 'Please change my intake to July')$$, 'student requests a change');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0433333333"}}')$$,
  '42501', null, 'student read-only while waiting for the agent');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select lives_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"preferred_intake":"Jul 2027"}}')$$,
  'agent edits after the change request');
select lives_ok($$select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000002', pg_temp.hash(pg_temp.tok(2)))$$, 'agent sends again');
reset role;
select public.portal_wizard_invite_delivered(pg_temp.inv('e5100000-0000-0000-0000-000000000002'), true);
select is(pg_temp.hstate('e5100000-0000-0000-0000-000000000002'), 'with_student', 'with the student again');
select ok(pg_temp.mails('e5100000-0000-0000-0000-000000000002') like '%handoff_change_requested%handoff_change_applied%', 'agent told of the request, student of the change');

-- 7. Take back, then send again.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select throws_ok($$select public.portal_application_take_back('e5100000-0000-0000-0000-000000000002')$$, '42501', null, 'student cannot take back');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select lives_ok($$select public.portal_application_take_back('e5100000-0000-0000-0000-000000000002')$$, 'agent takes it back');
select ok(public.portal_can_edit_application('e5100000-0000-0000-0000-000000000002'), 'agent can edit again');
reset role;
select is((select state from skyline_private.student_application_invites where id = pg_temp.inv('e5100000-0000-0000-0000-000000000002')), 'revoked', 'invite revoked on take back');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select throws_ok($$select public.portal_wizard_invite_accept(pg_temp.tok(2))$$, '42501', null, 'revoked link refused');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0444444444"}}')$$,
  '42501', null, 'student read-only after take back');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000002', pg_temp.hash(pg_temp.tok(3)));
reset role;
select public.portal_wizard_invite_delivered(pg_temp.inv('e5100000-0000-0000-0000-000000000002'), true);
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000002', pg_temp.hash(pg_temp.tok(4)))$$,
  '22023', 'The configured daily resend limit has been reached', 'resend limit applies (3 a day)');
reset role;

-- 8. Adult student signs and submits; the agent sees the diff.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select public.portal_wizard_invite_accept(pg_temp.tok(3));
select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0455555555"}}');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-adult0', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  '42501', 'Create your password before signing, so you can sign in to your SLIT account later', 'a hidden password does not count: create it at signing');
select ok(public.portal_my_signing_password_needed('e5100000-0000-0000-0000-000000000002'), 'sign step asks for the password');
select ok(public.portal_my_password_created(), 'password created at the sign step is recorded');
select ok(not public.portal_my_signing_password_needed('e5100000-0000-0000-0000-000000000002'), 'then no longer asked');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-adult', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl() - 'usi_permission'))$$,
  '22023', null, 'every declaration must be ticked');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-adult', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl() || '{"esos_written_agreement":"00"}'))$$,
  '22023', null, 'a declaration with another text refused');
select lives_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-adult', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  'student signs and submits');
reset role;
select is(pg_temp.status('e5100000-0000-0000-0000-000000000002'), 'submitted', 'adult: submitted at once');
select ok(skyline_private.student_account_established('b5100000-0000-0000-0000-000000000002', 'd5100000-0000-0000-0000-000000000002'), 'after a submission the next link asks to sign in');
select is((select count(*)::int from public.enrollment_application_consents where application_id = 'e5100000-0000-0000-0000-000000000002'
  and signer_role = 'student' and signer_user_id = 'b5100000-0000-0000-0000-000000000002' and text_hash ~ '^[a-f0-9]{64}$'), 3, 'three consent rows with signer and text hash');
select ok(pg_temp.mails('e5100000-0000-0000-0000-000000000002') like '%handoff_signed%handoff_submitted%', 'agent told signed and submitted');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select ok((select public.portal_application_handoff_diff('e5100000-0000-0000-0000-000000000002')->'changes') @> '[{"field":"mobile","after":"0455555555","by":"student"}]',
  'agent sees the student''s change');
select throws_ok($$select public.portal_application_take_back('e5100000-0000-0000-0000-000000000002')$$, '22023', null, 'no take back after submit');
reset role;

-- 9. Under 18: student signs, waits for the guardian, guardian verifies and signs, then submitted.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000003', pg_temp.hash(pg_temp.tok(6)));
reset role;
select public.portal_wizard_invite_delivered(pg_temp.inv('e5100000-0000-0000-0000-000000000003'), true);
select pg_temp.as_user('b5100000-0000-0000-0000-000000000003');
select public.portal_wizard_invite_accept(pg_temp.tok(6));
select public.portal_my_password_created();
select is(public.portal_submit_v2('e5100000-0000-0000-0000-000000000003', pg_temp.dv('e5100000-0000-0000-0000-000000000003'), 'k-minor', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))->>'state',
  'waiting_guardian', 'under 18: waits for the guardian');
select throws_ok($$select public.portal_guardian_request_begin('e5100000-0000-0000-0000-000000000003', 'Pat Parent', 'Mother', 'minor.signs@example.test', '+61400000000', pg_temp.hash(pg_temp.tok(7)))$$,
  '22023', null, 'guardian needs their own email');
select lives_ok($$select public.portal_guardian_request_begin('e5100000-0000-0000-0000-000000000003', 'Pat Parent', 'Mother', 'pat.parent@example.test', '+61400000000', pg_temp.hash(pg_temp.tok(7)))$$,
  'student names the guardian');
reset role;
select is(pg_temp.status('e5100000-0000-0000-0000-000000000003'), 'draft', 'not submitted without the guardian');
select ok(public.portal_guardian_request_delivered((select id from skyline_private.application_guardian_requests where application_id = 'e5100000-0000-0000-0000-000000000003'), true), 'guardian email delivered');
select throws_ok($$select public.portal_guardian_sign(pg_temp.hash(pg_temp.tok(7)), pg_temp.decl(), '1.2.3.4', 'ua')$$, '42501', null, 'guardian must enter the code first');
select public.portal_guardian_code_issue(pg_temp.hash(pg_temp.tok(7)), '123456');
select is(public.portal_guardian_code_verify(pg_temp.hash(pg_temp.tok(7)), '000000')->>'ok', 'false', 'wrong code refused');
select is(public.portal_guardian_code_verify(pg_temp.hash(pg_temp.tok(7)), '123456')->>'ok', 'true', 'right code verifies');
select lives_ok($$select public.portal_guardian_sign(pg_temp.hash(pg_temp.tok(7)), pg_temp.decl(), '1.2.3.4', 'ua')$$, 'guardian signs');
select is(pg_temp.status('e5100000-0000-0000-0000-000000000003'), 'submitted', 'submitted once both signed');
select is((select count(*)::int from public.enrollment_application_consents where application_id = 'e5100000-0000-0000-0000-000000000003'
  and signer_role = 'guardian' and guardian_email = 'pat.parent@example.test' and ip = '1.2.3.4'), 3, 'guardian consent recorded');
select throws_ok($$select public.portal_guardian_open(pg_temp.hash(pg_temp.tok(7)))$$, '42501', null, 'used guardian link refused');

-- 10. Expired links fail cleanly; resubmission is the student's too.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000005', pg_temp.hash(pg_temp.tok(8)));
reset role;
select public.portal_wizard_invite_delivered(pg_temp.inv('e5100000-0000-0000-0000-000000000005'), true);
update skyline_private.student_application_invites set expires_at = now() - interval '1 minute' where id = pg_temp.inv('e5100000-0000-0000-0000-000000000005');
update auth.users set encrypted_password = 'x' where id = 'b5100000-0000-0000-0000-000000000005';
select pg_temp.as_user('b5100000-0000-0000-0000-000000000005');
select throws_ok($$select public.portal_wizard_invite_accept(pg_temp.tok(8))$$, '42501', 'This invitation is invalid, expired, or no longer available', 'expired link refused');
reset role;
update skyline_private.application_guardian_requests set state = 'sent', expires_at = now() - interval '1 minute' where application_id = 'e5100000-0000-0000-0000-000000000003';
update skyline_private.application_handoffs set state = 'waiting_guardian' where application_id = 'e5100000-0000-0000-0000-000000000003';
select throws_ok($$select public.portal_guardian_open(pg_temp.hash(pg_temp.tok(7)))$$, '42501', null, 'expired guardian link refused');
update public.enrollment_applications set status = 'action_required' where id = 'e5100000-0000-0000-0000-000000000002';
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.portal_application_resubmit('e5100000-0000-0000-0000-000000000002', 'fixed', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  '42501', null, 'agent resubmit refused');
reset role;

-- 11. Invite by text (20261126130517): settings only when ClickSend is connected, the student's mobile, outcome on the timeline.
reset role;
select is(public.invite_sms_settings(), null, 'no ClickSend connection: no text settings');
select ok((public.invite_sms_target('student', pg_temp.inv('e5100000-0000-0000-0000-000000000002'))->>'mobile') <> '', 'the student mobile is found');
select lives_ok($$select public.invite_sms_record('e5100000-0000-0000-0000-000000000002', 'student', 'sent', '', '+61400000555')$$, 'text outcome recorded');
select ok((select detail->>'endsWith' = '555' and detail::text not like '%61400%' from skyline_private.application_handoff_events where application_id = 'e5100000-0000-0000-0000-000000000002' and event = 'sms_sent' limit 1), 'only the last three digits are kept');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.invite_sms_settings()$$, '42501', null, 'agents cannot read the ClickSend account');
reset role;

-- 12. Two links (20261126150517): the text link proves the mobile; the email is confirmed with a code before signing.
reset role;
insert into auth.users(id, email, email_confirmed_at, encrypted_password) values ('b5100000-0000-0000-0000-000000000007', 'textlink.signs@example.test', now(), 'x');
insert into public.enrollment_students(id, agency_id, full_name, email, status) values
 ('d5100000-0000-0000-0000-000000000007', 'a5100000-0000-0000-0000-000000000001', 'Text Link', 'textlink.signs@example.test', 'Active');
insert into public.enrollment_applications(id, agency_id, assigned_agent_id, created_by, student_id, status, student_email, data) values
 ('e5100000-0000-0000-0000-000000000007', 'a5100000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001',
  'd5100000-0000-0000-0000-000000000007', 'draft', 'textlink.signs@example.test', '{"values":{"dob":"1995-01-01","mobile":"0412345678"}}');
select pg_temp.avetmiss_ready('e5100000-0000-0000-0000-000000000007');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000007', pg_temp.hash(pg_temp.tok(11)));
reset role;
select ok(public.invite_set_sms_token(pg_temp.inv('e5100000-0000-0000-0000-000000000007'), pg_temp.hash(pg_temp.tok(12))), 'the text gets its own link');
select public.portal_wizard_invite_delivered(pg_temp.inv('e5100000-0000-0000-0000-000000000007'), true);
select is(public.portal_wizard_invite_lookup(pg_temp.hash(pg_temp.tok(12)))->>'via', 'sms', 'lookup knows the text link');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000007');
select is(public.portal_wizard_invite_accept(pg_temp.tok(12)), 'e5100000-0000-0000-0000-000000000007'::uuid, 'opened from the text link');
select is(public.contact_pending_mine()->>'kind', 'email', 'the email still has to be confirmed');
select public.portal_my_password_created();
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000007', pg_temp.dv('e5100000-0000-0000-0000-000000000007'), 'k-text', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  '42501', 'Confirm your email with the code we send you before signing', 'no signature before the email code');
reset role;
select public.contact_code_issue('b5100000-0000-0000-0000-000000000007', '654321');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000007');
select is(public.contact_code_verify('111111', 'e5100000-0000-0000-0000-000000000007')->>'ok', 'false', 'wrong email code refused');
select is(public.contact_code_verify('654321', 'e5100000-0000-0000-0000-000000000007')->>'ok', 'true', 'email confirmed with the code');
select lives_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000007', pg_temp.dv('e5100000-0000-0000-0000-000000000007'), 'k-text', jsonb_build_object('signature', pg_temp.sig(), 'declarations', pg_temp.decl()))$$,
  'then the student signs and submits');
reset role;
select ok(pg_temp.events('e5100000-0000-0000-0000-000000000007') like '%mobile_confirmed%email_confirmed%', 'both confirmations on the timeline');

-- 13. CONTACT-VERIFY everyone: employee / CMS / signing links use the same method (generic link aliases, proofs and codes).
select ok(public.link_alias_add('staff', 'f5100000-0000-0000-0000-000000000001', pg_temp.hash(pg_temp.tok(21)), pg_temp.hash(pg_temp.tok(22)),
  'Staff.Person@example.test', '+61412345678', now() + interval '7 days'), 'an employee link gets a text alias');
select is(public.link_opened(pg_temp.hash(pg_temp.tok(22)))->>'via', 'sms', 'the text alias is recognised');
select is(public.link_opened(pg_temp.hash(pg_temp.tok(22)))->>'base', pg_temp.hash(pg_temp.tok(21)), 'the text alias opens the emailed link''s record');
select ok(public.link_email_pending('staff', 'f5100000-0000-0000-0000-000000000001'), 'opened from the text: the email waits for a code');
select is(public.link_code_issue('staff', 'f5100000-0000-0000-0000-000000000001', '246810')->>'to', 'staff.person@example.test', 'the code goes to the email');
select throws_ok($$select public.link_code_issue('staff', 'f5100000-0000-0000-0000-000000000001', '135791')$$, '22023',
  'A code was just sent. Wait a minute before asking for another', 'one code a minute');
select is(public.link_code_verify('staff', 'f5100000-0000-0000-0000-000000000001', '000000')->>'ok', 'false', 'a wrong code is refused');
select is(public.link_code_verify('staff', 'f5100000-0000-0000-0000-000000000001', '246810')->>'ok', 'true', 'the right code confirms the email');
select ok(not public.link_email_pending('staff', 'f5100000-0000-0000-0000-000000000001'), 'nothing left to confirm');
select public.link_alias_add('cms', 'f5100000-0000-0000-0000-000000000002', null, pg_temp.hash(pg_temp.tok(23)), 'cms.person@example.test', '+61412345679', now() + interval '7 days');
select public.link_opened(pg_temp.hash(pg_temp.tok(23)));
select ok(public.link_alias_use(pg_temp.hash(pg_temp.tok(23))) and public.link_alias_use(pg_temp.hash(pg_temp.tok(23))) is null, 'a CMS text link is used once');

-- 14. STUDENT-WITHDRAW: the student withdraws their own submitted application (with a reason); nobody else does it this way.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.portal_student_withdraw('e5100000-0000-0000-0000-000000000007', 'Changed my mind')$$, '42501',
  'Only the student can withdraw their own application', 'the agent cannot withdraw as the student');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000007');
select throws_ok($$select public.portal_student_withdraw('e5100000-0000-0000-0000-000000000007', 'no')$$, '22023',
  'Tell us briefly why you are withdrawing (at least 5 characters)', 'a reason is needed');
select is(public.portal_student_withdraw('e5100000-0000-0000-0000-000000000007', 'Studying elsewhere')->>'status', 'withdrawn', 'the student withdraws');
reset role;
select is((select status from public.enrollment_applications where id = 'e5100000-0000-0000-0000-000000000007'), 'withdrawn', 'the application is withdrawn');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000007');
select throws_ok($$select public.portal_student_withdraw('e5100000-0000-0000-0000-000000000007', 'Studying elsewhere')$$, '22023', null, 'not twice');
reset role;

-- SUBMITTED-NEEDS-SIGNATURE (20261127180517): only a student-signed application becomes Submitted, whoever asks.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
-- STATUS-OVERRIDES (20261128012517): Under review is legacy and no longer a target.
select throws_ok($$select public.portal_set_application_status('e5100000-0000-0000-0000-000000000002', 'under_review', 'Checking')$$, null, null, 'staff can no longer move the signed application to Under review (legacy)');
select ok((select status from public.enrollment_applications where id = 'e5100000-0000-0000-0000-000000000002') <> 'under_review', 'the refused move changes nothing (the application never reaches Under review)');
select lives_ok($$select public.portal_set_application_status('e5100000-0000-0000-0000-000000000002', 'action_required', 'Please fix the passport')$$, 'staff send it back for a correction');
select throws_ok($$select public.portal_set_application_status('e5100000-0000-0000-0000-000000000002', 'submitted', 'Set by staff')$$, '42501',
  'Only the student can submit this application, by signing it (under 18: with their parent or guardian). Send it to the student to sign.', 'a SLIT admin cannot Set to Submitted after a correction: the student signs again');
reset role;
-- fixture only: a never-signed application moved on (withdrawn) without the guards
set local session_replication_role = replica; update public.enrollment_applications set status = 'withdrawn' where id = 'e5100000-0000-0000-0000-000000000005'; set local session_replication_role = origin;
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select throws_ok($$select public.portal_set_application_status('e5100000-0000-0000-0000-000000000005', 'submitted', 'Set by staff')$$, '42501', null, 'an application the student never signed cannot be Set to Submitted');
reset role;
insert into public.enrollment_applications(id, agency_id, status, data) values ('e5100000-0000-0000-0000-0000000000a9', 'a5100000-0000-0000-0000-000000000001', 'draft', '{}');
select throws_ok($$update public.enrollment_applications set status = 'submitted' where id = 'e5100000-0000-0000-0000-0000000000a9'$$, '42501', null, 'no writer (not even the database owner) makes an unsigned draft Submitted');

-- SIGNED-APPLICATION (20261128015517): once signed nobody changes the application (SLIT admins included); the student record still changes.
reset role;
set local session_replication_role = replica; update public.enrollment_applications set status = 'submitted' where id = 'e5100000-0000-0000-0000-000000000002'; set local session_replication_role = origin;
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0411000000"}}')$$, '42501', null, 'the agent cannot change a Submitted application');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0499999999"}}')$$, '42501',
  'This application is signed, so it cannot be changed. To correct it, send it back with Action required: the student corrects it and signs again.', 'a SLIT admin cannot change a signed application either');
reset role;
select throws_ok($$update public.enrollment_applications set data = jsonb_set(data, '{values,preferred_intake}', '"Jan 2030"') where id = 'e5100000-0000-0000-0000-000000000002'$$, '42501', null,
  'no writer (not even the database owner) changes a signed application''s answers');
-- Personal answers live on the student record (STUDENT-DETAILS-ON-STUDENT): a write of one goes there, the student's data, and is allowed.
update public.enrollment_applications set data = jsonb_set(data, '{values,mobile}', '"0400000001"') where id = 'e5100000-0000-0000-0000-000000000002';
select is((select s.details->>'mobile' || '|' || coalesce(a.data->'values'->>'mobile', '-') from public.enrollment_applications a join public.enrollment_students s on s.id = a.student_id
  where a.id = 'e5100000-0000-0000-0000-000000000002'), '0400000001|-', 'a personal detail is the student''s data: it changes on the student record, not on the signed application');
select lives_ok($$update public.enrollment_students set details = coalesce(details, '{}') || '{"mobile_note": "changed after signing"}' where id = (select student_id from public.enrollment_applications where id = 'e5100000-0000-0000-0000-000000000002')$$,
  'the student record still changes');
select lives_ok($$update public.enrollment_applications set status = 'under_review' where id = 'e5100000-0000-0000-0000-000000000002'$$, 'status moves still work');
-- What the Review & signature card shows: the stored declaration wording, no signing certificate details.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select ok(jsonb_typeof(public.application_signed_copy('e5100000-0000-0000-0000-000000000002')->'declarations') = 'array', 'SLIT admins read the signed copy');
select ok(not ((public.application_signed_copy('e5100000-0000-0000-0000-000000000002') - 'submission')::text ~ '"(ip|userAgent|user_agent|hash|textHash|text_hash)":')
  and not coalesce(public.application_signed_copy('e5100000-0000-0000-0000-000000000002') -> 'submission' -> 'snapshot' -> 'submission' ?| array['actor', 'consentIds', 'ip', 'userAgent'], false),
  'no IP, user agent or hash in the signed copy');
select ok(coalesce((select bool_and(d->>'body' is not null and length(d->>'body') > 20) from jsonb_array_elements(public.application_signed_copy('e5100000-0000-0000-0000-000000000002')->'declarations') d), false),
  'each declaration comes with the wording the student agreed to');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select ok(jsonb_typeof(public.application_signed_copy('e5100000-0000-0000-0000-000000000002')->'declarations') = 'array', 'the agent reads it too');
reset role;
-- STUDENT-AGENT-CHANGE (20261127190517): the student picks another active agent of their own agency
insert into public.agents(id, business_id, full_name, email, status) values
  ('a6100000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001', 'First Agent', 'first.agent@blackhole.postmarkapp.com', 'Active'),
  ('a6100000-0000-0000-0000-000000000002', 'a5100000-0000-0000-0000-000000000001', 'Second Agent', 'second.agent@blackhole.postmarkapp.com', 'Active');
update public.enrollment_students set agent_id = 'a6100000-0000-0000-0000-000000000001' where id = (select student_id from public.enrollment_applications where id = 'e5100000-0000-0000-0000-000000000002');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select lives_ok($$select public.portal_student_change_agent('a6100000-0000-0000-0000-000000000002')$$, 'the student changes to another agent of their agency');
reset role;
select is((select agent_id from public.enrollment_students where id = (select student_id from public.enrollment_applications where id = 'e5100000-0000-0000-0000-000000000002')), 'a6100000-0000-0000-0000-000000000002'::uuid, 'the student record names the new agent');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select throws_ok($$select public.portal_student_change_agent(gen_random_uuid())$$, '22023', null, 'an agent outside the agency is refused');
reset role;

-- SIGNED-APPLICATION (20261128015517): the student gets the submission confirmation too; the email worker stores the signed copy once
-- (lease-checked, PDFs only); the student, the agent and staff open it; the worker reads what was signed with no certificate details.
reset role;
select ok(exists (select 1 from public.notification_deliveries d join public.enrollment_applications a on a.id = d.application_id
  where d.application_id = 'e5100000-0000-0000-0000-000000000002' and d.event = 'application_submitted' and lower(d.recipient_email) = lower(a.student_email)),
  'the student gets the submission confirmation');
update public.notification_deliveries set state = 'sending', lease_token = 'f5100000-0000-0000-0000-0000000000aa', lease_expires_at = now() + interval '5 minutes'
 where id = (select d.id from public.notification_deliveries d join public.enrollment_applications a on a.id = d.application_id
   where d.application_id = 'e5100000-0000-0000-0000-000000000002' and d.event = 'application_submitted' and lower(d.recipient_email) = lower(a.student_email) limit 1);
select is((public.notification_delivery_submission((select id from public.notification_deliveries where lease_token = 'f5100000-0000-0000-0000-0000000000aa'), 'f5100000-0000-0000-0000-0000000000aa')->>'storeCopy'), 'true',
  'the first send is told to store the portal copy');
select ok(jsonb_array_length(public.notification_delivery_submission((select id from public.notification_deliveries where lease_token = 'f5100000-0000-0000-0000-0000000000aa'), 'f5100000-0000-0000-0000-0000000000aa')->'signed'->'declarations') >= 1
  and not ((public.notification_delivery_submission((select id from public.notification_deliveries where lease_token = 'f5100000-0000-0000-0000-0000000000aa'), 'f5100000-0000-0000-0000-0000000000aa')->'signed')::text ~ '"(ip|userAgent|user_agent|hash|text_hash)":'),
  'the worker gets what was signed, with no signing certificate details');
select throws_ok($$select public.notification_store_signed_copy((select id from public.notification_deliveries where lease_token = 'f5100000-0000-0000-0000-0000000000aa'), 'f5100000-0000-0000-0000-0000000000aa', encode(convert_to(repeat('not a pdf ', 20), 'UTF8'), 'base64'))$$,
  '22023', null, 'only a PDF is stored');
select ok(public.notification_store_signed_copy((select id from public.notification_deliveries where lease_token = 'f5100000-0000-0000-0000-0000000000aa'), 'f5100000-0000-0000-0000-0000000000aa', encode(convert_to('%PDF-1.4' || repeat(' signed', 30), 'UTF8'), 'base64')), 'the worker stores the signed copy');
select ok(not public.notification_store_signed_copy((select id from public.notification_deliveries where lease_token = 'f5100000-0000-0000-0000-0000000000aa'), gen_random_uuid(), encode(convert_to('%PDF-1.4' || repeat(' other', 30), 'UTF8'), 'base64')), 'not without the delivery''s lease');
select is((select count(*)::int from public.application_signed_copies where application_id = 'e5100000-0000-0000-0000-000000000002'), 1, 'one copy per submission');
select is((public.notification_delivery_submission((select id from public.notification_deliveries where lease_token = 'f5100000-0000-0000-0000-0000000000aa'), 'f5100000-0000-0000-0000-0000000000aa')->>'storeCopy'), 'false', 'later sends do not store it again');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select is(left(convert_from(decode(public.application_signed_copy_file('e5100000-0000-0000-0000-000000000002')->>'content', 'base64'), 'UTF8'), 5), '%PDF-', 'the agent opens the stored signed copy');
select ok(public.application_signed_copy('e5100000-0000-0000-0000-000000000002')->'storedCopy' is not null, 'the card knows it is kept in the portal');
reset role;
-- APPLICATION-FORM-TEMPLATES (20261128016517): the default Application form is recorded for each submission; one default; staff choose it.
reset role;
select ok(exists (select 1 from hr.sign_templates where category = 'application_form' and is_default and deleted_at is null), 'a default Application form exists');
select ok(exists (select 1 from public.application_form_used u where u.application_id = 'e5100000-0000-0000-0000-000000000002' and u.body_html like '%{{application.answers}}%'),
  'each submission keeps a copy of the form it prints from');
select throws_ok($$insert into hr.sign_templates(name, title, body_html, kind, audience, category, created_by, is_default, roles) values ('Second default', 'X', '<p>x</p>', 'text', 'student', 'application_form', gen_random_uuid(), true, '[]')$$,
  '23505', null, 'only one Application form is the default');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.application_form_template_set_default((select id from hr.sign_templates where category = 'application_form' and is_default limit 1))$$, null, null, 'an agent cannot choose the default form');
select ok(public.application_signed_copy('e5100000-0000-0000-0000-000000000002')->'formTemplate'->>'name' is not null, 'the signed copy names the form it prints from');
reset role;
-- LETTERHEAD-DESIGNER (20261128019517): only administrators apply a letterhead; it goes where they choose, as new template versions.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.letterhead_apply('{"name":"X","style":"modern","html":{"app_header":"<p>H</p>","app_footer":"<p>F</p>"}}', array['application_form'])$$, null, null, 'an agent cannot apply a letterhead');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select throws_ok($$select public.letterhead_apply('{"name":"X","style":"modern","html":{"app_header":"<p>H</p><script>x</script>","app_footer":"<p>F</p>"}}', array['application_form'])$$, null, null, 'unsafe HTML is refused');
select throws_ok($$select public.letterhead_apply('{"name":"X","style":"modern","html":{}}', array['application_form'])$$, '22023', null, 'a target without its letterhead is refused');
select lives_ok($$select public.letterhead_apply('{"name":"Modern test","style":"modern","designer":"built-in","spec":{},"html":{
  "app_header":"<p>APP HEADER</p>","app_header_later":"<p>APP LATER</p>","app_footer":"<p>APP FOOTER RTO CRICOS</p>",
  "loo_header":"<p>LOO HEADER</p>","loo_header_later":"<p>LOO LATER</p>","loo_footer":"<p>{{document.title}} | {{document.version}} | LOO FOOTER</p>",
  "preset_header":"<p>PRESET HEADER</p>","preset_footer":"<p>PRESET FOOTER</p>","workbook_header":"<p>WORKBOOK</p>"}}',
  array['application_form','letter_of_offer','document_templates','workbooks'])$$, 'an administrator applies a letterhead everywhere');
reset role;
select is((select header_html || '|' || header_later_html || '|' || footer_html from hr.sign_templates where category = 'application_form' and is_default and deleted_at is null),
  '<p>APP HEADER</p>|<p>APP LATER</p>|<p>APP FOOTER RTO CRICOS</p>', 'the default Application form has the letterhead (header, later-page header, footer)');
select ok((select count(*) from hr.sign_template_versions v join hr.sign_templates t on t.id = v.template_id where t.category = 'application_form' and t.is_default and v.snapshot->>'header_html' = '<p>APP HEADER</p>') = 1,
  'as a new version (earlier ones kept)');
select is((select html from hr.sign_template_parts where kind = 'header' and name = 'SLIT house letterhead' and deleted_at is null), '<p>PRESET HEADER</p>', 'the document template presets have it');
select is(public.letter_standard_header(), '<p>LOO HEADER</p>', 'a new Letter of Offer starts with it');
select is(public.letter_standard_footer('MY TITLE', 'Version 9'), '<p>MY TITLE | Version 9 | LOO FOOTER</p>', 'with the letter''s own title and version in the footer');
select is((select count(*)::int from public.brand_letterheads where active), 1, 'one active letterhead');
insert into public.enrollment_application_versions(application_id, version, snapshot) values ('e5100000-0000-0000-0000-000000000002', 98, '{}');
select is((select header_later_html from public.application_form_used where application_id = 'e5100000-0000-0000-0000-000000000002' and version = 98), '<p>APP LATER</p>',
  'a new submission keeps the later-page header with the form');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select is(public.brand_letterhead_active()->>'workbookHeader', '<p>WORKBOOK</p>', 'workbook added pages get the strip when workbooks were chosen');
reset role;
-- LETTERHEAD-ON-DOCUMENTS (20261128020517): "Put on letterhead" on any written template; it follows the chosen letterhead.
insert into hr.sign_templates(id, name, title, kind, audience, category, body_html, header_html, footer_html, created_by)
  values ('f5100000-0000-0000-0000-0000000000aa', 'ZZ consent', 'ZZ consent', 'text', 'any', 'consent_form', '<p>Body</p>', '<p>OWN HEADER</p>', '<p>OWN FOOTER</p>', 'b5100000-0000-0000-0000-000000000004');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select throws_ok($$select public.sign_template_use_letterhead('f5100000-0000-0000-0000-0000000000aa', true)$$, null, null, 'an agent cannot put a template on the letterhead');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select lives_ok($$select public.sign_template_use_letterhead('f5100000-0000-0000-0000-0000000000aa', true)$$, 'an administrator ticks Put on letterhead');
reset role;
select is((select header_html || '|' || footer_html || '|' || version from hr.sign_templates where id = 'f5100000-0000-0000-0000-0000000000aa'), '<p>PRESET HEADER</p>|<p>PRESET FOOTER</p>|2',
  'the template takes the letterhead, as a new version');
update hr.sign_templates set header_html = '<p>TYPED OVER</p>' where id = 'f5100000-0000-0000-0000-0000000000aa';
select is((select header_html from hr.sign_templates where id = 'f5100000-0000-0000-0000-0000000000aa'), '<p>PRESET HEADER</p>', 'while ticked, a save keeps the letterhead');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select throws_ok($$select public.letterhead_apply('{"name":"X","style":"modern","html":{"app_header":"<p>H</p>","app_footer":"<p>F</p>"}}', array['application_form'])$$, '22023', null, 'a design without the document letterhead is refused');
select lives_ok($$select public.letterhead_apply('{"name":"Classic two","style":"classic","designer":"ai","spec":{},"html":{"preset_header":"<p>NEW HEADER</p>","preset_header_later":"<p>NEW LATER</p>","preset_footer":"<p>NEW FOOTER</p>"}}', array['workbooks'])$$,
  'another letterhead is applied');
reset role;
select is((select header_html || '|' || header_later_html || '|' || footer_html || '|' || version from hr.sign_templates where id = 'f5100000-0000-0000-0000-0000000000aa'), '<p>NEW HEADER</p>|<p>NEW LATER</p>|<p>NEW FOOTER</p>|3',
  'the ticked template follows the new letterhead as a new version');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select lives_ok($$select public.sign_template_use_letterhead('f5100000-0000-0000-0000-0000000000aa', false)$$, 'unticking');
reset role;
update hr.sign_templates set header_html = '<p>MY OWN AGAIN</p>' where id = 'f5100000-0000-0000-0000-0000000000aa';
select is((select header_html from hr.sign_templates where id = 'f5100000-0000-0000-0000-0000000000aa'), '<p>MY OWN AGAIN</p>', 'unticked, the header is the template''s own again');
select * from finish();
rollback;
