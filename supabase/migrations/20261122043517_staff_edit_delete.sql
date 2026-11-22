-- STAFF-EDIT-DELETE (2026-11-22, admin request). Additive.
-- Staff > Employees lists everyone with their status; each row can be edited (name, email, optional mobile) and deleted.
-- hr_admin_staff_edit: any status; email cannot change once the person has a login; mobile optional (checked when given).
-- hr_admin_staff_delete: Admins only; never an Active person (set Inactive first) or the caller themself; refused while the person
--   has work records (time, leave, timesheet approvals, optional holidays, signed unit outcomes), signing requests or a Careers job
--   application. Removes their onboarding records and returns the stored file paths; the page then removes those files (storage
--   policy staff_documents_admin_delete_orphans: an Admin may delete a staff-documents file no record points to). Logged in
--   hr.staff_deletions.
-- Rollback (manual): drop the two functions, the policy and hr.staff_deletions.
begin;

create table if not exists hr.staff_deletions (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null,
 email text,
 name text,
 status text,
-- rule-policy: technical audit-column Count of files removed with the record.
 files integer not null default 0,
 deleted_by uuid not null,
 deleted_at timestamptz not null default now()
);
alter table hr.staff_deletions enable row level security;
revoke all on hr.staff_deletions from anon, authenticated;

-- The append-only logs (staff_status_events, recruitment_events, staff_audit) still refuse every update and truncate; a delete is
-- allowed only for the one profile hr_admin_staff_delete is removing in this transaction (transaction-local hr.staff_purge).
create or replace function hr.staff_events_append_only() returns trigger language plpgsql as $function$
begin
 if tg_op = 'DELETE' and tg_level = 'ROW' then
  if old.profile_id is not null and coalesce(current_setting('hr.staff_purge', true), '') = old.profile_id::text then return old; end if;
 end if;
-- rule-policy: security append-only The logs stay append-only except for this one purge.
 raise exception 'The staff status log is append-only.' using errcode = '23514';
end $function$;

create or replace function public.hr_admin_staff_edit(p_id uuid, p_first_name text, p_last_name text, p_email text, p_phone text default null)
returns uuid language plpgsql security definer set search_path = public, hr, pg_temp as $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; v_email text := hr.email_key(p_email);
 v_first text := btrim(coalesce(p_first_name, '')); v_last text := btrim(coalesce(p_last_name, '')); v_phone text;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if p.id is null then raise exception 'Staff member not found.' using errcode = 'P0002'; end if;
 if v_first = '' or v_last = '' or char_length(v_first) > 100 or char_length(v_last) > 100 or (v_first || v_last) ~ '[[:cntrl:]<>]' then raise exception 'Enter the first and last name.' using errcode = '22023'; end if;
 if v_email is null or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' or char_length(v_email) > 254 then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
 if p.auth_user_id is not null and v_email <> p.email then raise exception 'This person already signs in with %, so their email cannot be changed here.', p.email using errcode = '22023'; end if;
 if exists (select 1 from hr.staff_profiles s where s.email = v_email and s.id <> p.id) then
  raise exception 'Another staff record already uses %.', v_email using errcode = '23505', hint = 'email_taken'; end if;
 if nullif(btrim(coalesce(p_phone, '')), '') is null then v_phone := p.phone_e164;
 else
  v_phone := hr.phone_e164(p_phone);
  if v_phone is null then raise exception 'Enter a valid mobile number.' using errcode = '22023'; end if;
  if exists (select 1 from hr.staff_profiles s where s.phone_e164 = v_phone and s.id <> p.id) then
   raise exception 'Another staff record already uses the mobile number %.', v_phone using errcode = '23505'; end if;
 end if;
 -- rule-policy: technical audit-actor Records who changed the details.
 perform set_config('hr.actor', v_admin::text, true); perform set_config('hr.actor_kind', 'admin', true); perform set_config('hr.note', 'Details edited by an administrator', true);
 update hr.staff_profiles set first_name = v_first, last_name = v_last, email = v_email, phone_e164 = v_phone where id = p.id;
 return p.id;
