-- Positive preservation + direct mutation boundaries, synthetic and rollback-only.
begin;
select plan(539);
insert into public.agencies(id,name,code) values ('13000000-0000-0000-0000-000000000001','Positive A','P2-POS-A'),('13000000-0000-0000-0000-000000000002','Positive B','P2-POS-B');
insert into public.portal_profiles(id,auth_user_id,full_name,email) values
 ('23000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001','Positive agent','positive@example.test');
insert into public.agency_memberships(user_id,agency_id,role) values ('23000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','agent');
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status,data) values
 ('43000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','draft','{}');
-- SQL actor claims are stand-ins; native Auth provisioning is tested separately.
-- The SEC-11 contract requires an explicit UID mapping, never email alone.
-- cms_users.auth_user_id references auth.users (migration 0004): provision the Auth row inside the rolled-back transaction.
insert into auth.users(id,email) values ('33000000-0000-0000-0000-000000000002','positive-admin@example.test');
insert into public.cms_users(id,name,email,role,status,auth_user_id) values ('phase2-positive-admin','Positive admin','positive-admin@example.test','Admin','Active','33000000-0000-0000-0000-000000000002');
insert into public.portal_notifications(id,recipient,title) values ('63000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001','Original');
-- Checked categories (20261112100000): a document in a category whose contents are read needs its Storage object and the uploader's
-- validation receipt before its row can be written. Fixture files stand for files the Edge Function checked.
-- Holder-name matching (20261113160000): the receipt names the application's current passport at the time (none before the first one).
create function pg_temp.checked_upload(p_path text, p_category text, p_owner uuid default null) returns void language plpgsql security definer as $$
begin
  insert into storage.objects(bucket_id, name) values ('enrollment-documents', p_path) on conflict do nothing;
  perform public.record_passport_matched_document('enrollment-documents', p_path, p_category,
    (public.current_upload_passport('enrollment-documents', coalesce(p_owner, case when split_part(p_path, '/', 1) ~ '^[0-9a-f-]{36}$' then split_part(p_path, '/', 1)::uuid end))->>'id')::uuid);
end $$;
select pg_temp.checked_upload(p, 'Passport') from unnest(array['43000000-0000-0000-0000-000000000001/a.pdf', '43000000-0000-0000-0000-000000000001/b.pdf', 'foreign/b.pdf']) as p;
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000001';
select is((select count(*)::int from public.agencies),1,'agent can only read own agency');
select lives_ok($$update public.portal_profiles set phone='123',full_name='Updated' where id='23000000-0000-0000-0000-000000000001'$$,'own contact fields remain editable');
select throws_ok($$update public.portal_profiles set email='forged@example.test' where id='23000000-0000-0000-0000-000000000001'$$,'42501',null,'identity email cannot be changed directly');
select throws_ok($$update public.portal_profiles set auth_user_id='33000000-0000-0000-0000-000000000003' where id='23000000-0000-0000-0000-000000000001'$$,'42501',null,'auth identity cannot be rebound');
select lives_ok($$select public.portal_save_draft_v2('43000000-0000-0000-0000-000000000001',0,'{"courses":[{"courseId":"positive","code":"POS","title":"Positive"}]}')$$,'draft course command preserved');
select lives_ok($$select public.portal_save_document_review('43000000-0000-0000-0000-000000000001','{"first_name":"Ada"}','{}','["first_name"]','[]')$$,'draft manual confirmation preserved');
select lives_ok($$insert into public.enrollment_application_documents(id,application_id,category,storage_path,filename) values('53000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','Passport','43000000-0000-0000-0000-000000000001/a.pdf','a.pdf')$$,'draft document registration preserved');
select throws_ok($$update public.enrollment_application_documents set storage_path='43000000-0000-0000-0000-000000000001/b.pdf' where id='53000000-0000-0000-0000-000000000001'$$,'42501',null,'draft locator is immutable too');
-- The foreign file's receipt names the application's passport (as a checked upload would), so only the prefix rule can refuse it.
select pg_temp.checked_upload('foreign/b.pdf', 'Passport', '43000000-0000-0000-0000-000000000001');
select throws_ok($$insert into public.enrollment_application_documents(application_id,category,storage_path,filename) values('43000000-0000-0000-0000-000000000001','Passport','foreign/b.pdf','b.pdf')$$,'42501',null,'foreign prefix insertion denied');
select lives_ok($$insert into public.enrollment_application_messages(application_id,author,body) values('43000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001','Agency message')$$,'agency public message preserved');
select throws_ok($$insert into public.enrollment_application_messages(application_id,author,body,visibility) values('43000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001','Forged note','internal')$$,'42501',null,'agency internal-note insertion denied');
select lives_ok($$insert into public.enrollment_application_consents(application_id,method) values('43000000-0000-0000-0000-000000000001','Signed')$$,'draft consent recording preserved');
select lives_ok($$update public.portal_notifications set read=true where id='63000000-0000-0000-0000-000000000001'$$,'notification acknowledgement preserved');
select throws_ok($$update public.portal_notifications set title='Forged' where id='63000000-0000-0000-0000-000000000001'$$,'42501',null,'notification contents cannot be forged');
select throws_ok($$select public.portal_submit_application('43000000-0000-0000-0000-000000000001','{"values":{"first_name":"Ada"},"wizard":{"confirmed":["first_name"]}}')$$,'22023',null,'incomplete legacy submission is now rejected');
select is((select count(*)::int from public.enrollment_application_versions),0,'rejected submission writes no snapshot');
select is((select count(*)::int from public.enrollment_application_status_history),0,'rejected submission writes no history');
reset role;
update enrollment_applications set status='submitted' where id='43000000-0000-0000-0000-000000000001';
set local role authenticated;
select throws_ok($$select public.portal_save_document_review('43000000-0000-0000-0000-000000000001','{"first_name":"Tamper"}')$$,'42501',null,'submitted manual changes denied');
set local request.jwt.claims='{"email":"positive-admin@example.test"}';
select is(public.portal_is_slit_admin(),false,'matching email cannot grant another UID administrator access');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select is((select count(*)::int from public.agencies where id in ('13000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000002')),2,'SLIT admin agency visibility preserved');
select lives_ok($$select public.portal_save_document_review('43000000-0000-0000-0000-000000000001','{"first_name":"Admin correction"}')$$,'SLIT admin review correction preserved');
select lives_ok($$insert into public.enrollment_application_messages(application_id,author,body,visibility) values('43000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000002','Private','internal')$$,'SLIT admin internal note preserved');
select is((select count(*)::int from public.enrollment_application_messages where visibility='internal' and application_id='43000000-0000-0000-0000-000000000001'),1,'SLIT admin internal-note visibility preserved');
-- Migration 86: agency invitations and scoped user administration (actor-parameterised, as the edge function calls them).
reset role;
insert into auth.users(id,email,email_confirmed_at) values
 ('33000000-0000-0000-0000-000000000010','agency-admin-a@example.test',now()),('33000000-0000-0000-0000-000000000011','agency-admin-b@example.test',now()),
 ('33000000-0000-0000-0000-000000000012','agent-b@example.test',now()),('33000000-0000-0000-0000-000000000013','accept.me@example.test',now()),
 ('33000000-0000-0000-0000-000000000014','agency-admin-a2@example.test',now());
insert into public.portal_profiles(id,auth_user_id,full_name,email) values
 ('23000000-0000-0000-0000-000000000010','33000000-0000-0000-0000-000000000010','Admin A','agency-admin-a@example.test'),
 ('23000000-0000-0000-0000-000000000011','33000000-0000-0000-0000-000000000011','Admin B','agency-admin-b@example.test'),
 ('23000000-0000-0000-0000-000000000012','33000000-0000-0000-0000-000000000012','Agent B','agent-b@example.test');
insert into public.agency_memberships(user_id,agency_id,role) values
 ('23000000-0000-0000-0000-000000000010','13000000-0000-0000-0000-000000000001','agency_admin'),
 ('23000000-0000-0000-0000-000000000011','13000000-0000-0000-0000-000000000002','agency_admin'),
 ('23000000-0000-0000-0000-000000000012','13000000-0000-0000-0000-000000000002','agent');
select lives_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010',null,'new.agent@example.test','New Agent','agent')$$,'agency admin invites an agent; agency comes from their own membership');
select is((select agency_id from public.agency_invitations where email='new.agent@example.test'),'13000000-0000-0000-0000-000000000001'::uuid,'invitation is bound to the inviter agency');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010','13000000-0000-0000-0000-000000000002','other@example.test','Other','agent')$$,'42501',null,'agency admin cannot target another agency');
select lives_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010','13000000-0000-0000-0000-000000000001','second.admin@example.test','Second','agency_admin')$$,'agency admin may invite another agency admin into the same agency');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010',null,'esc@example.test','Esc','slit_admin')$$,'42501',null,'agency admin cannot invite an organization admin role');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010',null,'positive-admin@example.test','Esc','agent')$$,'42501',null,'an existing organization admin cannot be invited into an agency');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010',null,'esc2@example.test','Esc','owner')$$,'22023',null,'unknown role rejected');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000001',null,'by.agent@example.test','X','agent')$$,'42501',null,'agent cannot invite');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010',null,'new.agent@example.test','Dup','agent')$$,'23505',null,'already-invited email rejected');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010',null,'positive@example.test','Dup','agent')$$,'23505',null,'already-member email rejected');
update public.agency_invitations set expires_at=now()-interval '1 day' where email='new.agent@example.test';
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000010',null,'new.agent@example.test','Dup','agent')$$,'23505',null,'expired invitation must be resent, not recreated');
select lives_ok($$select public.portal_invitation_resend('33000000-0000-0000-0000-000000000010',(select id from public.agency_invitations where email='new.agent@example.test'))$$,'inviting agency admin resends an expired invitation');
select ok((select expires_at>now() from public.agency_invitations where email='new.agent@example.test'),'resend renews the expiry');
select throws_ok($$select public.portal_invitation_resend('33000000-0000-0000-0000-000000000011',(select id from public.agency_invitations where email='new.agent@example.test'))$$,'42501',null,'another agency admin cannot resend');
select lives_ok($$select public.portal_invitation_resend('33000000-0000-0000-0000-000000000002',(select id from public.agency_invitations where email='new.agent@example.test'))$$,'organization admin can resend any invitation');
select throws_ok($$select public.portal_invitation_revoke('33000000-0000-0000-0000-000000000001',(select id from public.agency_invitations where email='new.agent@example.test'))$$,'42501',null,'agent cannot revoke');
select lives_ok($$select public.portal_invitation_revoke('33000000-0000-0000-0000-000000000010',(select id from public.agency_invitations where email='new.agent@example.test'))$$,'inviting agency admin revokes');
select throws_ok($$select public.portal_invitation_revoke('33000000-0000-0000-0000-000000000010',(select id from public.agency_invitations where email='new.agent@example.test'))$$,'22023',null,'revoked invitation cannot be revoked again');
select lives_ok($$select public.portal_agency_create_with_admin('33000000-0000-0000-0000-000000000002','{"name":"Atomic Agency","code":"ATOMIC-1"}'::jsonb,'atomic.admin@example.test','Atomic Admin')$$,'organization admin creates an agency with its first admin');
select is((select count(*)::int from public.agency_invitations i join public.agencies a on a.id=i.agency_id where a.code='ATOMIC-1' and i.role='agency_admin' and i.status='pending'),1,'agency and admin invitation exist together');
select throws_ok($$select public.portal_agency_create_with_admin('33000000-0000-0000-0000-000000000002','{"name":"Bad Agency","code":"ATOMIC-BAD"}'::jsonb,'not-an-email','Bad')$$,'22023',null,'invalid admin email fails the whole creation');
select is((select count(*)::int from public.agencies where code='ATOMIC-BAD'),0,'no agency is left behind without its admin invitation');
select throws_ok($$select public.portal_agency_create_with_admin('33000000-0000-0000-0000-000000000010','{"name":"Mine","code":"MINE-1"}'::jsonb,'x@example.test','X')$$,'42501',null,'agency admin cannot create agencies');
select lives_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000002','b.agent@example.test','B Agent','agent')$$,'organization admin adds an agent to any agency');
select throws_ok($$select public.portal_member_update('33000000-0000-0000-0000-000000000010','23000000-0000-0000-0000-000000000012',null,'Inactive')$$,'42501',null,'agency admin cannot deactivate another agency agent');
select throws_ok($$select public.portal_member_update('33000000-0000-0000-0000-000000000010','23000000-0000-0000-0000-000000000011',null,'Inactive')$$,'42501',null,'agency admin cannot touch another agency admin');
select throws_ok($$select public.portal_member_update('33000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001',null,'Inactive')$$,'42501',null,'agent has no user-management rights');
select throws_ok($$select public.portal_member_update('33000000-0000-0000-0000-000000000010','23000000-0000-0000-0000-000000000010',null,'Inactive')$$,'23514',null,'last agency admin cannot remove themselves');
select throws_ok($$select public.portal_member_update('33000000-0000-0000-0000-000000000002','23000000-0000-0000-0000-000000000010','agent',null)$$,'23514',null,'last agency admin cannot be demoted, even by an organization admin');
select lives_ok($$select public.portal_member_update('33000000-0000-0000-0000-000000000010','23000000-0000-0000-0000-000000000001',null,'Inactive')$$,'agency admin deactivates an agent in their own agency');
select is((select status from public.agency_memberships where user_id='23000000-0000-0000-0000-000000000001'),'Inactive','deactivation is recorded');
select lives_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','accept.me@example.test','Accepted','agent')$$,'invite for acceptance');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000013';
select is((public.portal_resolve_access()->>'accepted')::boolean,true,'first sign-in accepts the invitation for the verified email');
reset role;
select is((select m.role||'/'||m.status from public.agency_memberships m join public.portal_profiles p on p.id=m.user_id where p.auth_user_id='33000000-0000-0000-0000-000000000013'),'agent/Active','accepted invitation becomes an active agent membership');
select is((select status from public.agency_invitations where email='accept.me@example.test'),'accepted','invitation is marked accepted');
insert into auth.users(id,email) values ('33000000-0000-0000-0000-000000000015','pending.only@example.test');
insert into public.agency_invitations(agency_id,email,role) values ('13000000-0000-0000-0000-000000000001','pending.only@example.test','agent');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000015';
select is(public.portal_resolve_access()->>'state','no_access','unconfirmed email never accepts an invitation');
reset role;
insert into public.portal_profiles(id,auth_user_id,full_name,email) values ('23000000-0000-0000-0000-000000000014','33000000-0000-0000-0000-000000000014','Admin A2','agency-admin-a2@example.test');
insert into public.agency_memberships(user_id,agency_id,role) values ('23000000-0000-0000-0000-000000000014','13000000-0000-0000-0000-000000000001','agency_admin');
select lives_ok($$select public.portal_member_update('33000000-0000-0000-0000-000000000010','23000000-0000-0000-0000-000000000010',null,'Inactive')$$,'an agency admin may step down once another active admin exists');
select ok((select count(*) from public.portal_audit_log where action in ('invite_user','resend_invitation','revoke_invitation','create_agency','deactivate_user','accept_invitation'))>=8,'invitations and role changes are audited');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000011';
select is((select count(*)::int from public.agency_invitations where agency_id='13000000-0000-0000-0000-000000000001'),0,'agency admin cannot read another agency invitations');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000011',null,'direct@example.test','D','agent')$$,'42501',null,'actor-parameterised functions are not callable by signed-in users');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000012';
select is((select count(*)::int from public.agency_invitations),0,'agents cannot read invitations');
-- Migration 87: notification sender identity comes from the database, per organization.
reset role;
insert into auth.users(id,email) values ('33000000-0000-0000-0000-000000000020','org-one-admin@example.test'),('33000000-0000-0000-0000-000000000021','platform@example.test');
insert into public.tenants(id,slug,name) values ('1b000000-0000-0000-0000-000000000001','sender-one','Org One "Uni"'),('1b000000-0000-0000-0000-000000000002','sender-two','Org Two');
insert into public.tenant_memberships(tenant_id,auth_user_id,role) values ('1b000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000020','tenant_admin');
insert into public.platform_admins(auth_user_id) values ('33000000-0000-0000-0000-000000000021');
set local role service_role;
select is(public.notification_resolve_sender(null),'{"name":"Skyline Institute of Technology","email":"it@slit.edu.au"}'::jsonb,'legacy scope defaults to it@slit.edu.au with the Skyline name');
reset role;
set local role service_role;
select is(public.notification_resolve_sender('1b000000-0000-0000-0000-000000000001'),null,'an organization without a sender configuration resolves to nothing (fails safely, no platform fallback)');
reset role;
insert into public.notification_sender_domains(tenant_id,domain,note) values ('1b000000-0000-0000-0000-000000000001','one.example.test','test');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000020';
select lives_ok($$select public.notification_save_sender('1b000000-0000-0000-0000-000000000001','IT@one.example.test',null,null)$$,'organization admin saves a sender on a verified domain');
reset role;
set local role service_role;
select is(public.notification_resolve_sender('1b000000-0000-0000-0000-000000000001')->>'name','Org One  Uni','the sender name defaults to the organization name (quotes neutralised)');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000020';
select throws_ok($$select public.notification_save_sender('1b000000-0000-0000-0000-000000000001','ceo@evil.example.test',null,null)$$,'22023',null,'an address on an unverified domain is rejected on save');
select throws_ok($$select public.notification_save_sender('1b000000-0000-0000-0000-000000000001','not-an-address',null,null)$$,'22023',null,'a malformed address is rejected on save');
select throws_ok($$select public.notification_set_sender_domain('1b000000-0000-0000-0000-000000000001','evil.example.test',true,'self-approve')$$,'42501',null,'an organization admin cannot declare a domain verified');
select throws_ok($$select public.notification_save_sender('1b000000-0000-0000-0000-000000000002','it@one.example.test',null,null)$$,'42501',null,'an organization admin cannot change another organization sender');
select throws_ok($$select public.notification_save_sender(null,'it@slit.edu.au',null,null)$$,'42501',null,'an organization admin cannot change the legacy sender');
reset role;
set local role service_role;
select is(public.notification_sender_allowed('1b000000-0000-0000-0000-000000000002','it@one.example.test'),false,'another organization cannot use this organization sender address');
reset role;
set local role service_role;
select is(public.notification_resolve_sender('1b000000-0000-0000-0000-000000000002'),null,'the other organization still has no sender');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000011';
select throws_ok($$select public.notification_save_sender(null,'it@slit.edu.au','Mine',null)$$,'42501',null,'an agency admin cannot change sender settings');
select throws_ok($$select public.notification_set_sender_domain(null,'evil.example.test',true,'x')$$,'42501',null,'an agency admin cannot verify domains');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000012';
select throws_ok($$select public.notification_save_sender('1b000000-0000-0000-0000-000000000001','it@one.example.test','Mine',null)$$,'42501',null,'an agent cannot change sender settings');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000021';
select lives_ok($$select public.notification_set_sender_domain('1b000000-0000-0000-0000-000000000002','two.example.test',true,'verified in Postmark')$$,'a platform admin verifies a domain for an organization');
select lives_ok($$select public.notification_save_sender('1b000000-0000-0000-0000-000000000002','it@two.example.test','Two Override','help@two.example.test')$$,'name and reply-to can be overridden');
reset role;
set local role service_role;
select is(public.notification_resolve_sender('1b000000-0000-0000-0000-000000000002'),'{"name":"Two Override","email":"it@two.example.test","replyTo":"help@two.example.test"}'::jsonb,'the resolved sender carries the override and reply-to');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.notification_save_sender(null,'ceo@evil.example.test',null,null)$$,'22023',null,'SLIT admin cannot save an unverified legacy address either');
select lives_ok($$select public.notification_save_sender(null,'admissions@slit.edu.au','Skyline Admissions',null)$$,'SLIT admin saves the legacy sender');
reset role;
update public.notification_sender_domains set revoked_at=now() where tenant_id is null and domain='slit.edu.au';
set local role service_role;
select is(public.notification_resolve_sender(null),null,'revoking the verified domain stops the sender (fails safely)');
reset role;
-- Migration 88: notification-delivery scheduler (pg_cron + pg_net, key from Vault at run time).
reset role;
select has_function('public','notification_dispatch_worker',array[]::text[],'the dispatcher function exists');
select is((select count(*)::int from cron.job where jobname='notification-delivery-worker'),1,'exactly one notification-delivery cron job exists');
select is((select schedule||'|'||active::text from cron.job where jobname='notification-delivery-worker'),'* * * * *|false','the job runs every minute but is inactive until the owner activates it (migration 90)');
select is((select command from cron.job where jobname='notification-delivery-worker'),'select public.notification_dispatch_worker();','the job command is only the dispatcher call (no key, no header)');
select ok((select prosrc !~ 'eyJ' and prosrc ~ 'vault.decrypted_secrets' and prosrc ~ 'notification_service_role_key' from pg_proc where proname='notification_dispatch_worker'),'the dispatcher reads the key from Vault and embeds no key material');
select is(public.notification_dispatch_worker(),null,'without the Vault secret the dispatcher makes no request');
set local role authenticated;
select throws_ok($$select public.notification_dispatch_worker()$$,'42501',null,'signed-in users cannot run the dispatcher');
reset role;
-- Migration 89: invitation input rules (name 2-100 without control characters; email trimmed, lower-cased, max 254).
reset role;
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','v1@example.test','   ','agent')$$,'22023',null,'a blank name is rejected');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','v2@example.test','A','agent')$$,'22023',null,'a 1-character name is rejected');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','v3@example.test',repeat('n',101),'agent')$$,'22023',null,'a 101-character name is rejected');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','v4@example.test',E'Bad\x01Name','agent')$$,'22023',null,'a name with a control character is rejected');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001',repeat('x',250)||'@example.test','Long Email','agent')$$,'22023',null,'an email over 254 characters is rejected');
select lives_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','  MiXed.Case@Example.TEST ','  Mixed Case  ','agent')$$,'a padded, mixed-case email and name are accepted');
select is((select email||'|'||full_name from public.agency_invitations where email like 'mixed.case@%'),'mixed.case@example.test|Mixed Case','the email is stored trimmed and lower-cased and the name trimmed');
-- Migration 91 (P08-04): new default status graph, legacy rows move forward only, no agent / agency-admin status transitions after submission, labels.
reset role;
insert into auth.users(id,email) values ('33000000-0000-0000-0000-000000000030','status-agent@example.test');
insert into public.portal_profiles(id,auth_user_id,full_name,email) values ('23000000-0000-0000-0000-000000000030','33000000-0000-0000-0000-000000000030','Status agent','status-agent@example.test');
insert into public.agency_memberships(user_id,agency_id,role) values ('23000000-0000-0000-0000-000000000030','13000000-0000-0000-0000-000000000001','agent');
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status,data) values
 ('43000000-0000-0000-0000-000000000030','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}'),
 ('43000000-0000-0000-0000-000000000031','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','under_review','{}'),
 ('43000000-0000-0000-0000-000000000032','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','under_review','{}'),
 ('43000000-0000-0000-0000-000000000033','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','offer_issued','{}'),
 ('43000000-0000-0000-0000-000000000034','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','offer_issued','{}'),
 ('43000000-0000-0000-0000-000000000035','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','action_required','{}'),
 ('43000000-0000-0000-0000-000000000036','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}'),
 ('43000000-0000-0000-0000-000000000037','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}'),
 ('43000000-0000-0000-0000-0000000000e6','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','action_required','{}');
