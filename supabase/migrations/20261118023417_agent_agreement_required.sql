-- No agent becomes Active without a signed agreement (owner decisions 2026-11-17, after agent-level onboarding):
--   * Server guard: a trigger on public.agents refuses every change that makes an agent Active (insert, status or business change) unless
--     an agreement covers that agent for that business (agent_agreement_covered):
--       - their own individual agent agreement, signed online or uploaded by an administrator (agent onboarding at agreement_signed /
--         activated with the signed copy stored);
--       - the business's agreement for the person who signed it (business onboarding at agreement_signed, or a signed legacy request);
--       - the business's signed or uploaded agreement (business_agreement_ready) for an agent who never had an onboarding of their own:
--         the business's own contact / admin agent and agents who predate agent-level onboarding;
--       - SLIT's direct business (no agreement there) and the Switch view test account (portal_profiles.is_test).
--     Agents already Active are not touched: the trigger only looks at a change to Active.
--   * Individual agent agreement: a new template type (hr.sign_templates.category 'individual_agent_agreement', managed in CMS > Templates).
--     An agent's onboarding gains the step references_received -> agreement_sent -> agreement_signed -> activated: staff send the active
--     template of that type (never P06), the agent signs it, then an administrator activates them. An administrator may record a signed
--     copy instead (reason required, written to the onboarding history).
--   * Business onboarding and existing rows are unchanged; nothing here updates an agents or agency_onboarding row.
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ schema (additive)
alter table hr.sign_templates drop constraint if exists sign_templates_category_check;
alter table hr.sign_templates add constraint sign_templates_category_check check (category = any (array['enrolment_agreement', 'consent_form', 'fee_agreement', 'employment_contract',
 'offer_letter', 'hr_declaration', 'agency_agreement', 'commission_agreement', 'other', 'offer_email', 'document_request', 'document_reupload', 'welcome_login', 'rejection', 'student_offer_letter',
 'individual_agent_agreement']));

alter table public.agency_onboarding add column if not exists agreement_uploaded_at timestamptz;
alter table public.agency_onboarding add column if not exists agreement_uploaded_by uuid;
alter table public.agency_onboarding add column if not exists agreement_upload_reason text check (agreement_upload_reason is null or length(agreement_upload_reason) <= 1000);
alter table public.agency_onboarding add column if not exists agreement_file_name text check (agreement_file_name is null or length(agreement_file_name) <= 200);

-- One open agent onboarding per agent, the agreement steps included.
drop index if exists public.agency_onboarding_agent_open_idx;
create unique index agency_onboarding_agent_open_idx on public.agency_onboarding(agent_id)
 where kind = 'agent' and stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'agreement_sent', 'agreement_signed');

