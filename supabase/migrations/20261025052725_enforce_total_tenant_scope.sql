-- A scope predicate is also called from PL/pgSQL IF guards: NULL must not
-- bypass a NOT predicate when an unknown domain has no tenant_current().
create or replace function public.tenant_scope(p_tenant uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select coalesce(case when p_tenant is null then public.tenant_request_domain() is null
   and not exists(select 1 from public.tenant_memberships where auth_user_id=auth.uid())
 else p_tenant=public.tenant_current() and exists(select 1 from public.tenants where id=p_tenant and status='active') end,false);
$$;
