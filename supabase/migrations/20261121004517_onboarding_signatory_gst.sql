-- Agency onboarding (owner 2026-11-21): (1) the SLIT signatory block on the agreement is filled when SLIT sends the application, not left
-- blank until approval: the sending SLIT admin's name and position, their signature (saved / drawn / typed, as on Approve) and the send date
-- (Melbourne). (2) GST on the commission: "GST inclusive" / "GST exclusive", set only by SLIT staff in Prepare application (these
-- functions require hr.require_admin), required before sending, printed with the percentage everywhere ("15% (GST exclusive)").
-- Existing onboardings keep commission_gst empty (never guessed); a draft must choose before it is sent. Onboardings sent before this
-- keep the earlier behaviour: their SLIT signatory is added at Approve.
-- Functions replaced from their live definitions (pg_get_functiondef, 2026-11-21): agency_onboarding_presend_get / _presend_save /
-- _presend_send / _combined_plan / _review_get / _list. Only the lines marked SIGNATORY-GST change.

alter table public.agency_onboarding
  add column if not exists commission_gst text check (commission_gst is null or commission_gst in ('inclusive', 'exclusive')),
  add column if not exists slit_signature text,
  add column if not exists slit_signature_kind text check (slit_signature_kind is null or slit_signature_kind in ('drawn', 'typed')),
  add column if not exists slit_signed_on date;

-- The SLIT signatory block of an onboarding as the screens show it (null until SLIT has signed): organisation, name, position, signature, date.
create or replace function public.agency_onboarding_slit_signatory(p_onboarding uuid)
 returns jsonb language sql stable security definer set search_path to pg_catalog, public
as $$
 select case when o.slit_signature is null then null else jsonb_build_object(
   'organisation', coalesce((select nullif(btrim(s.legal_name), '') from public.cms_settings s limit 1), 'INDOPACIFIC GLOBAL PTY LTD'),
   'name', o.admin_name, 'position', o.admin_position, 'kind', o.slit_signature_kind,
   'image', case when o.slit_signature_kind = 'drawn' then 'data:image/png;base64,' || o.slit_signature end,
   'typed', case when o.slit_signature_kind = 'typed' then o.slit_signature end,
   'signedOn', o.slit_signed_on) end
 from public.agency_onboarding o where o.id = p_onboarding;
