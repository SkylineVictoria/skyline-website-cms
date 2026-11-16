-- Pulled 2026-11-16 from hosted xcpydisstlvtvcsqnjob (supabase_migrations.schema_migrations.statements, version 20261116102323),
-- applied there by another session; the repo copy exists so a fresh lab replay matches hosted. Do not edit: fixes go in new migrations.
create or replace function public.portal_course_options()
returns jsonb language sql stable security definer
set search_path to 'public'
as $function$
 select coalesce(jsonb_agg(jsonb_build_object('courseId', c.id, 'code', c.code,
   'title', c.name || public.course_variant_suffix(c.name, c.variant_label), 'variant', coalesce(btrim(c.variant_label), ''))
   order by c.name, c.variant_label), '[]')
 from public.cms_courses c
 where c.code <> 'BSB80120' and nullif(btrim(c.name), '') is not null
  -- who may see it: per-tenant access, or single-tenant mode (no tenants set up yet)
  and (
   (c.tenant_id = public.tenant_current()
     and (public.tenant_has_role(c.tenant_id, array['tenant_admin', 'staff']) or public.tenant_agency_access(c.tenant_id, public.portal_agency_id())))
   or (c.tenant_id is null and not exists (select 1 from public.tenants)
     and (public.cms_is_staff() or public.portal_agency_id() is not null))
  )
  -- what is offered: published on the website, or has an open intake in LMS
  and (c.status = 'Published' or exists (select 1 from public.course_intakes i
     where i.course_id = c.id and i.is_active and i.start_date >= public.course_intake_today()));
$function$;
