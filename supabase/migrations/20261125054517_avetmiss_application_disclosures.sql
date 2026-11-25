-- NCVER AVETMISS Data Element Definitions 2.3, Disability flag / Disability type
-- identifier / Prior educational achievement flag and identifier.
-- https://www.ncver.edu.au/rto-hub/statistical-standard-software/avetmiss-data-element-definitions-edition-2.3
-- Keep draft disclosures on the application. Apply them to the student's reporting
-- records when the existing authorised submission or resubmission commits.

create or replace function public.application_route_student_fields() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare
  sv jsonb;
  disclosures jsonb;
  quals jsonb;
begin
  if new.student_id is null or new.data is null then return new; end if;
  sv := public.student_values(new.data -> 'values');
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into disclosures
  from jsonb_each(sv) where key in ('disability', 'prior_ed', 'english_proficiency_code');
  sv := sv - array['disability', 'prior_ed', 'english_proficiency_code'];
  quals := case when jsonb_typeof(new.data -> 'academicQualifications') = 'array' then new.data -> 'academicQualifications' end;
  if sv <> '{}'::jsonb or quals is not null then
    perform public.student_apply_details(new.student_id, sv, quals);
  end if;
  new.data := new.data - 'academicQualifications';
  if new.data ? 'values' then
    new.data := jsonb_set(new.data, '{values}', public.application_only_values(new.data -> 'values') || disclosures, true);
  end if;
  return new;
end;
$function$;

create or replace function public.application_values(p_application uuid) returns jsonb
language sql stable security definer set search_path = '' as $function$
  select coalesce(a.data -> 'values', '{}'::jsonb) || coalesce(s.details, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'disability', a.data #> '{values,disability}',
      'prior_ed', a.data #> '{values,prior_ed}',
      'english_proficiency_code', a.data #> '{values,english_proficiency_code}'
    ))
  from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id
  where a.id = p_application;
$function$;

create or replace function public.application_data(p_application uuid) returns jsonb
language sql stable security definer set search_path = '' as $function$
  select jsonb_set(coalesce(a.data, '{}'::jsonb) || jsonb_build_object(
    'academicQualifications', coalesce(a.data -> 'academicQualifications', s.qualifications, '[]'::jsonb)
  ), '{values}', public.application_values(a.id), true)
  from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id
  where a.id = p_application;
$function$;

-- Use the committed application version as the historical disclosure record. No
-- disability or qualification contents are copied to general-purpose activity logs.
create function skyline_private.avetmiss_apply_application_disclosures() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare
  draft jsonb := coalesce(new.data -> 'values', '{}'::jsonb);
  vals jsonb;
  s public.enrollment_students;
  disability_answer text;
  prior_answer text;
  proficiency text;
  types text[];
  qualifications jsonb;
