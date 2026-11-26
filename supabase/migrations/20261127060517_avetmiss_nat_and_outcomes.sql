-- AVETMISS-NAT (owner, 2026-11-26: everything follows AVETMISS so NCVER reporting never has gaps).
-- Spec: AVETMISS VET Provider Collection Specifications release 8.0 (training activity to 31 Dec 2026); release 8.1 applies to
-- activity from 1 Jan 2027 and the VET Information Standard replaces AVETMISS by 1 Jan 2029 (both to be re-checked against NCVER).
--
-- 1. Final assessment result -> unit enrolment outcome (NAT00120 Outcome identifier - national), stored when the trainer signs off:
--      C                                   -> 20 Competency achieved / pass, activity end date = the sign-off day
--      NYC with attempts left (1..max-1)   -> 70 Continuing activity, end date cleared (NAT00120 reports the planned end date)
--      NYC on the last allowed attempt     -> 30 Competency not achieved / fail, end date = the sign-off day
--    A later sign-off (a resubmission, superseding row) recalculates the outcome and moves the end date to its own day.
--    Never overwritten: 40 withdrawn, 41 RTO closure, 51 / 52 RPL, 60 credit transfer, 61 superseded (set by staff / withdrawal).
-- 2. Programs store their NAT00030 level of education and recognition codes at entry (derived from the training.gov.au
--    qualification level when the course is saved, never at reporting time).
-- 3. public.avetmiss_nat_build(from, to): the NAT files of a collection period as JSON rows (NAT00010 ... NAT00130).
--    public.avetmiss_nat_problems(nat): codes, required fields and cross-file links (every NAT00120 location / client / subject /
--    program exists in NAT00020 / 80 / 60 / 30 ...). supabase/tests/avetmiss_nat.sql runs both with the other suites.

begin;

-- ------------------------------------------------------------------------------------------- 1. assessment result -> outcome
create or replace function public.asm_outcome_to_avetmiss()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_day date := (new.signed_at at time zone public.institution_tz())::date;
  v_assignment uuid; v_used integer := 0; v_max integer; v_code text;
begin
  if new.outcome = 'C' then
    v_code := '20';
  elsif new.outcome = 'NYC' then
    -- The student's latest assignment of this assessment decides how many attempts are allowed.
    select t.assignment_id into v_assignment
      from asm_attempts t join asm_assignments a on a.id = t.assignment_id
     where a.assessment_id = new.assessment_id and t.student_id = new.student_id
     order by t.attempt_no desc, t.created_at desc limit 1;
    select count(*) into v_used
      from asm_attempts t join asm_assignments a on a.id = t.assignment_id
     where a.assessment_id = new.assessment_id and t.student_id = new.student_id
       and t.voided_at is null and t.submitted_at is not null;
    v_max := case when v_assignment is not null then asm_max_attempts(v_assignment) end;
    v_code := case when v_max is null or v_used >= v_max then '30' else '70' end;
  else
    return null;
  end if;

  update lms_unit_students u
     set outcome_code = v_code,
         outcome_recorded_at = now(),
         outcome_recorded_by = new.signed_by,
         -- A final result ends the activity on its sign-off day; a continuing one has no actual end yet.
         actual_end_date = case when v_code = '70' then null else v_day end,
         actual_start_date = coalesce(u.actual_start_date, least(u.assigned_start_date, v_day))
   where u.student_id = new.student_id and u.unit_id = new.unit_id
     and (new.intake_id is null or u.intake_id = new.intake_id)
     and coalesce(u.outcome_code, '') not in ('40', '41', '51', '52', '60', '61');
  return null;
end $function$;

-- ------------------------------------------------------------------------- 2. NAT00030 program level and recognition at entry
insert into public.avetmiss_codes (code_set, code, label, sort, is_active) values
  ('program_level', '211', 'Graduate Diploma', 1, true),
  ('program_level', '221', 'Graduate Certificate', 2, true),
  ('program_level', '411', 'Advanced Diploma', 3, true),
  ('program_level', '413', 'Associate Degree', 4, true),
  ('program_level', '421', 'Diploma', 5, true),
  ('program_level', '511', 'Certificate IV', 6, true),
  ('program_level', '514', 'Certificate III', 7, true),
  ('program_level', '521', 'Certificate II', 8, true),
  ('program_level', '524', 'Certificate I', 9, true),
  ('program_recognition', '11', 'Nationally accredited qualification specified in a national Training Package', 1, true),
  ('program_recognition', '12', 'Nationally accredited course', 2, true)
on conflict do nothing;

