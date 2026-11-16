-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116120022),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
do $$
declare v_def text; v_anchor text := 'v_vals := public.application_letter_values(a.id) -> ''values'';'; v_oid oid;
begin
 select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'portal_offer_letter_issue_template' and n.nspname = 'public';
 v_def := pg_get_functiondef(v_oid);
 if position('no_discount_strip' in v_def) > 0 then return; end if;
 if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
  raise exception 'anchor not found exactly once';
 end if;
 v_def := replace(v_def, v_anchor, v_anchor || E'\r\n -- no_discount_strip: {{#if discount}} prints only when a course on the application has a discount\r\n'
   || ' if not exists (select 1 from public.enrollment_application_courses x where x.application_id = a.id and coalesce(x.discount_percent, 0) > 0) then'
   || E'\r\n  v_keys := array(select k2 from unnest(v_keys) k2 where k2 not in (''fees.discount_percent'', ''fees.discount_amount'', ''fees.tuition_after_discount''));'
   || E'\r\n end if;');
 execute v_def;
end $$;
