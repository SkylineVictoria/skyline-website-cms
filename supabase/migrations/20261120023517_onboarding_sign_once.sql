-- Agency onboarding: admin pre-fill, F04 + P06 signed once, drawn witness, referees no longer block (owner brief 2026-11-20).
--
--   draft (admin pre-fill) -> application_sent (F04 + P06 in ONE request) -> application_signed (one signature on both; referee
--   checks go out at once) -> references_pending / references_received (shown, never blocking) -> correction_requested / resubmitted
--   -> references_approved (Approve) -> agreement_signed (the signed agreement countersigned by SLIT and issued) -> released
--
--   * Add business saves the business and its point of contact and a DRAFT onboarding: nothing is emailed. Staff fill or edit the F04
--     answers (title, position, website, any detail), the agreement terms (commencement, territory, commission) and optionally the
--     agent's witness (typed name + DRAWN signature) in the pre-send step, then Save draft or Send to point of contact.
--   * Send makes one signing request: the F04 pages followed by the P06 pages (combined = true). The agency admin signs once; the
--     signature lands on both; the signed PDF is split into the application form and the agreement (form_content / agreement_content);
--     signature_event records that one signature covered both documents (time, IP, user agent, request).
--   * The witness signature is drawn only. Entered by staff: printed on the agreement and shown read-only. Left blank: the agency admin
--     types the witness name and has the witness draw the signature before signing (document-signing stamps it; witness_box says where).
--   * Approve no longer waits for referees (a warning in the CMS instead); on a combined onboarding it does not send a P06: the signed
--     agreement is countersigned and issued (agency_onboarding_agreement_issue) and the held sign-in invitations are released.
--   * Referee checks can still be sent, changed, uploaded and received after approval; they are kept on the record.
--   * In flight: every onboarding sent before this migration has combined = false and keeps its flow (separate P06 after approval).
-- Additive: one stage, columns, new functions; existing functions are patched in place (single-line anchors, exact counts).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

-- ------------------------------------------------------------------ columns and stages
alter table public.agency_onboarding
 add column if not exists combined boolean not null default false,
 add column if not exists presend jsonb check (presend is null or jsonb_typeof(presend) = 'object'),
 add column if not exists presend_saved_at timestamptz,
 add column if not exists presend_saved_by uuid,
 add column if not exists witness_name text check (witness_name is null or char_length(witness_name) between 2 and 150),
 add column if not exists witness_png text check (witness_png is null or (length(witness_png) <= 400000 and witness_png ~ '^[A-Za-z0-9+/]+=*$')),
 add column if not exists witness_by text check (witness_by is null or witness_by in ('admin', 'agent')),
 add column if not exists witness_box jsonb check (witness_box is null or jsonb_typeof(witness_box) = 'object'),
 add column if not exists signature_event jsonb,
 add column if not exists agreement_issued_at timestamptz,
 add column if not exists agreement_issued_by uuid;
comment on column public.agency_onboarding.combined is 'The application request carries the agreement too (F04 + P06 signed once, 2026-11-20). False for every onboarding sent before.';
comment on column public.agency_onboarding.presend is 'Staff pre-fill before the F04 is sent: answers, ACN, MARN, message (stage draft).';
comment on column public.agency_onboarding.witness_png is 'The agent''s witness signature, drawn (PNG, base64): by staff in the pre-send step or by the agency admin when signing.';
comment on column public.agency_onboarding.signature_event is 'One signature covered the application form and the agreement: when, by whom, IP, user agent, request.';

alter table public.agency_onboarding drop constraint if exists agency_onboarding_stage_check;
alter table public.agency_onboarding add constraint agency_onboarding_stage_check check (stage = any (array['legacy', 'draft', 'application_sent', 'application_signed', 'references_pending',
 'references_received', 'references_approved', 'declined', 'agreement_sent', 'agreement_signed', 'cancelled', 'expired', 'activated', 'correction_requested', 'resubmitted']));
drop index if exists public.agency_onboarding_business_open_idx;
create unique index agency_onboarding_business_open_idx on public.agency_onboarding(agency_id)
 where kind = 'business' and stage in ('draft', 'application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent', 'correction_requested', 'resubmitted');

