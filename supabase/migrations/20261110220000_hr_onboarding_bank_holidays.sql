-- HRMS fixes (owner's request 2026-11-10): bring back staff onboarding next to the simple Employees page, add bank details,
-- and import public holidays in bulk.
--
-- 1. Status rules. 20261110170000 (Employees made simple) re-created hr.staff_transition_allowed and hr.staff_status_guard with the
--    pre-HR-02 status names (draft / submitted / preboarding). On a database that already has 20261110090000 (applied, invited,
--    documents_submitted, offer_sent, offer_signed, active, rejected, inactive) that blocked every onboarding step and every new
--    application:
--      * "A staff profile starts as a draft." on each Careers / Enroll now application (hr_svc_apply), and on "Add staff member";
--      * "cannot move from applied to invited" (document link), invited -> documents_submitted, -> offer_sent, -> offer_signed.
--    This restores the 20261110090000 pipeline and keeps what 20261110170000 added: an Admin may still add someone as Active at once
--    and switch anyone to Active or Inactive.
-- 2. hr.employee_bank: the employee's bank account for pay (account name, BSB, account number, bank name). Admin-only RPCs; the
--    account number is returned masked in lists and in full only to hr_admin_emp_bank_get.
-- 3. hr_admin_holidays_import(p_rows, p_status): many holidays at once (from the Excel / CSV template on Public Holidays). All or
--    nothing: every row is checked first and the call fails with the row numbers of the problems. Same date + name + state = update.
--
-- Rollback (manual): drop the three functions of section 2 and 3 and table hr.employee_bank; re-run hr.staff_transition_allowed and
-- hr.staff_status_guard from 20261110170000 (not recommended: it breaks onboarding again).

-- ------------------------------------------------------------------ 1. status rules
create or replace function hr.staff_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
 select p_to in ('active', 'inactive') or (p_from, p_to) in (
  ('applied','invited'), ('applied','rejected'),
  ('invited','documents_submitted'), ('invited','rejected'),
  ('documents_submitted','invited'), ('documents_submitted','offer_sent'), ('documents_submitted','rejected'),
  ('offer_sent','offer_signed'), ('offer_sent','documents_submitted'), ('offer_sent','rejected'),
  ('offer_signed','rejected'),
  ('rejected','applied'), ('inactive','applied'));
$fn$;

create or replace function hr.staff_status_guard() returns trigger
language plpgsql set search_path = hr, public as $$
begin
 if tg_op = 'INSERT' then
  -- A new record is an application (Careers, Enroll now, Candidates, "Add staff member"); an Admin adding an employee directly
  -- (hr_admin_emp_save sets hr.actor_kind = 'admin') may create them Active.
  if new.status <> 'applied' and not (new.status = 'active' and current_setting('hr.actor_kind', true) = 'admin') then
   raise exception 'A staff profile starts as an application.' using errcode = '23514'; end if;
  return new;
 end if;
 new.updated_at := now();
 if new.status is distinct from old.status then
  if not hr.staff_transition_allowed(old.status, new.status) then
   raise exception 'A staff record cannot move from % to %.', old.status, new.status using errcode = '23514';
  end if;
  new.status_changed_at := now();
 end if;
 return new;
end $$;

-- ------------------------------------------------------------------ 2. bank details
create table if not exists hr.employee_bank (
 profile_id uuid primary key references hr.staff_profiles(id) on delete cascade,
 account_name text not null check (char_length(btrim(account_name)) between 1 and 100),
 bsb text not null check (bsb ~ '^\d{6}$'),
 account_number text not null check (account_number ~ '^\d{4,10}$'),
 bank_name text not null default '' check (char_length(bank_name) <= 100),
 updated_at timestamptz not null default now(),
 updated_by uuid
);
alter table hr.employee_bank enable row level security;
revoke all on hr.employee_bank from anon, authenticated;

create or replace function hr.bank_json(b hr.employee_bank, p_full boolean) returns jsonb
language sql stable set search_path = '' as $fn$
 select case when b.profile_id is null then null else jsonb_build_object(
  'accountName', b.account_name, 'bsb', b.bsb, 'bankName', b.bank_name, 'updatedAt', b.updated_at,
  'accountNumber', case when p_full then b.account_number else repeat('•', greatest(char_length(b.account_number) - 3, 0)) || right(b.account_number, 3) end)
 end;
$fn$;

create or replace function public.hr_admin_emp_bank_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b hr.employee_bank;
begin
 perform hr.require_admin();
 select * into b from hr.employee_bank where profile_id = p_id;
 return hr.bank_json(b, true);
end $$;

-- p_bank: {accountName, bsb, accountNumber, bankName}; null or {} removes the bank details.
create or replace function public.hr_admin_emp_bank_save(p_id uuid, p_bank jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b hr.employee_bank; v_name text; v_bsb text; v_acc text; v_bank text;
begin
 perform hr.require_admin();
 if not exists (select 1 from hr.staff_profiles where id = p_id) then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
 v_name := btrim(coalesce(p_bank->>'accountName', ''));
 v_bsb := regexp_replace(coalesce(p_bank->>'bsb', ''), '[\s-]', '', 'g');
 v_acc := regexp_replace(coalesce(p_bank->>'accountNumber', ''), '[\s-]', '', 'g');
 v_bank := left(btrim(coalesce(p_bank->>'bankName', '')), 100);
 if v_name = '' and v_bsb = '' and v_acc = '' then
  delete from hr.employee_bank where profile_id = p_id;
  return null;
 end if;
 if v_name = '' or char_length(v_name) > 100 then raise exception 'Enter the account name (up to 100 characters).' using errcode = '22023'; end if;
 if v_bsb !~ '^\d{6}$' then raise exception 'The BSB must be 6 digits, for example 062-000.' using errcode = '22023'; end if;
 if v_acc !~ '^\d{4,10}$' then raise exception 'The account number must be 4 to 10 digits.' using errcode = '22023'; end if;
 insert into hr.employee_bank (profile_id, account_name, bsb, account_number, bank_name, updated_at, updated_by)
 values (p_id, v_name, v_bsb, v_acc, v_bank, now(), auth.uid())
 on conflict (profile_id) do update set account_name = excluded.account_name, bsb = excluded.bsb, account_number = excluded.account_number,
  bank_name = excluded.bank_name, updated_at = now(), updated_by = auth.uid()
 returning * into b;
 return hr.bank_json(b, true);
end $$;

-- ------------------------------------------------------------------ 3. holiday import
-- p_rows: [{date: 'YYYY-MM-DD', name, isOptional?, state?, note?}, ...] (up to 500); p_status: 'review' (default) or 'confirmed'.
create or replace function public.hr_admin_holidays_import(p_rows jsonb, p_status text default 'review') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; i int := 0; v_date date; v_name text; v_state text; v_default_state text; problems text[] := '{}';
 v_inserted int := 0; v_updated int := 0; v_status text := coalesce(nullif(p_status, ''), 'review'); v_new boolean;
begin
 perform hr.require_admin();
 if v_status not in ('review', 'confirmed') then raise exception 'Status must be review or confirmed.' using errcode = '22023'; end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'The file has no holidays.' using errcode = '22023'; end if;
 if jsonb_array_length(p_rows) > 500 then raise exception 'Import up to 500 holidays at a time.' using errcode = '22023'; end if;
 select upper(coalesce(nullif(btrim(s.state), ''), 'VIC')) into v_default_state from hr.settings s limit 1;
 v_default_state := coalesce(v_default_state, 'VIC');
 -- Check every row first: nothing is saved if any row is wrong.
 for r in select * from jsonb_array_elements(p_rows) loop
  i := i + 1;
  begin v_date := (r->>'date')::date; exception when others then v_date := null; end;
  v_name := btrim(coalesce(r->>'name', ''));
  v_state := upper(coalesce(nullif(btrim(r->>'state'), ''), v_default_state));
  if v_date is null then problems := problems || format('row %s: the date is missing or not a date', i + 1);
  elsif v_date < date '2000-01-01' or v_date > date '2100-12-31' then problems := problems || format('row %s: the date is out of range', i + 1); end if;
  if v_name = '' or char_length(v_name) > 120 then problems := problems || format('row %s: the name is missing or longer than 120 characters', i + 1); end if;
  if v_state !~ '^[A-Z]{2,3}$' then problems := problems || format('row %s: the state must be like VIC', i + 1); end if;
 end loop;
 if cardinality(problems) > 0 then
  raise exception 'Nothing was imported. Fix these rows and try again: %', array_to_string(problems[1:20], '; ') using errcode = '22023';
 end if;
 for r in select * from jsonb_array_elements(p_rows) loop
  v_date := (r->>'date')::date; v_name := btrim(r->>'name');
  v_state := upper(coalesce(nullif(btrim(r->>'state'), ''), v_default_state));
  insert into hr.public_holidays (holiday_date, name, is_optional, state, status, note, updated_by)
  values (v_date, v_name, coalesce((r->>'isOptional')::boolean, false), v_state, v_status, left(coalesce(r->>'note', ''), 500), auth.uid())
  on conflict (state, holiday_date, name) do update set is_optional = excluded.is_optional, status = excluded.status,
   note = case when excluded.note <> '' then excluded.note else hr.public_holidays.note end, updated_by = auth.uid(), updated_at = now()
  returning (xmax = 0) into v_new;
  if v_new then v_inserted := v_inserted + 1; else v_updated := v_updated + 1; end if;
 end loop;
 return jsonb_build_object('inserted', v_inserted, 'updated', v_updated);
end $$;

-- ------------------------------------------------------------------ privileges
revoke all on function public.hr_admin_emp_bank_get(uuid), public.hr_admin_emp_bank_save(uuid, jsonb),
 public.hr_admin_holidays_import(jsonb, text) from public, anon;
grant execute on function public.hr_admin_emp_bank_get(uuid), public.hr_admin_emp_bank_save(uuid, jsonb),
 public.hr_admin_holidays_import(jsonb, text) to authenticated;
