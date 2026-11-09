begin;
-- Staff self-registration (hr schema): phone normalisation, duplicate checks, RLS, role and approval rules, status log.
-- Fixtures only; rolled back. Run: npx supabase test db
select plan(137);

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

-- ---------------------------------------------------------------- job posts and job applications (20261106120000)
reset role;
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
 ('a0000000-0000-0000-0000-000000000008', 'job.seeker@example.test', now(), '{"staff_phone":"+61 400 000 008"}', 'authenticated', 'authenticated');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000008';
select throws_ok($$select public.hr_admin_job_save(null, '{"title":"Trainer","description":"Teach.","employmentType":"full_time","location":"Melbourne"}')$$, '42501', null, 'only an administrator posts a job');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_job_save(null, '{"title":"T","description":"Teach.","employmentType":"full_time","location":"Melbourne"}')$$, '22023', 'Enter a job title (2 to 150 characters).', 'a job needs a title');
select throws_ok($$select public.hr_admin_job_save(null, '{"title":"Trainer","description":"Teach.","employmentType":"casual","location":"Melbourne"}')$$, '22023', 'Choose Full time or Part time.', 'full time or part time only');
select lives_ok($$select public.hr_admin_job_save(null, '{"title":"Trainer (test post)","description":"Teach.","employmentType":"part_time","location":"Melbourne"}')$$, 'an administrator posts a job');
reset role;
insert into hr.jobs(id, title, description, employment_type, salary, location, published_at) values
 ('f0000000-0000-0000-0000-000000000001', 'Commercial Cookery Trainer', 'Teach commercial cookery.', 'full_time', '$80,000 + super', 'Melbourne, VIC', now());
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select is(jsonb_array_length(public.hr_admin_job_list()), 2, 'the admin list shows every job');
select is((select e->>'applied' from jsonb_array_elements(public.hr_admin_job_list()) e where e->>'id' = 'f0000000-0000-0000-0000-000000000001'), '0', 'with its applicant count');
set local role anon;
select is(jsonb_array_length(public.jobs_open()), 2, 'anyone sees the open jobs');
select is(public.jobs_open('f0000000-0000-0000-0000-000000000001')->0->>'employmentType', 'full_time', 'with the employment type');
select throws_ok($$select * from hr.jobs$$, '42501', null, 'the table itself is not readable by visitors');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000008';
select lives_ok($$select public.hr_staff_start()$$, 'the job seeker''s account is created from the sign-up (a draft)');
select throws_ok($$select public.hr_job_apply('f0000000-0000-0000-0000-000000000001', 'Dear team', null)$$, '22023', 'Upload your resume.', 'a resume is required');
reset role;
insert into storage.objects(bucket_id, name) select 'staff-documents', 'a0000000-0000-0000-0000-000000000008/' || a.id || '/resume.docx'
 from hr.staff_applications a join hr.staff_profiles p on p.id = a.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000008';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000008';
