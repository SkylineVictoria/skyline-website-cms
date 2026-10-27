-- Published website assets are immutable public objects. Existing public URLs
-- and both private buckets are preserved; metadata status never implies privacy.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('tenant-public-media','tenant-public-media',true,20971520,array['application/pdf','image/png','image/jpeg','image/webp','image/gif']);
create function public.tenant_public_media_access(p_name text) returns boolean
language plpgsql stable security definer set search_path=public as $$
declare t uuid;
begin
 if p_name !~ '^[a-f0-9-]{36}/[a-z]+/[a-zA-Z0-9_./-]+$' or p_name ~ '(^|/)(\.|\.\.)(/|$)' or position(chr(92) in p_name)>0 then return false; end if;
 t:=split_part(p_name,'/',1)::uuid;
 return public.tenant_scope(t) and public.tenant_has_role(t,array['tenant_admin','editor']);
exception when invalid_text_representation then return false;
end; $$;
revoke all on function public.tenant_public_media_access(text) from public,anon,authenticated,service_role;
grant execute on function public.tenant_public_media_access(text) to authenticated;
create policy tenant_public_media_read on storage.objects for select to authenticated
 using(bucket_id='tenant-public-media' and public.tenant_public_media_access(name));
create policy tenant_public_media_insert on storage.objects for insert to authenticated
 with check(bucket_id='tenant-public-media' and public.tenant_public_media_access(name));
-- No UPDATE/DELETE policy: replacement uses a fresh object and retains old URLs.

create function public.cms_safe_public_url(p_value text) returns boolean
language sql immutable set search_path=public as $$
 select p_value is null or p_value='' or
 (p_value !~ '[[:cntrl:]]' and p_value !~ '[[:space:]]' and
  (p_value ~ '^/[^/]' or p_value='/' or p_value ~ '^https?://[^/]+'));
$$;
revoke all on function public.cms_safe_public_url(text) from public,anon,authenticated,service_role;
create function public.cms_validate_public_settings() returns trigger
language plpgsql security definer set search_path=public as $$
declare value text;
begin
 if new.tenant_id is not null then
  foreach value in array array[new.logo,new.favicon,new.home_about_image,new.sign_in_url] loop
   if not public.cms_safe_public_url(value) then raise exception 'Invalid public asset URL' using errcode='22023'; end if;
  end loop;
  foreach value in array new.home_hero_images loop
   if not public.cms_safe_public_url(value) then raise exception 'Invalid public image URL' using errcode='22023'; end if;
  end loop;
 end if;
 return new;
end; $$;
revoke all on function public.cms_validate_public_settings() from public,anon,authenticated,service_role;
create trigger validate_public_settings before insert or update on public.cms_settings for each row execute function public.cms_validate_public_settings();
