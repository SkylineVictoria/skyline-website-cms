begin;
-- Staff self-registration (hr schema): phone normalisation, duplicate checks, RLS, role and approval rules, status log.
-- Fixtures only; rolled back. Run: npx supabase test db
select plan(71);

-- ---------------------------------------------------------------- phone normalisation (same vectors as scripts/test-staff-registration.ts)
select is(hr.phone_e164('+61 412 345 678'), '+61412345678', 'e164 with spaces');
select is(hr.phone_e164('0412 345 678'), '+61412345678', 'australian mobile national format');
select is(hr.phone_e164('+61 (0)412 345 678'), '+61412345678', 'trunk zero in brackets removed');
select is(hr.phone_e164('0061412345678'), '+61412345678', '00 prefix');
select is(hr.phone_e164('(02) 9876 5432'), '+61298765432', 'australian landline');
select is(hr.phone_e164('+44 7700 900123'), '+447700900123', 'other country code');
select is(hr.phone_e164('9876543210'), null, 'no country code and not australian is rejected');
select is(hr.phone_e164('+0123'), null, 'too short / bad country code is rejected');

-- ---------------------------------------------------------------- fixtures
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
 ('a0000000-0000-0000-0000-000000000001', 'new.staff@example.test', now(), '{"staff_phone":"+61 400 000 001"}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000002', 'other.staff@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000003', 'student.login@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000004', 'admin.user@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000005', 'unverified@example.test', null, '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000006', 'trainer.person@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000007', 'admin.person@example.test', now(), '{}', 'authenticated', 'authenticated');
insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password) values
 ('hr-test-admin', 'Test Admin', 'admin.user@example.test', 'Admin', 'Active', 'a0000000-0000-0000-0000-000000000004', false);
insert into public.agencies(id, name, code) values ('b0000000-0000-0000-0000-000000000001', 'HR fixture business', 'HR-FIX');
insert into public.enrollment_students(id, agency_id, full_name, email, phone) values
 ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'Existing Student', 'student.login@example.test', '0411 222 333'),
 ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'Other Student', 'somebody.else@example.test', '+61 455 666 777');
insert into public.portal_profiles(id, auth_user_id, full_name, email, phone) values
 ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003', 'Existing Student', 'student.login@example.test', '0411 222 333');
insert into public.agency_memberships(user_id, agency_id, role, student_id) values
 ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'student', 'c0000000-0000-0000-0000-000000000001');
insert into public.agents(id, business_id, full_name, email, phone) values
 ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'An Agent', 'agent.person@example.test', '+61 477 888 999');

-- ---------------------------------------------------------------- duplicate checks (service role precheck)
select is(public.hr_staff_precheck('fresh@example.test', '+61 400 111 222')->>'ok', 'true', 'a new email and number pass');
select is(public.hr_staff_precheck('somebody.else@example.test', '+61 400 111 222')->>'emailConflict', 'true', 'student email is a conflict');
select is(public.hr_staff_precheck('fresh@example.test', '0455 666 777')->>'phoneConflict', 'true', 'student phone in a different format is a conflict');
select is(public.hr_staff_precheck('agent.person@example.test', '+61 400 111 222')->>'emailConflict', 'true', 'agent email is a conflict');
select is(public.hr_staff_precheck('fresh@example.test', '0477 888 999')->>'phoneConflict', 'true', 'agent phone in a different format is a conflict');
select is(public.hr_staff_precheck('ADMIN.USER@example.test', '+61 400 111 222')->>'emailConflict', 'true', 'admin user email is a conflict (case-insensitive)');
select is(public.hr_staff_precheck('fresh@example.test', 'not a number')->>'reason', 'invalid_phone', 'an invalid number is reported');

-- ---------------------------------------------------------------- applicant: start, duplicates, attach
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000005';
select throws_ok($$select public.hr_staff_start('+61 400 000 005')$$, '42501', 'Verify your email address first.', 'an unverified email cannot start');

set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select is((public.hr_staff_start()->'profile'->>'phone_e164'), '+61400000001', 'start takes the phone from the sign-up metadata, normalised');
select is((public.hr_staff_start('+61 499 999 999')->'profile'->>'phone_e164'), '+61400000001', 'starting again returns the same profile');
select is(public.hr_staff_access(), 'draft', 'access state is draft');

set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select throws_ok($$select public.hr_staff_start('0400 000 001')$$, '23505', 'This number can''t be used. Sign in or contact the administrator.', 'the same number in another format is refused with the neutral text');
select is((public.hr_staff_start('0400 000 002')->'profile'->>'status'), 'draft', 'a different number starts');

set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_staff_start('0400 000 004')$$, '23505', 'This email can''t be used. Sign in or contact the administrator.', 'an admin user cannot apply as staff');

