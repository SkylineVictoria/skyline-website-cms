-- Applied on hosted 20261126124153 (avetmiss_enforce_upcoming_data) outside this repo; pulled from supabase_migrations.schema_migrations.statements so the lab replays what hosted has.
-- 1. Student: fuller NAT00080/85 completeness check (used by the enrolment gate).
create or replace function public.avetmiss_student_missing(p_student uuid)
 returns text[] language plpgsql stable security definer set search_path to 'public'
as $function$
declare s enrollment_students; d jsonb; m text[] := '{}'; v_overseas boolean; v_dob date;
begin
  select * into s from enrollment_students where id = p_student;
  if not found then return array['student record']; end if;
  d := coalesce(s.details, '{}'::jsonb);
  v_overseas := d->>'address_type' = 'Overseas Address'
    or (nullif(btrim(d->>'au_country'), '') is not null and lower(btrim(d->>'au_country')) not in ('australia', 'au'));
  begin v_dob := coalesce(s.date_of_birth, nullif(btrim(d->>'dob'), '')::date); exception when others then v_dob := null; end;

  if nullif(btrim(d->>'first_name'), '') is null and nullif(btrim(d->>'last_name'), '') is null then m := array_append(m, 'name'); end if;
  if v_dob is null then m := array_append(m, 'date of birth');
  elsif v_dob > current_date - interval '10 years' or v_dob < current_date - interval '100 years' then m := array_append(m, 'valid date of birth (age 10-100)'); end if;
  if s.sex_code is null then m := array_append(m, 'gender'); end if;
  if s.birth_country_code is null then m := array_append(m, 'country of birth');
  elsif s.birth_country_code <> '@@@@' and not exists (select 1 from avetmiss_codes where code_set = 'country' and code = s.birth_country_code) then m := array_append(m, 'valid country of birth'); end if;
  if s.home_language_code is null then m := array_append(m, 'language spoken at home');
  elsif s.home_language_code <> '@@@@' and not exists (select 1 from avetmiss_codes where code_set = 'language' and code = s.home_language_code) then m := array_append(m, 'valid language spoken at home'); end if;
  if s.home_language_code not in ('1201', '@@@@') and s.english_proficiency_code is null then m := array_append(m, 'English proficiency'); end if;
  if s.indigenous_status_code is null then m := array_append(m, 'Aboriginal or Torres Strait Islander status'); end if;
  if s.school_level_code is null then m := array_append(m, 'highest school level completed');
  elsif s.school_level_code not in ('02', '@@') and s.school_level_year is null then m := array_append(m, 'year highest school level completed'); end if;
  if s.school_level_year ~ '^[0-9]{4}$' and v_dob is not null
     and (s.school_level_year::int < extract(year from v_dob) + 5 or s.school_level_year::int > extract(year from current_date)) then
    m := array_append(m, 'valid year school completed'); end if;
  if s.at_school_flag is null then m := array_append(m, 'still at secondary school'); end if;
  if s.labour_force_code is null then m := array_append(m, 'employment status'); end if;
  if s.disability_flag is null then m := array_append(m, 'disability (yes/no)'); end if;
  if s.disability_flag = 'Y' and not exists (select 1 from student_disabilities x where x.student_id = s.id) then m := array_append(m, 'disability type'); end if;
  if s.prior_education_flag is null then m := array_append(m, 'prior education (yes/no)'); end if;
  if s.prior_education_flag = 'Y' and not exists (select 1 from student_prior_education x where x.student_id = s.id) then m := array_append(m, 'prior qualifications'); end if;
  -- USI: a consent-only row is not a USI
  if nullif(btrim(d->>'usi_number'), '') is null
     and not exists (select 1 from application_usi u join enrollment_applications a on a.id = u.application_id
                     where a.student_id = s.id and nullif(btrim(u.usi), '') is not null) then
    m := array_append(m, 'USI'); end if;
  if v_overseas then
    if nullif(btrim(coalesce(d->>'ov_street', d->>'au_street')), '') is null then m := array_append(m, 'street address'); end if;
    if nullif(btrim(coalesce(d->>'ov_suburb', d->>'au_suburb')), '') is null then m := array_append(m, 'suburb / town'); end if;
  else
    if nullif(btrim(d->>'au_street'), '') is null then m := array_append(m, 'street address'); end if;
    if nullif(btrim(d->>'au_suburb'), '') is null then m := array_append(m, 'residential suburb'); end if;
    if coalesce(btrim(d->>'au_zip'), '') !~ '^[0-9]{4}$' then m := array_append(m, 'residential postcode'); end if;
    if avetmiss_code('state', d->>'au_state') is null then m := array_append(m, 'residential state'); end if;
  end if;
  return m;