begin
  if new.student_id is null then return new; end if;
  select * into strict s from public.enrollment_students where id = new.student_id for update;
  vals := coalesce(s.details, '{}'::jsonb) || draft;

  if draft ?| array['disability', 'disability_types'] then
    disability_answer := case vals ->> 'disability'
      when 'Yes' then 'Y' when 'No' then 'N' when 'Not specified' then '@' end;
    if disability_answer is null then
      raise exception 'Choose an answer: disability' using errcode = '22023';
    end if;
    types := '{}';
    if disability_answer = 'Y' then
      select coalesce(array_agg(distinct btrim(t.code)), '{}') into types
      from unnest(string_to_array(vals ->> 'disability_types', ',')) t(code)
      where btrim(t.code) <> '';
      -- NAT00090 requires 99 when the learner discloses a disability but no specific type.
      if cardinality(types) = 0 then types := array['99']; end if;
      if ('99' = any(types) and cardinality(types) > 1) or exists (
        select 1 from unnest(types) t(code) where not exists (
          select 1 from public.avetmiss_codes c
          where c.code_set = 'disability_type' and c.code = t.code and c.is_active
        )
      ) then
        raise exception 'Choose valid disability categories: disability_types' using errcode = '22023';
      end if;
    end if;
    delete from public.student_disabilities
    where student_id = s.id and disability_type_code <> all(types);
    insert into public.student_disabilities(student_id, disability_type_code)
    select s.id, t.code from unnest(types) t(code)
    on conflict (student_id, disability_type_code) do nothing;
    s.details := s.details || jsonb_build_object('disability', vals ->> 'disability');
    s.disability_flag := disability_answer;
  end if;

  if draft ?| array['prior_ed', 'prior_education'] then
    prior_answer := case vals ->> 'prior_ed'
      when 'Yes' then 'Y' when 'No' then 'N' when 'Not specified' then '@' end;
    if prior_answer is null then
      raise exception 'Choose an answer: prior_ed' using errcode = '22023';
    end if;
    qualifications := '[]'::jsonb;
    if prior_answer = 'Y' then
      begin
        qualifications := coalesce(nullif(vals ->> 'prior_education', '')::jsonb, '[]'::jsonb);
      exception when invalid_text_representation then
        raise exception 'Choose valid qualifications: prior_education' using errcode = '22023';
      end;
      if jsonb_typeof(qualifications) <> 'array' or qualifications = '[]'::jsonb then
        raise exception 'Add at least one qualification: prior_education' using errcode = '22023';
      end if;
      if exists (
        select 1 from jsonb_array_elements(qualifications) q(v)
        where not exists (select 1 from public.avetmiss_codes c
                 where c.code_set = 'prior_education' and c.code = q.v ->> 'code' and c.is_active)
           or not exists (select 1 from public.avetmiss_codes c
                 where c.code_set = 'prior_education_recognition' and c.code = q.v ->> 'recognition' and c.is_active)
           or char_length(btrim(q.v ->> 'name')) > 200
      ) or exists (
        select 1 from jsonb_array_elements(qualifications) q(v)
        group by q.v ->> 'code', q.v ->> 'recognition' having count(*) > 1
      ) then
        raise exception 'Check qualification categories and recognition: prior_education' using errcode = '22023';
      end if;
    end if;
    delete from public.student_prior_education p
    where p.student_id = s.id and not exists (
      select 1 from jsonb_array_elements(qualifications) q(v)
      where q.v ->> 'code' = p.prior_education_code and q.v ->> 'recognition' = p.recognition_code
    );
    insert into public.student_prior_education(student_id, prior_education_code, recognition_code, qualification_name)
    select s.id, q.v ->> 'code', q.v ->> 'recognition', nullif(btrim(q.v ->> 'name'), '')
    from jsonb_array_elements(qualifications) q(v)
    on conflict (student_id, prior_education_code, recognition_code) do update
    set qualification_name = excluded.qualification_name
    where student_prior_education.qualification_name is distinct from excluded.qualification_name;
    s.details := s.details || jsonb_build_object('prior_ed', vals ->> 'prior_ed');
    s.prior_education_flag := prior_answer;
  end if;

  if draft ? 'english_proficiency_code' then
    proficiency := nullif(btrim(draft ->> 'english_proficiency_code'), '');
    if proficiency is not null and not exists (
      select 1 from public.avetmiss_codes c
      where c.code_set = 'english_proficiency' and c.code = proficiency and c.is_active
    ) then
      raise exception 'Choose a valid English proficiency: english_proficiency_code' using errcode = '22023';
    end if;
    s.details := s.details - 'english_proficiency_code';
    s.english_proficiency_code := proficiency;
  end if;

  update public.enrollment_students
  set details = s.details, disability_flag = s.disability_flag, prior_education_flag = s.prior_education_flag,
      english_proficiency_code = s.english_proficiency_code
  where id = s.id;
  return new;
end;
$function$;
revoke all on function skyline_private.avetmiss_apply_application_disclosures() from public, anon, authenticated;

