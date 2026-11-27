-- 1. Validation: an AVETMISS field accepts any answer that maps to a valid AVETMISS code
--    (so the screen and the server can't drift apart: old labels like "Viet Nam" or "... - 09" still pass).
CREATE OR REPLACE FUNCTION public.portal_validate_submission(p_application_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; s jsonb; f jsonb; vals jsonb; field_value jsonb; v_category text; label text; v_problem text;
begin
 select * into a from public.enrollment_applications where id=p_application_id;
 vals:=public.application_values(a.id);
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
         and not (f ? 'avetmissSet' and public.avetmiss_code(f->>'avetmissSet', field_value#>>'{}') is not null) then
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
 v_problem := public.application_intake_problem(a.id);
 if v_problem is not null then raise exception '%', v_problem using errcode='22023'; end if;
end; $function$;

-- 2. Wizard options from the official AVETMISS / ABS lists
do $do$
declare
  sch jsonb := public.portal_required_schema();
  countries jsonb; reasons jsonb; new_sections jsonb := '[]'; sec jsonb; fl jsonb; new_fields jsonb;
begin
  select jsonb_agg(label order by (code = '1101') desc, label) into countries
    from public.avetmiss_codes where code_set = 'country' and is_active and code <> '@@@@';
  select jsonb_agg(label || ' - ' || code order by sort) into reasons
    from public.avetmiss_codes where code_set = 'study_reason' and is_active;

  for sec in select value from jsonb_array_elements(sch) loop
    new_fields := '[]';
    for fl in select value from jsonb_array_elements(sec->'fields') loop
      fl := case fl->>'name'
        when 'birth_country' then fl || jsonb_build_object('options', countries, 'avetmissSet', 'country', 'searchable', true)
        when 'citizenship'   then fl || jsonb_build_object('options', countries, 'avetmissSet', 'country', 'searchable', true)
        when 'study_reason'  then fl || jsonb_build_object('options', reasons, 'avetmissSet', 'study_reason')
        when 'gender'        then fl || jsonb_build_object('options', '["Male","Female","Other","Prefer not to say"]'::jsonb, 'avetmissSet', 'sex')
        when 'atsi'          then fl || jsonb_build_object('options',
                                   (fl->'options') || case when (fl->'options') ? 'Prefer not to say' then '[]'::jsonb else '["Prefer not to say"]'::jsonb end,
                                   'avetmissSet', 'indigenous_status')
        when 'school_level'  then fl || jsonb_build_object('options',
                                   (fl->'options') || case when (fl->'options') ? 'Prefer not to say' then '[]'::jsonb else '["Prefer not to say"]'::jsonb end,
                                   'avetmissSet', 'school_level')
        when 'employment'    then fl || jsonb_build_object('avetmissSet', 'labour_force')
        when 'disability'    then fl || jsonb_build_object('avetmissSet', 'flag')
        when 'prior_ed'      then fl || jsonb_build_object('avetmissSet', 'flag')
        when 'secondary_enrolled' then fl || jsonb_build_object('avetmissSet', 'flag')
        else fl end;
      new_fields := new_fields || jsonb_build_array(fl);
    end loop;
    new_sections := new_sections || jsonb_build_array(jsonb_set(sec, '{fields}', new_fields));
  end loop;

  execute format($f$create or replace function public.portal_required_schema() returns jsonb
    language sql immutable set search_path to 'public' as %L$f$,
    'select ' || quote_literal(new_sections::text) || '::jsonb');
end $do$;