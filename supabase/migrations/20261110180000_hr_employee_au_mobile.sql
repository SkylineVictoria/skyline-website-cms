-- Staff > Employees: the mobile number must be an Australian mobile (+614 and 8 digits), as the form already checks
-- (src/lib/employeeRules.ts toAuMobile). Replaces hr_admin_emp_save of 20261110170000; only the phone check changes. Existing
-- employees keep their number until it is edited.
-- Rollback (manual): re-run hr_admin_emp_save from 20261110170000.
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function public.hr_admin_emp_save(p_id uuid, p_person jsonb) returns uuid
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin();
 v_first text := btrim(coalesce(p_person->>'firstName', '')); v_last text := btrim(coalesce(p_person->>'lastName', ''));
 v_email text := lower(btrim(coalesce(p_person->>'email', ''))); v_phone text := btrim(coalesce(p_person->>'phone', ''));
 v_problem text; p hr.staff_profiles; v_other hr.staff_profiles;
begin
 v_problem := coalesce(hr.emp_name_problem(v_first, 'first name'), hr.emp_name_problem(v_last, 'last name'));
 if v_problem is null and (v_email = '' or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$') then v_problem := 'Enter a valid email address.'; end if;
 if v_problem is null and v_phone !~ '^\+614\d{8}$' then v_problem := 'Enter an Australian mobile number, for example 0412 345 678.'; end if;
 if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;
 perform set_config('hr.actor', v_admin::text, true);
 perform set_config('hr.actor_kind', 'admin', true);
 perform pg_advisory_xact_lock(hashtext('hr.emp_save'));

 if p_id is null then
  select * into p from hr.staff_profiles where email = v_email for update;
  if found and p.status in ('active','inactive') then
   raise exception '% is already an employee (%).', v_email, p.status using errcode = '23505'; end if;
 else
  select * into p from hr.staff_profiles where id = p_id for update;
  if not found then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
  select * into v_other from hr.staff_profiles where email = v_email and id <> p.id;
  if found then raise exception 'Another staff record already uses %.', v_email using errcode = '23505'; end if;
  if p.auth_user_id is not null and p.email <> v_email then
   raise exception 'This person already signs in with %, so their email cannot be changed here.', p.email using errcode = '22023'; end if;
 end if;
 select * into v_other from hr.staff_profiles where phone_e164 = v_phone and id is distinct from p.id;
 if found then raise exception 'Another staff record already uses the mobile number %.', v_phone using errcode = '23505'; end if;

 if p.id is null then
  insert into hr.staff_profiles(first_name, last_name, email, phone_e164, status) values (v_first, v_last, v_email, v_phone, 'active') returning * into p;
 else
  -- Editing, or a candidate with this email becoming the employee.
  update hr.staff_profiles set first_name = v_first, last_name = v_last, email = v_email, phone_e164 = v_phone,
   status = case when p_id is null then 'active' else status end where id = p.id returning * into p;
 end if;
 insert into hr.staff_applications(profile_id) values (p.id) on conflict (profile_id) do nothing;
 insert into hr.employment(profile_id) values (p.id) on conflict (profile_id) do nothing;
 return p.id;
end $fn$;
revoke all on function public.hr_admin_emp_save(uuid, jsonb) from public, anon;
grant execute on function public.hr_admin_emp_save(uuid, jsonb) to authenticated;