$$;
revoke all on function public.agency_onboarding_slit_signatory(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.agency_onboarding_presend_get(p_agency uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'hr'
AS $function$
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
  'terms', jsonb_build_object('commencementDate', o.commencement_date, 'territory', coalesce(o.territory, ''), 'commissionPercent', o.commission_percent,
   'commissionGst', o.commission_gst), -- SIGNATORY-GST
  'witness', jsonb_build_object('name', o.slit_witness_name, 'png', o.slit_witness_png),
  -- SIGNATORY-GST: the SLIT signatory kept with the draft (name, position) and the organisation printed on the agreement.
  'signatory', jsonb_build_object('name', o.admin_name, 'position', o.admin_position),
  'organisation', coalesce((select nullif(btrim(s.legal_name), '') from public.cms_settings s limit 1), 'INDOPACIFIC GLOBAL PTY LTD'),
  'savedAt', o.presend_saved_at, 'savedBy', (select u.name from public.cms_users u where u.auth_user_id = o.presend_saved_by limit 1));
end $function$;

CREATE OR REPLACE FUNCTION public.agency_onboarding_presend_save(p_agency uuid, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'hr'
AS $function$
declare a public.agencies; g public.agents; o public.agency_onboarding; e record; v_answers jsonb := '{}'::jsonb; v_start date; v_end date; v_pct numeric; v_wname text; v_wpng text;
 v_acn text; v_marn text; v_png bytea; v_new boolean := false; v_gst text;
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
 if nullif(btrim(coalesce(p_data->>'commencementDate', '')), '') is not null then
  begin v_start := (p_data->>'commencementDate')::date; v_end := public.agent_agreement_expiry(v_start); exception when others then raise exception 'Enter the commencement date' using errcode = '22023'; end;
  if v_end is null or v_end <= v_start then raise exception 'Enter the commencement date' using errcode = '22023'; end if;
 end if;
 if nullif(btrim(coalesce(p_data->>'commissionPercent', '')), '') is not null then
  begin v_pct := (regexp_replace(p_data->>'commissionPercent', '[^0-9.]', '', 'g'))::numeric; exception when others then raise exception 'Enter the commission as a percentage' using errcode = '22023'; end;
  if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage' using errcode = '22023'; end if;
  perform public.agents_commission_check(v_pct);
 end if;
 -- SIGNATORY-GST: GST inclusive / exclusive, or not chosen yet (a draft may wait; Send refuses).
 v_gst := nullif(lower(btrim(coalesce(p_data->>'commissionGst', ''))), '');
 if v_gst is not null and v_gst not in ('inclusive', 'exclusive') then raise exception 'Choose GST inclusive or GST exclusive for the commission.' using errcode = '22023'; end if;
 -- The SLIT witness: a typed name and a DRAWN signature together, or neither (the approver may add it when approving).
 v_wname := nullif(public.agency_onboarding_clean(p_data->>'witnessName', 150), '');
 v_wpng := nullif(regexp_replace(coalesce(p_data->>'witnessPng', ''), '^data:image/png;base64,', ''), '');
 if v_wpng is not null then
  begin v_png := decode(v_wpng, 'base64'); exception when others then raise exception 'The SLIT witness signature could not be read. Draw it again.' using errcode = '22023'; end;
  if length(v_png) < 8 or substring(v_png from 1 for 8) <> '\x89504e470d0a1a0a'::bytea or length(v_wpng) > 400000 then raise exception 'The SLIT witness signature could not be read. Draw it again.' using errcode = '22023'; end if;
 end if;
 if (v_wname is null) <> (v_wpng is null) then
  raise exception 'Give the SLIT witness''s name and have the witness draw the signature, or leave both empty.' using errcode = '22023'; end if;
 if v_wname is not null and char_length(v_wname) < 2 then raise exception 'Enter the SLIT witness''s full name.' using errcode = '22023'; end if;
 select * into o from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business' and x.stage = 'draft' order by x.created_at desc limit 1 for update;
 if o.id is null then
  insert into public.agency_onboarding(agency_id, agent_id, stage, status, form_pages, sent_by, combined)
  values (a.id, g.id, 'draft', 'sent', 1, auth.uid(), true) returning * into o;
  v_new := true;
 end if;
 update public.agency_onboarding set agent_id = g.id, combined = true,
  presend = jsonb_strip_nulls(jsonb_build_object('answers', v_answers, 'acn', nullif(v_acn, ''), 'marn', nullif(v_marn, ''), 'message', nullif(public.agency_onboarding_clean(p_data->>'message', 2000), ''))),
  commencement_date = v_start, expiry_date = v_end, territory = public.agency_onboarding_clean(p_data->>'territory', 200), commission_percent = v_pct,
  commission_gst = v_gst, -- SIGNATORY-GST
  admin_name = nullif(public.agency_onboarding_clean(p_data->>'adminName', 150), ''), admin_position = nullif(public.agency_onboarding_clean(p_data->>'adminPosition', 150), ''), -- SIGNATORY-GST
  slit_witness_name = v_wname, slit_witness_png = v_wpng, presend_saved_at = now(), presend_saved_by = auth.uid() where id = o.id returning * into o;
 perform public.agency_onboarding_log(o.id, case when v_new then 'draft_created' else 'draft_saved' end, jsonb_build_object('answers', (select count(*) from jsonb_object_keys(v_answers)), 'slitWitness', v_wpng is not null, 'terms', v_start is not null));
 return jsonb_build_object('onboardingId', o.id, 'stage', o.stage, 'savedAt', o.presend_saved_at, 'contact', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email));
end $function$;

CREATE OR REPLACE FUNCTION public.agency_onboarding_presend_send(p_onboarding uuid, p_request uuid, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'hr'
AS $function$
declare o public.agency_onboarding; g public.agents; r hr.sign_requests; v_name text; v_position text; v_kind text; v_sig text; v_on date; v_png bytea;
begin
 perform hr.require_admin();
 p_data := coalesce(p_data, '{}'::jsonb);
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage <> 'draft' then raise exception 'This application has already been sent.' using errcode = '22023'; end if;
 if o.commencement_date is null or o.expiry_date is null or btrim(o.territory) = '' or o.commission_percent is null then
  raise exception 'Enter the agreement''s commencement date, territory and commission before sending.' using errcode = '22023'; end if;
 -- SIGNATORY-GST: the GST choice is required; the SLIT signatory (name, position, signature, date) is signed now.
 if o.commission_gst is null then raise exception 'Choose GST inclusive or GST exclusive for the commission before sending.' using errcode = '22023'; end if;
 v_name := nullif(public.agency_onboarding_clean(p_data->>'admin_name', 150), '');
 v_position := nullif(public.agency_onboarding_clean(p_data->>'admin_position', 150), '');
 v_kind := p_data->>'slit_signature_kind';
 v_sig := nullif(btrim(coalesce(p_data->>'slit_signature', '')), '');
 if v_name is null or char_length(v_name) < 2 then raise exception 'Enter the name of the SLIT signatory.' using errcode = '22023'; end if;
 if v_position is null then raise exception 'Enter the position of the SLIT signatory.' using errcode = '22023'; end if;
 if v_kind is null or v_kind not in ('drawn', 'typed') or v_sig is null then raise exception 'Add the SLIT signature before sending.' using errcode = '22023'; end if;
 if v_kind = 'drawn' then
  v_sig := regexp_replace(v_sig, '^data:image/png;base64,', '');
  begin v_png := decode(v_sig, 'base64'); exception when others then raise exception 'The SLIT signature could not be read. Draw it again.' using errcode = '22023'; end;
  if length(v_png) < 8 or substring(v_png from 1 for 8) <> '\x89504e470d0a1a0a'::bytea or length(v_sig) > 400000 then raise exception 'The SLIT signature could not be read. Draw it again.' using errcode = '22023'; end if;
 else v_sig := left(v_sig, 150); end if;
 begin v_on := (p_data->>'signed_on')::date; exception when others then v_on := null; end;
 if v_on is null or abs(v_on - (now() at time zone 'Australia/Melbourne')::date) > 1 then v_on := (now() at time zone 'Australia/Melbourne')::date; end if;
 select * into g from public.agents where id = o.agent_id;
 select * into r from hr.sign_requests where id = p_request for update;
 if not found or r.state <> 'draft' or r.subject_type is distinct from 'agent' or r.subject_id is distinct from g.id or r.agency_onboarding_id is not null then
  raise exception 'The signing request does not match this business''s point of contact'; end if;
 update public.agency_onboarding set application_request_id = r.id, stage = 'application_sent', status = 'sent', combined = true,
  form_pages = greatest(coalesce((p_data->>'form_pages')::integer, 1), 1), sent_values = coalesce(p_data->'values', '{}'::jsonb), sent_by = auth.uid(),
  message = nullif(public.agency_onboarding_clean(p_data->>'message', 2000), ''), admin_name = v_name, admin_position = v_position, -- SIGNATORY-GST
  slit_signature = v_sig, slit_signature_kind = v_kind, slit_signed_on = v_on, -- SIGNATORY-GST
  witness_box = case when jsonb_typeof(p_data->'witness_box') = 'object' then p_data->'witness_box' end, created_at = now()
 where id = o.id returning * into o;
 update hr.sign_requests set agency_onboarding_id = o.id where id = r.id;
 update public.agencies set agreement_onboarding_id = o.id, updated_at = now() where id = o.agency_id and agreement_status <> 'signed';
 perform public.agency_onboarding_log(o.id, 'application_sent', jsonb_build_object('request', r.reference, 'agent', g.id, 'email', g.email, 'combined', true, 'witness', o.witness_by,
  'commencement', o.commencement_date, 'territory', o.territory, 'commission', o.commission_percent, 'commissionGst', o.commission_gst, 'slitSignatory', o.admin_name)); -- SIGNATORY-GST
 perform public.admin_business_audit('agent_onboarding_sent', o.agency_id, o.agency_id, jsonb_build_object('onboarding', o.id, 'request', r.reference, 'agent', g.id, 'email', g.email, 'document', 'application_and_agreement'));
 return jsonb_build_object('id', o.id, 'requestId', r.id, 'reference', r.reference, 'stage', o.stage);
end $function$;

CREATE OR REPLACE FUNCTION public.agency_onboarding_combined_plan(p_onboarding uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 select case when o.combined then jsonb_build_object('combined', true,
  'agreement', jsonb_build_object('commencementDate', o.commencement_date, 'expiryDate', o.expiry_date, 'territory', o.territory, 'commissionPercent', o.commission_percent,
   'commissionGst', o.commission_gst, 'slitSignatory', public.agency_onboarding_slit_signatory(o.id)), -- SIGNATORY-GST
  'witness', jsonb_build_object('preset', o.witness_png is not null, 'name', o.witness_name, 'by', o.witness_by,
   'image', case when o.witness_png is null then null else 'data:image/png;base64,' || o.witness_png end, 'box', o.witness_box),
  'slitWitness', o.slit_witness_name)
  else jsonb_build_object('combined', false) end
 from public.agency_onboarding o where o.id = p_onboarding;
$function$;

CREATE OR REPLACE FUNCTION public.agency_onboarding_review_get(p_onboarding uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'hr'
AS $function$
declare o public.agency_onboarding; a public.agencies; g public.agents; k public.agency_onboarding_corrections;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.application_signed_at is null then raise exception 'The application form is not signed yet' using errcode = '22023'; end if;
 select * into a from public.agencies where id = o.agency_id;
 select * into g from public.agents where id = o.agent_id;
 select * into k from public.agency_onboarding_corrections c where c.onboarding_id = o.id and c.status = 'open';
 return jsonb_build_object('onboardingId', o.id, 'stage', o.stage, 'label', public.agency_onboarding_label(a.id),
  'agency', jsonb_build_object('id', a.id, 'name', a.name, 'abn', a.registration_number, 'status', a.status),
  'contact', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role),
  'requestId', o.application_request_id, 'signerName', o.signer_name, 'signedAt', o.application_signed_at,
  -- The form's structure comes from the first signed request (a correction request has the same fields).
  'fields', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'key', f.key, 'type', f.type, 'label', f.label, 'required', f.required, 'page', f.page) order by f.page, f.y, f.x)
   from hr.sign_fields f where f.request_id = coalesce((select c.previous_request_id from public.agency_onboarding_corrections c where c.onboarding_id = o.id order by c.round limit 1), o.application_request_id)
    and f.key is not null and f.type in ('text', 'checkbox')), '[]'::jsonb),
  'combined', o.combined, 'terms', jsonb_build_object('commencementDate', o.commencement_date, 'expiryDate', o.expiry_date, 'territory', o.territory, 'commissionPercent', o.commission_percent,
   'commissionGst', o.commission_gst), -- SIGNATORY-GST
  'slitSignatory', public.agency_onboarding_slit_signatory(o.id), -- SIGNATORY-GST
  'witness', case when o.witness_name is null then null else jsonb_build_object('name', o.witness_name, 'by', o.witness_by, 'png', o.witness_png) end,
  'slitWitness', case when o.slit_witness_name is null then null else jsonb_build_object('name', o.slit_witness_name, 'png', o.slit_witness_png) end, 'signatureEvent', o.signature_event, 'acn', a.acn, 'acnSource', a.acn_source,
  'agencySignature', (select jsonb_build_object('name', r.signer_name, 'kind', r.signature_kind, 'image', r.signature_image, 'signedAt', r.signed_at)
   from hr.sign_recipients r where r.request_id = o.application_request_id and r.signed_at is not null order by (r.role_key = 'agent') desc, r.signed_at desc limit 1),
  'answers', coalesce(o.answers, '{}'::jsonb), 'facts', a.profile->'abr_facts',
  'attachments', coalesce((select jsonb_object_agg(x.kind, jsonb_build_object('name', x.file_name, 'size', x.size_bytes, 'at', x.uploaded_at))
   from public.agency_onboarding_attachments x where x.request_id = o.application_request_id), '{}'::jsonb),
  'referees', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'position', f.position, 'name', f.contact_name, 'organisation', f.organisation, 'positionTitle', f.position_title,
    'email', f.email, 'phone', f.phone, 'status', f.status, 'request', public.agency_onboarding_request_json(f.request_id), 'receivedAt', f.received_at, 'receivedVia', f.received_via, 'answers', f.answers) order by f.position)
   from public.agency_onboarding_referees f where f.onboarding_id = o.id), '[]'::jsonb),
  'correction', case when k.id is null then null else jsonb_build_object('round', k.round, 'message', k.message, 'flags', k.flags, 'requestedAt', k.requested_at, 'by', k.requested_by_name) end);
