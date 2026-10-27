-- Positive preservation + direct mutation boundaries, synthetic and rollback-only.
begin;
select plan(215);
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
 ('43000000-0000-0000-0000-000000000037','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','under_review')$$,'22023',null,'"Under review" is no longer a target of the default graph');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','offer_issued')$$,'22023',null,'"Offer issued" is no longer a target of the default graph');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','action_required','Please correct the passport')$$,'submitted -> action_required');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','submitted')$$,'action_required -> submitted');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','action_required','Second correction')$$,'submitted -> action_required again');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','offer_accepted')$$,'action_required -> offer_accepted');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','submitted')$$,'22023',null,'offer_accepted cannot go back to submitted');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','coe_issued')$$,'offer_accepted -> coe_issued');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','enrolled')$$,'coe_issued -> enrolled');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000030','withdrawn')$$,'22023',null,'enrolled is terminal');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000036','withdrawn')$$,'an admin can withdraw a submitted application');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000037','rejected')$$,'an admin can reject a submitted application');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000031','offer_accepted')$$,'a legacy under_review row moves forward to offer_accepted');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000032','submitted')$$,'22023',null,'a legacy under_review row cannot move back to submitted');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000033','offer_accepted')$$,'a legacy offer_issued row moves forward to offer_accepted');
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000034','under_review')$$,'22023',null,'a legacy offer_issued row cannot move back to under_review');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000030';
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000035','submitted')$$,'42501',null,'an agent has no status transition after submission');
select throws_ok($$select public.portal_submit_v2('43000000-0000-0000-0000-000000000035',0,'p0804-resubmit','{}')$$,'PT409',null,'an agent cannot resubmit an action_required application (only drafts are submitted)');
select throws_ok($$update public.enrollment_applications set status='enrolled' where id='43000000-0000-0000-0000-000000000035'$$,'42501',null,'a direct status write by an agent is refused');
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000014';
select throws_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000035','submitted')$$,'42501',null,'an agency admin has no status transition after submission');
reset role;
select is((select count(*)::int from jsonb_array_elements_text(public.tenant_config_defaults('workflow')->'statuses') x where x in ('under_review','offer_issued')),0,'the default workflow no longer lists the removed statuses');
select is((select count(*)::int from jsonb_array_elements(public.tenant_config_defaults('workflow')->'transitions') t where t->>'from' in ('under_review','offer_issued') or t->>'to' in ('under_review','offer_issued')),0,'the default graph has no transition to or from the removed statuses');
select lives_ok($$select public.tenant_config_validate('workflow', public.tenant_config_defaults('workflow'))$$,'the new default workflow passes the existing validator');
select is(public.portal_status_label('coe_issued'),'CoE / VoE issued','coe_issued reads "CoE / VoE issued" in notification text');
select is(public.portal_status_label('action_required'),'action required','other labels keep the sentence form');
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
 ('43000000-0000-0000-0000-000000000047','13000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000030','submitted','{}',''),
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
select throws_ok($$select public.notification_save_legacy_event('application_submitted',(select jsonb_build_object('recipients',jsonb_agg('r'||g||'@example.test')) from generate_series(1,11) g))$$,'22023',null,'more than 10 recipients are rejected');
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
select is((select count(*)::int from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000045'),1,'a person already receiving a copy is not emailed twice');
insert into public.notification_preferences(auth_user_id,event,email_enabled) values ('33000000-0000-0000-0000-000000000030','offer_accepted',false);
insert into public.admission_event_outbox(application_id,tenant_id,event,payload) values ('43000000-0000-0000-0000-000000000046',null,'offer_accepted','{"from":"submitted","to":"offer_accepted"}');
select is((select string_agg(state||':'||coalesce(state_reason,''),',') from public.notification_deliveries where application_id='43000000-0000-0000-0000-000000000046'),'suppressed:recipient_opted_out','a recipient opt-out still suppresses the delivery');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000047','offer_accepted')$$,'status command: submitted -> offer_accepted');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000048','coe_issued')$$,'status command: offer_accepted -> coe_issued');
select lives_ok($$select public.portal_set_application_status('43000000-0000-0000-0000-000000000049','action_required','Please correct the passport')$$,'status command: submitted -> action_required');
reset role;
select is((select string_agg(application_id::text,'|' order by application_id)||'='||string_agg(event,'|' order by application_id) from public.admission_event_outbox where application_id in ('43000000-0000-0000-0000-000000000047','43000000-0000-0000-0000-000000000048','43000000-0000-0000-0000-000000000049')),'43000000-0000-0000-0000-000000000047|43000000-0000-0000-0000-000000000048|43000000-0000-0000-0000-000000000049=offer_accepted|coe_voe_issued|application_status_changed','the event is named after the target status');
select lives_ok($$select public.tenant_config_validate('notifications','{"events":{"offer_accepted":{"recipients":["ops@example.test"],"notifyAgent":true,"notifyStudent":false}}}')$$,'tenant configuration accepts per-event settings');
select throws_ok($$select public.tenant_config_validate('notifications','{"events":{"nope":{}}}')$$,'22023',null,'tenant configuration rejects an unknown event');
select throws_ok($$select public.tenant_config_validate('notifications','{"events":{"offer_accepted":{"recipients":["bad"]}}}')$$,'22023',null,'tenant configuration rejects an invalid recipient');
select throws_ok($$select public.tenant_config_validate('notifications','{"events":{"offer_accepted":{"notifyStudent":"no"}}}')$$,'22023',null,'tenant configuration rejects a non-boolean toggle');
select is((select count(*)::int from jsonb_object_keys(public.tenant_config_defaults('notifications')->'templates')),4,'the default templates cover all four events');
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
select is((select count(*)::int from public.notification_deliveries where subject||body like '%Ada%'),0,'delivery rows never contain form content');
set local role authenticated;
set local request.jwt.claim.sub='33000000-0000-0000-0000-000000000002';
select throws_ok($$select public.notification_delivery_submission(current_setting('p0806.d1')::uuid,current_setting('p0806.l1')::uuid)$$,'42501',null,'signed-in users cannot read a submission snapshot');
select throws_ok($$select public.notification_save_attachment_mode(null,'zip')$$,'22023',null,'only attach or link are accepted');
select lives_ok($$select public.notification_save_attachment_mode(null,'link')$$,'a SLIT admin switches the legacy scope to a secure link');
select is(public.notification_attachment_state(null)->>'submissionPdf','link','the option is stored');
reset role;
set local role service_role;
select ok((public.notification_delivery_submission(current_setting('p0806.d1')::uuid,current_setting('p0806.l1')::uuid)->>'link')='https://slit.edu.au/agency/applications/43000000-0000-0000-0000-000000000050' and (public.notification_delivery_submission(current_setting('p0806.d1')::uuid,current_setting('p0806.l1')::uuid)->'snapshot')='null'::jsonb,'link mode returns the sign-in-protected link and no snapshot');
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
select is((select count(*)::int from public.admission_event_outbox where application_id='43000000-0000-0000-0000-000000000060' and event='coe_voe_issued'),1,'exactly one coe_voe_issued event was produced');
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
select * from finish();
rollback;
