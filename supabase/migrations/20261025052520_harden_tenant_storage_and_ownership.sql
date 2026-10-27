-- Intersect existing Storage grants with trusted application ownership. A
-- permissive tenant policy must never override registered-object retention.
create or replace function public.tenant_storage_access(p_bucket text,p_name text,p_write boolean default false)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare app public.enrollment_applications; tenant uuid; part text:=split_part(p_name,'/',1);
begin
 if auth.uid() is null or part !~ '^[a-f0-9-]{36}$' or p_name ~ '(^|/)(\.|\.\.)(/|$)' or position(chr(92) in p_name)>0 then return false; end if;
 if p_bucket='tenant-cms' then
  tenant:=part::uuid;return public.tenant_scope(tenant) and public.tenant_has_role(tenant,array['tenant_admin','editor']);
 elsif p_bucket='enrollment-documents' then
  select * into app from public.enrollment_applications where id=part::uuid;
  if not found or app.tenant_id is null or not public.tenant_scope(app.tenant_id) then return false; end if;
  return (not p_write or (app.status in ('draft','action_required') and not exists(
   select 1 from public.enrollment_application_documents where bucket_name=p_bucket and storage_path=p_name))) and
   (public.tenant_has_role(app.tenant_id,array['tenant_admin','staff']) or
   (public.tenant_agency_access(app.tenant_id,app.agency_id) and (public.portal_is_agency_admin() or app.assigned_agent_id=public.portal_profile_id())));
 end if;
 return false;
exception when invalid_text_representation then return false;
end; $$;
create function public.tenant_storage_boundary(p_bucket text,p_name text) returns boolean
language plpgsql stable security definer set search_path=public as $$
declare app public.enrollment_applications;
begin
 if p_bucket='tenant-cms' then return public.tenant_storage_access(p_bucket,p_name,false); end if;
 if p_bucket<>'enrollment-documents' then return true; end if;
 select * into app from public.enrollment_applications where id=public.portal_path_app_id(p_name);
 if not found then return false; end if;
 if app.tenant_id is null then return public.tenant_scope(null); end if;
 return public.tenant_storage_access(p_bucket,p_name,false);
exception when invalid_text_representation then return false;
end; $$;
revoke all on function public.tenant_storage_boundary(text,text) from public,anon;
grant execute on function public.tenant_storage_boundary(text,text) to authenticated,service_role;
create policy tenant_storage_boundary on storage.objects as restrictive for all to authenticated
using(public.tenant_storage_boundary(bucket_id,name)) with check(public.tenant_storage_boundary(bucket_id,name));
create policy tenant_storage_registered_update on storage.objects as restrictive for update to authenticated
using(bucket_id<>'enrollment-documents' or public.portal_can_mutate_unbound_object(bucket_id,name))
with check(bucket_id<>'enrollment-documents' or public.portal_can_mutate_unbound_object(bucket_id,name));
create policy tenant_storage_registered_delete on storage.objects as restrictive for delete to authenticated
using(bucket_id<>'enrollment-documents' or public.portal_can_mutate_unbound_object(bucket_id,name));
create policy tenant_storage_registered_insert on storage.objects as restrictive for insert to authenticated
with check(bucket_id<>'enrollment-documents' or public.portal_can_mutate_unbound_object(bucket_id,name));

do $patch$
declare body text;
begin
 body:=pg_get_functiondef('public.tenant_apply_ownership(uuid)'::regprocedure);
 if strpos(body,'tenant_apply_ownership.source_type')=0 then raise exception 'Unexpected ownership predecessor'; end if;
 body:=replace(body,'source_type text;','mapped_source_type text;');
 body:=replace(body,'source_type:=','mapped_source_type:=');
 body:=replace(body,'if source_type is not null','if mapped_source_type is not null');
 body:=replace(body,'tenant_apply_ownership.source_type','mapped_source_type');
 -- A stale evidence decision is a client-visible conflict, not a transient
 -- serialization failure that PostgREST should retry indefinitely.
 body:=replace(body,'errcode=''40001''','errcode=''PT409''');execute body;
 body:=pg_get_functiondef('public.tenant_approve_ownership(uuid)'::regprocedure);
 execute replace(body,'errcode=''40001''','errcode=''PT409''');
end; $patch$;
