-- Onboarding per business (2026-11-19, owner). The onboarding (Agent Application Form F04 -> two referee checks F05 -> staff review ->
-- Agent Agreement P06 -> admin Activate) runs ONCE per business, with its point of contact (POC). Agents have no onboarding of their own.
--   * Add business sends F04 to the POC at once (document-signing agent_onboarding_business_create); never for an existing business.
--     At most one open onboarding per business (unique index): a double click or a retry cannot send a second F04.
--   * The signed business agreement no longer activates anything: the business stays Onboarding, "Ready to activate". An administrator
--     presses Activate (agency_business_activate, called by document-signing agent_onboarding_business_activate): the business goes
--     Active, the POC and every agent added meanwhile get ONE set-password email each.
--   * Add agent: into an operational business it adds and invites as before; into a business still onboarding the agent is recorded with
--     status 'Onboarding' (invitation held) and nothing is sent; Activate releases them. Agents of a declined or inactive business: refused.
--   * An uploaded signed copy of the business agreement (reason required, logged in the onboarding history) stands in for the online one
--     and is activated the same way; admin_business_set_status refuses to activate a business that is still onboarding.
--   * Every agent-level onboarding RPC is refused (agent_level_onboarding_refuse); existing rows stay readable, nothing is deleted.
--   * The "Individual Agent Agreement" template is archived (cannot be chosen); SLIT-DIRECT is unchanged (no onboarding, @slit.edu.au only).
-- Additive and data-preserving: no column or row is dropped; no email is queued by this migration. The rollback is at the end of this file.
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ idempotency: one open onboarding (one F04 cycle) per business
create unique index if not exists agency_onboarding_business_open_idx on public.agency_onboarding(agency_id)
 where kind = 'business' and stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent');
create unique index if not exists agency_onboarding_application_request_idx on public.agency_onboarding(application_request_id) where application_request_id is not null;

-- ------------------------------------------------------------------ in-place patches (one-line anchors, exact counts)
create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

-- ------------------------------------------------------------------ agent-level onboarding is retired: one refusal, switched in every per-agent RPC
create or replace function public.agent_level_onboarding_refuse() returns void language plpgsql as $f$
begin
 raise exception 'Agents have no onboarding of their own: the business onboarding covers them. Add the agent; their sign-in invitation goes out when the business is active.'
  using errcode = '22023', hint = 'covered_by_business';
end $f$;
revoke all on function public.agent_level_onboarding_refuse() from public, anon;

create or replace function pg_temp.refuse_in(p_fn regprocedure) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); v text;
begin
 if position('agent_level_onboarding_refuse' in d) > 0 then return; end if;
 v := regexp_replace(d, E'\\nbegin\\r?\\n', E'\nbegin\n perform public.agent_level_onboarding_refuse();\n');
 if v = d then raise exception '%: no begin line', p_fn; end if;
 execute v;
end $p$;
select pg_temp.refuse_in('public.agent_onboarding_agent_add(uuid, text, text, text, text, text, uuid)');
select pg_temp.refuse_in('public.agency_onboarding_agent_application_create(uuid, jsonb)');
select pg_temp.refuse_in('public.agency_onboarding_agent_activate(uuid)');
select pg_temp.refuse_in('public.agency_onboarding_agent_agreement_create(uuid, uuid)');
select pg_temp.refuse_in('public.agency_onboarding_agent_agreement_upload(uuid, text, text, text, boolean)');
select pg_temp.refuse_in('public.agency_onboarding_agent_countersigner_change(uuid, text)');
select pg_temp.refuse_in('public.agency_onboarding_agent_countersigner_set(uuid, text, boolean)');
select pg_temp.refuse_in('public.agency_onboarding_agent_countersign_claim(uuid)');
select pg_temp.refuse_in('public.agent_agreement_individual_template_create(uuid, text)');

-- The Individual Agent Agreement template cannot be chosen any more (archived, kept).
update hr.sign_templates set status = 'archived', updated_at = now() where category = 'individual_agent_agreement' and status = 'active' and deleted_at is null;

