-- SLIT countersigns the individual agent agreement (owner decisions 2026-11-17, after 20261118023417):
--   * The agreement request has two signers in order: the agent (order 1), then a SLIT signatory (order 2) chosen at Send from the active
--     CMS Admins (the sender by default). The Sign module emails the signatory their link once the agent has signed; the CMS shows them a
--     Countersign button. The signatory can be changed until they have signed (old links stop working, a new invitation goes out).
--   * Status: Agreement sent -> Agent signed (awaiting SLIT) (request state partial) -> Fully signed (stage agreement_signed). The Sign
--     module's completion email delivers the fully signed PDF and certificate to the agent; the signed copy is kept on the onboarding.
--   * The server guard counts an online agreement only when the request is complete with both signatures; an uploaded copy must be
--     declared fully signed by both parties (admins only, reason, logged).
--   * Reject voids the open agreement request in any open state (fix: the open-state list named 'partially_signed', which does not exist;
--     the Sign module's state is 'partial').
--   * Nothing here updates an existing row.
set local lock_timeout = '5s';

create function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

-- ------------------------------------------------------------------ the guard: both signatures
create or replace function public.agent_agreement_covered(p_agent uuid, p_business uuid, p_profile uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select exists (select 1 from public.agencies a where a.id = p_business and coalesce(a.is_direct, false))
  or exists (select 1 from public.portal_profiles p where p.id = p_profile and coalesce(p.is_test, false))
  or exists (select 1 from public.agency_onboarding o where o.kind = 'agent' and o.agent_id = p_agent and o.agency_id = p_business
   and o.stage in ('agreement_signed', 'activated') and o.agreement_content is not null
   and (o.agreement_uploaded_at is not null
    or exists (select 1 from hr.sign_requests r where r.id = o.agreement_request_id and r.state = 'signed'
     and (select count(*) from hr.sign_recipients k where k.request_id = r.id and k.state = 'signed') >= 2
     and not exists (select 1 from hr.sign_recipients k where k.request_id = r.id and k.required and k.state <> 'signed'))))
  or exists (select 1 from public.agency_onboarding o where o.kind = 'business' and o.agent_id = p_agent and o.agency_id = p_business
   and (o.stage = 'agreement_signed' or (o.stage = 'legacy' and o.status = 'signed')))
  or (not exists (select 1 from public.agency_onboarding o where o.kind = 'agent' and o.agent_id = p_agent) and public.business_agreement_ready(p_business));
$f$;
revoke all on function public.agent_agreement_covered(uuid, uuid, uuid) from public, anon, authenticated;

-- The signed agent agreement is accepted only with every signature (agent and SLIT) done.
select pg_temp.patch('public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb)',
 $a$if v_kind = 'agreement' and o.kind = 'agent' then
  if o.stage <> 'agreement_sent' then raise exception 'This agreement is no longer waiting for a signature'; end if;$a$,
 $a$if v_kind = 'agreement' and o.kind = 'agent' then
  if o.stage <> 'agreement_sent' then raise exception 'This agreement is no longer waiting for a signature'; end if;
  if (select count(*) from hr.sign_recipients k where k.request_id = r.id and k.state = 'signed') < 2
    or exists (select 1 from hr.sign_recipients k where k.request_id = r.id and k.required and k.state <> 'signed') then
   raise exception 'The agreement needs both signatures (the agent and SLIT)'; end if;$a$);

-- Reject voids the open agreement request whatever its open state.
select pg_temp.patch('public.agency_onboarding_decline(uuid, text)',
 $a$r.state in ('draft', 'sent', 'viewed', 'partially_signed')$a$, $a$r.state in ('draft', 'sending', 'sent', 'viewed', 'partial', 'email_failed')$a$);

-- Lists: the agreement request's state (Agent signed, awaiting SLIT).
select pg_temp.patch('public.admin_agent_rows(uuid, text, text, integer, integer)', $a$'ready', o.stage = 'agreement_signed')$a$,
 $a$'ready', o.stage = 'agreement_signed', 'agreementState', (select q.state from hr.sign_requests q where q.id = o.agreement_request_id))$a$);
select pg_temp.patch('public.admin_agent_overview(uuid)', $a$'ready', o.stage = 'agreement_signed')$a$,
 $a$'ready', o.stage = 'agreement_signed', 'agreementState', (select q.state from hr.sign_requests q where q.id = o.agreement_request_id))$a$);
-- The business page: the SLIT signatory of an agent's agreement, and whether it is the person looking.
select pg_temp.patch('public.agency_onboarding_list(uuid)',
 $a$'agreementUpload', case when o.agreement_uploaded_at is null then null else$a$,
 $a$'countersign', case when o.kind <> 'agent' or o.agreement_request_id is null then null else (select jsonb_build_object('recipientId', k.id, 'name', k.name, 'email', k.email, 'state', k.state,
   'signedAt', k.signed_at, 'mine', lower(k.email) = (select lower(u.email) from auth.users u where u.id = auth.uid())) from hr.sign_recipients k where k.request_id = o.agreement_request_id and k.signing_order = 2 limit 1) end,
  'agreementUpload', case when o.agreement_uploaded_at is null then null else$a$);
