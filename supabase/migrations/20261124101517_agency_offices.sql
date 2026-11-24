-- AGENCY-OFFICES (owner, 2026-11-24: "Aussizz Group has multiple locations, so allow adding the main headquarters and branches too with
-- Google Maps"): a business has one head office (the existing profile office_* keys, printed on the F04) and any number of branches
-- (agencies.profile.branches, at most 30), each found on Google Maps (Add business / the business page: Search Google Maps) or typed.
--   public.agency_offices_get(uuid)               head office + branches, for the business page (SLIT administrators)
--   public.agency_offices_set(uuid, jsonb, jsonb) head office replaced when given (p_head null keeps it), branches replaced by the list
-- Unlike agency_places_attach (blank keys only, Add business), this is staff's deliberate change, so the head office is overwritten.
-- Rollback: drop function public.agency_offices_get(uuid), public.agency_offices_set(uuid, jsonb, jsonb); profile 'branches' keys can stay.
begin;

-- One office as stored: plain text, trimmed, no control characters; state as its abbreviation; postcode 4 digits; links https only.
create or replace function public.agency_office_clean(p jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, public as $$
declare c jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end; v jsonb; k text;
begin
 v := jsonb_strip_nulls(jsonb_build_object(
  'label', nullif(left(btrim(regexp_replace(coalesce(c->>'label', ''), '\s+', ' ', 'g')), 80), ''),
  'name', nullif(left(btrim(regexp_replace(coalesce(c->>'name', ''), '\s+', ' ', 'g')), 200), ''),
  'street', nullif(left(btrim(regexp_replace(coalesce(c->>'street', ''), '\s+', ' ', 'g')), 200), ''),
  'suburb', nullif(left(btrim(regexp_replace(regexp_replace(coalesce(c->>'suburb', ''), '\s+\d{4}$', ''), '\s+', ' ', 'g')), 100), ''),
  'state', case when upper(btrim(coalesce(c->>'state', ''))) ~ '^(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)$' then upper(btrim(c->>'state')) end,
  'postcode', case when btrim(coalesce(c->>'postcode', '')) ~ '^\d{4}$' then btrim(c->>'postcode') end,
  'country', nullif(left(btrim(coalesce(c->>'country', '')), 80), ''),
  'website', case when btrim(coalesce(c->>'website', '')) ~* '^https?://' then left(btrim(c->>'website'), 300) end,
  'phone', nullif(left(btrim(regexp_replace(coalesce(c->>'phone', ''), '[^0-9+() -]', '', 'g')), 40), ''),
  'placeId', nullif(left(btrim(coalesce(c->>'placeId', '')), 300), ''),
  'mapsUri', case when btrim(coalesce(c->>'mapsUri', '')) ~* '^https://' then left(btrim(c->>'mapsUri'), 500) end));
 for k in select jsonb_object_keys(v) loop
  if (v->>k) ~ '[[:cntrl:]]' then raise exception 'The office details contain characters that cannot be printed.' using errcode = '22023'; end if;
 end loop;
 return v;
end $$;
revoke all on function public.agency_office_clean(jsonb) from public, anon;

create or replace function public.agency_offices_get(p_agency uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare a public.agencies; p jsonb;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_agency;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 p := coalesce(a.profile, '{}'::jsonb);
 return jsonb_build_object(
  'head', jsonb_strip_nulls(jsonb_build_object('street', p->>'office_street_address', 'suburb', p->>'office_suburb', 'state', p->>'office_state',
    'postcode', p->>'office_postcode', 'country', p->>'office_country', 'website', p->>'agent_website', 'phone', p->>'business_phone',
    'name', p#>>'{google_place,name}', 'placeId', p#>>'{google_place,placeId}', 'mapsUri', p#>>'{google_place,mapsUri}')),
  'branches', case when jsonb_typeof(p->'branches') = 'array' then p->'branches' else '[]'::jsonb end);
end $$;
revoke all on function public.agency_offices_get(uuid) from public, anon;
grant execute on function public.agency_offices_get(uuid) to authenticated;

create or replace function public.agency_offices_set(p_agency uuid, p_head jsonb, p_branches jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.agencies; p jsonb; h jsonb; b jsonb := '[]'::jsonb; e jsonb; o jsonb;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_agency for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if length(coalesce(p_head, 'null'::jsonb)::text) + length(coalesce(p_branches, 'null'::jsonb)::text) > 40000 then
  raise exception 'The office details could not be read.' using errcode = '22023';
 end if;
 p := coalesce(a.profile, '{}'::jsonb);
 if jsonb_typeof(p_head) = 'object' then
  h := public.agency_office_clean(p_head);
  if not (h ?| array['street', 'suburb']) then raise exception 'The head office needs a street address or suburb.' using errcode = '22023'; end if;
  p := p - array['office_street_address', 'office_suburb', 'office_state', 'office_postcode', 'office_country', 'business_phone', 'google_place']
   || jsonb_strip_nulls(jsonb_build_object('office_street_address', h->>'street', 'office_suburb', h->>'suburb', 'office_state', h->>'state',
     'office_postcode', h->>'postcode', 'office_country', h->>'country', 'business_phone', h->>'phone'));
  if h ? 'website' then p := p || jsonb_build_object('agent_website', h->>'website'); end if;
  if h ?| array['placeId', 'mapsUri'] then
   p := p || jsonb_build_object('google_place', jsonb_strip_nulls(jsonb_build_object('placeId', h->>'placeId', 'mapsUri', h->>'mapsUri', 'name', h->>'name', 'attachedAt', now())));
  end if;
 end if;
 if p_branches is not null then
  if jsonb_typeof(p_branches) <> 'array' then raise exception 'The branches could not be read.' using errcode = '22023'; end if;
  if jsonb_array_length(p_branches) > 30 then raise exception 'A business can have at most 30 branches.' using errcode = '22023'; end if;
  for e in select value from jsonb_array_elements(p_branches) loop
   o := public.agency_office_clean(e);
   if o ?| array['street', 'suburb'] then b := b || jsonb_build_array(o); end if;
  end loop;
  p := p || jsonb_build_object('branches', b);
 end if;
 update public.agencies set profile = p,
  address = case when h ? 'street' then left(concat_ws(', ', h->>'street', nullif(concat_ws(' ', h->>'suburb', h->>'state', h->>'postcode'), '')), 300) else a.address end,
  updated_at = now()
 where id = a.id;
 perform public.admin_business_audit('offices_updated', a.id, a.id, jsonb_build_object('headChanged', h is not null,
  'branches', case when p_branches is null then null else jsonb_array_length(b) end));
 return public.agency_offices_get(a.id);
end $$;
revoke all on function public.agency_offices_set(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.agency_offices_set(uuid, jsonb, jsonb) to authenticated;

commit;
