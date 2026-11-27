-- BSB80120 is offered for applications: remove the hardcoded exclusion (everything else unchanged)
CREATE OR REPLACE FUNCTION public.portal_course_options()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
 select coalesce(jsonb_agg(jsonb_build_object('courseId', c.id, 'code', c.code,
   'title', c.name || public.course_variant_suffix(c.name, c.variant_label), 'variant', coalesce(btrim(c.variant_label), ''))
   order by c.name, c.variant_label), '[]')
 from public.cms_courses c
 where nullif(btrim(c.name), '') is not null
  -- who may see it: per-tenant access, or single-tenant mode (no tenants set up yet)
  and (
   (c.tenant_id = public.tenant_current()
     and (public.tenant_has_role(c.tenant_id, array['tenant_admin', 'staff']) or public.tenant_agency_access(c.tenant_id, public.portal_agency_id())))
   or (c.tenant_id is null and not exists (select 1 from public.tenants)
     and (public.cms_is_staff() or public.portal_agency_id() is not null))
  )
  -- what is offered: published on the website, or has an open intake in LMS
  and (c.status = 'Published' or not public.rule_bool('admissions.applications_require_published_course', true)) and public.course_has_open_intake(c.id);
$function$;