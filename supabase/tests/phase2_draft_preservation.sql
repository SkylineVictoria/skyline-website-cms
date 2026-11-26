begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
select plan(9);
insert into agencies(id,name,code) values('16000000-0000-0000-0000-000000000001','Draft preservation','DRAFT-PRESERVE');
-- fixture (migration 20261117220000): an uploaded signed agreement makes the Active fixture businesses operational
insert into public.business_documents(business_id, kind, file_name, storage_path) select a.id, 'agent_agreement', 'fixture-agreement.pdf', 'fixtures/' || a.id::text || '/agreement.pdf' from public.agencies a where a.status = 'Active' and not coalesce(a.is_direct, false) and a.agreement_status = 'none' and not exists (select 1 from public.business_documents d where d.business_id = a.id);
insert into portal_profiles(id,auth_user_id,email) values('26000000-0000-0000-0000-000000000001','36000000-0000-0000-0000-000000000001','draft-preserve@example.test');
insert into agency_memberships(user_id,agency_id) values('26000000-0000-0000-0000-000000000001','16000000-0000-0000-0000-000000000001');
insert into enrollment_applications(id,agency_id,assigned_agent_id,data) values('46000000-0000-0000-0000-000000000001','16000000-0000-0000-0000-000000000001','26000000-0000-0000-0000-000000000001','{"wizard":{"confirmed":["first_name"]},"provenance":{"first_name":"Reviewed passport"}}');
-- 20261123170457: browsers save drafts through portal_save_draft_v2 (draft lock + expected version); the old command is owner-only
create function pg_temp.dv(p_id uuid) returns bigint language sql stable security definer as $$ select draft_version from public.enrollment_applications where id = p_id $$;
select has_function('public','portal_save_draft_v2',array['uuid','bigint','jsonb'],'atomic draft command exists');
select is(has_function_privilege('authenticated','public.portal_save_application_draft(uuid,jsonb,text,text,text,integer)','execute'),false,'the old draft command is closed to browsers');
set local role authenticated;
set local request.jwt.claim.sub='36000000-0000-0000-0000-000000000001';
select lives_ok($$select portal_save_draft_v2('46000000-0000-0000-0000-000000000001',pg_temp.dv('46000000-0000-0000-0000-000000000001'),'{"values":{"first_name":"Reviewed"}}')$$,'own draft saves');
reset role; -- the checks read the tables as the owner (no browser table grant)
select is((select data->'wizard'->'confirmed' from enrollment_applications where id='46000000-0000-0000-0000-000000000001'),'["first_name"]'::jsonb,'confirmed wizard metadata preserved');
select is((select s.details->>'first_name' from enrollment_applications a join enrollment_students s on s.id = a.student_id where a.id='46000000-0000-0000-0000-000000000001'),'Reviewed','edited form value saved (on the student record since 20261104120000)');
set local role authenticated;
set local request.jwt.claim.sub='36000000-0000-0000-0000-000000000001';
select throws_ok($$select portal_save_draft_v2('46000000-0000-0000-0000-000000000001',pg_temp.dv('46000000-0000-0000-0000-000000000001'),'{"provenance":{}}')$$,'22023',null,'draft command cannot replace review metadata');
set local request.jwt.claim.sub='36000000-0000-0000-0000-000000000002';
select throws_ok($$select portal_save_draft_v2('46000000-0000-0000-0000-000000000001',pg_temp.dv('46000000-0000-0000-0000-000000000001'),'{}')$$,'42501',null,'foreign actor denied');
reset role;
-- fixture only: a submitted application (the submit guards need the full AVETMISS record since 20261126124153; paused for this one row)
set local session_replication_role = replica; update enrollment_applications set status='submitted' where id='46000000-0000-0000-0000-000000000001'; set local session_replication_role = origin;
set local role authenticated;
set local request.jwt.claim.sub='36000000-0000-0000-0000-000000000001';
select throws_ok($$select portal_save_draft_v2('46000000-0000-0000-0000-000000000001',pg_temp.dv('46000000-0000-0000-0000-000000000001'),'{}')$$,'42501',null,'submitted draft save denied');
select throws_ok($$select portal_save_draft_v2('46000000-0000-0000-0000-000000000099',0,'{}')$$,'42501',null,'missing application denied');
select * from finish();
rollback;
