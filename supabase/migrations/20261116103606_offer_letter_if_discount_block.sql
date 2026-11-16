-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116103606),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
-- 1. {{#if discount}} ... {{/if}} is a valid conditional block, not an unmapped variable.
create or replace function public.letter_template_unmapped(p_html text)
returns text[] language sql stable security definer set search_path to 'public'
as $function$
  with src as (select regexp_replace(coalesce(p_html, ''), '<[^>]*>', '', 'g') as t),
  found as (
    select '{{' || btrim(m[1]) || '}}' tok, 'curly' kind, btrim(m[1]) raw from src, regexp_matches(src.t, '\{\{\s*([^{}]{1,80}?)\s*\}\}', 'g') m
    union all select '$[' || m[1] || ']', 'old', m[1] from src, regexp_matches(src.t, '\$\[([^\[\]]{1,80})\]', 'g') m
    union all select '{' || m[1] || ':inline}', 'old', m[1] from src, regexp_matches(src.t, '\{([A-Za-z][A-Za-z0-9_ ]{0,60}):inline\}', 'g') m
    union all select '[' || m[1] || ']', 'bracket', m[1] from src, regexp_matches(src.t, '(?:^|[^$])\[([^\[\]\n]{1,80})\]', 'g') m
  )
  select coalesce(array_agg(distinct tok order by tok), '{}') from found f
  where (f.kind = 'curly' and lower(regexp_replace(f.raw, '\s+', ' ', 'g')) not in ('#each courses', '#each other_fees', '/each', '#if multiple_courses', '#if gst', '#if discount', '/if')
          and (not exists (select 1 from public.letter_variables v where v.key = lower(btrim(split_part(f.raw, '|', 1))))
            or (position('|' in f.raw) > 0 and lower(btrim(split_part(f.raw, '|', 2))) not in ('upper', 'lower', 'raw', 'title')
                and lower(btrim(split_part(f.raw, '|', 2))) !~ '^h[0-9]{2,3}$')))
     or f.kind = 'old'
     or (f.kind = 'bracket' and exists (select 1 from public.letter_variables v, unnest(v.aliases) al where public.letter_norm(al) = public.letter_norm(f.raw)));
$function$;

-- 2. When no course on the application has a discount, don't ask for the discount block's values.
do $$
declare v_def text; v_anchor text := 'v_vals := public.application_letter_values(a.id) -> ''values'';'; v_oid oid;
begin
 select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'portal_offer_letter_issue_template' and n.nspname = 'public';
 v_def := pg_get_functiondef(v_oid);
 if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
  raise exception 'anchor not found exactly once in portal_offer_letter_issue_template';
 end if;
 if position('no_discount_strip' in v_def) = 0 then
  v_def := replace(v_def, v_anchor, v_anchor || E'\r\n -- no_discount_strip: {{#if discount}} prints only when a course on the application has a discount\r\n'
   || ' if not exists (select 1 from public.enrollment_application_courses x where x.application_id = a.id and coalesce(x.discount_percent, 0) > 0) then'
   || E'\r\n  v_keys := array(select k2 from unnest(v_keys) k2 where k2 not in (''fees.discount_percent'', ''fees.discount_amount'', ''fees.tuition_after_discount''));'
   || E'\r\n end if;');
  execute v_def;
 end if;
end $$;

-- 3. Re-activate the student offer letter template that the guard had auto-archived.
update hr.sign_templates set status = 'active', updated_at = now()
 where id = '22b104c6-9173-416e-9b50-e9c14752b911' and deleted_at is null;
