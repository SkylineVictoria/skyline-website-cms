-- Staff onboarding wizard (owner's brief 2026-11-10): upload documents first, details filled from them, bank details through the
-- private link, encrypted at rest, masked for administrators with an audited Reveal.
--
-- 1. hr.staff_profiles: nationality, passport_number, visa_subclass, visa_conditions (read from the documents or typed). The two
--    phone checks accept the shortest number the shared phone rule accepts (7 digits in all; was 8).
-- 2. hr.v_*: the shared person rules (supabase/functions/_shared/validation/person.ts and staff-onboarding.ts) repeated in SQL with
--    the same messages: phone, name, date of birth, and hr.v_staff_problem (the first problem of a set of onboarding fields, as a
--    draft or as the final check). scripts/lab/staff-lab.mjs `wizard` compares both sides on one list of inputs.
-- 3. hr.employee_bank: account name, BSB and account number are stored ENCRYPTED (pgcrypto, AES-256, key in Supabase Vault as
--    hr_bank_details_key, created here when missing and never printed). Existing rows are encrypted, checked by decrypting, and
--    the plain columns are emptied and locked to null. Only security-definer functions read the key.
--    hr_admin_emp_bank_get now answers MASKED (BSB 06••••, account •••• 4321); hr_admin_emp_bank_reveal answers in full and writes
--    "bank_revealed" to hr.staff_audit; both are for Admins only (hr.require_admin: an Editor is refused). The person saves their
--    own through the link (hr_svc_onboarding_bank_save, service role only).
-- 4. Onboarding by link: documents may be uploaded without an expiry date (the reader fills it; Submit still needs a current one),
--    the reader also fills nationality, passport number, visa subclass and the passport / visa expiry dates, the person may correct
--    their mobile, and Submit needs the details, the bank details and the documents. A re-upload link is unchanged.
-- 5. hr.staff_section_checks + hr_admin_onboarding_check / hr_admin_onboarding_extras: an administrator's "verified" tick per
--    section (personal, bank, and one per document type), audited, cleared when that document or the bank details change.
-- 6. Retention (hr.staff_anonymise) also clears the new columns, the bank details and the ticks.
--
-- Rollback (manual): the bank details cannot go back to plain text without the Vault key; to undo the rest, re-run the functions
-- hr_svc_onboarding_save / _submit / hr_svc_document_add / hr_staff_document_apply_extraction / hr.staff_applicant_view /
-- hr.staff_anonymise from 20261110090000 and hr_admin_emp_bank_* from 20261110220000 (after decrypting into the plain columns),
-- then drop hr.staff_section_checks, the hr.v_* functions and the four new columns.
set local lock_timeout='5s';
set local statement_timeout='120s';

-- ------------------------------------------------------------------ 1. columns
alter table hr.staff_profiles
 add column if not exists nationality text not null default '' check (char_length(nationality) <= 100),
 add column if not exists passport_number text not null default '' check (passport_number = '' or passport_number ~ '^[A-Z0-9]{6,12}$'),
 add column if not exists visa_subclass text not null default '' check (char_length(visa_subclass) <= 100),
 add column if not exists visa_conditions text not null default '' check (char_length(visa_conditions) <= 500);

do $phones$
declare r record;
begin
 for r in select conname from pg_constraint where conrelid = 'hr.staff_profiles'::regclass and contype = 'c'
   and pg_get_constraintdef(oid) like '%phone_e164%' and pg_get_constraintdef(oid) like '%{7,14}%' loop
  execute format('alter table hr.staff_profiles drop constraint %I', r.conname);
 end loop;
end $phones$;
alter table hr.staff_profiles drop constraint if exists staff_profiles_phone_format;
alter table hr.staff_profiles add constraint staff_profiles_phone_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9]\d{6,14}$');
alter table hr.staff_profiles drop constraint if exists staff_profiles_emergency_phone_format;
alter table hr.staff_profiles add constraint staff_profiles_emergency_phone_format check (emergency_phone_e164 is null or emergency_phone_e164 ~ '^\+[1-9]\d{6,14}$');

