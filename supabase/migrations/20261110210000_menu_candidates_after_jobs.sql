-- Admin sidebar (owner's request 2026-11-10): Candidates moves from HRMS to Website, directly below Jobs (20261110200000).
-- Labels and placement only: the route (/admin/staff/candidates), permissions and page are unchanged. Safe to run twice.
-- Rollback (manual): set the /admin/staff/candidates row's parent_id back to 'staff' and sort_order to 10.
set local lock_timeout='5s';
set local statement_timeout='60s';

do $menu$
declare v_jobs integer;
begin
 select sort_order into v_jobs from public.admin_menu_items where route = '/admin/jobs' and parent_id = 'website';
 if v_jobs is null then raise exception 'Jobs is not under Website yet (run 20261110200000 first). Nothing was changed.'; end if;
 alter table public.admin_menu_items disable trigger protect_admin_menu;
 -- Make room right after Jobs only when another item sits there, then put Candidates there.
 update public.admin_menu_items set sort_order = sort_order + 10
  where parent_id = 'website' and sort_order > v_jobs and sort_order <= v_jobs + 5 and route is distinct from '/admin/staff/candidates';
 update public.admin_menu_items set parent_id = 'website', sort_order = v_jobs + 5, is_enabled = true
  where route = '/admin/staff/candidates';
 alter table public.admin_menu_items enable trigger protect_admin_menu;
end $menu$;
