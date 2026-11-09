begin;
-- Staff enrolment v2 (hr schema): phone normalisation, public apply, token links (hash only, expiry, replace, revoke, read-only
-- after submit), documents and review, re-upload, offer and signature, activation (new login or existing login), My HR,
-- rejection, retention, email outbox, privileges and the status log. Fixtures only; rolled back. Run: npx supabase test db
select plan(235);

-- ---------------------------------------------------------------- phone normalisation (same vectors as scripts/test-staff-registration.ts)
select is(hr.phone_e164('+61 412 345 678'), '+61412345678', 'e164 with spaces');
select is(hr.phone_e164('0412 345 678'), '+61412345678', 'australian mobile national format');
select is(hr.phone_e164('+61 (0)412 345 678'), '+61412345678', 'trunk zero in brackets removed');
select is(hr.phone_e164('0061412345678'), '+61412345678', '00 prefix');
select is(hr.phone_e164('(02) 9876 5432'), '+61298765432', 'australian landline');
select is(hr.phone_e164('+44 7700 900123'), '+447700900123', 'other country code');
select is(hr.phone_e164('9876543210'), null, 'no country code and not australian is rejected');
select is(hr.phone_e164('+0123'), null, 'too short / bad country code is rejected');

-- ---------------------------------------------------------------- fixtures and helpers
insert into auth.users(id, email, email_confirmed_at, invited_at, raw_user_meta_data, aud, role) values
 ('a0000000-0000-0000-0000-000000000003', 'Student.Login@example.test', now(), null, '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000004', 'admin.user@example.test', now(), null, '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000005', 'invited.trainer@example.test', null, now(), '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000006', 'someone.else@example.test', now(), null, '{}', 'authenticated', 'authenticated'),
 ('a0000000-0000-0000-0000-000000000007', 'never.confirmed@example.test', null, null, '{}', 'authenticated', 'authenticated');
insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password) values
 ('hr-test-admin', 'Test Admin', 'admin.user@example.test', 'Admin', 'Active', 'a0000000-0000-0000-0000-000000000004', false);

