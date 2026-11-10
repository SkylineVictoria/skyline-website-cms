-- Staff onboarding flow, part 3 (owner's decision 2026-11-10): the offer and the person's login go out together, with a one-time
-- set-password link instead of an emailed password. Additive; needs 20261111090000 and 20261111100000.
--
-- How it works
--   Send offer letter   staff-admin makes sure a login exists for the person's email (a new one is unconfirmed and cannot sign in),
--                       then hr_admin_onboarding_offer_send marks the offer sent, links the login to the person and, when the login
--                       has never been set up, records a one-time 'account' link (sha256 only, 7 days). One email carries the link.
--                       If that email fails, hr_admin_onboarding_offer_unsend puts everything back (offer unsent, links revoked,
--                       login unlinked) and the function deletes the login it created.
--   Set password        /staff/welcome#t=...: staff-onboarding checks the link (hr_svc_account_open), sets the password the person
--                       chose and confirms the email with the Auth admin API, then marks the link used (hr_svc_account_done). The
--                       link works once. No password is ever generated, stored or emailed by us.
--   Until Active        the login sees only its own offer and onboarding documents: hr_staff_onboarding_me (own record),
--                       hr_svc_staff_session / hr_svc_staff_document_path (the Edge Function resolves the signed-in user to their
--                       own offer and files). Storage, My HR, timesheets and leave stay closed until the person is Active
--                       (staff_documents_read and hr.require_me already require status = active).
--   Resend login        hr_admin_onboarding_login_resend: a new one-time link (the old one stops working), while no password is set.
--   Activate            unchanged (staff-admin activate): the login is confirmed by then, so the person is Active at once.
--
-- Rollback (manual): drop the functions of this file; re-run hr_admin_onboarding from 20261111090000; 'account' may stay allowed.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table hr.staff_invites drop constraint if exists staff_invites_purpose_check;
alter table hr.staff_invites add constraint staff_invites_purpose_check check (purpose in ('documents', 'reupload', 'offer', 'account'));

-- ------------------------------------------------------------------ helpers
create or replace function hr.random_hash() returns text
language sql volatile set search_path = pg_catalog, pg_temp as $fn$
 select md5(gen_random_uuid()::text || clock_timestamp()::text) || md5(gen_random_uuid()::text);
$fn$;

-- A one-time set-password link for a person: any earlier live document / account link stops working.
create or replace function hr.account_invite_create(p_profile uuid, p_hash text, p_admin uuid) returns hr.staff_invites
language plpgsql security definer set search_path = hr, pg_temp as $fn$
declare i hr.staff_invites;
begin
 if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid link hash.' using errcode = '22023'; end if;
 update hr.staff_invites set superseded_at = now()
  where profile_id = p_profile and purpose <> 'offer' and revoked_at is null and superseded_at is null and used_at is null;
 insert into hr.staff_invites(profile_id, purpose, token_hash, created_by, expires_at) values (p_profile, 'account', p_hash, p_admin, now() + interval '7 days') returning * into i;
 return i;
end $fn$;

-- The login state of a person, as the admin sees it.
create or replace function hr.onboarding_account_json(p_profile uuid) returns jsonb
language sql stable security definer set search_path = hr, auth, pg_temp as $fn$
 select jsonb_build_object('hasLogin', p.auth_user_id is not null, 'passwordSet', u.email_confirmed_at is not null, 'lastSignInAt', u.last_sign_in_at,
  'link', (select jsonb_build_object('sentAt', i.created_at, 'expiresAt', i.expires_at, 'usedAt', i.used_at,
     'state', case when i.used_at is not null then 'used' when i.revoked_at is not null then 'revoked' when i.superseded_at is not null then 'replaced'
      when i.expires_at <= now() then 'expired' else 'live' end)
    from hr.staff_invites i where i.profile_id = p.id and i.purpose = 'account' order by i.created_at desc limit 1))
 from hr.staff_profiles p left join auth.users u on u.id = p.auth_user_id where p.id = p_profile;
$fn$;
revoke all on function hr.random_hash(), hr.account_invite_create(uuid, text, uuid), hr.onboarding_account_json(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ admin: send the offer with the login
-- p_auth_user_id: the login for the person's email (found or just created by staff-admin). p_account_hash: sha256 of the
-- set-password token, required when that login has never been set up.
create or replace function public.hr_admin_onboarding_offer_send(p_id uuid, p_auth_user_id uuid, p_account_hash text default null) returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; u auth.users; i hr.staff_invites; r jsonb; v_first boolean; v_needs boolean;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('documents_submitted', 'offer_sent') then raise exception 'An offer can be sent after the documents are submitted.' using errcode = '23514'; end if;
 v_first := p.status = 'documents_submitted';
 if p_auth_user_id is null then raise exception 'A login is needed before the offer can be sent.' using errcode = '22023'; end if;
 if p_auth_user_id = v_admin then raise exception 'You cannot send yourself an offer.' using errcode = '42501'; end if;
 select * into u from auth.users where id = p_auth_user_id;
 if not found or lower(btrim(coalesce(u.email, ''))) <> p.email then raise exception 'That login does not belong to this person.' using errcode = '42501'; end if;
 if p.auth_user_id is not null and p.auth_user_id <> p_auth_user_id then raise exception 'This person is already linked to a different login.' using errcode = '23505'; end if;
 if exists (select 1 from hr.staff_profiles s where s.auth_user_id = p_auth_user_id and s.id <> p.id) then raise exception 'That login already belongs to another staff member.' using errcode = '23505'; end if;
 v_needs := u.email_confirmed_at is null;
 if v_needs and (p_account_hash is null or p_account_hash !~ '^[0-9a-f]{64}$') then raise exception 'A sign-in link is needed for this person.' using errcode = '22023'; end if;
 -- The offer itself: same rules as before (an offer exists, documents approved, pay details complete). Its link is internal now:
 -- nobody holds the token; the signed-in person reaches the offer through hr_svc_staff_session.
 r := public.hr_admin_staff_offer_send(p.id, hr.random_hash());
 update hr.staff_profiles set auth_user_id = p_auth_user_id where id = p.id and auth_user_id is distinct from p_auth_user_id;
 if v_needs then i := hr.account_invite_create(p.id, p_account_hash, v_admin); end if;
 return jsonb_build_object('profileId', p.id, 'email', p.email, 'name', hr.staff_name(p), 'offer', r->'offer', 'firstSend', v_first, 'needsPassword', v_needs,
  'invite', case when v_needs then hr.invite_json(i) end, 'expiresAt', case when v_needs then i.expires_at end);
end $fn$;

-- Undo of a first send whose email failed: nothing reached the person, so the offer is unsent again, its links are revoked and (when
-- the login was made for this send) the person is unlinked from it. Only the admin who sent it, within 15 minutes, unsigned.
create or replace function public.hr_admin_onboarding_offer_unsend(p_id uuid, p_unlink boolean default false) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; o hr.staff_offers;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status <> 'offer_sent' then raise exception 'There is no sent offer to undo.' using errcode = '23514'; end if;
 select * into o from hr.staff_offers where profile_id = p.id and sent_at is not null and withdrawn_at is null and signed_at is null for update;
 if not found or o.sent_by is distinct from v_admin or o.sent_at < now() - interval '15 minutes' then
  raise exception 'Only a send that has just failed can be undone. Withdraw the offer instead.' using errcode = '23514'; end if;
 update hr.staff_invites set revoked_at = now(), revoked_by = v_admin
  where profile_id = p.id and purpose in ('offer', 'account') and revoked_at is null and superseded_at is null and used_at is null;
 update hr.staff_offers set sent_at = null, sent_by = null where id = o.id;
 perform hr.staff_move(p.id, 'documents_submitted', 'The offer email could not be sent; nothing went out', v_admin, false);
 if coalesce(p_unlink, false) then update hr.staff_profiles set auth_user_id = null where id = p.id; end if;
 return public.hr_admin_staff_detail(p.id);
end $fn$;

-- A new one-time set-password link (the earlier one stops working), while the person has not chosen a password yet.
create or replace function public.hr_admin_onboarding_login_resend(p_id uuid, p_account_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; u auth.users; i hr.staff_invites;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p.status not in ('offer_sent', 'offer_signed') or p.auth_user_id is null then raise exception 'A sign-in link is sent with the offer letter.' using errcode = '23514'; end if;
 select * into u from auth.users where id = p.auth_user_id;
 if not found then raise exception 'The login for this person no longer exists. Withdraw the offer and send it again.' using errcode = 'P0002'; end if;
 if u.email_confirmed_at is not null then
  raise exception 'This person has already chosen a password. They can use "Forgot password" on the login page.' using errcode = '23514'; end if;
 i := hr.account_invite_create(p.id, p_account_hash, v_admin);
 return jsonb_build_object('profileId', p.id, 'email', p.email, 'name', hr.staff_name(p), 'invite', hr.invite_json(i), 'expiresAt', i.expires_at);
end $fn$;

revoke all on function public.hr_admin_onboarding_offer_send(uuid, uuid, text), public.hr_admin_onboarding_offer_unsend(uuid, boolean),
 public.hr_admin_onboarding_login_resend(uuid, text) from public, anon;
grant execute on function public.hr_admin_onboarding_offer_send(uuid, uuid, text), public.hr_admin_onboarding_offer_unsend(uuid, boolean),
 public.hr_admin_onboarding_login_resend(uuid, text) to authenticated;

-- A withdrawn offer also ends the set-password link that went out with it.
create or replace function hr.staff_offer_withdrawn_links() returns trigger
language plpgsql security definer set search_path = hr, pg_temp as $fn$
begin
 if old.withdrawn_at is null and new.withdrawn_at is not null and old.sent_at is not null then
  update hr.staff_invites set revoked_at = now(), revoked_by = new.withdrawn_by
   where profile_id = new.profile_id and purpose = 'account' and revoked_at is null and superseded_at is null and used_at is null;
 end if;
 return new;
end $fn$;
drop trigger if exists staff_offer_withdrawn_links on hr.staff_offers;
create trigger staff_offer_withdrawn_links after update of withdrawn_at on hr.staff_offers for each row execute function hr.staff_offer_withdrawn_links();

-- ------------------------------------------------------------------ the admin view, now with the login state
create or replace function public.hr_admin_onboarding(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 return hr.onboarding_stage(p.id) || jsonb_build_object(
  'payDetails', hr.onboarding_pay_json(p.id),
  'documentLinkSentAt', (select max(i.created_at) from hr.staff_invites i where i.profile_id = p.id and i.purpose in ('documents', 'reupload')),
  'account', hr.onboarding_account_json(p.id),
  'offerLetter', (select jsonb_build_object('offerId', l.offer_id, 'templateName', l.template_name, 'title', l.title, 'createdAt', l.created_at)
    from hr.staff_offer_letters l join hr.staff_offers o on o.id = l.offer_id where l.profile_id = p.id and o.withdrawn_at is null order by l.created_at desc limit 1),
  'timeline', hr.onboarding_timeline(p.id));
end $fn$;

-- ------------------------------------------------------------------ service: set the password (staff-onboarding, link token)
-- One neutral answer for every unusable link (unknown, expired, replaced, revoked, already used, or the offer is gone).
create or replace function public.hr_svc_account_open(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles;
begin
 i := hr.invite_resolve(p_token_hash, array['account']);
 select * into p from hr.staff_profiles where id = i.profile_id;
 if i.used_at is not null or p.auth_user_id is null or p.status not in ('offer_sent', 'offer_signed') then
  raise exception 'This link is not valid any more. Ask us for a new one.' using errcode = '28000'; end if;
 return jsonb_build_object('name', hr.staff_name(p), 'firstName', p.first_name, 'email', p.email, 'expiresAt', i.expires_at, 'authUserId', p.auth_user_id);
end $fn$;

create or replace function public.hr_svc_account_done(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles;
begin
 i := hr.invite_resolve(p_token_hash, array['account']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if i.used_at is not null or p.auth_user_id is null or p.status not in ('offer_sent', 'offer_signed') then
  raise exception 'This link is not valid any more. Ask us for a new one.' using errcode = '28000'; end if;
 perform set_config('hr.actor', p.auth_user_id::text, true); perform set_config('hr.actor_kind', 'applicant', true);
 update hr.staff_invites set used_at = now() where id = i.id;
 return jsonb_build_object('ok', true, 'email', p.email);
end $fn$;

-- ------------------------------------------------------------------ service: the signed-in person's own offer and documents
-- The hash of this person's offer link, for the existing offer functions (hr_svc_offer_open / _path / _file / _sign). Only someone
-- with a confirmed login whose own record has an offer out or signed; a missing or expired link is made again here.
create or replace function public.hr_svc_staff_session(p_user uuid) returns text
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare p hr.staff_profiles; v_hash text;
begin
 select * into p from hr.staff_profiles where auth_user_id = p_user;
 if not found or p.status not in ('offer_sent', 'offer_signed')
  or not exists (select 1 from auth.users u where u.id = p_user and u.email_confirmed_at is not null)
  or not exists (select 1 from hr.staff_offers o where o.profile_id = p.id and o.sent_at is not null and o.withdrawn_at is null) then
  raise exception 'There is no offer for this login.' using errcode = '28000'; end if;
 select i.token_hash into v_hash from hr.staff_invites i
  where i.profile_id = p.id and i.purpose = 'offer' and i.revoked_at is null and i.superseded_at is null and i.expires_at > now()
  order by i.created_at desc limit 1;
 if v_hash is null then
  v_hash := hr.random_hash();
  perform hr.invite_create(p.id, 'offer', v_hash, p_user);
  -- A signed offer stays read-only through its new link.
  if p.status = 'offer_signed' then update hr.staff_invites set used_at = now() where token_hash = v_hash; end if;
 end if;
 return v_hash;
end $fn$;

create or replace function public.hr_svc_staff_document_path(p_user uuid, p_doc uuid) returns text
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_path text;
begin
 select d.storage_path into v_path from hr.staff_documents d join hr.staff_profiles p on p.id = d.profile_id
  where d.id = p_doc and d.is_current and p.auth_user_id = p_user and p.status in ('offer_sent', 'offer_signed');
 if v_path is null then raise exception 'Document not found.' using errcode = 'P0002'; end if;
 return v_path;
end $fn$;

revoke all on function public.hr_svc_account_open(text), public.hr_svc_account_done(text), public.hr_svc_staff_session(uuid),
 public.hr_svc_staff_document_path(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_svc_account_open(text), public.hr_svc_account_done(text), public.hr_svc_staff_session(uuid),
 public.hr_svc_staff_document_path(uuid, uuid) to service_role;

-- ------------------------------------------------------------------ the person's own onboarding page (signed in, before Active)
create or replace function public.hr_staff_onboarding_me() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare v_uid uuid := auth.uid(); p hr.staff_profiles;
begin
 if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 select * into p from hr.staff_profiles where auth_user_id = v_uid;
 if not found then return null; end if;
 if p.status not in ('offer_sent', 'offer_signed') then return jsonb_build_object('status', p.status); end if;
 return jsonb_build_object('status', p.status, 'name', hr.staff_name(p), 'firstName', p.first_name, 'email', p.email,
  'position', (select e.job_title from hr.employment e where e.profile_id = p.id),
  'offer', (select jsonb_build_object('filename', o.filename, 'sentAt', o.sent_at, 'signedAt', o.signed_at)
    from hr.staff_offers o where o.profile_id = p.id and o.sent_at is not null and o.withdrawn_at is null order by o.sent_at desc limit 1),
  'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'category', d.category, 'filename', d.filename, 'status', d.status,
     'expiryDate', d.expiry_date, 'uploadedAt', d.created_at) order by d.category, d.created_at)
    from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb));
end $fn$;
revoke all on function public.hr_staff_onboarding_me() from public, anon;
grant execute on function public.hr_staff_onboarding_me() to authenticated;

-- ------------------------------------------------------------------ the sign-in link email ("Resend login") as its own email kind
alter table hr.staff_emails drop constraint if exists staff_emails_kind_check;
alter table hr.staff_emails add constraint staff_emails_kind_check check (kind in ('application_received','admin_new_application','document_invite','reupload_invite',
 'admin_documents_submitted','offer','signed_offer','admin_offer_signed','rejected','already_applied','access_ready','login_link'));

-- The three functions of 20261110090000 that list the link emails, now with login_link (nothing else changes): a link email is
-- logged by the function that sent it, and a failed one is sent again as a new link, never retried from the outbox.
create or replace function public.hr_svc_email_log(p_profile uuid, p_kind text, p_state text, p_message_id text default null, p_error text default null,
 p_payload jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_id bigint;
begin
 if p_kind not in ('document_invite','reupload_invite','offer','login_link') then raise exception 'Only link emails are logged this way.' using errcode = '22023'; end if;
 if p_state not in ('sent','failed','skipped') then raise exception 'Unknown email state.' using errcode = '22023'; end if;
 v_id := hr.queue_email(p_profile, p_kind, 'applicant', p_payload);
 update hr.staff_emails set state = p_state, attempts = 1, provider_message_id = left(p_message_id, 200), last_error = left(p_error, 500),
  sent_at = case when p_state = 'sent' then now() end where id = v_id;
 return v_id;
end $fn$;
revoke all on function public.hr_svc_email_log(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.hr_svc_email_log(uuid, text, text, text, text, jsonb) to service_role;

create or replace function public.hr_admin_staff_email_retry(p_email bigint) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin(); e hr.staff_emails;
begin
 select * into e from hr.staff_emails where id = p_email for update;
 if not found then raise exception 'Email not found.' using errcode = 'P0002'; end if;
 if e.kind in ('document_invite','reupload_invite','offer','login_link') then raise exception 'Send the link again instead: a new link replaces the old one.' using errcode = '23514'; end if;
 if e.state <> 'failed' then raise exception 'Only a failed email can be sent again.' using errcode = '23514'; end if;
 update hr.staff_emails set state = 'queued', attempts = 0, lease_until = null, last_error = null where id = e.id;
 return public.hr_admin_staff_detail(e.profile_id);
end $fn$;
revoke all on function public.hr_admin_staff_email_retry(bigint) from public, anon;
grant execute on function public.hr_admin_staff_email_retry(bigint) to authenticated;

create or replace function public.hr_admin_staff_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; a hr.staff_applications;
begin
 perform hr.require_admin();
 select * into p from hr.staff_profiles where id = p_id;
 if not found then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 select * into a from hr.staff_applications where profile_id = p.id;
 return jsonb_build_object('profile', to_jsonb(p) - 'auth_user_id', 'application', to_jsonb(a),
  'hasAccount', p.auth_user_id is not null,
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id),
  'invites', coalesce((select jsonb_agg(hr.invite_json(i) order by i.created_at desc) from hr.staff_invites i where i.profile_id = p.id), '[]'::jsonb),
  'offers', coalesce((select jsonb_agg(hr.offer_json(o) order by o.uploaded_at desc) from hr.staff_offers o where o.profile_id = p.id), '[]'::jsonb),
  'emails', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'audience', e.audience, 'state', e.state, 'createdAt', e.created_at,
     'sentAt', e.sent_at, 'error', e.last_error, 'attempts', e.attempts,
     'retryable', e.state = 'failed' and e.kind not in ('document_invite','reupload_invite','offer','login_link')) order by e.id desc) from hr.staff_emails e where e.profile_id = p.id), '[]'::jsonb),
  'emailFailed', hr.staff_email_failed(p.id),
  'roles', coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'grantedAt', r.granted_at, 'revokedAt', r.revoked_at) order by r.granted_at) from hr.staff_roles r where r.profile_id = p.id), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actorKind', e.actor_kind, 'note', e.note, 'at', e.created_at) order by e.id) from hr.staff_status_events e where e.profile_id = p.id), '[]'::jsonb),
  'hasCmsAccess', exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id and c.status = 'Active'),
  'jobApplications', hr.job_applications_json(p.id), 'employment', hr.employment_json(p.id));
end $fn$;
revoke all on function public.hr_admin_staff_detail(uuid) from public, anon;
grant execute on function public.hr_admin_staff_detail(uuid) to authenticated;