-- ------------------------------------------------------------------ the guard
create or replace function public.agent_agreement_covered(p_agent uuid, p_business uuid, p_profile uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select exists (select 1 from public.agencies a where a.id = p_business and coalesce(a.is_direct, false))
  or exists (select 1 from public.portal_profiles p where p.id = p_profile and coalesce(p.is_test, false))
  or exists (select 1 from public.agency_onboarding o where o.kind = 'agent' and o.agent_id = p_agent and o.agency_id = p_business
   and o.stage in ('agreement_signed', 'activated') and o.agreement_content is not null)
  or exists (select 1 from public.agency_onboarding o where o.kind = 'business' and o.agent_id = p_agent and o.agency_id = p_business
   and (o.stage = 'agreement_signed' or (o.stage = 'legacy' and o.status = 'signed')))
  or (not exists (select 1 from public.agency_onboarding o where o.kind = 'agent' and o.agent_id = p_agent) and public.business_agreement_ready(p_business));
$f$;
revoke all on function public.agent_agreement_covered(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.agents_require_agreement() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $f$
begin
 if new.status is distinct from 'Active' then return new; end if;
 if tg_op = 'UPDATE' and old.status = 'Active' and old.business_id is not distinct from new.business_id then return new; end if;
 if not public.agent_agreement_covered(new.id, new.business_id, new.profile_id) then
  raise exception 'This agent has not signed an agent agreement yet: they can be activated once their individual agent agreement is signed (or an administrator records a signed copy).'
   using errcode = '23514', hint = 'agent_agreement_required';
 end if;
 return new;
end $f$;
revoke all on function public.agents_require_agreement() from public, anon, authenticated;
drop trigger if exists agents_require_agreement on public.agents;
create trigger agents_require_agreement before insert or update of status, business_id on public.agents
 for each row execute function public.agents_require_agreement();

-- ------------------------------------------------------------------ in-place patches (one-line anchors, exact counts)
create function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

-- The signed individual agreement is kept on the agent's onboarding; the business (profile, agreement, status) is never touched.
select pg_temp.patch('public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb)',
 $a$if v_kind = 'agreement' then$a$,
 $a$if v_kind = 'agreement' and o.kind = 'agent' then
  if o.stage <> 'agreement_sent' then raise exception 'This agreement is no longer waiting for a signature'; end if;
  update public.agency_onboarding set status = 'signed', stage = 'agreement_signed', signed_at = coalesce(r.signed_at, now()), signer_name = c.signer_name, agreement_content = p_signed,
   certificate_content = p_certificate where id = o.id returning * into o;
  perform public.agency_onboarding_log(o.id, 'agreement_signed', jsonb_build_object('request', r.reference, 'signer', c.signer_name, 'document', 'individual_agent_agreement'));
  perform public.admin_business_audit('agent_individual_agreement_signed', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'agent', o.agent_id, 'request', r.reference, 'signer', c.signer_name));
  return;
 end if;
 if v_kind = 'agreement' then$a$);
-- The business activation never runs for an agent's own onboarding.
select pg_temp.patch('public.agency_onboarding_activate(uuid)',
 $a$if o.stage <> 'agreement_signed' then raise exception 'The agreement is not signed yet'; end if;$a$,
 $a$if o.kind <> 'business' then raise exception 'An agent''s own agreement activates nothing by itself: an administrator activates the agent.' using errcode = '22023'; end if; if o.stage <> 'agreement_signed' then raise exception 'The agreement is not signed yet'; end if;$a$);
-- Reject stays possible until the agent is activated.
select pg_temp.patch('public.agency_onboarding_decline(uuid, text)',
 $a$if o.stage not in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent') then$a$,
 $a$if o.stage not in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent') and not (o.kind = 'agent' and o.stage = 'agreement_signed') then$a$);
-- Add agent / restart: an onboarding at the agreement step is still in progress.
select pg_temp.patch('public.agent_onboarding_agent_add(uuid, text, text, text, text, text, uuid)',
 $a$and x.stage in ('application_sent', 'application_signed', 'references_pending', 'references_received')) then$a$,
 $a$and x.stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'agreement_sent', 'agreement_signed')) then$a$);
-- Ready to activate = the agreement is signed (lists, business page, agent page, Needs action today).
select pg_temp.patch('public.admin_agent_rows(uuid, text, text, integer, integer)', $a$'ready', o.stage = 'references_received')$a$, $a$'ready', o.stage = 'agreement_signed')$a$);
select pg_temp.patch('public.admin_agent_overview(uuid)', $a$'ready', o.stage = 'references_received')$a$, $a$'ready', o.stage = 'agreement_signed')$a$);
select pg_temp.patch('public.admin_business_detail(uuid)', $a$x2.kind = 'agent' and x2.stage = 'references_received'),$a$, $a$x2.kind = 'agent' and x2.stage = 'agreement_signed'),$a$);
select pg_temp.patch('public.admin_today()',
 $a$(select count(*) from public.agency_onboarding o where o.stage = 'references_received'),$a$,
 $a$(select count(*) from public.agency_onboarding o where o.stage = 'references_received' or (o.kind = 'agent' and o.stage = 'agreement_signed')),$a$);
select pg_temp.patch('public.admin_today()',
 $a$case when o.kind = 'agent' then 'Agent ready: both references received, activate or reject'$a$,
 $a$case when o.kind = 'agent' and o.stage = 'agreement_signed' then 'Agent signed their agreement: activate or reject' when o.kind = 'agent' then 'Agent references received: send the individual agent agreement or reject'$a$);
select pg_temp.patch('public.admin_today()',
 $a$where o.stage = 'references_received'), '[]'::jsonb)));$a$,
 $a$where o.stage = 'references_received' or (o.kind = 'agent' and o.stage = 'agreement_signed')), '[]'::jsonb)));$a$);
-- The business page shows a recorded copy (who, when, why).
select pg_temp.patch('public.agency_onboarding_list(uuid)',
 $a$'agreement', public.agency_onboarding_request_json(o.agreement_request_id),$a$,
 $a$'agreement', public.agency_onboarding_request_json(o.agreement_request_id), 'agreementUpload', case when o.agreement_uploaded_at is null then null else jsonb_build_object('at', o.agreement_uploaded_at,
   'reason', o.agreement_upload_reason, 'fileName', o.agreement_file_name, 'by', (select name from public.cms_users u where u.auth_user_id = o.agreement_uploaded_by limit 1)) end,$a$);

