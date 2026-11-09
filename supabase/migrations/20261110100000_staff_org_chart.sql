-- Staff > Employees > Org chart: who reports to whom, read from hr.employment (manager_id, job_title, department; 20261109153953).
-- Additive: two Admin-only functions, no table changes.
--   hr_admin_org_chart()                          everyone on the chart: active staff, plus anyone further along the pipeline who already has
--                                                 a manager (e.g. added "under" someone); never rejected or inactive people
--   hr_admin_staff_manager_set(p_id, p_manager)   changes only the manager (null: top of the chart), with the same rules as
--                                                 hr_admin_staff_employment_save (20261110090000): the manager is an active employee, nobody
--                                                 manages themselves, no reporting cycle. A missing hr.employment row (for the person, or for
--                                                 an active manager) is created with empty details, so any active person can be a manager.
-- Rollback (manual): drop function public.hr_admin_staff_manager_set(uuid, uuid), public.hr_admin_org_chart(), hr.on_org_chart(text, uuid).
set local lock_timeout='5s';
set local statement_timeout='60s';

-- On the chart: active staff, or a pipeline record that already has a manager.
create or replace function hr.on_org_chart(p_status text, p_manager uuid) returns boolean
language sql immutable parallel safe as $fn$
 select p_status = 'active' or (p_status in ('applied','invited','documents_submitted','offer_sent','offer_signed') and p_manager is not null);
$fn$;
revoke all on function hr.on_org_chart(text, uuid) from public, anon, authenticated;

create or replace function public.hr_admin_org_chart() returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id', p.id, 'name', hr.staff_name(p), 'email', p.email, 'status', p.status,
   'role', (select r.role from hr.staff_roles r where r.profile_id = p.id and r.revoked_at is null),
   'jobTitle', coalesce(e.job_title, ''), 'department', coalesce(e.department, ''), 'employmentType', e.employment_type,
   'workLocation', coalesce(e.work_location, ''),
   -- A manager who is no longer on the chart (e.g. made inactive) is not shown as anyone's manager.
   'managerId', case when m.id is not null and hr.on_org_chart(m.status, me.manager_id) then m.id end)
  order by lower(hr.staff_name(p)))
  from hr.staff_profiles p
  left join hr.employment e on e.profile_id = p.id
  left join hr.staff_profiles m on m.id = e.manager_id
  left join hr.employment me on me.profile_id = m.id
  where hr.on_org_chart(p.status, e.manager_id)), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_org_chart() from public, anon;
grant execute on function public.hr_admin_org_chart() to authenticated;

create or replace function public.hr_admin_staff_manager_set(p_id uuid, p_manager uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare p hr.staff_profiles; m hr.staff_profiles;
begin
 perform hr.require_admin();
 -- One change at a time, so two Admins cannot build a cycle between them.
 perform pg_advisory_xact_lock(hashtext('hr.org_chart'));
 select * into p from hr.staff_profiles where id = p_id for update;
 if not found then raise exception 'Staff record not found.' using errcode = 'P0002'; end if;
 if p.status in ('rejected','inactive') then raise exception 'A rejected or inactive person is not on the org chart.' using errcode = '23514'; end if;
 if p_manager is not null then
  if p_manager = p.id then raise exception 'A person cannot be their own manager.' using errcode = '23514'; end if;
  select * into m from hr.staff_profiles where id = p_manager;
  if not found or m.status <> 'active' then raise exception 'Choose an active employee as the manager.' using errcode = '22023'; end if;
  insert into hr.employment(profile_id) values (m.id) on conflict (profile_id) do nothing;
  if exists (with recursive chain as (select e.profile_id, e.manager_id from hr.employment e where e.profile_id = p_manager
    union select e.profile_id, e.manager_id from hr.employment e join chain c on e.profile_id = c.manager_id) select 1 from chain where profile_id = p.id) then
   raise exception '% already reports to %, so % cannot be their manager.', hr.staff_name(m), hr.staff_name(p), hr.staff_name(m) using errcode = '23514'; end if;
 end if;
 insert into hr.employment(profile_id, manager_id) values (p.id, p_manager)
 on conflict (profile_id) do update set manager_id = excluded.manager_id;
 return jsonb_build_object('id', p.id, 'managerId', p_manager);
end $fn$;
revoke all on function public.hr_admin_staff_manager_set(uuid, uuid) from public, anon;
grant execute on function public.hr_admin_staff_manager_set(uuid, uuid) to authenticated;
