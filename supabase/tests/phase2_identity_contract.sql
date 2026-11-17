-- SQL role simulation only; does not verify Auth API/JWT validation.
begin;
select plan(8);
insert into public.agencies(id,name,code) values
 ('11000000-0000-0000-0000-000000000001','Identity fixture','P2-ID');
-- fixture (migration 20261117220000): an uploaded signed agreement makes the Active fixture businesses operational
insert into public.business_documents(business_id, kind, file_name, storage_path) select a.id, 'agent_agreement', 'fixture-agreement.pdf', 'fixtures/' || a.id::text || '/agreement.pdf' from public.agencies a where a.status = 'Active' and not coalesce(a.is_direct, false) and a.agreement_status = 'none' and not exists (select 1 from public.business_documents d where d.business_id = a.id);
insert into public.portal_profiles(id,auth_user_id,full_name,email) values
 ('21000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000001','Identity agent','identity@example.test');
insert into public.agency_memberships(user_id,agency_id,role) values
 ('21000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001','agent');
set local role anon;
select is(public.portal_identity()->>'role',null,'anonymous identity has no portal role');
select is(public.portal_identity()->>'profile_id',null,'anonymous identity has no profile');
reset role;
set local role authenticated;
set local request.jwt.claim.sub='31000000-0000-0000-0000-000000000001';
select is(public.portal_identity()->>'role','agent','active assigned agent retains role');
select is(public.portal_identity()->>'agency_id','11000000-0000-0000-0000-000000000001','identity retains agency ID');
reset role;
update public.agency_memberships set role='agency_admin' where agency_id='11000000-0000-0000-0000-000000000001';
set local role authenticated;
select is(public.portal_identity()->>'role','agency_admin','active agency admin retains role');
reset role;
update public.agencies set status='Inactive' where id='11000000-0000-0000-0000-000000000001';
set local role authenticated;
select is(public.portal_identity()->>'role',null,'inactive agency receives no identity role');
reset role;
update public.portal_profiles set status='Inactive' where id='21000000-0000-0000-0000-000000000001';
set local role authenticated;
select is(public.portal_identity()->>'profile_id',null,'inactive profile receives no identity profile');
set local request.jwt.claim.sub='31000000-0000-0000-0000-000000000002';
select is(public.portal_identity()->>'role',null,'unmapped authenticated subject receives no role');
select * from finish();
rollback;