-- Needs action today: an agreement the agent signed waits for SLIT.
select pg_temp.patch('public.admin_today()',
 $a$(o.kind = 'agent' and o.stage = 'agreement_signed')$a$,
 $a$(o.kind = 'agent' and o.stage = 'agreement_signed') or (o.kind = 'agent' and o.stage = 'agreement_sent' and exists (select 1 from hr.sign_requests q where q.id = o.agreement_request_id and q.state = 'partial'))$a$, 2);
select pg_temp.patch('public.admin_today()',
 $a$case when o.kind = 'agent' and o.stage = 'agreement_signed' then$a$,
 $a$case when o.kind = 'agent' and o.stage = 'agreement_sent' then 'Agent signed their agreement: SLIT to countersign' when o.kind = 'agent' and o.stage = 'agreement_signed' then$a$);

-- The template Send agreement uses, with the roles that have a signature box (both signers need one on a PDF template).
create or replace function public.agent_agreement_template() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare t hr.sign_templates;
begin
 if coalesce(auth.role(), '') <> 'service_role' then perform public.admin_business_require(); end if;
 select * into t from hr.sign_templates x where x.category = 'individual_agent_agreement' and x.status = 'active' and x.deleted_at is null and x.kind in ('pdf', 'text')
  order by x.is_default desc, x.updated_at desc nulls last, x.created_at desc limit 1;
 if not found then return null; end if;
 return jsonb_build_object('id', t.id, 'name', t.name, 'kind', t.kind, 'roles', coalesce(t.roles, '[]'::jsonb), 'version', t.version,
  'signatureRoles', coalesce((select jsonb_agg(distinct f->>'role') from jsonb_array_elements(case when jsonb_typeof(t.fields) = 'array' then t.fields else '[]'::jsonb end) f where f->>'type' = 'signature'), '[]'::jsonb));
end $f$;
revoke all on function public.agent_agreement_template() from public, anon;
grant execute on function public.agent_agreement_template() to authenticated, service_role;

-- ------------------------------------------------------------------ who may countersign: active CMS Admins with a sign-in
create or replace function public.agent_agreement_countersigners() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
begin
 if coalesce(auth.role(), '') <> 'service_role' then perform public.admin_business_require(); end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', lower(u.email), 'me', u.auth_user_id = auth.uid()) order by lower(u.name))
  from public.cms_users u where u.role = 'Admin' and u.status = 'Active' and u.auth_user_id is not null and coalesce(btrim(u.email), '') <> ''), '[]'::jsonb);
end $f$;
revoke all on function public.agent_agreement_countersigners() from public, anon;
grant execute on function public.agent_agreement_countersigners() to authenticated, service_role;

-- Send agreement: the request must have the agent first and an active CMS Admin second, signing in that order.
create or replace function public.agency_onboarding_agent_agreement_create(p_onboarding uuid, p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; t hr.sign_templates; g public.agents; k1 hr.sign_recipients; k2 hr.sign_recipients;
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
 select * into g from public.agents where id = o.agent_id;
 if (select count(*) from hr.sign_recipients where request_id = r.id) <> 2 or r.signing_mode <> 'sequential' then
  raise exception 'The agreement needs two signers in order: the agent, then SLIT' using errcode = '23514', hint = 'agent_agreement_signers'; end if;
 select * into k1 from hr.sign_recipients where request_id = r.id order by signing_order limit 1;
 select * into k2 from hr.sign_recipients where request_id = r.id order by signing_order desc limit 1;
 if k1.signing_order >= k2.signing_order or lower(k1.email) <> lower(g.email) or not k1.required or not k2.required then
  raise exception 'The agreement needs two signers in order: the agent, then SLIT' using errcode = '23514', hint = 'agent_agreement_signers'; end if;
 if not exists (select 1 from public.cms_users u where lower(u.email) = lower(k2.email) and u.role = 'Admin' and u.status = 'Active' and u.auth_user_id is not null) then
  raise exception 'The SLIT signatory must be an active CMS administrator' using errcode = '23514', hint = 'agent_agreement_countersigner'; end if;
 update public.agency_onboarding set agreement_request_id = r.id, stage = 'agreement_sent' where id = o.id returning * into o;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 perform public.agency_onboarding_log(o.id, 'agreement_sent', jsonb_build_object('request', r.reference, 'template', t.name, 'version', t.version, 'document', 'individual_agent_agreement',
  'countersigner', k2.name, 'countersigner_email', k2.email));
 perform public.admin_business_audit('agent_onboarding_sent', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'document', 'individual_agent_agreement'));
 return jsonb_build_object('id', o.id, 'requestId', r.id, 'reference', r.reference, 'stage', o.stage, 'countersigner', jsonb_build_object('name', k2.name, 'email', k2.email));
