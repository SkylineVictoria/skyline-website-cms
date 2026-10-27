alter table public.cms_settings add column theme_configured boolean not null default false;
alter table public.cms_footer add column links_configured boolean not null default false;
-- Counters are trigger-owned; client-supplied versions cannot confer freshness.
revoke update on public.tenant_website_config from authenticated;
create function public.cms_track_theme() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if (new.primary_color,new.heading_font,new.body_font,new.logo,new.favicon) is distinct from
    (old.primary_color,old.heading_font,old.body_font,old.logo,old.favicon) then
  update public.tenant_website_config set theme_version=theme_version+1 where tenant_id=new.tenant_id;
 end if;
 return new;
end; $$;
revoke all on function public.cms_track_theme() from public,anon,authenticated,service_role;
create trigger track_website_theme after update on public.cms_settings for each row execute function public.cms_track_theme();
