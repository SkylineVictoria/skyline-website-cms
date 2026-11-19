-- Agency onboarding follow-up (owner 2026-11-20): the witness entered in Prepare application is the SLIT witness, not the agency's.
--
--   * Prepare application keeps a SLIT witness (typed name + DRAWN signature, both or neither) in slit_witness_name / slit_witness_png;
--     document-signing prints it on the agreement's SLIT witness line when the application is sent. Left empty, the approver may add the
--     SLIT witness (drawn) when approving; a SLIT witness given before sending is not asked for again.
--   * The agency admin always gives their own witness on the form (typed name + drawn signature). witness_name / witness_png / witness_by
--     now hold only that agent witness (witness_by = 'agent'); a correction re-prints it.
-- No row needed moving: no combined onboarding existed when this was written (checked on hosted 2026-11-20).
-- Additive: two columns; functions replaced (bodies from 20261120023517) or patched in place (single-line anchors, exact counts).
set local lock_timeout = '5s';

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_count integer default 1) returns void language plpgsql as $p$
declare d text := pg_get_functiondef(p_fn); k integer;
begin
 k := (length(d) - length(replace(d, p_old, ''))) / length(p_old);
 if k <> p_count then raise exception '%: anchor found % times (expected %): %', p_fn, k, p_count, left(p_old, 80); end if;
 execute replace(d, p_old, p_new);
end $p$;

alter table public.agency_onboarding
 add column if not exists slit_witness_name text check (slit_witness_name is null or char_length(slit_witness_name) between 2 and 150),
 add column if not exists slit_witness_png text check (slit_witness_png is null or (length(slit_witness_png) <= 400000 and slit_witness_png ~ '^[A-Za-z0-9+/]+=*$'));
comment on column public.agency_onboarding.slit_witness_png is 'The SLIT witness signature, drawn (PNG, base64), given by staff in Prepare application; printed on the agreement''s SLIT witness line.';
comment on column public.agency_onboarding.witness_png is 'The agent''s witness signature, drawn (PNG, base64) by the agency admin''s witness on the signing page.';
-- Any agent-witness value staff could have set under 20261120023517 belongs to SLIT now (none existed).
update public.agency_onboarding set slit_witness_name = witness_name, slit_witness_png = witness_png, witness_name = null, witness_png = null, witness_by = null where witness_by = 'admin';
alter table public.agency_onboarding drop constraint if exists agency_onboarding_witness_by_check;
alter table public.agency_onboarding add constraint agency_onboarding_witness_by_check check (witness_by is null or witness_by = 'agent');

-- ------------------------------------------------------------------ Prepare application: the SLIT witness
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
  'witness', jsonb_build_object('name', o.slit_witness_name, 'png', o.slit_witness_png),
  'savedAt', o.presend_saved_at, 'savedBy', (select u.name from public.cms_users u where u.auth_user_id = o.presend_saved_by limit 1));
end $f$;

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
  begin v_start := (p_data->>'commencementDate')::date; v_end := (p_data->>'expiryDate')::date; exception when others then raise exception 'Enter the commencement date' using errcode = '22023'; end;
  if v_end is null or v_end <= v_start then raise exception 'Enter the commencement date' using errcode = '22023'; end if;
 end if;
 if nullif(btrim(coalesce(p_data->>'commissionPercent', '')), '') is not null then
  begin v_pct := (regexp_replace(p_data->>'commissionPercent', '[^0-9.]', '', 'g'))::numeric; exception when others then raise exception 'Enter the commission as a percentage' using errcode = '22023'; end;
  if v_pct < 0 or v_pct > 100 then raise exception 'Enter the commission as a percentage' using errcode = '22023'; end if;
 end if;
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
  slit_witness_name = v_wname, slit_witness_png = v_wpng, presend_saved_at = now(), presend_saved_by = auth.uid() where id = o.id returning * into o;
 perform public.agency_onboarding_log(o.id, case when v_new then 'draft_created' else 'draft_saved' end, jsonb_build_object('answers', (select count(*) from jsonb_object_keys(v_answers)), 'slitWitness', v_wpng is not null, 'terms', v_start is not null));
 return jsonb_build_object('onboardingId', o.id, 'stage', o.stage, 'savedAt', o.presend_saved_at, 'contact', jsonb_build_object('id', g.id, 'name', g.full_name, 'email', g.email));