-- Migration 20261113260000: statuses and actions from the catalogue tables; Offer letter issued only through the offer letter
-- command; the applicant resubmits and accepts; staff marking an offer accepted, rejecting or asking for action add a note.
update public.enrollment_applications set created_by='23000000-0000-0000-0000-000000000030' where id='43000000-0000-0000-0000-000000000030';
update public.enrollment_applications set student_email='direct.student@example.test', student_name='Direct Student' where id='43000000-0000-0000-0000-000000000036';
update public.enrollment_applications set student_email='mismatch@example.test', data='{"values":{"declaration_name":"Asha Patel","digital_signature":"Someone Else"}}' where id='43000000-0000-0000-0000-000000000037';
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status,data) values
 ('43000000-0000-0000-0000-000000000038','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}'),
 ('43000000-0000-0000-0000-000000000039','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}');
-- Reads the offer letters table as its owner (the tests run as the signed-in user, who has no direct access).
create function pg_temp.letter(p_app uuid, p_expr text) returns text language plpgsql security definer as $$ declare r text; begin execute format('select %s from public.enrollment_offer_letters where application_id = $1 order by issued_at desc limit 1', p_expr) into r using p_app; return r; end $$;
-- Any read as the owner, for tables the signed-in user cannot read (outbox, deliveries).
create function pg_temp.q(p_sql text) returns text language plpgsql security definer as $$ declare r text; begin execute p_sql into r; return r; end $$;
create function pg_temp.loo() returns text language sql as $$ select encode(convert_to(E'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'UTF8'), 'base64') $$;
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','under_review')$$,'22023',null,'"Under review" is not a target of the default graph');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','offer_issued')$$,'22023',null,'Offer letter issued is reached only through Issue offer letter');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','offer_accepted','by email')$$,'22023',null,'submitted cannot jump to offer_accepted (an offer is accepted from an issued letter)');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000039','rejected')$$,'22023',null,'a rejection needs a note');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000039','rejected','Course full')$$,'an admin can reject a submitted application with a note');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000038','withdrawn','Student request')$$,'an admin can withdraw a submitted application with a reason');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','action_required','Please correct the passport')$$,'submitted -> action_required');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','submitted')$$,'22023',null,'staff do not resubmit: the student or agent does');
select throws_ok($$select public.portal_application_resubmit('43000000-0000-0000-0000-0000000000e6','Fixed','{"method":"electronic","confirmed":true,"authorised":false}')$$,'22023',null,'resubmitting needs both declaration confirmations (20261113310000)');
select lives_ok($$select public.portal_application_resubmit('43000000-0000-0000-0000-0000000000e6','Fixed the passport','{"method":"electronic","confirmed":true,"authorised":true,"declarationVersion":"1.0"}')$$,'staff resubmit a corrected application (20261113310000)');
select is(pg_temp.q($q$select (select status from public.enrollment_applications where id='43000000-0000-0000-0000-0000000000e6')||'|'||(select count(*) from public.enrollment_application_consents where application_id='43000000-0000-0000-0000-0000000000e6')$q$),'submitted|1','back to Submitted, the declaration recorded again');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select lives_ok($$select public.portal_application_resubmit('43000000-0000-0000-0000-000000000030','Passport replaced')$$,'the agent resubmits after the correction');
select is((select status from public.enrollment_applications where id='43000000-0000-0000-0000-000000000030'),'submitted','resubmitted: back to Submitted');
select ok(exists(select 1 from public.enrollment_application_status_history where application_id='43000000-0000-0000-0000-000000000030' and new_status='submitted' and note='Passport replaced'),'the resubmission is in the history with its note');
select throws_ok($$select public.portal_offer_letter_issue('43000000-0000-0000-0000-000000000030','upload','LOO.pdf',pg_temp.loo())$$,'42501',null,'an agent cannot issue an offer letter');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.portal_offer_letter_issue('43000000-0000-0000-0000-000000000030','upload','LOO.pdf',encode('not a pdf','base64'))$$,'22023',null,'the letter must be a PDF');
select is(public.portal_offer_letter_recipient('43000000-0000-0000-0000-000000000030')->>'kind','agent','started by an agent: the letter goes to the agent');
select is(public.portal_offer_letter_recipient('43000000-0000-0000-0000-000000000036')->>'kind','student','created by staff for the student: the letter goes to the student');
select lives_ok($$select public.portal_offer_letter_issue('43000000-0000-0000-0000-000000000030','upload','LOO.pdf',pg_temp.loo(),null,'Welcome aboard')$$,'Send offer letter (upload)');
select is((select status from public.enrollment_applications where id='43000000-0000-0000-0000-000000000030'),'offer_issued','the application is now Offer letter issued');
select is(pg_temp.letter('43000000-0000-0000-0000-000000000030',$q$recipient_kind||'|'||recipient_email$q$),'agent|status-agent@example.test','the letter is stored with the routed recipient');
select is(pg_temp.q($q$select count(*) from public.admission_event_outbox where application_id='43000000-0000-0000-0000-000000000030' and event='offer_letter_issued'$q$)::int,1,'the offer letter email is queued');
select is(pg_temp.q($q$select recipient_email from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000030' and event='offer_letter_issued' limit 1$q$),'status-agent@example.test','the email goes to the agent only');
select ok(exists(select 1 from public.enrollment_application_status_history where application_id='43000000-0000-0000-0000-000000000030' and new_status='offer_issued' and note like 'Offer letter sent to agent status-agent@example.test%'),'the history says who the letter went to');
select throws_ok($$select public.portal_offer_letter_issue('43000000-0000-0000-0000-000000000030','upload','LOO.pdf',pg_temp.loo())$$,'22023',null,'no second letter while one waits for acceptance');
select lives_ok($$select public.portal_offer_letter_resend('43000000-0000-0000-0000-000000000030')$$,'Resend offer letter');
select is(pg_temp.q($q$select count(*) from public.admission_event_outbox where application_id='43000000-0000-0000-0000-000000000030' and event='offer_letter_issued'$q$)::int,2,'the resend queues the email again');
select throws_ok($$select public.portal_offer_accept('43000000-0000-0000-0000-000000000030')$$,'42501',null,'staff record acceptance with Mark offer accepted, not the applicant accept');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select is((public.portal_offer_letter_current('43000000-0000-0000-0000-000000000030'))->>'fileName','LOO.pdf','the agent sees the current letter');
select lives_ok($$select public.portal_offer_accept('43000000-0000-0000-0000-000000000030')$$,'the agent accepts the offer for the student');
select is((select status from public.enrollment_applications where id='43000000-0000-0000-0000-000000000030'),'offer_accepted','accepting moves the application to Offer accepted');
select is(pg_temp.letter('43000000-0000-0000-0000-000000000030',$q$(accepted_at is not null)::text||'|'||accepted_via$q$),'true|portal','the acceptance time and channel are recorded on the letter');
select throws_ok($$select public.portal_offer_accept('43000000-0000-0000-0000-000000000030')$$,'22023',null,'an accepted offer cannot be accepted again');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000035','submitted')$$,'42501',null,'an agent has no staff status command');
select throws_ok($$select public.portal_submit_v2('43000000-0000-0000-0000-000000000035',0,'p0804-resubmit','{}')$$,'PT409',null,'portal_submit_v2 still submits drafts only (the resubmit command handles Action required)');
select throws_ok($$update public.enrollment_applications set status='enrolled' where id='43000000-0000-0000-0000-000000000035'$$,'42501',null,'a direct status write by an agent is refused');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000014';
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000035','submitted')$$,'42501',null,'an agency admin has no staff status command');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','submitted')$$,'22023',null,'offer_accepted cannot go back to submitted');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','coe_issued')$$,'offer_accepted -> coe_issued');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','enrolled')$$,'coe_issued -> enrolled');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','withdrawn')$$,'22023',null,'enrolled is terminal');
-- Staff mark an offer accepted (e.g. by email) with a note; a declaration mismatch needs a note to issue the letter.
select lives_ok($$select public.portal_offer_letter_issue('43000000-0000-0000-0000-000000000036','template','Offer.pdf',pg_temp.loo())$$,'Send offer letter (template) to a student');
select is(pg_temp.letter('43000000-0000-0000-0000-000000000036',$q$recipient_kind||'|'||recipient_email$q$),'student|direct.student@example.test','the letter goes to the student');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000036','offer_accepted','Accepted by email on 12 Nov')$$,'22023',null,'staff cannot mark an offer accepted: only the recipient accepts (20261113280000)');
select is((select status from public.enrollment_applications where id='43000000-0000-0000-0000-000000000036'),'offer_issued','the offer stays issued until the recipient accepts');
select ok(not exists(select 1 from public.application_status_transitions where action_key='mark_accepted'),'there is no manual Mark offer accepted');
select throws_ok($$select public.portal_offer_letter_issue('43000000-0000-0000-0000-000000000037','upload','LOO.pdf',pg_temp.loo())$$,'22023',null,'a declaration mismatch stops the letter without a note');
select lives_ok($$select public.portal_offer_letter_issue('43000000-0000-0000-0000-000000000037','upload','LOO.pdf',pg_temp.loo(),null,'','Checked with the student by phone')$$,'staff can issue it with a note');
select ok(exists(select 1 from public.enrollment_application_status_history where application_id='43000000-0000-0000-0000-000000000037' and new_status='offer_issued' and note like '%Declaration mismatch accepted: Checked with the student by phone%'),'the override note is in the history');
-- Legacy rows move forward only; a reminder keeps the status.
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000031','action_required','Need the visa')$$,'a legacy under_review row moves forward');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000032','submitted')$$,'22023',null,'a legacy under_review row cannot move back to submitted');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000033','offer_accepted','Accepted by phone')$$,'22023',null,'a legacy offer_issued row is accepted only by the recipient');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000034','under_review')$$,'22023',null,'a legacy offer_issued row cannot move back to under_review');
select lives_ok($$select public.portal_application_reminder('43000000-0000-0000-0000-000000000035','Please upload the passport')$$,'Send reminder on Action required');
select is(pg_temp.q($q$select count(*) from public.admission_event_outbox where application_id='43000000-0000-0000-0000-000000000035' and event='action_required_reminder'$q$)::int,1,'the reminder email is queued');
select is((select status from public.enrollment_applications where id='43000000-0000-0000-0000-000000000035'),'action_required','a reminder keeps the status');
select throws_ok($$select public.portal_application_reminder('43000000-0000-0000-0000-000000000036')$$,'22023',null,'no reminder outside Action required');
reset role;
select is(jsonb_array_length(public.application_status_workflow()->'statuses'),10,'the catalogue lists every status');
select is((select s->>'label' from jsonb_array_elements(public.application_status_workflow()->'statuses') s where s->>'value'='offer_issued'),'Offer letter issued','the new status label');
select is((select string_agg(x->>'action', ',' order by (x->>'sort')::int) from jsonb_array_elements(public.application_status_workflow()->'actions') x where x->>'from'='submitted' and x->>'actor'='staff'),'issue_offer,action_required,withdraw,reject','Submitted offers Issue offer letter, Action required, Withdraw, Reject');
select is((select count(*)::int from jsonb_array_elements_text(public.tenant_config_defaults('workflow')->'statuses') x where x='under_review'),0,'the default workflow does not list the legacy status');
select is((select count(*)::int from jsonb_array_elements(public.tenant_config_defaults('workflow')->'transitions') t where t->>'to'='offer_issued'),1,'new tenant workflows reach Offer letter issued from Submitted');
select lives_ok($$select public.tenant_config_validate('workflow', public.tenant_config_defaults('workflow'))$$,'the default workflow passes the existing validator');
select is(public.portal_status_label('coe_issued'),'CoE / VoE issued','coe_issued reads "CoE / VoE issued" in notification text');
select is(public.portal_status_label('action_required'),'Action required','labels come from the catalogue');
-- Migration 20261113270000: offer letter templates. One registry; values from the application, the chosen course / intake and its
-- fee setup (an intake's fees override the course's); unmapped tokens keep a template inactive; Send needs every required detail.
reset role;
insert into public.cms_courses(id, slug, code, name, status) values ('loo-course', 'loo-course', 'BSB50120', 'Diploma of Business', 'Published');
insert into public.course_intakes(id, course_id, start_date, end_date, label) values ('53000000-0000-0000-0000-0000000000f1', 'loo-course', '2027-02-03', '2028-02-02', 'February 2027');
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status,student_email,student_name,data) values
 ('43000000-0000-0000-0000-0000000000f0','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','loo.student@example.test','Asha Patel',
  '{"values":{"title":"ms","first_name":"ASHA","middle_name":"rani","last_name":"o''neil-smith","dob":"2001-04-12","nationality":"India","passport_number":"N1234567","au_street":"1 Example St","au_suburb":"Melbourne","au_state":"VIC","au_zip":"3000"}}'),
 ('43000000-0000-0000-0000-0000000000f1','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','loo.two@example.test','Ravi Kumar',
  '{"values":{"first_name":"Ravi","last_name":"Kumar","dob":"2000-01-31","nationality":"India"}}');
