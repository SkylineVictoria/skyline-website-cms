-- GOOGLE-MAPS-AUTOFILL (owner 2026-11-24: "Fill all info whatever you can find online for this business so no manual work").
-- Add business looks the business up on Google Maps (Places API (New) Text Search, Edge Function document-signing, secret
-- EF_GOOGLE_MAPS_KEY) after the ABN lookup; staff confirm / edit the office address, website and phone; they are kept on the
-- business profile (blank keys only) and prefill the F04's office row and website. Additive only.
--   public.google_place_lookups              answers cached by ABN (found place or "not found"), service role only
--   public.google_place_cache_get(text)      the cached answer while younger than agents.abn_cache_days (service role)
--   public.google_place_cache_put(text, text, jsonb)                                                  (service role)
--   public.agency_places_attach(uuid, jsonb) staff's confirmed office details onto agencies.profile, blank keys only (CMS admins)
--   Business Rules agents.google_maps_autofill (Yes) and agents.google_maps_match_percent (60)
-- Rollback (manual): drop function public.agency_places_attach(uuid, jsonb), public.google_place_cache_put(text, text, jsonb),
--   public.google_place_cache_get(text); drop table public.google_place_lookups; delete the two rules on Administration › Business Rules.
begin;

create table if not exists public.google_place_lookups (
  abn text primary key check (abn ~ '^\d{11}$'),
  query text not null default '',
  found boolean not null,
  place jsonb check (place is null or (jsonb_typeof(place) = 'object' and length(place::text) <= 8000)),
  fetched_at timestamptz not null default now()
);
comment on table public.google_place_lookups is 'Google Maps (Places API (New)) answers by ABN for Add business and the F04 prefill; reused for agents.abn_cache_days. Service role only.';
alter table public.google_place_lookups enable row level security;
revoke all on table public.google_place_lookups from public, anon, authenticated;
grant all on table public.google_place_lookups to service_role;

