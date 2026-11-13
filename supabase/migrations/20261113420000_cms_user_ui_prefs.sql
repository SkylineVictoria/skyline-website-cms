-- UI-PREFS: each CMS user's display preferences (density: compact / comfortable; sidebar: full / icons), saved to their profile.
-- Additive: one column and one function. A user reads and changes only their own preferences.
alter table public.cms_users add column if not exists ui_prefs jsonb not null default '{}'::jsonb;

-- With no argument: the signed-in user's preferences. With one: only known keys and values are kept, merged, and returned.
create or replace function public.cms_user_prefs(p_prefs jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
 if p_prefs is null then
  return coalesce((select ui_prefs from public.cms_users where auth_user_id = auth.uid() limit 1), '{}'::jsonb);
 end if;
 update public.cms_users set ui_prefs = coalesce(ui_prefs, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
   'density', case when p_prefs->>'density' in ('compact', 'comfortable') then p_prefs->>'density' end,
   'sidebar', case when p_prefs->>'sidebar' in ('full', 'icons') then p_prefs->>'sidebar' end))
 where auth_user_id = auth.uid()
 returning ui_prefs into v;
 return coalesce(v, '{}'::jsonb);
end $$;
revoke all on function public.cms_user_prefs(jsonb) from public, anon;
grant execute on function public.cms_user_prefs(jsonb) to authenticated;