set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
select is((public.hr_staff_start('0400 000 003')->>'attachedToExistingAccount'), 'true', 'an existing student attaches the application to the same login');
reset role;
select is((select count(*)::int from auth.users where lower(email) = 'student.login@example.test'), 1, 'no second login was created');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
select throws_ok($$select public.hr_staff_save('{"phone":"0455 666 777"}')$$, '23505', 'This number can''t be used. Sign in or contact the administrator.', 'changing to another person''s number is refused');

-- ---------------------------------------------------------------- applicant: edit, documents, submit
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000006';
select lives_ok($$select public.hr_staff_start('0400 000 006')$$, 'trainer applicant starts');
select lives_ok($$select public.hr_staff_save('{"first_name":"Tara","last_name":"Trainer","date_of_birth":"1990-05-06","address_street":"1 Example St","address_suburb":"Melbourne","address_state":"VIC","address_postcode":"3000","address_country":"Australia","emergency_name":"Em Contact","emergency_relationship":"Sibling","emergency_phone":"0422 333 444","requested_role":"trainer"}')$$, 'details save');
select is((public.hr_staff_me()->'profile'->>'emergency_phone_e164'), '+61422333444', 'emergency phone stored as E.164');
select throws_ok($$select public.hr_staff_submit()$$, '23514', 'A passport is required before you can submit.', 'submit is blocked without a passport');
select throws_ok($$update hr.staff_profiles set status = 'active' where auth_user_id = auth.uid()$$, '42501', null, 'an applicant cannot write their own status');
select throws_ok($$insert into hr.staff_roles(profile_id, role, granted_by) select id, 'admin', auth_user_id from hr.staff_profiles where auth_user_id = auth.uid()$$, '42501', null, 'an applicant cannot assign themselves a role');
select throws_ok($$select public.hr_staff_document_register('Passport', 'a0000000-0000-0000-0000-000000000006/00000000-0000-0000-0000-000000000000/p.pdf', 'p.pdf', 'application/pdf', 10)$$, '22023', 'The document location is not valid.', 'a document path outside the own application is refused');

reset role;
insert into storage.objects(bucket_id, name) select 'staff-documents', 'a0000000-0000-0000-0000-000000000006/' || a.id || '/passport.pdf'
 from hr.staff_applications a join hr.staff_profiles p on p.id = a.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000006';
select lives_ok($$select public.hr_staff_document_register('Passport', 'a0000000-0000-0000-0000-000000000006/' || (select id from hr.staff_applications limit 1) || '/passport.pdf', 'passport.pdf', 'application/pdf', 1234)$$, 'passport registered');
select lives_ok($$select public.hr_staff_submit()$$, 'submit works with a passport');
select is(public.hr_staff_access(), 'submitted', 'status is submitted');
select throws_ok($$select public.hr_staff_save('{"first_name":"Changed"}')$$, '23514', 'This application can no longer be edited.', 'a submitted application is read-only');

-- ---------------------------------------------------------------- RLS
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select is((select count(*)::int from hr.staff_profiles), 1, 'an applicant sees only their own profile');
select is((select count(*)::int from hr.staff_documents), 0, 'an applicant cannot read another applicant''s documents');
select is((select count(*)::int from storage.objects where bucket_id = 'staff-documents'), 0, 'an applicant cannot read another applicant''s files');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select ok((select count(*)::int from hr.staff_profiles) >= 4, 'an admin sees every profile');
select is((select count(*)::int from storage.objects where bucket_id = 'staff-documents' and name like 'a0000000-%'), 1, 'an admin can read staff files');