select set_config('portal.draft_command','43000000-0000-0000-0000-0000000000f0',true);
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id) values ('43000000-0000-0000-0000-0000000000f0','loo-course','BSB50120','Diploma of Business','53000000-0000-0000-0000-0000000000f1');
select set_config('portal.draft_command','43000000-0000-0000-0000-0000000000f1',true);
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id) values ('43000000-0000-0000-0000-0000000000f1','loo-course','BSB50120','Diploma of Business','53000000-0000-0000-0000-0000000000f1');
select set_config('portal.draft_command','',true);
insert into public.course_fee_setups(course_id, intake_id, tuition_fee, enrolment_fee) values ('loo-course', null, 14000, 250), ('loo-course', '53000000-0000-0000-0000-0000000000f1', 14500, null);
insert into hr.sign_templates(id, name, title, body_html, kind, audience, category, created_by) values
 ('73000000-0000-0000-0000-0000000000a1','LOO standard','Letter of offer','<p>Dear {{student.full_name}}, born {{student.dob}}. {{course.name}} ({{course.cricos}}) from {{course.start_date}}. Tuition {{fees.tuition}}, material {{fees.material}}. Page {{page.number}} of {{page.total}}.</p>',
  'text','student','student_offer_letter','33000000-0000-0000-0000-000000000002'),
 ('73000000-0000-0000-0000-0000000000a2','LOO old','Letter of offer','<p>Dear $[dogField], {example2:inline} [Page Number] [optional note] {{student.dob|shout}}</p>','text','student','student_offer_letter','33000000-0000-0000-0000-000000000002');
select is(public.letter_format_name('ASHA o''neil-smith'),'Asha O''Neil-Smith','names print in Title Case, also after an apostrophe or hyphen');
insert into public.cms_courses(id, slug, code, name, status) values ('loo-c2', 'loo-c2-public-slug', 'LOOC2', 'Slug course', 'Published');
select is(public.letter_course_id('loo-c2-public-slug', 'LOOC2'),'loo-c2','a course row holding the public slug resolves to the course setup (20261113290000)');
select is(cardinality(public.letter_template_unmapped('<p>$[dogField] {example2:inline} [Page Number] [optional note] {{student.dob|shout}} {{foo.bar}} {{student.dob|upper}}</p>')),5,'old placeholders, an unknown variable and an unknown modifier are unmapped');
select ok(not ('[optional note]' = any(public.letter_template_unmapped('<p>[Page Number] [optional note]</p>'))),'other text in square brackets stays text');
select ok(hr.rich_html_problem('<p><img src="https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/template-assets/default/'||gen_random_uuid()||'.png"></p>') is null,'a picture in template-assets is allowed in a template');
select ok(hr.rich_html_problem('<p><img src="https://evil.example/logo.png"></p>') is not null,'a picture from another site is refused');
select is((select status from hr.sign_templates where id='73000000-0000-0000-0000-0000000000a2'),'archived','a template with unmapped tokens is saved inactive');
select is((select status from hr.sign_templates where id='73000000-0000-0000-0000-0000000000a1'),'active','a fully mapped template stays active');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
create temporary view loo_v as select public.portal_letter_values('43000000-0000-0000-0000-0000000000f0') v;
select is((select v->'values'->'student.full_name'->>'value' from loo_v),'Ms Asha Rani O''Neil-Smith','full name = title + given + middle + family, Title Case');
select is((select v->'values'->'student.dob'->>'value' from loo_v),'12/04/2001','date of birth as DD/MM/YYYY');
select is((select v->'values'->'student.passport_number'->>'value' from loo_v),'N1234567','passport number from the final answers');
select is((select v->'values'->'student.nationality'->>'value' from loo_v),'India','nationality');
select is((select v->'values'->'student.address'->>'value' from loo_v),'1 Example St, Melbourne VIC 3000','address with the empty line 2 left out');
select is((select v->'values'->'course.name'->>'value' from loo_v),'Diploma of Business','course from the course setup');
select is((select v->'values'->'course.intake'->>'value' from loo_v),'February 2027','the intake chosen on the application');
select is((select v->'values'->'course.start_date'->>'value' from loo_v),'03/02/2027','the intake''s start date');
select is((select v->'values'->'fees.tuition'->>'value' from loo_v),'AUD$14,500.00','the intake''s tuition overrides the course''s');
select is((select v->'values'->'fees.enrolment'->>'value' from loo_v),'AUD$250.00','the course''s enrolment fee where the intake sets none');
select is((select v->'values'->'fees.total'->>'value' from loo_v),'AUD$14,750.00','total fees');
select ok((select (v->'values'->'course.cricos'->>'missing')::boolean from loo_v),'an empty CRICOS code is missing');
select ok((select v->'values'->'fees.tuition'->>'source' from loo_v) like '%for intake February 2027%','the source says which fee setup it came from');
select ok(exists(select 1 from jsonb_array_elements(public.letter_templates()) t where t->>'id'='73000000-0000-0000-0000-0000000000a2' and t->'unmapped' ? '$[dogField]'),'the template list shows the unmapped tokens');
select throws_ok($$select public.letter_template_set_active('73000000-0000-0000-0000-0000000000a2', true)$$,'22023',null,'a template with unmapped tokens cannot be made active');
select throws_ok($$select public.portal_offer_letter_issue_template('43000000-0000-0000-0000-0000000000f0','73000000-0000-0000-0000-0000000000a1',1,'Offer.pdf',pg_temp.loo())$$,'22023',null,'Send is refused while required details are missing');
select throws_ok($$select public.portal_offer_letter_issue_template('43000000-0000-0000-0000-0000000000f0','73000000-0000-0000-0000-0000000000a1',1,'Offer.pdf',pg_temp.loo(),'[{"key":"fees.material","mode":"blank"}]')$$,'22023',null,'an optional detail left blank does not fill a required one');
select throws_ok($$select public.portal_offer_letter_issue_template('43000000-0000-0000-0000-0000000000f0','73000000-0000-0000-0000-0000000000a1',1,'Offer.pdf',pg_temp.loo(),'[{"key":"course.cricos","mode":"blank"},{"key":"fees.material","mode":"blank"}]')$$,'22023',null,'a required detail cannot be left blank');
select throws_ok($$select public.portal_offer_letter_issue_template('43000000-0000-0000-0000-0000000000f0','73000000-0000-0000-0000-0000000000a1',1,'Offer.pdf',pg_temp.loo(),'[{"key":"course.cricos","mode":"letter","value":"0101234"}]')$$,'22023',null,'an optional detail must be filled or ticked blank');
select throws_ok($$select public.portal_offer_letter_issue_template('43000000-0000-0000-0000-0000000000f0','73000000-0000-0000-0000-0000000000a1',9,'Offer.pdf',pg_temp.loo(),'[{"key":"course.cricos","mode":"letter","value":"0101234"},{"key":"fees.material","mode":"blank"}]')$$,'40001',null,'a preview of another template version is refused');
select lives_ok($$select public.portal_offer_letter_issue_template('43000000-0000-0000-0000-0000000000f0','73000000-0000-0000-0000-0000000000a1',1,'Offer.pdf',pg_temp.loo(),'[{"key":"course.cricos","mode":"letter","value":"0101234"},{"key":"fees.material","mode":"blank"}]','','Welcome')$$,'Send with the required detail filled for this letter and the optional one ticked blank');
select is((select status from public.enrollment_applications where id='43000000-0000-0000-0000-0000000000f0'),'offer_issued','the application is Offer letter issued');
select is(pg_temp.letter('43000000-0000-0000-0000-0000000000f0',$q$template_name||'|'||template_version||'|'||jsonb_array_length(manual_values)||'|'||(variable_values->>'course.cricos')$q$),'LOO standard|1|2|0101234','the letter keeps the template name and version, the manual fills and the values used');
select ok(exists(select 1 from public.enrollment_application_status_history where application_id='43000000-0000-0000-0000-0000000000f0' and new_status='offer_issued'
  and note like '%(template "LOO standard" v1)%Filled by hand: CRICOS course code (this letter only); Material fee (left blank)%'),'the manual fills are in the status history');
