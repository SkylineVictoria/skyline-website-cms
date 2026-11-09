begin;
-- Staff self-registration (hr schema): phone normalisation, duplicate checks, RLS, role and approval rules, status log.
-- Fixtures only; rolled back. Run: npx supabase test db
select plan(138);

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
select throws_ok($$select public.hr_staff_submit()$$, '23514', 'Tell us whether you are an Australian citizen.', 'submit is blocked until citizenship is answered');
select lives_ok($$select public.hr_staff_set_citizenship(false)$$, 'citizenship answered: not a citizen');
select is((public.hr_staff_me()->'summary'->>'required'), '5', 'a non-citizen needs five document types (passport, visa, English, academic, health insurance)');
select is(cardinality(hr.staff_required_categories(true)), 3, 'a citizen needs three (passport, academic, health insurance)');
select ok(not ('Driving Licence' = any(hr.staff_required_categories(false))) and not ('Driving Licence' = any(hr.staff_required_categories(true))), 'the driving licence is never required');
select throws_ok($$select public.hr_staff_submit()$$, '23514', 'A passport is required before you can submit.', 'submit is blocked without a passport');
select throws_ok($$update hr.staff_profiles set status = 'active' where auth_user_id = auth.uid()$$, '42501', null, 'an applicant cannot write their own status');
select throws_ok($$insert into hr.staff_roles(profile_id, role, granted_by) select id, 'admin', auth_user_id from hr.staff_profiles where auth_user_id = auth.uid()$$, '42501', null, 'an applicant cannot assign themselves a role');
select is(to_regprocedure('public.hr_staff_document_register(text, text, text, text, integer)')::text, null, 'the old upload function (no expiry, legacy categories) is dropped');
select throws_ok($$select public.hr_staff_document_register('Passport', 'a0000000-0000-0000-0000-000000000006/passport/p.pdf', 'p.pdf', 'application/pdf', 10)$$, '42883', null, 'and cannot be called by a signed-in user');

