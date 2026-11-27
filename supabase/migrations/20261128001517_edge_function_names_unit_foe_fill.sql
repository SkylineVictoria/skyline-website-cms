-- EDGE-FUNCTION-NAMES-UNIT-FOE-FILL (owner 2026-11-27): the Edge Function allowlist (browser error reports, daily health check)
-- gains unit-foe-fill (live v2, folder supabase/functions/unit-foe-fill; called by unit_foe_fill_dispatch and the hourly cron job
-- unit-foe-fill, from 20261125014126). Whatever is live is kept; nothing else changes.
-- Down: re-create edge_function_names() without 'unit-foe-fill'.
do $do$
declare names text[] := public.edge_function_names();
begin
 if not ('unit-foe-fill' = any(names)) then
  names := array(select x from unnest(names || array['unit-foe-fill']) x order by x);
  execute format('create or replace function public.edge_function_names() returns text[] language sql immutable as $f$ select %L::text[] $f$', names);
 end if;
end $do$;