end $function$;

-- 2. Course enrolment (NAT00120 program level): fill funding source and course dates, then require them.
create or replace function public.intake_enrolments_avetmiss_required()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_missing text[]; i record;
begin
  if new.study_reason_code is null then
    select avetmiss_code('study_reason', s.details->>'study_reason') into new.study_reason_code
      from enrollment_students s where s.id = new.student_id;
  end if;
  if new.study_reason_code is null then
    select avetmiss_code('study_reason', a.data #>> '{values,study_reason}') into new.study_reason_code
      from enrollment_applications a
     where a.student_id = new.student_id and nullif(btrim(a.data #>> '{values,study_reason}'), '') is not null
     order by a.updated_at desc nulls last, a.created_at desc limit 1;
  end if;
  -- Funding source: international (onshore) or domestic full fee-for-service, from residency
  if new.funding_source_code is null then
    select case when s.residency_status = 'international' then '31'
                when s.residency_status is not null then '20' end
      into new.funding_source_code from enrollment_students s where s.id = new.student_id;
  end if;
  if new.course_start_date is null or new.course_end_date is null then
    select start_date, end_date into i from course_intakes where id = new.intake_id;
    new.course_start_date := coalesce(new.course_start_date, i.start_date);
    new.course_end_date := coalesce(new.course_end_date, i.end_date);
  end if;

  v_missing := avetmiss_student_missing(new.student_id);
  if new.study_reason_code is null then v_missing := array_append(v_missing, 'study reason'); end if;
  if new.funding_source_code is null then v_missing := array_append(v_missing, 'funding source (residency status)'); end if;
  if new.course_start_date is null then v_missing := array_append(v_missing, 'course start date'); end if;
  if array_length(v_missing, 1) > 0 then
    raise exception 'This student cannot be enrolled yet. AVETMISS details missing: %.', array_to_string(v_missing, ', ')
      using errcode = 'check_violation';
  end if;
  return new;
end $function$;

-- 3. Unit enrolment and results (NAT00120 unit level).
create or replace function public.lms_unit_students_avetmiss()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_loc uuid; c record; u record; v_missing text[] := '{}';
begin
  if tg_op = 'UPDATE' and new.location_id is distinct from old.location_id and new.location_is_auto is not distinct from old.location_is_auto then
    new.location_is_auto := false;
  end if;
  if new.location_id is null or new.location_is_auto then
    v_loc := avetmiss_batch_location(new.intake_id, new.student_id, new.unit_id);
    if v_loc is not null then new.location_id := v_loc; new.location_is_auto := true; end if;
  end if;

  if new.outcome_code in ('51','52','60') then
    new.delivery_mode_identifier := 'NNN'; new.predominant_delivery_mode := 'N';
  elsif new.delivery_mode_identifier is null or new.predominant_delivery_mode is null
        or (tg_op = 'UPDATE' and old.outcome_code in ('51','52','60') and new.delivery_mode_identifier = 'NNN') then
    select delivery_mode_identifier, predominant_delivery_mode into c from cms_courses where id = new.course_id;
    new.delivery_mode_identifier := coalesce(case when new.delivery_mode_identifier = 'NNN' then null else new.delivery_mode_identifier end, c.delivery_mode_identifier);
    new.predominant_delivery_mode := coalesce(case when new.predominant_delivery_mode = 'N' then null else new.predominant_delivery_mode end, c.predominant_delivery_mode);
  end if;

  if new.funding_source_code is null then
    select e.funding_source_code into new.funding_source_code
      from intake_enrolments e where e.intake_id = new.intake_id and e.student_id = new.student_id
     order by (e.archived_at is null) desc, e.enrolled_on desc nulls last limit 1;
  end if;

  if tg_op = 'INSERT' then
    select code, slit_hours, field_of_education_code, vet_flag into u from cms_course_units where id = new.unit_id;
    if coalesce(u.slit_hours, 0) <= 0 then
      raise exception 'Set your RTO hours for unit % before students are enrolled in it (they are reported to NCVER).', u.code
        using errcode = 'check_violation';
    end if;
    if coalesce(u.field_of_education_code, '') !~ '^[0-9]{6}$' or u.vet_flag is null then
      raise exception 'Unit % is missing its field of education or VET flag. These fill in automatically from training.gov.au shortly after the unit is added; try again in a few minutes.', u.code
        using errcode = 'check_violation';
    end if;
  end if;

  -- Once a result is recorded it must be reportable
  if new.outcome_code is not null and new.outcome_code <> '85'
     and (tg_op = 'INSERT' or new.outcome_code is distinct from old.outcome_code
          or new.actual_start_date is distinct from old.actual_start_date or new.actual_end_date is distinct from old.actual_end_date
          or new.location_id is distinct from old.location_id or new.funding_source_code is distinct from old.funding_source_code) then
    if new.actual_start_date is null then v_missing := array_append(v_missing, 'activity start date'); end if;
    if new.outcome_code <> '70' and new.actual_end_date is null then v_missing := array_append(v_missing, 'activity end date'); end if;
    if new.location_id is null then v_missing := array_append(v_missing, 'delivery location'); end if;
    if new.funding_source_code is null then v_missing := array_append(v_missing, 'funding source'); end if;
    if new.delivery_mode_identifier is null or new.predominant_delivery_mode is null then v_missing := array_append(v_missing, 'delivery mode'); end if;
    if array_length(v_missing, 1) > 0 then
      raise exception 'This result cannot be saved yet. AVETMISS details missing: %.', array_to_string(v_missing, ', ')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $function$;

-- 4. Course (NAT00030): a published course must be fully reportable.
create or replace function public.cms_courses_avetmiss_delivery()
 returns trigger language plpgsql set search_path to 'public'
as $function$
declare m text := lower(coalesce(new.mode, '')); v_missing text[] := '{}';
begin
  if new.delivery_mode_identifier is null and m <> '' then
    new.delivery_mode_identifier :=
      (case when m ~ '(face|class|campus|blend|mixed|on-?site)' then 'Y' else 'N' end) ||
      (case when m ~ '(online|distance|remote|blend|mixed|virtual)' then 'Y' else 'N' end) ||
      (case when m ~ '(workplace|work-based|work based|on-the-job|placement)' then 'Y' else 'N' end);
    if new.delivery_mode_identifier = 'NNN' then new.delivery_mode_identifier := null; end if;
  end if;
  if new.predominant_delivery_mode is null and new.delivery_mode_identifier is not null then
    new.predominant_delivery_mode := case when substr(new.delivery_mode_identifier, 1, 1) = 'Y' then 'I'
                                          when substr(new.delivery_mode_identifier, 2, 1) = 'Y' then 'E' else 'W' end;
  end if;
  if new.status = 'Published' then
    if new.delivery_mode_identifier is null or new.predominant_delivery_mode is null then
      raise exception 'Choose how this course is delivered (classroom, online and/or workplace, and which is the main one) before publishing it. It is reported to NCVER.'
        using errcode = 'check_violation';
    end if;
    if coalesce(btrim(new.code), '') !~ '^[A-Z0-9]{1,10}$' then v_missing := array_append(v_missing, 'national course code (max 10 characters)'); end if;
    if char_length(coalesce(new.name, '')) not between 1 and 100 then v_missing := array_append(v_missing, 'course name (max 100 characters)'); end if;
    if coalesce(new.tga_field_of_education_code, '') !~ '^[0-9]{4}$' then v_missing := array_append(v_missing, 'field of education'); end if;
    if coalesce(new.tga_anzsco_code, '') !~ '^[0-9]{6}$' then v_missing := array_append(v_missing, 'ANZSCO code'); end if;
    if nullif(btrim(new.tga_qualification_level), '') is null then v_missing := array_append(v_missing, 'qualification level'); end if;
    if array_length(v_missing, 1) > 0 then
      raise exception 'This course cannot be published yet. AVETMISS details missing: %. Re-import it from training.gov.au to fill them.', array_to_string(v_missing, ', ')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $function$;
