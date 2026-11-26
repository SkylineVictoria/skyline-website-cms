begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- APPLICATION-STUDENT-SIGNS (20261125190517): agent fills, only the student (and, under 18, a parent / guardian) signs and submits.
-- Synthetic fixtures, rolled back. Run: node scripts/lab/staff-lab.mjs sql
select plan(62);

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
update public.enrollment_applications set student_email = s.email from public.enrollment_students s where s.id = enrollment_applications.student_id
  and enrollment_applications.id::text like 'e5100000%';

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, true), set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);
$$;
create function pg_temp.tok(n int) returns text language sql as $$ select rpad('Tok' || n, 43, 'x') $$;
create function pg_temp.hash(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.decl() returns jsonb language sql security definer as $$
  select jsonb_object_agg(key, hash) from public.application_declaration_texts where active $$;
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
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-agent', jsonb_build_object('declarations', pg_temp.decl()))$$,
  '42501', null, 'agent submit refused');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-agent2', '{"confirmed":true,"authorised":true,"method":"electronic","declarationVersion":"1.0"}')$$,
  '42501', null, 'agent-ticked electronic consent refused');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000006');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-aa', jsonb_build_object('declarations', pg_temp.decl()))$$,
  '42501', null, 'agency admin submit refused');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000004');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-staff', jsonb_build_object('declarations', pg_temp.decl()))$$,
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
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0411111111"}}')$$,
  '42501', null, 'agent edit while with the student refused');
select ok(not public.portal_can_edit_application('e5100000-0000-0000-0000-000000000002'), 'portal_can_edit_application false for the agent');
reset role;

-- 4. Student: a link alone is not enough (no password / Google), then accept with a password.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000001');
select lives_ok($$select public.portal_wizard_invite_begin('e5100000-0000-0000-0000-000000000005', pg_temp.hash(pg_temp.tok(5)))$$, 'agent sends the no-password student');
reset role;
select public.portal_wizard_invite_delivered(pg_temp.inv('e5100000-0000-0000-0000-000000000005'), true);
select pg_temp.as_user('b5100000-0000-0000-0000-000000000005');
reset role;
select is(public.portal_wizard_invite_lookup(pg_temp.hash(pg_temp.tok(5)))->>'account', 'new', 'lookup: first-time email opens as a guest');
select is(public.portal_wizard_invite_lookup(pg_temp.hash(pg_temp.tok(1)))->>'account', 'login', 'lookup: an email with a password signs in');
select is(public.portal_wizard_invite_lookup(pg_temp.hash(pg_temp.tok(98)))->>'valid', 'false', 'lookup: unknown link invalid');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000005');
select is(public.portal_wizard_invite_accept(pg_temp.tok(5)), 'e5100000-0000-0000-0000-000000000005'::uuid, 'first-time student opens the application without a password');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000005', pg_temp.dv('e5100000-0000-0000-0000-000000000005'), 'k-nopass', jsonb_build_object('declarations', pg_temp.decl()))$$,
  '42501', 'Create your password before signing, so you can sign in to your SLIT account later', 'signing needs the password first');
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select is(public.portal_wizard_invite_accept(pg_temp.tok(1)), 'e5100000-0000-0000-0000-000000000002'::uuid, 'student accepts with a password');
select throws_ok($$select public.portal_wizard_invite_accept(pg_temp.tok(99))$$, '42501', null, 'unknown link refused');
reset role;
select ok(pg_temp.events('e5100000-0000-0000-0000-000000000002') = 'sent,accepted', 'timeline: sent, accepted');
select ok(pg_temp.mails('e5100000-0000-0000-0000-000000000002') like '%handoff_accepted%', 'agent told the student accepted');

-- 5. Student edits allowed fields; view-only fields refused.
select pg_temp.as_user('b5100000-0000-0000-0000-000000000002');
select lives_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"mobile":"0422222222","agent_agency":"Signs Agency"}}')$$,
  'student edits contact (unchanged agency allowed)');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"preferred_intake":"Jul 2027"}}')$$,
  '42501', null, 'student cannot change the intake');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"values":{"agent_agency":"Other"}}')$$,
  '42501', null, 'student cannot change the agency');
select throws_ok($$select public.portal_save_draft_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), '{"courses":[{"courseId":"X","variant":""}]}')$$,
  '42501', null, 'student cannot change the course');

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
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-adult', jsonb_build_object('declarations', pg_temp.decl() - 'usi_permission'))$$,
  '22023', null, 'every declaration must be ticked');
select throws_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-adult', jsonb_build_object('declarations', pg_temp.decl() || '{"esos_written_agreement":"00"}'))$$,
  '22023', null, 'a declaration with another text refused');
select lives_ok($$select public.portal_submit_v2('e5100000-0000-0000-0000-000000000002', pg_temp.dv('e5100000-0000-0000-0000-000000000002'), 'k-adult', jsonb_build_object('declarations', pg_temp.decl()))$$,
  'student signs and submits');
reset role;
select is(pg_temp.status('e5100000-0000-0000-0000-000000000002'), 'submitted', 'adult: submitted at once');
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
select is(public.portal_submit_v2('e5100000-0000-0000-0000-000000000003', pg_temp.dv('e5100000-0000-0000-0000-000000000003'), 'k-minor', jsonb_build_object('declarations', pg_temp.decl()))->>'state',
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
select throws_ok($$select public.portal_application_resubmit('e5100000-0000-0000-0000-000000000002', 'fixed', jsonb_build_object('declarations', pg_temp.decl()))$$,
  '42501', null, 'agent resubmit refused');
reset role;

select * from finish();
rollback;
