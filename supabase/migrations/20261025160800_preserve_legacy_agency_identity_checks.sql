create or replace function public.portal_identity() returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare role text;
begin
 if public.tenant_request_domain() is not null then
  if public.tenant_current() is null then raise exception 'Unknown or inactive institution' using errcode='42501'; end if;
  if public.portal_is_slit_admin() then role:='slit_admin';
  elsif public.tenant_agency_access(public.tenant_current(),public.portal_agency_id()) then
   role:=case when public.portal_is_agency_admin() then 'agency_admin' else 'agent' end;
  end if;
 else
  if not public.tenant_scope(null) then raise exception 'Legacy scope not authorized' using errcode='42501'; end if;
  role:=case when public.portal_is_slit_admin() then 'slit_admin' when public.portal_agency_id() is not null and public.portal_is_agency_admin() then 'agency_admin' when public.portal_agency_id() is not null and public.portal_is_agent() then 'agent' end;
 end if;
 return jsonb_build_object('is_slit_admin',role='slit_admin','profile_id',public.portal_profile_id(),'agency_id',public.portal_agency_id(),'role',role,'tenant_id',public.tenant_current());
end; $$;
revoke all on function public.portal_identity() from public,anon,authenticated,service_role;
grant execute on function public.portal_identity() to authenticated,service_role;


grant execute on function public.portal_identity() to anon;