-- ------------------------------------------------------------------ the business agreement covers every agent of the business
create or replace function public.agent_agreement_covered(p_agent uuid, p_business uuid, p_profile uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select exists (select 1 from public.agencies a where a.id = p_business and coalesce(a.is_direct, false))
  or exists (select 1 from public.portal_profiles p where p.id = p_profile and coalesce(p.is_test, false))
  or exists (select 1 from public.agency_onboarding o where o.kind = 'business' and o.agent_id = p_agent and o.agency_id = p_business
   and (o.stage = 'agreement_signed' or (o.stage = 'legacy' and o.status = 'signed')))
  or public.business_agreement_ready(p_business);
$f$;

-- ------------------------------------------------------------------ a business still onboarding holds its agents' invitations
create or replace function public.agency_business_holds_invites(p_business uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $f$
 select exists (select 1 from public.agencies a where a.id = p_business and a.status = 'Onboarding' and not coalesce(a.is_direct, false))
  and coalesce((select o.stage from public.agency_onboarding o where o.agency_id = p_business and o.kind = 'business' order by o.created_at desc limit 1), '') <> 'declined';
$f$;
revoke all on function public.agency_business_holds_invites(uuid) from public, anon;
grant execute on function public.agency_business_holds_invites(uuid) to authenticated;

create or replace function public.agency_gate_reason(a public.agencies) returns text
language sql stable security definer set search_path = public as $f$
 select case public.agency_effective_status(a)
  when 'Active' then null
  when 'Onboarding' then case when public.business_agreement_ready(a.id) then 'This business is ready to activate: agents can be added now; their sign-in invitations go out when an administrator activates it.'
   else 'This business is still onboarding: agents can be added now; their sign-in invitations go out when an administrator activates it.' end
  else case
   when a.status = 'Active' and a.agreement_status = 'signed' and a.agreement_expiry_date < current_date then 'The agent agreement expired on ' || to_char(a.agreement_expiry_date, 'DD/MM/YYYY') || ': renew it before agents can be added.'
   when a.status = 'Active' then 'This business has no signed agent agreement: complete the onboarding before agents can be added.'
   else 'This business is inactive.' end end;
$f$;

-- ------------------------------------------------------------------ Add agent (CMS): invite-only; held while the business is onboarding
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$declare g public.agents; a public.agencies; v_old uuid; v_business_activated boolean := false;$a$,
 $a$declare g public.agents; a public.agencies; v_old uuid; v_business_activated boolean := false; v_held boolean := false;$a$);
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$if g.status in ('Onboarding', 'Declined') then raise exception 'This agent is going through onboarding: activate them from the business page once both references are back, or start their onboarding again.' using errcode = '23514', hint = 'agent_onboarding'; end if;$a$,
 $a$if exists (select 1 from public.agency_onboarding x where x.kind = 'agent' and x.agent_id = g.id and x.stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'agreement_sent')) then raise exception 'This agent still has an onboarding of their own open: cancel it first (the business onboarding now covers agents).' using errcode = '23514', hint = 'agent_onboarding'; end if;$a$);
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$ if not public.agency_is_operational(a.id) then$a$,
 $a$ v_held := not public.agency_is_operational(a.id) and public.agency_business_holds_invites(a.id);
 if not v_held and not public.agency_is_operational(a.id) then$a$);
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$if g.id is null and not coalesce(a.is_direct, false) then raise exception 'New agents start with their onboarding: Add agent emails them the application form.' using errcode = '23514', hint = 'agent_onboarding_required'; end if;$a$, '');
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$values (a.id, v_name, v_email, v_phone, v_marn, p_role, 'Active', now(), auth.uid()) returning * into g;$a$,
 $a$values (a.id, v_name, v_email, v_phone, v_marn, p_role, case when v_held then 'Onboarding' else 'Active' end, now(), auth.uid()) returning * into g;$a$);
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$status = 'Active', status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now() where id = g.id returning * into g;$a$,
 $a$status = case when v_held then 'Onboarding' else 'Active' end, status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now() where id = g.id returning * into g;$a$);
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$ if g.profile_id is not null then$a$, $a$ if g.profile_id is not null and not v_held then$a$);
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$jsonb_build_object('agent', v_name, 'marn', v_marn,$a$, $a$jsonb_build_object('agent', v_name, 'held', v_held, 'marn', v_marn,$a$);
select pg_temp.patch('public.admin_agent_activate(uuid, uuid, text, text, text, text, text)',
 $a$'businessCreated', false, 'businessActivated', v_business_activated,$a$, $a$'businessCreated', false, 'held', v_held, 'businessActivated', v_business_activated,$a$);

-- Portal invitations: an operational business's admin agent invites as before (the agent record is made when the invitation is accepted);
-- an agent held for activation (status Onboarding) still gets no invitation until the business is activated.
select pg_temp.patch('public.portal_invitation_create(uuid, uuid, text, text, text, uuid)',
 $a$raise exception 'Add the agent first: Add agent emails them the application form, and the sign-in invitation goes out once they are activated.' using errcode = '22023', hint = 'agent_onboarding_required'; end if;$a$,
 $a$null; end if;$a$);
select pg_temp.patch('public.portal_invitation_resend(uuid, uuid)',
 $a$or (not exists (select 1 from public.agents g where g.business_id = inv.agency_id and g.email = inv.email) and not exists (select 1 from public.agencies x where x.id = inv.agency_id and coalesce(x.is_direct, false)))) then$a$,
 $a$or false) then$a$);