alter table public.cms_courses
  add column if not exists avetmiss_level_code text,
  add column if not exists avetmiss_recognition_code text;
alter table public.cms_courses drop constraint if exists cms_courses_avetmiss_level_code_check;
alter table public.cms_courses add constraint cms_courses_avetmiss_level_code_check check (public.avetmiss_is_code('program_level', avetmiss_level_code));
alter table public.cms_courses drop constraint if exists cms_courses_avetmiss_recognition_code_check;
alter table public.cms_courses add constraint cms_courses_avetmiss_recognition_code_check check (public.avetmiss_is_code('program_recognition', avetmiss_recognition_code));
comment on column public.cms_courses.avetmiss_level_code is 'AVETMISS NAT00030 program level of education identifier (stored at entry).';
comment on column public.cms_courses.avetmiss_recognition_code is 'AVETMISS NAT00030 program recognition identifier (stored at entry).';

create or replace function public.cms_courses_avetmiss_program()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  if new.avetmiss_level_code is null then
    new.avetmiss_level_code := case lower(btrim(coalesce(new.tga_qualification_level, '')))
      when 'graduate diploma' then '211' when 'graduate certificate' then '221' when 'advanced diploma' then '411'
      when 'associate degree' then '413' when 'diploma' then '421' when 'certificate iv' then '511'
      when 'certificate iii' then '514' when 'certificate ii' then '521' when 'certificate i' then '524' end;
  end if;
  if new.avetmiss_recognition_code is null and nullif(btrim(coalesce(new.tga_training_package_code, '')), '') is not null then
    new.avetmiss_recognition_code := '11';
  end if;
  return new;
end $function$;
drop trigger if exists avetmiss_program_codes on public.cms_courses;
create trigger avetmiss_program_codes before insert or update on public.cms_courses
  for each row execute function public.cms_courses_avetmiss_program();
-- Existing courses get theirs once (a no-op update fires the trigger; other columns unchanged).
update public.cms_courses set avetmiss_level_code = avetmiss_level_code
 where avetmiss_level_code is null or avetmiss_recognition_code is null;

-- ------------------------------------------------------------------------------------------- 3. NAT files and their checks
create or replace function public.avetmiss_nat_build(p_from date default date_trunc('year', current_date)::date,
                                                     p_to date default (date_trunc('year', current_date) + interval '1 year - 1 day')::date)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $function$