end $function$;

create or replace function public.hr_admin_staff_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $function$
declare v_admin uuid := hr.require_admin(); p hr.staff_profiles; v_paths text[]; v_block text;
begin
 select * into p from hr.staff_profiles where id = p_id for update;
 if p.id is null then raise exception 'Staff member not found.' using errcode = 'P0002'; end if;
 if p.auth_user_id is not null and p.auth_user_id = auth.uid() then raise exception 'You cannot delete your own staff record.' using errcode = '42501'; end if;
 -- rule-policy: security delete-guard An Active person is never deleted; work and signing records are never removed this way.
 if p.status = 'active' then raise exception 'Active staff cannot be deleted. Set them Inactive first.' using errcode = '23514'; end if;
 v_block := case
  when exists (select 1 from hr.time_events x where x.profile_id = p.id) then 'time records'
  when exists (select 1 from hr.leave_requests x where x.profile_id = p.id) or exists (select 1 from hr.leave_ledger x where x.profile_id = p.id) then 'leave records'
  -- rule-policy: security delete-guard Work records are never deleted this way.
  when exists (select 1 from hr.timesheet_approvals x where x.profile_id = p.id) then 'timesheet approvals'
  when exists (select 1 from hr.optional_holiday_requests x where x.profile_id = p.id) then 'holiday requests'
  when exists (select 1 from public.asm_unit_outcomes x where x.signed_staff_id = p.id) then 'signed assessment results'
  when exists (select 1 from hr.sign_requests x where x.profile_id = p.id) then 'signing documents'
  when exists (select 1 from hr.job_applications x where x.profile_id = p.id) then 'a Careers job application (reject it instead)'
  else null end;
 if v_block is not null then raise exception 'This person has % and cannot be deleted. Set them Inactive instead.', v_block using errcode = '23514'; end if;
 select array_remove(array_agg(distinct path), null) into v_paths from (
  select d.storage_path as path from hr.staff_documents d where d.profile_id = p.id
  union all select a.resume_path from hr.staff_applications a where a.profile_id = p.id) x;
 perform set_config('hr.staff_purge', p.id::text, true);
 delete from hr.staff_status_events where profile_id = p.id;
 delete from hr.recruitment_events where profile_id = p.id;
 delete from hr.staff_emails where profile_id = p.id;
 delete from hr.staff_invites where profile_id = p.id;
 delete from hr.staff_offers where profile_id = p.id;
 delete from hr.staff_roles where profile_id = p.id;
 delete from hr.staff_documents where profile_id = p.id;
 delete from hr.employment where profile_id = p.id;
 delete from hr.staff_applications where profile_id = p.id;
 delete from hr.staff_profiles where id = p.id;
 perform set_config('hr.staff_purge', '', true);
 insert into hr.staff_deletions(profile_id, email, name, status, files, deleted_by)
 values (p.id, p.email, btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), p.status, coalesce(cardinality(v_paths), 0), v_admin);
 return jsonb_build_object('ok', true, 'email', p.email, 'paths', coalesce(to_jsonb(v_paths), '[]'::jsonb));
end $function$;

drop policy if exists staff_documents_admin_delete_orphans on storage.objects;
create policy staff_documents_admin_delete_orphans on storage.objects for delete to authenticated
 using (bucket_id = 'staff-documents' and public.cms_is_admin()
  and not exists (select 1 from hr.staff_documents d where d.storage_path = objects.name)
  and not exists (select 1 from hr.staff_applications a where a.resume_path = objects.name));

revoke all on function public.hr_admin_staff_edit(uuid, text, text, text, text), public.hr_admin_staff_delete(uuid) from public, anon;
grant execute on function public.hr_admin_staff_edit(uuid, text, text, text, text), public.hr_admin_staff_delete(uuid) to authenticated;

commit;
