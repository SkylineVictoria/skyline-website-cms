-- GOOGLE-MAPS-CACHE-FOREVER (owner 2026-11-24: "only 5 to 10 businesses for life; save the data so the API is not called again"):
-- a Google Maps answer (found place or "not found") is kept by ABN for as long as the Business Rule agents.google_maps_cache_days says;
-- 0 (the default) = forever, so each business costs at most one lookup (two calls at most: trading name, then legal name). The business's
-- confirmed details are also saved on its record (agency_places_attach), which never calls Google again.
begin;
select public.business_rule_add_setting('agents.google_maps_cache_days', 'Keep Google Maps answers for (days)', 'Agents',
  'agency_agents', 'business', 'number', '0'::jsonb, '{"min":0,"max":3650}'::jsonb,
  'How long a Google Maps answer for a business is reused before Google is asked again. 0 = keep it forever (each business is looked up once).');
create or replace function public.google_place_cache_get(p_abn text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
 select jsonb_build_object('found', l.found, 'place', l.place, 'query', l.query, 'fetchedAt', l.fetched_at)
 from public.google_place_lookups l
 where l.abn = regexp_replace(coalesce(p_abn, ''), '\D', '', 'g')
   and (public.rule_int('agents.google_maps_cache_days', 0) <= 0
        or l.fetched_at > now() - make_interval(days => public.rule_int('agents.google_maps_cache_days', 0)));
$$;
revoke all on function public.google_place_cache_get(text) from public, anon, authenticated;
grant execute on function public.google_place_cache_get(text) to service_role;
commit;