end $f$;

-- ------------------------------------------------------------------ the signing page: only the agent's witness (preset only on a correction)
create or replace function public.agency_onboarding_combined_plan(p_onboarding uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $f$
 select case when o.combined then jsonb_build_object('combined', true,
  'agreement', jsonb_build_object('commencementDate', o.commencement_date, 'expiryDate', o.expiry_date, 'territory', o.territory, 'commissionPercent', o.commission_percent),
  'witness', jsonb_build_object('preset', o.witness_png is not null, 'name', o.witness_name, 'by', o.witness_by,
   'image', case when o.witness_png is null then null else 'data:image/png;base64,' || o.witness_png end, 'box', o.witness_box),
  'slitWitness', o.slit_witness_name)
  else jsonb_build_object('combined', false) end
 from public.agency_onboarding o where o.id = p_onboarding;
$f$;

-- The agent's witness is always the agency admin's (the earlier 'admin' early return is gone).
select pg_temp.patch('public.agency_onboarding_witness_record(uuid, text, text)', $a$ if o.witness_by = 'admin' then return; end if;$a$, $a$ -- 2026-11-20: the agent's witness is always given on the signing page.$a$);

-- ------------------------------------------------------------------ Approve: say whether the SLIT witness is already on the agreement
create or replace function public.agency_onboarding_approve(p_onboarding uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; v_received integer; v_total integer;
begin
 perform hr.require_admin();
 select * into o from public.agency_onboarding where id = p_onboarding for update;
 if not found or o.kind <> 'business' then raise exception 'Onboarding record not found' using errcode = 'P0002'; end if;
 if o.stage = 'references_approved' then
  select * into a from public.agencies where id = o.agency_id;
  return jsonb_build_object('id', o.id, 'stage', o.stage, 'agencyStatus', a.status, 'already', true, 'combined', o.combined, 'slitWitness', o.slit_witness_png is not null); end if;
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
 return jsonb_build_object('id', o.id, 'stage', o.stage, 'agencyStatus', a.status, 'combined', o.combined, 'refereesPending', greatest(v_total - v_received, 0), 'slitWitness', o.slit_witness_png is not null);
end $f$;

select pg_temp.patch('public.agency_onboarding_agreement_issue(uuid, text, jsonb)',
 $a$'witness', nullif(public.agency_onboarding_clean(p_data->>'admin_witness_name', 150), ''),$a$,
 $a$'witness', coalesce(nullif(public.agency_onboarding_clean(p_data->>'admin_witness_name', 150), ''), o.slit_witness_name),$a$);

-- ------------------------------------------------------------------ what the CMS reads
select pg_temp.patch('public.agency_onboarding_list(uuid)',
 $a$'witness', case when o.witness_name is null then null else jsonb_build_object('name', o.witness_name, 'by', o.witness_by) end,$a$,
 $a$'witness', case when o.witness_name is null then null else jsonb_build_object('name', o.witness_name, 'by', o.witness_by) end,
   'slitWitness', case when o.slit_witness_name is null then null else jsonb_build_object('name', o.slit_witness_name) end,$a$);
select pg_temp.patch('public.agency_onboarding_review_get(uuid)',
 $a$'witness', case when o.witness_name is null then null else jsonb_build_object('name', o.witness_name, 'by', o.witness_by, 'png', o.witness_png) end,$a$,
 $a$'witness', case when o.witness_name is null then null else jsonb_build_object('name', o.witness_name, 'by', o.witness_by, 'png', o.witness_png) end,
  'slitWitness', case when o.slit_witness_name is null then null else jsonb_build_object('name', o.slit_witness_name, 'png', o.slit_witness_png) end,$a$);
