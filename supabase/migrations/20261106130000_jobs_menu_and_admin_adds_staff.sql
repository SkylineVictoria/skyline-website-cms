-- Jobs get their own sidebar item (Agencies > Jobs, /admin/jobs), the Jobs page lists applicants, and an administrator can add a
-- staff member from the CMS (the staff-register function invites them by email, then calls hr_admin_staff_create with the service
-- role; the person sets a password from the emailed link and completes the staff registration on the same login).
-- Requires 20261106120000_job_posts. Apply with the frontend release that has /admin/jobs (before it, the link leads nowhere).
-- The menu insert fails loudly, rolling back this file only, when the 'agencies' menu group is missing (same as 20261105200000).
-- Rollback (manual): delete from public.admin_menu_items where id = 'agency_jobs' (protection trigger disabled);
-- drop function public.hr_admin_job_applications(uuid), public.hr_admin_staff_create(uuid, text, text, text, text, text, uuid).
set local lock_timeout='5s';
set local statement_timeout='30s';

do $check$
begin
 if not exists (select 1 from public.admin_menu_items where id = 'agencies') then
  raise exception 'The admin menu group "agencies" does not exist; the Jobs item has no parent. Nothing was changed.';
 end if;
end $check$;
alter table public.admin_menu_items disable trigger protect_admin_menu;
insert into public.admin_menu_items(id, parent_id, label, route, icon_key, sort_order, is_enabled, permission_key, permission_scope, is_system)
 values ('agency_jobs', 'agencies', 'Jobs', '/admin/jobs', 'jobs', 50, true, 'cms.admin', 'current', true)
on conflict (id) do update set parent_id = excluded.parent_id, label = excluded.label, route = excluded.route, icon_key = excluded.icon_key, is_enabled = true;
alter table public.admin_menu_items enable trigger protect_admin_menu;

-- Every job application (or one job's), newest first, with the applicant: for the Applicants tab of the Jobs page.
create or replace function public.hr_admin_job_applications(p_job uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'jobId', j.id, 'jobTitle', j.title, 'employmentType', j.employment_type, 'location', j.location,
   'profileId', p.id, 'name', btrim(concat_ws(' ', p.first_name, p.last_name)), 'email', p.email, 'phone', p.phone_e164, 'staffStatus', p.status,
   'status', a.status, 'appliedAt', a.created_at, 'decidedAt', a.decided_at, 'decisionNote', a.decision_note,
   'resume', (select jsonb_build_object('filename', d.filename, 'storagePath', d.storage_path) from hr.staff_documents d where d.id = a.resume_document_id))
   order by a.created_at desc)
  from hr.job_applications a join hr.jobs j on j.id = a.job_id join hr.staff_profiles p on p.id = a.profile_id
  where p_job is null or a.job_id = p_job), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_admin_job_applications(uuid) from public, anon;
grant execute on function public.hr_admin_job_applications(uuid) to authenticated;

-- An administrator adds a staff member (service role only: the staff-register function has already verified the caller is an
-- Active CMS Admin and invited or found the Auth user). The record starts as a draft with the name filled in; the person sets a
-- password from the emailed link and completes the rest. The same duplicate checks as self sign-up apply; a draft may repeat.
create or replace function public.hr_admin_staff_create(p_auth_user_id uuid, p_email text, p_phone text, p_first_name text, p_last_name text, p_role text default null, p_admin uuid default null) returns jsonb
language plpgsql security definer set search_path = public, hr, auth, pg_temp as $fn$
declare v_email text := hr.email_key(p_email); v_phone text := hr.phone_e164(p_phone); v_role text := nullif(btrim(coalesce(p_role, '')), ''); c jsonb; p hr.staff_profiles;
begin
 if p_auth_user_id is null or not exists (select 1 from auth.users u where u.id = p_auth_user_id) then raise exception 'The sign-in account was not found.' using errcode = 'P0002'; end if;
 if v_email is null or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
 if v_phone is null then raise exception 'Enter a valid mobile number with its country code.' using errcode = '22023'; end if;
 if char_length(btrim(coalesce(p_first_name, ''))) = 0 or char_length(btrim(coalesce(p_last_name, ''))) = 0 then raise exception 'Enter the first and last name.' using errcode = '22023'; end if;
 if char_length(p_first_name) > 100 or char_length(p_last_name) > 100 then raise exception 'Names must be 100 characters or fewer.' using errcode = '22023'; end if;
 if v_role is not null and v_role not in ('admin','trainer') then raise exception 'Choose Admin or Trainer.' using errcode = '22023'; end if;
 if exists (select 1 from hr.staff_profiles where auth_user_id = p_auth_user_id) then raise exception 'This person already has a staff record.' using errcode = '23505'; end if;
 c := hr.contact_conflicts(v_email, v_phone, p_auth_user_id);
 if jsonb_array_length(c->'email') > 0 then raise exception 'This email is already used by another record (%).', (select string_agg(x, ', ') from jsonb_array_elements_text(c->'email') x) using errcode = '23505'; end if;
 if jsonb_array_length(c->'phone') > 0 then raise exception 'This mobile number is already used by another record (%).', (select string_agg(x, ', ') from jsonb_array_elements_text(c->'phone') x) using errcode = '23505'; end if;
 perform set_config('hr.actor', coalesce(p_admin::text, ''), true); perform set_config('hr.actor_kind', 'admin', true);
 perform set_config('hr.note', 'Added by an administrator', true);
 insert into hr.staff_profiles(auth_user_id, email, phone_e164, first_name, last_name) values (p_auth_user_id, v_email, v_phone, btrim(p_first_name), btrim(p_last_name)) returning * into p;
 insert into hr.staff_applications(profile_id, requested_role) values (p.id, v_role);
 return jsonb_build_object('id', p.id, 'status', p.status);
exception when unique_violation then
 if sqlerrm like '%staff_profiles_phone_key%' then raise exception 'This mobile number is already used by another staff record.' using errcode = '23505'; end if;
 if sqlerrm like '%staff_profiles_email_key%' then raise exception 'This email is already used by another staff record.' using errcode = '23505'; end if;
 raise;
end $fn$;
revoke all on function public.hr_admin_staff_create(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.hr_admin_staff_create(uuid, text, text, text, text, text, uuid) to service_role;
