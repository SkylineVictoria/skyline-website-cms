-- Tax and super step of the staff onboarding wizard (owner's option A, 2026-11-10). Additive, local only until released.
-- Only the super choice and the NON-SECRET answers of the ATO declarations are kept; the tax file number is never asked for or
-- stored here (the person gives it through Xero, the payroll system), so nothing in this file is encrypted or masked.
-- 1. hr.staff_profiles: tax_residency (resident | foreign | whm), tax_free_threshold (yes | no), study_loan (yes | no),
--    super_choice (default | own | smsf), super_fund_name, super_fund_abn (11 digits), super_usi, super_member_number. '' = unanswered.
-- 2. The shared rules (supabase/functions/_shared/validation/staff-onboarding.ts) repeated: hr.v_abn_problem (the same check as
--    validation/abn.ts) and the eight new cases of hr.v_staff_problem; hr.staff_details_json carries the new keys.
-- 3. hr_svc_onboarding_save takes the answers (draft rules), hr_svc_onboarding_submit needs them (final rules); a change clears the
--    Admin's "verified" tick of the Tax and super section and is written to the history as tax_super_saved (no values).
-- 4. hr.staff_section_checks accepts the section 'tax'; hr_admin_onboarding_check ticks it once there is an answer to verify.
-- 5. hr.staff_anonymise (retention) clears the eight columns.
-- Rollback (manual): restore the functions of 20261112090000, drop the section-check constraint back to its old list, then drop the columns.
set local lock_timeout='5s';
set local statement_timeout='120s';

-- ------------------------------------------------------------------ 1. columns
alter table hr.staff_profiles
 add column if not exists tax_residency text not null default '' check (tax_residency in ('', 'resident', 'foreign', 'whm')),
 add column if not exists tax_free_threshold text not null default '' check (tax_free_threshold in ('', 'yes', 'no')),
 add column if not exists study_loan text not null default '' check (study_loan in ('', 'yes', 'no')),
 add column if not exists super_choice text not null default '' check (super_choice in ('', 'default', 'own', 'smsf')),
 add column if not exists super_fund_name text not null default '' check (char_length(super_fund_name) <= 100),
 add column if not exists super_fund_abn text not null default '' check (super_fund_abn = '' or super_fund_abn ~ '^\d{11}$'),
 add column if not exists super_usi text not null default '' check (super_usi ~ '^[A-Z0-9]{0,20}$'),
 add column if not exists super_member_number text not null default '' check (char_length(super_member_number) <= 30);

-- ------------------------------------------------------------------ 2. the shared rules, in SQL
-- validateAbn() of validation/abn.ts: 11 digits (spaces allowed) and the ABN check digits (weights 10,1,3,5,7,9,11,13,15,17,19 mod 89).
create or replace function hr.v_abn_problem(p text) returns text
language plpgsql immutable parallel safe set search_path = pg_catalog, pg_temp as $fn$
declare v text := regexp_replace(coalesce(p, ''), '\s', '', 'g'); w constant int[] := array[10,1,3,5,7,9,11,13,15,17,19]; s int := 0; i int;
begin
 if v = '' then return 'Enter the business ABN.'; end if;
 if v !~ '^\d{11}$' then return 'ABN must contain 11 digits.'; end if;
 for i in 1..11 loop s := s + (substr(v, i, 1)::int - case when i = 1 then 1 else 0 end) * w[i]; end loop;
 return case when s % 89 = 0 then '' else 'Enter a valid ABN; its check digits do not match.' end;
end $fn$;

create or replace function hr.v_staff_problem(p jsonb, p_keys text[], p_final boolean, p_today date default null) returns jsonb
language plpgsql stable parallel safe set search_path = hr, pg_catalog, pg_temp as $fn$
declare k text; v text; m text;
 v_au boolean := lower(hr.v_trim(p->>'address_country')) in ('australia', 'au', 'aus');
 v_resident boolean := hr.v_trim(p->>'tax_residency') = 'resident';
 v_super text := hr.v_trim(p->>'super_choice');
 fields constant text[] := array['is_australian_citizen','first_name','middle_name','last_name','date_of_birth','phone',
  'address_street','address_line2','address_suburb','address_country','address_state','address_postcode',
  'emergency_name','emergency_phone','emergency_relationship','nationality','passport_number','visa_subclass','visa_conditions',
  'tax_residency','tax_free_threshold','study_loan','super_choice','super_fund_name','super_fund_abn','super_usi','super_member_number'];
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
  -- Tax and super: the answers of the ATO declarations, never the tax file number.
  elsif k = 'tax_residency' then
   if v = '' then if p_final then m := 'Tell us your residency status for tax purposes.'; end if;
   elsif v not in ('resident', 'foreign', 'whm') then m := 'Choose your residency status for tax purposes.'; end if;
  elsif k = 'tax_free_threshold' then
   if v = '' then if p_final and v_resident then m := 'Tell us whether you claim the tax-free threshold.'; end if;
   elsif v not in ('yes', 'no') then m := 'Answer yes or no for the tax-free threshold.'; end if;
  elsif k = 'study_loan' then
   if v = '' then if p_final then m := 'Tell us whether you have a study or training support loan.'; end if;
   elsif v not in ('yes', 'no') then m := 'Answer yes or no for the study or training support loan.'; end if;
  elsif k = 'super_choice' then
   if v = '' then if p_final then m := 'Choose how your super is paid.'; end if;
   elsif v not in ('default', 'own', 'smsf') then m := 'Choose how your super is paid.'; end if;
  elsif k = 'super_fund_name' then
   if v = '' then if p_final and v_super in ('own', 'smsf') then m := 'Enter the name of your super fund.'; end if;
   elsif hr.v_has_control(v) or char_length(v) > 100 then m := 'The super fund name must be 100 characters or fewer.'; end if;
  elsif k = 'super_fund_abn' then
   if v = '' then if p_final and v_super in ('own', 'smsf') then m := 'Enter the fund''s ABN.'; end if;
   else m := hr.v_abn_problem(v); end if;
  elsif k = 'super_usi' then
   if v <> '' and v !~ '^[A-Za-z0-9]{1,20}$' then m := 'The USI must be up to 20 letters and numbers.'; end if;
  elsif k = 'super_member_number' then
   if v = '' then if p_final and v_super = 'own' then m := 'Enter your member number.'; end if;
   elsif v !~ '^[A-Za-z0-9 -]{1,30}$' then m := 'The member number must be up to 30 letters, numbers, spaces or hyphens.'; end if;
  end if;
  if m <> '' then return jsonb_build_object('field', k, 'message', m); end if;
 end loop;
 return null;
end $fn$;

create or replace function hr.staff_details_json(p hr.staff_profiles) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $fn$
 select jsonb_build_object('is_australian_citizen', p.is_australian_citizen, 'first_name', p.first_name, 'middle_name', p.middle_name, 'last_name', p.last_name,
  'date_of_birth', p.date_of_birth::text, 'phone', p.phone_e164, 'address_street', p.address_street, 'address_line2', p.address_line2,
  'address_suburb', p.address_suburb, 'address_country', p.address_country, 'address_state', p.address_state, 'address_postcode', p.address_postcode,
  'emergency_name', p.emergency_name, 'emergency_phone', p.emergency_phone_e164, 'emergency_relationship', p.emergency_relationship,
  'nationality', p.nationality, 'passport_number', p.passport_number, 'visa_subclass', p.visa_subclass, 'visa_conditions', p.visa_conditions,
  'tax_residency', p.tax_residency, 'tax_free_threshold', p.tax_free_threshold, 'study_loan', p.study_loan, 'super_choice', p.super_choice,
  'super_fund_name', p.super_fund_name, 'super_fund_abn', p.super_fund_abn, 'super_usi', p.super_usi, 'super_member_number', p.super_member_number);
$fn$;

-- ------------------------------------------------------------------ 3. saving and submitting through the link
create or replace function public.hr_svc_onboarding_save(p_token_hash text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; k text; v_keys text[] := '{}'; d jsonb; v_problem jsonb; v_dob date; v_phone text; v_ephone text; c jsonb; v_au boolean;
 known constant text[] := array['is_australian_citizen','first_name','middle_name','last_name','date_of_birth','phone',
  'address_street','address_line2','address_suburb','address_country','address_state','address_postcode',
  'emergency_name','emergency_phone','emergency_relationship','nationality','passport_number','visa_subclass','visa_conditions',
  'tax_residency','tax_free_threshold','study_loan','super_choice','super_fund_name','super_fund_abn','super_usi','super_member_number'];
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
  visa_subclass = hr.v_trim(d->>'visa_subclass'), visa_conditions = hr.v_trim(d->>'visa_conditions'),
  tax_residency = hr.v_trim(d->>'tax_residency'), tax_free_threshold = hr.v_trim(d->>'tax_free_threshold'), study_loan = hr.v_trim(d->>'study_loan'),
  super_choice = hr.v_trim(d->>'super_choice'), super_fund_name = hr.v_trim(d->>'super_fund_name'),
  super_fund_abn = regexp_replace(hr.v_trim(d->>'super_fund_abn'), '\s', '', 'g'), super_usi = upper(hr.v_trim(d->>'super_usi')),
  super_member_number = hr.v_trim(d->>'super_member_number')
  where id = p.id;
 -- A changed tax or super answer takes the Admin's tick away and goes into the history (the answer itself is not written there).
 if exists (select 1 from hr.staff_profiles n where n.id = p.id
    and (n.tax_residency, n.tax_free_threshold, n.study_loan, n.super_choice, n.super_fund_name, n.super_fund_abn, n.super_usi, n.super_member_number)
     is distinct from (p.tax_residency, p.tax_free_threshold, p.study_loan, p.super_choice, p.super_fund_name, p.super_fund_abn, p.super_usi, p.super_member_number)) then
  delete from hr.staff_section_checks where profile_id = p.id and section = 'tax';
  perform set_config('hr.actor', '', true);
  perform set_config('hr.actor_kind', 'applicant', true);
  perform hr.audit_log(p.id, 'tax_super_saved', '{}'::jsonb);
 end if;
 return hr.staff_applicant_view(i);
exception when unique_violation then
 if sqlerrm like '%staff_profiles_phone_key%' then raise exception 'This number can''t be used. Sign in or contact the administrator.' using errcode = '23505'; end if;
 raise;
end $fn$;

-- Submit: as 20261112090000, with the tax and super answers among the details a 'documents' link must have.
create or replace function public.hr_svc_onboarding_submit(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare i hr.staff_invites; p hr.staff_profiles; c text; v_problem jsonb;
begin
 i := hr.invite_for_write(p_token_hash, array['documents','reupload']);
 select * into p from hr.staff_profiles where id = i.profile_id for update;
 if i.purpose = 'documents' then
  v_problem := hr.v_staff_problem(hr.staff_details_json(p), array['is_australian_citizen','first_name','middle_name','last_name','date_of_birth','phone',
   'address_street','address_line2','address_suburb','address_country','address_state','address_postcode',
   'emergency_name','emergency_phone','emergency_relationship','nationality','passport_number','visa_subclass','visa_conditions',
   'tax_residency','tax_free_threshold','study_loan','super_choice','super_fund_name','super_fund_abn','super_usi','super_member_number'], true);
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

-- ------------------------------------------------------------------ 4. the Admin's "verified" tick for Tax and super
alter table hr.staff_section_checks drop constraint if exists staff_section_checks_section_check;
alter table hr.staff_section_checks add constraint staff_section_checks_section_check
 check (section in ('personal', 'bank', 'tax', 'passport', 'visa', 'english', 'academic', 'driving-licence', 'health-insurance'));

create or replace function public.hr_admin_onboarding_check(p_id uuid, p_section text, p_verified boolean) returns jsonb
language plpgsql security definer set search_path = public, hr, pg_temp as $fn$
declare v_admin uuid := hr.require_admin();
begin
 if not exists (select 1 from hr.staff_profiles where id = p_id) then raise exception 'Staff application not found.' using errcode = 'P0002'; end if;
 if p_section is null or p_section not in ('personal', 'bank', 'tax', 'passport', 'visa', 'english', 'academic', 'driving-licence', 'health-insurance') then
  raise exception 'Unknown section.' using errcode = '22023'; end if;
 perform set_config('hr.actor', v_admin::text, true);
 perform set_config('hr.actor_kind', 'admin', true);
 if coalesce(p_verified, false) then
  if p_section = 'bank' and not exists (select 1 from hr.employee_bank where profile_id = p_id) then raise exception 'There are no bank details to verify yet.' using errcode = '23514'; end if;
  if p_section = 'tax' and not exists (select 1 from hr.staff_profiles where id = p_id and (tax_residency <> '' or super_choice <> '')) then
   raise exception 'There are no tax and super answers to verify yet.' using errcode = '23514'; end if;
  if p_section not in ('personal', 'bank', 'tax') and not exists (select 1 from hr.staff_documents d where d.profile_id = p_id and d.is_current and hr.staff_doc_slug(d.category) = p_section) then
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

-- ------------------------------------------------------------------ 5. retention
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
  nationality = '', passport_number = '', visa_subclass = '', visa_conditions = '',
  tax_residency = '', tax_free_threshold = '', study_loan = '', super_choice = '', super_fund_name = '', super_fund_abn = '', super_usi = '', super_member_number = ''
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

-- ------------------------------------------------------------------ privileges (as before; the new rule function joins the others)
revoke all on function hr.v_abn_problem(text), hr.v_staff_problem(jsonb, text[], boolean, date), hr.staff_details_json(hr.staff_profiles) from public, anon, authenticated;
grant execute on function hr.v_abn_problem(text), hr.v_staff_problem(jsonb, text[], boolean, date) to service_role;
revoke all on function hr.staff_anonymise(uuid) from public, anon, authenticated;
revoke all on function public.hr_admin_onboarding_check(uuid, text, boolean) from public, anon;
grant execute on function public.hr_admin_onboarding_check(uuid, text, boolean) to authenticated;
revoke all on function public.hr_svc_onboarding_save(text, jsonb), public.hr_svc_onboarding_submit(text) from public, anon, authenticated;
grant execute on function public.hr_svc_onboarding_save(text, jsonb), public.hr_svc_onboarding_submit(text) to service_role;