declare v_toid text; v jsonb := '{}'::jsonb;
begin
  select avetmiss_toid into v_toid from cms_settings limit 1;

  -- Training activity of the period: a unit enrolment that overlaps it (actual dates first, else planned).
  create temp table if not exists _nat_act on commit drop as select * from lms_unit_students where false;
  truncate _nat_act;
  insert into _nat_act select * from lms_unit_students u
   where coalesce(u.actual_start_date, u.assigned_start_date) <= p_to
     and coalesce(u.actual_end_date, u.assigned_end_date, p_to) >= p_from;

  v := v || jsonb_build_object('NAT00010', coalesce((select jsonb_agg(jsonb_build_object(
      'toid', s.avetmiss_toid, 'name', s.avetmiss_legal_name, 'org_type', s.avetmiss_org_type_code,
      'address1', s.avetmiss_address_line1, 'address2', s.avetmiss_address_line2, 'suburb', s.avetmiss_suburb,
      'postcode', s.avetmiss_postcode, 'state', s.avetmiss_state_code, 'contact_name', s.avetmiss_contact_name,
      'phone', s.avetmiss_contact_phone, 'email', s.avetmiss_contact_email)) from (select * from cms_settings limit 1) s), '[]'));

  v := v || jsonb_build_object('NAT00020', coalesce((select jsonb_agg(jsonb_build_object(
      'key', l.id, 'toid', v_toid, 'location_id', l.avetmiss_location_id, 'name', l.name, 'suburb', l.suburb,
      'postcode', l.postcode, 'state', l.state_code, 'country', l.country_code) order by l.avetmiss_location_id)
    from locations l where l.id in (select location_id from _nat_act) or l.is_active), '[]'));

  v := v || jsonb_build_object('NAT00030', coalesce((select jsonb_agg(jsonb_build_object(
      'key', c.id, 'program_id', c.code, 'name', c.name, 'level', c.avetmiss_level_code, 'recognition', c.avetmiss_recognition_code,
      'foe', c.tga_field_of_education_code, 'anzsco', c.tga_anzsco_code, 'vet_flag', 'Y',
      'nominal_hours', (select sum(coalesce(u.avetmiss_nominal_hours, u.nominal_hours)) from cms_course_units u
                         where u.course_id = c.id and u.is_active and u.archived_at is null)) order by c.code)
    from cms_courses c where c.id in (select course_id from _nat_act)
       or c.id in (select course_id from course_completions where revoked_at is null and issued_at::date between p_from and p_to)), '[]'));

  v := v || jsonb_build_object('NAT00060', coalesce((select jsonb_agg(jsonb_build_object(
      'key', u.id, 'subject_flag', 'C', 'subject_id', u.code, 'name', u.name, 'foe', u.field_of_education_code,
      'vet_flag', case u.vet_flag when true then 'Y' when false then 'N' end,
      'nominal_hours', coalesce(u.avetmiss_nominal_hours, u.nominal_hours)) order by u.code)
    from (select distinct on (u.code) u.* from cms_course_units u where u.id in (select unit_id from _nat_act) order by u.code, u.id) u), '[]'));

  v := v || jsonb_build_object('NAT00080', coalesce((select jsonb_agg(jsonb_build_object(
      'key', s.id, 'client_id', s.student_number, 'name', s.full_name, 'sex', s.sex_code, 'dob', s.date_of_birth,
      'school_level', s.school_level_code, 'school_year', s.school_level_year, 'indigenous', s.indigenous_status_code,
      'home_language', s.home_language_code, 'labour_force', s.labour_force_code, 'birth_country', s.birth_country_code,
      'disability_flag', s.disability_flag, 'prior_education_flag', s.prior_education_flag, 'at_school_flag', s.at_school_flag,
      'missing', to_jsonb(avetmiss_student_missing(s.id))) order by s.student_number)
    from enrollment_students s where s.id in (select student_id from _nat_act)
       or s.id in (select student_id from course_completions where revoked_at is null and issued_at::date between p_from and p_to)), '[]'));

  v := v || jsonb_build_object('NAT00085', coalesce((select jsonb_agg(jsonb_build_object(
      'client_id', s.student_number, 'email', s.email, 'phone', s.phone))
    from enrollment_students s where s.id in (select student_id from _nat_act)), '[]'));

  v := v || jsonb_build_object('NAT00090', coalesce((select jsonb_agg(jsonb_build_object(
      'client_id', s.student_number, 'disability_type', d.disability_type_code))
    from student_disabilities d join enrollment_students s on s.id = d.student_id where s.id in (select student_id from _nat_act)), '[]'));

  v := v || jsonb_build_object('NAT00100', coalesce((select jsonb_agg(jsonb_build_object(
      'client_id', s.student_number, 'prior_education', p.prior_education_code, 'recognition', p.recognition_code))
    from student_prior_education p join enrollment_students s on s.id = p.student_id where s.id in (select student_id from _nat_act)), '[]'));

  v := v || jsonb_build_object('NAT00120', coalesce((select jsonb_agg(jsonb_build_object(
      'toid', v_toid, 'location_id', l.avetmiss_location_id, 'client_id', s.student_number, 'subject_id', cu.code,
      'program_id', c.code, 'start', coalesce(a.actual_start_date, a.assigned_start_date),
      'end', coalesce(a.actual_end_date, a.assigned_end_date), 'actual_end', a.actual_end_date,
      'delivery_mode', coalesce(a.delivery_mode_identifier, c.delivery_mode_identifier),
      'predominant_delivery_mode', coalesce(a.predominant_delivery_mode, c.predominant_delivery_mode),
      'outcome', coalesce(a.outcome_code, case when coalesce(a.actual_start_date, a.assigned_start_date) > current_date then '85' else '70' end),
      'funding', coalesce(a.funding_source_code, e.funding_source_code), 'study_reason', e.study_reason_code,
      -- Commencing program identifier: 3 = started the program this collection year, 4 = continuing from an earlier year.
      'commencing', case when e.course_start_date is null then null when e.course_start_date >= p_from then '3' else '4' end))
    from _nat_act a
    join enrollment_students s on s.id = a.student_id
    join cms_course_units cu on cu.id = a.unit_id
    join cms_courses c on c.id = coalesce(a.course_id, cu.course_id)
    left join locations l on l.id = a.location_id
    left join lateral (select * from intake_enrolments ie where ie.intake_id = a.intake_id and ie.student_id = a.student_id
                        order by ie.archived_at nulls first, ie.enrolled_on desc nulls last limit 1) e on true), '[]'));

  v := v || jsonb_build_object('NAT00130', coalesce((select jsonb_agg(jsonb_build_object(
      'toid', v_toid, 'program_id', cc.course_code, 'client_id', s.student_number,
      'year', extract(year from cc.issued_at)::int, 'issued', 'Y'))
    from course_completions cc join enrollment_students s on s.id = cc.student_id
   where cc.revoked_at is null and cc.kind = 'certificate' and cc.issued_at::date between p_from and p_to), '[]'));
  return v;
