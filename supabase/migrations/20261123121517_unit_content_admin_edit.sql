-- UNIT-CONTENT-ADMIN (owner, 2026-11-23: "allow admin to do same too"): Admins may add, edit and delete a unit's learning
-- content and documents as RTO Managers can (Add from documents saves onto units; the Resources tab edits and deletes them).
-- unit_content_can_edit() is used by the unit_contents insert / update / delete policies, the unit-content storage insert /
-- delete policies and unit_learning_file_limit(), so this one change covers them all. Read access is unchanged.
-- Rollback: create or replace function public.unit_content_can_edit() returns boolean language sql stable security definer
--   set search_path = public as $$ select coalesce(public.cms_is_rto_manager(), false); $$;
begin;

create or replace function public.unit_content_can_edit() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false);
$$;
revoke all on function public.unit_content_can_edit() from public, anon;
grant execute on function public.unit_content_can_edit() to authenticated;

commit;