-- ---------------------------------------------------------------- approval: admin only, role rules, cms_users timing
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select throws_ok($$select public.hr_admin_staff_approve((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'admin', null, true)$$, '42501', 'Only an administrator can do this.', 'a non-admin cannot approve or assign a role');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_approve((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'admin')$$, '23514', 'Confirm that this person should become an Admin.', 'granting Admin needs the explicit confirm');
select lives_ok($$select public.hr_admin_staff_approve((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'trainer', 'Welcome')$$, 'approve as trainer');
select is((select status from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'preboarding', 'approval moves to preboarding');
select is((select count(*)::int from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 0, 'no CMS access at preboarding');
select lives_ok($$select public.hr_admin_staff_activate((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'))$$, 'activate the trainer');
select is((select count(*)::int from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 0, 'a trainer never gets a cms_users row');
select lives_ok($$select public.hr_admin_staff_deactivate((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'Left')$$, 'deactivate');
select is((select string_agg(to_status, '>' order by id) from hr.staff_status_events where profile_id = (select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006')),
 'draft>submitted>preboarding>active>inactive', 'every change is logged in order');

-- ---------------------------------------------------------------- Admin role: cms_users only at active, deactivate turns it off
reset role;
insert into hr.staff_profiles(auth_user_id, email, phone_e164, first_name, last_name) values ('a0000000-0000-0000-0000-000000000007', 'admin.person@example.test', '+61400000007', 'Ada', 'Admin');
insert into hr.staff_applications(profile_id, requested_role) select id, 'admin' from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000007';
update hr.staff_profiles set status = 'submitted' where auth_user_id = 'a0000000-0000-0000-0000-000000000007';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_approve((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000007'), 'admin', null, true)$$, 'approve as admin with the confirm');
select is((select count(*)::int from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000007'), 0, 'no CMS access at preboarding even for an admin role');
select lives_ok($$select public.hr_admin_staff_activate((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000007'))$$, 'activate the admin');
select is((select role || '/' || status from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000007'), 'Admin/Active', 'activation writes the Admin cms_users row');
select lives_ok($$select public.hr_admin_staff_deactivate((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000007'))$$, 'deactivate the admin');
select is((select status from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000007'), 'Inactive', 'deactivation switches CMS access off');

-- ---------------------------------------------------------------- reject and reopen
reset role;
update hr.staff_profiles set status = 'submitted' where auth_user_id = 'a0000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_reject((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000002'), '  ')$$, '22023', 'Add a note explaining the decision.', 'a rejection needs a note');
select lives_ok($$select public.hr_admin_staff_reject((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000002'), 'Documents unreadable')$$, 'reject with a note');
select is((select review_note from hr.staff_applications a join hr.staff_profiles p on p.id = a.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000002'), 'Documents unreadable', 'the note is kept on the application');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select throws_ok($$select public.hr_staff_reopen((select id from hr.staff_profiles where auth_user_id = auth.uid()), 'Let me in')$$, '42501', 'Only an administrator can do this.', 'the applicant cannot reopen their own rejection');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_staff_reopen((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000002'), 'Please upload again')$$, 'an admin reopens a rejected application');
select is((select status from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000002'), 'draft', 'reopened to draft');

-- ---------------------------------------------------------------- document reading fills EMPTY details only
reset role;
update hr.staff_profiles set last_name = 'Keep' where auth_user_id = 'a0000000-0000-0000-0000-000000000002';
insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size)
 select a.id, p.id, 'Passport', 'a0000000-0000-0000-0000-000000000002/' || a.id || '/p.pdf', 'p.pdf', 'application/pdf', 10
 from hr.staff_profiles p join hr.staff_applications a on a.profile_id = p.id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000002';
select lives_ok($$select public.hr_staff_document_apply_extraction((select id from hr.staff_documents where storage_path like 'a0000000-0000-0000-0000-000000000002/%'), 'done', '{"first_name":"Asha","last_name":"Overwritten","dob":"1999-04-05","passport_number":"X1234567","passport_expiry":"2031-08-09"}')$$, 'a passport reading is recorded');
select is((select first_name || '/' || last_name || '/' || date_of_birth from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000002'), 'Asha/Keep/1999-04-05', 'empty details are filled and typed ones are never overwritten');
select is((select extraction_status || '/' || (extracted->>'passport_number') || '/' || (extracted->>'passport_expiry') from hr.staff_documents where storage_path like 'a0000000-0000-0000-0000-000000000002/%'), 'done/X1234567/2031-08-09', 'document number and expiry are kept on the document');
select lives_ok($$select public.hr_staff_document_apply_extraction((select id from hr.staff_documents where storage_path like 'a0000000-0000-0000-0000-000000000002/%'), 'failed', '{}', 'unreadable')$$, 'a failed reading is recorded');
select is((select extraction_status || '/' || (extracted->>'passport_number') from hr.staff_documents where storage_path like 'a0000000-0000-0000-0000-000000000002/%'), 'failed/X1234567', 'a failure never wipes what was read');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select throws_ok($$select public.hr_staff_document_apply_extraction(gen_random_uuid(), 'done', '{}')$$, '42501', null, 'the browser cannot write a reading');
select is(public.hr_staff_document_for_extraction((select id from hr.staff_documents limit 1))::text, null, 'another applicant''s document is not offered for reading');
reset role;

-- ---------------------------------------------------------------- guard and append-only
reset role;
select throws_ok($$update hr.staff_profiles set status = 'active' where auth_user_id = 'a0000000-0000-0000-0000-000000000002'$$, '23514', null, 'draft -> active is not an allowed transition');
select throws_ok($$update hr.staff_status_events set note = 'edited'$$, '23514', 'The staff status log is append-only.', 'the log cannot be edited');
select * from finish();
rollback;
