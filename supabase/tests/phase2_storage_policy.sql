begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- Policy-only test: native Storage's API sets this transaction-local context.
-- RLS remains enabled; real byte/API deletion is covered by native-auth-storage.
set local storage.allow_delete_query = 'true';
select plan(6);
insert into public.agencies(id,name,code) values('15000000-0000-0000-0000-000000000001','Storage fixture','P2-STORAGE');
-- fixture (migration 20261117220000): an uploaded signed agreement makes the Active fixture businesses operational
insert into public.business_documents(business_id, kind, file_name, storage_path) select a.id, 'agent_agreement', 'fixture-agreement.pdf', 'fixtures/' || a.id::text || '/agreement.pdf' from public.agencies a where a.status = 'Active' and not coalesce(a.is_direct, false) and a.agreement_status = 'none' and not exists (select 1 from public.business_documents d where d.business_id = a.id);
insert into public.portal_profiles(id,auth_user_id,full_name,email) values('25000000-0000-0000-0000-000000000001','35000000-0000-0000-0000-000000000001','Storage agent','storage@example.test');
insert into public.agency_memberships(user_id,agency_id,role) values('25000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001','agent');
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status) values
 ('45000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001','25000000-0000-0000-0000-000000000001','draft'),
 ('45000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000001','25000000-0000-0000-0000-000000000001','submitted');
insert into storage.objects(bucket_id,name) values
 ('enrollment-documents','45000000-0000-0000-0000-000000000001/passport.pdf'),
 ('enrollment-documents','45000000-0000-0000-0000-000000000001/consent.pdf');
-- Checked categories (20261112100000): the passport row needs the uploader's validation receipt on its object; a consent form is not read.
select public.record_validated_document_category('enrollment-documents','45000000-0000-0000-0000-000000000001/passport.pdf','Passport');
insert into public.enrollment_application_documents(application_id,category,storage_path,filename) values
 ('45000000-0000-0000-0000-000000000001','Passport','45000000-0000-0000-0000-000000000001/passport.pdf','passport.pdf'),
 ('45000000-0000-0000-0000-000000000001','Consent','45000000-0000-0000-0000-000000000001/consent.pdf','consent.pdf');
set local role authenticated;
set local request.jwt.claim.sub='35000000-0000-0000-0000-000000000001';
select lives_ok($$insert into storage.objects(bucket_id,name) values('enrollment-documents','45000000-0000-0000-0000-000000000001/orphan.pdf')$$,'draft upload object insert preserved');
select throws_ok($$insert into storage.objects(bucket_id,name) values('enrollment-documents','45000000-0000-0000-0000-000000000002/new.pdf')$$,'42501',null,'submitted direct upload denied');
with changed as (update storage.objects set metadata='{"tampered":true}' where name='45000000-0000-0000-0000-000000000001/passport.pdf' returning id)
select is((select count(*)::int from changed),0,'registered object cannot be overwritten directly');
with changed as (delete from storage.objects where name='45000000-0000-0000-0000-000000000001/consent.pdf' returning id)
select is((select count(*)::int from changed),0,'retained consent cannot be deleted directly');
with changed as (delete from storage.objects where name='45000000-0000-0000-0000-000000000001/passport.pdf' returning id)
select is((select count(*)::int from changed),0,'registered object deletion requires coordinated handler');
with changed as (delete from storage.objects where name='45000000-0000-0000-0000-000000000001/orphan.pdf' returning id)
select is((select count(*)::int from changed),1,'failed registration orphan cleanup remains allowed');
select * from finish();
rollback;