-- ------------------------------------------------------------------ the pre-send step (staff)
-- A clean text answer: control characters removed, trimmed, at most n characters.
create or replace function public.agency_onboarding_clean(p_value text, p_max integer) returns text
language sql immutable set search_path = pg_catalog as $f$ select left(btrim(regexp_replace(coalesce(p_value, ''), '[[:cntrl:]]', ' ', 'g')), p_max) $f$;

create or replace function public.agency_onboarding_presend_get(p_agency uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; o public.agency_onboarding; g public.agents; v_open text;
begin
 perform hr.require_admin();
 select * into a from public.agencies where id = p_agency;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 select * into o from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business' and x.stage = 'draft' order by x.created_at desc limit 1;
 select x.stage into v_open from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business'
  and x.stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent', 'correction_requested', 'resubmitted') limit 1;
 select * into g from public.agents x where x.id = coalesce(o.agent_id, (select y.id from public.agents y where y.business_id = a.id and y.role = 'agency_admin' order by y.created_at limit 1));
 return jsonb_build_object('onboardingId', o.id, 'stage', o.stage, 'openStage', v_open,
  'agency', jsonb_build_object('id', a.id, 'name', a.name, 'abn', a.registration_number, 'status', a.status),
  'contact', case when g.id is null then null else jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email) end,
  'presend', coalesce(o.presend, '{}'::jsonb),
  'terms', jsonb_build_object('commencementDate', o.commencement_date, 'territory', coalesce(o.territory, ''), 'commissionPercent', o.commission_percent),
  'witness', jsonb_build_object('name', o.witness_name, 'png', o.witness_png),
  'savedAt', o.presend_saved_at, 'savedBy', (select u.name from public.cms_users u where u.auth_user_id = o.presend_saved_by limit 1));
end $f$;
revoke all on function public.agency_onboarding_presend_get(uuid) from public, anon;
grant execute on function public.agency_onboarding_presend_get(uuid) to authenticated;