create temp table t(k text primary key, v text);
grant select, insert on t to public;
create function pg_temp.v(text) returns uuid language sql stable as $$ select v::uuid from t where k = $1 $$;
create function pg_temp.h(text) returns text language sql immutable as $$ select encode(sha256(convert_to($1, 'UTF8')), 'hex') $$;
create function pg_temp.obj(text) returns void language sql as $$ insert into storage.objects(bucket_id, name) values ('staff-documents', $1) $$;
-- Walks a fresh application to offer_signed with direct writes (the guard still checks every move).
create function pg_temp.to_signed(p_key text, p_first text, p_email text, p_phone text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
 v_id := (public.hr_svc_apply(p_first, 'Walker', p_email, p_phone)->>'profileId')::uuid;
 insert into t values (p_key, v_id);
 update hr.staff_profiles set status = 'invited' where id = v_id;
 update hr.staff_profiles set status = 'documents_submitted' where id = v_id;
 update hr.staff_applications set submitted_at = now() where profile_id = v_id;
 insert into storage.objects(bucket_id, name) values ('staff-documents', v_id || '/offer/o.pdf'), ('staff-documents', v_id || '/offer/s.pdf');
 insert into hr.staff_offers(profile_id, storage_path, filename, file_size, sha256, uploaded_by, sent_at, sent_by, signed_at, signer_name, consent_text, signed_path, signed_sha256)
  values (v_id, v_id || '/offer/o.pdf', 'o.pdf', 10, repeat('a', 64), 'a0000000-0000-0000-0000-000000000004', now(), 'a0000000-0000-0000-0000-000000000004', now(),
   p_first, 'I agree', v_id || '/offer/s.pdf', repeat('b', 64));
 update hr.staff_profiles set status = 'offer_sent' where id = v_id;
 update hr.staff_profiles set status = 'offer_signed' where id = v_id;
 return v_id;
end $$;

-- ---------------------------------------------------------------- status machine
select is(hr.staff_transition_allowed('applied','invited'), true, 'applied -> invited');
select is(hr.staff_transition_allowed('documents_submitted','invited'), true, 're-upload goes back to invited');
select is(hr.staff_transition_allowed('offer_sent','documents_submitted'), true, 'a withdrawn offer goes back to documents_submitted');
select is(hr.staff_transition_allowed('rejected','applied'), true, 'rejected -> applied (re-application or reopen)');
select is(hr.staff_transition_allowed('applied','active'), false, 'nobody skips to active');
select is(hr.staff_transition_allowed('invited','offer_sent'), false, 'no offer before the documents are submitted');
select is(hr.staff_transition_allowed('draft','submitted'), false, 'the old statuses are gone');
select throws_ok($$insert into hr.staff_profiles(email, phone_e164, status) values ('x@example.test', '+61400000999', 'invited')$$, '23514', 'A staff profile starts as an application.', 'a profile starts as applied');
select is((select column_default from information_schema.columns where table_schema = 'hr' and table_name = 'staff_profiles' and column_name = 'status'), '''applied''::text', 'the status default is applied');
select is((select is_nullable from information_schema.columns where table_schema = 'hr' and table_name = 'staff_profiles' and column_name = 'auth_user_id'), 'YES', 'a profile needs no login until activation');

-- ---------------------------------------------------------------- public apply (service role)
insert into t select 'a1', public.hr_svc_apply('Ann', 'Applicant', 'Ann.Applicant@Example.test', '0400 000 101')->>'profileId';
select is((select status || '/' || email || '/' || phone_e164 from hr.staff_profiles where id = pg_temp.v('a1')), 'applied/ann.applicant@example.test/+61400000101', 'a new application is applied, email lower-cased, phone in E.164');
select is((select auth_user_id from hr.staff_profiles where id = pg_temp.v('a1')), null, 'no login is created');
select is(public.hr_svc_apply('Ann', 'Again', 'ann.applicant@example.test', '0400 000 101')->>'profileId', pg_temp.v('a1')::text, 'the same email before the resume arrives reuses the application');
select is(public.hr_svc_apply('X', 'Y', 'fresh.one@example.test', '+61 400 000 101')->>'reason', 'exists', 'another email with the same number is refused neutrally');
select is(public.hr_svc_apply('X', 'Y', 'ADMIN.USER@example.test', '0400 000 199')->>'reason', 'exists', 'an admin user cannot apply');
select is(public.hr_svc_apply('X', 'Y', 'not-an-email', '0400 000 199')->>'reason', 'invalid_email', 'an invalid email is reported');
select is(public.hr_svc_apply('X', 'Y', 'ok@example.test', 'nope')->>'reason', 'invalid_phone', 'an invalid number is reported');
select is(public.hr_svc_apply('', 'Y', 'ok@example.test', '0400 000 199')->>'reason', 'invalid_name', 'a name is required');
select throws_ok($$select public.hr_svc_apply_resume(pg_temp.v('a1'), gen_random_uuid() || '/resume/cv.pdf', 'cv.pdf', 'application/pdf', 100)$$, '22023', 'The resume location is not valid.', 'the resume must be in the person''s own folder');
select throws_ok($$select public.hr_svc_apply_resume(pg_temp.v('a1'), pg_temp.v('a1') || '/resume/cv.pdf', 'cv.pdf', 'application/pdf', 100)$$, 'P0002', 'The uploaded file was not found.', 'the resume file must exist');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/resume/cv.pdf');
select throws_ok($$select public.hr_svc_apply_resume(pg_temp.v('a1'), pg_temp.v('a1') || '/resume/cv.pdf', 'cv.exe', 'application/x-msdownload', 100)$$, '22023', 'Upload a PDF or Word (.docx) file.', 'only PDF or DOCX');
select throws_ok($$select public.hr_svc_apply_resume(pg_temp.v('a1'), pg_temp.v('a1') || '/resume/cv.pdf', 'cv.pdf', 'application/pdf', 5242881)$$, '22023', 'The resume must be 5 MB or smaller.', 'the resume size limit');
select lives_ok($$select public.hr_svc_apply_resume(pg_temp.v('a1'), pg_temp.v('a1') || '/resume/cv.pdf', 'cv.pdf', 'application/pdf', 100)$$, 'the resume is recorded');
select is((select string_agg(kind || ':' || audience || ':' || coalesce(to_email, '-'), ',' order by id) from hr.staff_emails where profile_id = pg_temp.v('a1')),
 'application_received:applicant:ann.applicant@example.test,admin_new_application:admin:-', 'received (applicant) and new application (admin) are queued');
select is(public.hr_svc_apply('Ann', 'Again', 'ann.applicant@example.test', '0400 000 101')->>'reason', 'exists', 'a complete application cannot be submitted twice');
select is((select count(*)::int from hr.staff_emails where profile_id = pg_temp.v('a1') and kind = 'already_applied' and to_email = 'ann.applicant@example.test'), 1, 'that address is told it already has an application');
select is(public.hr_svc_apply('Ann', 'Thrice', 'ann.applicant@example.test', '0400 000 101')->>'reason', 'exists', 'a third try');
select is((select count(*)::int from hr.staff_emails where profile_id = pg_temp.v('a1') and kind = 'already_applied'), 1, 'at most one such email an hour');
select is(public.hr_svc_apply('Sam', 'Student', 'student.login@example.test', '0400 000 103')->>'ok', 'true', 'an existing student login may apply');
select is((select count(*)::int from auth.users where lower(email) = 'student.login@example.test'), 1, 'no second login was created');

-- ---------------------------------------------------------------- document links: admin only, hash only, replace, revoke
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000006';
select throws_ok($$select public.hr_admin_staff_invite(pg_temp.v('a1'), 'documents', pg_temp.h('tok-1'))$$, '42501', 'Only an administrator can do this.', 'only an administrator sends a link');
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_invite(pg_temp.v('a1'), 'documents', 'tok-1')$$, '22023', 'Invalid link hash.', 'only a sha256 hex hash is accepted');
select throws_ok($$select public.hr_admin_staff_invite(pg_temp.v('a1'), 'reupload', pg_temp.h('tok-1'))$$, '23514', 'Reject at least one document before asking for a new upload.', 'no re-upload link for a new application');
select is((public.hr_admin_staff_invite(pg_temp.v('a1'), 'documents', pg_temp.h('tok-1'))->'invite'->>'state'), 'live', 'a document link is created');
select is((public.hr_admin_staff_invite(pg_temp.v('a1'), 'documents', pg_temp.h('tok-2'))->'invite'->>'state'), 'live', 'sending again creates a new link');
reset role;
select is((select status from hr.staff_profiles where id = pg_temp.v('a1')), 'invited', 'the application is invited');
select is((select count(*)::int from hr.staff_invites where profile_id = pg_temp.v('a1') and superseded_at is not null), 1, 'the old link is replaced');
select is((select count(*)::int from information_schema.columns where table_schema = 'hr' and table_name = 'staff_invites' and column_name ~ 'token' and column_name <> 'token_hash'), 0, 'only the token hash is stored');
select throws_ok($$select public.hr_svc_onboarding_open(pg_temp.h('tok-1'))$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'a replaced link no longer opens');
select throws_ok($$select public.hr_svc_onboarding_open(pg_temp.h('never-sent'))$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'an unknown link gets the same message');
select throws_ok($$select public.hr_svc_onboarding_open('not-a-hash')$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'a malformed link gets the same message');
select is(public.hr_svc_onboarding_open(pg_temp.h('tok-2'))->>'readOnly', 'false', 'the live link opens for editing');
select is(public.hr_svc_onboarding_open(pg_temp.h('tok-2'))->'profile' ? 'auth_user_id', false, 'the applicant view never carries login ids');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_invite_revoke(pg_temp.v('a1'))$$, 'an admin revokes the link');
reset role;
select throws_ok($$select public.hr_svc_onboarding_open(pg_temp.h('tok-2'))$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'a revoked link no longer opens');
select is((select status from hr.staff_profiles where id = pg_temp.v('a1')), 'invited', 'revoking does not change the status');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_invite(pg_temp.v('a1'), 'documents', pg_temp.h('tok-3'))$$, 'a new link after revoking');
reset role;
update hr.staff_invites set created_at = now() - interval '20 days', expires_at = now() - interval '1 second' where token_hash = pg_temp.h('tok-3');
select throws_ok($$select public.hr_svc_onboarding_open(pg_temp.h('tok-3'))$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'an expired link no longer opens');
update hr.staff_invites set expires_at = now() + interval '14 days', created_at = now() where token_hash = pg_temp.h('tok-3');
select ok((select expires_at between now() + interval '13 days' and now() + interval '15 days' from hr.staff_invites where token_hash = pg_temp.h('tok-3')), 'a document link lasts 14 days');

-- ---------------------------------------------------------------- onboarding: details, documents, submit
select lives_ok($$select public.hr_svc_onboarding_save(pg_temp.h('tok-3'), '{"first_name":"Ann","last_name":"Applicant","date_of_birth":"1990-05-06","address_street":"1 Example St","address_suburb":"Melbourne","address_state":"VIC","address_postcode":"3000","address_country":"Australia","emergency_name":"Em Contact","emergency_relationship":"Sibling","emergency_phone":"0422 333 444","is_australian_citizen":false}')$$, 'details save through the link');
select is((select emergency_phone_e164 || '/' || is_australian_citizen from hr.staff_profiles where id = pg_temp.v('a1')), '+61422333444/false', 'emergency phone normalised, citizenship recorded');
select throws_ok($$select public.hr_svc_onboarding_save(pg_temp.h('tok-3'), '{"first_name":"bad\u0001"}')$$, '22023', 'Check the first name field.', 'control characters are refused');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/passport/p1.pdf');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/passport/p2.pdf');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/visa/v.pdf');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/english/e.pdf');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/academic/a1.pdf');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/academic/a2.pdf');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/health-insurance/h.pdf');
select throws_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Passport', gen_random_uuid() || '/passport/p1.pdf', 'p.pdf', 'application/pdf', 10, current_date + 900)$$, '22023', 'The document location is not valid.', 'a file outside the person''s folder is refused');
select throws_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Passport', pg_temp.v('a1') || '/visa/v.pdf', 'p.pdf', 'application/pdf', 10, current_date + 900)$$, '22023', 'The document location is not valid.', 'the folder must match the document type');
select throws_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Passport', pg_temp.v('a1') || '/passport/missing.pdf', 'p.pdf', 'application/pdf', 10, current_date + 900)$$, 'P0002', 'The uploaded file was not found.', 'the file must exist');
select throws_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Passport', pg_temp.v('a1') || '/passport/p1.pdf', 'p.pdf', 'application/pdf', 10)$$, '22023', 'Enter the expiry date of your passport.', 'a passport needs an expiry date');
select throws_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Passport', pg_temp.v('a1') || '/passport/p1.pdf', 'p.pdf', 'application/pdf', 10, current_date - 1)$$, '22023', 'This passport has expired. Upload a current one.', 'an expired passport is refused');
select lives_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Passport', pg_temp.v('a1') || '/passport/p1.pdf', 'p.pdf', 'application/pdf', 10, current_date + 900)$$, 'a passport is recorded');
select is(public.hr_svc_document_add(pg_temp.h('tok-3'), 'Passport', pg_temp.v('a1') || '/passport/p2.pdf', 'p.pdf', 'application/pdf', 10, current_date + 900)->'replacedPaths'->>0, pg_temp.v('a1') || '/passport/p1.pdf', 'a new passport replaces the old one and returns its path for deletion');
select throws_ok($$select public.hr_svc_onboarding_submit(pg_temp.h('tok-3'))$$, '23514', 'Upload your visa.', 'submit needs every required document');
select lives_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Visa', pg_temp.v('a1') || '/visa/v.pdf', 'v.pdf', 'application/pdf', 10, current_date + 400)$$, 'visa');
select lives_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'English', pg_temp.v('a1') || '/english/e.pdf', 'e.pdf', 'application/pdf', 10)$$, 'English without an expiry date');
select lives_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Academic', pg_temp.v('a1') || '/academic/a1.pdf', 'a1.pdf', 'application/pdf', 10)$$, 'academic 1');
select lives_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Academic', pg_temp.v('a1') || '/academic/a2.pdf', 'a2.pdf', 'application/pdf', 10)$$, 'academic 2');
select is((select count(*)::int from hr.staff_documents where profile_id = pg_temp.v('a1') and category = 'Academic' and is_current), 2, 'academic results keep several files');
select is(public.hr_svc_document_remove(pg_temp.h('tok-3'), (select id from hr.staff_documents where storage_path = pg_temp.v('a1') || '/academic/a2.pdf'))->>'removedPath', pg_temp.v('a1') || '/academic/a2.pdf', 'removing returns the path for deletion');
select lives_ok($$select public.hr_svc_document_add(pg_temp.h('tok-3'), 'Health Insurance', pg_temp.v('a1') || '/health-insurance/h.pdf', 'h.pdf', 'application/pdf', 10, current_date + 300)$$, 'health insurance');
select is(public.hr_svc_document_for_extraction(pg_temp.h('tok-3'), (select id from hr.staff_documents where storage_path = pg_temp.v('a1') || '/passport/p2.pdf'))->>'category', 'Passport', 'the link holder''s document is offered for reading');
select throws_ok($$select public.hr_svc_document_for_extraction(pg_temp.h('tok-3'), gen_random_uuid())$$, 'P0002', 'Document not found.', 'another document is not');
select lives_ok($$select public.hr_svc_onboarding_submit(pg_temp.h('tok-3'))$$, 'the applicant submits');
select is((select status from hr.staff_profiles where id = pg_temp.v('a1')), 'documents_submitted', 'documents_submitted');
select ok((select used_at is not null from hr.staff_invites where token_hash = pg_temp.h('tok-3')), 'the link is used');
select is(public.hr_svc_onboarding_open(pg_temp.h('tok-3'))->>'readOnly', 'true', 'the used link still opens, read-only');
select throws_ok($$select public.hr_svc_onboarding_save(pg_temp.h('tok-3'), '{"first_name":"Changed"}')$$, '23514', 'This has already been sent and can no longer be changed.', 'nothing changes after submit');
select is((select count(*)::int from hr.staff_emails where profile_id = pg_temp.v('a1') and kind = 'admin_documents_submitted'), 1, 'the admins are told');
select is(public.hr_svc_document_path(pg_temp.h('tok-3'), (select id from hr.staff_documents where storage_path = pg_temp.v('a1') || '/passport/p2.pdf')), pg_temp.v('a1') || '/passport/p2.pdf', 'a used link still opens its own files');
select throws_ok($$select public.hr_svc_document_path(pg_temp.h('tok-3'), gen_random_uuid())$$, 'P0002', 'Document not found.', 'but no other file');
select throws_ok($$select public.hr_svc_upload_target(pg_temp.h('tok-3'), 'Passport')$$, '23514', 'This has already been sent and can no longer be changed.', 'a used link cannot upload');

-- ---------------------------------------------------------------- review and re-upload
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_document_review((select id from hr.staff_documents where storage_path = pg_temp.v('a1') || '/passport/p2.pdf'), 'rejected', '')$$, '22023', 'Add a note telling them what to fix.', 'a rejection needs a note');
select lives_ok($$select public.hr_admin_staff_document_review((select id from hr.staff_documents where storage_path = pg_temp.v('a1') || '/passport/p2.pdf'), 'rejected', 'Blurry')$$, 'reject the passport');
select is(jsonb_array_length(public.hr_admin_staff_invite(pg_temp.v('a1'), 'reupload', pg_temp.h('tok-4'))->'rejected'), 1, 'the re-upload link lists the rejected document');
reset role;
select is((select status from hr.staff_profiles where id = pg_temp.v('a1')), 'invited', 're-upload goes back to invited');
select is(public.hr_svc_onboarding_open(pg_temp.h('tok-4'))->>'mode', 'reupload', 'the link opens in re-upload mode');
select is(public.hr_svc_upload_target(pg_temp.h('tok-4'), 'Passport')::text, jsonb_build_object('profileId', pg_temp.v('a1'), 'folder', 'passport')::text, 'the rejected passport may be uploaded again, into the person''s folder');
select throws_ok($$select public.hr_svc_upload_target(pg_temp.h('tok-4'), 'Visa')$$, '23514', 'Only a rejected document can be replaced.', 'a pending document is refused before any file is stored');
select throws_ok($$select public.hr_svc_upload_target(pg_temp.h('tok-4'), 'Academic')$$, '23514', 'Only a rejected document can be replaced.', 'a re-upload link cannot add academic files');
select throws_ok($$select public.hr_svc_upload_target(pg_temp.h('tok-4'), 'Payslip')$$, '22023', 'Unknown document type.', 'unknown types are refused');
select throws_ok($$select public.hr_svc_onboarding_save(pg_temp.h('tok-4'), '{"first_name":"Changed"}')$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'a re-upload link cannot change details');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/visa/v2.pdf');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/passport/p3.pdf');
select throws_ok($$select public.hr_svc_document_add(pg_temp.h('tok-4'), 'Visa', pg_temp.v('a1') || '/visa/v2.pdf', 'v.pdf', 'application/pdf', 10, current_date + 400)$$, '23514', 'Only a rejected document can be replaced.', 'an accepted or pending document stays');
select throws_ok($$select public.hr_svc_onboarding_submit(pg_temp.h('tok-4'))$$, '23514', 'Replace every document we asked you to upload again.', 'submit needs the rejected document replaced');
select is(public.hr_svc_document_add(pg_temp.h('tok-4'), 'Passport', pg_temp.v('a1') || '/passport/p3.pdf', 'p3.pdf', 'application/pdf', 10, current_date + 900)->'replacedPaths', '[]'::jsonb, 'the rejected passport is replaced and the old file is kept');
select lives_ok($$select public.hr_svc_onboarding_submit(pg_temp.h('tok-4'))$$, 'the re-upload is submitted');
select is((select status from hr.staff_documents where storage_path = pg_temp.v('a1') || '/passport/p3.pdf'), 'pending', 'the new file waits for review');

-- ---------------------------------------------------------------- offer
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/offer/offer.pdf');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_offer_send(pg_temp.v('a1'), pg_temp.h('off-1'))$$, '23514', 'Upload the offer letter first.', 'no offer to send');
select lives_ok($$select public.hr_admin_staff_offer_add(pg_temp.v('a1'), pg_temp.v('a1') || '/offer/offer.pdf', 'offer.pdf', 1000, repeat('c', 64))$$, 'the offer PDF is recorded');
select throws_ok($$select public.hr_admin_staff_offer_send(pg_temp.v('a1'), pg_temp.h('off-1'))$$, '23514', 'Approve every required document first (passport).', 'every required document must be approved first');
select lives_ok($$select public.hr_admin_staff_document_review(d.id, 'approved') from hr.staff_documents d where d.profile_id = pg_temp.v('a1') and d.is_current$$, 'approve every document');
select is(public.hr_admin_staff_offer_send(pg_temp.v('a1'), pg_temp.h('off-1'))->'invite'->>'purpose', 'offer', 'the offer is sent with its own link');
reset role;
select is((select status from hr.staff_profiles where id = pg_temp.v('a1')), 'offer_sent', 'offer_sent');
select ok((select expires_at between now() + interval '29 days' and now() + interval '31 days' from hr.staff_invites where token_hash = pg_temp.h('off-1')), 'an offer link lasts 30 days');
select throws_ok($$select public.hr_svc_offer_open(pg_temp.h('tok-4'))$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'a document link does not open the offer');
select is(public.hr_svc_offer_open(pg_temp.h('off-1'))->'offer'->>'filename', 'offer.pdf', 'the offer opens');
select is(public.hr_svc_offer_file(pg_temp.h('off-1'))->>'sha256', repeat('c', 64), 'the signer gets the offer and the hash recorded at upload');
select is(public.hr_svc_offer_path(pg_temp.h('off-1'), 'offer'), pg_temp.v('a1') || '/offer/offer.pdf', 'the offer page shows the offer');
select throws_ok($$select public.hr_svc_offer_path(pg_temp.h('off-1'), 'signed')$$, 'P0002', 'The offer has not been signed yet.', 'no signed copy before signing');
select throws_ok($$select public.hr_svc_offer_file(pg_temp.h('tok-4'))$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'a document link cannot sign');
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('a1') || '/offer/signed.pdf');
select throws_ok($$select public.hr_svc_offer_sign(pg_temp.h('off-1'), (select id from hr.staff_offers where profile_id = pg_temp.v('a1')), '', 'I agree', '203.0.113.5', 'UA', pg_temp.v('a1') || '/offer/signed.pdf', repeat('d', 64))$$, '22023', 'Type your full name to sign.', 'a typed name is required');
select throws_ok($$select public.hr_svc_offer_sign(pg_temp.h('off-1'), (select id from hr.staff_offers where profile_id = pg_temp.v('a1')), 'Ann Applicant', 'I agree', '203.0.113.5', 'UA', pg_temp.v('a1') || '/offer/offer.pdf', repeat('d', 64))$$, '22023', 'The signed file location is not valid.', 'the signed copy is a separate file');
select lives_ok($$select public.hr_svc_offer_sign(pg_temp.h('off-1'), (select id from hr.staff_offers where profile_id = pg_temp.v('a1')), 'Ann Applicant', 'I agree to the terms of this offer.', '203.0.113.5', 'UA', pg_temp.v('a1') || '/offer/signed.pdf', repeat('d', 64))$$, 'the applicant signs on the page');
select is((select status from hr.staff_profiles where id = pg_temp.v('a1')), 'offer_signed', 'offer_signed');
select is((select signer_name || '/' || signer_ip || '/' || signed_sha256 from hr.staff_offers where profile_id = pg_temp.v('a1')), 'Ann Applicant/203.0.113.5/' || repeat('d', 64), 'name, IP and the signed file hash are recorded');
select is((select string_agg(kind || ':' || audience, ',' order by id) from hr.staff_emails where profile_id = pg_temp.v('a1') and kind in ('signed_offer','admin_offer_signed')), 'signed_offer:applicant,admin_offer_signed:admin', 'the signed PDF goes to the applicant and to HR');
select throws_ok($$select public.hr_svc_offer_sign(pg_temp.h('off-1'), (select id from hr.staff_offers where profile_id = pg_temp.v('a1')), 'Ann Applicant', 'I agree', 'x', 'UA', pg_temp.v('a1') || '/offer/signed.pdf', repeat('d', 64))$$, '23514', 'This has already been sent and can no longer be changed.', 'an offer is signed once');
select throws_ok($$select public.hr_svc_offer_file(pg_temp.h('off-1'))$$, '23514', 'This has already been sent and can no longer be changed.', 'a signed offer gives nothing more to sign');
select is(public.hr_svc_offer_path(pg_temp.h('off-1'), 'signed'), pg_temp.v('a1') || '/offer/signed.pdf', 'after signing the link shows the signed copy');
select is(public.hr_svc_offer_signed_file((select id from hr.staff_offers where profile_id = pg_temp.v('a1')))->>'sha256', repeat('d', 64), 'the outbox finds the signed copy and its hash');

-- withdraw (a second person)
insert into t select 'w1', public.hr_svc_apply('Wes', 'Withdrawn', 'wes@example.test', '0400 000 301')->>'profileId';
update hr.staff_profiles set status = 'invited' where id = pg_temp.v('w1');
update hr.staff_profiles set status = 'documents_submitted' where id = pg_temp.v('w1');
update hr.staff_profiles set status = 'offer_sent' where id = pg_temp.v('w1');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_offer_withdraw(pg_temp.v('w1'), 'Role filled')$$, 'an offer is withdrawn');
reset role;
select is((select status from hr.staff_profiles where id = pg_temp.v('w1')), 'documents_submitted', 'withdrawing goes back to documents_submitted');

-- ---------------------------------------------------------------- activation: a new login (Auth invite) as trainer, then claim
do $w$ begin perform pg_temp.to_signed('t1', 'Tess', 'invited.trainer@example.test', '0400 000 401'); end $w$;
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_activate_account(pg_temp.v('t1'), 'trainer', null)$$, '22023', 'Enter the joining date.', 'a joining date is required');
select is(public.hr_admin_staff_activate_account(pg_temp.v('t1'), 'trainer', current_date + 14)->>'email', 'invited.trainer@example.test', 'the check call returns the email and changes nothing');
select is(public.hr_admin_staff_activate_account(pg_temp.v('t1'), 'trainer', current_date + 14)->>'existingLogin', 'false', 'a just-invited login does not count as an existing login');
select throws_ok($$select public.hr_admin_staff_activate_account(pg_temp.v('t1'), 'trainer', current_date + 14, 'a0000000-0000-0000-0000-000000000006')$$, '42501', 'That login does not belong to this person.', 'a login with another email is refused');
select throws_ok($$select public.hr_admin_staff_activate_account(pg_temp.v('t1'), 'trainer', current_date + 14, gen_random_uuid())$$, '42501', 'That login does not belong to this person.', 'an id that is no login is refused');
select throws_ok($$select public.hr_admin_staff_activate_account(pg_temp.v('t1'), 'trainer', current_date + 14, 'a0000000-0000-0000-0000-000000000004')$$, '42501', 'That login does not belong to this person.', 'the admin''s own id is refused');
select is((select auth_user_id from hr.staff_profiles where id = pg_temp.v('t1')), null, 'a refused id links nothing');
select is(public.hr_admin_staff_activate_account(pg_temp.v('t1'), 'trainer', current_date + 14, 'a0000000-0000-0000-0000-000000000005')->>'activated', 'false', 'an unconfirmed (just invited) login waits for the password');
reset role;
select is((select p.status || '/' || a.joining_date::text || '/' || r.role from hr.staff_profiles p join hr.staff_applications a on a.profile_id = p.id
  join hr.staff_roles r on r.profile_id = p.id and r.revoked_at is null where p.id = pg_temp.v('t1')), 'offer_signed/' || (current_date + 14)::text || '/trainer', 'role and joining date recorded, still offer_signed');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000005';
select throws_ok($$select public.hr_staff_claim_account()$$, '42501', 'Confirm your email first.', 'claiming needs the invite accepted');
reset role;
update auth.users set email_confirmed_at = now() where id = 'a0000000-0000-0000-0000-000000000005';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000005';
select is(public.hr_staff_claim_account()->>'status', 'active', 'setting the password activates the account');
select is(public.hr_staff_claim_account()->>'status', 'active', 'claiming again is harmless');
select is(public.hr_staff_me()->'signedOffer'->>'signedPath', pg_temp.v('t1') || '/offer/s.pdf', 'My HR shows the signed offer');
select is(public.hr_staff_access(), 'active', 'access state is active');
reset role;
select is((select count(*)::int from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000005'), 0, 'a trainer gets no CMS access');
select is((select count(*)::int from hr.staff_emails where profile_id = pg_temp.v('t1') and kind = 'access_ready'), 0, 'the Auth invite path sends no access-ready email (the invite is the email)');

-- ---------------------------------------------------------------- activation: an existing student login as Admin
do $w$ begin perform pg_temp.to_signed('s1', 'Sam', 'student.login@example.test', '0400 000 501'); end $w$;
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_activate_account(pg_temp.v('s1'), 'admin', current_date, 'a0000000-0000-0000-0000-000000000003')$$, '23514', 'Confirm that this person should become an Admin.', 'Admin needs an explicit confirm');
select throws_ok($$select public.hr_admin_staff_activate_account(pg_temp.v('s1'), 'trainer', current_date, 'a0000000-0000-0000-0000-000000000005')$$, '42501', 'That login does not belong to this person.', 'another person''s login is refused');
select is(public.hr_admin_staff_activate_account(pg_temp.v('s1'), 'trainer', current_date)->>'existingLogin', 'true', 'the server finds the confirmed login by email, case-insensitively');
select is(public.hr_admin_staff_activate_account(pg_temp.v('s1'), 'admin', current_date, 'a0000000-0000-0000-0000-000000000003', true)->>'activated', 'true', 'the existing confirmed login is activated at once');
reset role;
select is((select status from hr.staff_profiles where id = pg_temp.v('s1')), 'active', 'active');
select is((select auth_user_id from hr.staff_profiles where id = pg_temp.v('s1')), 'a0000000-0000-0000-0000-000000000003'::uuid, 'the role is granted to the same login');
select is((select role || '/' || status from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000003'), 'Admin/Active', 'an Admin gets CMS access');
select is((select count(*)::int from auth.users where lower(email) = 'student.login@example.test'), 1, 'still one login');
select is((select string_agg(kind || ':' || audience || ':' || (payload->>'role'), ',') from hr.staff_emails where profile_id = pg_temp.v('s1') and kind = 'access_ready'), 'access_ready:applicant:admin', 'the existing login is told by HR that staff access is ready');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_deactivate(pg_temp.v('s1'), 'Left')$$, 'deactivate');
reset role;
select is((select status from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000003'), 'Inactive', 'deactivation turns CMS access off');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select is(public.hr_admin_staff_activate(pg_temp.v('s1'))->'profile'->>'status', 'active', 'reactivation');
reset role;
select is((select status from public.cms_users where auth_user_id = 'a0000000-0000-0000-0000-000000000003'), 'Active', 'reactivation restores CMS access');

-- an unconfirmed login that was NOT created by an Auth invite (for example a sign-up never confirmed) is refused
do $w$ begin perform pg_temp.to_signed('n1', 'Nina', 'never.confirmed@example.test', '0400 000 801'); end $w$;
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_activate_account(pg_temp.v('n1'), 'trainer', current_date, 'a0000000-0000-0000-0000-000000000007')$$, '42501', 'That login has not confirmed its email.', 'an unconfirmed, uninvited login is refused');
reset role;
select is((select status || '/' || coalesce(auth_user_id::text, 'none') from hr.staff_profiles where id = pg_temp.v('n1')), 'offer_signed/none', 'nothing was linked or activated');

-- ---------------------------------------------------------------- reject, reopen, re-apply
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_reject(pg_temp.v('w1'), '')$$, '22023', 'Add a note explaining the decision.', 'a rejection needs a note');
select lives_ok($$select public.hr_admin_staff_reject(pg_temp.v('w1'), 'Not suitable', false)$$, 'reject without an email');
select throws_ok($$select public.hr_admin_staff_reject(pg_temp.v('s1'), 'x')$$, '23514', 'Only an application in progress can be rejected.', 'an active person is deactivated, not rejected');
reset role;
select is((select count(*)::int from hr.staff_emails where profile_id = pg_temp.v('w1') and kind = 'rejected'), 0, 'unticked: no rejection email');
insert into t select 'r1', public.hr_svc_apply('Rita', 'Rejected', 'rita@example.test', '0400 000 601')->>'profileId';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_invite(pg_temp.v('r1'), 'documents', pg_temp.h('rita-1'))$$, 'invite Rita');
select lives_ok($$select public.hr_admin_staff_reject(pg_temp.v('r1'), 'Not suitable')$$, 'reject with the default email');
reset role;
select is((select count(*)::int from hr.staff_emails where profile_id = pg_temp.v('r1') and kind = 'rejected'), 1, 'ticked (default): the rejection email is queued');
select throws_ok($$select public.hr_svc_onboarding_open(pg_temp.h('rita-1'))$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'rejecting revokes the live link');
select is(public.hr_svc_apply('Rita', 'Again', 'rita@example.test', '0400 000 601')->>'profileId', pg_temp.v('r1')::text, 'a rejected person may apply again (same record)');
select is((select status from hr.staff_profiles where id = pg_temp.v('r1')), 'applied', 'rejected -> applied');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_reject(pg_temp.v('r1'), 'Still not suitable')$$, 'reject again');
select is(public.hr_staff_reopen(pg_temp.v('r1'), 'Reconsidered')->'profile'->>'status', 'applied', 'an admin reopens a rejected application');
reset role;

-- duplicates: only an OPEN application (or an active staff member) counts; a closed one (rejected or inactive) may apply again
select is(public.hr_svc_apply('Ann', 'Again', 'ann.applicant@example.test', '0400 000 101')->>'reason', 'exists', 'an open application (offer signed) is a duplicate');
select is(public.hr_svc_apply('Wes', 'Again', 'wes@example.test', '0400 000 301')->>'profileId', pg_temp.v('w1')::text, 'a rejected application is reopened by applying again');
update hr.staff_profiles set status = 'rejected' where id = pg_temp.v('w1');
select is(public.hr_svc_apply('Sam', 'Student', 'student.login@example.test', '0400 000 501')->>'reason', 'exists', 'an active staff member is a duplicate');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_deactivate(pg_temp.v('s1'), 'Left again')$$, 'deactivate before re-applying');
reset role;
select is(public.hr_svc_apply('Sam', 'Student', 'STUDENT.login@example.test', '0400 000 501')->>'profileId', pg_temp.v('s1')::text, 'an inactive former staff member may apply again (same record)');
select is((select status || '/' || (select count(*) from hr.staff_roles r where r.profile_id = p.id and r.revoked_at is null) from hr.staff_profiles p where p.id = pg_temp.v('s1')), 'applied/0', 'inactive -> applied, and the old role is revoked');
select is(public.hr_svc_apply('Other', 'Person', 'other.person@example.test', '0400 000 501')->>'reason', 'exists', 'another person''s number is still a duplicate');
select is((select count(*)::int from hr.staff_emails where profile_id = pg_temp.v('s1') and kind = 'already_applied'), 0, 'neither an active admin console user nor a number-only clash is emailed');

-- ---------------------------------------------------------------- retention
insert into storage.objects(bucket_id, name) values ('staff-documents', pg_temp.v('w1') || '/resume/w.pdf');
update hr.staff_applications set resume_path = pg_temp.v('w1') || '/resume/w.pdf', resume_filename = 'w.pdf', resume_mime = 'application/pdf', resume_size = 10 where profile_id = pg_temp.v('w1');
select is(jsonb_array_length(public.hr_svc_retention_due(6)), 0, 'nothing is due straight after rejection');
update hr.staff_profiles set status_changed_at = now() - interval '7 months' where id = pg_temp.v('w1');
select is(public.hr_svc_retention_due(6)->0->'paths'->>0, pg_temp.v('w1') || '/resume/w.pdf', 'a rejection older than the retention period lists its files');
select is(public.hr_svc_retention_mark(pg_temp.v('r1'), 6), false, 'a recent or reopened application is never marked');
select is(public.hr_svc_retention_mark(pg_temp.v('w1'), 6), true, 'the purge is recorded');
select is((select active::text || '/' || schedule || '/' || command from cron.job where jobname = 'hr-retention-purge'), 'false/15 3 * * */select public.hr_retention_dispatch();', 'the daily retention job exists and is inactive until the owner turns it on');
select is(public.hr_retention_dispatch(), null::bigint, 'without the Vault secrets the dispatcher makes no call');
select is(has_function_privilege('authenticated', 'public.hr_retention_dispatch()', 'execute'), false, 'nobody but postgres runs the dispatcher');
select is(jsonb_array_length(public.hr_svc_retention_due(6)), 0, 'a purged application is not listed again');
select throws_ok($$select public.hr_svc_retention_due(0)$$, '22023', 'Retention must be 1 to 120 months.', 'the retention period is bounded');

-- ---------------------------------------------------------------- email outbox
select ok(jsonb_array_length(public.hr_svc_email_claim(50)) >= 5, 'queued mail is claimed');
select is((select count(*)::int from hr.staff_emails where state = 'queued'), 0, 'claimed mail is leased');
select lives_ok($$select public.hr_svc_email_result((select min(id) from hr.staff_emails where state = 'sending'), 'sent', 'pm-1')$$, 'a send result is recorded');
select is(jsonb_array_length(public.hr_svc_email_claim(50)), 0, 'leased mail is not claimed twice');
select throws_ok($$select public.hr_svc_email_log(pg_temp.v('a1'), 'rejected', 'sent')$$, '22023', 'Only link emails are logged this way.', 'only link emails are logged inline');
select throws_ok($$select hr.queue_email(pg_temp.v('a1'), 'offer', 'applicant', '{"token":"secret"}')$$, '23514', null, 'a token is never stored in an email row');
insert into t select 'e1', hr.queue_email(pg_temp.v('a1'), 'rejected', 'applicant');
select is(jsonb_array_length(public.hr_svc_email_claim(50, 120, array['admin_new_application'])), 0, 'the claim only takes the kinds the sender can send');
select is(public.hr_svc_email_claim(50, 120, array['rejected'])->0->>'kind', 'rejected', 'a kind it can send is claimed');
select lives_ok($$select public.hr_svc_email_result((select v::bigint from t where k = 'e1'), 'failed', null, 'rejected')$$, 'a provider refusal is recorded');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select is(public.hr_admin_staff_detail(pg_temp.v('a1'))->>'emailFailed', 'true', 'the failure is visible to the admin');
select is((select r->>'emailFailed' from jsonb_array_elements(public.hr_admin_staff_list(null, null, 200, 0)->'rows') r where r->>'id' = pg_temp.v('a1')::text), 'true', '...also in the list');
select is((select e->>'retryable' from jsonb_array_elements(public.hr_admin_staff_detail(pg_temp.v('a1'))->'emails') e where (e->>'id')::bigint = (select v::bigint from t where k = 'e1')), 'true', 'a failed queued email can be retried');
select lives_ok($$select public.hr_admin_staff_email_retry((select v::bigint from t where k = 'e1'))$$, 'the admin retries it');
select throws_ok($$select public.hr_admin_staff_email_retry((select v::bigint from t where k = 'e1'))$$, '23514', 'Only a failed email can be sent again.', 'only a failed email');
reset role;
select is((select state || '/' || attempts from hr.staff_emails where id = (select v::bigint from t where k = 'e1')), 'queued/0', 'back in the queue with fresh attempts');
insert into t select 'e2', public.hr_svc_email_log(pg_temp.v('a1'), 'offer', 'failed', null, 'rejected');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_email_retry((select v::bigint from t where k = 'e2'))$$, '23514', 'Send the link again instead: a new link replaces the old one.', 'a link email is never re-sent from the outbox');
reset role;

-- a link whose email could not be sent is cancelled; sending again makes exactly one live link
insert into t select 'c1', public.hr_svc_apply('Cora', 'Cancel', 'cora@example.test', '0400 000 901')->>'profileId';
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
insert into t select 'ci1', public.hr_admin_staff_invite(pg_temp.v('c1'), 'documents', pg_temp.h('cora-1'))->'invite'->>'id';
select throws_ok($$select public.hr_admin_staff_invite_cancel(pg_temp.v('c1'), gen_random_uuid())$$, 'P0002', 'There is no live link to cancel.', 'only that person''s live link');
select lives_ok($$select public.hr_admin_staff_invite_cancel(pg_temp.v('c1'), pg_temp.v('ci1'))$$, 'the unsent link is cancelled');
reset role;
select throws_ok($$select public.hr_svc_onboarding_open(pg_temp.h('cora-1'))$$, '28000', 'This link is not valid any more. Ask us for a new one.', 'a cancelled link never opens');
select is((select status from hr.staff_profiles where id = pg_temp.v('c1')), 'invited', 'the status stays invited');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_invite(pg_temp.v('c1'), 'documents', pg_temp.h('cora-2'))$$, 'send again');
reset role;
select is((select count(*)::int from hr.staff_invites where profile_id = pg_temp.v('c1') and revoked_at is null and superseded_at is null and used_at is null), 1, 'exactly one live link');
update hr.staff_invites set created_at = now() - interval '20 days', expires_at = now() - interval '1 second' where token_hash = pg_temp.h('cora-2');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select lives_ok($$select public.hr_admin_staff_invite(pg_temp.v('c1'), 'documents', pg_temp.h('cora-3'))$$, 'an expired link can be sent again');
reset role;
select is(public.hr_svc_onboarding_open(pg_temp.h('cora-3'))->>'readOnly', 'false', 'the new link works');
select is((select count(*)::int from hr.staff_invites where profile_id = pg_temp.v('c1') and revoked_at is null and superseded_at is null and used_at is null), 1, 'still exactly one live link');

-- the read-only rate-limit counter (staff-onboarding's invalid-link lockout)
select ok(public.public_assistant_take_rate_limit('hr-test-bucket', 5, 600) and public.public_assistant_take_rate_limit('hr-test-bucket', 5, 600), 'two requests');
select is(public.hr_svc_rate_count('hr-test-bucket', 600), 2, 'the counter reads the current window');
select is(public.hr_svc_rate_count('hr-test-bucket', 600), 2, 'reading does not count');
select is(public.hr_svc_rate_count('hr-unknown-bucket', 600), 0, 'an unknown bucket is 0');
select is(has_function_privilege('anon', 'public.hr_svc_rate_count(text, integer)', 'execute'), false, 'service role only');

-- ---------------------------------------------------------------- document reading fills EMPTY details only, while invited
insert into t select 'x1', public.hr_svc_apply('Xena', 'Keep', 'xena@example.test', '0400 000 701')->>'profileId';
update hr.staff_profiles set status = 'invited', first_name = '' where id = pg_temp.v('x1');
insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size, expiry_date)
 select a.id, a.profile_id, 'Passport', a.profile_id || '/passport/x.pdf', 'x.pdf', 'application/pdf', 10, current_date + 100 from hr.staff_applications a where a.profile_id = pg_temp.v('x1');
select lives_ok($$select public.hr_staff_document_apply_extraction((select id from hr.staff_documents where profile_id = pg_temp.v('x1')), 'done', '{"first_name":"Asha","last_name":"Overwritten","dob":"1999-04-05","passport_number":"X1234567"}')$$, 'a passport reading is recorded');
select is((select first_name || '/' || last_name || '/' || date_of_birth from hr.staff_profiles where id = pg_temp.v('x1')), 'Asha/Keep/1999-04-05', 'empty details are filled and typed ones are never overwritten');

-- ---------------------------------------------------------------- privileges
select is(has_function_privilege('anon', 'public.hr_svc_onboarding_open(text)', 'execute'), false, 'anon cannot call the link functions');
select is(has_function_privilege('authenticated', 'public.hr_svc_document_add(text, text, text, text, text, integer, date, uuid)', 'execute'), false, 'a signed-in user cannot call the link functions');
select is(has_function_privilege('authenticated', 'public.hr_svc_apply(text, text, text, text)', 'execute'), false, 'the browser cannot apply around the CAPTCHA');
select is(has_function_privilege('service_role', 'public.hr_svc_offer_sign(text, uuid, text, text, text, text, text, text)', 'execute'), true, 'the service role can');
select is(has_function_privilege('anon', 'public.hr_svc_offer_file(text)', 'execute'), false, 'anon cannot read the offer file');
select is(has_function_privilege('authenticated', 'public.hr_svc_offer_signed_file(uuid)', 'execute'), false, 'a signed-in user cannot read the signed file record');
select is(has_table_privilege('authenticated', 'hr.staff_invites', 'select'), false, 'link hashes are not readable by users');
select is(has_table_privilege('authenticated', 'hr.staff_emails', 'select'), false, 'the outbox is not readable by users');
select is(has_column_privilege('authenticated', 'hr.staff_profiles', 'first_name', 'update'), false, 'no applicant edits through the Data API');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and policyname like 'staff\_documents\_owner%'), 0, 'no owner write policy on the bucket');
select is(to_regprocedure('public.hr_staff_submit()'), null, 'the sign-up era applicant functions are gone');
select is(to_regprocedure('public.hr_admin_staff_approve(uuid,text,text,boolean)'), null, 'approve (preboarding) is gone');
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
select throws_ok($$select public.hr_admin_staff_list(null, null, 50, 0, array['draft'])$$, '22023', 'Unknown status.', 'old statuses are not accepted by the list');
select is((public.hr_admin_staff_list(null, null, 50, 0, array['offer_signed','active'])->>'total')::int, (select count(*)::int from hr.staff_profiles where status in ('offer_signed','active')), 'the list filters by several statuses');
reset role;

-- ---------------------------------------------------------------- guard and append-only
select throws_ok($$update hr.staff_profiles set status = 'active' where id = pg_temp.v('x1')$$, '23514', null, 'invited -> active is not an allowed transition');
select throws_ok($$update hr.staff_status_events set note = 'edited'$$, '23514', 'The staff status log is append-only.', 'the log cannot be edited');
select ok((select count(*) from hr.staff_status_events where profile_id = pg_temp.v('a1')) >= 7, 'every move of the application is logged');
select * from finish();
rollback;
