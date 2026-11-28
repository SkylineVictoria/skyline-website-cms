-- BULK-DOCUMENTS (owner, 2026-11-28: "scan each file in the bulk upload and attach it to the category where it is needed; no manual
-- category selection"): the new Edge Function document-classify (which document a file is; nothing stored) joins the Edge Function
-- allowlist (browser error reports and the daily health check). No table or data change.
begin;
do $do$
declare names text[] := public.edge_function_names();
begin
 if not ('document-classify' = any(names)) then
  names := array(select x from unnest(names || array['document-classify']) x order by x);
  execute format('create or replace function public.edge_function_names() returns text[] language sql immutable as $f$ select %L::text[] $f$', names);
 end if;
end $do$;
commit;
