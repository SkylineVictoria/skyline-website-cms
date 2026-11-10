-- Admin sidebar (owner's request 2026-11-10): the Staff group is renamed HRMS, and Jobs moves under Website (last item).
-- Labels and placement only: routes, permissions and pages are unchanged (Jobs stays cms.admin). Safe to run twice.
-- Rollback (manual): set the HRMS group label back to 'Staff' and the /admin/jobs row's parent_id back to 'staff' (sort_order 30).
set local lock_timeout='5s';
set local statement_timeout='60s';

do $menu$
declare v_website text; v_after integer;
begin
 select id into v_website from public.admin_menu_items where id = 'website' and parent_id is null and route is null;
 if v_website is null then raise exception 'The Website menu group was not found. Nothing was changed.'; end if;
 select coalesce(max(sort_order), 0) + 10 into v_after from public.admin_menu_items where parent_id = 'website' and route is distinct from '/admin/jobs';

 alter table public.admin_menu_items disable trigger protect_admin_menu;
 -- The Staff group (id 'staff'; or any top-level group still labelled Staff) becomes HRMS.
 update public.admin_menu_items set label = 'HRMS'
  where parent_id is null and route is null and (id = 'staff' or lower(btrim(label)) = 'staff');
 -- Jobs (/admin/jobs) goes under Website, after its other items.
 update public.admin_menu_items set parent_id = 'website', sort_order = v_after, is_enabled = true
  where route = '/admin/jobs' and parent_id is distinct from 'website';
 alter table public.admin_menu_items enable trigger protect_admin_menu;
end $menu$;
