-- The individual agent agreement is the "Agent Agreement" (P06) PDF, countersigned by SLIT (owner decisions 2026-11-18):
--   * agent_agreement_individual_template_create: a copy of the installed P06 template (system_key agent_agreement, untouched) as type
--     "Individual agent agreement", Active, signers Agent then SLIT. Printed at Send: [Agent Organisation] (business name), ABN, Item 1
--     (the business agreement's commencement), Item 3 territory, Item 4 commission (both from the business's signed agreement), the agent's
--     name and position "Agent". The agent signs and dates; a SLIT administrator countersigns (officer name from their signature, position
--     typed, required; date filled on signing). Witness lines are left blank (not in the copy). The function copies the source file first.
--   * agent_agreement_schedule: what Send prints from the business; refuses a business without an ABN or without a signed agreement that
--     has a commencement date, territory and commission (never guessed, never blank).
--   * Any CMS administrator can countersign: agency_onboarding_agent_countersign_claim makes the caller the SLIT signer once the agent has
--     signed (the earlier signer's links stop working; no email, the caller opens it at once). The function emails every active
--     administrator when the agent has signed.
--   * Nothing here updates an existing row.
set local lock_timeout = '5s';

-- ------------------------------------------------------------------ the template (service role / owner only)
create or replace function public.agent_agreement_individual_template_create(p_id uuid, p_source_path text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare s hr.sign_templates; t hr.sign_templates; v_fields jsonb := '[]'::jsonb; f jsonb; k text;
begin
 select * into t from hr.sign_templates where category = 'individual_agent_agreement' and name = 'Individual Agent Agreement' and deleted_at is null order by created_at limit 1;
 if found then return jsonb_build_object('id', t.id, 'created', false, 'status', t.status); end if;
 select * into s from hr.sign_templates where system_key = 'agent_agreement' and deleted_at is null and kind = 'pdf' limit 1;
 if not found then raise exception 'The Agent Agreement (P06) template is not installed'; end if;
 if p_source_path is null or p_source_path not like 'templates/' || p_id::text || '/%' then raise exception 'Copy the P06 source file under templates/%/ first', p_id; end if;
 for f in select * from jsonb_array_elements(s.fields) loop
  k := f->>'key';
  if k in ('admin_witness_name', 'admin_witness_signature', 'agent_witness_name', 'agent_witness_signature') then continue; end if;
  f := case k
   when 'agent_signatory_name' then f || jsonb_build_object('role', 'sender', 'type', 'text', 'value', '{{agent_signatory_name}}', 'required', false)
   when 'agent_signatory_position' then f || jsonb_build_object('role', 'sender', 'type', 'text', 'value', 'Agent', 'required', false)
   when 'admin_name' then f || jsonb_build_object('role', 'slit', 'type', 'name', 'value', '', 'required', true, 'label', 'SLIT officer name')
   when 'admin_position' then f || jsonb_build_object('role', 'slit', 'type', 'text', 'value', '', 'required', true, 'label', 'Position (SLIT officer)')
   when 'admin_signature' then f || jsonb_build_object('role', 'slit', 'type', 'signature', 'value', '', 'required', true, 'label', 'SLIT signature')
   when 'admin_signed_date' then f || jsonb_build_object('role', 'slit', 'type', 'date', 'value', '', 'required', false, 'label', 'SLIT signed date')
   else f end;
  v_fields := v_fields || jsonb_build_array(f);
 end loop;
 insert into hr.sign_templates(id, name, title, created_by, kind, audience, category, status, source_path, source_hash, source_pages, roles, fields, signing_mode, expiry_days, reminder_days)
 values (p_id, 'Individual Agent Agreement', 'Individual Agent Agreement (P06)', s.created_by, 'pdf', 'agent', 'individual_agent_agreement', 'active', p_source_path, s.source_hash, s.source_pages,
  '[{"key": "agent", "label": "Agent", "order": 1, "required": true}, {"key": "slit", "label": "SLIT", "order": 2, "required": true}]'::jsonb, v_fields, 'sequential', s.expiry_days, s.reminder_days)
 returning * into t;
 return jsonb_build_object('id', t.id, 'created', true, 'status', t.status, 'fields', jsonb_array_length(t.fields), 'from', s.id, 'sourceHash', s.source_hash);
end $f$;
revoke all on function public.agent_agreement_individual_template_create(uuid, text) from public, anon, authenticated;
grant execute on function public.agent_agreement_individual_template_create(uuid, text) to service_role;

-- ------------------------------------------------------------------ what Send prints from the business
create or replace function public.agent_agreement_schedule(p_onboarding uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare o public.agency_onboarding; a public.agencies; g public.agents; b public.agency_onboarding;
begin
 if coalesce(auth.role(), '') <> 'service_role' then perform public.admin_business_require(); end if;
 select * into o from public.agency_onboarding where id = p_onboarding;
 if not found or o.kind <> 'agent' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 select * into a from public.agencies where id = o.agency_id;
 select * into g from public.agents where id = o.agent_id;
 if nullif(regexp_replace(coalesce(a.registration_number, ''), '\D', '', 'g'), '') is null then
  raise exception '% has no ABN: add it on the business before sending the agreement.', a.name using errcode = '23514', hint = 'agent_agreement_abn_missing'; end if;
 select * into b from public.agency_onboarding x where x.agency_id = a.id and x.kind = 'business' and (x.stage = 'agreement_signed' or (x.stage = 'legacy' and x.status = 'signed'))
  order by x.signed_at desc nulls last, x.created_at desc limit 1;
 if b.id is null or b.commencement_date is null or nullif(btrim(coalesce(b.territory, '')), '') is null or b.commission_percent is null then
  raise exception '% has no signed agreement with a commencement date, territory and commission to copy: the agent''s agreement cannot be prefilled.', a.name
   using errcode = '23514', hint = 'agent_agreement_schedule_missing'; end if;
 return jsonb_build_object('businessName', a.name, 'abn', a.registration_number, 'commencementDate', b.commencement_date, 'expiryDate', b.expiry_date, 'territory', b.territory,
  'commissionPercent', b.commission_percent, 'agentName', g.full_name, 'businessOnboardingId', b.id);
end $f$;
revoke all on function public.agent_agreement_schedule(uuid) from public, anon;
grant execute on function public.agent_agreement_schedule(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ any administrator countersigns
create or replace function public.agency_onboarding_agent_countersigner_set(p_onboarding uuid, p_cms_user text, p_invite boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; k hr.sign_recipients; u public.cms_users; v_turn boolean; v_n integer;
begin
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.kind <> 'agent' or o.stage <> 'agreement_sent' or o.agreement_request_id is null then raise exception 'This agreement is not waiting for SLIT''s signature' using errcode = '22023'; end if;
 select * into r from hr.sign_requests where id = o.agreement_request_id for update;
 if r.state not in ('sent', 'viewed', 'partial', 'email_failed') then raise exception 'This agreement is not waiting for a signature' using errcode = '22023'; end if;
 select * into k from hr.sign_recipients where request_id = r.id and signing_order = 2 for update;
 if k.id is null or k.state not in ('pending', 'sent', 'viewed') then raise exception 'SLIT has already signed this agreement' using errcode = '22023'; end if;
 select * into u from public.cms_users where id = p_cms_user and role = 'Admin' and status = 'Active' and auth_user_id is not null and coalesce(btrim(email), '') <> '';
 if not found then raise exception 'Choose an active CMS administrator' using errcode = '22023'; end if;
 if lower(u.email) = lower(k.email) then return jsonb_build_object('id', o.id, 'changed', false, 'recipientId', k.id, 'countersigner', jsonb_build_object('name', k.name, 'email', k.email)); end if;
 if lower(u.email) = lower(coalesce((select x.email from hr.sign_recipients x where x.request_id = r.id and x.signing_order = 1), '')) then raise exception 'The agent cannot countersign for SLIT' using errcode = '22023'; end if;
 v_turn := k.state in ('sent', 'viewed');
 delete from hr.sign_tokens where recipient_id = k.id;
 update hr.sign_notifications set state = 'cancelled' where recipient_id = k.id and state in ('queued', 'sending');
 update hr.sign_recipients set name = left(u.name, 150), email = lower(btrim(u.email)), state = case when v_turn then 'sent' else state end, viewed_at = null,
  last_notified_at = case when v_turn then now() else last_notified_at end, reminder_count = 0, delivery_error = null where id = k.id;
 if v_turn and p_invite then
  select count(*) + 1 into v_n from hr.sign_notifications where recipient_id = k.id and kind = 'invite';
  perform hr.sign_queue(r.id, k.id, 'invite', 'invite:' || k.id || ':' || v_n || ':changed');
 end if;
 perform hr.sign_event(r.id, 'recipient_changed', k.id, auth.uid(), jsonb_build_object('from', k.email, 'to', lower(u.email), 'role', k.role_label, 'claimed', not p_invite));
 perform public.agency_onboarding_log(o.id, case when p_invite then 'countersigner_changed' else 'countersign_claimed' end, jsonb_build_object('from', k.name, 'to', u.name, 'email', lower(u.email), 'invited', v_turn and p_invite));
 return jsonb_build_object('id', o.id, 'changed', true, 'invited', v_turn and p_invite, 'recipientId', k.id, 'countersigner', jsonb_build_object('name', u.name, 'email', lower(u.email)));
end $f$;
revoke all on function public.agency_onboarding_agent_countersigner_set(uuid, text, boolean) from public, anon, authenticated;

create or replace function public.agency_onboarding_agent_countersigner_change(p_onboarding uuid, p_cms_user text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
begin
 perform public.admin_business_require();
 perform hr.require_admin();
 return public.agency_onboarding_agent_countersigner_set(p_onboarding, p_cms_user, true);
end $f$;
revoke all on function public.agency_onboarding_agent_countersigner_change(uuid, text) from public, anon;
grant execute on function public.agency_onboarding_agent_countersigner_change(uuid, text) to authenticated;

-- Countersign (any administrator): once the agent has signed, the caller becomes the SLIT signer and opens it themselves.
create or replace function public.agency_onboarding_agent_countersign_claim(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare v_me text; r hr.sign_requests;
begin
 perform public.admin_business_require();
 select u.id into v_me from public.cms_users u where u.auth_user_id = auth.uid() and u.role = 'Admin' and u.status = 'Active' limit 1;
 if v_me is null then raise exception 'Only a CMS administrator can countersign for SLIT' using errcode = '42501'; end if;
 select q.* into r from hr.sign_requests q join public.agency_onboarding o on o.agreement_request_id = q.id where o.id = p_onboarding;
 if r.id is null or r.state <> 'partial' then raise exception 'The agent has not signed this agreement yet' using errcode = '22023'; end if;
 return public.agency_onboarding_agent_countersigner_set(p_onboarding, v_me, false);
end $f$;
revoke all on function public.agency_onboarding_agent_countersign_claim(uuid) from public, anon;
grant execute on function public.agency_onboarding_agent_countersign_claim(uuid) to authenticated;