-- ------------------------------------------------------------------ the individual agent agreement step
-- The template staff send: the active template of type Individual agent agreement (the default one first, then the latest edited). Never P06.
create or replace function public.agent_agreement_template() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare t hr.sign_templates;
begin
 if coalesce(auth.role(), '') <> 'service_role' then perform public.admin_business_require(); end if;
 select * into t from hr.sign_templates x where x.category = 'individual_agent_agreement' and x.status = 'active' and x.deleted_at is null and x.kind in ('pdf', 'text')
  order by x.is_default desc, x.updated_at desc nulls last, x.created_at desc limit 1;
 if not found then return null; end if;
 return jsonb_build_object('id', t.id, 'name', t.name, 'kind', t.kind, 'roles', coalesce(t.roles, '[]'::jsonb), 'version', t.version);
end $f$;
revoke all on function public.agent_agreement_template() from public, anon;
grant execute on function public.agent_agreement_template() to authenticated, service_role;

-- Send agreement: the function made the request (draft, the agent as its subject and only signer) from that template; this links it.
create or replace function public.agency_onboarding_agent_agreement_create(p_onboarding uuid, p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; t hr.sign_templates;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.kind <> 'agent' then raise exception 'This is the business''s onboarding: send the business''s agreement from its page.' using errcode = '22023'; end if;
 if o.stage <> 'references_received' then raise exception 'The agreement can be sent once both references are back.' using errcode = '23514', hint = 'references_outstanding'; end if;
 select * into r from hr.sign_requests where id = p_request for update;
 if not found or r.state <> 'draft' or r.subject_type is distinct from 'agent' or r.subject_id is distinct from o.agent_id or r.agency_onboarding_id is not null then
  raise exception 'The signing request does not match this agent'; end if;
 select * into t from hr.sign_templates where id = r.template_id;
 if t.id is null or t.category <> 'individual_agent_agreement' then raise exception 'No individual agent agreement template yet' using errcode = '23514', hint = 'agent_agreement_template_missing'; end if;
 update public.agency_onboarding set agreement_request_id = r.id, stage = 'agreement_sent' where id = o.id returning * into o;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 perform public.agency_onboarding_log(o.id, 'agreement_sent', jsonb_build_object('request', r.reference, 'template', t.name, 'version', t.version, 'document', 'individual_agent_agreement'));
 perform public.admin_business_audit('agent_onboarding_sent', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'document', 'individual_agent_agreement'));
 return jsonb_build_object('id', o.id, 'requestId', r.id, 'reference', r.reference, 'stage', o.stage);
end $f$;
revoke all on function public.agency_onboarding_agent_agreement_create(uuid, uuid) from public, anon;
grant execute on function public.agency_onboarding_agent_agreement_create(uuid, uuid) to authenticated;

-- A signed copy received outside the Sign module: administrators only, with a reason, kept on the onboarding and in its history. An open
-- online request is returned so the function voids it.
create or replace function public.agency_onboarding_agent_agreement_upload(p_onboarding uuid, p_file_name text, p_base64 text, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; v bytea; v_reason text; v_prev uuid; v_file text;
begin
 perform public.admin_business_require();
 v_reason := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 1000), '');
 if v_reason is null or length(v_reason) < 5 then raise exception 'Give the reason for recording a signed copy instead of the online agreement (kept on the record)' using errcode = '22023'; end if;
 begin v := decode(coalesce(p_base64, ''), 'base64'); exception when others then raise exception 'The file could not be read'; end;
 if length(v) < 5 or length(v) > 15 * 1024 * 1024 or substring(v from 1 for 4) <> '\x25504446'::bytea then raise exception 'Upload the signed agreement as a PDF (up to 15 MB)'; end if;
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.kind <> 'agent' then raise exception 'This is the business''s onboarding: record its agreement on the business page (Documents).' using errcode = '22023'; end if;
 if o.stage not in ('references_received', 'agreement_sent') then raise exception 'A signed agreement can be recorded once both references are back.' using errcode = '23514', hint = 'references_outstanding'; end if;
 v_prev := case when o.stage = 'agreement_sent' then o.agreement_request_id end;
 v_file := left(coalesce(nullif(btrim(regexp_replace(coalesce(p_file_name, ''), '[[:cntrl:]]', '', 'g')), ''), 'agent-agreement.pdf'), 200);
 update public.agency_onboarding set status = 'signed', stage = 'agreement_signed', signed_at = now(), signer_name = null, agreement_content = v, certificate_content = null,
  agreement_uploaded_at = now(), agreement_uploaded_by = auth.uid(), agreement_upload_reason = v_reason, agreement_file_name = v_file where id = o.id returning * into o;
 perform public.agency_onboarding_log(o.id, 'agreement_uploaded', jsonb_build_object('file', v_file, 'reason', v_reason, 'previous_request', v_prev, 'document', 'individual_agent_agreement'));
 perform public.admin_business_audit('agent_individual_agreement_uploaded', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'agent', o.agent_id, 'file', v_file, 'reason', v_reason));
 return jsonb_build_object('id', o.id, 'onboardingId', o.id, 'stage', o.stage, 'previousRequestId', v_prev);
