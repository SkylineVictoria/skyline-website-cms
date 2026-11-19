-- Businesses (owner 2026-11-20):
--   1. An Active business (or one that was ever activated: onboarding_completed_at) can never go back to Onboarding, by any path
--      (admin_business_set_status already allows only Active / Inactive; this trigger covers direct writes too).
--   2. Delete business, only while the application is at "Application sent" (F04 sent, not signed), only by a SLIT administrator, never
--      for SLIT-DIRECT / TEST-VIEW (or any permanent / direct business), never with students, applications or an uploaded agreement.
--      public.admin_business_delete removes everything of the business in one transaction, with triggers off so nothing is queued or
--      emailed: the business, its agents (point of contact included), invitations, memberships, tenants, the onboarding (pre-send data,
--      witness, drafts, uploads, history, referees, corrections), every signing request of it (recipients, fields, links, link history,
--      codes, notifications, history), its Messages conversations and their queued emails, audit rows naming it, and sign-in accounts
--      made only for its people. It returns the signing files to remove (document-signing removes them from storage). One minimal row is
--      kept in public.business_deletions (who, when, name, ABN). The ABN can be added again.
--   3. A signing link whose token is gone altogether (its request deleted) says "This link is no longer available." (neutral; a link
--      replaced by a newer email keeps the request-a-new-link page). Direct API deletes of agencies are refused (only the function deletes).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

-- ------------------------------------------------------------------ 1. never back to Onboarding; no direct deletes
create or replace function public.agencies_status_guard() returns trigger language plpgsql set search_path = pg_catalog, public as $f$
begin
 if tg_op = 'DELETE' then
  -- Only public.admin_business_delete (security definer, runs as the owner) deletes a business; the API roles cannot.
  if current_user in ('authenticated', 'anon') then
   raise exception 'Delete a business with Delete business (only while its application is at Application sent); otherwise make it Inactive.' using errcode = '42501';
  end if;
  return old;
 end if;
 if new.status = 'Onboarding' and old.status is distinct from 'Onboarding' and (old.status = 'Active' or old.onboarding_completed_at is not null) then
  raise exception 'An active business has already been onboarded: it can be Active or Inactive, never Onboarding again.' using errcode = '23514';
 end if;
 return new;
end $f$;
drop trigger if exists agencies_status_guard on public.agencies;
create trigger agencies_status_guard before update of status on public.agencies for each row execute function public.agencies_status_guard();
drop trigger if exists agencies_delete_guard on public.agencies;
create trigger agencies_delete_guard before delete on public.agencies for each row execute function public.agencies_status_guard();

-- ------------------------------------------------------------------ 2. delete at Application sent
create table if not exists public.business_deletions(
 id bigint generated always as identity primary key,
 deleted_at timestamptz not null default now(),
 deleted_by uuid,
 deleted_by_name text,
 business_name text not null,
 abn text
);
alter table public.business_deletions enable row level security;
revoke all on public.business_deletions from public, anon, authenticated;
comment on table public.business_deletions is 'Businesses deleted at Application sent (admin_business_delete): who, when, name and ABN only.';