-- ------------------------------------------------------------------ 2. the shared rules, in SQL
-- JS String.trim(): leading and trailing white space of any kind.
create or replace function hr.v_trim(p text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select regexp_replace(coalesce(p, ''), '^\s+|\s+$', '', 'g'); $fn$;

-- CONTROL in person.ts: U+0001 to U+001F and U+007F (text cannot hold U+0000).
create or replace function hr.v_has_control(p text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select coalesce(p, '') ~ '[\x01-\x1F\x7F]'; $fn$;

-- phoneProblem(): "+" and a known country code (the shared picker's nine), then validatePhone().
create or replace function hr.v_phone_problem(p_value text, p_missing text) returns text
language plpgsql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
declare v text := regexp_replace(coalesce(p_value, ''), '^\s+|\s+$', '', 'g'); d text; v_dial text; v_nat text;
begin
 if v = '' or left(v, 1) <> '+' then return p_missing; end if;
 d := regexp_replace(v, '\D', '', 'g');
 v_dial := case when d like '977%' then '977' when d like '880%' then '880'
  when left(d, 2) in ('61','91','63','94','92','44') then left(d, 2) when left(d, 1) = '1' then '1' end;
 if v_dial is null then return p_missing; end if;
 v_nat := substr(d, char_length(v_dial) + 1);
 if v_nat = '' then return p_missing; end if;
 if v_dial = '61' then
  return case when v_nat ~ '^[1-9]\d{8}$' then '' else 'Enter a 10-digit Australian number starting with 0, e.g. 041 234 5678.' end;
 end if;
 return case when v_nat ~ '^\d{6,12}$' and char_length(v_dial) + char_length(v_nat) <= 15 then '' else 'Enter a valid phone number for the selected country.' end;
end $fn$;

-- The value as it is stored: "+" and the digits.
create or replace function hr.v_phone_store(p_value text) returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select '+' || regexp_replace(coalesce(p_value, ''), '\D', '', 'g'); $fn$;

-- nameProblem(value, what).
create or replace function hr.v_name_problem(p_value text, p_what text) returns text
language plpgsql immutable parallel safe set search_path = hr, pg_catalog, pg_temp as $fn$
declare v text := hr.v_trim(p_value);
begin
 if v = '' then return format('Enter your %s.', p_what); end if;
 if hr.v_has_control(v) or char_length(v) > 100 then return format('The %s must be 100 characters or fewer.', p_what); end if;
 return '';
end $fn$;

-- parseDateOfBirth(): YYYY-MM-DD or D/M/YYYY, a real date, 10 to 100 years before p_today (the JS rule: the same day of the month
-- that many years back, rolling over like Date.UTC does). Null when it is not usable.
create or replace function hr.v_dob_parse(p_value text, p_today date, out o_date date, out o_real boolean) returns record
language plpgsql immutable parallel safe set search_path = hr, pg_catalog, pg_temp as $fn$
declare v text := hr.v_trim(p_value); m text[]; y integer; mo integer; d integer; v_date date; v_young date; v_old date;
begin
 o_date := null; o_real := false;
 m := regexp_match(v, '^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$');
 if m is not null then d := m[1]::integer; mo := m[2]::integer; y := m[3]::integer;
 else
  m := regexp_match(v, '^(\d{4})-(\d{2})-(\d{2})$');
  if m is null then return; end if;
  y := m[1]::integer; mo := m[2]::integer; d := m[3]::integer;
 end if;
 begin v_date := make_date(y, mo, d); exception when others then return; end;
 o_real := true;
 v_young := make_date(extract(year from p_today)::integer - 10, extract(month from p_today)::integer, 1) + (extract(day from p_today)::integer - 1);
 v_old := make_date(extract(year from p_today)::integer - 100, extract(month from p_today)::integer, 1) + (extract(day from p_today)::integer - 1);
 if v_date > v_young or v_date < v_old then return; end if;
 o_date := v_date;
end $fn$;

-- dateOfBirthProblem().
create or replace function hr.v_dob_problem(p_value text, p_today date default null) returns text
language plpgsql stable parallel safe set search_path = hr, pg_catalog, pg_temp as $fn$
declare r record;
begin
 if hr.v_trim(p_value) = '' then return 'Enter your date of birth.'; end if;
 r := hr.v_dob_parse(p_value, coalesce(p_today, (now() at time zone 'utc')::date));
 if r.o_date is not null then return ''; end if;
 return case when r.o_real then 'You must be between 10 and 100 years old.' else 'Enter a real date of birth.' end;
end $fn$;

-- bankProblems(): the first problem (account name, BSB, account number), or ''.
create or replace function hr.v_bank_problem(p_name text, p_bsb text, p_account text) returns text
language plpgsql immutable parallel safe set search_path = hr, pg_catalog, pg_temp as $fn$
declare v text := hr.v_trim(p_name);
begin
 if v = '' then return 'Enter the account name.'; end if;
 if hr.v_has_control(v) or char_length(v) > 100 then return 'The account name must be 100 characters or fewer.'; end if;
 if regexp_replace(coalesce(p_bsb, ''), '[\s-]', '', 'g') !~ '^\d{6}$' then return 'The BSB must be 6 digits, for example 062-000.'; end if;
 if regexp_replace(coalesce(p_account, ''), '[\s-]', '', 'g') !~ '^\d{4,10}$' then return 'The account number must be 4 to 10 digits.'; end if;
 return '';
end $fn$;

-- staffProblems() in staff-onboarding.ts: the first problem among p_keys, in the wizard's field order, as {field, message}, or null.
-- p: the person's details as text (and is_australian_citizen as a boolean or null). p_final false = a draft (blank is fine, what
-- is typed must be valid); true = the check before Submit (everything needed must be there).
create or replace function hr.v_staff_problem(p jsonb, p_keys text[], p_final boolean, p_today date default null) returns jsonb
language plpgsql stable parallel safe set search_path = hr, pg_catalog, pg_temp as $fn$
declare k text; v text; m text;
 v_au boolean := lower(hr.v_trim(p->>'address_country')) in ('australia', 'au', 'aus');
 fields constant text[] := array['is_australian_citizen','first_name','middle_name','last_name','date_of_birth','phone',
  'address_street','address_line2','address_suburb','address_country','address_state','address_postcode',
  'emergency_name','emergency_phone','emergency_relationship','nationality','passport_number','visa_subclass','visa_conditions'];
begin
 foreach k in array fields loop
  continue when not (k = any(p_keys));
  v := hr.v_trim(p->>k);
  m := '';
  if k = 'is_australian_citizen' then
   if p_final and jsonb_typeof(p->k) is distinct from 'boolean' then m := 'Tell us whether you are an Australian citizen.'; end if;
  elsif k in ('first_name', 'last_name') then
   if v <> '' or p_final then m := hr.v_name_problem(v, replace(k, '_', ' ')); end if;
  elsif k = 'middle_name' then
   if v <> '' then m := hr.v_name_problem(v, 'middle name'); end if;
  elsif k = 'date_of_birth' then
   if v <> '' or p_final then m := hr.v_dob_problem(v, p_today); end if;
  elsif k = 'phone' then
   m := hr.v_phone_problem(v, 'Enter your mobile number.');
  elsif k = 'address_street' then
   if v = '' then if p_final then m := 'Enter the street address.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 200 then m := 'The street address must be 200 characters or fewer.'; end if;
  elsif k = 'address_line2' then
   if hr.v_has_control(v) or char_length(v) > 200 then m := 'Address line 2 must be 200 characters or fewer.'; end if;
  elsif k = 'address_suburb' then
   if v = '' then if p_final then m := 'Enter the suburb or city.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 200 then m := 'The suburb or city must be 200 characters or fewer.'; end if;
  elsif k = 'address_country' then
   if v = '' then if p_final then m := 'Enter the country.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 200 then m := 'The country must be 200 characters or fewer.'; end if;
  elsif k = 'address_state' then
   if v_au then
    if (v <> '' or p_final) and upper(v) not in ('ACT','NSW','NT','QLD','SA','TAS','VIC','WA') then m := 'Choose the state or territory.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 200 then m := 'The state must be 200 characters or fewer.'; end if;
  elsif k = 'address_postcode' then
   if v_au then
    if (v <> '' or p_final) and v !~ '^\d{4}$' then m := 'Enter the 4-digit postcode.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 20 then m := 'The postcode must be 20 characters or fewer.'; end if;
  elsif k = 'emergency_name' then
   if v = '' then if p_final then m := 'Enter the emergency contact''s name.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 120 then m := 'The emergency contact''s name must be 120 characters or fewer.'; end if;
  elsif k = 'emergency_phone' then
   if v <> '' or p_final then m := hr.v_phone_problem(v, 'Enter the emergency contact''s phone number.'); end if;
  elsif k = 'emergency_relationship' then
   if v = '' then if p_final then m := 'Enter how they are related to you.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 60 then m := 'The relationship must be 60 characters or fewer.'; end if;
  elsif k = 'nationality' then
   if v = '' then if p_final then m := 'Enter your nationality.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 100 then m := 'The nationality must be 100 characters or fewer.'; end if;
  elsif k = 'passport_number' then
   v := upper(regexp_replace(v, '\s', '', 'g'));
   if v = '' then if p_final then m := 'Enter your passport number.'; end if;
   elsif v !~ '^[A-Z0-9]{6,12}$' then m := 'Enter the passport number: 6 to 12 letters and numbers.'; end if;
  elsif k = 'visa_subclass' then
   if v = '' then if p_final and (p->'is_australian_citizen') = 'false'::jsonb then m := 'Enter your visa type or subclass.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 100 then m := 'The visa type or subclass must be 100 characters or fewer.'; end if;
  elsif k = 'visa_conditions' then
   if hr.v_has_control(regexp_replace(v, '[\r\n\t]', ' ', 'g')) or char_length(v) > 500 then m := 'The visa work conditions must be 500 characters or fewer.'; end if;
  end if;
  if m <> '' then return jsonb_build_object('field', k, 'message', m); end if;
 end loop;
 return null;
end $fn$;

-- The person's details in the shape hr.v_staff_problem takes.
create or replace function hr.staff_details_json(p hr.staff_profiles) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('is_australian_citizen', p.is_australian_citizen, 'first_name', p.first_name, 'middle_name', p.middle_name, 'last_name', p.last_name,
  'date_of_birth', p.date_of_birth::text, 'phone', p.phone_e164, 'address_street', p.address_street, 'address_line2', p.address_line2,
  'address_suburb', p.address_suburb, 'address_country', p.address_country, 'address_state', p.address_state, 'address_postcode', p.address_postcode,
  'emergency_name', p.emergency_name, 'emergency_phone', p.emergency_phone_e164, 'emergency_relationship', p.emergency_relationship,
  'nationality', p.nationality, 'passport_number', p.passport_number, 'visa_subclass', p.visa_subclass, 'visa_conditions', p.visa_conditions);
$fn$;

-- ------------------------------------------------------------------ 3. bank details, encrypted
create extension if not exists pgcrypto with schema extensions;

do $key$
begin
 if not exists (select 1 from vault.secrets where name = 'hr_bank_details_key') then
  perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'hr_bank_details_key',
   'Encrypts staff bank details (hr.employee_bank). Without it they cannot be read: keep a copy somewhere safe.');
 end if;
end $key$;

create or replace function hr.bank_key() returns text
language plpgsql stable security definer set search_path = '' as $fn$
declare v text;
begin
 select s.decrypted_secret into v from vault.decrypted_secrets s where s.name = 'hr_bank_details_key' limit 1;
 if v is null or v = '' then raise exception 'Bank details cannot be read or saved right now.' using errcode = '55000'; end if;
 return v;
end $fn$;
create or replace function hr.bank_encrypt(p text) returns bytea
language sql security definer set search_path = '' as $fn$ select extensions.pgp_sym_encrypt(p, hr.bank_key(), 'cipher-algo=aes256'); $fn$;
create or replace function hr.bank_decrypt(p bytea) returns text
language sql stable security definer set search_path = '' as $fn$ select extensions.pgp_sym_decrypt(p, hr.bank_key()); $fn$;
revoke all on function hr.bank_key(), hr.bank_encrypt(text), hr.bank_decrypt(bytea) from public, anon, authenticated;

alter table hr.employee_bank
 add column if not exists account_name_enc bytea,
 add column if not exists bsb_enc bytea,
 add column if not exists account_number_enc bytea;

-- Saves are logged by the functions below (who and how), not by the row trigger.
drop trigger if exists staff_audit_bank on hr.employee_bank;

do $encrypt$
declare v_plain boolean;
begin
 select exists (select 1 from information_schema.columns where table_schema = 'hr' and table_name = 'employee_bank' and column_name = 'account_number' and is_nullable = 'NO') into v_plain;
 if not v_plain then return; end if; -- already done
 update hr.employee_bank set account_name_enc = hr.bank_encrypt(account_name), bsb_enc = hr.bank_encrypt(bsb), account_number_enc = hr.bank_encrypt(account_number);
 if exists (select 1 from hr.employee_bank where hr.bank_decrypt(account_name_enc) is distinct from account_name
   or hr.bank_decrypt(bsb_enc) is distinct from bsb or hr.bank_decrypt(account_number_enc) is distinct from account_number) then
  raise exception 'The encrypted bank details do not read back as they were saved. Nothing was changed.';
 end if;
 alter table hr.employee_bank drop constraint if exists employee_bank_account_name_check;
 alter table hr.employee_bank drop constraint if exists employee_bank_bsb_check;
 alter table hr.employee_bank drop constraint if exists employee_bank_account_number_check;
 alter table hr.employee_bank alter column account_name drop not null, alter column bsb drop not null, alter column account_number drop not null;
 update hr.employee_bank set account_name = null, bsb = null, account_number = null;
end $encrypt$;
alter table hr.employee_bank drop constraint if exists employee_bank_no_plain_text;
alter table hr.employee_bank add constraint employee_bank_no_plain_text check (account_name is null and bsb is null and account_number is null);
alter table hr.employee_bank drop constraint if exists employee_bank_encrypted;
alter table hr.employee_bank add constraint employee_bank_encrypted check (account_name_enc is not null and bsb_enc is not null and account_number_enc is not null);

-- What a screen gets. Masked: BSB 06•••• and account •••• 4321 (the last four digits, or two of a number shorter than eight).
create or replace function hr.bank_view(p_profile uuid, p_full boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare b hr.employee_bank; v_bsb text; v_acc text;
begin
 select * into b from hr.employee_bank where profile_id = p_profile;
 if not found then return null; end if;
 v_bsb := hr.bank_decrypt(b.bsb_enc); v_acc := hr.bank_decrypt(b.account_number_enc);
 return jsonb_build_object('accountName', hr.bank_decrypt(b.account_name_enc), 'bankName', b.bank_name, 'updatedAt', b.updated_at, 'masked', not p_full,
  'bsb', case when p_full then v_bsb else left(v_bsb, 2) || '••••' end,
  'accountNumber', case when p_full then v_acc else '•••• ' || right(v_acc, case when char_length(v_acc) >= 8 then 4 else 2 end) end);
end $fn$;
revoke all on function hr.bank_view(uuid, boolean) from public, anon, authenticated;
drop function if exists hr.bank_json(hr.employee_bank, boolean);

-- Validates and stores (encrypted). p_bank: {accountName, bsb, accountNumber, bankName?}. The caller has already been authorised.
create or replace function hr.bank_store(p_profile uuid, p_bank jsonb, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $fn$
declare v_name text := hr.v_trim(p_bank->>'accountName'); v_bsb text := regexp_replace(coalesce(p_bank->>'bsb', ''), '[\s-]', '', 'g');
 v_acc text := regexp_replace(coalesce(p_bank->>'accountNumber', ''), '[\s-]', '', 'g'); v_bank text := left(hr.v_trim(p_bank->>'bankName'), 100);
 v_problem text := hr.v_bank_problem(p_bank->>'accountName', p_bank->>'bsb', p_bank->>'accountNumber');
begin
 if v_problem <> '' then raise exception '%', v_problem using errcode = '22023'; end if;
 insert into hr.employee_bank (profile_id, account_name_enc, bsb_enc, account_number_enc, bank_name, updated_at, updated_by)
 values (p_profile, hr.bank_encrypt(v_name), hr.bank_encrypt(v_bsb), hr.bank_encrypt(v_acc), v_bank, now(), p_actor)
 on conflict (profile_id) do update set account_name_enc = excluded.account_name_enc, bsb_enc = excluded.bsb_enc,
  account_number_enc = excluded.account_number_enc, bank_name = excluded.bank_name, updated_at = now(), updated_by = excluded.updated_by;
 delete from hr.staff_section_checks where profile_id = p_profile and section = 'bank';
 perform hr.audit_log(p_profile, 'bank_saved', '{}'::jsonb);
end $fn$;
revoke all on function hr.bank_store(uuid, jsonb, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ 5. "verified by admin" ticks (created before the functions that clear them)
create table if not exists hr.staff_section_checks (
 profile_id uuid not null references hr.staff_profiles(id) on delete cascade,
 section text not null check (section in ('personal', 'bank', 'passport', 'visa', 'english', 'academic', 'driving-licence', 'health-insurance')),
 verified_by uuid not null,
 verified_at timestamptz not null default now(),
 primary key (profile_id, section)
);
alter table hr.staff_section_checks enable row level security;
revoke all on hr.staff_section_checks from public, anon, authenticated;

-- A new file for a document type takes that section's tick away.
create or replace function hr.staff_section_check_reset() returns trigger
language plpgsql security definer set search_path = hr, pg_temp as $fn$
begin
 delete from hr.staff_section_checks where profile_id = new.profile_id and section = hr.staff_doc_slug(new.category);
 return new;
end $fn$;
revoke all on function hr.staff_section_check_reset() from public, anon, authenticated;
drop trigger if exists staff_section_check_reset on hr.staff_documents;
create trigger staff_section_check_reset after insert on hr.staff_documents for each row execute function hr.staff_section_check_reset();

create or replace function public.hr_admin_onboarding_extras(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, hr, pg_temp as $fn$
begin
 perform hr.require_admin();
 if not exists (select 1 from hr.staff_profiles where id = p_id) then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 return jsonb_build_object('bank', hr.bank_view(p_id, false),
  'checks', coalesce((select jsonb_object_agg(c.section, jsonb_build_object('verifiedAt', c.verified_at,
     'verifiedByName', coalesce((select u.name from public.cms_users u where u.auth_user_id = c.verified_by), 'An administrator')))
    from hr.staff_section_checks c where c.profile_id = p_id), '{}'::jsonb));
end $fn$;

create or replace function public.hr_admin_onboarding_check(p_id uuid, p_section text, p_verified boolean) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin();
begin
 if not exists (select 1 from hr.staff_profiles where id = p_id) then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p_section is null or p_section not in ('personal', 'bank', 'passport', 'visa', 'english', 'academic', 'driving-licence', 'health-insurance') then
  raise exception 'Unknown section.' using errcode = '22023'; end if;
 perform set_config('hr.actor', v_admin::text, true);
 perform set_config('hr.actor_kind', 'admin', true);
 if coalesce(p_verified, false) then
  if p_section = 'bank' and not exists (select 1 from hr.employee_bank where profile_id = p_id) then raise exception 'There are no bank details to verify yet.' using errcode = '23514'; end if;
  if p_section not in ('personal', 'bank') and not exists (select 1 from hr.staff_documents d where d.profile_id = p_id and d.is_current and hr.staff_doc_slug(d.category) = p_section) then
   raise exception 'There is no document to verify yet.' using errcode = '23514'; end if;
  insert into hr.staff_section_checks(profile_id, section, verified_by) values (p_id, p_section, v_admin)
   on conflict (profile_id, section) do update set verified_by = excluded.verified_by, verified_at = now();
  perform hr.audit_log(p_id, 'section_verified', jsonb_build_object('section', p_section));
 else
  delete from hr.staff_section_checks where profile_id = p_id and section = p_section;
  if found then perform hr.audit_log(p_id, 'section_unverified', jsonb_build_object('section', p_section)); end if;
 end if;
 return public.hr_admin_onboarding_extras(p_id);
end $fn$;

-- ------------------------------------------------------------------ 3b. bank details: administrators
drop function if exists public.hr_admin_emp_bank_get(uuid);
create or replace function public.hr_admin_emp_bank_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
begin
 perform hr.require_admin();
 return hr.bank_view(p_id, false);
end $fn$;

-- In full, and written to the history: who looked and when (never the numbers).
create or replace function public.hr_admin_emp_bank_reveal(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare v jsonb; v_admin uuid := hr.require_admin();
begin
 v := hr.bank_view(p_id, true);
 if v is null then raise exception 'There are no bank details yet.' using errcode = 'P0002'; end if;
 perform set_config('hr.actor', v_admin::text, true);
 perform set_config('hr.actor_kind', 'admin', true);
 perform hr.audit_log(p_id, 'bank_revealed', '{}'::jsonb);
 return v;
end $fn$;

-- p_bank: {accountName, bsb, accountNumber, bankName}; null or {} removes the bank details. Answers masked.
create or replace function public.hr_admin_emp_bank_save(p_id uuid, p_bank jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare v_admin uuid := hr.require_admin();
begin
 if not exists (select 1 from hr.staff_profiles where id = p_id) then raise exception 'Employee not found.' using errcode = 'P0002'; end if;
 perform set_config('hr.actor', v_admin::text, true);
 perform set_config('hr.actor_kind', 'admin', true);
 if hr.v_trim(p_bank->>'accountName') = '' and hr.v_trim(p_bank->>'bsb') = '' and hr.v_trim(p_bank->>'accountNumber') = '' then
  delete from hr.employee_bank where profile_id = p_id;
  if found then
   delete from hr.staff_section_checks where profile_id = p_id and section = 'bank';
   perform hr.audit_log(p_id, 'bank_removed', '{}'::jsonb);
  end if;
  return null;
 end if;
 perform hr.bank_store(p_id, p_bank, v_admin);
 return hr.bank_view(p_id, false);
end $fn$;

-- ------------------------------------------------------------------ 4. onboarding by link
-- What the applicant's page shows (no auth ids, no review internals beyond the note). The bank details come back masked.
create or replace function hr.staff_applicant_view(i hr.staff_invites) returns jsonb
language plpgsql stable security definer set search_path = hr, pg_temp as $fn$
declare p hr.staff_profiles;
begin
 select * into p from hr.staff_profiles where id = i.profile_id;
 return jsonb_build_object(
  'profile', to_jsonb(p) - 'auth_user_id' - 'id' - 'status_changed_at' - 'created_at' - 'updated_at',
  'status', p.status,
  'mode', i.purpose,
  'readOnly', i.used_at is not null or p.status <> 'invited',
  'expiresAt', i.expires_at,
  'documents', coalesce((select jsonb_agg(hr.staff_doc_json(d) order by d.category, d.created_at) from hr.staff_documents d where d.profile_id = p.id and d.is_current), '[]'::jsonb),
  'requiredCategories', to_jsonb(hr.staff_required_categories(p.is_australian_citizen)),
  'summary', hr.staff_doc_summary(p.id),
  'bank', hr.bank_view(p.id, false));
end $fn$;
revoke all on function hr.staff_applicant_view(hr.staff_invites) from public, anon, authenticated;

-- Personal details: only with a 'documents' link (a re-upload link changes documents only). The email is fixed. What is typed must
-- be valid (hr.v_staff_problem as a draft); blank is fine until Submit.
create or replace function public.hr_svc_onboarding_save(p_token_hash text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; k text; v_keys text[] := '{}'; d jsonb; v_problem jsonb; v_dob date; v_phone text; v_ephone text; c jsonb; v_au boolean;
 known constant text[] := array['is_australian_citizen','first_name','middle_name','last_name','date_of_birth','phone',
  'address_street','address_line2','address_suburb','address_country','address_state','address_postcode',
  'emergency_name','emergency_phone','emergency_relationship','nationality','passport_number','visa_subclass','visa_conditions'];
begin
 i := hr.invite_for_write(p_token_hash, array['documents']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Nothing to save.' using errcode = '22023'; end if;
 d := hr.staff_details_json(p);
 foreach k in array known loop
  continue when not (p_patch ? k);
  if k = 'is_australian_citizen' then
   if jsonb_typeof(p_patch->k) not in ('boolean', 'null') then raise exception 'Tell us whether you are an Australian citizen.' using errcode = '22023'; end if;
  elsif jsonb_typeof(p_patch->k) not in ('string', 'null') then raise exception 'Check the % field.', replace(k, '_', ' ') using errcode = '22023';
  end if;
  v_keys := array_append(v_keys, k);
  d := d || jsonb_build_object(k, p_patch->k);
 end loop;
 v_problem := hr.v_staff_problem(d, v_keys, false);
 if v_problem is not null then raise exception '%', v_problem->>'message' using errcode = '22023'; end if;

 v_dob := case when hr.v_trim(d->>'date_of_birth') = '' then null else (hr.v_dob_parse(d->>'date_of_birth', (now() at time zone 'utc')::date)).o_date end;
 v_phone := case when 'phone' = any(v_keys) then hr.v_phone_store(d->>'phone') else p.phone_e164 end;
 v_ephone := case when not ('emergency_phone' = any(v_keys)) then p.emergency_phone_e164 when hr.v_trim(d->>'emergency_phone') = '' then null else hr.v_phone_store(d->>'emergency_phone') end;
 if v_phone is distinct from p.phone_e164 then
  c := hr.contact_conflicts(null, v_phone, null);
  if (c->'phone') - 'staff'::text <> '[]'::jsonb or exists (select 1 from hr.staff_profiles o where o.phone_e164 = v_phone and o.id <> p.id) then
   raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 end if;
 v_au := lower(hr.v_trim(d->>'address_country')) in ('australia', 'au', 'aus');
 update hr.staff_profiles set
  is_australian_citizen = case when jsonb_typeof(d->'is_australian_citizen') = 'boolean' then (d->>'is_australian_citizen')::boolean else null end,
  first_name = hr.v_trim(d->>'first_name'), middle_name = hr.v_trim(d->>'middle_name'), last_name = hr.v_trim(d->>'last_name'),
  date_of_birth = v_dob, phone_e164 = v_phone, emergency_phone_e164 = v_ephone,
  address_street = hr.v_trim(d->>'address_street'), address_line2 = hr.v_trim(d->>'address_line2'), address_suburb = hr.v_trim(d->>'address_suburb'),
  address_state = case when v_au then upper(hr.v_trim(d->>'address_state')) else hr.v_trim(d->>'address_state') end,
  address_postcode = hr.v_trim(d->>'address_postcode'), address_country = hr.v_trim(d->>'address_country'),
  emergency_name = hr.v_trim(d->>'emergency_name'), emergency_relationship = hr.v_trim(d->>'emergency_relationship'),
  nationality = hr.v_trim(d->>'nationality'), passport_number = upper(regexp_replace(hr.v_trim(d->>'passport_number'), '\s', '', 'g')),
  visa_subclass = hr.v_trim(d->>'visa_subclass'), visa_conditions = hr.v_trim(d->>'visa_conditions')
  where id = p.id;
 return hr.staff_applicant_view(i);
exception when unique_violation then
 if sqlerrm like '%staff_profiles_phone_key%' then raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 raise;
end $fn$;

-- The person's own bank details, through a 'documents' link only. Stored encrypted; the answer carries them masked.
create or replace function public.hr_svc_onboarding_bank_save(p_token_hash text, p_bank jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites;
begin
 i := hr.invite_for_write(p_token_hash, array['documents']);
 if jsonb_typeof(p_bank) is distinct from 'object' then raise exception 'Enter your bank details.' using errcode = '22023'; end if;
 perform set_config('hr.actor', '', true);
 perform set_config('hr.actor_kind', 'applicant', true);
 perform hr.bank_store(i.profile_id, p_bank, null);
 return hr.staff_applicant_view(i);
end $fn$;

-- Records a file the function already uploaded. As before, except that the expiry date may come later: the reader fills it, or the
-- person types it on the next step; Submit still needs a current one.
create or replace function public.hr_svc_document_add(p_token_hash text, p_category text, p_path text, p_filename text, p_mime text, p_size integer,
 p_expiry date default null, p_replaces uuid default null) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; a hr.staff_applications; d hr.staff_documents; r hr.staff_documents; v_old text[]; v_expiry date; v_fresh boolean;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 v_fresh := i.purpose = 'documents';
 select * into p from hr.staff_profiles where id = i.profile_id;
 select * into a from hr.staff_applications where profile_id = p.id;
 if p_category is null or p_category not in ('Passport','Visa','English','Academic','Driving Licence','Health Insurance') then raise exception 'Unknown document type.' using errcode = '22023'; end if;
 if not hr.staff_path_ok(p_path, p.id, hr.staff_doc_slug(p_category)) then raise exception 'The document location is not valid.' using errcode = '22023'; end if;
 if p_mime is null or p_mime not in ('application/pdf','image/png','image/jpeg') then raise exception 'Only PDF, JPG, and PNG documents are supported.' using errcode = '22023'; end if;
 if p_size is null or p_size < 1 or p_size > 10485760 then raise exception 'Each document must be a PDF, JPG, or PNG no larger than 10 MB.' using errcode = '22023'; end if;
 if p_expiry is not null then
  v_expiry := hr.check_staff_expiry(p_category, p_expiry);
  if v_expiry is not null and v_expiry < current_date then raise exception 'This % has expired. Upload a current one.', hr.staff_doc_label(p_category) using errcode = '22023'; end if;
 end if;
 if p_category = 'Academic' then
  if p_replaces is not null then
   select * into r from hr.staff_documents where id = p_replaces and profile_id = p.id and category = 'Academic' and is_current for update;
   if not found then raise exception 'Document not found.' using errcode = 'P0002'; end if;
   if not v_fresh and r.status <> 'rejected' then raise exception 'Only a rejected document can be replaced.' using errcode = '23514'; end if;
  elsif not v_fresh then raise exception 'Only a rejected document can be replaced.' using errcode = '23514';
  end if;
 else
  select * into r from hr.staff_documents where application_id = a.id and category = p_category and is_current for update;
  if not v_fresh and (r.id is null or r.status <> 'rejected') then raise exception 'Only a rejected document can be replaced.' using errcode = '23514'; end if;
 end if;
 if not hr.staff_object_exists(p_path) then raise exception 'The uploaded file was not found.' using errcode = 'P0002'; end if;
 if r.id is not null then
  update hr.staff_documents set is_current = false where id = r.id;
  if v_fresh then v_old := array[r.storage_path]; end if;
 end if;
 insert into hr.staff_documents(application_id, profile_id, category, storage_path, filename, mime_type, file_size, expiry_date)
  values (a.id, p.id, p_category, p_path, left(btrim(coalesce(p_filename, 'document')), 255), p_mime, p_size, v_expiry) returning * into d;
 return jsonb_build_object('id', d.id, 'replacedPaths', coalesce(to_jsonb(v_old), '[]'::jsonb), 'view', hr.staff_applicant_view(i));
end $fn$;

-- The reader's outcome. "done" fills EMPTY details only, while the person is still filling in the wizard (status invited): the
-- passport gives the name, date of birth, nationality, passport number and (when no date was typed) the passport's expiry; the
-- visa gives the subclass and its expiry; an Australian driving licence gives the address. A date that has passed is not taken.
create or replace function public.hr_staff_document_apply_extraction(p_doc uuid, p_status text, p_extracted jsonb, p_error text default null) returns void
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare d hr.staff_documents; p hr.staff_profiles; x jsonb := coalesce(p_extracted, '{}'::jsonb); v_dob date; v_expiry date; v_number text;
begin
 if p_status not in ('processing','done','no_fields','failed','unavailable') then raise exception 'Unknown extraction status.' using errcode = '22023'; end if;
 select * into d from hr.staff_documents where id = p_doc and is_current for update;
 if not found then return; end if;
 update hr.staff_documents set extraction_status = p_status, extracted = case when p_status in ('done','no_fields') then x else extracted end,
  extracted_at = case when p_status in ('done','no_fields') then now() else extracted_at end, extraction_error = left(p_error, 500) where id = d.id;
 if p_status <> 'done' then return; end if;
 select * into p from hr.staff_profiles where id = d.profile_id;
 if p.status <> 'invited' then return; end if;
 if d.category in ('Passport', 'Visa') and d.expiry_date is null then
  begin v_expiry := nullif(x->>(case d.category when 'Passport' then 'passport_expiry' else 'visa_stay_until' end), '')::date; exception when others then v_expiry := null; end;
  if v_expiry is not null and v_expiry >= current_date and v_expiry <= date '2100-12-31' then
   update hr.staff_documents set expiry_date = v_expiry where id = d.id;
  end if;
 end if;
 if d.category = 'Passport' then
  v_dob := (hr.v_dob_parse(x->>'dob', (now() at time zone 'utc')::date)).o_date;
  v_number := upper(regexp_replace(coalesce(x->>'passport_number', ''), '\s', '', 'g'));
  update hr.staff_profiles set
   first_name = case when first_name = '' then left(btrim(coalesce(x->>'first_name', '')), 100) else first_name end,
   middle_name = case when middle_name = '' then left(btrim(coalesce(x->>'middle_name', '')), 100) else middle_name end,
   last_name = case when last_name = '' then left(btrim(coalesce(x->>'last_name', '')), 100) else last_name end,
   date_of_birth = coalesce(date_of_birth, v_dob),
   nationality = case when nationality = '' then left(btrim(coalesce(nullif(btrim(x->>'nationality'), ''), x->>'citizenship', '')), 100) else nationality end,
   passport_number = case when passport_number = '' and v_number ~ '^[A-Z0-9]{6,12}$' then v_number else passport_number end
   where id = p.id;
 elsif d.category = 'Visa' then
  update hr.staff_profiles set
   visa_subclass = case when visa_subclass = '' then left(btrim(coalesce(x->>'visa_subclass', '')), 100) else visa_subclass end where id = p.id;
 elsif d.category = 'Driving Licence' then
  update hr.staff_profiles set
   address_street = case when address_street = '' then left(btrim(coalesce(x->>'au_street', '')), 200) else address_street end,
   address_line2 = case when address_line2 = '' then left(btrim(coalesce(x->>'au_line2', '')), 200) else address_line2 end,
   address_suburb = case when address_suburb = '' then left(btrim(coalesce(x->>'au_suburb', '')), 100) else address_suburb end,
   address_state = case when address_state = '' then left(upper(btrim(coalesce(x->>'au_state', ''))), 100) else address_state end,
   address_postcode = case when address_postcode = '' then left(btrim(coalesce(x->>'au_zip', '')), 20) else address_postcode end,
   address_country = case when address_country = '' and coalesce(x->>'au_street', '') <> '' then 'Australia' else address_country end where id = p.id;
 end if;
end $fn$;

-- Submit. A 'documents' link: every detail (hr.v_staff_problem, final), the bank details, then the documents. A re-upload link:
-- the documents only, as before. The link becomes read-only; the admins are told.
create or replace function public.hr_svc_onboarding_submit(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; c text; v_problem jsonb;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if i.purpose = 'documents' then
  v_problem := hr.v_staff_problem(hr.staff_details_json(p), array['is_australian_citizen','first_name','middle_name','last_name','date_of_birth','phone',
   'address_street','address_line2','address_suburb','address_country','address_state','address_postcode',
   'emergency_name','emergency_phone','emergency_relationship','nationality','passport_number','visa_subclass','visa_conditions'], true);
  if v_problem is not null then raise exception '%', v_problem->>'message' using errcode = '23514'; end if;
 elsif p.is_australian_citizen is null then raise exception 'Tell us whether you are an Australian citizen.' using errcode = '23514';
 end if;
 foreach c in array hr.staff_required_categories(p.is_australian_citizen) loop
  if not exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current) then
   raise exception '%', case c when 'Passport' then 'A passport is required before you can submit.' else 'Upload your ' || hr.staff_doc_label(c) || '.' end
    using errcode = '23514'; end if;
  if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.category = c and d.is_current
     and ((d.expiry_date is null and hr.staff_doc_needs_expiry(c)) or d.expiry_date < current_date)) then
   raise exception 'Enter a current expiry date for your %.', hr.staff_doc_label(c) using errcode = '23514'; end if;
 end loop;
 if exists (select 1 from hr.staff_documents d where d.profile_id = p.id and d.is_current and d.status = 'rejected') then
  raise exception 'Replace every document we asked you to upload again.' using errcode = '23514'; end if;
 if i.purpose = 'documents' and not exists (select 1 from hr.employee_bank b where b.profile_id = p.id) then
  raise exception 'Enter your bank details.' using errcode = '23514'; end if;
 perform set_config('hr.actor_kind', 'applicant', true);
 perform set_config('hr.note', case when i.purpose = 'reupload' then 'Documents uploaded again' else 'Documents submitted' end, true);
 update hr.staff_profiles set status = 'documents_submitted' where id = p.id;
 update hr.staff_applications set submitted_at = now() where profile_id = p.id;
 update hr.staff_invites set used_at = now() where id = i.id returning * into i;
 perform hr.queue_email(p.id, 'admin_documents_submitted', 'admin', jsonb_build_object('reupload', i.purpose = 'reupload'));
 return hr.staff_applicant_view(i);
end $fn$;

-- ------------------------------------------------------------------ 6. retention
-- hr.staff_anonymise of 20261110090000, plus the wizard's columns, the bank details and the ticks.
create or replace function hr.staff_anonymise(p_profile uuid) returns void
language plpgsql security definer set search_path = hr, public, auth, pg_temp as $fn$
declare v_login uuid;
begin
 select p.auth_user_id into v_login from hr.staff_profiles p where p.id = p_profile;
 if v_login is not null then
  update hr.staff_profiles set auth_user_id = null where id = p_profile;
  if exists (select 1 from auth.users u where u.id = v_login and u.invited_at is not null and u.last_sign_in_at is null
       and coalesce(u.raw_user_meta_data->>'account_type', '') = 'staff')
     and not exists (select 1 from public.cms_users c where c.auth_user_id = v_login)
     and not exists (select 1 from public.portal_profiles pp where pp.auth_user_id = v_login)
     and not exists (select 1 from hr.staff_profiles o where o.auth_user_id = v_login) then
   begin
    delete from auth.users where id = v_login;
   exception when foreign_key_violation then null;
   end;
  end if;
 end if;
 update hr.staff_profiles set first_name = '', middle_name = '', last_name = '', date_of_birth = null, email = null, phone_e164 = null,
  address_street = '', address_line2 = '', address_suburb = '', address_state = '', address_postcode = '', address_country = '',
  emergency_name = '', emergency_relationship = '', emergency_phone_e164 = null, is_australian_citizen = null,
  nationality = '', passport_number = '', visa_subclass = '', visa_conditions = ''
  where id = p_profile;
 delete from hr.employee_bank where profile_id = p_profile;
 delete from hr.staff_section_checks where profile_id = p_profile;
 update hr.staff_applications set resume_path = null, resume_filename = null, review_note = '' where profile_id = p_profile;
 update hr.staff_documents set filename = 'removed', extracted = '{}'::jsonb, extraction_error = null,
  review_note = case when status = 'rejected' then 'removed' else '' end where profile_id = p_profile;
 update hr.staff_offers set filename = 'removed.pdf', signer_name = case when signer_name is null then null else 'removed' end,
  signer_ip = null, signer_user_agent = null where profile_id = p_profile;
 update hr.staff_emails set to_email = case when audience = 'applicant' then 'removed' else null end, payload = '{}'::jsonb, last_error = null where profile_id = p_profile;
 update hr.job_applications set cover_letter = '', cover_letter_path = null, cover_letter_filename = null, decision_note = '', interview_notes = '', recruiter_notes = '' where profile_id = p_profile;
end $fn$;
revoke all on function hr.staff_anonymise(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ privileges
revoke all on function hr.v_trim(text), hr.v_has_control(text), hr.v_phone_problem(text, text), hr.v_phone_store(text), hr.v_name_problem(text, text),
 hr.v_dob_parse(text, date), hr.v_dob_problem(text, date), hr.v_bank_problem(text, text, text), hr.v_staff_problem(jsonb, text[], boolean, date),
 hr.staff_details_json(hr.staff_profiles) from public, anon, authenticated;
grant execute on function hr.v_trim(text), hr.v_has_control(text), hr.v_phone_problem(text, text), hr.v_phone_store(text), hr.v_name_problem(text, text),
 hr.v_dob_parse(text, date), hr.v_dob_problem(text, date), hr.v_bank_problem(text, text, text), hr.v_staff_problem(jsonb, text[], boolean, date) to service_role;

revoke all on function public.hr_admin_emp_bank_get(uuid), public.hr_admin_emp_bank_reveal(uuid), public.hr_admin_emp_bank_save(uuid, jsonb),
 public.hr_admin_onboarding_extras(uuid), public.hr_admin_onboarding_check(uuid, text, boolean) from public, anon;
grant execute on function public.hr_admin_emp_bank_get(uuid), public.hr_admin_emp_bank_reveal(uuid), public.hr_admin_emp_bank_save(uuid, jsonb),
 public.hr_admin_onboarding_extras(uuid), public.hr_admin_onboarding_check(uuid, text, boolean) to authenticated;

revoke all on function public.hr_svc_onboarding_save(text, jsonb), public.hr_svc_onboarding_bank_save(text, jsonb), public.hr_svc_onboarding_submit(text),
 public.hr_svc_document_add(text, text, text, text, text, integer, date, uuid),
 public.hr_staff_document_apply_extraction(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.hr_svc_onboarding_save(text, jsonb), public.hr_svc_onboarding_bank_save(text, jsonb), public.hr_svc_onboarding_submit(text),
 public.hr_svc_document_add(text, text, text, text, text, integer, date, uuid),
 public.hr_staff_document_apply_extraction(uuid, text, jsonb, text) to service_role;
