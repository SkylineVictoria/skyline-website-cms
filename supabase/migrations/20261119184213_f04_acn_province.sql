-- F04 follow-ups (owner, verified on hosted 2026-11-18):
-- 1. A company's ACN when the register gives none: the last nine digits of its ABN, only for an entity type that is a company and only when
--    they pass ASIC's ACN check digit (public.acn_from_abn; the same rule as acnFromAbn in _shared/validation/abr.ts). document-signing
--    sends it and, on open, writes it into the request's stored values (agency_onboarding_record_fill).
-- 2. A postcode kept as the Province in an unsigned F04's stored values (hr.sign_requests.field_values) or fields (hr.sign_fields): the
--    Province is cleared; the postcode joins a named suburb, otherwise it is kept as office_postcode in the stored values only (the form
--    has no postcode box and the Suburb box never holds a postcode alone).

create or replace function public.acn_valid(p_acn text) returns boolean
language sql immutable set search_path = pg_catalog as $f$
 select coalesce(length(d) = 9 and (10 - ((substr(d,1,1)::int * 8 + substr(d,2,1)::int * 7 + substr(d,3,1)::int * 6 + substr(d,4,1)::int * 5
   + substr(d,5,1)::int * 4 + substr(d,6,1)::int * 3 + substr(d,7,1)::int * 2 + substr(d,8,1)::int) % 10)) % 10 = substr(d,9,1)::int, false)
 from (select regexp_replace(coalesce(p_acn, ''), '\D', '', 'g') as d) x;
$f$;

create or replace function public.acn_from_abn(p_abn text, p_entity_type text) returns text
language sql immutable set search_path = pg_catalog, public as $f$
 select case when length(d) = 11 and coalesce(p_entity_type, '') ~* 'company' and public.acn_valid(substr(d, 3)) then substr(d, 3) end
 from (select regexp_replace(coalesce(p_abn, ''), '\D', '', 'g') as d) x;
$f$;
revoke all on function public.acn_valid(text), public.acn_from_abn(text, text) from public, anon;
grant execute on function public.acn_valid(text), public.acn_from_abn(text, text) to authenticated, service_role;

-- The office row of a stored-values object: a postcode in Province leaves it; it joins a named suburb or is kept as office_postcode.
create or replace function public.agency_onboarding_office_fix(p_values jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $f$
declare v jsonb := coalesce(p_values, '{}'::jsonb); v_prov text := btrim(coalesce(p_values->>'office_province', '')); v_sub text := btrim(coalesce(p_values->>'office_suburb', ''));
begin
 if v_sub ~ '^\d{4}$' then v := (v - 'office_suburb') || jsonb_build_object('office_postcode', coalesce(nullif(btrim(coalesce(v->>'office_postcode', '')), ''), v_sub)); v_sub := ''; end if;
 if v_prov ~ '^\d{4}$' then
  v := v - 'office_province';
  if v_sub <> '' then
   if v_sub !~ '\s\d{4}$' then v := v || jsonb_build_object('office_suburb', v_sub || ' ' || v_prov); end if;
  elsif btrim(coalesce(v->>'office_postcode', '')) = '' then v := v || jsonb_build_object('office_postcode', v_prov);
  end if;
 end if;
 return v;
end $f$;

-- On open (document-signing, service role): the blank keys of an unsigned F04's stored values are filled (the ACN), the office row fixed.
create or replace function public.agency_onboarding_record_fill(p_request uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, hr as $f$
declare o public.agency_onboarding; r hr.sign_requests; v jsonb; e record; v_filled jsonb := '{}'::jsonb;
begin
 o := public.agency_onboarding_application_of(p_request);
 if o.id is null then return '{}'::jsonb; end if;
 select * into r from hr.sign_requests where id = p_request and state in ('sent', 'viewed', 'email_failed') for update;
 if not found then return '{}'::jsonb; end if;
 v := coalesce(r.field_values, '{}'::jsonb);
 for e in select key, value from jsonb_each_text(coalesce(p_values, '{}'::jsonb)) loop
  if e.key ~ '^[a-z][a-z0-9_]{0,60}$' and length(btrim(coalesce(e.value, ''))) between 1 and 500 and btrim(coalesce(v->>e.key, '')) = '' then
   v := v || jsonb_build_object(e.key, btrim(e.value)); v_filled := v_filled || jsonb_build_object(e.key, btrim(e.value));
  end if;
 end loop;
 v := public.agency_onboarding_office_fix(v);
 if v is distinct from coalesce(r.field_values, '{}'::jsonb) then update hr.sign_requests set field_values = v where id = r.id; end if;
 return v_filled;
end $f$;
revoke all on function public.agency_onboarding_record_fill(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.agency_onboarding_record_fill(uuid, jsonb) to service_role;
revoke all on function public.agency_onboarding_office_fix(jsonb) from public, anon;

-- Once, on every unsigned F04: the stored values get the ACN (the profile's register facts, else the ABN for a company) and the office fix;
-- a Province field holding a postcode is cleared (its postcode joins a named suburb in the Suburb field).
with apps as (
 select r.id, a.profile, a.abr_details, a.registration_number from hr.sign_requests r
 join public.agency_onboarding o on o.application_request_id = r.id join public.agencies a on a.id = o.agency_id
 where r.state in ('sent', 'viewed', 'email_failed'))
update hr.sign_requests r set field_values = public.agency_onboarding_office_fix(
  case when btrim(coalesce(r.field_values->>'agent_acn', '')) = '' and coalesce(nullif(regexp_replace(coalesce(apps.profile->'abr_facts'->>'acn', apps.abr_details->>'acn', ''), '\D', '', 'g'), ''),
     public.acn_from_abn(coalesce(apps.profile->'abr_facts'->>'abn', apps.registration_number), coalesce(apps.profile->'abr_facts'->>'entityType', apps.abr_details->>'entityType'))) is not null
   then coalesce(r.field_values, '{}'::jsonb) || jsonb_build_object('agent_acn', coalesce(nullif(regexp_replace(coalesce(apps.profile->'abr_facts'->>'acn', apps.abr_details->>'acn', ''), '\D', '', 'g'), ''),
     public.acn_from_abn(coalesce(apps.profile->'abr_facts'->>'abn', apps.registration_number), coalesce(apps.profile->'abr_facts'->>'entityType', apps.abr_details->>'entityType'))))
   else coalesce(r.field_values, '{}'::jsonb) end)
from apps where apps.id = r.id;

with prov as (
 select f.request_id, btrim(f.value) as postcode from hr.sign_fields f
 join public.agency_onboarding o on o.application_request_id = f.request_id join hr.sign_requests r on r.id = f.request_id
 where f.key = 'office_province' and btrim(coalesce(f.value, '')) ~ '^\d{4}$' and r.state in ('sent', 'viewed', 'email_failed'))
update hr.sign_fields s set value = btrim(s.value) || ' ' || prov.postcode
 from prov where s.request_id = prov.request_id and s.key = 'office_suburb' and btrim(coalesce(s.value, '')) <> '' and btrim(s.value) !~ '\d{4}$';

update hr.sign_fields f set value = null
 where f.key = 'office_province' and btrim(coalesce(f.value, '')) ~ '^\d{4}$'
   and exists (select 1 from public.agency_onboarding o join hr.sign_requests r on r.id = o.application_request_id
                where o.application_request_id = f.request_id and r.state in ('sent', 'viewed', 'email_failed'));