reset role;
insert into storage.objects(bucket_id, name) select 'staff-documents', 'a0000000-0000-0000-0000-000000000006/' || f
 from unnest(array['passport/p.pdf','visa/v.pdf','english/e.pdf','academic/a1.pdf','academic/a2.pdf','driving-licence/l.pdf','health-insurance/h.pdf','pte/x.pdf']) f;
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000006';
select throws_ok($$select public.hr_staff_document_add('Passport', 'a0000000-0000-0000-0000-000000000006/visa/v.pdf', 'p.pdf', 'application/pdf', 10, current_date + 400)$$, '22023', 'The document location is not valid.', 'a file outside the folder of its document type is refused');
select throws_ok($$select public.hr_staff_document_add('Passport', 'a0000000-0000-0000-0000-000000000006/passport/p.pdf', 'p.pdf', 'application/pdf', 10)$$, '22023', 'Enter the expiry date of your passport.', 'a passport needs an expiry date');
select throws_ok($$select public.hr_staff_document_add('Passport', 'a0000000-0000-0000-0000-000000000006/passport/p.pdf', 'p.pdf', 'application/pdf', 10, current_date - 1)$$, '22023', 'This passport has expired. Upload a current one.', 'an expired passport is refused');
select lives_ok($$select public.hr_staff_document_add('Passport', 'a0000000-0000-0000-0000-000000000006/passport/p.pdf', 'passport.pdf', 'application/pdf', 1234, current_date + 20)$$, 'passport registered with its expiry');
select throws_ok($$select public.hr_staff_submit()$$, '23514', 'Upload your visa.', 'a non-citizen must upload a visa');
select lives_ok($$select public.hr_staff_document_add('Visa', 'a0000000-0000-0000-0000-000000000006/visa/v.pdf', 'visa.pdf', 'application/pdf', 100, current_date + 400)$$, 'visa registered');
select throws_ok($$select public.hr_staff_submit()$$, '23514', 'Upload your English test result.', 'a non-citizen must upload an English test result');
select throws_ok($$select public.hr_staff_document_add('English', 'a0000000-0000-0000-0000-000000000006/english/e.pdf', 'e.pdf', 'application/pdf', 100, current_date - 1)$$, '22023', 'This English test result has expired. Upload a current one.', 'a past English expiry date is refused');
select lives_ok($$select public.hr_staff_document_add('English', 'a0000000-0000-0000-0000-000000000006/english/e.pdf', 'english.pdf', 'application/pdf', 100, null)$$, 'an English test result needs no expiry date');
select throws_ok($$select public.hr_staff_document_add('PTE', 'a0000000-0000-0000-0000-000000000006/pte/x.pdf', 'x.pdf', 'application/pdf', 100, null)$$, '22023', 'Unknown document type.', 'the legacy PTE category is refused');
select lives_ok($$select public.hr_staff_document_add('Academic', 'a0000000-0000-0000-0000-000000000006/academic/a1.pdf', 'a1.pdf', 'application/pdf', 100)$$, 'first academic file');
select lives_ok($$select public.hr_staff_document_add('Academic', 'a0000000-0000-0000-0000-000000000006/academic/a2.pdf', 'a2.pdf', 'application/pdf', 100)$$, 'second academic file');
select is((select count(*)::int from hr.staff_documents where category = 'Academic' and is_current), 2, 'academic results keep several current files');
select throws_ok($$select public.hr_staff_submit()$$, '23514', 'Upload your health insurance.', 'health insurance is required');
select lives_ok($$select public.hr_staff_document_add('Health Insurance', 'a0000000-0000-0000-0000-000000000006/health-insurance/h.pdf', 'h.pdf', 'application/pdf', 100, current_date + 200)$$, 'health insurance registered');
select throws_ok($$select public.hr_staff_document_add('Driving Licence', 'a0000000-0000-0000-0000-000000000006/driving-licence/l.pdf', 'l.pdf', 'application/pdf', 100, null)$$, '22023', 'Enter the expiry date of your driving licence.', 'a driving licence needs its expiry date');
select lives_ok($$select public.hr_staff_document_add('Driving Licence', 'a0000000-0000-0000-0000-000000000006/driving-licence/l.pdf', 'licence.pdf', 'application/pdf', 100, current_date + 700)$$, 'the optional driving licence is registered with its expiry');
select is((public.hr_staff_me()->'summary'->>'uploaded') || '/' || (public.hr_staff_me()->'summary'->>'expiringSoon'), '5/true', 'checklist: five of five required uploaded (the licence is not counted), passport expiring soon');
select lives_ok($$select public.hr_staff_submit()$$, 'submit works with every required document');
select is(public.hr_staff_access(), 'submitted', 'status is submitted');
select throws_ok($$select public.hr_staff_save('{"first_name":"Changed"}')$$, '23514', 'This application can no longer be edited.', 'a submitted application is read-only');
select throws_ok($$select public.hr_staff_set_citizenship(true)$$, '23514', 'This application can no longer be edited.', 'citizenship cannot change after submit (it decides whether a visa is required)');
select throws_ok($$insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size, status) select a.id, a.profile_id, 'Visa', 'a0000000-0000-0000-0000-000000000006/visa/forged.pdf', 'f.pdf', 'application/pdf', 1, 'approved' from hr.staff_applications a$$, '42501', null, 'a staff user cannot insert a document row directly');
select throws_ok($$insert into hr.staff_profiles(auth_user_id, email, phone_e164) values (auth.uid(), 'forged@example.test', '+61400999999')$$, '42501', null, 'a staff user cannot insert a profile row directly');
with u as (update hr.staff_profiles set first_name = 'Forged' returning 1) select is((select count(*)::int from u), 0, 'a staff user cannot update their submitted profile directly');
select throws_ok($$select public.hr_staff_document_add('Visa', 'a0000000-0000-0000-0000-000000000006/visa/v.pdf', 'v.pdf', 'application/pdf', 10, current_date + 400)$$, '23514', 'Only a rejected document can be replaced.', 'after submit only a rejected document can be replaced');
select throws_ok($$insert into storage.objects(bucket_id, name) values ('staff-documents', 'a0000000-0000-0000-0000-000000000006/visa/again.pdf')$$, '42501', null, 'no upload after submit while nothing is rejected');

-- ---------------------------------------------------------------- RLS
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select is((select count(*)::int from hr.staff_profiles), 1, 'an applicant sees only their own profile');
select is((select count(*)::int from hr.staff_documents), 0, 'an applicant cannot read another applicant''s documents');
select is((select count(*)::int from storage.objects where bucket_id = 'staff-documents'), 0, 'an applicant cannot read another applicant''s files');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select ok((select count(*)::int from hr.staff_profiles) >= 4, 'an admin sees every profile');
select is((select count(*)::int from storage.objects where bucket_id = 'staff-documents' and name like 'a0000000-%'), 8, 'an admin can read staff files');