create trigger avetmiss_application_disclosures
before update of status on public.enrollment_applications
for each row when (
  -- rule-policy: technical committed-disclosure Trigger follows the authorised application submission transition.
  old.status in ('draft', 'action_required') and new.status = 'submitted'
  and (new.data -> 'values') ?| array['disability', 'disability_types', 'prior_ed', 'prior_education', 'english_proficiency_code']
)
execute function skyline_private.avetmiss_apply_application_disclosures();

-- NCVER Release 8.0 NAT00080 omits spoken English proficiency (removed in Release 8.0).
CREATE OR REPLACE FUNCTION public.avetmiss_student_missing(p_student uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- rule-policy: technical reporting-diagnostics Collect validation issue labels from the existing enrollment gate.
declare s enrollment_students; d jsonb; m text[] := '{}'; v_overseas boolean;
begin
  select * into s from enrollment_students where id = p_student;
  if not found then return array['student record']; end if;
  d := coalesce(s.details, '{}'::jsonb);
  v_overseas := nullif(btrim(d->>'au_country'), '') is not null and lower(btrim(d->>'au_country')) not in ('australia', 'au');
  if nullif(btrim(d->>'dob'), '') is null then m := array_append(m, 'date of birth'); end if;
  if s.sex_code is null then m := array_append(m, 'gender'); end if;
  if s.birth_country_code is null then m := array_append(m, 'country of birth'); end if;
  if s.home_language_code is null then m := array_append(m, 'language spoken at home'); end if;
  -- rule-policy: technical reporting-diagnostics Report an unanswered existing reporting classification.
  if s.indigenous_status_code is null then m := array_append(m, 'Aboriginal or Torres Strait Islander status'); end if;
  if s.school_level_code is null then m := array_append(m, 'highest school level completed'); end if;
  if s.at_school_flag is null then m := array_append(m, 'still at secondary school'); end if;
  -- rule-policy: technical reporting-diagnostics Report an unanswered existing reporting classification.
  if s.labour_force_code is null then m := array_append(m, 'employment status'); end if;
  if s.disability_flag is null then m := array_append(m, 'disability (yes/no)'); end if;
  if s.disability_flag = 'Y' and not exists (select 1 from student_disabilities x where x.student_id = s.id) then m := array_append(m, 'disability type'); end if;
  if s.prior_education_flag is null then m := array_append(m, 'prior education (yes/no)'); end if;
  if s.prior_education_flag = 'Y' and not exists (select 1 from student_prior_education x where x.student_id = s.id) then m := array_append(m, 'prior qualifications'); end if;
  -- rule-policy: technical reporting-diagnostics Reuse the existing learner identifier presence check.
  if nullif(btrim(d->>'usi_number'), '') is null
     and not exists (select 1 from application_usi u join enrollment_applications a on a.id = u.application_id where a.student_id = s.id) then
    m := array_append(m, 'USI'); end if;
  if not v_overseas then
    if nullif(btrim(d->>'au_suburb'), '') is null then m := array_append(m, 'residential suburb'); end if;
    if coalesce(btrim(d->>'au_zip'), '') !~ '^[0-9]{4}$' then m := array_append(m, 'residential postcode'); end if;
    if nullif(btrim(d->>'au_state'), '') is null then m := array_append(m, 'residential state'); end if;
  end if;
  return m;
end $function$;

-- This function runs inside the enrolment trigger. Direct calls would expose protected reporting details.
revoke execute on function public.avetmiss_student_missing(uuid) from public, anon, authenticated;

-- Permit current country-of-birth and study-reason references alongside historical application values.
CREATE OR REPLACE FUNCTION public.portal_validate_submission(p_application_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; s jsonb; f jsonb; vals jsonb; field_value jsonb; v_category text; label text; v_problem text;
begin
 select * into a from public.enrollment_applications where id=p_application_id;
 vals:=public.application_values(a.id);
 -- rule-policy: regulatory ncver-language-identifier The national language identifier must use a recognised code. https://www.ncver.edu.au/rto-hub/statistical-standard-software/avetmiss-data-element-definitions-edition-2.3
 if vals->>'language_home' = 'Yes, language other than English' and not exists (
   select 1 from public.avetmiss_codes c where c.code_set = 'language' and c.is_active
   and c.code <> '1201' and c.code = public.avetmiss_code('language', vals->>'language_other')
 ) then
   raise exception 'Choose a valid language: language_other' using errcode='22023';
 end if;
 for s in select value from jsonb_array_elements(public.portal_required_schema()) loop
  if not public.portal_condition_met(s->'showIf',vals) then continue; end if;
  for f in select value from jsonb_array_elements(s->'fields') loop
   if not public.portal_condition_met(f->'showIf',vals) or public.admissions_field_optional(f->>'name')
      or (f->>'name' = 'mobile' and not public.rule_bool('admissions.application_mobile_required', true)) then continue; end if;
   label:=f->>'name';field_value:=vals->label;
   if f->>'type'='file' then
    v_category:=case label when 'passport_copy' then 'Passport' when 'visa_copy' then 'Visa' when 'english_upload' then 'English Test' when 'academic_upload' then 'Academic' end;
    if v_category is null or not exists(select 1 from public.enrollment_application_documents d join storage.objects o on o.bucket_id=d.bucket_name and o.name=d.storage_path
     where d.application_id=a.id and d.category=v_category and d.is_current) then
     raise exception 'Required document missing: %',label using errcode='22023'; end if;
   elsif f->>'type'='checkbox' then
    if jsonb_typeof(field_value) is distinct from 'array' or jsonb_array_length(field_value)=0 then raise exception 'Required selection missing: %',label using errcode='22023'; end if;
    if label='courses_of_interest' then
     if not exists(select 1 from public.enrollment_application_courses where application_id=a.id) then raise exception 'Select an institution course' using errcode='22023'; end if;
    elsif f ? 'options' then
     if exists(select 1 from jsonb_array_elements_text(field_value) v where not (f->'options' ? v)) then raise exception 'Invalid selection: %',label using errcode='22023'; end if;
    end if;
   elsif nullif(btrim(field_value#>>'{}'),'') is null then raise exception 'Required field missing: %',label using errcode='22023';
   elsif f->>'type' in ('select','radio') and f ? 'options' and label<>'agent_agency' and not(f->'options' ? (field_value#>>'{}'))
    and not exists (
      select 1 from public.avetmiss_codes c
      where c.code_set = case label when 'birth_country' then 'country' when 'study_reason' then 'study_reason' end
        and c.is_active and c.code = public.avetmiss_code(c.code_set, field_value#>>'{}')
    ) then
    raise exception 'Invalid option: %',label using errcode='22023';
   elsif f->>'type'='date' then
    begin perform (field_value#>>'{}')::date; exception when others then raise exception 'Invalid date: %',label using errcode='22023'; end;
   elsif f->>'type'='email' and (field_value#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid email: %',label using errcode='22023';
   end if;
  end loop;
 end loop;
 if nullif(btrim(vals->>'mobile'), '') is not null
    and regexp_replace(vals->>'mobile', '[[:space:]().-]', '', 'g') !~ '^(04[0-9]{8}|\+61[1-9][0-9]{8}|\+(?!61)[1-9][0-9]{6,14})$' then
   raise exception 'Enter a valid phone number: mobile' using errcode='22023';
 end if;
 if vals->>'email' is distinct from vals->>'confirm_email' then raise exception 'Email confirmation does not match' using errcode='22023'; end if;
 if a.tenant_id is not null and exists(select 1 from public.enrollment_application_courses c left join public.cms_courses cc on cc.id=c.course_id and cc.tenant_id=a.tenant_id and (cc.status='Published' or not public.rule_bool('admissions.applications_require_published_course', true))
  where c.application_id=a.id and cc.id is null) then raise exception 'Course is no longer published' using errcode='22023'; end if;
 -- INT-01: an open intake of the application's own course, and the label the server wrote for it.
 v_problem := public.application_intake_problem(a.id);
 if v_problem is not null then raise exception '%', v_problem using errcode='22023'; end if;
end; $function$;