end $f$;
revoke all on function public.agency_onboarding_agent_agreement_create(uuid, uuid) from public, anon;
grant execute on function public.agency_onboarding_agent_agreement_create(uuid, uuid) to authenticated;

-- Change the SLIT signatory before they sign: their old links stop working; if it was their turn, the new signatory is invited now.
create or replace function public.agency_onboarding_agent_countersigner_change(p_onboarding uuid, p_cms_user text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; k hr.sign_recipients; u public.cms_users; v_turn boolean; v_n integer;
begin
 perform public.admin_business_require();
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.kind <> 'agent' or o.stage <> 'agreement_sent' or o.agreement_request_id is null then raise exception 'This agreement is not waiting for SLIT''s signature' using errcode = '22023'; end if;
 select * into r from hr.sign_requests where id = o.agreement_request_id for update;
 if r.state not in ('sent', 'viewed', 'partial', 'email_failed') then raise exception 'This agreement is not waiting for a signature' using errcode = '22023'; end if;
 select * into k from hr.sign_recipients where request_id = r.id and signing_order = 2 for update;
 if k.id is null or k.state not in ('pending', 'sent', 'viewed') then raise exception 'SLIT has already signed this agreement' using errcode = '22023'; end if;
 select * into u from public.cms_users where id = p_cms_user and role = 'Admin' and status = 'Active' and auth_user_id is not null and coalesce(btrim(email), '') <> '';
 if not found then raise exception 'Choose an active CMS administrator' using errcode = '22023'; end if;
 if lower(u.email) = lower(k.email) then return jsonb_build_object('id', o.id, 'changed', false); end if;
 if lower(u.email) = lower(coalesce((select x.email from hr.sign_recipients x where x.request_id = r.id and x.signing_order = 1), '')) then raise exception 'The agent cannot countersign for SLIT' using errcode = '22023'; end if;
 v_turn := k.state in ('sent', 'viewed');
 delete from hr.sign_tokens where recipient_id = k.id;
 update hr.sign_notifications set state = 'cancelled' where recipient_id = k.id and state in ('queued', 'sending');
 update hr.sign_recipients set name = left(u.name, 150), email = lower(btrim(u.email)), state = case when v_turn then 'sent' else state end, viewed_at = null, last_notified_at = case when v_turn then now() else last_notified_at end,
  reminder_count = 0, delivery_error = null where id = k.id;
 if v_turn then
  select count(*) + 1 into v_n from hr.sign_notifications where recipient_id = k.id and kind = 'invite';
  perform hr.sign_queue(r.id, k.id, 'invite', 'invite:' || k.id || ':' || v_n || ':changed');
 end if;
 perform hr.sign_event(r.id, 'recipient_changed', k.id, auth.uid(), jsonb_build_object('from', k.email, 'to', lower(u.email), 'role', k.role_label));
 perform public.agency_onboarding_log(o.id, 'countersigner_changed', jsonb_build_object('from', k.name, 'to', u.name, 'email', lower(u.email), 'invited', v_turn));
 return jsonb_build_object('id', o.id, 'changed', true, 'invited', v_turn, 'countersigner', jsonb_build_object('name', u.name, 'email', lower(u.email)));
end $f$;
revoke all on function public.agency_onboarding_agent_countersigner_change(uuid, text) from public, anon;
grant execute on function public.agency_onboarding_agent_countersigner_change(uuid, text) to authenticated;

-- A signed copy recorded by an administrator: the copy must already carry both signatures (declared, with a reason; logged).
drop function if exists public.agency_onboarding_agent_agreement_upload(uuid, text, text, text);
create or replace function public.agency_onboarding_agent_agreement_upload(p_onboarding uuid, p_file_name text, p_base64 text, p_reason text, p_both_signed boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; v bytea; v_reason text; v_prev uuid; v_file text;
begin
 perform public.admin_business_require();
 v_reason := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), 1000), '');
 if v_reason is null or length(v_reason) < 5 then raise exception 'Give the reason for recording a signed copy instead of the online agreement (kept on the record)' using errcode = '22023'; end if;
 if p_both_signed is not true then raise exception 'Confirm that the copy is signed by the agent and countersigned by SLIT' using errcode = '22023', hint = 'agent_agreement_both_signatures'; end if;
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
 perform public.agency_onboarding_log(o.id, 'agreement_uploaded', jsonb_build_object('file', v_file, 'reason', v_reason, 'previous_request', v_prev, 'document', 'individual_agent_agreement', 'both_signed', true));
 perform public.admin_business_audit('agent_individual_agreement_uploaded', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'agent', o.agent_id, 'file', v_file, 'reason', v_reason));
 return jsonb_build_object('id', o.id, 'onboardingId', o.id, 'stage', o.stage, 'previousRequestId', v_prev);
end $f$;
revoke all on function public.agency_onboarding_agent_agreement_upload(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.agency_onboarding_agent_agreement_upload(uuid, text, text, text, boolean) to authenticated;