create or replace function public.google_place_cache_get(p_abn text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
 select jsonb_build_object('found', l.found, 'place', l.place, 'query', l.query, 'fetchedAt', l.fetched_at)
 from public.google_place_lookups l
 where l.abn = regexp_replace(coalesce(p_abn, ''), '\D', '', 'g')
   and l.fetched_at > now() - make_interval(days => greatest(1, public.rule_int('agents.abn_cache_days', 30)));
$$;
revoke all on function public.google_place_cache_get(text) from public, anon, authenticated;
grant execute on function public.google_place_cache_get(text) to service_role;

create or replace function public.google_place_cache_put(p_abn text, p_query text, p_place jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_abn text := regexp_replace(coalesce(p_abn, ''), '\D', '', 'g');
  v_place jsonb := case when jsonb_typeof(p_place) = 'object' and length(p_place::text) <= 8000 then p_place end;
begin
 if v_abn !~ '^\d{11}$' then return; end if;
 if v_place is not null and btrim(coalesce(v_place->>'name', '')) = '' then v_place := null; end if;
 insert into public.google_place_lookups(abn, query, found, place, fetched_at)
 values (v_abn, left(regexp_replace(coalesce(p_query, ''), '[[:cntrl:]]', ' ', 'g'), 300), v_place is not null, v_place, now())
 on conflict (abn) do update set query = excluded.query, found = excluded.found, place = excluded.place, fetched_at = excluded.fetched_at;
end $$;
revoke all on function public.google_place_cache_put(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.google_place_cache_put(text, text, jsonb) to service_role;

-- Staff's confirmed office details (Google Maps, possibly edited, or typed by hand) onto the business profile. Only keys still blank
-- are written: an answer the agency or staff already gave is never overwritten. agent_onboarding_values passes every string key of the
-- profile to the F04 prefill (office_street_address, office_suburb, office_state, office_postcode, office_country, agent_website).
create or replace function public.agency_places_attach(p_agency uuid, p_place jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.agencies; c jsonb := case when jsonb_typeof(p_place) = 'object' then p_place else '{}'::jsonb end;
  p jsonb; v jsonb; k text; written text[] := '{}';
  clean text;
begin
 perform public.admin_business_require();
 select * into a from public.agencies where id = p_agency for update;
 if not found then raise exception 'Business not found' using errcode = 'P0002'; end if;
 if length(c::text) > 8000 then raise exception 'The office details could not be read.' using errcode = '22023'; end if;
 v := jsonb_strip_nulls(jsonb_build_object(
  'office_street_address', nullif(left(btrim(regexp_replace(coalesce(c->>'street', ''), '\s+', ' ', 'g')), 200), ''),
  'office_suburb', nullif(left(btrim(regexp_replace(regexp_replace(coalesce(c->>'suburb', ''), '\s+\d{4}$', ''), '\s+', ' ', 'g')), 100), ''),
  'office_state', case when upper(btrim(coalesce(c->>'state', ''))) ~ '^(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)$' then upper(btrim(c->>'state')) end,
  'office_postcode', case when btrim(coalesce(c->>'postcode', '')) ~ '^\d{4}$' then btrim(c->>'postcode') end,
  'office_country', nullif(left(btrim(coalesce(c->>'country', '')), 80), ''),
  'agent_website', case when btrim(coalesce(c->>'website', '')) ~* '^https?://[^\s<>"]+$' then left(btrim(c->>'website'), 300) end,
  'business_phone', nullif(left(btrim(regexp_replace(coalesce(c->>'phone', ''), '[^0-9+() -]', '', 'g')), 40), '')));
 for k in select jsonb_object_keys(v) loop
  if (v->>k) ~ '[[:cntrl:]]' then raise exception 'The office details contain characters that cannot be printed.' using errcode = '22023'; end if;
 end loop;
 p := coalesce(a.profile, '{}'::jsonb);
 for k, clean in select e.key, e.value #>> '{}' from jsonb_each(v) e loop
  if btrim(coalesce(p->>k, '')) = '' then p := p || jsonb_build_object(k, clean); written := written || k; end if;
 end loop;
 -- Where the details came from (shown as "Found on Google Maps" with its link); the place id is kept so staff can open it again.
 if c->>'source' = 'google' then
  p := p || jsonb_build_object('google_place', jsonb_strip_nulls(jsonb_build_object(
   'placeId', nullif(left(btrim(coalesce(c->>'placeId', '')), 300), ''),
   'mapsUri', case when btrim(coalesce(c->>'mapsUri', '')) ~* '^https://' then left(btrim(c->>'mapsUri'), 500) end,
   'name', nullif(left(btrim(coalesce(c->>'name', '')), 200), ''), 'attachedAt', now())));
 end if;
 update public.agencies set profile = p,
  -- The business record's address: the full street address when it was only "STATE postcode" (the sign-up) or blank.
  address = case when (btrim(coalesce(a.address, '')) = '' or btrim(a.address) ~ '^[A-Z]{2,3}\s+\d{4}$') and v ? 'office_street_address'
   then left(concat_ws(', ', v->>'office_street_address', nullif(concat_ws(' ', v->>'office_suburb', v->>'office_state', v->>'office_postcode'), '')), 300) else a.address end,
  updated_at = now()
 where id = a.id;
 perform public.admin_business_audit('office_details_attached', a.id, a.id, jsonb_build_object('source', coalesce(nullif(c->>'source', ''), 'staff'), 'fields', to_jsonb(written)));
 return jsonb_build_object('agencyId', a.id, 'written', to_jsonb(written));
end $$;
revoke all on function public.agency_places_attach(uuid, jsonb) from public, anon;
grant execute on function public.agency_places_attach(uuid, jsonb) to authenticated;

-- Business Rules (nothing hard-coded): whether Google Maps is used at all, and how close a match must be.
select public.business_rule_add_setting('agents.google_maps_autofill', 'Fill business details from Google Maps', 'Agents',
  'agency_agents', 'business', 'boolean', 'true'::jsonb, '{}'::jsonb,
  'Yes: Add business looks the business up on Google Maps after the ABN lookup and fills the office address, website and phone (staff confirm them), and a blank office address on the Agent Application Form is filled the same way. No: staff type them. Needs the Edge Function secret EF_GOOGLE_MAPS_KEY.');
select public.business_rule_add_setting('agents.google_maps_match_percent', 'Google Maps match needed', 'Agents',
  'agency_agents', 'business', 'number', '60'::jsonb, '{"min":30,"max":100}'::jsonb,
  'How closely (in percent) a Google Maps place must match the business''s registered names, in the same state, before its details are used. Higher = fewer wrong matches, more addresses typed by hand.');

commit;