-- ---------------------------------------------------------------- per-document review, re-upload of a rejected document
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000006';
select throws_ok($$select public.hr_admin_staff_document_review((select id from hr.staff_documents where category = 'Visa' and is_current), 'approved')$$, '42501', 'Only an administrator can do this.', 'an applicant cannot review documents');
with u as (update hr.staff_documents set status = 'approved' returning 1) select is((select count(*)::int from u), 0, 'an applicant cannot write a review field');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_document_review((select d.id from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.category = 'Visa' and d.is_current), 'rejected', ' ')$$, '22023', 'Add a note telling them what to fix.', 'a rejection needs a note');
select lives_ok($$select public.hr_admin_staff_document_review((select d.id from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.category = 'Visa' and d.is_current), 'rejected', 'Blurry scan')$$, 'admin rejects the visa with a note');
select throws_ok($$select public.hr_admin_staff_activate_account((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'trainer')$$, '23514', 'Approve every required document first (passport).', 'activation needs every required document approved');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000006';
select is((select d->>'status' || '/' || (d->>'reviewNote') from jsonb_array_elements(public.hr_staff_me()->'documents') d where d->>'category' = 'Visa'), 'rejected/Blurry scan', 'the applicant sees the rejection and its note');
select throws_ok($$select public.hr_staff_document_set_expiry((select id from hr.staff_documents where category = 'Passport' and is_current), current_date + 300)$$, '23514', 'Only a rejected document can be changed.', 'after submit only a rejected document''s date can change');
select lives_ok($$select public.hr_staff_document_set_expiry((select id from hr.staff_documents where category = 'Visa' and is_current), current_date + 450)$$, 'the applicant corrects the expiry date of the rejected visa');
select is((select d->>'status' || '/' || (d->>'reviewNote') || '/' || coalesce(d->>'reviewedAt', 'none') from jsonb_array_elements(public.hr_staff_me()->'documents') d where d->>'category' = 'Visa'), 'pending//none', 'a changed expiry date resets the review to pending');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_document_review((select d.id from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.category = 'Visa' and d.is_current), 'rejected', 'Still blurry')$$, 'admin rejects the visa again');
select lives_ok($$select public.hr_admin_staff_document_review((select d.id from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.storage_path like '%/academic/a1.pdf'), 'rejected', 'Wrong transcript')$$, 'admin rejects one academic file');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000006';
select lives_ok($$insert into storage.objects(bucket_id, name) values ('staff-documents', 'a0000000-0000-0000-0000-000000000006/academic/a3.pdf')$$, 'the applicant may upload into the academic folder');
select lives_ok($$select public.hr_staff_document_add('Academic', 'a0000000-0000-0000-0000-000000000006/academic/a3.pdf', 'a3.pdf', 'application/pdf', 100, null, (select id from hr.staff_documents where storage_path like '%/academic/a1.pdf'))$$, 'the rejected academic file is replaced');
select is((select string_agg(right(storage_path, 6) || ':' || status || ':' || is_current, ',' order by storage_path) from hr.staff_documents where category = 'Academic'), 'a1.pdf:rejected:false,a2.pdf:pending:true,a3.pdf:pending:true', 'the replacement is pending, the other file is untouched and the rejected one is kept');
select lives_ok($$insert into storage.objects(bucket_id, name) values ('staff-documents', 'a0000000-0000-0000-0000-000000000006/visa/v2.pdf')$$, 'the applicant may upload into the folder of a rejected document');
select throws_ok($$insert into storage.objects(bucket_id, name) values ('staff-documents', 'a0000000-0000-0000-0000-000000000006/passport/p2.pdf')$$, '42501', null, 'but not into the folder of a document that was not rejected');
select lives_ok($$select public.hr_staff_document_add('Visa', 'a0000000-0000-0000-0000-000000000006/visa/v2.pdf', 'visa2.pdf', 'application/pdf', 100, current_date + 500)$$, 'a rejected visa is re-uploaded after submit');
select is((select string_agg(status || ':' || is_current, ',' order by is_current) from hr.staff_documents where category = 'Visa'), 'rejected:false,pending:true', 'the new visa is pending and the rejected one is kept');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_document_review(d.id, 'approved') from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.is_current and d.category <> 'Driving Licence'$$, 'admin approves every current required document (the optional licence stays pending)');
select is((select r->'docs'->>'approved' || '/' || (r->'docs'->>'required') from jsonb_array_elements(public.hr_admin_staff_list()->'rows') r where r->>'email' = 'trainer.person@example.test'), '5/5', 'the list shows five of five approved while the optional licence is still pending');
select is((select count(*)::int from jsonb_array_elements(public.hr_admin_staff_list(p_statuses => array['submitted','preboarding'])->'rows') r where r->>'email' = 'trainer.person@example.test'), 1, 'p_statuses: the Applications tab (submitted + preboarding) lists a submitted applicant');
select is((select count(*)::int from jsonb_array_elements(public.hr_admin_staff_list(p_statuses => array['inactive','rejected'])->'rows') r where r->>'email' = 'trainer.person@example.test'), 0, 'p_statuses: the Inactive/Rejected tab does not');
select is((public.hr_admin_staff_list(p_statuses => array['submitted','preboarding'])->>'total')::int, (select count(*)::int from hr.staff_profiles where status in ('submitted','preboarding')), 'p_statuses: the total counts every matching status (the tab badge)');
select is((select count(*)::int from jsonb_array_elements(public.hr_admin_staff_list('submitted')->'rows') r where r->>'email' = 'trainer.person@example.test'), 1, 'p_status still works on its own');
select is((public.hr_admin_staff_list(p_statuses => '{}'::text[])->>'total')::int, (select count(*)::int from hr.staff_profiles), 'an empty p_statuses means no filter');
select throws_ok($$select public.hr_admin_staff_list(p_statuses => array['submitted','bogus'])$$, '22023', 'Unknown status.', 'every p_statuses value is validated');
select throws_ok($$select public.hr_admin_staff_list(p_statuses => array['active', null])$$, '22023', 'Unknown status.', 'a null p_statuses value is refused');
select throws_ok($$select public.hr_admin_staff_list('active', null, 50, 0, array['inactive'])$$, '22023', 'Use p_status or p_statuses, not both.', 'p_status and p_statuses cannot be combined');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select throws_ok($$select public.hr_admin_staff_list(p_statuses => array['submitted'])$$, '42501', 'Only an administrator can do this.', 'p_statuses still requires an administrator');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select is((select count(*)::int from pg_proc where proname = 'hr_admin_staff_list' and pronamespace = 'public'::regnamespace), 1, 'one hr_admin_staff_list only (no ambiguous overload)');
select ok(not has_function_privilege('anon', 'public.hr_admin_staff_list(text, text, integer, integer, text[])', 'execute') and has_function_privilege('authenticated', 'public.hr_admin_staff_list(text, text, integer, integer, text[])', 'execute'), 'the new signature is callable by signed-in users only');
reset role;
select is((select coalesce(parent_id, '-') || '/' || coalesce(route, '-') || '/' || label || '/' || permission_key || '/' || permission_scope || '/' || is_enabled from public.admin_menu_items where id = 'staff'), '-/-/Staff/cms.admin/current/true', 'menu: a top-level Staff group with the same admin-only permission');
select is((select parent_id || '/' || label || '/' || route || '/' || is_enabled from public.admin_menu_items where id = 'agency_staff'), 'staff/Employees//admin/staff/employees/true', 'menu: agency_staff moved under Staff as Employees, same id');
select is((select string_agg(id, ',' order by sort_order, id) from (select id, sort_order from public.admin_menu_items where parent_id is null and sort_order >= (select sort_order from public.admin_menu_items where id = 'agencies') order by sort_order, id limit 3) x), 'agencies,staff,website', 'menu: Staff comes right after Agencies');
set local role authenticated;
reset role;
update hr.staff_documents d set expiry_date = d.expiry_date + 1 from hr.staff_profiles p where p.id = d.profile_id and p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.category = 'Passport' and d.is_current;
select is((select d.status || '/' || d.review_note || '/' || coalesce(d.reviewed_by::text, 'none') from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.category = 'Passport' and d.is_current), 'pending//none', 'an expiry change made any other way also resets an approved document to pending');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select is((select r->'docs'->>'approved' || '/' || (r->'docs'->>'required') from jsonb_array_elements(public.hr_admin_staff_list()->'rows') r where r->>'email' = 'trainer.person@example.test'), '4/5', 'the list drops back to four of five approved');
select lives_ok($$select public.hr_admin_staff_document_review(d.id, 'approved') from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.category = 'Passport' and d.is_current$$, 'admin approves the passport again');

