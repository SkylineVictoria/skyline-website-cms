-- Staff self-registration, part 3 of 3: the "Staff" item in the admin sidebar, next to Businesses / Agents / Students.
-- Apply together with the frontend release that has the /admin/staff route: before it, this link leads to a page the site does not have.
-- Same pattern as 20261102150000_business_admin_sidebar.sql: the protection trigger is switched off for this one statement and
-- back on (the ALTER holds the table lock until commit).
-- It FAILS LOUDLY, rolling back this file only, when the 'agencies' menu group is missing (hosted menus can differ from the repo):
-- a Staff link that silently never appeared would be worse than an error. Run the read-only check in docs/SUPABASE.md first.
-- Rollback (manual): delete from public.admin_menu_items where id = 'agency_staff' (with the protection trigger disabled).
set local lock_timeout='5s';
set local statement_timeout='30s';
do $check$
begin
 if not exists (select 1 from public.admin_menu_items where id = 'agencies') then
  raise exception 'The admin menu group "agencies" does not exist; the Staff item has no parent. Nothing was changed.';
 end if;
end $check$;
alter table public.admin_menu_items disable trigger protect_admin_menu;
insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, is_enabled, permission_key, permission_scope, is_system)
 values ('agency_staff', 'agencies', 'Staff', '/admin/staff', 'users', 40, true, 'cms.admin', 'current', true)
on conflict (id) do update set parent_id = excluded.parent_id, label = excluded.label, route = excluded.route, is_enabled = true;
alter table public.admin_menu_items enable trigger protect_admin_menu;
