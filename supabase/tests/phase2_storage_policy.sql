begin;
-- Policy-only test: native Storage's API sets this transaction-local context.
-- RLS remains enabled; real byte/API deletion is covered by native-auth-storage.
set local storage.allow_delete_query = 'true';
select plan(6);
insert into public.agencies(id,name,code) values('15000000-0000-0000-0000-000000000001','Storage fixture','P2-STORAGE');
insert into public.portal_profiles(id,auth_user_id,full_name,email) values('25000000-0000-0000-0000-000000000001','35000000-0000-0000-0000-000000000001','Storage agent','storage@example.test');
insert into public.agency_memberships(user_id,agency_id,role) values('25000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001','agent');
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status) values
 ('45000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001','25000000-0000-0000-0000-000000000001','draft'),
 ('45000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000001','25000000-0000-0000-0000-000000000001','submitted');
insert into public.enrollment_application_documents(application_id,category,storage_path,filename) values
 ('45000000-0000-0000-0000-000000000001','Passport','45000000-0000-0000-0000-000000000001/passport.pdf','passport.pdf'),
 ('45000000-0000-0000-0000-000000000001','Consent','45000000-0000-0000-0000-000000000001/consent.pdf','consent.pdf');
insert into storage.objects(bucket_id,name) values
 ('enrollment-documents','45000000-0000-0000-0000-000000000001/passport.pdf'),
 ('enrollment-documents','45000000-0000-0000-0000-000000000001/consent.pdf');
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
