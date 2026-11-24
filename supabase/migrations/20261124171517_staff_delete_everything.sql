-- STAFF-DELETE-EVERYTHING (owner, 2026-11-24: "when you delete, all its associations should be gone; show only once and allow deletion"):
-- HRMS › Staff › Delete removes the person and every row tied to them after one confirmation, whatever their status: onboarding, offers,
-- documents, employment, time / leave / timesheet / holiday records, signing documents, Careers job applications and the rest, found by
-- walking the foreign keys to hr.staff_profiles (public.rto_course_purge, 20261124121517/131517: NOT NULL links deleted, nullable links
-- cleared, triggers off so append-only logs do not refuse). A nullable link such as a student's result signed by them is kept with the
-- signer cleared. Their sign-in account goes too when nothing else uses it (no CMS user, no portal profile). Still refused: your own record.
-- Files: the paths of their documents and résumés are returned for the screen to remove from Storage, as before. One hr.staff_deletions row.
-- Rollback: re-run hr_admin_staff_delete from 20261122043517_staff_edit_delete.sql.
begin;

create or replace function public.hr_admin_staff_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; v_paths text[]; v_counts jsonb;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if p.id is null then raise exception 'Staff member not found.' using errcode = 'P0002'; end if;
 if p.auth_user_id is not null and p.auth_user_id = auth.uid() then raise exception 'You cannot delete your own staff record.' using errcode = '42501'; end if;
 select array_remove(array_agg(distinct path), null) into v_paths from (
  select d.storage_path as path from hr.staff_documents d where d.profile_id = p.id
  union all select a.resume_path from hr.staff_applications a where a.profile_id = p.id) x;
 perform set_config('hr.staff_purge', p.id::text, true);
 set local session_replication_role = replica;
 v_counts := public.rto_course_purge('hr.staff_profiles'::regclass, format('id = %L', p.id), true, '{}', '{}'::jsonb);
 -- Their sign-in account, when it is only theirs.
 if p.auth_user_id is not null
    and not exists (select 1 from public.cms_users c where c.auth_user_id = p.auth_user_id)
    and not exists (select 1 from public.portal_profiles x where x.auth_user_id = p.auth_user_id) then
  delete from auth.users where id = p.auth_user_id;
 end if;
 set local session_replication_role = origin;
 perform set_config('hr.staff_purge', '', true);
 if exists (select 1 from hr.staff_profiles where id = p.id) then raise exception 'The staff record could not be deleted completely; nothing was changed.'; end if;
 insert into hr.staff_deletions(profile_id, email, name, status, files, deleted_by)
 values (p.id, p.email, btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), p.status, coalesce(cardinality(v_paths), 0), v_admin);
 return jsonb_build_object('ok', true, 'email', p.email, 'paths', coalesce(to_jsonb(v_paths), '[]'::jsonb), 'tables', v_counts);
end $function$;
revoke all on function public.hr_admin_staff_delete(uuid) from public, anon;
grant execute on function public.hr_admin_staff_delete(uuid) to authenticated;

commit;
