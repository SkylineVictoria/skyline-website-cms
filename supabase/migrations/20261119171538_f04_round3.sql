-- F04 wizard, round 3 (owner brief 2026-11-18): the Suburb box never holds a postcode alone.
--
-- agent_onboarding_values (the business record's values used by the send and by the open's fill of blanks) joins the sign-up / profile
-- postcode to a NAMED suburb only ("Melbourne 3000"); with no suburb name the Suburb box stays blank and the contact's address search fills
-- suburb, state and postcode. A postcode-only Suburb box already on an unsigned F04 is cleared (the value was the register's postcode, never
-- a suburb). Everything else is unchanged from 20261119153412.

create or replace function public.agent_onboarding_values(p_agent uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $f$
declare g public.agents; a public.agencies; p jsonb; pp public.portal_profiles; v jsonb; v_given text; v_family text; v_parts text[]; v_state text; v_post text; v_position text; v_prov text; v_sub text;
begin
 select * into g from public.agents where id = p_agent;
 if not found then return '{}'::jsonb; end if;
 select * into a from public.agencies where id = g.business_id;
 p := coalesce(a.profile, '{}'::jsonb);
 if g.profile_id is not null then select * into pp from public.portal_profiles where id = g.profile_id; end if;
 v_parts := regexp_split_to_array(btrim(coalesce(g.full_name, '')), '\s+');
 if coalesce(array_length(v_parts, 1), 0) >= 2 then v_given := array_to_string(v_parts[1:array_length(v_parts, 1) - 1], ' '); v_family := v_parts[array_length(v_parts, 1)];
 else v_given := coalesce(v_parts[1], ''); v_family := ''; end if;
 -- The sign-up keeps "STATE postcode" as the address.
 v_state := nullif(substring(coalesce(a.address, '') from '^([A-Z]{2,3})\s+\d{4}$'), '');
 v_post := nullif(substring(coalesce(a.address, '') from '^[A-Z]{2,3}\s+(\d{4})$'), '');
 -- A postcode kept as the Province (forms signed before 2026-11-19) is a postcode, not a region.
 v_prov := btrim(coalesce(p->>'office_province', ''));
 if v_prov ~ '^\d{4}$' then v_post := coalesce(v_post, v_prov); p := p - 'office_province'; v_prov := ''; end if;
 -- The Suburb box: a named suburb, with the postcode joined when it has none; a postcode alone is dropped (round 3).
 v_sub := btrim(coalesce(p->>'office_suburb', ''));
 if v_sub ~ '^\d{4}$' then v_post := coalesce(v_post, v_sub); v_sub := ''; end if;
 p := p - 'office_suburb';
 if v_sub <> '' and v_post is not null and v_sub !~ '\s\d{4}$' then v_sub := v_sub || ' ' || v_post; end if;
 v_position := coalesce(nullif(btrim(coalesce(pp.job_title, '')), ''), nullif(btrim(coalesce(p->>'contact_position', '')), ''), '');
 v := jsonb_strip_nulls(jsonb_build_object(
  'agent_organisation_name', nullif(coalesce(nullif(btrim(coalesce(p->>'agent_legal_entity', '')), ''), a.name), ''),
  'agent_abn', nullif(btrim(coalesce(a.registration_number, '')), ''),
  'agent_agency_name', nullif(btrim(coalesce(a.name, '')), ''),
  'contact_given_name', nullif(coalesce(nullif(btrim(coalesce(p->>'contact_given_name', '')), ''), v_given), ''),
  'contact_family_name', nullif(coalesce(nullif(btrim(coalesce(p->>'contact_family_name', '')), ''), v_family), ''),
  'contact_position', nullif(v_position, ''),
  'contact_email', nullif(lower(btrim(coalesce(g.email, ''))), ''),
  'contact_phone', nullif(coalesce(nullif(btrim(coalesce(g.phone, '')), ''), nullif(btrim(coalesce(a.phone, '')), '')), ''),
  'office_state', nullif(coalesce(nullif(btrim(coalesce(p->>'office_state', '')), ''), v_state), ''),
  'office_province', nullif(v_prov, ''),
  'office_suburb', nullif(v_sub, ''),
  'office_country', nullif(coalesce(nullif(btrim(coalesce(p->>'office_country', '')), ''), nullif(btrim(coalesce(a.country, '')), '')), ''),
  'agent_signatory_name', nullif(coalesce(nullif(btrim(coalesce(p->>'agent_signatory_name', '')), ''), nullif(btrim(coalesce(g.full_name, '')), '')), ''),
  'agent_signatory_position', nullif(coalesce(nullif(btrim(coalesce(p->>'agent_signatory_position', '')), ''), v_position), '')));
 v := v || jsonb_build_object('declarant_name', coalesce(nullif(btrim(concat_ws(' ', v->>'contact_given_name', v->>'contact_family_name')), ''), ''), 'declarant_role', coalesce(v->>'contact_position', ''));
 return (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(p) e where jsonb_typeof(e.value) = 'string' and e.key ~ '^[a-z][a-z0-9_]{0,60}$' and length(e.value #>> '{}') <= 500)
  || jsonb_strip_nulls(v);
end $f$;
revoke all on function public.agent_onboarding_values(uuid) from public, anon, authenticated;

-- An unsigned F04 whose Suburb box holds a postcode alone: cleared, so the open's fill and the contact's address search can fill it.
update hr.sign_fields f set value = null
 where f.key = 'office_suburb' and btrim(coalesce(f.value, '')) ~ '^\d{4}$'
   and exists (select 1 from public.agency_onboarding o join hr.sign_requests r on r.id = o.application_request_id
                where o.application_request_id = f.request_id and r.state in ('sent', 'viewed', 'email_failed'));
