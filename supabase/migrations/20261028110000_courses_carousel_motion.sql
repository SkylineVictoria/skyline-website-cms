-- Homepage courses carousel: motion style (continuous drift or slide by slide) and drift speed (cms_settings).
-- Constant defaults make this metadata-only: existing rows become "drift, slow", the new default look.
-- Writes stay Admin-only: the guard from 20261028100000 is redefined to cover the two new columns.
--
-- Rollback / compensation (additive; run manually if ever needed):
--   re-create public.cms_guard_carousel_settings as in 20261028100000, then
--   alter table public.cms_settings drop column if exists courses_carousel_motion, drop column if exists courses_carousel_drift_speed;
-- Apply with the normal reviewed release process (after 20261028100000); it must not be assumed applied.
begin;

alter table public.cms_settings add column if not exists courses_carousel_motion text not null default 'drift'
  check (courses_carousel_motion in ('drift', 'slide'));
alter table public.cms_settings add column if not exists courses_carousel_drift_speed text not null default 'slow'
  check (courses_carousel_drift_speed in ('slow', 'medium', 'fast'));

create or replace function public.cms_guard_carousel_settings() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.courses_carousel_auto, new.courses_carousel_interval_seconds, new.courses_carousel_pause_on_hover, new.courses_carousel_motion, new.courses_carousel_drift_speed) is distinct from
     (case when tg_op = 'UPDATE' then old.courses_carousel_auto else true end,
      case when tg_op = 'UPDATE' then old.courses_carousel_interval_seconds else 5 end,
      case when tg_op = 'UPDATE' then old.courses_carousel_pause_on_hover else true end,
      case when tg_op = 'UPDATE' then old.courses_carousel_motion else 'drift' end,
      case when tg_op = 'UPDATE' then old.courses_carousel_drift_speed else 'slow' end) then
    if not (case when new.tenant_id is null then public.cms_is_admin() else public.tenant_has_role(new.tenant_id, array['tenant_admin']) end) then
      raise exception 'Only administrators can change the homepage carousel settings' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.cms_guard_carousel_settings() from public, anon, authenticated, service_role;

commit;