end $function$;

-- Every problem that would stop or weaken an NCVER submission: required fields, codes, formats, links between the files.
create or replace function public.avetmiss_nat_problems(p_nat jsonb)
returns table(nat text, record_key text, problem text)
language plpgsql stable set search_path to 'public' as $function$
declare r jsonb; k text;
  locs text[] := array(select jsonb_array_elements(coalesce(p_nat->'NAT00020', '[]'))->>'location_id');
  progs text[] := array(select jsonb_array_elements(coalesce(p_nat->'NAT00030', '[]'))->>'program_id');
  subs text[] := array(select jsonb_array_elements(coalesce(p_nat->'NAT00060', '[]'))->>'subject_id');
  clients text[] := array(select jsonb_array_elements(coalesce(p_nat->'NAT00080', '[]'))->>'client_id');
  final_codes text[] := array['20', '30', '40', '41', '51', '52', '60', '61', '81', '82'];
begin
  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00010', '[]')) loop
    k := coalesce(r->>'toid', '?');
    if nullif(btrim(coalesce(r->>'toid', '')), '') is null then nat := 'NAT00010'; record_key := k; problem := 'training organisation identifier missing'; return next; end if;
    if nullif(btrim(coalesce(r->>'name', '')), '') is null then nat := 'NAT00010'; record_key := k; problem := 'training organisation name missing'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'org_type' and code = r->>'org_type') then nat := 'NAT00010'; record_key := k; problem := 'organisation type identifier missing or not a code'; return next; end if;
    if nullif(btrim(coalesce(r->>'address1', '')), '') is null or nullif(btrim(coalesce(r->>'suburb', '')), '') is null then nat := 'NAT00010'; record_key := k; problem := 'address or suburb missing'; return next; end if;
    if coalesce(r->>'postcode', '') !~ '^[0-9]{4}$' then nat := 'NAT00010'; record_key := k; problem := 'postcode must be 4 digits'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'state' and code = r->>'state') then nat := 'NAT00010'; record_key := k; problem := 'state identifier missing or not a code'; return next; end if;
    if nullif(btrim(coalesce(r->>'contact_name', '')), '') is null then nat := 'NAT00010'; record_key := k; problem := 'contact name missing'; return next; end if;
  end loop;
  if jsonb_array_length(coalesce(p_nat->'NAT00010', '[]')) <> 1 then nat := 'NAT00010'; record_key := '-'; problem := 'exactly one training organisation record is required'; return next; end if;

  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00020', '[]')) loop
    k := coalesce(r->>'location_id', r->>'name', '?'); nat := 'NAT00020'; record_key := k;
    if nullif(btrim(coalesce(r->>'location_id', '')), '') is null or length(r->>'location_id') > 10 then problem := 'delivery location identifier missing or over 10 characters'; return next; end if;
    if nullif(btrim(coalesce(r->>'suburb', '')), '') is null then problem := 'suburb missing'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'country' and code = r->>'country') then problem := 'country identifier missing or not a code'; return next; end if;
    if r->>'country' = '1101' and coalesce(r->>'postcode', '') !~ '^[0-9]{4}$' then problem := 'postcode must be 4 digits'; return next; end if;
    if r->>'country' = '1101' and not exists (select 1 from avetmiss_codes where code_set = 'state' and code = r->>'state') then problem := 'state identifier missing or not a code'; return next; end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00030', '[]')) loop
    nat := 'NAT00030'; record_key := coalesce(r->>'program_id', '?');
    if nullif(btrim(coalesce(r->>'program_id', '')), '') is null then problem := 'program identifier missing'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'program_level' and code = r->>'level') then problem := 'program level of education identifier missing'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'program_recognition' and code = r->>'recognition') then problem := 'program recognition identifier missing'; return next; end if;
    if coalesce(r->>'foe', '') !~ '^[0-9]{4}$' then problem := 'program field of education identifier must be 4 digits'; return next; end if;
    if coalesce(r->>'anzsco', '') !~ '^[0-9]{6}$' then problem := 'ANZSCO identifier must be 6 digits'; return next; end if;
    if coalesce((r->>'nominal_hours')::numeric, 0) <= 0 then problem := 'nominal hours missing'; return next; end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00060', '[]')) loop
    nat := 'NAT00060'; record_key := coalesce(r->>'subject_id', '?');
    if coalesce(r->>'foe', '') !~ '^[0-9]{6}$' then problem := 'subject field of education identifier must be 6 digits'; return next; end if;
    if coalesce(r->>'vet_flag', '') not in ('Y', 'N') then problem := 'VET flag missing'; return next; end if;
    if coalesce((r->>'nominal_hours')::numeric, 0) <= 0 then problem := 'nominal hours missing'; return next; end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00080', '[]')) loop
    nat := 'NAT00080'; record_key := coalesce(r->>'client_id', r->>'name', '?');
    if nullif(btrim(coalesce(r->>'client_id', '')), '') is null or length(r->>'client_id') > 10 then problem := 'client identifier missing or over 10 characters'; return next; end if;
    for k in select jsonb_array_elements_text(coalesce(r->'missing', '[]')) loop problem := k || ' missing'; return next; end loop;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00085', '[]')) loop
    if not (r->>'client_id' = any(clients)) then nat := 'NAT00085'; record_key := coalesce(r->>'client_id', '?'); problem := 'client not in NAT00080'; return next; end if;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00090', '[]')) loop
    nat := 'NAT00090'; record_key := coalesce(r->>'client_id', '?');
    if not (r->>'client_id' = any(clients)) then problem := 'client not in NAT00080'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'disability_type' and code = r->>'disability_type') then problem := 'disability type not a code'; return next; end if;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00100', '[]')) loop
    nat := 'NAT00100'; record_key := coalesce(r->>'client_id', '?');
    if not (r->>'client_id' = any(clients)) then problem := 'client not in NAT00080'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'prior_education' and code = r->>'prior_education') then problem := 'prior educational achievement not a code'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'prior_education_recognition' and code = r->>'recognition') then problem := 'prior educational achievement recognition not a code'; return next; end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00120', '[]')) loop
    nat := 'NAT00120'; record_key := coalesce(r->>'client_id', '?') || ' / ' || coalesce(r->>'subject_id', '?');
    if not (coalesce(r->>'location_id', '') = any(locs)) then problem := 'delivery location not in NAT00020'; return next; end if;
    if not (coalesce(r->>'client_id', '') = any(clients)) then problem := 'client not in NAT00080'; return next; end if;
    if not (coalesce(r->>'subject_id', '') = any(subs)) then problem := 'subject not in NAT00060'; return next; end if;
    if not (coalesce(r->>'program_id', '') = any(progs)) then problem := 'program not in NAT00030'; return next; end if;
    if r->>'start' is null or r->>'end' is null then problem := 'activity start or end date missing'; return next;
    elsif (r->>'start')::date > (r->>'end')::date then problem := 'activity start date after end date'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'outcome' and code = r->>'outcome') then problem := 'outcome identifier not a code'; return next; end if;
    if r->>'outcome' = any(final_codes) and (r->>'actual_end' is null or (r->>'actual_end')::date > current_date) then problem := 'final outcome ' || (r->>'outcome') || ' needs its actual end date (not in the future)'; return next; end if;
    if r->>'outcome' = '85' and (r->>'start') is not null and (r->>'start')::date <= current_date then problem := 'outcome 85 (not yet started) but the activity has started'; return next; end if;
    if coalesce(r->>'delivery_mode', '') !~ '^[YN]{3}$' then problem := 'delivery mode identifier must be three Y/N flags'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'predominant_delivery_mode' and code = r->>'predominant_delivery_mode') then problem := 'predominant delivery mode missing'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'funding_source' and code = r->>'funding') then problem := 'funding source missing'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'study_reason' and code = r->>'study_reason') then problem := 'study reason missing'; return next; end if;
    if not exists (select 1 from avetmiss_codes where code_set = 'commencing' and code = r->>'commencing') then problem := 'commencing program identifier missing (course start date)'; return next; end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_nat->'NAT00130', '[]')) loop
    nat := 'NAT00130'; record_key := coalesce(r->>'client_id', '?') || ' / ' || coalesce(r->>'program_id', '?');
    if not (coalesce(r->>'program_id', '') = any(progs)) then problem := 'program not in NAT00030'; return next; end if;
    if not (coalesce(r->>'client_id', '') = any(clients)) then problem := 'client not in NAT00080'; return next; end if;
  end loop;
  return;
end $function$;

revoke all on function public.avetmiss_nat_build(date, date) from public, anon, authenticated;
revoke all on function public.avetmiss_nat_problems(jsonb) from public, anon, authenticated;
grant execute on function public.avetmiss_nat_build(date, date) to service_role;
grant execute on function public.avetmiss_nat_problems(jsonb) to service_role;

commit;