end $f$;
revoke all on function public.agency_onboarding_agent_agreement_upload(uuid, text, text, text) from public, anon;
grant execute on function public.agency_onboarding_agent_agreement_upload(uuid, text, text, text) to authenticated;

-- Activate: only once the agent's own agreement is signed (or recorded). The agent becomes Active and ONE invitation is made (none when
-- they already sign in); the function emails the congratulations set-password link.
create or replace function public.agency_onboarding_agent_activate(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; g public.agents; inv public.agency_invitations; v_received integer; v_total integer; v_login boolean := false; v_made boolean := false; v_staff text;
begin
 perform public.admin_business_require();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.kind <> 'agent' then raise exception 'This is the business''s onboarding: it completes with the signed agreement.' using errcode = '22023'; end if;
 select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 if v_total < 2 or v_received < v_total then
  raise exception 'The agent can be activated once both references are back (% of 2 received).', coalesce(v_received, 0) using errcode = '23514', hint = 'references_outstanding'; end if;
 if o.stage <> 'agreement_signed' or o.agreement_content is null then
  raise exception 'The agent can be activated once they have signed their individual agent agreement (or an administrator records a signed copy).' using errcode = '23514', hint = 'agent_agreement_required'; end if;
 select * into a from public.agencies where id = o.agency_id for update;
 if not public.agency_is_operational(a.id) then
  raise exception '%', coalesce(public.agency_gate_reason(a), 'Activate the business first.') using errcode = '23514', hint = 'business_inactive'; end if;
 select * into g from public.agents where id = o.agent_id for update;
 if g.status <> 'Onboarding' then raise exception 'This agent is not in onboarding' using errcode = '22023'; end if;
 update public.agents set status = 'Active', status_changed_at = now(), status_changed_by = auth.uid(), updated_at = now() where id = g.id returning * into g;
 if g.profile_id is not null then
  update public.portal_profiles set status = 'Active', updated_at = now() where id = g.profile_id and status <> 'Active';
  update public.agency_memberships set status = 'Active', agency_id = a.id, role = case when role = 'student' then role else g.role end, updated_at = now() where user_id = g.profile_id;
  v_login := true;
 elsif g.email <> '' then
  select * into inv from public.agency_invitations i where i.agency_id = a.id and i.email = g.email and i.status = 'pending' order by i.created_at desc limit 1;
  if inv.id is null and not exists (select 1 from public.portal_profiles p join public.agency_memberships m on m.user_id = p.id where lower(p.email) = g.email and m.status = 'Active' and p.status = 'Active') then
   select u.name into v_staff from public.cms_users u where u.auth_user_id = auth.uid() limit 1;
   insert into public.agency_invitations(agency_id, email, full_name, role, invited_by, invited_by_name) values (a.id, g.email, g.full_name, g.role, auth.uid(), coalesce(v_staff, 'Skyline'))
   returning * into inv;
   v_made := true;
  end if;
 end if;
 update public.agency_onboarding set stage = 'activated', status = 'signed', activated_at = now(), approved_by = auth.uid(), approved_at = now(), activation_invitation_id = coalesce(inv.id, activation_invitation_id)
  where id = o.id returning * into o;
 perform public.agency_onboarding_log(o.id, 'agent_activated', jsonb_build_object('agent', g.id, 'email', g.email, 'invitation', inv.id, 'login', v_login));
 perform public.admin_business_audit('agent_activated', a.id, a.id, jsonb_build_object('agent', g.full_name, 'onboarding', o.id));
 return jsonb_build_object('onboardingId', o.id, 'stage', o.stage, 'agency', jsonb_build_object('id', a.id, 'name', a.name),
  'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role, 'status', g.status), 'loginExists', v_login,
  'invitation', case when inv.id is null then null else jsonb_build_object('id', inv.id, 'email', inv.email, 'name', inv.full_name, 'role', inv.role, 'expiresAt', inv.expires_at, 'new', v_made,
   'sent', inv.link_sent_at is not null) end);
end $f$;
revoke all on function public.agency_onboarding_agent_activate(uuid) from public, anon;
grant execute on function public.agency_onboarding_agent_activate(uuid) to authenticated;
