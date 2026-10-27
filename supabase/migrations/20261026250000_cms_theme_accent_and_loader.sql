-- Theme: an optional accent colour and the loader animation style per site (cms_settings), next to the existing primary_color.
-- accent_color is null until an editor picks one (the site keeps its neutral accent); loader_style defaults to the current ring.
-- Both columns are metadata-only additions (constant default), so existing rows are not rewritten and keep their current look.
-- cms_track_theme is redefined (same signature, same privileges) so changing either value also advances tenant_website_config.theme_version,
-- which is what tells open public pages that the theme changed.
--
-- Rollback / compensation (additive; run manually if ever needed):
--   re-create public.cms_track_theme as in 20261025091028 (without the two new columns), then
--   alter table public.cms_settings drop column if exists accent_color, drop column if exists loader_style;
-- Apply with the normal reviewed release process; it must not be assumed applied. The CMS keeps saving settings without these columns
-- until an editor changes the accent or loader style.
begin;

alter table public.cms_settings add column if not exists accent_color text check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$');
alter table public.cms_settings add column if not exists loader_style text not null default 'ring' check (loader_style in ('ring', 'bar', 'dots'));

create or replace function public.cms_track_theme() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.primary_color, new.heading_font, new.body_font, new.logo, new.favicon, new.accent_color, new.loader_style) is distinct from
     (old.primary_color, old.heading_font, old.body_font, old.logo, old.favicon, old.accent_color, old.loader_style) then
    update public.tenant_website_config set theme_version = theme_version + 1 where tenant_id = new.tenant_id;
  end if;
  return new;
end;
$$;

commit;