select lives_ok($$select public.hr_staff_document_register('Resume', 'a0000000-0000-0000-0000-000000000008/' || (select a.id from hr.staff_applications a join hr.staff_profiles p on p.id = a.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000008') || '/resume.docx', 'resume.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 2048)$$, 'a Word resume is registered');
select is((select extraction_status from hr.staff_documents where category = 'Resume' and is_current), 'unavailable', 'a resume is never sent for reading');
select throws_ok($$select public.hr_job_apply('f0000000-0000-0000-0000-000000000001', '', (select id from hr.staff_documents where category = 'Resume' and is_current))$$, '22023', 'Write a cover letter or upload one.', 'a cover letter is required');
select is(public.hr_job_apply('f0000000-0000-0000-0000-000000000001', 'Dear team, I would love to teach cookery.', (select id from hr.staff_documents where category = 'Resume' and is_current))->'profile'->>'status', 'job_applied', 'applying puts the person in the staff table as Job applied');
select is(jsonb_array_length(public.hr_staff_me()->'jobApplications'), 1, 'the applicant sees their job application');
select throws_ok($$select public.hr_job_apply('f0000000-0000-0000-0000-000000000001', 'Again', (select id from hr.staff_documents where category = 'Resume' and is_current))$$, '23505', 'You have already applied for this job.', 'no second application for the same job');
select throws_ok($$select public.hr_staff_submit()$$, '23514', null, 'a job applicant cannot submit the staff form before being hired');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select is(public.hr_admin_staff_list('job_applied')->>'total', '1', 'the staff list filters by Job applied');
select is(public.hr_admin_staff_list('job_applied')->'rows'->0->>'jobTitle', 'Commercial Cookery Trainer', 'and names the job');
select is((select e->>'applied' from jsonb_array_elements(public.hr_admin_job_list()) e where e->>'id' = 'f0000000-0000-0000-0000-000000000001'), '1', 'the job post counts the applicant');
select throws_ok($$select public.hr_admin_job_decide((select id from hr.job_applications where job_id = 'f0000000-0000-0000-0000-000000000001'), 'hired', null)$$, '23514', 'Mark the candidate selected before hiring.', 'hire requires selection');
select lives_ok($$select public.hr_admin_candidate_progress((select id from hr.job_applications where job_id = 'f0000000-0000-0000-0000-000000000001'), 'interview', now(), 'Interviewed', null)$$, 'record the interview');
select lives_ok($$select public.hr_admin_candidate_progress((select id from hr.job_applications where job_id = 'f0000000-0000-0000-0000-000000000001'), 'selected', null, null, null)$$, 'select the interviewed candidate');
select is(public.hr_admin_job_decide((select id from hr.job_applications where job_id = 'f0000000-0000-0000-0000-000000000001'), 'hired', null)->'profile'->>'status', 'draft', 'hired: the person completes the staff registration (a draft again)');
select is((select status from hr.job_applications where job_id = 'f0000000-0000-0000-0000-000000000001'), 'hired', 'the job application is marked hired');
select is((select note from hr.staff_status_events where from_status = 'job_applied' and to_status = 'draft' order by id desc limit 1), 'Hired for Commercial Cookery Trainer. Complete onboarding.', 'the applicant is told why');
select throws_ok($$select public.hr_admin_job_decide((select id from hr.job_applications where job_id = 'f0000000-0000-0000-0000-000000000001'), 'declined', null)$$, '23514', 'This job application has already been decided.', 'a decision is made once');
select lives_ok($$select public.hr_admin_job_save('f0000000-0000-0000-0000-000000000001', '{"status":"closed"}')$$, 'the job is closed');
reset role;
select is(jsonb_array_length(public.jobs_open()), 1, 'a closed job is no longer listed');
select is(public.jobs_open('f0000000-0000-0000-0000-000000000001')->0->>'status', 'closed', 'but its page can say it is closed');
select is(hr.staff_transition_allowed('submitted', 'job_applied'), false, 'a submitted staff application does not become a job application');
select is(hr.staff_transition_allowed('draft', 'job_applied'), true, 'a draft does');

-- ---------------------------------------------------------------- applicants list and an Admin adding a staff member (20261106130000)
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select is(jsonb_array_length(public.hr_admin_job_applications('f0000000-0000-0000-0000-000000000001')), 1, 'the applicants of a job are listed');
select is(public.hr_admin_job_applications()->0->>'email', 'job.seeker@example.test', 'with the applicant''s details');
select throws_ok($$select public.hr_admin_staff_create('a0000000-0000-0000-0000-000000000009', 'x@example.test', '+61400000009', 'A', 'B')$$, '42501', null, 'the browser cannot create staff records (service role only)');
reset role;
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
 ('a0000000-0000-0000-0000-000000000009', 'added.staff@example.test', null, '{"registrant":"staff","staff_phone":"+61400000009"}', 'authenticated', 'authenticated');
select is(public.hr_admin_staff_create('a0000000-0000-0000-0000-000000000009', 'added.staff@example.test', '0400 000 009', 'Added', 'Person', 'trainer', 'a0000000-0000-0000-0000-000000000004')->>'status', 'draft', 'an Admin-added staff member starts as a draft');
select is((select first_name || ' ' || last_name from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000009'), 'Added Person', 'with the name filled in');
select throws_ok($$select public.hr_admin_staff_create('a0000000-0000-0000-0000-000000000009', 'added.staff@example.test', '+61400000009', 'Added', 'Person')$$, '23505', 'This person already has a staff record.', 'not twice');
select is((select actor_kind from hr.staff_status_events e join hr.staff_profiles p on p.id = e.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000009'), 'admin', 'the log says an administrator added them');

-- ---------------------------------------------------------------- guard and append-only
reset role;
select throws_ok($$update hr.staff_profiles set status = 'active' where auth_user_id = 'a0000000-0000-0000-0000-000000000002'$$, '23514', null, 'draft -> active is not an allowed transition');
select throws_ok($$update hr.staff_status_events set note = 'edited'$$, '23514', 'The staff status log is append-only.', 'the log cannot be edited');
-- Master Data recruitment. Same profile through manual entry, verified claim and hiring.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('a0000000-0000-0000-0000-000000000010','manual.candidate@example.test',now(),'{"staff_phone":"+61400000010"}');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select set_config('test.hr_draft', (public.hr_admin_job_save(null, '{"title":"Draft role","description":"Test only","employmentType":"full_time","location":"Melbourne","department":"Training","vacancies":3,"status":"draft"}')->>'id'), true);
select is(jsonb_array_length(public.jobs_open(current_setting('test.hr_draft')::uuid)), 0, 'draft job is private even by known ID');
select is(public.hr_admin_job_save(current_setting('test.hr_draft')::uuid,'{"status":"open"}')->>'vacancies','3','publishing preserves vacancy details');
select is(public.jobs_open(current_setting('test.hr_draft')::uuid)->0->>'department','Training','published job is visible to Careers');
select set_config('test.hr_candidate',public.hr_admin_candidate_save(null,current_setting('test.hr_draft')::uuid,
 '{"firstName":"Manual","lastName":"Candidate","email":"manual.candidate@example.test","phone":"+61400000010"}','','Internal notes')::text,true);
select is(public.hr_admin_candidates(current_setting('test.hr_draft')::uuid,'screening','manual',20,0)->>'total','1','manual candidate appears in filtered search');
select is(public.hr_admin_employees(null,null,'manual.candidate@example.test',20,0)->>'total','0','screening candidate is outside the employee list');
select throws_ok($$select public.hr_admin_candidate_save(null,current_setting('test.hr_draft')::uuid,'{"firstName":"Manual","lastName":"Candidate","email":"manual.candidate@example.test","phone":"+61400000010"}','','')$$,'23505',null,'duplicate application blocked');
select throws_ok($$select public.hr_admin_candidate_progress(current_setting('test.hr_candidate')::uuid,'declined',null,null,'')$$,'22023','Record a reason for this decision.','rejection requires a reason');
select set_config('test.hr_person',public.hr_admin_candidate(current_setting('test.hr_candidate')::uuid)->>'profileId',true);
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000010';
select is(public.hr_staff_start()->'profile'->>'id',current_setting('test.hr_person'),'verified email and phone claim the same profile');
select throws_ok($$select public.hr_admin_candidate(current_setting('test.hr_candidate')::uuid)$$,'42501',null,'applicant cannot read internal recruitment details');
select throws_ok($$select public.hr_admin_employees(null,null,'',20,0)$$,'42501',null,'applicant cannot read employee records');
select throws_ok($$select public.hr_employee_invite_target(current_setting('test.hr_person')::uuid)$$,'42501',null,'employee invitation target is service only');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_candidate_progress(current_setting('test.hr_candidate')::uuid,'interview',now(),'Interview',null),
 public.hr_admin_candidate_progress(current_setting('test.hr_candidate')::uuid,'selected',null,null,null)$$,'interview and select manual candidate');
select is(public.hr_admin_candidate_progress(current_setting('test.hr_candidate')::uuid,'hired',null,null,'')::text,current_setting('test.hr_person'),'hiring returns the employee ID for the same person');
select is(public.hr_admin_employee(current_setting('test.hr_person')::uuid)->>'candidateId',current_setting('test.hr_candidate'),'employee links to the correct application');
select is(public.hr_admin_employee(current_setting('test.hr_person')::uuid)->>'status','draft','hiring leaves access in onboarding');
select is(public.hr_admin_employees('onboarding','Training','manual',20,0)->>'total','1','employee is searchable by department and status');
reset role;
select is((select count(*)::int from hr.staff_roles where profile_id = current_setting('test.hr_person')::uuid),0,'hiring grants no role');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select set_config('test.hr_job',current_setting('test.hr_draft'),true);
select ok(exists (select 1 from jsonb_array_elements(public.hr_admin_candidate(current_setting('test.hr_candidate')::uuid)->'history') event where event->'details'->>'status' = 'hired'),'hiring decision is in the audit log');
select set_config('test.hr_direct',public.hr_admin_employee_save(null,
 '{"firstName":"Direct","lastName":"Employee","email":"direct.employee@example.test","phone":"+61400000011"}',
 jsonb_build_object('jobTitle','Administrator','employmentType','full_time','managerId',current_setting('test.hr_person')))::text,true);
select is(public.hr_admin_employee(current_setting('test.hr_direct')::uuid)->>'managerId',current_setting('test.hr_person'),'direct employee is linked to the selected manager');
select throws_ok($$select public.hr_admin_employee_save(current_setting('test.hr_person')::uuid,
 '{"firstName":"Manual","lastName":"Candidate","email":"manual.candidate@example.test","phone":"+61400000010"}',
 jsonb_build_object('jobTitle','Trainer','employmentType','full_time','managerId',current_setting('test.hr_direct')))$$,
 '23514','The manager assignment would create a reporting cycle.','cyclic reporting lines are rejected');
select throws_ok($$select public.hr_admin_staff_activate(current_setting('test.hr_direct')::uuid)$$,'23514',null,'an unclaimed draft cannot be activated');
reset role;
select is(public.hr_employee_invite_target(current_setting('test.hr_direct')::uuid)->>'hasAccount','false','a direct hire has no Auth account before invitation');
-- A prior employment ends and the person is rehired through a new attempt for the same job.
update hr.staff_profiles set status = 'submitted' where id = current_setting('test.hr_person')::uuid;
update hr.staff_profiles set status = 'preboarding' where id = current_setting('test.hr_person')::uuid;
update hr.staff_profiles set status = 'active' where id = current_setting('test.hr_person')::uuid;
update hr.staff_profiles set status = 'inactive' where id = current_setting('test.hr_person')::uuid;
set local role authenticated;
select set_config('test.hr_rehire',public.hr_admin_candidate_save(null,current_setting('test.hr_job')::uuid,
 '{"firstName":"Manual","lastName":"Candidate","email":"manual.candidate@example.test","phone":"+61400000010"}','','')::text,true);
select lives_ok($$select public.hr_admin_candidate_progress(current_setting('test.hr_rehire')::uuid,'interview',now(),null,null),
 public.hr_admin_candidate_progress(current_setting('test.hr_rehire')::uuid,'selected',null,null,null)$$,'record a new interview and selection for rehire');
select is(public.hr_admin_candidate_progress(current_setting('test.hr_rehire')::uuid,'hired',null,null,'')::text,current_setting('test.hr_person'),'rehire reuses the original employee ID');
select is(public.hr_admin_candidate(current_setting('test.hr_candidate')::uuid)->>'status','hired','original hired application is preserved');
select is(public.hr_admin_employee(current_setting('test.hr_person')::uuid)->>'status','draft','rehire requires onboarding before activation');
reset role;
select * from finish();
rollback;