-- ---------------------------------------------------------------- approval: admin only, role rules, cms_users timing
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select throws_ok($$select public.hr_admin_staff_approve((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'admin', null, true)$$, '42501', 'Only an administrator can do this.', 'a non-admin cannot approve or assign a role');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_approve((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'admin')$$, '23514', 'Confirm that this person should become an Admin.', 'granting Admin needs the explicit confirm');
select throws_ok($$select public.hr_admin_staff_activate_account((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'admin')$$, '23514', 'Confirm that this person should become an Admin.', 'one-step activation as Admin needs the explicit confirm');
select lives_ok($$select public.hr_admin_staff_activate_account((select id from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'trainer', 'Welcome')$$, 'activate as trainer in one step once every document is approved');
select is((select status from hr.staff_profiles where auth_user_id = 'a0000000-0000-0000-0000-000000000006'), 'active', 'the account is active');
select is((select d.status from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id where p.auth_user_id = 'a0000000-0000-0000-0000-000000000006' and d.category = 'Driving Licence' and d.is_current), 'pending', 'a pending optional licence did not block activation');
reset role;
select throws_ok($$insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size) select a.id, a.profile_id, 'English Certificate', 'x/legacy.pdf', 'l.pdf', 'application/pdf', 1 from hr.staff_applications a limit 1$$, '23514', null, 'the legacy English Certificate category is no longer allowed in the table');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
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