select is(public.portal_offer_letter_current('43000000-0000-0000-0000-0000000000f0')->>'templateVersion','1','the current letter shows its template version');
-- Fill and save to source: written where the variable comes from, only where allowed, and audited.
select lives_ok($$select public.portal_letter_save_to_source('43000000-0000-0000-0000-0000000000f1','student.passport_number','P7654321')$$,'save a passport number to the application');
select is(public.portal_letter_values('43000000-0000-0000-0000-0000000000f1')->'values'->'student.passport_number'->>'value','P7654321','the value now comes from the application');
select is(pg_temp.q($q$select public.application_values('43000000-0000-0000-0000-0000000000f1')->>'passport_number'$q$),'P7654321','the application''s answer is updated');
select throws_ok($$select public.portal_letter_save_to_source('43000000-0000-0000-0000-0000000000f1','student.full_name','Someone')$$,'42501',null,'a computed variable cannot be saved to a source');
select throws_ok($$select public.portal_letter_save_to_source('43000000-0000-0000-0000-0000000000f1','fees.material','abc')$$,'22023',null,'an amount must be a number');
select lives_ok($$select public.portal_letter_save_to_source('43000000-0000-0000-0000-0000000000f1','fees.material','AUD$500')$$,'save a material fee to the fee setup');
select is(public.portal_letter_values('43000000-0000-0000-0000-0000000000f1')->'values'->'fees.material'->>'value','AUD$500.00','the intake''s fee setup now has the material fee');
select is(public.portal_letter_values('43000000-0000-0000-0000-0000000000f1')->'values'->'fees.tuition'->>'value','AUD$14,500.00','saving one fee keeps the others');
select lives_ok($$select public.portal_letter_save_to_source('43000000-0000-0000-0000-0000000000f1','institute.abn','12 345 678 901')$$,'save the institute ABN to the settings');
select is(public.portal_letter_values('43000000-0000-0000-0000-0000000000f1')->'values'->'institute.abn'->>'value','12 345 678 901','the ABN now comes from the settings');
select is(pg_temp.q($q$select count(*) from public.portal_audit_log where application_id='43000000-0000-0000-0000-0000000000f1' and action='letter_value_saved_to_source'$q$)::int,3,'each save to source is audited');
select lives_ok($$select public.letter_template_set_active('73000000-0000-0000-0000-0000000000a1', false)$$,'a template can be made inactive');
select throws_ok($$select public.portal_offer_letter_issue_template('43000000-0000-0000-0000-0000000000f1','73000000-0000-0000-0000-0000000000a1',1,'Offer.pdf',pg_temp.loo())$$,'22023',null,'an inactive template cannot be used');
select lives_ok($$select public.letter_template_set_active('73000000-0000-0000-0000-0000000000a1', true)$$,'a mapped template can be made active again');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select throws_ok($$select public.portal_letter_values('43000000-0000-0000-0000-0000000000f1')$$,'42501',null,'an agent cannot read the letter values');
select throws_ok($$select public.portal_letter_save_to_source('43000000-0000-0000-0000-0000000000f1','student.passport_number','X1')$$,'42501',null,'an agent cannot save to source');
select throws_ok($$select public.portal_offer_letter_issue_template('43000000-0000-0000-0000-0000000000f1','73000000-0000-0000-0000-0000000000a1',1,'Offer.pdf',pg_temp.loo())$$,'42501',null,'an agent cannot issue a letter');
select throws_ok($$select public.letter_template_set_active('73000000-0000-0000-0000-0000000000a1', false)$$,'42501',null,'an agent cannot change a template');
reset role;
-- Migration 20261113280000: change_application_status (transition, active, not automatic, role, access, reason), notify, undo, enrol;
-- admins write the configuration (audited), guards keep it consistent.
reset role;
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status,data) values
 ('43000000-0000-0000-0000-0000000000e0','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}'),
 ('43000000-0000-0000-0000-0000000000e1','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}'),
 ('43000000-0000-0000-0000-0000000000e2','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}'),
 ('43000000-0000-0000-0000-0000000000e3','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}'),
 ('43000000-0000-0000-0000-0000000000e4','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','coe_issued','{}'),
 ('43000000-0000-0000-0000-0000000000e5','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select ok('Admin' = any(public.application_caller_roles()),'a CMS admin''s role is Admin');
select throws_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e0','reject','{}')$$,'22023',null,'Reject needs a reason');
select throws_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e0','reject',jsonb_build_object('reason_id',(select id from public.status_reasons where status='withdrawn' and label='Student request')))$$,'22023',null,'a reason of another status is refused');
select lives_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e0','reject',jsonb_build_object('reason_id',(select id from public.status_reasons where status='rejected' and label='Course or intake full'),'note','February is full'))$$,'Reject with a reason');
select is((select new_status||'|'||action_key||'|'||reason||'|'||note from public.enrollment_application_status_history where application_id='43000000-0000-0000-0000-0000000000e0' order by created_at desc limit 1),
  'rejected|reject|Course or intake full|Course or intake full — February is full','the history records the action, the reason and the note');
select throws_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e1','action_required',jsonb_build_object('reason_id',(select id from public.status_reasons where status='action_required' and is_other)))$$,'22023',null,'"Other" needs its text');
select lives_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e1','action_required',jsonb_build_object('reason_id',(select id from public.status_reasons where status='action_required' and is_other),'reason_text','Upload the visa grant'))$$,'Action required with Other and its text');
select is((select reason from public.enrollment_application_status_history where application_id='43000000-0000-0000-0000-0000000000e1' order by created_at desc limit 1),'Upload the visa grant','the Other text is the reason');
select lives_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e2','withdraw',jsonb_build_object('reason_id',(select id from public.status_reasons where status='withdrawn' and label='Student request'),'notify',false))$$,'Withdraw without notifying');
select is(pg_temp.q($q$select count(*) from public.admission_event_outbox where application_id='43000000-0000-0000-0000-0000000000e2'$q$)::int,0,'"Notify student/agent" unticked: no email is queued');
select is(pg_temp.q($q$select count(*) from public.admission_event_outbox where application_id='43000000-0000-0000-0000-0000000000e0'$q$)::int,1,'ticked (the default): the email is queued');
select throws_ok($$select public.change_application_status('43000000-0000-0000-0000-000000000036','accept_offer','{}')$$,'22023',null,'accepting an offer is automatic, never a staff action');
select throws_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e3','issue_offer','{}')$$,'22023',null,'Issue offer letter goes through its own command (it needs the letter)');
select throws_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e3','enrol','{}')$$,'22023',null,'an action of another status is refused');
select lives_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e4','enrol','{"enrolment_date":"2027-02-03","note":"Orientation done"}')$$,'Enrol with the enrolment date');
select is((select new_status||'|'||(payload->>'enrolment_date') from public.enrollment_application_status_history where application_id='43000000-0000-0000-0000-0000000000e4' order by created_at desc limit 1),'enrolled|2027-02-03','enrolled, the date in the history');
select is((select string_agg(x->>'action', ',') from jsonb_array_elements(public.application_status_workflow()->'actions') x where x->>'from'='enrolled'),'withdraw','Enrolled offers Withdraw only');
select is((select string_agg(x->>'action', ',' order by (x->>'sort')::int) from jsonb_array_elements(public.application_status_workflow()->'actions') x where x->>'from'='offer_accepted' and not (x->>'automatic')::boolean),'issue_coe,withdraw,reject','Offer accepted offers Issue CoE / VoE, Withdraw, Reject');
select is((select count(*)::int from jsonb_array_elements(public.application_status_workflow()->'actions') x where x->>'from' in ('rejected','withdrawn')),0,'Rejected and Withdrawn are final');
select lives_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e5','reject',jsonb_build_object('reason_id',(select id from public.status_reasons where status='rejected' and label='Course or intake full')))$$,'a reject to undo');
select lives_ok($$select public.revert_application_status('43000000-0000-0000-0000-0000000000e5')$$,'Undo within the toast''s time');
select is((select status from public.enrollment_applications where id='43000000-0000-0000-0000-0000000000e5'),'submitted','undone: back to Submitted');
select is(pg_temp.q($q$select count(*) from public.notification_deliveries where application_id='43000000-0000-0000-0000-0000000000e5' and state='pending'$q$)::int,0,'no email of the undone change is left to send');
select throws_ok($$select public.revert_application_status('43000000-0000-0000-0000-0000000000e5')$$,'22023',null,'an undo cannot be undone');
select throws_ok($$update public.enrollment_applications set status='rejected' where id='43000000-0000-0000-0000-0000000000e3'$$,'42501',null,'a direct status write by an admin is refused (only the commands change it)');
-- The configuration: admins write it, every change is audited, the guards hold.
select lives_ok($$update public.application_statuses set label='Submitted for review' where value='submitted'$$,'an admin renames a status');
select is(public.portal_status_label('submitted'),'Submitted for review','the new label is used at once');
select ok(exists(select 1 from public.status_config_audit where table_name='application_statuses' and row_key='submitted' and after->>'label'='Submitted for review' and changed_by='33000000-0000-0000-0000-000000000002'),'the change is audited with who made it');
select is(jsonb_array_length(public.status_config_history('application_statuses'))>0,true,'the History link reads the audit');
select lives_ok($$update public.application_statuses set label='Submitted' where value='submitted'$$,'and back');
select throws_ok($$update public.application_statuses set is_active=false where value='submitted'$$,'23503',null,'a status in use cannot be deactivated');
select throws_ok($$update public.application_statuses set value='sent' where value='submitted'$$,'22023',null,'a status key cannot change');
select throws_ok($$update public.application_status_transitions set is_primary=true where from_status='submitted' and action_key='reject'$$,'23505',null,'one primary action per status');
select throws_ok($$update public.application_status_transitions set is_active=false where from_status='offer_issued' and action_key='accept_offer'$$,'42501',null,'automatic moves are locked');
select lives_ok($$update public.application_status_transitions set is_active=false where from_status='submitted' and action_key='action_required'$$,'an admin turns a transition off');
select throws_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e3','action_required','{}')$$,'22023',null,'a transition that is off is refused');
select lives_ok($$update public.application_status_transitions set is_active=true where from_status='submitted' and action_key='action_required'$$,'and on again');
select lives_ok($$insert into public.status_reasons(status,label,sort) values ('rejected','Late application',60)$$,'an admin adds a reason');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select ok(not ('Admin' = any(public.application_caller_roles())) and 'agent' = any(public.application_caller_roles()),'an agent''s role is agent');
select throws_ok($$select public.change_application_status('43000000-0000-0000-0000-0000000000e3','reject',jsonb_build_object('reason_id',(select id from public.status_reasons where status='rejected' and label='Course or intake full')))$$,'42501',null,'an agent''s role is not allowed to reject');
select throws_ok($$insert into public.status_reasons(status,label) values ('rejected','Agent reason')$$,'42501',null,'an agent cannot add a reason');
select is((select count(*)::int from (select 1 from public.application_statuses) x),10,'an agent reads the statuses');
update public.application_statuses set label='Hacked' where value='draft';
select is(public.portal_status_label('draft'),'Draft','an agent''s update changes nothing');
select is((select count(*)::int from public.status_config_audit),0,'an agent cannot read the audit');
reset role;
-- Migration 92 (P08-05): per-event recipients, non-user deliveries, event naming, validation, permissions.
reset role;
delete from public.notification_activation where tenant_id is null;
update public.portal_profiles set email='status-agent@example.test' where id='23000000-0000-0000-0000-000000000030';
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status,data,student_email) values
 ('43000000-0000-0000-0000-000000000040','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}',''),
 ('43000000-0000-0000-0000-000000000041','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}',''),
 ('43000000-0000-0000-0000-000000000042','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','offer_accepted','{}','Student@Example.test'),
 ('43000000-0000-0000-0000-000000000043','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}',''),
 ('43000000-0000-0000-0000-000000000044','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}',''),
 ('43000000-0000-0000-0000-000000000045','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}',''),
 ('43000000-0000-0000-0000-000000000046','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}',''),
 ('43000000-0000-0000-0000-000000000047','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','offer_issued','{}',''),
 ('43000000-0000-0000-0000-000000000048','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','offer_accepted','{}',''),
 ('43000000-0000-0000-0000-000000000049','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}','');