-- ------------------------------------------------------------------ the signed business agreement: Ready to activate, not Active
select pg_temp.patch('public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb)',
 $a$perform public.agency_onboarding_activate(o.id);$a$,
 $a$perform public.agency_onboarding_log(o.id, 'ready_to_activate', jsonb_build_object('agency', o.agency_id));$a$);

-- Called by the document-signing version deployed before this change after a signature: it now activates nothing.
create or replace function public.agency_onboarding_activation(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies;
begin
 select * into o from public.agency_onboarding where id = p_onboarding;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 select * into a from public.agencies where id = o.agency_id;
 return jsonb_build_object('onboardingId', o.id, 'agency', jsonb_build_object('id', a.id, 'name', a.name, 'status', a.status), 'agent', null, 'loginExists', false, 'invitation', null,
  'readyToActivate', a.status <> 'Active' and public.business_agreement_ready(a.id));
end $f$;

-- Activate (administrator): the business goes Active; the POC and every agent held for it become Active; one invitation each (no login yet).
-- Returns the invitations still to email; document-signing sends them (one set-password email per invitation, never a second).
create or replace function public.agency_business_activate(p_business uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; o public.agency_onboarding; poc public.agents; g public.agents; inv public.agency_invitations; v_staff text; v_invites jsonb := '[]'::jsonb;
 v_held integer := 0; v_skipped jsonb := '[]'::jsonb; v_contact_inv uuid;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_business for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if coalesce(a.is_direct, false) then raise exception 'SLIT''s direct business has no onboarding to activate.' using errcode = '22023', hint = 'direct_business'; end if;
 if a.status = 'Active' then raise exception 'This business is already active.' using errcode = '23514', hint = 'already_active'; end if;
 if not public.business_agreement_ready(a.id) then
  raise exception 'The agent agreement is not signed yet: activate once it is signed online, or upload a signed copy with a reason.' using errcode = '23514', hint = 'agreement_required'; end if;
 select * into o from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business' order by x.created_at desc limit 1;
 if o.id is not null and o.stage = 'declined' then raise exception 'This business''s onboarding was declined.' using errcode = '23514', hint = 'declined'; end if;
 if o.id is not null and o.stage = 'agreement_signed' then select * into poc from public.agents where id = o.agent_id and business_id = a.id; end if;
 if poc.id is null then
  select * into poc from public.agents x where x.business_id = a.id and x.role = 'agency_admin' and x.status <> 'Declined' and x.email <> '' order by (x.status = 'Active') desc, x.created_at limit 1; end if;
 if poc.id is null then raise exception 'This business has no point of contact with an email address.' using errcode = '23514', hint = 'no_contact'; end if;
 select u.name into v_staff from public.cms_users u where u.auth_user_id = auth.uid() limit 1;
 -- Activated on an uploaded signed copy while the online onboarding is still open: its requests close silently (no "voided" email, no
 -- more reminders) and the onboarding is closed; its history stays.
 if o.id is not null and o.stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent') then
  update hr.sign_notifications n set state = 'cancelled' from hr.sign_requests r where n.request_id = r.id and r.agency_onboarding_id = o.id and n.state = 'queued';
  update hr.sign_requests set state = 'void', closed_reason = 'Signed copy uploaded: the business was activated'
   where agency_onboarding_id = o.id and state in ('draft', 'sending', 'sent', 'viewed', 'partial', 'email_failed');
  update public.agency_onboarding set stage = 'cancelled', status = 'closed', closed_reason = 'signed_copy_uploaded' where id = o.id and stage not in ('cancelled', 'expired', 'declined');
  perform public.agency_onboarding_log(o.id, 'closed_signed_copy', jsonb_build_object('stageBefore', o.stage));
 end if;
 update public.agencies set status = 'Active', onboarding_completed_at = coalesce(onboarding_completed_at, now()), updated_at = now() where id = a.id returning * into a;
 for g in select x.* from public.agents x where x.business_id = a.id and (x.id = poc.id or x.status = 'Onboarding')
   order by (x.id = poc.id) desc, x.created_at loop
  update public.agents set status = 'Active', role = case when g.id = poc.id then 'agency_admin' else role end, status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now()
   where id = g.id returning * into g;
  if g.id <> poc.id then v_held := v_held + 1; end if;
  inv := null;
  if g.profile_id is not null then
   update public.portal_profiles set status = 'Active', updated_at = now() where id = g.profile_id and status <> 'Active';
   update public.agency_memberships set status = 'Active', agency_id = a.id, role = case when role = 'student' then role else g.role end, updated_at = now() where user_id = g.profile_id;
  elsif g.email <> '' then
   select * into inv from public.agency_invitations i where i.email = g.email and i.status = 'pending' order by i.created_at desc limit 1;
   if inv.id is not null and inv.agency_id <> a.id then
    v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('email', g.email, 'reason', 'pending invitation for another business')); inv := null;
   elsif inv.id is null then
    if exists (select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id where lower(p.email) = g.email and m.status = 'Active' and p.status = 'Active') then
     v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('email', g.email, 'reason', 'already signs in'));
    else
     insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name)
     values (a.id, g.email, g.full_name, g.role, auth.uid(), coalesce(v_staff, 'Skyline')) returning * into inv;
    end if;
   end if;
   if inv.id is not null then
    v_invites := v_invites || jsonb_build_array(jsonb_build_object('id', inv.id, 'email', inv.email, 'name', inv.full_name, 'role', inv.role, 'expiresAt', inv.expires_at,
     'sent', inv.link_sent_at is not null, 'contact', g.id = poc.id, 'agentId', g.id));
    if g.id = poc.id then v_contact_inv := inv.id; end if;
   end if;
  end if;
 end loop;
 if o.id is not null then
  update public.agency_onboarding set activated_at = coalesce(activated_at, now()), activation_invitation_id = coalesce(v_contact_inv, activation_invitation_id) where id = o.id;
  perform public.agency_onboarding_log(o.id, 'activated', jsonb_build_object('by', 'admin', 'email', poc.email, 'invitation', v_contact_inv, 'heldAgents', v_held,
   'invitations', jsonb_array_length(v_invites), 'uploadedCopy', coalesce(a.agreement_status, '') <> 'signed'));
 end if;
 perform public.admin_business_audit('business_activated', a.id, a.id, jsonb_build_object('name', a.name, 'by', 'admin', 'contact', poc.email, 'heldAgents', v_held));
 return jsonb_build_object('businessId', a.id, 'name', a.name, 'status', a.status, 'onboardingId', o.id,
  'contact', jsonb_build_object('id', poc.id, 'name', poc.full_name, 'email', poc.email), 'heldReleased', v_held, 'invitations', v_invites, 'skipped', v_skipped);
