-- Recovered from read-only metadata of the approved shared CMS/Agency project.
-- Preserve the existing RPC contract and grants; authorization hardening follows
-- its own regression gates. No records, identities or ownership are changed.
begin;
CREATE OR REPLACE FUNCTION public.portal_identity()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
select jsonb_build_object(
 'is_slit_admin', public.portal_is_slit_admin(),
 'profile_id', public.portal_profile_id(),
 'agency_id', public.portal_agency_id(),
 'role',case
 when public.portal_is_slit_admin() then 'slit_admin'
 when (public.portal_is_agency_admin() or public.portal_is_agent())
  and exists(select 1 from public.agencies a where a.id=public.portal_agency_id() and a.status='Active')
 then case when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end
 else null end);
$function$;
-- These are the observed legacy grants, not a new authorization boundary.
grant execute on function public.portal_identity() to public, anon, authenticated, service_role;
commit;
