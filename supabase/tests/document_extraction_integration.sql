-- Run with: npm run test:document-extraction:integration
-- Exercises the database boundary used by both functions and the wizard.
begin;
select plan(25);

insert into public.agencies(id, name, code) values
  ('10000000-0000-0000-0000-000000000001', 'Extraction test A', 'EXT-A'),
  ('10000000-0000-0000-0000-000000000002', 'Extraction test B', 'EXT-B');
insert into public.portal_profiles(id, auth_user_id, full_name, email) values
  ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Agent A', 'a@example.test'),
  ('20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'Agent B', 'b@example.test'),
  ('20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000003', 'Unassigned agent', 'c@example.test');
insert into public.agency_memberships(user_id, agency_id, role) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'agent'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'agent'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'agent');
insert into public.enrollment_applications(id, agency_id, assigned_agent_id, data, status) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '{"values":{"last_name":"Verified"}}', 'draft'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '{}', 'draft');
insert into public.enrollment_application_documents(id, application_id, category, storage_path, filename, metadata) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Passport', '40000000-0000-0000-0000-000000000001/a.pdf', 'a.pdf', '{}'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'Passport', '40000000-0000-0000-0000-000000000001/b.pdf', 'b.pdf', '{}');

set local role service_role;
select is(public.portal_apply_document_candidates('50000000-0000-0000-0000-000000000001', '{"first_name":"Ada","last_name":"Replacement"}'::jsonb)->>'first_name', 'auto_applied', 'an empty form field is populated');
select is((select data #>> '{values,first_name}' from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000001'), 'Ada', 'the populated candidate is persisted');
select is((select data #>> '{values,last_name}' from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000001'), 'Verified', 'a populated/verified field is never overwritten');
select is((select state from public.enrollment_document_field_reviews where field_identifier = 'last_name' order by created_at desc limit 1), 'conflict', 'a protected populated field becomes a conflict');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select lives_ok($$select public.portal_save_document_review('40000000-0000-0000-0000-000000000001', '{"first_name":"Ada Lovelace"}', '{"first_name":"Manual entry"}', '["first_name"]', '[{"field":"first_name","state":"corrected"}]')$$, 'assigned agent saves a correction and confirmation');
select is((select data #>> '{values,first_name}' from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000001'), 'Ada Lovelace', 'correction persists on reload');
select is((select state from public.enrollment_document_field_reviews where field_identifier = 'first_name' order by audit_revision desc limit 1), 'corrected', 'correction is the latest immutable audit revision');
select is((select count(*)::integer from public.enrollment_document_field_reviews where field_identifier = 'first_name' and state = 'corrected'), 1, 'correction has a durable immutable audit row');

-- The locked review save serialises with a worker candidate.
reset role;
set local role service_role;
select lives_ok($$select public.portal_apply_document_candidates('50000000-0000-0000-0000-000000000002', '{"dob":"2000-01-01"}'::jsonb)$$, 'concurrent worker candidate is accepted safely');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select lives_ok($$select public.portal_save_document_review('40000000-0000-0000-0000-000000000001', '{"dob":"2000-02-02"}', '{"dob":"Manual entry"}', '["first_name","dob"]', '[{"field":"dob","state":"corrected"}]')$$, 'manual edit serialises with extraction');
select is((select data #>> '{values,dob}' from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000001'), '2000-02-02', 'manual edit is the durable final value');

set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
select is((select count(*) from public.enrollment_document_field_reviews where application_id = '40000000-0000-0000-0000-000000000001')::integer, 0, 'other agency cannot read candidates');
select throws_ok($$select public.portal_save_document_review('40000000-0000-0000-0000-000000000001', '{"dob":"bad"}', '{}', '[]', '[]')$$, '42501', 'not authorised', 'other agency cannot edit candidates');
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';
select is((select count(*) from public.enrollment_document_field_reviews where application_id = '40000000-0000-0000-0000-000000000001')::integer, 0, 'an unassigned agent in the same agency cannot read candidates');
select throws_ok($$select public.portal_save_document_review('40000000-0000-0000-0000-000000000001', '{"dob":"bad"}', '{}', '[]', '[]')$$, '42501', 'not authorised', 'an unassigned agent cannot edit candidates');

reset role;
set local role service_role;
insert into public.enrollment_document_deletion_recovery(document_id, application_id, bucket_name, storage_path, state, last_error)
values ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'enrollment-documents', 'x', 'storage_deleted_row_failed', 'simulated row failure');
select is((select state from public.enrollment_document_deletion_recovery where document_id = '50000000-0000-0000-0000-000000000001'), 'storage_deleted_row_failed', 'partial deletion has a recovery record');
update public.enrollment_application_documents set is_current = false where id = '50000000-0000-0000-0000-000000000002';
select is((public.portal_apply_document_candidates('50000000-0000-0000-0000-000000000002', '{"dob":"2001-01-01"}'::jsonb)->>'stale')::boolean, true, 'deleted or replaced documents reject stale results');

-- Replacement: an unedited value from a superseded file is replaced; an edited one is a conflict.
insert into public.enrollment_applications(id, agency_id, assigned_agent_id, data, status) values
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '{"academicQualifications":[{"institution":"Manual Inst","qualification":"Cert"}]}', 'draft');
insert into public.enrollment_application_documents(id, application_id, category, storage_path, filename, metadata) values
  ('50000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 'Driving Licence', '40000000-0000-0000-0000-000000000003/old.pdf', 'old.pdf', '{}'),
  ('50000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000003', 'Driving Licence', '40000000-0000-0000-0000-000000000003/new.pdf', 'new.pdf', '{}'),
  ('50000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000003', 'Academic', '40000000-0000-0000-0000-000000000003/a1.pdf', 'a1.pdf', '{}'),
  ('50000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000003', 'Academic', '40000000-0000-0000-0000-000000000003/a2.pdf', 'a2.pdf', '{}'),
  ('50000000-0000-0000-0000-000000000007', '40000000-0000-0000-0000-000000000003', 'Academic', '40000000-0000-0000-0000-000000000003/a3.pdf', 'a3.pdf', '{}');
select public.portal_apply_document_candidates('50000000-0000-0000-0000-000000000003', '{"au_street":"1 Old St","au_suburb":"Oldtown"}'::jsonb);
update public.enrollment_applications set data = jsonb_set(data, '{values,au_suburb}', '"Edited"') where id = '40000000-0000-0000-0000-000000000003';
delete from public.enrollment_application_documents where id = '50000000-0000-0000-0000-000000000003';
create temp table replace_result as select public.portal_apply_document_candidates('50000000-0000-0000-0000-000000000004', '{"au_street":"2 New St","au_suburb":"Newtown"}'::jsonb) as r;
select is((select r->>'au_street' from replace_result), 'auto_applied', 'an unedited value from the replaced file is re-applied');
select is((select data #>> '{values,au_street}' from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000003'), '2 New St', 'the replacement value is persisted');
select is((select r->>'au_suburb' from replace_result), 'conflict', 'an edited value is a conflict, not a replacement');
select is((select data #>> '{values,au_suburb}' from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000003'), 'Edited', 'an edited value is never overwritten');

-- Qualifications: one entry per distinct qualification, duplicates share an entry, deletes remove only their own.
select public.portal_apply_document_candidates('50000000-0000-0000-0000-000000000005', '{"academic_institution":"Uni A","academic_qualification":"BSc","academic_year":"2020"}'::jsonb);
select public.portal_apply_document_candidates('50000000-0000-0000-0000-000000000006', '{"academic_institution":"uni a","academic_qualification":"bsc","academic_year":"2020"}'::jsonb);
select public.portal_apply_document_candidates('50000000-0000-0000-0000-000000000007', '{"academic_institution":"Uni B","academic_qualification":"MSc","academic_year":"2022"}'::jsonb);
select is((select jsonb_array_length(data->'academicQualifications') from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000003'), 3, 'each distinct qualification is appended and the duplicate is skipped');
delete from public.enrollment_application_documents where id = '50000000-0000-0000-0000-000000000005';
select is((select jsonb_array_length(data->'academicQualifications') from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000003'), 3, 'a shared entry survives while another file still backs it');
delete from public.enrollment_application_documents where id in ('50000000-0000-0000-0000-000000000006', '50000000-0000-0000-0000-000000000007');
select is((select jsonb_array_length(data->'academicQualifications') from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000003'), 1, 'removing the files removes only the entries they created');
select is((select data #>> '{academicQualifications,0,institution}' from public.enrollment_applications where id = '40000000-0000-0000-0000-000000000003'), 'Manual Inst', 'manual entries are kept');

select * from finish();
rollback;