end $f$;
revoke all on function public.agency_business_activate(uuid) from public, anon;
grant execute on function public.agency_business_activate(uuid) to authenticated;

-- Activate & invite by hand no longer applies to a business still onboarding: its Activate releases the held invitations too.
select pg_temp.patch('public.admin_business_set_status(uuid, text)',
 $a$ if p_status = 'Active' and a.status <> 'Active' and not public.business_agreement_ready(a.id) then$a$,
 $a$ if p_status = 'Active' and a.status = 'Onboarding' and not coalesce(a.is_direct, false) then
  raise exception 'Activate this business with Activate on its page: it also sends the held agent invitations.' using errcode = '23514', hint = 'use_business_activate'; end if;
 if p_status = 'Active' and a.status <> 'Active' and not public.business_agreement_ready(a.id) then$a$);

-- The business page: Ready to activate and the agents waiting for it.
select pg_temp.patch('public.admin_business_detail(uuid)',
 $a$'onboarding', jsonb_build_object('completedAt', a.onboarding_completed_at, 'agreementReady', public.business_agreement_ready(a.id),$a$,
 $a$'onboarding', jsonb_build_object('completedAt', a.onboarding_completed_at, 'agreementReady', public.business_agreement_ready(a.id),
   'readyToActivate', a.status = 'Onboarding' and not coalesce(a.is_direct, false) and public.business_agreement_ready(a.id) and coalesce(o.stage, '') <> 'declined',
   'heldAgents', (select count(*) from public.agents h where h.business_id = a.id and h.status = 'Onboarding'),$a$);

/* ------------------------------------------------------------------ ROLLBACK (run as one transaction; restores the agent-level behaviour)
begin;
create or replace function public.agent_level_onboarding_refuse() returns void language plpgsql as $f$ begin return; end $f$;  -- per-agent RPCs work again
update hr.sign_templates set status = 'active', updated_at = now() where category = 'individual_agent_agreement' and name = 'Individual Agent Agreement' and status = 'archived' and deleted_at is null;
drop index if exists public.agency_onboarding_business_open_idx;
drop index if exists public.agency_onboarding_application_request_idx;
-- Re-apply, in this order, the definitions these patches replaced (repo files are the source; the anchors above reversed):
--   agent_agreement_covered            -> supabase/migrations/20261118041529_agent_agreement_countersign.sql
--   agency_gate_reason                 -> supabase/migrations/20261117220000_agent_onboarding_gate.sql
--   agency_onboarding_activation       -> supabase/migrations/20261117220000_agent_onboarding_gate.sql
--   admin_agent_activate, portal_invitation_create, portal_invitation_resend, admin_business_detail
--                                      -> run this file's pg_temp.patch calls with old/new swapped (same anchors)
--   agency_onboarding_accept_signed    -> pg_temp.patch(..., 'perform public.agency_onboarding_log(o.id, ''ready_to_activate'', jsonb_build_object(''agency'', o.agency_id));',
--                                         'perform public.agency_onboarding_activate(o.id);')
--   admin_business_set_status          -> remove the 'use_business_activate' block (pg_temp.patch with the two-line text -> '')
drop function if exists public.agency_business_activate(uuid);
drop function if exists public.agency_business_holds_invites(uuid);
commit;
-- Data: nothing to restore (this migration changes no onboarding, agent or invitation row; only the template status above).
*/