-- Before activation: the agent's copy is created but suppressed (migration 84 rule, unchanged).
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000040',null,'offer_accepted','{"from":"submitted","to":"offer_accepted"}');
select is((select string_agg(recipient_email||':'||state||':'||coalesce(state_reason,''),',') from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000040'),'status-agent@example.test:suppressed:legacy_scope_not_activated','offer_accepted defaults to the assigned agent only; not activated stays suppressed');
insert into public.notification_activation(tenant_id,note) values (null,'p08-05 test activation');
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000041',null,'offer_accepted','{"from":"submitted","to":"offer_accepted"}');
select is((select string_agg(recipient_email||':'||state,',') from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000041'),'status-agent@example.test:pending','after activation the agent copy is pending');
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000042',null,'coe_voe_issued','{"from":"offer_accepted","to":"coe_issued"}');
select is((select string_agg(recipient_email||':'||(recipient_user is null)::text,',' order by recipient_email) from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000042'),'status-agent@example.test:false,student@example.test:true','coe_voe_issued goes to the agent and to the student (a recipient without a portal account, lower-cased)');
select ok((select bool_and(subject like '%CoE / VoE issued%') from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000042'),'the CoE / VoE template is used');
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000043',null,'application_submitted','{"reference":"X"}');
select is((select string_agg(recipient_email,',' order by recipient_email) from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000043'),'agency-admin-a2@example.test,status-agent@example.test','application_submitted keeps its default recipients: assigned agent and agency admins');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select throws_ok($$select public.notification_save_legacy_event('application_submitted','{"recipients":["x@example.test"]}')$$,'42501',null,'an agent cannot change event recipients');
select throws_ok($$select public.notification_event_settings_state(null)$$,'42501',null,'an agent cannot read the recipient settings');
select lives_ok($$select public.portal_set_notification_preference('coe_voe_issued',false)$$,'users can opt out of the new events');
select throws_ok($$select public.portal_set_notification_preference('bogus',false)$$,'22023',null,'unknown preference events are refused');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.notification_save_legacy_event('application_submitted','{"recipients":["a@example.test","A@example.test"]}')$$,'22023',null,'duplicate recipients (case-insensitive) are rejected');
select throws_ok($$select public.notification_save_legacy_event('application_submitted','{"recipients":["not-an-email"]}')$$,'22023',null,'an invalid recipient address is rejected');
select throws_ok($$select public.notification_save_legacy_event('application_submitted',(select jsonb_build_object('recipients',jsonb_agg('r'||g||'@example.test')) from generate_series(1,21) g))$$,'22023',null,'more than 20 recipients are rejected');
select throws_ok($$select public.notification_save_legacy_event('application_submitted','{"notifyAgent":"yes"}')$$,'22023',null,'toggles must be booleans');
select throws_ok($$select public.notification_save_legacy_event('application_submitted','{"notifyEveryone":true}')$$,'22023',null,'unknown settings are rejected');
select throws_ok($$select public.notification_save_legacy_event('bogus','{}')$$,'22023',null,'unknown events are rejected');
select lives_ok($$select public.notification_save_legacy_event('application_submitted','{"recipients":["  IT-Admin@Example.test "],"notifyAgent":false,"notifyAgencyAdmins":false}')$$,'a SLIT admin saves internal recipients for the legacy scope');
select is((public.notification_event_settings_state(null)->'events'->'application_submitted'->'recipients')::text,'["it-admin@example.test"]','recipients are stored trimmed and lower-cased');
reset role;
select is((select count(*)::int from public.tenant_access_audit where tenant_id is null and action='notification_event_settings' and details::text not like '%@%'),1,'the change is audited without recipient addresses');
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000044',null,'application_submitted','{"reference":"Y"}');
select is((select string_agg(recipient_email||':'||(recipient_user is null)::text||':'||state,',') from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000044'),'it-admin@example.test:true:pending','with the agent toggles off only the internal recipient is emailed, without a portal account');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select lives_ok($$select public.notification_save_legacy_event('offer_accepted','{"recipients":["status-agent@example.test"]}')$$,'an internal address may equal the agent address');
reset role;
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000045',null,'offer_accepted','{"from":"submitted","to":"offer_accepted"}');
select is(pg_temp.q($q$select count(*) from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000045'$q$)::int,1,'a person already receiving a copy is not emailed twice');
insert into public.notification_preferences(auth_user_id,event,email_enabled) values ('33000000-0000-0000-0000-000000000030','offer_accepted',false);
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000046',null,'offer_accepted','{"from":"submitted","to":"offer_accepted"}');
select is((select string_agg(state||':'||coalesce(state_reason,''),',') from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000046'),'suppressed:recipient_opted_out','a recipient opt-out still suppresses the delivery');
insert into public.enrollment_offer_letters(application_id, source, file_name, size_bytes, sha256, content, recipient_kind, recipient_email) values ('43000000-0000-0000-0000-000000000047', 'upload', 'LOO.pdf', 5, 'x', convert_to('%PDF-', 'UTF8'), 'agent', 'status-agent@example.test');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select lives_ok($$select public.portal_offer_accept('43000000-0000-0000-0000-000000000047')$$,'the system path: the recipient accepts, offer_issued -> offer_accepted');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000048','coe_issued')$$,'status command: offer_accepted -> coe_issued');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000049','action_required','Please correct the passport')$$,'status command: submitted -> action_required');
reset role;
select is((select string_agg(application_id::text,'|' order by application_id)||'='||string_agg(event,'|' order by application_id) from public.admission_event_outbox where application_id in ('43000000-0000-0000-0000-000000000047','43000000-0000-0000-0000-000000000048','43000000-0000-0000-0000-000000000049')),'43000000-0000-0000-0000-000000000047|43000000-0000-0000-0000-000000000048|43000000-0000-0000-0000-000000000049=offer_accepted|coe_voe_issued|application_status_changed','the event is named after the target status');
select lives_ok($$select public.tenant_config_validate('notifications','{"events":{"offer_accepted":{"recipients":["ops@example.test"],"notifyAgent":true,"notifyStudent":false}}}')$$,'tenant configuration accepts per-event settings');
select throws_ok($$select public.tenant_config_validate('notifications','{"events":{"nope":{}}}')$$,'22023',null,'tenant configuration rejects an unknown event');
select throws_ok($$select public.tenant_config_validate('notifications','{"events":{"offer_accepted":{"recipients":["bad"]}}}')$$,'22023',null,'tenant configuration rejects an invalid recipient');
select throws_ok($$select public.tenant_config_validate('notifications','{"events":{"offer_accepted":{"notifyStudent":"no"}}}')$$,'22023',null,'tenant configuration rejects a non-boolean toggle');
select is((select count(*)::int from jsonb_object_keys(public.tenant_config_defaults('notifications')->'templates')),6,'the default templates cover all six events (with the offer letter and the reminder)');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000020';
select lives_ok($$select public.tenant_config_save_draft('1b000000-0000-0000-0000-000000000001','notifications','{"events":{"coe_voe_issued":{"recipients":["tenant-ops@example.test"],"notifyStudent":false}}}'::jsonb,0)$$,'a tenant administrator saves a draft with event settings');
select is(public.tenant_config_publish('1b000000-0000-0000-0000-000000000001','notifications',0),1,'and publishes it (versioned and audited)');
select is((public.notification_event_settings_state('1b000000-0000-0000-0000-000000000001')->'events'->'coe_voe_issued')::jsonb,'{"recipients":["tenant-ops@example.test"],"notifyAgent":true,"notifyAgencyAdmins":false,"notifyStudent":false}'::jsonb,'the tenant settings overlay the defaults for that event only');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000011';
select throws_ok($$select public.notification_event_settings_state('1b000000-0000-0000-0000-000000000001')$$,'42501',null,'an agency admin cannot read another organization recipient settings');
select throws_ok($$select public.tenant_config_save_draft('1b000000-0000-0000-0000-000000000001','notifications','{"events":{}}'::jsonb,1)$$,'42501',null,'and cannot change them');
reset role;
set local role service_role;
select is(public.notification_event_settings('1b000000-0000-0000-0000-000000000002','coe_voe_issued'),'{"recipients":[],"notifyAgent":true,"notifyAgencyAdmins":false,"notifyStudent":true}'::jsonb,'another organization still resolves its own defaults, never a neighbour''s recipients');
reset role;
-- Migration 93 (P08-06): submission PDF option and the lease-checked snapshot read.
reset role;
update public.notification_deliveries set state='suppressed', state_reason='test isolation' where state='pending';
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status,data,student_email) values
 ('43000000-0000-0000-0000-000000000050','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}',''),
 ('43000000-0000-0000-0000-000000000051','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','coe_issued','{}','student2@example.test');
insert into public.enrollment_application_versions(application_id,version,snapshot,created_by_name) values
 ('43000000-0000-0000-0000-000000000050',1,'{"values":{"first_name":"Ada","passport_copy":"x"},"courses":[{"title":"Cert IV","code":"C4"}],"submission":{"consent":{"method":"electronic","declarationVersion":"1.0"}}}','tester');
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000050',null,'application_submitted','{"version":1}');
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000051',null,'coe_voe_issued','{"from":"offer_accepted","to":"coe_issued"}');
select set_config('p0806.d1',(select id::text from public.notification_claim_delivery()),true);
select set_config('p0806.l1',(select lease_token::text from public.notification_deliveries where id=current_setting('p0806.d1')::uuid),true);
select set_config('p0806.d2',(select id::text from public.notification_claim_delivery()),true);
select set_config('p0806.l2',(select lease_token::text from public.notification_deliveries where id=current_setting('p0806.d2')::uuid),true);
set local role service_role;
select is(public.notification_delivery_submission(current_setting('p0806.d1')::uuid,current_setting('p0806.l1')::uuid)->>'mode','attach','the default is to attach the PDF; the claimed submitted delivery releases its snapshot');
select is(public.notification_delivery_submission(current_setting('p0806.d1')::uuid,current_setting('p0806.l1')::uuid)#>>'{snapshot,values,first_name}','Ada','the snapshot is the immutable submitted version');
select is(public.notification_delivery_submission(current_setting('p0806.d1')::uuid,gen_random_uuid()),null,'a wrong lease releases nothing');
select is(public.notification_delivery_submission(current_setting('p0806.d2')::uuid,current_setting('p0806.l2')::uuid),null,'only application_submitted deliveries get a submission');
reset role;
select is(pg_temp.q($q$select count(*) from public.notification_deliveries where subject||body like '%Ada%'$q$)::int,0,'delivery rows never contain form content');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.notification_delivery_submission(current_setting('p0806.d1')::uuid,current_setting('p0806.l1')::uuid)$$,'42501',null,'signed-in users cannot read a submission snapshot');
select throws_ok($$select public.notification_save_attachment_mode(null,'zip')$$,'22023',null,'only attach or link are accepted');
select lives_ok($$select public.notification_save_attachment_mode(null,'link')$$,'a SLIT admin switches the legacy scope to a secure link');
select is(public.notification_attachment_state(null)->>'submissionPdf','link','the option is stored');
reset role;
set local role service_role;
select ok((select (r->>'link') = 'https://slit.edu.au/' || case when r->>'recipientKind' = 'portal' then 'agency' else 'admin' end || '/applications/43000000-0000-0000-0000-000000000050' and (r->'snapshot') = 'null'::jsonb
  from public.notification_delivery_submission(current_setting('p0806.d1')::uuid,current_setting('p0806.l1')::uuid) r),'link mode returns the sign-in-protected link of the recipient''s own site (portal or CMS) and no snapshot');
reset role;
update public.notification_deliveries set state='sent' where id=current_setting('p0806.d1')::uuid;
set local role service_role;
select is(public.notification_delivery_submission(current_setting('p0806.d1')::uuid,current_setting('p0806.l1')::uuid),null,'a delivery that is no longer being sent releases nothing');
reset role;
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select throws_ok($$select public.notification_save_attachment_mode(null,'attach')$$,'42501',null,'an agent cannot change the option');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000020';
select is(public.notification_attachment_state('1b000000-0000-0000-0000-000000000001')->>'submissionPdf','attach','an organization defaults to attaching the PDF');
select lives_ok($$select public.notification_save_attachment_mode('1b000000-0000-0000-0000-000000000001','link')$$,'an organization administrator changes their own option');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000011';
select throws_ok($$select public.notification_save_attachment_mode('1b000000-0000-0000-0000-000000000001','attach')$$,'42501',null,'an agency admin cannot change another organization option');
reset role;
select is((select count(*)::int from public.tenant_access_audit where action='notification_attachment_mode' and details::text not like '%@%'),2,'both changes are audited without personal data');
-- Migration 94 (P08-07): CoE / VoE issue flow, relaxed verification, invalid_recipient visibility.
reset role;
delete from public.notification_preferences where auth_user_id='33000000-0000-0000-0000-000000000030';
insert into auth.users(id,email) values ('33000000-0000-0000-0000-000000000031','blank-email-agent@example.test');
insert into public.portal_profiles(id,auth_user_id,full_name,email) values ('23000000-0000-0000-0000-000000000031','33000000-0000-0000-0000-000000000031','Blank email agent','');
insert into public.agency_memberships(user_id,agency_id,role) values ('23000000-0000-0000-0000-000000000031','13000000-0000-0000-0000-000000000001','agent');
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,status,data,student_email) values
 ('43000000-0000-0000-0000-000000000060','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','offer_accepted','{}','student3@example.test'),
 ('43000000-0000-0000-0000-000000000061','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','offer_accepted','{}','student4@example.test'),
 ('43000000-0000-0000-0000-000000000062','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}','student5@example.test'),
 ('43000000-0000-0000-0000-000000000063','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','coe_issued','{}','not-an-email'),
 ('43000000-0000-0000-0000-000000000064','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000031','offer_accepted','{}','');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select set_config('p0807.r1',public.portal_registration_create('43000000-0000-0000-0000-000000000060')::text,true);
select set_config('p0807.r2',public.portal_registration_create('43000000-0000-0000-0000-000000000061')::text,true);
select lives_ok($$select public.portal_registration_add_evidence(current_setting('p0807.r1')::uuid,'external_confirmation','Registered in the external system')$$,'evidence for the first registration');
select lives_ok($$select public.portal_registration_transition(current_setting('p0807.r1')::uuid,'lodged')$$,'lodged while the application reads offer_accepted');
select lives_ok($$select public.portal_registration_transition(current_setting('p0807.r1')::uuid,'verified','E0000000060')$$,'a registration can be verified while the offer is merely accepted');
select lives_ok($$select public.portal_registration_transition(current_setting('p0807.r2')::uuid,'lodged')$$,'the second registration is only lodged');
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r2')::uuid,'coe','coe.pdf',encode(convert_to(E'%PDF-1.4\n%%EOF\n','LATIN1'),'base64'))$$,'22023',null,'upload needs a verified registration');
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'zip','coe.pdf',encode(convert_to(E'%PDF-1.4\n%%EOF\n','LATIN1'),'base64'))$$,'22023',null,'the type must be CoE or VoE');
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'coe','coe.pdf',encode(convert_to('hello world, not a pdf','LATIN1'),'base64'))$$,'22023',null,'only PDF content is accepted');
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'coe','coe.pdf',encode(convert_to(E'%PDF-1.4\ntruncated','LATIN1'),'base64'))$$,'22023',null,'a PDF without an end-of-file marker is refused');
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'coe','coe.pdf','@@@not base64@@@')$$,'22023',null,'unreadable content is refused');
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'coe','../coe.pdf',encode(convert_to(E'%PDF-1.4\n%%EOF\n','LATIN1'),'base64'))$$,'22023',null,'a path-like file name is refused');
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'coe','coe.pdf',repeat('A',4300001))$$,'22023',null,'an oversize upload is refused');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'coe','coe.pdf',encode(convert_to(E'%PDF-1.4\n%%EOF\n','LATIN1'),'base64'))$$,'42501',null,'an agent cannot upload a CoE / VoE');
select throws_ok($$select public.portal_coe_voe_issue('43000000-0000-0000-0000-000000000060')$$,'42501',null,'an agent cannot issue');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.portal_coe_voe_issue('43000000-0000-0000-0000-000000000060')$$,'22023',null,'issuing needs an uploaded PDF');
select lives_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'coe','coe-first.pdf',encode(convert_to(E'%PDF-1.4\nfirst\n%%EOF\n','LATIN1'),'base64'))$$,'a reviewer uploads the CoE PDF');
select lives_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'voe','voe-second.pdf',encode(convert_to(E'%PDF-1.4\nsecond\n%%EOF\n','LATIN1'),'base64'))$$,'a new upload supersedes the earlier one before issue');
select is(public.portal_coe_document_list('43000000-0000-0000-0000-000000000060')->>'kind','voe','only the latest upload is current');
select is(convert_from(decode(public.portal_coe_document_content('43000000-0000-0000-0000-000000000060')->>'contentBase64','base64'),'LATIN1'),E'%PDF-1.4\nsecond\n%%EOF\n','a reviewer can read back exactly what was uploaded');
select throws_ok($$select count(*) from public.enrollment_coe_documents$$,'42501',null,'browser roles have no direct access to the stored documents');
select throws_ok($$select public.portal_coe_voe_issue('43000000-0000-0000-0000-000000000061')$$,'22023',null,'issuing needs a verified registration');
select throws_ok($$select public.portal_coe_voe_issue('43000000-0000-0000-0000-000000000062')$$,'22023',null,'issuing needs the offer to be accepted');
reset role;
update public.notification_deliveries set state='suppressed', state_reason='test isolation' where state='pending';
select is((select count(*)::int from public.enrollment_coe_documents where application_id='43000000-0000-0000-0000-000000000060' and superseded_at is not null),1,'the earlier upload is kept as superseded, never deleted');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select lives_ok($$select public.portal_coe_voe_issue('43000000-0000-0000-0000-000000000060','Approved by the registrar')$$,'Approve and issue');
reset role;
select is((select status from public.enrollment_applications where id='43000000-0000-0000-0000-000000000060'),'coe_issued','the application moved to coe_issued');
select is(pg_temp.q($q$select count(*) from public.admission_event_outbox where application_id='43000000-0000-0000-0000-000000000060' and event='coe_voe_issued'$q$)::int,1,'exactly one coe_voe_issued event was produced');
select is((select string_agg(recipient_email||':'||state,',' order by recipient_email) from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000060'),'status-agent@example.test:pending,student3@example.test:pending','the agent and the student are the recipients');
select ok((select issued_at is not null and issued_by is not null from public.enrollment_coe_documents where application_id='43000000-0000-0000-0000-000000000060' and superseded_at is null),'the document is marked issued');
select is((select string_agg(action||':'||(detail->>'kind'),',' order by action,created_at) from public.portal_audit_log where application_id='43000000-0000-0000-0000-000000000060' and action like 'coe_voe_%'),'coe_voe_issue:voe,coe_voe_upload:coe,coe_voe_upload:voe','uploads and the issue are audited, without file content');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.portal_coe_voe_issue('43000000-0000-0000-0000-000000000060')$$,'22023',null,'it cannot be issued twice');
select throws_ok($$select public.portal_coe_document_upload(current_setting('p0807.r1')::uuid,'coe','again.pdf',encode(convert_to(E'%PDF-1.4\n%%EOF\n','LATIN1'),'base64'))$$,'22023',null,'nothing can be uploaded after issue');
reset role;
select throws_ok($$update public.enrollment_coe_documents set content='\x00' where application_id='43000000-0000-0000-0000-000000000060'$$,'42501',null,'an issued document is immutable');
select throws_ok($$delete from public.enrollment_coe_documents where application_id='43000000-0000-0000-0000-000000000060'$$,'42501',null,'and is never deleted');
select set_config('p0807.d1',(select id::text from public.notification_claim_delivery()),true);
select set_config('p0807.l1',(select lease_token::text from public.notification_deliveries where id=current_setting('p0807.d1')::uuid),true);
set local role service_role;
select is(convert_from(decode(public.notification_delivery_coe_document(current_setting('p0807.d1')::uuid,current_setting('p0807.l1')::uuid)->>'contentBase64','base64'),'LATIN1'),E'%PDF-1.4\nsecond\n%%EOF\n','the worker gets the issued document for a claimed coe_voe_issued delivery');
select is(public.notification_delivery_coe_document(current_setting('p0807.d1')::uuid,gen_random_uuid()),null,'a wrong lease gets nothing');
reset role;
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000063',null,'coe_voe_issued','{"from":"offer_accepted","to":"coe_issued"}');
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000064',null,'offer_accepted','{"from":"submitted","to":"offer_accepted"}');
select is((select string_agg(state||':'||state_reason,',') from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000063' and recipient_user is null),'suppressed:invalid_recipient','a malformed student address becomes a visible suppressed delivery');
select is((select string_agg(state||':'||state_reason,',') from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000064'),'suppressed:invalid_recipient','a recipient user without an address becomes a visible suppressed delivery');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select ok(jsonb_array_length(public.notification_invalid_recipients(null))>=2 and public.notification_invalid_recipients(null)::text not like '%not-an-email%','administrators see them, masked');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select throws_ok($$select public.notification_invalid_recipients(null)$$,'42501',null,'an agent cannot list them');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000020';
select is(public.notification_invalid_recipients('1b000000-0000-0000-0000-000000000001'),'[]'::jsonb,'another organization sees none of the legacy scope deliveries');
reset role;
-- Agency detail isolation: one agency's agents and applications never appear under another agency.
insert into public.agencies(id,name,code) values ('1c000000-0000-0000-0000-00000000000a','Isolation A','ISO-A'),('1c000000-0000-0000-0000-00000000000b','Isolation B','ISO-B');
insert into public.portal_profiles(id,auth_user_id,full_name,email) values
 ('2c000000-0000-0000-0000-00000000000a','3c000000-0000-0000-0000-00000000000a','Agent A1','a1@example.test'),
 ('2c000000-0000-0000-0000-00000000000b','3c000000-0000-0000-0000-00000000000b','Agent B1','b1@example.test');
insert into public.agency_memberships(user_id,agency_id,role) values
 ('2c000000-0000-0000-0000-00000000000a','1c000000-0000-0000-0000-00000000000a','agent'),
 ('2c000000-0000-0000-0000-00000000000b','1c000000-0000-0000-0000-00000000000b','agent');
insert into public.enrollment_applications(id,agency_id,assigned_agent_id,data,status) values
 ('4c000000-0000-0000-0000-00000000000a','1c000000-0000-0000-0000-00000000000a','2c000000-0000-0000-0000-00000000000a','{}','draft'),
 ('4c000000-0000-0000-0000-00000000000b','1c000000-0000-0000-0000-00000000000b','2c000000-0000-0000-0000-00000000000b','{}','draft');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select is((select array_agg(user_id::text) from public.agency_memberships where agency_id='1c000000-0000-0000-0000-00000000000a'),array['2c000000-0000-0000-0000-00000000000a'],'agency A lists only its own agents');
select is((select array_agg(user_id::text) from public.agency_memberships where agency_id='1c000000-0000-0000-0000-00000000000b'),array['2c000000-0000-0000-0000-00000000000b'],'agency B lists only its own agents');
select is((select array_agg(r->>'id') from jsonb_array_elements(public.portal_query_applications('','','1c000000-0000-0000-0000-00000000000a',null,'','','updated','desc',25,0)->'rows') r),array['4c000000-0000-0000-0000-00000000000a'],'agency A lists only its own applications');
select is((public.portal_query_applications('','','1c000000-0000-0000-0000-00000000000b',null,'','','updated','desc',25,0)->>'total')::int,1,'agency B count covers only its own applications');
-- Migration 118: student sign-in. A student is invited from their record, accepts, sees only their own applications and starts their own.
-- The inviting agency admin is Admin A2 (auth 33…0014): Admin A stepped down (Inactive) in the member-management block above.
reset role;
insert into public.enrollment_students(id,agency_id,full_name,email,status) values
 ('73000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','Stu Dent','stu.dent@example.test','Active'),
 ('73000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000002','Other Stu','other.stu@example.test','Active'),
 ('73000000-0000-0000-0000-000000000003','13000000-0000-0000-0000-000000000001','No Mail',null,'Active');
select lives_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000014',null,'stu.dent@example.test','Stu Dent','student','73000000-0000-0000-0000-000000000001')$$,'agency admin invites their student to sign in');
select is((select role||':'||student_id::text from public.agency_invitations where email='stu.dent@example.test'),'student:73000000-0000-0000-0000-000000000001','student invitation carries the role and the student record');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000014',null,'other.stu@example.test','Other Stu','student','73000000-0000-0000-0000-000000000002')$$,'42501',null,'a student of another business cannot be invited');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000014',null,'','No Mail','student','73000000-0000-0000-0000-000000000003')$$,'22023',null,'a student without an email cannot be invited');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000014',null,'x@example.test','X','student')$$,'22023',null,'a student invitation names the student');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000014',null,'x@example.test','X','agent','73000000-0000-0000-0000-000000000001')$$,'22023',null,'an agent invitation names no student');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000014',null,'stu.dent@example.test','Stu Dent','student','73000000-0000-0000-0000-000000000001')$$,'23505',null,'an already-invited student is not invited twice');
select throws_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000014',null,'wrong@example.test','Stu Dent','student','73000000-0000-0000-0000-000000000001')$$,'22023',null,'the invitation goes to the email on the student record');
insert into auth.users(id,email,email_confirmed_at) values ('33000000-0000-0000-0000-000000000077','stu.dent@example.test',now());
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000077';
select is((public.portal_resolve_access()->>'accepted')::boolean,true,'the student accepts their invitation on first sign-in');
select is((select m.role||':'||m.student_id::text from public.agency_memberships m join public.portal_profiles p on p.id=m.user_id where p.auth_user_id='33000000-0000-0000-0000-000000000077'),'student:73000000-0000-0000-0000-000000000001','the membership is a student membership tied to the record');
select is(public.portal_identity()->>'role','student','the student signs in as a student');
select is(public.portal_identity()->>'student_id','73000000-0000-0000-0000-000000000001','identity names the student record');
select lives_ok($$select public.portal_create_student_application('stu-key-1','73000000-0000-0000-0000-000000000001')$$,'the student starts their own application');
reset role;
select ok((select student_id='73000000-0000-0000-0000-000000000001' and assigned_agent_id is null from public.enrollment_applications where client_key='stu-key-1'),'the application belongs to the student and is not assigned to them as an agent');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000077';
select is((select count(*)::int from public.portal_scoped_applications()),1,'the student is scoped to their own application only');
select is(public.portal_can_access_application('43000000-0000-0000-0000-000000000001'),false,'another student''s application in the same business is out of reach');
select throws_ok($$select public.portal_create_student_application('stu-key-2','73000000-0000-0000-0000-000000000003')$$,'42501',null,'a student cannot start another student''s application');
select is((select count(*)::int from public.enrollment_applications),1,'direct reads show the student only their own application');
reset role;
update public.enrollment_students set status='Inactive' where id='73000000-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000077';
select is(public.portal_resolve_access()->>'state','user_suspended','a disabled student is suspended');
select is(public.portal_identity()->>'role',null::text,'a disabled student has no portal role');
reset role;
update public.enrollment_students set status='Active' where id='73000000-0000-0000-0000-000000000001';
select is(public.student_login_state('73000000-0000-0000-0000-000000000001')->>'status','active','the CMS sees the student as able to sign in');
select is(public.student_login_state('73000000-0000-0000-0000-000000000003')->>'status','none','a student never invited has no sign-in');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select is((select r->'login'->>'status' from jsonb_array_elements(public.admin_students_list('stu.dent','',null,null,25,0,'')->'rows') r limit 1),'active','the Students list reports the sign-in state');
reset role;
select lives_ok($$select public.portal_invitation_create('33000000-0000-0000-0000-000000000011',null,'other.stu@example.test','Other Stu','student','73000000-0000-0000-0000-000000000002')$$,'the other business''s admin invites their own student');
select lives_ok($$select public.portal_invitation_resend('33000000-0000-0000-0000-000000000002',(select id from public.agency_invitations where email='other.stu@example.test'))$$,'organization admin resends a student invitation');
-- Migration 119: self-enrolment. A student enrols under a referral code or the direct business and gets the student
-- invitation; an agent registers a pending business, can set a password at once, and waits for SLIT's decision.
reset role;
select ok((select status = 'Active' and is_permanent from public.agencies where is_direct),'the direct business exists and is active');
select lives_ok($$select public.portal_self_register('student','{"firstName":"Self","lastName":"Starter","email":"self.starter@example.test","phone":"+61412345678","dateOfBirth":"2000-01-02","course":"X - Y"}')$$,'a student enrols without a referral code');
select is((select a.is_direct from public.enrollment_students s join public.agencies a on a.id=s.agency_id where s.email='self.starter@example.test'),true,'they go under the direct business');
select is((select role||':'||(student_id is not null)::text from public.agency_invitations where email='self.starter@example.test'),'student:true','they get a student sign-in invitation');
select is((select details->>'course_of_interest' from public.enrollment_students where email='self.starter@example.test'),'X - Y','the course they asked about is kept');
select is((public.portal_self_register('student','{"firstName":"Self","lastName":"Starter","email":"self.starter@example.test","phone":"+61412345678","dateOfBirth":"2000-01-02"}'))->>'invitationId',(select id::text from public.agency_invitations where email='self.starter@example.test'),'enrolling again reuses the record and its invitation');
select is((select count(*)::int from public.enrollment_students where email='self.starter@example.test'),1,'no second student record is created');
select lives_ok($$select public.portal_self_register('student','{"firstName":"Ref","lastName":"Erred","email":"ref.erred@example.test","phone":"+61412345679","dateOfBirth":"1999-05-06","referralCode":"p2-pos-a"}')$$,'a referral code picks the business');
select is((select agency_id from public.enrollment_students where email='ref.erred@example.test'),'13000000-0000-0000-0000-000000000001','the student is under the referred business');
select throws_ok($$select public.portal_self_register('student','{"firstName":"No","lastName":"Code","email":"no.code@example.test","phone":"+61412345680","dateOfBirth":"1999-05-06","referralCode":"NOPE"}')$$,'22023',null,'an unknown referral code is refused');
select throws_ok($$select public.portal_self_register('student','{"firstName":"Dup","lastName":"Mobile","email":"dup.mobile@example.test","phone":"+61 412 345 678","dateOfBirth":"1999-05-06"}')$$,'23505',null,'a mobile already on record is refused');
select throws_ok($$select public.portal_self_register('student','{"firstName":"Staff","lastName":"Mail","email":"positive-admin@example.test","phone":"+61412345681","dateOfBirth":"1999-05-06"}')$$,'23505',null,'an email that already signs in is refused');
select lives_ok($$select public.portal_self_register('agent','{"businessName":"Self Reg Agency","abn":"85165345717","contactName":"Reg Istrar","email":"reg.istrar@example.test","phone":"0398765432"}')$$,'an agent registers their business');
select is((select status||':'||(registration_requested_at is not null)::text||':'||(registration_reviewed_at is null)::text from public.agencies where registration_number='85165345717'),'Inactive:true:true','the business waits inactive and unreviewed');
select is((select role from public.agency_invitations where email='reg.istrar@example.test'),'agency_admin','the registrant is invited as its administrator');
select is((select role||':'||status||':'||(profile_id is null)::text from public.agents where email='reg.istrar@example.test'),'agency_admin:Active:true','the registrant is listed as the business''s agent straight away (Invited until they sign in)');
select throws_ok($$select public.portal_self_register('agent','{"businessName":"Again","abn":"85 165 345 717","contactName":"Some One","email":"some.one@example.test","phone":"0398765432"}')$$,'23505','The ABN you entered already exists in our system. Please contact Skyline to get registered.','the same ABN cannot register twice, and the message says so');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select is((select count(*)::int from jsonb_array_elements(public.admin_registration_list()) r where r->>'abn'='85165345717'),1,'the CMS lists the pending registration');
reset role;
insert into auth.users(id,email,email_confirmed_at) values ('33000000-0000-0000-0000-000000000090','reg.istrar@example.test',now());
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000090';
select is(public.portal_resolve_access()->>'accepted','true','the registrant accepts their invitation before the review');
select is(public.portal_resolve_access()->>'state','pending_review','and is told the review is pending');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select is((public.admin_business_set_status((select id from public.agencies where registration_number='85165345717'),'Active'))->>'reviewed','true','activating the business records the approval');
select is((select registration_decision from public.agencies where registration_number='85165345717'),'approved','the decision is approved');
select is((select count(*)::int from jsonb_array_elements(public.admin_registration_list()) r where r->>'abn'='85165345717'),0,'it leaves the pending list');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000090';
select is(public.portal_resolve_access()->>'state','active','the registrant can now use the portal');
select is(public.portal_identity()->>'role','agency_admin','as its administrator');
reset role;
select lives_ok($$select public.portal_self_register('agent','{"businessName":"Declined Agency","abn":"51824753556","contactName":"De Clined","email":"de.clined@example.test","phone":"0398765433"}')$$,'a second agent registers');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select lives_ok($$select public.admin_business_set_status((select id from public.agencies where registration_number='51824753556'),'Inactive')$$,'deactivating a pending business declines it');
select is((select registration_decision from public.agencies where registration_number='51824753556'),'declined','the decision is declined');
select is((select status from public.agency_invitations where email='de.clined@example.test'),'revoked','and its invitation is revoked');
select is((select status from public.agents where email='de.clined@example.test'),'Inactive','and its agent is no longer invited');
-- Signing up with Google, Facebook or a phone number: the signed-in account completes its details and becomes a student.
reset role;
select is((select count(*)::int from public.agents a join public.portal_profiles p on p.id = a.profile_id where p.auth_user_id = '33000000-0000-0000-0000-000000000077'),0,'a student''s sign-in is never mirrored as an agent');
insert into auth.users(id,email,email_confirmed_at) values ('33000000-0000-0000-0000-000000000040','google.student@example.test',now());
insert into auth.users(id,phone,phone_confirmed_at) values ('33000000-0000-0000-0000-000000000041','61498765432',now());
insert into auth.users(id,email) values ('33000000-0000-0000-0000-000000000042','unconfirmed@example.test');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000040';
select lives_ok($$select public.portal_self_enrol_complete('{"firstName":"Goo","lastName":"Gle","phone":"+61498000001","dateOfBirth":"2001-03-04"}')$$,'a Google sign-up completes its details');
select is(public.portal_identity()->>'role','student','and signs in as a student straight away');
select is((select a.is_direct from public.enrollment_students s join public.agencies a on a.id=s.agency_id where s.email='google.student@example.test'),true,'under the direct business');
select throws_ok($$select public.portal_self_enrol_complete('{"firstName":"Goo","lastName":"Gle","phone":"+61498000001","dateOfBirth":"2001-03-04"}')$$,'23505',null,'it cannot be completed twice');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000041';
select throws_ok($$select public.portal_self_enrol_complete('{"firstName":"Pho","lastName":"Ne","email":"stu.dent@example.test","dateOfBirth":"2001-03-04"}')$$,'23505',null,'a typed email already on record cannot be claimed');
select lives_ok($$select public.portal_self_enrol_complete('{"firstName":"Pho","lastName":"Ne","email":"phone.student@example.test","dateOfBirth":"2001-03-04"}')$$,'a phone sign-up completes with its verified mobile');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000042';
select throws_ok($$select public.portal_self_enrol_complete('{"firstName":"Un","lastName":"Confirmed","phone":"+61498000002","dateOfBirth":"2001-03-04"}')$$,'42501',null,'an account with nothing verified cannot enrol');
-- An agent signs up with Google: their business waits for review with them as its administrator.
reset role;
select ok(public.abn_checksum_ok('85165345717') and not public.abn_checksum_ok('85165345718') and not public.abn_checksum_ok('8516534571'),'the ABN checksum is enforced');
insert into auth.users(id,email,email_confirmed_at) values ('33000000-0000-0000-0000-000000000043','google.agent@example.test',now());
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000043';
select throws_ok($$select public.portal_self_register_agent_complete('{"abn":"85165345718","businessName":"Bad Abn","contactName":"Goo Agent","phone":"0398765400"}')$$,'22023',null,'an invalid ABN is refused');
select lives_ok($$select public.portal_self_register_agent_complete('{"abn":"53004085616","businessName":"Google Agency","contactName":"Goo Agent","phone":"0398765400"}')$$,'a Google sign-up registers its agency');
-- Read as the owner: an inactive business is not visible to its own pending agent (20261104090000).
reset role;
select is((select status||':'||(registration_requested_at is not null)::text from public.agencies where registration_number='53004085616'),'Inactive:true','the business waits for review');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000043';
select is(public.portal_resolve_access()->>'state','pending_review','the agent is told the review is pending');
select throws_ok($$select public.portal_self_register_agent_complete('{"abn":"51824753556","businessName":"Second","contactName":"Goo Agent","phone":"0398765400"}')$$,'23505',null,'one business per account');
-- A Google student gives only a mobile (migration 20261105100000): no date of birth needed.
reset role;
insert into auth.users(id,email,email_confirmed_at) values ('33000000-0000-0000-0000-000000000044','mobile.only@example.test',now());
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000044';
select lives_ok($$select public.portal_self_enrol_complete('{"firstName":"Mob","lastName":"Only","phone":"+61498000044"}')$$,'a Google student needs only their mobile');
select throws_ok($$select public.portal_self_enrol_complete('{"firstName":"Bad","lastName":"Dob","phone":"+61498000045","dateOfBirth":"2025-01-01"}')$$,'23505',null,'once set up, the account cannot enrol again');
-- An approved agent is Active before setting a password; an agent of a business waiting for approval is Invited (20261105130000).
reset role;
insert into public.agents(id,business_id,full_name,email,role,status) values
 ('53000000-0000-0000-0000-000000000090','13000000-0000-0000-0000-000000000001','No Password Yet','no.password@example.test','agent','Active');
insert into public.agencies(id,name,code,status,registration_requested_at) values ('13000000-0000-0000-0000-000000000090','Waiting Co','P2-WAIT','Inactive',now());
insert into public.agents(id,business_id,full_name,email,role,status) values
 ('53000000-0000-0000-0000-000000000091','13000000-0000-0000-0000-000000000090','Waiting Admin','waiting.admin@example.test','agency_admin','Active');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select is((select r->>'status' from jsonb_array_elements(public.admin_business_agents('13000000-0000-0000-0000-000000000001')) r where r->>'email'='no.password@example.test'),'Active','an approved agent without a password yet is Active');
select is((select r->>'status' from jsonb_array_elements(public.admin_business_agents('13000000-0000-0000-0000-000000000090')) r where r->>'email'='waiting.admin@example.test'),'Invited','an agent of a business waiting for approval is Invited');
-- Agent sign-up checks (20261105140000): the ABN first, then the email and phone against agents of other companies.
reset role;
select is(public.portal_abn_registered('85 165 345 717'),true,'a registered ABN is found, spaces or not');
select is(public.portal_abn_registered('33102417032'),false,'a new ABN is not');
select throws_ok($$select public.portal_self_register('agent','{"businessName":"Clash Email","abn":"33102417032","contactName":"Some One","email":"reg.istrar@example.test","phone":"0390000001"}')$$,'23505',
 'The email you entered is already linked to another company. Please enter a different email, since this will be the admin account for your company.','an email already used by another company''s agent is refused, naming the email');
select throws_ok($$select public.portal_self_register('agent','{"businessName":"Clash Phone","abn":"33102417032","contactName":"Some One","email":"fresh.one@example.test","phone":"+61 3 9876 5432"}')$$,'23505',
 'The phone number you entered is already linked to another company. Please enter a different phone number, since this will be the admin account for your company.','a phone already used by another company''s agent is refused, in any spelling');
select throws_ok($$select public.portal_self_register('agent','{"businessName":"Clash Both","abn":"33102417032","contactName":"Some One","email":"reg.istrar@example.test","phone":"03 9876 5432"}')$$,'23505',
 'The email and phone number you entered are already linked to another company. Please enter a different email and phone number, since this will be the admin account for your company.','both matching are named together');
select lives_ok($$select public.portal_self_register('agent','{"businessName":"Clean Agency","abn":"33102417064","contactName":"Clean Contact","email":"clean.contact@example.test","phone":"0390000002"}')$$,'a new ABN with a new email and phone registers');
reset role;

-- ---------------------------------------------------------------- INT-01 course intakes (20261113200000, 20261113210000)
reset role;
insert into public.agencies(id, name, code) values ('13000000-0000-0000-0000-0000000000a1', 'Intake agency', 'INT-AGENCY');
insert into public.portal_profiles(id, auth_user_id, full_name, email) values ('23000000-0000-0000-0000-0000000000a1', '33000000-0000-0000-0000-0000000000a1', 'Intake agent', 'intake.agent@example.test');
insert into public.agency_memberships(user_id, agency_id, role) values ('23000000-0000-0000-0000-0000000000a1', '13000000-0000-0000-0000-0000000000a1', 'agent');
insert into public.cms_courses(id, slug, code, name, status) values ('int-course-a', 'int-course-a', 'INTA1', 'Intake course A', 'Published'), ('int-course-b', 'int-course-b', 'INTB1', 'Intake course B', 'Published');
insert into public.enrollment_students(id, agency_id, full_name, email) values ('73000000-0000-0000-0000-0000000000a1', '13000000-0000-0000-0000-0000000000a1', 'Ina Take', 'ina.take@example.test');
insert into public.enrollment_applications(id, reference, agency_id, assigned_agent_id, status, data, student_id) values
 ('43000000-0000-0000-0000-0000000000a1', 'APP-INT-0001', '13000000-0000-0000-0000-0000000000a1', '23000000-0000-0000-0000-0000000000a1', 'draft', '{}', '73000000-0000-0000-0000-0000000000a1');
create temp table intake_ids(k text primary key, v uuid);
grant select, insert on intake_ids to public;
set local role authenticated;
set local request.jwt.claim.sub = '33000000-0000-0000-0000-0000000000a1';
select throws_ok($$select public.course_intakes_admin('save', 'int-course-a', null, '{"startDate":"2030-01-01"}')$$, '42501', 'Only CMS staff can manage intakes', 'INT-01: an agent cannot manage intakes');
set local request.jwt.claim.sub = '33000000-0000-0000-0000-000000000002';
select is(jsonb_array_length(public.course_intakes_admin('save', 'int-course-a', null, jsonb_build_object('startDate', current_date + 60))), 1, 'INT-01: staff add an intake');
select is(jsonb_array_length(public.course_intakes_admin('save', 'int-course-a', null, jsonb_build_object('startDate', current_date + 20, 'label', 'Early start', 'endDate', current_date + 400))), 2, 'INT-01: with a label and an end date');
select is(jsonb_array_length(public.course_intakes_admin('save', 'int-course-a', null, jsonb_build_object('startDate', current_date - 10))), 3, 'INT-01: a past intake can be recorded');
select is(jsonb_array_length(public.course_intakes_admin('save', 'int-course-a', null, jsonb_build_object('startDate', current_date + 90, 'isActive', false))), 4, 'INT-01: and an inactive one');
select is(jsonb_array_length(public.course_intakes_admin('save', 'int-course-b', null, jsonb_build_object('startDate', current_date + 30))), 1, 'INT-01: another course has its own intakes');
select throws_ok(format($$select public.course_intakes_admin('save', 'int-course-a', null, '{"startDate":"%s"}')$$, current_date + 60), '23505', null, 'INT-01: one intake per course and start date');
select throws_ok(format($$select public.course_intakes_admin('save', 'int-course-a', null, '{"startDate":"%s","endDate":"%s"}')$$, current_date + 61, current_date + 1), '22023', 'The end date is before the start date', 'INT-01: an end date before the start is refused');
select throws_ok($$select public.course_intakes_admin('list', 'no-such-course')$$, 'P0002', 'Course not found', 'INT-01: an unknown course is refused');
reset role;
insert into intake_ids select 'a20', id from public.course_intakes where course_id = 'int-course-a' and start_date = current_date + 20;
insert into intake_ids select 'a60', id from public.course_intakes where course_id = 'int-course-a' and start_date = current_date + 60;
insert into intake_ids select 'past', id from public.course_intakes where course_id = 'int-course-a' and start_date = current_date - 10;
insert into intake_ids select 'off', id from public.course_intakes where course_id = 'int-course-a' and start_date = current_date + 90;
insert into intake_ids select 'b30', id from public.course_intakes where course_id = 'int-course-b';
create function pg_temp.iv(text) returns uuid language sql stable as $$ select v from intake_ids where k = $1 $$;
set local role authenticated;
set local request.jwt.claim.sub = '33000000-0000-0000-0000-0000000000a1';
select is((select string_agg(x->>'name', ',' order by n) from jsonb_array_elements(public.course_intakes_open('int-course-a')) with ordinality as e(x, n)),
 'Early start,' || to_char(current_date + 60, 'FMMonth YYYY'), 'INT-01: the dropdown lists only active intakes that have not started, earliest first');
select is(public.course_intakes_open('int-course-a')->1->>'display', to_char(current_date + 60, 'FMMonth YYYY') || ' (starts ' || to_char(current_date + 60, 'FMDD Mon YYYY') || ')', 'INT-01: the label is made by the database');
select is(public.course_intakes_open('int-course-a')->0->>'display', 'Early start (starts ' || to_char(current_date + 20, 'FMDD Mon YYYY') || ')', 'INT-01: a staff label is used');
select is(jsonb_array_length(public.course_intakes_open('int-course-b')), 1, 'INT-01: each course lists its own intakes');
select is((select count(*)::int from public.course_intakes where course_id in ('int-course-a', 'int-course-b')), 4, 'INT-01: an applicant reads only active intakes of courses they can see (the inactive one is hidden)');
select lives_ok(format($$select public.portal_save_draft_v2('43000000-0000-0000-0000-0000000000a1', 0, '{"values":{"preferred_intake":"Next month please"},"courses":[{"courseId":"int-course-a","code":"INTA1","title":"Intake course A","intakeId":"%s"}]}')$$, pg_temp.iv('a20')),
 'INT-01: a draft saves an open intake of its course');
select throws_ok(format($$select public.portal_save_draft_v2('43000000-0000-0000-0000-0000000000a1', 1, '{"courses":[{"courseId":"int-course-a","code":"INTA1","title":"Intake course A","intakeId":"%s"}]}')$$, pg_temp.iv('b30')),
 '22023', 'This intake is not open for the chosen course. Choose the course again and pick one of its intakes.', 'INT-01: a tampered course / intake pair is refused');
select throws_ok(format($$select public.portal_save_draft_v2('43000000-0000-0000-0000-0000000000a1', 1, '{"courses":[{"courseId":"int-course-a","code":"INTA1","title":"Intake course A","intakeId":"%s"}]}')$$, pg_temp.iv('past')),
 '22023', 'This intake is not open for the chosen course. Choose the course again and pick one of its intakes.', 'INT-01: an intake that has started is refused');
select throws_ok(format($$select public.portal_save_draft_v2('43000000-0000-0000-0000-0000000000a1', 1, '{"courses":[{"courseId":"int-course-a","code":"INTA1","title":"Intake course A","intakeId":"%s"}]}')$$, pg_temp.iv('off')),
 '22023', 'This intake is not open for the chosen course. Choose the course again and pick one of its intakes.', 'INT-01: an inactive intake is refused');
select throws_ok($$select public.portal_save_draft_v2('43000000-0000-0000-0000-0000000000a1', 1, '{"courses":[{"courseId":"int-course-a","code":"INTA1","title":"Intake course A","intakeId":"00000000-0000-4000-8000-000000000000"}]}')$$,
 '22023', 'This intake is not open for the chosen course. Choose the course again and pick one of its intakes.', 'INT-01: an unknown intake is refused');
reset role;
select is((select a.data#>>'{values,preferred_intake}' || '|' || a.intake || '|' || c.intake_id from public.enrollment_applications a join public.enrollment_application_courses c on c.application_id = a.id where a.id = '43000000-0000-0000-0000-0000000000a1'),
 'Early start (starts ' || to_char(current_date + 20, 'FMDD Mon YYYY') || ')|Early start (starts ' || to_char(current_date + 20, 'FMDD Mon YYYY') || ')|' || pg_temp.iv('a20'), 'INT-01: the application records the intake''s own label, not the text the client sent');
select is(public.application_intake_problem('43000000-0000-0000-0000-0000000000a1'), null, 'INT-01: submission accepts an open intake of the course');
select is((hr.sign_subject('student', '73000000-0000-0000-0000-0000000000a1')->'values') - array['current_date', 'student.address', 'student.phone', 'student.date_of_birth', 'student.passport_number', 'student.nationality', 'course.fees', 'course.duration', 'course.cricos', 'student.first_name', 'student.last_name', 'student.email', 'student.full_name', 'agency.name'],
 jsonb_build_object('course.name', 'Intake course A', 'course.code', 'INTA1', 'course.intake', 'Early start', 'course.start_date', to_char(current_date + 20, 'FMDD FMMonth YYYY'), 'course.end_date', to_char(current_date + 400, 'FMDD FMMonth YYYY'),
  'student.id', 'APP-INT-0001', 'agent.name', 'Intake agent'), 'INT-01: [Intake], [Start Date], [Student ID] and [Agent Name] fill from the student''s record');
update public.enrollment_applications set data = jsonb_set(data, '{values,preferred_intake}', '"Hand edited"') where id = '43000000-0000-0000-0000-0000000000a1';
select is(public.application_intake_problem('43000000-0000-0000-0000-0000000000a1'), 'The preferred intake does not match the chosen intake. Choose the intake again.', 'INT-01: a hand-edited intake label is refused at submission');
update public.course_intakes set is_active = false where id = pg_temp.iv('a20');
select is(public.application_intake_problem('43000000-0000-0000-0000-0000000000a1'), 'The chosen intake is not open for this course any more. Choose another intake.', 'INT-01: an intake closed after it was chosen is refused at submission');
update public.course_intakes set is_active = true where id = pg_temp.iv('a20');
set local role authenticated;
set local request.jwt.claim.sub = '33000000-0000-0000-0000-000000000002';
select throws_ok(format($$select public.course_intakes_admin('delete', 'int-course-a', '%s')$$, pg_temp.iv('a20')), '23514', 'This intake is chosen on 1 application(s). Deactivate it instead of deleting it.', 'INT-01: a chosen intake is not deleted');
select throws_ok(format($$select public.course_intakes_admin('save', 'int-course-a', '%s', '{"startDate":"%s"}')$$, pg_temp.iv('a20'), current_date + 21), '23514', null, 'INT-01: a chosen intake keeps its start date');
select lives_ok(format($$select public.course_intakes_admin('save', 'int-course-a', '%s', '{"startDate":"%s","label":"Renamed"}')$$, pg_temp.iv('a20'), current_date + 20), 'INT-01: its label can change');
select is(jsonb_array_length(public.course_intakes_admin('delete', 'int-course-a', pg_temp.iv('off'))), 3, 'INT-01: an unused intake is deleted');
set local request.jwt.claim.sub = '33000000-0000-0000-0000-0000000000a1';
select lives_ok($$select public.portal_save_draft_v2('43000000-0000-0000-0000-0000000000a1', (select draft_version from public.enrollment_applications where id = '43000000-0000-0000-0000-0000000000a1'), '{"courses":[{"courseId":"int-course-a","code":"INTA1","title":"Intake course A"}]}')$$,
 'INT-01: a client without the intake dropdown still saves (release 1)');
reset role;
select is(public.application_intake_problem('43000000-0000-0000-0000-0000000000a1'), 'Choose an intake for the course', 'INT-01: but such an application cannot be submitted once 20261113210000 is released');
select is(has_function_privilege('anon', 'public.course_intakes_open(text)', 'execute') or has_function_privilege('anon', 'public.course_intakes_admin(text, text, uuid, jsonb)', 'execute')
 or has_function_privilege('authenticated', 'public.application_intake_problem(uuid)', 'execute') or has_table_privilege('authenticated', 'public.course_intakes', 'insert'), false, 'INT-01: no anonymous access, no direct writes');
-- Fallback (owner's decision 2026-11-11): a course without open intakes offers the next twelve months, as before.
reset role;
insert into public.cms_courses(id, slug, code, name, status) values ('int-course-c', 'int-course-c', 'INTC1', 'Intake course C', 'Published');
insert into public.enrollment_applications(id, reference, agency_id, assigned_agent_id, status, data, student_id) values
 ('43000000-0000-0000-0000-0000000000a2', 'APP-INT-0002', '13000000-0000-0000-0000-0000000000a1', '23000000-0000-0000-0000-0000000000a1', 'draft', '{}', '73000000-0000-0000-0000-0000000000a1');
set local role authenticated;
set local request.jwt.claim.sub = '33000000-0000-0000-0000-0000000000a1';
select is(jsonb_array_length(public.course_intakes_open('int-course-c')), 12, 'INT-01 fallback: a course without intakes lists twelve start months');
select is(public.course_intakes_open('int-course-c')->0->>'display', to_char(date_trunc('month', public.course_intake_today()::timestamp) + interval '1 month', 'FMMonth YYYY'), '...from next month, labelled by the database');
select is((select bool_and((x->>'fallback')::boolean and x->>'id' is null) from jsonb_array_elements(public.course_intakes_open('int-course-c')) x), true, '...marked as fallback months, with no intake row');
select is((select bool_or((x->>'fallback')::boolean) from jsonb_array_elements(public.course_intakes_open('int-course-a')) x), false, 'INT-01 fallback: a course with real intakes lists only those');
select lives_ok(format($$select public.portal_save_draft_v2('43000000-0000-0000-0000-0000000000a2', 0, '{"values":{"preferred_intake":"%s"},"courses":[{"courseId":"int-course-c","code":"INTC1","title":"Intake course C"}]}')$$, to_char(date_trunc('month', public.course_intake_today()::timestamp) + interval '1 month', 'FMMonth YYYY')),
 'INT-01 fallback: a draft saves a start month for a course without intakes');
reset role;
select is(public.application_intake_problem('43000000-0000-0000-0000-0000000000a2'), null, 'INT-01 fallback: submission accepts a listed month');
update public.enrollment_applications set data = jsonb_set(data, '{values,preferred_intake}', '"Whenever suits"') where id = '43000000-0000-0000-0000-0000000000a2';
select is(public.application_intake_problem('43000000-0000-0000-0000-0000000000a2'), 'Choose one of the listed start months for the course.', 'INT-01 fallback: any other text is refused');
insert into public.course_intakes(course_id, start_date) values ('int-course-c', current_date + 50);
select is(public.application_intake_problem('43000000-0000-0000-0000-0000000000a2'), 'Choose an intake for the course', 'INT-01 fallback: once the course has a real intake, a month alone is refused');
select is((select bool_or((x->>'fallback')::boolean) from jsonb_array_elements(public.course_intakes_open('int-course-c')) x), false, '...and only the real intake is listed');

-- An email is unique WITHIN a role (hosted 20261112042544 email_unique_per_role, 20261112042642 portal_invite_single_login_role;
-- local 20261113230000 find_student_by_email). Same-role duplicates (also by case / spaces) are refused with 23505 + hint
-- email_taken; one person may hold the email as a student, a staff member and an agent. pg_temp.email_err returns
-- 'ok' or '<sqlstate>:<hint>' so the hint the forms map is asserted, not only the code.
reset role;
create function pg_temp.email_err(p_sql text) returns text language plpgsql as $$
declare c text; h text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics c = returned_sqlstate, h = pg_exception_hint;
  return c || ':' || coalesce(h, '');
end $$;
grant execute on function pg_temp.email_err(text) to authenticated, anon;
insert into public.agencies(id, name, code) values
 ('ee000000-0000-0000-0000-0000000000a1', 'Identity X', 'IDX-X'), ('ee000000-0000-0000-0000-0000000000a2', 'Identity Y', 'IDX-Y');
insert into auth.users(id, email, email_confirmed_at) values
 ('ee000000-0000-0000-0000-0000000000b1', 'idx.admin.x@example.test', now()),
 ('ee000000-0000-0000-0000-0000000000b2', 'agent.one@example.test', now()),
 ('ee000000-0000-0000-0000-0000000000b3', 'cms.admin@example.test', now());
insert into public.portal_profiles(id, auth_user_id, full_name, email) values
 ('ee000000-0000-0000-0000-0000000000c1', 'ee000000-0000-0000-0000-0000000000b1', 'Identity admin X', 'idx.admin.x@example.test'),
 ('ee000000-0000-0000-0000-0000000000c2', 'ee000000-0000-0000-0000-0000000000b2', 'Agent One', 'agent.one@example.test');
-- The agent record first: agent_membership_sync links a membership to it (and makes one for the agency admin).
insert into public.agents(id, business_id, profile_id, full_name, email) values
 ('ee000000-0000-0000-0000-0000000000d1', 'ee000000-0000-0000-0000-0000000000a1', 'ee000000-0000-0000-0000-0000000000c2', 'Agent One', 'agent.one@example.test');
insert into public.agency_memberships(user_id, agency_id, role) values
 ('ee000000-0000-0000-0000-0000000000c1', 'ee000000-0000-0000-0000-0000000000a1', 'agency_admin'),
 ('ee000000-0000-0000-0000-0000000000c2', 'ee000000-0000-0000-0000-0000000000a1', 'agent');
insert into public.enrollment_students(id, agency_id, agent_id, full_name, email, phone) values
 ('ee000000-0000-0000-0000-0000000000e1', 'ee000000-0000-0000-0000-0000000000a1', 'ee000000-0000-0000-0000-0000000000d1', 'Stu X', 'stu.x@example.test', '+61400000101'),
 ('ee000000-0000-0000-0000-0000000000e2', 'ee000000-0000-0000-0000-0000000000a2', null, 'Stu Y', 'stu.y@example.test', '+61400000102');
insert into public.cms_users(id, name, email, role, status, auth_user_id) values
 ('idx-cms-admin', 'Identity CMS admin', 'cms.admin@example.test', 'Admin', 'Active', 'ee000000-0000-0000-0000-0000000000b3');
insert into hr.staff_profiles(id, first_name, last_name, email) values ('ee000000-0000-0000-0000-0000000000f1', 'Hr', 'One', 'hr.one@example.test');
-- CMS staff users
select is(pg_temp.email_err($$insert into public.cms_users(id, name, email, role, status) values ('idx-cms-dup', 'Dup', ' CMS.Admin@Example.test ', 'Editor', 'Active')$$), '23505:email_taken', 'identity: a second CMS user with the same email (case and spaces differ) is refused as email_taken');
select is(pg_temp.email_err($$insert into public.cms_users(id, name, email, role, status) values ('idx-cms-agent', 'Agent as staff', 'agent.one@example.test', 'Editor', 'Active')$$), 'ok', 'identity: an agent''s email may also be a CMS user');
select is(pg_temp.email_err($$update public.cms_users set name = 'Renamed' where id = 'idx-cms-admin'$$), 'ok', 'identity: editing a CMS user without changing the email works');
select is(pg_temp.email_err($$insert into public.cms_users(id, name, email, role, status) values ('idx-cms-new', 'New', 'cms.new@example.test', 'Editor', 'Active')$$), 'ok', 'identity: a brand-new CMS user email works');
-- HR staff profiles
select is(pg_temp.email_err($$insert into hr.staff_profiles(first_name, last_name, email) values ('Dup', 'Hr', 'HR.One@example.test ')$$), '23505:email_taken', 'identity: a second HR staff profile with the same email (case and spaces differ) is refused');
select is(pg_temp.email_err($$insert into hr.staff_profiles(first_name, last_name, email) values ('Cms', 'Admin', 'cms.admin@example.test')$$), 'ok', 'identity: a CMS user may also have an HR staff profile');
select is(pg_temp.email_err($$update hr.staff_profiles set first_name = 'Harriet' where id = 'ee000000-0000-0000-0000-0000000000f1'$$), 'ok', 'identity: editing an HR staff profile without changing the email works');
select is(pg_temp.email_err($$insert into hr.staff_profiles(first_name, last_name, email) values ('New', 'Hr', 'hr.new@example.test')$$), 'ok', 'identity: a brand-new HR staff email works');
-- Agents (agent + agency admin = one role)
select is(pg_temp.email_err($$insert into public.agents(business_id, full_name, email) values ('ee000000-0000-0000-0000-0000000000a2', 'Dup', ' Agent.One@Example.test')$$), '23505:email_taken', 'identity: an agent email already used in another agency is refused (case and spaces differ)');
select is(pg_temp.email_err($$insert into public.agents(business_id, full_name, email, role) values ('ee000000-0000-0000-0000-0000000000a1', 'Dup admin', 'agent.one@example.test', 'agency_admin')$$), '23505:email_taken', 'identity: agent and agency admin are one role: a second agent record in the same agency is refused');
select is(pg_temp.email_err($$insert into public.agents(business_id, full_name, email) values ('ee000000-0000-0000-0000-0000000000a2', 'Student as agent', 'stu.y@example.test')$$), 'ok', 'identity: a student''s email may also be an agent');
select is(pg_temp.email_err($$update public.agents set phone = '+61400000999' where id = 'ee000000-0000-0000-0000-0000000000d1'$$), 'ok', 'identity: editing an agent without changing the email works');
select is(pg_temp.email_err($$insert into public.agents(business_id, full_name, email) values ('ee000000-0000-0000-0000-0000000000a1', 'New agent', 'agent.new@example.test')$$), 'ok', 'identity: a brand-new agent email works');
-- Students
select is(pg_temp.email_err($$insert into public.enrollment_students(agency_id, full_name, email, phone) values ('ee000000-0000-0000-0000-0000000000a1', 'Dup', ' STU.Y@example.test', '+61400000103')$$), '23505:email_taken', 'identity: another business''s student email is refused for a new student (case and spaces differ)');
select is(pg_temp.email_err($$insert into public.enrollment_students(id, agency_id, full_name, email, phone) values ('ee000000-0000-0000-0000-0000000000e3', 'ee000000-0000-0000-0000-0000000000a1', 'Agent as student', 'agent.one@example.test', '+61400000104')$$), 'ok', 'identity: an agent''s email may also be a student');
select is(pg_temp.email_err($$update public.enrollment_students set full_name = 'Stu X Renamed' where id = 'ee000000-0000-0000-0000-0000000000e1'$$), 'ok', 'identity: editing a student without changing the email works');
select is(pg_temp.email_err($$update public.enrollment_students set email = 'stu.x@example.test', phone = '+61400000111' where id = 'ee000000-0000-0000-0000-0000000000e1'$$), 'ok', 'identity: saving a student with their own email again works');
select is(pg_temp.email_err($$insert into public.enrollment_students(agency_id, full_name, email, phone) values ('ee000000-0000-0000-0000-0000000000a1', 'New student', 'stu.new@example.test', '+61400000105')$$), 'ok', 'identity: a brand-new student email works');
-- Self-service student profiles
select is(pg_temp.email_err($$insert into public.student_profiles(id, email) values ('ee000000-0000-0000-0000-000000000071', 'sp.one@example.test')$$), 'ok', 'identity: a brand-new student profile email works');
select is(pg_temp.email_err($$insert into public.student_profiles(id, email) values ('ee000000-0000-0000-0000-000000000072', ' SP.One@example.test')$$), '23505:email_taken', 'identity: a second student profile with the same email (case and spaces differ) is refused');
select is(pg_temp.email_err($$insert into public.student_profiles(id, email) values ('ee000000-0000-0000-0000-000000000073', 'agent.new@example.test')$$), 'ok', 'identity: an agent''s email may also be a student profile');
select is(pg_temp.email_err($$update public.student_profiles set email = 'sp.one@example.test' where id = 'ee000000-0000-0000-0000-000000000071'$$), 'ok', 'identity: saving a student profile with its own email works');
-- Live check (CMS admin signed in)
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b3';
select is(public.email_available(' Agent.One@Example.test ', 'agent')->>'available', 'false', 'email_available: an agent email is taken for another agent (case and spaces differ)');
select is(public.email_available('agent.one@example.test', 'agent', 'ee000000-0000-0000-0000-0000000000d1')->>'available', 'true', 'email_available: an agent editing their own record is not flagged');
select is(public.email_available('hr.one@example.test', 'agent')->>'available', 'true', 'email_available: an HR staff email is free for an agent');
select is(public.email_available('hr.one@example.test', 'hr_staff')->>'message', 'This email is already in use. Please use a different email address.', 'email_available: a second HR staff profile is flagged with the field message');
select is(public.email_available('hr.one@example.test', 'staff')->>'available', 'true', 'email_available: a CMS user and an HR profile are separate records');
select is(pg_temp.email_err($$select public.email_available('x@example.test', null)$$), '22023:', 'email_available: the role is required');
set local role anon;
select is(pg_temp.email_err($$select public.email_available('x@example.test', 'agent')$$), '42501:', 'email_available: signed-out callers are refused');
-- Portal invitations
reset role;
select is(pg_temp.email_err($$insert into public.agency_invitations(agency_id, email, role, full_name) values ('ee000000-0000-0000-0000-0000000000a2', 'Agent.One@example.test', 'agent', 'Agent One')$$), '23505:email_taken', 'identity: an agent cannot be invited into a second agency');
select is(pg_temp.email_err($$insert into public.agency_invitations(id, agency_id, email, role, full_name) values ('ee000000-0000-0000-0000-000000000091', 'ee000000-0000-0000-0000-0000000000a1', 'agent.one@example.test', 'agent', 'Agent One')$$), 'ok', 'identity: inviting an agent into their own agency works');
select is(pg_temp.email_err($$update public.agency_invitations set status = 'pending', email = email, sent_count = sent_count + 1, expires_at = now() + interval '7 days' where id = 'ee000000-0000-0000-0000-000000000091'$$), 'ok', 'identity: resending an agent invite to the same person works');
select is(pg_temp.email_err($$insert into public.agency_invitations(agency_id, email, role, full_name, student_id) values ('ee000000-0000-0000-0000-0000000000a1', 'agent.one@example.test', 'student', 'Agent as student', 'ee000000-0000-0000-0000-0000000000e3')$$), '23505:login_role_conflict', 'identity: a student invite to an email that signs in as an agent is refused as login_role_conflict');
select is(pg_temp.email_err($$insert into public.agency_invitations(agency_id, email, role, full_name, student_id) values ('ee000000-0000-0000-0000-0000000000a1', 'stu.y@example.test', 'student', 'Wrong student', 'ee000000-0000-0000-0000-0000000000e1')$$), '23505:email_taken', 'identity: a student invite to another student''s email is refused');
select is(pg_temp.email_err($$insert into public.agency_invitations(id, agency_id, email, role, full_name, student_id) values ('ee000000-0000-0000-0000-000000000092', 'ee000000-0000-0000-0000-0000000000a1', 'stu.x@example.test', 'student', 'Stu X', 'ee000000-0000-0000-0000-0000000000e1')$$), 'ok', 'identity: inviting a student with their own email works');
select is(pg_temp.email_err($$update public.agency_invitations set status = 'pending', email = email, sent_count = sent_count + 1 where id = 'ee000000-0000-0000-0000-000000000092'$$), 'ok', 'identity: resending a student invite to the same student works');
-- Applications: the email step (find_student_by_email, 20261113230000)
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b1';
select is(public.find_student_by_email('stu.x@example.test')->>'status', 'student', 'applications: an agency admin is offered their business''s student for reuse');
select is(public.find_student_by_email(' STU.X@Example.test ')->>'id', 'ee000000-0000-0000-0000-0000000000e1', '...found by a case / spaces variant');
select is(public.find_student_by_email('stu.y@example.test'), '{"status": "taken"}'::jsonb, 'applications: another business''s student is only "taken" (no id, name or business)');
select is(public.find_student_by_email('hr.one@example.test')->>'status', 'free', 'applications: a staff member''s email is free for a new student');
select is(public.find_student_by_email('idx.admin.x@example.test')->>'status', 'free', 'applications: an agent''s login email is free for a new student');
select is(public.find_student_by_email('brand.new@example.test')->>'status', 'free', 'applications: a brand-new email is free');
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b2';
select is(public.find_student_by_email('stu.x@example.test')->>'status', 'student', 'applications: an agent is offered their own student for reuse');
select is(public.find_student_by_email('agent.one@example.test'), '{"status": "taken"}'::jsonb, 'applications: an agent is not offered another agent''s (or an unassigned) student in the business');
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b3';
select is(public.find_student_by_email('stu.y@example.test')->>'status', 'student', 'applications: a SLIT admin is offered any student for reuse');
set local role anon;
select is(pg_temp.email_err($$select public.find_student_by_email('stu.x@example.test')$$), '42501:', 'applications: signed-out callers cannot look up students');
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b1';
select is(pg_temp.email_err($$select public.portal_student_save(null, 'ee000000-0000-0000-0000-0000000000d1', 'Dup', 'stu.y@example.test', '+61400000106')$$), '23505:email_taken', 'applications: a new student with another business''s student email is refused as email_taken');
select is(pg_temp.email_err($$select public.portal_student_save(null, 'ee000000-0000-0000-0000-0000000000d1', 'Again', 'Stu.X@example.test', '+61400000107')$$), '23505:email_taken', 'applications: a second student with an existing student''s email is refused as email_taken');
select is(pg_temp.email_err($$select public.portal_student_save(null, 'ee000000-0000-0000-0000-0000000000d1', 'Staff email student', 'hr.one@example.test', '+61400000108')$$), 'ok', 'applications: a staff member''s email creates a new student');
select is(pg_temp.email_err($$select public.portal_create_student_application('idx-reuse-1', 'ee000000-0000-0000-0000-0000000000e1')$$), 'ok', 'applications: the existing student gets the new application');
reset role;
select is((select count(*)::int from public.enrollment_students where lower(btrim(email)) = 'stu.x@example.test'), 1, 'applications: reuse made no second student');
select is((select count(*)::int from public.enrollment_applications where student_id = 'ee000000-0000-0000-0000-0000000000e1'), 1, '...and the application belongs to that student');
select is(pg_temp.email_err($$update public.enrollment_applications set student_name = 'Stu X', data = jsonb_set(data, '{values,first_name}', '"Stu"') where student_id = 'ee000000-0000-0000-0000-0000000000e1'$$), 'ok', 'applications: editing the draft without changing the email works');
-- 20261113240000: the functions' own duplicate-email refusals carry hint email_taken (a mobile duplicate does not).
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b3';
select is(pg_temp.email_err($$select public.admin_student_update('ee000000-0000-0000-0000-0000000000e1', 'Stu X', 'STU.Y@example.test', '+61400000111', null, '', '', null)$$), '23505:email_taken', 'hints: Edit student to another student''s email is email_taken');
select is(pg_temp.email_err($$select public.admin_student_update('ee000000-0000-0000-0000-0000000000e1', 'Stu X', 'stu.x@example.test', '+61400000102', null, '', '', null)$$), '23505:', 'hints: Edit student to another student''s mobile has no email hint');
select is(pg_temp.email_err($$select public.admin_student_update('ee000000-0000-0000-0000-0000000000e1', 'Stu X Again', 'stu.x@example.test', '+61400000111', null, '', '', null)$$), 'ok', 'hints: Edit student keeping the email works');
select is(pg_temp.email_err($$select public.admin_agent_activate(null, 'ee000000-0000-0000-0000-0000000000a1', 'Second Agent One', 'agent.one@example.test')$$), '23505:email_taken', 'hints: Activate agent with an email already in the business is email_taken');
reset role;
select is(pg_temp.email_err($$select public.portal_invitation_create('ee000000-0000-0000-0000-0000000000b1', null, 'agent.one@example.test', 'Agent One', 'agent')$$), '23505:email_taken', 'hints: a second invitation to a pending invitee is email_taken');
select is(pg_temp.email_err($$select public.portal_invitation_create('ee000000-0000-0000-0000-0000000000b1', null, 'idx.admin.x@example.test', 'Identity admin X', 'agent')$$), '23505:email_taken', 'hints: inviting an email that already signs in to the portal is email_taken');
insert into auth.users(id, phone, phone_confirmed_at) values ('ee000000-0000-0000-0000-0000000000b4', '61400000199', now());
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b4';
select is(pg_temp.email_err($$select public.portal_self_enrol_complete('{"email":"Stu.Y@example.test","firstName":"Phone","lastName":"Person"}')$$), '23505:email_taken', 'hints: Complete profile with another student''s email is email_taken');
-- 20261113250000: the live check knows the agent's own business; the student search hides other people's students.
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b3';
select is(public.email_available('agent.one@example.test', 'agent', 'ee000000-0000-0000-0000-0000000000d1')->>'available', 'true', 'rule fix: an agent''s own pending invite in their own business is not "taken"');
reset role;
insert into public.agency_invitations(agency_id, email, role, full_name) values ('ee000000-0000-0000-0000-0000000000a2', 'pending.y@example.test', 'agent', 'Pending Y');
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b3';
select is(public.email_available('pending.y@example.test', 'agent', 'ee000000-0000-0000-0000-0000000000d1')->>'available', 'false', 'rule fix: a pending agent invite into another business still counts');
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b1';
select is(public.portal_student_find('stu.y@example.test'), '[{"taken": true}]'::jsonb, 'rule fix: another business''s student is only {"taken": true} (no business name)');
select is(public.portal_student_find('stu.x@example.test')->0->>'id', 'ee000000-0000-0000-0000-0000000000e1', 'rule fix: the agency admin still finds their business''s student');
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-0000000000b2';
select is(public.portal_student_find('agent.one@example.test'), '[{"taken": true}]'::jsonb, 'rule fix: an agent does not see an unassigned student of the business');
select is(public.portal_student_find('', '+61400000111')->0->>'name', 'Stu X Again', 'rule fix: an agent finds their own student by mobile');
reset role;

select * from finish();
rollback;
