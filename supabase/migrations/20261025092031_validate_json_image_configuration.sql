-- CMS hero images are a JSON array, retained from the existing schema.
create or replace function public.cms_validate_public_settings() returns trigger
language plpgsql security definer set search_path=public as $$
declare value text;
begin
 if new.tenant_id is not null then
  foreach value in array array[new.logo,new.favicon,new.home_about_image,new.sign_in_url] loop
   if not public.cms_safe_public_url(value) then raise exception 'Invalid public asset URL' using errcode='22023'; end if;
  end loop;
  for value in select jsonb_array_elements_text(new.home_hero_images) loop
   if not public.cms_safe_public_url(value) then raise exception 'Invalid public image URL' using errcode='22023'; end if;
  end loop;
 end if;
 return new;
end; $$;