-- Save draft (staff): the pre-send answers, the agreement terms and the witness. Creates the draft when the business has none.
create or replace function public.agency_onboarding_presend_save(p_agency uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare a public.agencies; g public.agents; o public.agency_onboarding; e record; v_answers jsonb := '{}'::jsonb; v_start date; v_end date; v_pct numeric; v_wname text; v_wpng text;
 v_acn text; v_marn text; v_png bytea; v_new boolean := false;
begin
 perform hr.require_admin();
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into a from public.agencies where id = p_agency for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if exists (select 1 from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business'
   and x.stage in ('application_sent', 'application_signed', 'references_pending', 'references_received', 'references_approved', 'agreement_sent', 'correction_requested', 'resubmitted')) then
  raise exception 'This business already has an onboarding in progress: the application form has been sent.' using errcode = '22023'; end if;
 select * into g from public.agents x where x.business_id = a.id and x.id = case when coalesce(p_data->>'agentId', '') ~ '^[0-9a-f-]{36}$' then (p_data->>'agentId')::uuid end;
 if g.id is null then select * into g from public.agents x where x.business_id = a.id and x.role = 'agency_admin' order by x.created_at limit 1; end if;
 if g.id is null then raise exception 'This business has no point of contact (agency admin) to send the application to.' using errcode = '22023'; end if;
 -- The answers: known shapes only (a key like the form's, a short text); the references are left for the agency admin.
 if jsonb_typeof(p_data->'answers') = 'object' then
  for e in select key, value from jsonb_each_text(p_data->'answers') loop
   if e.key !~ '^[a-z][a-z0-9_]{0,60}$' or e.key ~ '^ref[12]_' or e.key in ('declarant_name', 'declarant_role', 'agent_registration_number') then continue; end if;
   if nullif(public.agency_onboarding_clean(e.value, 500), '') is not null then v_answers := v_answers || jsonb_build_object(e.key, public.agency_onboarding_clean(e.value, 500)); end if;
  end loop;
 end if;
 v_acn := regexp_replace(coalesce(p_data->>'acn', ''), '\D', '', 'g');
 v_marn := regexp_replace(coalesce(p_data->>'marn', ''), '\s', '', 'g');
 if v_acn <> '' and v_acn !~ '^\d{9}$' then raise exception 'The ACN has 9 digits.' using errcode = '22023'; end if;
 if v_marn <> '' and v_marn !~ '^\d{1,10}$' then raise exception 'The MARN is a number: digits only.' using errcode = '22023'; end if;
 -- The agreement terms (required only when sending).
 if nullif(btrim(coalesce(p_data->>'commencementDate', '')), '') is not null then
  begin v_start := (p_data->>'commencementDate')::date; v_end := (p_data->>'expiryDate')::date; exception when others then raise exception 'Enter the commencement date' using errcode = '22023'; end;
  if v_end is null or v_end <= v_start then raise exception 'Enter the commencement date' using errcode = '22023'; end if;
 end if;
 if nullif(btrim(coalesce(p_data->>'commissionPercent', '')), '') is not null then
  begin v_pct := (regexp_replace(p_data->>'commissionPercent', '[^0-9.]', '', 'g'))::numeric; exception when others then raise exception 'Enter the commission as a percentage' using errcode = '22023'; end;
  if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage' using errcode = '22023'; end if;
 end if;
 -- The witness: a typed name and a DRAWN signature together, or neither (then the agency admin adds them when signing).
 v_wname := nullif(public.agency_onboarding_clean(p_data->>'witnessName', 150), '');
 v_wpng := nullif(regexp_replace(coalesce(p_data->>'witnessPng', ''), '^data:image/png;base64,', ''), '');
 if v_wpng is not null then
  begin v_png := decode(v_wpng, 'base64'); exception when others then raise exception 'The witness signature could not be read. Draw it again.' using errcode = '22023'; end;
  if length(v_png) < 8 or substring(v_png from 1 for 8) <> '\x89504e470d0a1a0a'::bytea or length(v_wpng) > 400000 then raise exception 'The witness signature could not be read. Draw it again.' using errcode = '22023'; end if;
 end if;
 if (v_wname is null) <> (v_wpng is null) then
  raise exception 'Give the witness''s name and have the witness draw the signature, or leave both empty for the agency admin.' using errcode = '22023'; end if;
 if v_wname is not null and char_length(v_wname) < 2 then raise exception 'Enter the witness''s full name.' using errcode = '22023'; end if;
 select * into o from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business' and x.stage = 'draft' order by x.created_at desc limit 1 for update;
 if o.id is null then
  insert into public.agency_onboarding(agency_id, agent_id, stage, status, form_pages, sent_by, combined)
  values (a.id, g.id, 'draft', 'sent', 1, auth.uid(), true) returning * into o;
  v_new := true;
 end if;
 update public.agency_onboarding set agent_id = g.id, combined = true,
  presend = jsonb_strip_nulls(jsonb_build_object('answers', v_answers, 'acn', nullif(v_acn, ''), 'marn', nullif(v_marn, ''), 'message', nullif(public.agency_onboarding_clean(p_data->>'message', 2000), ''))),
  commencement_date = v_start, expiry_date = v_end, territory = public.agency_onboarding_clean(p_data->>'territory', 200), commission_percent = v_pct,
  witness_name = v_wname, witness_png = v_wpng, witness_by = case when v_wpng is null then null else 'admin' end,
  presend_saved_at = now(), presend_saved_by = auth.uid() where id = o.id returning * into o;
 perform public.agency_onboarding_log(o.id, case when v_new then 'draft_created' else 'draft_saved' end, jsonb_build_object('answers', (select count(*) from jsonb_object_keys(v_answers)), 'witness', v_wpng is not null, 'terms', v_start is not null));
 return jsonb_build_object('onboardingId', o.id, 'stage', o.stage, 'savedAt', o.presend_saved_at, 'contact', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email));
end $f$;
revoke all on function public.agency_onboarding_presend_save(uuid, jsonb) from public, anon;
grant execute on function public.agency_onboarding_presend_save(uuid, jsonb) to authenticated;

-- Send to point of contact (document-signing, after it made the combined request): the draft becomes the sent application.
create or replace function public.agency_onboarding_presend_send(p_onboarding uuid, p_request uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; g public.agents; r hr.sign_requests;
begin
 perform hr.require_admin();
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage <> 'draft' then raise exception 'This application has already been sent.' using errcode = '22023'; end if;
 if o.commencement_date is null or o.expiry_date is null or btrim(o.territory) = '' or o.commission_percent is null then
  raise exception 'Enter the agreement''s commencement date, territory and commission before sending.' using errcode = '22023'; end if;
 select * into g from public.agents where id = o.agent_id;
 select * into r from hr.sign_requests where id = p_request for update;
 if not found or r.state <> 'draft' or r.subject_type is distinct from 'agent' or r.subject_id is distinct from g.id or r.agency_onboarding_id is not null then
  raise exception 'The signing request does not match this business''s point of contact'; end if;
 update public.agency_onboarding set application_request_id = r.id, stage = 'application_sent', status = 'sent', combined = true,
  form_pages = greatest(coalesce((p_data->>'form_pages')::integer, 1), 1), sent_values = coalesce(p_data->'values', '{}'::jsonb), sent_by = auth.uid(),
  message = nullif(public.agency_onboarding_clean(p_data->>'message', 2000), ''), admin_name = public.agency_onboarding_clean(p_data->>'admin_name', 150),
  witness_box = case when jsonb_typeof(p_data->'witness_box') = 'object' then p_data->'witness_box' end, created_at = now()
 where id = o.id returning * into o;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 update public.agencies set agreement_onboarding_id = o.id, updated_at = now() where id = o.agency_id and agreement_status <> 'signed';
 perform public.agency_onboarding_log(o.id, 'application_sent', jsonb_build_object('request', r.reference, 'agent', g.id, 'email', g.email, 'combined', true, 'witness', o.witness_by,
  'commencement', o.commencement_date, 'territory', o.territory, 'commission', o.commission_percent));
 perform public.admin_business_audit('agent_onboarding_sent', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'agent', g.id, 'email', g.email, 'document', 'application_and_agreement'));
 return jsonb_build_object('id', o.id, 'requestId', r.id, 'reference', r.reference, 'stage', o.stage);
end $f$;
revoke all on function public.agency_onboarding_presend_send(uuid, uuid, jsonb) from public, anon;
grant execute on function public.agency_onboarding_presend_send(uuid, uuid, jsonb) to authenticated;

-- An unsent draft can be thrown away (staff).
create or replace function public.agency_onboarding_presend_discard(p_onboarding uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
begin
 perform hr.require_admin();
 delete from public.agency_onboarding where id = p_onboarding and stage = 'draft';
 if not found then raise exception 'Only an unsent draft can be discarded.' using errcode = '22023'; end if;
end $f$;
revoke all on function public.agency_onboarding_presend_discard(uuid) from public, anon;
grant execute on function public.agency_onboarding_presend_discard(uuid) to authenticated;

-- ------------------------------------------------------------------ the signing page: the agreement terms and the witness (application links only)
create or replace function public.agency_onboarding_combined_plan(p_onboarding uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $f$
 select case when o.combined then jsonb_build_object('combined', true,
  'agreement', jsonb_build_object('commencementDate', o.commencement_date, 'expiryDate', o.expiry_date, 'territory', o.territory, 'commissionPercent', o.commission_percent),
  'witness', jsonb_build_object('preset', o.witness_png is not null, 'name', o.witness_name, 'by', o.witness_by,
   'image', case when o.witness_png is null then null else 'data:image/png;base64,' || o.witness_png end, 'box', o.witness_box))
  else jsonb_build_object('combined', false) end
 from public.agency_onboarding o where o.id = p_onboarding;
$f$;
revoke all on function public.agency_onboarding_combined_plan(uuid) from public, anon, authenticated;
create or replace function public.agency_onboarding_request_plan(p_request uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select case when r.agency_onboarding_id is null then null else public.agency_onboarding_plan(r.agency_onboarding_id) || jsonb_build_object('kind', k.kind)
  || case when k.kind = 'application' then coalesce(public.agency_onboarding_combined_plan(r.agency_onboarding_id), '{}'::jsonb) else '{}'::jsonb end end
 from hr.sign_requests r cross join lateral (select public.agency_onboarding_request_kind(r.agency_onboarding_id, r.id) as kind) k where r.id = p_request;
$f$;

-- ------------------------------------------------------------------ one signature on both documents
create or replace function public.agency_onboarding_signed_once(p_onboarding uuid, p_request uuid, p_recipient uuid, p_agreement bytea, p_data jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare r hr.sign_requests; c hr.sign_recipients; v_event jsonb;
begin
 select * into r from hr.sign_requests where id = p_request;
 select * into c from hr.sign_recipients where id = p_recipient;
 v_event := jsonb_strip_nulls(jsonb_build_object('at', coalesce(r.signed_at, now()), 'request', r.reference, 'requestId', r.id, 'recipientId', c.id, 'signer', c.signer_name,
  'signatureKind', c.signature_kind, 'signatureHash', p_data->>'signature_hash', 'ip', coalesce(nullif(p_data->>'ip', ''), c.ip::text), 'userAgent', left(p_data->>'user_agent', 300),
  'documentHash', r.signed_hash, 'documents', jsonb_build_array('Agent Application Form (F04)', 'Education Agent Agreement (P06)')));
 update public.agency_onboarding set agreement_content = p_agreement, signature_event = v_event, signed_at = coalesce(r.signed_at, now()), signer_name = c.signer_name where id = p_onboarding;
 perform public.agency_onboarding_log(p_onboarding, 'signed_once', v_event);
end $f$;
revoke all on function public.agency_onboarding_signed_once(uuid, uuid, uuid, bytea, jsonb) from public, anon, authenticated;

-- The combined request's signed PDF arrives split (form_base64 / agreement_base64, as the first merged version did): the form part is the
-- application form, the agreement part is kept signed by the agency admin until SLIT approves and countersigns it.
select pg_temp.patch('public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb)',
 $a$if o.stage = 'correction_requested' then perform public.agency_onboarding_resubmitted(o.id, r.id, c.id, p_signed, p_certificate, v_answers); return; end if;$a$,
 $a$if o.combined then
   begin v_form := decode(coalesce(p_data->>'form_base64', ''), 'base64'); v_agreement := decode(coalesce(p_data->>'agreement_base64', ''), 'base64');
   exception when others then raise exception 'The signed documents could not be stored. Please select Sign again'; end;
   if length(v_form) < 5 or length(v_agreement) < 5 or substring(v_form from 1 for 4) <> '\x25504446'::bytea or substring(v_agreement from 1 for 4) <> '\x25504446'::bytea then
    raise exception 'The signed documents could not be stored. Please select Sign again'; end if;
   p_signed := v_form;
  end if;
  if o.stage = 'correction_requested' then perform public.agency_onboarding_resubmitted(o.id, r.id, c.id, p_signed, p_certificate, v_answers);
   if o.combined then perform public.agency_onboarding_signed_once(o.id, r.id, c.id, v_agreement, p_data); end if; return; end if;$a$);
select pg_temp.patch('public.agency_onboarding_accept_signed(uuid, uuid, uuid, bytea, bytea, jsonb)',
 $a$perform public.agency_onboarding_log(o.id, 'application_signed', jsonb_build_object('request', r.reference, 'signer', c.signer_name, 'referees', v_emails));$a$,
 $a$perform public.agency_onboarding_log(o.id, 'application_signed', jsonb_build_object('request', r.reference, 'signer', c.signer_name, 'referees', v_emails, 'combined', o.combined));
  if o.combined then perform public.agency_onboarding_signed_once(o.id, r.id, c.id, v_agreement, p_data); end if;$a$);

-- The witness the agency admin added when signing (document-signing, service role, after the signature is committed).
create or replace function public.agency_onboarding_witness_record(p_request uuid, p_name text, p_png text) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; v_png text := regexp_replace(coalesce(p_png, ''), '^data:image/png;base64,', ''); v_name text := public.agency_onboarding_clean(p_name, 150);
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null or not o.combined then raise exception 'Not a combined application' using errcode = '22023'; end if;
 if not exists (select 1 from hr.sign_requests r where r.id = p_request and r.state = 'signed') then raise exception 'The application is not signed yet' using errcode = '22023'; end if;
 if o.witness_by = 'admin' then return; end if;
 if char_length(v_name) < 2 or v_png !~ '^[A-Za-z0-9+/]+=*$' or length(v_png) > 400000 then raise exception 'The witness could not be recorded' using errcode = '22023'; end if;
 update public.agency_onboarding set witness_name = v_name, witness_png = v_png, witness_by = 'agent' where id = o.id;
 perform public.agency_onboarding_log(o.id, 'witness_recorded', jsonb_build_object('name', v_name, 'by', 'agent'));
end $f$;
revoke all on function public.agency_onboarding_witness_record(uuid, text, text) from public, anon, authenticated;
grant execute on function public.agency_onboarding_witness_record(uuid, text, text) to service_role;

-- ------------------------------------------------------------------ referees never block: review, send back and approve once signed
create or replace function public.agency_onboarding_approve(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; v_received integer; v_total integer;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage = 'references_approved' then
  select * into a from public.agencies where id = o.agency_id;
  return jsonb_build_object('id', o.id, 'stage', o.stage, 'agencyStatus', a.status, 'already', true, 'combined', o.combined); end if;
 if o.stage not in ('application_signed', 'references_pending', 'references_received', 'resubmitted') then
  raise exception 'The application can be approved once it is signed (and a correction, if any, is resubmitted).' using errcode = '22023'; end if;
 if o.combined and o.agreement_content is null then raise exception 'The signed agreement is missing: the application cannot be approved.' using errcode = '22023'; end if;
 select count(*) filter (where status = 'received'), count(*) into v_received, v_total from public.agency_onboarding_referees where onboarding_id = o.id;
 update public.agency_onboarding set stage = 'references_approved', approved_by = auth.uid(), approved_at = now() where id = o.id returning * into o;
 update public.agencies set status = 'Active', updated_at = now() where id = o.agency_id and status = 'Onboarding' returning * into a;
 if a.id is null then select * into a from public.agencies where id = o.agency_id; end if;
 perform public.agency_onboarding_log(o.id, 'approved', jsonb_build_object('received', v_received, 'total', v_total, 'refereesPending', greatest(v_total - v_received, 0),
  'rounds', (select count(*) from public.agency_onboarding_corrections c where c.onboarding_id = o.id), 'combined', o.combined));
 perform public.admin_business_audit('business_approved', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'status', a.status, 'refereesReceived', v_received, 'refereesTotal', v_total));
 return jsonb_build_object('id', o.id, 'stage', o.stage, 'agencyStatus', a.status, 'combined', o.combined, 'refereesPending', greatest(v_total - v_received, 0));
end $f$;
revoke all on function public.agency_onboarding_approve(uuid) from public, anon;
grant execute on function public.agency_onboarding_approve(uuid) to authenticated;

select pg_temp.patch('public.agency_onboarding_correction_request(uuid, uuid, jsonb)',
 $a$if o.stage not in ('references_received', 'resubmitted') then raise exception 'An application can be sent back once both referees have replied.' using errcode = '22023'; end if;$a$,
 $a$if o.stage not in ('application_signed', 'references_pending', 'references_received', 'resubmitted') then raise exception 'An application can be sent back once it is signed (and not while a correction is with the agency).' using errcode = '22023'; end if;$a$);
select pg_temp.patch('public.agency_onboarding_correction_request(uuid, uuid, jsonb)',
 $a$if exists (select 1 from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status <> 'received') then raise exception 'Wait for both referees before sending the application back.' using errcode = '22023'; end if;$a$,
 $a$-- 2026-11-20: referees no longer block a correction.$a$);
-- After approval a referee can still be changed, uploaded or sent a check; what arrives is kept on the record.
select pg_temp.patch('public.agency_onboarding_referee_change_email(uuid, text, text)',
 $a$if o.stage not in ('application_signed', 'references_pending') then raise exception$a$,
 $a$if o.stage not in ('application_signed', 'references_pending', 'references_received', 'resubmitted', 'references_approved', 'agreement_sent', 'agreement_signed') then raise exception$a$);
select pg_temp.patch('public.agency_onboarding_referee_upload(uuid, text, text)',
 $a$if o.stage not in ('application_signed', 'references_pending') then raise exception$a$,
 $a$if o.stage not in ('application_signed', 'references_pending', 'references_received', 'resubmitted', 'references_approved', 'agreement_sent', 'agreement_signed') then raise exception$a$);
select pg_temp.patch('public.agency_onboarding_referee_request_create(uuid, jsonb)',
 $a$if o.stage not in ('application_signed', 'references_pending', 'resubmitted') then raise exception$a$,
 $a$if o.stage not in ('application_signed', 'references_pending', 'references_received', 'resubmitted', 'references_approved', 'agreement_sent', 'agreement_signed') then raise exception$a$);

-- ------------------------------------------------------------------ Approve on a combined onboarding: the signed agreement is issued
create or replace function public.agency_onboarding_agreement_issue(p_onboarding uuid, p_base64 text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; g public.agents; v bytea;
begin
 perform hr.require_admin();
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if not o.combined then raise exception 'This onboarding sends its agreement separately.' using errcode = '22023'; end if;
 if o.stage = 'agreement_signed' then
  select * into a from public.agencies where id = o.agency_id; select * into g from public.agents where id = o.agent_id;
  return jsonb_build_object('id', o.id, 'stage', o.stage, 'already', true, 'name', a.name, 'contact', jsonb_build_object('name', g.full_name, 'email', g.email)); end if;
 if o.stage <> 'references_approved' then raise exception 'Approve the application first.' using errcode = '22023'; end if;
 begin v := decode(coalesce(p_base64, ''), 'base64'); exception when others then raise exception 'The agreement could not be stored' using errcode = '22023'; end;
 if length(v) < 5 or substring(v from 1 for 4) <> '\x25504446'::bytea then raise exception 'The agreement could not be stored' using errcode = '22023'; end if;
 update public.agency_onboarding set agreement_content = v, stage = 'agreement_signed', status = 'signed', signed_at = coalesce(signed_at, application_signed_at, now()),
  admin_name = public.agency_onboarding_clean(p_data->>'admin_name', 150), admin_position = public.agency_onboarding_clean(p_data->>'admin_position', 150),
  agreement_issued_at = now(), agreement_issued_by = auth.uid() where id = o.id returning * into o;
 update public.agencies set agreement_status = 'signed', agreement_commencement_date = o.commencement_date, agreement_expiry_date = o.expiry_date, agreement_onboarding_id = o.id, updated_at = now()
  where id = o.agency_id returning * into a;
 select * into g from public.agents where id = o.agent_id;
 perform public.agency_onboarding_log(o.id, 'agreement_issued', jsonb_build_object('signatory', o.admin_name, 'position', o.admin_position, 'witness', nullif(public.agency_onboarding_clean(p_data->>'admin_witness_name', 150), ''),
  'commencement', o.commencement_date, 'expiry', o.expiry_date, 'signedBy', o.signer_name, 'signedAt', o.signed_at));
 perform public.admin_business_audit('agent_agreement_signed', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'signer', o.signer_name, 'countersigned', o.admin_name, 'combined', true));
 return jsonb_build_object('id', o.id, 'stage', o.stage, 'name', a.name, 'commencementDate', o.commencement_date, 'expiryDate', o.expiry_date,
  'contact', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email));
end $f$;
revoke all on function public.agency_onboarding_agreement_issue(uuid, text, jsonb) from public, anon;
grant execute on function public.agency_onboarding_agreement_issue(uuid, text, jsonb) to authenticated;

-- ------------------------------------------------------------------ the business status in words
create or replace function public.agency_onboarding_label(p_business uuid) returns text
language sql stable security definer set search_path = pg_catalog, public as $f$
 select case
  when a.id is null or coalesce(a.is_direct, false) or o.id is null or o.stage = 'legacy' then null
  when o.stage = 'draft' then 'Not sent yet'
  when o.stage = 'application_sent' then 'Application sent'
  when o.stage in ('application_signed', 'references_pending') and o.combined then 'Ready for review'
  when o.stage in ('application_signed', 'references_pending') then 'Awaiting referees'
  when o.stage = 'references_received' then 'Ready for review'
  when o.stage = 'correction_requested' then 'Correction requested'
  when o.stage = 'resubmitted' then case when not o.combined and exists (select 1 from public.agency_onboarding_referees f where f.onboarding_id = o.id and f.status <> 'received') then 'Awaiting referees' else 'Resubmitted' end
  when a.status = 'Active' and o.stage in ('references_approved', 'agreement_sent', 'agreement_signed', 'activated') then 'Active'
  when o.stage = 'agreement_signed' then 'Ready to activate'
  when o.stage = 'agreement_sent' then 'Agreement sent'
  when o.stage = 'references_approved' then 'Approved'
  when o.stage = 'declined' then 'Declined'
  when o.stage = 'cancelled' then 'Cancelled'
  when o.stage = 'expired' then 'Expired' end
 from public.agencies a left join lateral (select * from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business' order by x.created_at desc limit 1) o on true
 where a.id = p_business;
$f$;

-- ------------------------------------------------------------------ what the CMS and the emails read
select pg_temp.patch('public.agency_onboarding_list(uuid)', $a$'files', jsonb_build_object('form', o.form_content is not null,$a$,
 $a$'combined', o.combined, 'signatureEvent', o.signature_event, 'agreementIssuedAt', o.agreement_issued_at,
   'witness', case when o.witness_name is null then null else jsonb_build_object('name', o.witness_name, 'by', o.witness_by) end,
   'presendSavedAt', o.presend_saved_at,
   'files', jsonb_build_object('form', o.form_content is not null,$a$);
select pg_temp.patch('public.agency_onboarding_review_get(uuid)', $a$'answers', coalesce(o.answers, '{}'::jsonb), 'facts', a.profile->'abr_facts',$a$,
 $a$'combined', o.combined, 'terms', jsonb_build_object('commencementDate', o.commencement_date, 'expiryDate', o.expiry_date, 'territory', o.territory, 'commissionPercent', o.commission_percent),
  'witness', case when o.witness_name is null then null else jsonb_build_object('name', o.witness_name, 'by', o.witness_by, 'png', o.witness_png) end, 'signatureEvent', o.signature_event,
  'answers', coalesce(o.answers, '{}'::jsonb), 'facts', a.profile->'abr_facts',$a$);
-- The review shows each referee's request (sent / completed / not completed) with a resend.
select pg_temp.patch('public.agency_onboarding_review_get(uuid)', $a$'email', f.email, 'phone', f.phone, 'status', f.status, 'receivedAt', f.received_at,$a$,
 $a$'email', f.email, 'phone', f.phone, 'status', f.status, 'request', public.agency_onboarding_request_json(f.request_id), 'receivedAt', f.received_at,$a$);
select pg_temp.patch('public.agency_onboarding_followup(uuid)', $a$'id', o.id, 'kind', o.kind, 'stage', o.stage, 'status', o.status,$a$,
 $a$'id', o.id, 'kind', o.kind, 'stage', o.stage, 'status', o.status, 'combined', o.combined,$a$);

-- Needs action today: a combined application is ready for review as soon as it is signed (referees may still be pending).
select pg_temp.patch('public.admin_today()', $a$(o.stage = 'references_received' or (o.stage = 'resubmitted'$a$,
 $a$(o.stage = 'references_received' or (o.combined and o.stage in ('application_signed', 'references_pending')) or (o.stage = 'resubmitted'$a$, 2);
select pg_temp.patch('public.admin_today()', $a$case when o.stage = 'resubmitted' then 'Resubmitted: review the corrections' else$a$,
 $a$case when o.stage = 'resubmitted' then 'Resubmitted: review the corrections' when o.stage in ('application_signed', 'references_pending') then 'Ready for review: application and agreement signed' else$a$);