-- Why a business cannot be deleted, or null when it can (the same rule for the screens and the delete itself).
create or replace function public.admin_business_delete_block(p_business uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; o public.agency_onboarding; r hr.sign_requests;
begin
 select * into a from public.agencies where id = p_business;
 if not found then return 'Business not found.'; end if;
 if upper(coalesce(a.code, '')) in ('SLIT-DIRECT', 'TEST-VIEW') or coalesce(a.is_permanent, false) or coalesce(a.is_direct, false) then
  return 'This is a system business: it cannot be deleted.'; end if;
 if a.status <> 'Onboarding' or a.onboarding_completed_at is not null then return 'Only a business whose application is at Application sent can be deleted; make this one Inactive.'; end if;
 select * into o from public.agency_onboarding where agency_id = a.id and kind = 'business' and stage not in ('cancelled', 'expired', 'declined', 'legacy')
  order by created_at desc limit 1;
 if o.id is null or o.stage <> 'application_sent' then return 'Only a business whose application is at Application sent can be deleted; make this one Inactive.'; end if;
 select * into r from hr.sign_requests where id = o.application_request_id;
 if r.id is null or r.state not in ('sent', 'viewed') or r.signed_at is not null then
  return 'The application has been signed or submitted: make this business Inactive instead.'; end if;
 if exists (select 1 from public.agency_onboarding x where x.agency_id = a.id and x.stage in ('application_signed', 'references_pending', 'references_received', 'references_approved',
   'agreement_sent', 'agreement_signed', 'correction_requested', 'resubmitted')) then
  return 'The application has been signed or submitted: make this business Inactive instead.'; end if;
 if exists (select 1 from public.enrollment_students s where s.agency_id = a.id or s.agent_id in (select g.id from public.agents g where g.business_id = a.id))
  or exists (select 1 from public.enrollment_applications p where p.agency_id = a.id or p.assigned_agent_id in (select g.id from public.agents g where g.business_id = a.id)) then
  return 'This business has students or applications: make it Inactive instead.'; end if;
 if exists (select 1 from public.business_documents d where d.business_id = a.id) then
  return 'A signed agreement copy was uploaded for this business: make it Inactive instead.'; end if;
 return null;
end $f$;

-- The screens: can the signed-in user delete this business, and if not, why. SLIT administrators only.
create or replace function public.admin_business_delete_check(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare v_block text; a public.agencies;
begin
 perform public.admin_business_require();
 if not public.cms_is_admin() then return jsonb_build_object('deletable', false, 'reason', 'Only a SLIT administrator can delete a business.'); end if;
 select * into a from public.agencies where id = p_business;
 v_block := public.admin_business_delete_block(p_business);
 return jsonb_build_object('deletable', v_block is null, 'reason', v_block, 'name', a.name, 'abn', a.registration_number);
end $f$;

create or replace function public.admin_business_delete(p_business uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; v_block text; v_confirm text := lower(regexp_replace(coalesce(p_confirm, ''), '\s+', ' ', 'g')); v_abn text;
 v_files text[]; v_users uuid[]; v_counts jsonb := '{}'::jsonb; v_n integer; v_left integer; v_actor text;
begin
 perform public.admin_business_require();
 if not public.cms_is_admin() then raise exception 'Only a SLIT administrator can delete a business.' using errcode = '42501'; end if;
 select * into a from public.agencies where id = p_business for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 v_block := public.admin_business_delete_block(a.id);
 if v_block is not null then raise exception '%', v_block using errcode = '23514'; end if;
 v_abn := regexp_replace(coalesce(a.registration_number, ''), '\D', '', 'g');
 if not (btrim(v_confirm) = lower(btrim(regexp_replace(a.name, '\s+', ' ', 'g'))) or (v_abn <> '' and regexp_replace(v_confirm, '\D', '', 'g') = v_abn)) then
  raise exception 'Type the business name or its ABN exactly to confirm.' using errcode = '22023'; end if;
 select coalesce(c.name, c.email) into v_actor from public.cms_users c where c.auth_user_id = auth.uid() limit 1;

 -- What belongs to the business.
 create temp table _b_agents on commit drop as select id, profile_id, lower(btrim(email)) email from public.agents where business_id = a.id;
 create temp table _b_onb on commit drop as select id from public.agency_onboarding where agency_id = a.id;
 create temp table _b_rq on commit drop as select id from hr.sign_requests where agency_onboarding_id in (select id from _b_onb)
  union select application_request_id from public.agency_onboarding where id in (select id from _b_onb) and application_request_id is not null
  union select request_id from public.agency_onboarding where id in (select id from _b_onb) and request_id is not null
  union select agreement_request_id from public.agency_onboarding where id in (select id from _b_onb) and agreement_request_id is not null
  union select request_id from public.agency_onboarding_referees where onboarding_id in (select id from _b_onb) and request_id is not null;
 create temp table _b_rc on commit drop as select id from hr.sign_recipients where request_id in (select id from _b_rq);
 create temp table _b_conv on commit drop as select id from public.comm_conversations
  where (person_kind = 'agency' and person_ref = a.id) or (person_kind = 'agent' and person_ref in (select id from _b_agents));
 -- Sign-in accounts made only for the business's people: no CMS user, no other business, no student record.
 create temp table _b_users on commit drop as select p.id profile_id, p.auth_user_id from public.portal_profiles p
  where p.id in (select profile_id from _b_agents where profile_id is not null) and p.auth_user_id is not null
   and not exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id)
   and not exists (select 1 from public.agents g where g.profile_id = p.id and g.business_id <> a.id)
   and not exists (select 1 from public.agency_memberships m where m.user_id = p.id and m.agency_id <> a.id);
 select coalesce(array_agg(o.name), '{}') into v_files from storage.objects o where o.bucket_id = 'signing-documents' and split_part(o.name, '/', 1) in (select id::text from _b_rq);
 select coalesce(array_agg(auth_user_id), '{}') into v_users from _b_users;

 -- Everything goes in one transaction with triggers off: nothing is queued or emailed, the signing history (append-only) can go. FK
 -- actions are triggers too, so every child table is deleted explicitly; the check at the end refuses to commit anything left over.
 set local session_replication_role = replica;
 delete from hr.sign_fields where request_id in (select id from _b_rq) or recipient_id in (select id from _b_rc);
 delete from hr.sign_tokens where recipient_id in (select id from _b_rc);
 delete from hr.sign_token_history where recipient_id in (select id from _b_rc);
 delete from hr.sign_codes where recipient_id in (select id from _b_rc);
 delete from hr.sign_notifications where request_id in (select id from _b_rq) or recipient_id in (select id from _b_rc);
 delete from hr.sign_events where request_id in (select id from _b_rq);
 update public.sign_batch_sends set request_id = null where request_id in (select id from _b_rq);
 delete from public.payments where subject_id in (select id from _b_rq);
 delete from public.agency_onboarding_drafts where request_id in (select id from _b_rq) or recipient_id in (select id from _b_rc);
 delete from public.agency_onboarding_attachments where request_id in (select id from _b_rq);
 delete from public.agency_onboarding_corrections where onboarding_id in (select id from _b_onb) or request_id in (select id from _b_rq) or previous_request_id in (select id from _b_rq);
 delete from public.agency_onboarding_revisions where onboarding_id in (select id from _b_onb) or request_id in (select id from _b_rq);
 delete from public.agency_onboarding_referees where onboarding_id in (select id from _b_onb);
 delete from public.agency_onboarding_events where onboarding_id in (select id from _b_onb);
 delete from hr.sign_recipients where id in (select id from _b_rc);
 get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('signers', v_n);
 delete from hr.sign_requests where id in (select id from _b_rq);
 get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('signingRequests', v_n);
 delete from public.agency_onboarding where id in (select id from _b_onb);
 get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('onboardings', v_n);
 -- Messages conversations about the business or its agents, and the emails they queued.
 delete from public.notification_deliveries where id in (select m.email_delivery_id from public.comm_messages m where m.conversation_id in (select id from _b_conv) and m.email_delivery_id is not null);
 delete from public.comm_messages where conversation_id in (select id from _b_conv);
 delete from public.comm_conversations where id in (select id from _b_conv);
 -- Emails still queued for the business's people (an address nobody else in the system uses), and audit rows naming the business.
 delete from public.notification_deliveries n where n.sent_at is null and lower(btrim(n.recipient_email)) in (select email from _b_agents where email <> '')
  and not exists (select 1 from public.agents g where lower(btrim(g.email)) = lower(btrim(n.recipient_email)) and g.business_id <> a.id)
  and not exists (select 1 from public.cms_users c where lower(c.email) = lower(btrim(n.recipient_email)));
 delete from public.portal_audit_log where agency_id = a.id or target_id in (select a.id::text union all select id::text from _b_agents union all select id::text from _b_onb);
 delete from public.agency_invitations where agency_id = a.id;
 get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invitations', v_n);
 delete from public.agency_memberships where agency_id = a.id or user_id in (select profile_id from _b_users);
 delete from public.agency_tenant_agents where agency_id = a.id;
 delete from public.agency_tenants where agency_id = a.id;
 delete from public.business_documents where business_id = a.id;
 update public.support_tickets set agency_id = null where agency_id = a.id;
 delete from public.agents where business_id = a.id;
 get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('agents', v_n);
 delete from public.portal_profiles where id in (select profile_id from _b_users);
 delete from auth.users where id in (select auth_user_id from _b_users);
 get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('signInAccounts', v_n);
 delete from public.agencies where id = a.id;
 set local session_replication_role = origin;

 -- Nothing may be left pointing at what was deleted.
 select (select count(*) from hr.sign_requests where id in (select id from _b_rq) or agency_onboarding_id in (select id from _b_onb))
  + (select count(*) from hr.sign_recipients where request_id in (select id from _b_rq))
  + (select count(*) from hr.sign_tokens where recipient_id in (select id from _b_rc))
  + (select count(*) from hr.sign_events where request_id in (select id from _b_rq))
  + (select count(*) from public.agency_onboarding where agency_id = a.id)
  + (select count(*) from public.agents where business_id = a.id)
  + (select count(*) from public.agency_invitations where agency_id = a.id)
  + (select count(*) from public.agencies where id = a.id) into v_left;
 if v_left > 0 then raise exception 'The business could not be deleted completely (% rows left); nothing was changed.', v_left; end if;

 insert into public.business_deletions(deleted_by, deleted_by_name, business_name, abn) values (auth.uid(), v_actor, a.name, nullif(v_abn, ''));
 return jsonb_build_object('deleted', true, 'name', a.name, 'abn', nullif(v_abn, ''), 'files', to_jsonb(v_files), 'counts', v_counts);
end $f$;

revoke all on function public.admin_business_delete_block(uuid) from public, anon, authenticated;
revoke all on function public.admin_business_delete_check(uuid), public.admin_business_delete(uuid, text) from public, anon;
grant execute on function public.admin_business_delete_check(uuid), public.admin_business_delete(uuid, text) to authenticated;

-- ------------------------------------------------------------------ 3. a link whose request is gone: neutral
select pg_temp.patch('public.signing_service(text, text, uuid, jsonb)',
 $a$ if not found then raise exception 'This signing link is invalid or expired'; end if;$a$,
 $a$ if not found then
  -- No such link at all (its request was deleted, 2026-11-20): neutral. A link replaced by a newer email is still in the history.
  if not exists (select 1 from hr.sign_token_history h where h.token_hash = p_hash) then raise exception 'This link is no longer available.' using errcode = '42501'; end if;
  raise exception 'This signing link is invalid or expired';
 end if;$a$);