end $function$;

CREATE OR REPLACE FUNCTION public.agency_onboarding_list(p_agency uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'hr'
AS $function$
begin
 perform public.admin_business_require();
 return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'status', o.status, 'stage', o.stage, 'createdAt', o.created_at, 'signedAt', o.signed_at, 'signerName', o.signer_name, 'closedReason', o.closed_reason,
   'applicationSignedAt', o.application_signed_at, 'referencesReceivedAt', o.references_received_at, 'message', o.message,
   'commencementDate', o.commencement_date, 'expiryDate', o.expiry_date, 'territory', o.territory, 'commissionPercent', o.commission_percent, 'adminName', o.admin_name, 'adminPosition', o.admin_position,
   'commissionGst', o.commission_gst, -- SIGNATORY-GST
   'slitSignatory', case when o.slit_signature is null then null else jsonb_build_object('name', o.admin_name, 'position', o.admin_position, 'signedOn', o.slit_signed_on) end, -- SIGNATORY-GST
   'approval', case when o.approved_at is null then null else jsonb_build_object('at', o.approved_at, 'by', (select name from public.cms_users u where u.auth_user_id = o.approved_by limit 1)) end, 'decline', case when o.declined_at is null then null else jsonb_build_object('at', o.declined_at, 'reason', o.decline_reason, 'by', (select name from public.cms_users u where u.auth_user_id = o.declined_by limit 1)) end, 'activation', case when o.activated_at is null then null else jsonb_build_object('at', o.activated_at, 'invitationId', o.activation_invitation_id, 'invitationStatus', (select i.status from public.agency_invitations i where i.id = o.activation_invitation_id)) end, 'override', case when o.override_reason is null then null else jsonb_build_object('reason', o.override_reason, 'at', o.override_at, 'by', (select name from public.cms_users u where u.auth_user_id = o.override_by limit 1)) end,
   'agent', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email, 'role', g.role, 'status', g.status), 'answers', o.answers,
   'request', public.agency_onboarding_request_json(o.request_id),
   'application', public.agency_onboarding_request_json(o.application_request_id),
   'agreement', public.agency_onboarding_request_json(o.agreement_request_id), 'countersign', case when o.kind <> 'agent' or o.agreement_request_id is null then null else (select jsonb_build_object('recipientId', k.id, 'name', k.name, 'email', k.email, 'state', k.state,
   'signedAt', k.signed_at, 'mine', lower(k.email) = (select lower(u.email) from auth.users u where u.id = auth.uid())) from hr.sign_recipients k where k.request_id = o.agreement_request_id and k.signing_order = 2 limit 1) end,
  'agreementUpload', case when o.agreement_uploaded_at is null then null else jsonb_build_object('at', o.agreement_uploaded_at,
   'reason', o.agreement_upload_reason, 'fileName', o.agreement_file_name, 'by', (select name from public.cms_users u where u.auth_user_id = o.agreement_uploaded_by limit 1)) end,
   'referees', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'position', f.position, 'name', f.contact_name, 'organisation', f.organisation, 'positionTitle', f.position_title, 'email', f.email,
     'phone', f.phone, 'status', f.status, 'domainWarning', f.domain_warning, 'receivedAt', f.received_at, 'receivedVia', f.received_via, 'fileName', f.file_name,
     'files', jsonb_build_object('form', f.form_content is not null, 'certificate', false), 'answers', f.answers,
     'request', public.agency_onboarding_request_json(f.request_id)) order by f.position) from public.agency_onboarding_referees f where f.onboarding_id = o.id), '[]'::jsonb),
   'label', public.agency_onboarding_label(o.agency_id),
   'corrections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'round', c.round, 'message', c.message, 'flags', c.flags, 'status', c.status, 'changes', c.changes, 'by', c.requested_by_name,
     'requestedAt', c.requested_at, 'resubmittedAt', c.resubmitted_at, 'closedReason', c.closed_reason, 'request', public.agency_onboarding_request_json(c.request_id)) order by c.round) from public.agency_onboarding_corrections c where c.onboarding_id = o.id), '[]'::jsonb),
   'revisions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'revision', v.revision, 'kind', v.kind, 'note', v.note, 'changes', v.changes, 'by', v.created_by_name, 'at', v.created_at) order by v.revision) from public.agency_onboarding_revisions v where v.onboarding_id = o.id), '[]'::jsonb),
   'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'actor', e.actor_name, 'event', e.event, 'detail', e.detail) order by e.id) from (select * from public.agency_onboarding_events x where x.onboarding_id = o.id order by x.id desc limit 80) e), '[]'::jsonb),
   'combined', o.combined, 'signatureEvent', o.signature_event, 'agreementIssuedAt', o.agreement_issued_at,
   'witness', case when o.witness_name is null then null else jsonb_build_object('name', o.witness_name, 'by', o.witness_by) end,
   'slitWitness', case when o.slit_witness_name is null then null else jsonb_build_object('name', o.slit_witness_name) end,
   'presendSavedAt', o.presend_saved_at,
   'files', jsonb_build_object('form', o.form_content is not null, 'agreement', o.agreement_content is not null, 'certificate', false, 'application_certificate', false)) order by o.created_at desc)
  from public.agency_onboarding o join public.agents g on g.id = o.agent_id where o.agency_id = p_agency), '[]'::jsonb);
end $function$;
