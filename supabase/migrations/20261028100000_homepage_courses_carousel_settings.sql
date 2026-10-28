-- Homepage courses carousel: admin-configurable auto-slide (cms_settings).
-- Columns are metadata-only additions with constant defaults (on, 5 seconds, pause on hover), so existing rows keep today's behaviour.
-- Writes go through cms_commit (CMS staff / tenant admins and editors only); the public snapshot already serves the whole cms_settings row to anon,
-- and the homepage reads only these three fields from it.
--
-- Rollback / compensation (additive; run manually if ever needed):
--   alter table public.cms_settings drop column if exists courses_carousel_auto, drop column if exists courses_carousel_interval_seconds,
--     drop column if exists courses_carousel_pause_on_hover;
-- Apply with the normal reviewed release process; it must not be assumed applied. The CMS saves settings without these columns
-- until an editor changes the carousel settings.
begin;

alter table public.cms_settings add column if not exists courses_carousel_auto boolean not null default true;
alter table public.cms_settings add column if not exists courses_carousel_interval_seconds integer not null default 5
  check (courses_carousel_interval_seconds between 2 and 30);
alter table public.cms_settings add column if not exists courses_carousel_pause_on_hover boolean not null default true;


-- Editors may change other website settings, but the carousel settings are administrator-only.
-- cms_commit already rejects non-staff and (on a tenant site) non-admin/editor callers; this adds the admin-only rule at the table.
-- Calls without a signed-in user (migrations, service role) are not restricted.
create or replace function public.cms_guard_carousel_settings() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.courses_carousel_auto, new.courses_carousel_interval_seconds, new.courses_carousel_pause_on_hover) is distinct from
     (case when tg_op = 'UPDATE' then old.courses_carousel_auto else true end,
      case when tg_op = 'UPDATE' then old.courses_carousel_interval_seconds else 5 end,
      case when tg_op = 'UPDATE' then old.courses_carousel_pause_on_hover else true end) then
    if not (case when new.tenant_id is null then public.cms_is_admin() else public.tenant_has_role(new.tenant_id, array['tenant_admin']) end) then
      raise exception 'Only administrators can change the homepage carousel settings' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.cms_guard_carousel_settings() from public, anon, authenticated, service_role;
drop trigger if exists cms_guard_carousel_settings on public.cms_settings;
create trigger cms_guard_carousel_settings before insert or update on public.cms_settings for each row execute function public.cms_guard_carousel_settings();

commit;
