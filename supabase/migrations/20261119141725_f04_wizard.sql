-- F04 wizard (owner brief 2026-11-19). Additive.
--   * The Agent Application Form (F04) is signed through a step-by-step wizard on /sign. "Save and continue later" keeps the contact's answers
--     on the server: public.agency_onboarding_drafts, one row per application request (service role only; the Edge Function writes it after
--     checking the emailed link's token).
--   * The register's facts (ABN status and active-from date, entity type, GST registered-from date, ACN) are kept on the business profile
--     (agencies.profile.abr_facts): recorded by staff when the F04 is sent (agency_abr_facts_record), or by the function on the first open when
--     the send did not keep them (agency_onboarding_facts_save). Shown read-only in the wizard's Company summary; no box on the PDF.
--   * When the F04 is signed, the ACN, the MARN (digits only, checked by document-signing core.ts) and the ticked declaration statements join
--     the signed answers (agency_onboarding.answers) and the business profile (agency_onboarding_application_extra); the draft is removed.
-- Rollback (manual): drop function public.agency_onboarding_application_extra(uuid, jsonb), public.agency_onboarding_facts_save(uuid, jsonb),
--   public.agency_abr_facts_record(uuid, jsonb), public.agency_onboarding_wizard_get(uuid), public.agency_onboarding_draft_save(uuid, uuid, jsonb),
--   public.agency_abr_facts_clean(jsonb); drop table public.agency_onboarding_drafts.
begin;

create table public.agency_onboarding_drafts(
  request_id uuid primary key references hr.sign_requests(id) on delete cascade,
  recipient_id uuid not null references hr.sign_recipients(id) on delete cascade,
  draft jsonb not null check (jsonb_typeof(draft) = 'object' and length(draft::text) <= 60000),
  saved_at timestamptz not null default now()
);
alter table public.agency_onboarding_drafts enable row level security;
revoke all on public.agency_onboarding_drafts from public, anon, authenticated;
grant select on public.agency_onboarding_drafts to service_role;
comment on table public.agency_onboarding_drafts is 'F04 wizard: the contact''s unsigned answers ("Save and continue later"), per application request. Written by document-signing only.';

-- The application request a link holder signs, with its onboarding: null when the request is not an F04 of an onboarding.
create function public.agency_onboarding_application_of(p_request uuid) returns public.agency_onboarding
language sql stable security definer set search_path = pg_catalog, public, hr as $f$
 select o.* from hr.sign_requests r join public.agency_onboarding o on o.id = r.agency_onboarding_id and o.application_request_id = r.id where r.id = p_request;
$f$;
revoke all on function public.agency_onboarding_application_of(uuid) from public, anon, authenticated;

-- The facts kept: known keys only, short strings, the dates as ISO dates, nothing else.
create function public.agency_abr_facts_clean(p_facts jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $f$
declare f jsonb := case when jsonb_typeof(p_facts) = 'object' then p_facts else '{}'::jsonb end; t text;
begin
 if regexp_replace(coalesce(f->>'abn', ''), '\D', '', 'g') !~ '^\d{11}$' then raise exception 'The ABN Lookup facts could not be read.' using errcode = '22023'; end if;
 foreach t in array array['abnStatus', 'entityName', 'entityType', 'sourceUrl'] loop
  if (f->>t) ~ '[[:cntrl:]]' then raise exception 'The ABN Lookup facts contain characters that cannot be shown.' using errcode = '22023'; end if;
 end loop;
 return jsonb_build_object(
  'abn', regexp_replace(f->>'abn', '\D', '', 'g'),
  'acn', case when regexp_replace(coalesce(f->>'acn', ''), '\D', '', 'g') ~ '^\d{9}$' then regexp_replace(f->>'acn', '\D', '', 'g') else '' end,
  'abnStatus', left(btrim(coalesce(f->>'abnStatus', '')), 40),
  'statusFrom', case when coalesce(f->>'statusFrom', '') ~ '^\d{4}-\d{2}-\d{2}$' then f->>'statusFrom' else '' end,
  'entityName', left(btrim(coalesce(f->>'entityName', '')), 200),
  'entityType', left(btrim(coalesce(f->>'entityType', '')), 120),
  'gstRegistered', coalesce((f->>'gstRegistered')::boolean, false),
  'gstFrom', case when coalesce(f->>'gstFrom', '') ~ '^\d{4}-\d{2}-\d{2}$' then f->>'gstFrom' else '' end,
  'sourceUrl', case when coalesce(f->>'sourceUrl', '') ~ '^https://abr\.business\.gov\.au/' then left(f->>'sourceUrl', 200) else '' end,
  'fetchedAt', case when coalesce(f->>'fetchedAt', '') ~ '^\d{4}-\d{2}-\d{2}T' then left(f->>'fetchedAt', 40) else now()::text end);
end $f$;
revoke all on function public.agency_abr_facts_clean(jsonb) from public, anon, authenticated;

-- Staff sending the F04: the facts from the lookup made for it, kept on the business profile.
create function public.agency_abr_facts_record(p_agency uuid, p_facts jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare v jsonb;
begin
 perform hr.require_admin();
 v := public.agency_abr_facts_clean(p_facts);
 update public.agencies set profile = coalesce(profile, '{}'::jsonb) || jsonb_build_object('abr_facts', v), updated_at = now()
  where id = p_agency and regexp_replace(coalesce(registration_number, ''), '\D', '', 'g') = v->>'abn';
 if not found then raise exception 'The ABN Lookup facts are for another business.' using errcode = '22023'; end if;
end $f$;
revoke all on function public.agency_abr_facts_record(uuid, jsonb) from public, anon;
grant execute on function public.agency_abr_facts_record(uuid, jsonb) to authenticated;

-- The function, for a link holder whose token it checked: the draft, the facts kept on the business and its ABN.
create function public.agency_onboarding_wizard_get(p_request uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; a public.agencies; d public.agency_onboarding_drafts;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null then return null; end if;
 select * into a from public.agencies where id = o.agency_id;
 select * into d from public.agency_onboarding_drafts where request_id = p_request;
 return jsonb_build_object('draft', d.draft, 'saved_at', d.saved_at, 'facts', a.profile->'abr_facts',
  'abn', nullif(regexp_replace(coalesce(a.registration_number, ''), '\D', '', 'g'), ''));
end $f$;
revoke all on function public.agency_onboarding_wizard_get(uuid) from public, anon, authenticated;
grant execute on function public.agency_onboarding_wizard_get(uuid) to service_role;

create function public.agency_onboarding_facts_save(p_request uuid, p_facts jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; v jsonb;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null then raise exception 'Not an application form' using errcode = '22023'; end if;
 v := public.agency_abr_facts_clean(p_facts);
 update public.agencies set profile = coalesce(profile, '{}'::jsonb) || jsonb_build_object('abr_facts', v), updated_at = now()
  where id = o.agency_id and regexp_replace(coalesce(registration_number, ''), '\D', '', 'g') = v->>'abn' and not (coalesce(profile, '{}'::jsonb) ? 'abr_facts');
end $f$;
revoke all on function public.agency_onboarding_facts_save(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_facts_save(uuid, jsonb) to service_role;

-- "Save and continue later": only while the application form waits for this signer.
create function public.agency_onboarding_draft_save(p_request uuid, p_recipient uuid, p_draft jsonb) returns timestamptz
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; c hr.sign_recipients; v_at timestamptz;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null or o.stage <> 'application_sent' then raise exception 'This application form is no longer waiting for a signature' using errcode = '22023'; end if;
 select * into c from hr.sign_recipients where id = p_recipient and request_id = p_request;
 if not found or c.state in ('signed', 'declined', 'skipped') then raise exception 'This application form is no longer waiting for a signature' using errcode = '22023'; end if;
 if jsonb_typeof(p_draft) is distinct from 'object' or length(p_draft::text) > 60000 then raise exception 'The draft could not be saved: it is too large.' using errcode = '22023'; end if;
 insert into public.agency_onboarding_drafts(request_id, recipient_id, draft, saved_at) values (p_request, p_recipient, p_draft, now())
 on conflict (request_id) do update set recipient_id = excluded.recipient_id, draft = excluded.draft, saved_at = excluded.saved_at
 returning saved_at into v_at;
 return v_at;
end $f$;
revoke all on function public.agency_onboarding_draft_save(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_draft_save(uuid, uuid, jsonb) to service_role;

-- After the F04 is signed: the ACN, the MARN and the declarations with the answers and on the business; the draft goes.
create function public.agency_onboarding_application_extra(p_request uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; v jsonb; v_acn text; v_marn text;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null then raise exception 'Not an application form' using errcode = '22023'; end if;
 if not exists (select 1 from hr.sign_requests r where r.id = p_request and r.state = 'signed') then raise exception 'The application form is not signed yet' using errcode = '22023'; end if;
 v_acn := regexp_replace(coalesce(p_data->>'agent_acn', ''), '\D', '', 'g');
 v_marn := regexp_replace(coalesce(p_data->>'agent_marn', ''), '\s', '', 'g');
 if v_acn <> '' and v_acn !~ '^\d{9}$' then raise exception 'The ACN has 9 digits.' using errcode = '22023'; end if;
 if v_marn <> '' and v_marn !~ '^\d{1,10}$' then raise exception 'The MARN is a number: digits only.' using errcode = '22023'; end if;
 v := jsonb_strip_nulls(jsonb_build_object('agent_acn', nullif(v_acn, ''), 'agent_marn', nullif(v_marn, ''),
  'declarations', case when jsonb_typeof(p_data->'declarations') = 'object' then (select coalesce(jsonb_object_agg(e.key, true), '{}'::jsonb) from jsonb_each(p_data->'declarations') e
    where e.key ~ '^[a-z][a-z0-9_]{0,40}$' and e.value = 'true'::jsonb) end,
  'declared_at', case when coalesce(p_data->>'declared_at', '') ~ '^\d{4}-\d{2}-\d{2}' then left(p_data->>'declared_at', 40) end));
 update public.agency_onboarding set answers = coalesce(answers, '{}'::jsonb) || v where id = o.id;
 update public.agencies set profile = coalesce(profile, '{}'::jsonb) || (v - 'declarations' - 'declared_at'), updated_at = now() where id = o.agency_id;
 delete from public.agency_onboarding_drafts where request_id = p_request;
 perform public.agency_onboarding_log(o.id, 'application_declarations', jsonb_build_object('declarations', (select count(*) from jsonb_object_keys(coalesce(v->'declarations', '{}'::jsonb))),
  'marn', v ? 'agent_marn', 'acn', v ? 'agent_acn'));
end $f$;
revoke all on function public.agency_onboarding_application_extra(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_application_extra(uuid, jsonb) to service_role;

commit;
