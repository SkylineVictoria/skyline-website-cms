-- 1. Submission checks the wizard's AVETMISS follow-up answers (the screen collects them; now the server insists)
create or replace function public.avetmiss_application_problem(vals jsonb)
returns text language plpgsql stable set search_path = public as $$
declare v jsonb; arr jsonb;
begin
  -- Home language other than English: which one (ASCL)
  if coalesce(vals->>'language_home', '') <> '' and avetmiss_code('language', vals->>'language_home') is null
     and avetmiss_code('language', vals->>'language_other') is null then
    return 'Choose the language spoken at home';
  end if;
  -- Disability = Yes: at least one type
  if lower(btrim(coalesce(vals->>'disability', ''))) = 'yes' then
    v := vals->'disability_types';
    if jsonb_typeof(v) = 'string' then begin v := (v#>>'{}')::jsonb; exception when others then v := to_jsonb(v#>>'{}'); end; end if;
    if v is null or v = '""'::jsonb or v = '[]'::jsonb or v = 'null'::jsonb or (jsonb_typeof(v) = 'string' and btrim(v#>>'{}') = '') then
      return 'Choose the disability type(s)';
    end if;
  end if;
  -- Prior education = Yes: at least one qualification
  if lower(btrim(coalesce(vals->>'prior_ed', ''))) = 'yes' then
    arr := vals->'prior_education';
    if jsonb_typeof(arr) = 'string' then begin arr := (arr#>>'{}')::jsonb; exception when others then arr := null; end; end if;
    if arr is null or jsonb_typeof(arr) <> 'array' or jsonb_array_length(arr) = 0 then
      return 'Add the prior qualification(s)';
    end if;
  end if;
  -- Australian address: real state and 4-digit postcode
  if vals->>'address_type' = 'Australian Address' then
    if avetmiss_code('state', vals->>'au_state') is null then return 'Enter a valid Australian state (e.g. VIC)'; end if;
    if coalesce(btrim(vals->>'au_zip'), '') !~ '^[0-9]{4}$' then return 'Enter a 4-digit Australian postcode'; end if;
  end if;
  return null;
end $$;

-- State names as people type them
insert into public.avetmiss_code_aliases (code_set, alias, code) values
('state','victoria','02'),('state','new south wales','01'),('state','queensland','03'),('state','south australia','04'),
('state','western australia','05'),('state','tasmania','06'),('state','northern territory','07'),
('state','australian capital territory','08'),('state','vic.','02'),('state','nsw.','01')
on conflict do nothing;

do $do$
declare d text := pg_get_functiondef('public.portal_validate_submission(uuid)'::regprocedure);
begin
  if position('avetmiss_application_problem' in d) = 0 then
    d := replace(d, ' v_problem := public.application_intake_problem(a.id);',
      ' v_problem := public.avetmiss_application_problem(vals);
 if v_problem is not null then raise exception ''%'', v_problem using errcode=''22023''; end if;
 v_problem := public.application_intake_problem(a.id);');
    if position('avetmiss_application_problem' in d) = 0 then raise exception 'could not patch portal_validate_submission'; end if;
    execute d;
  end if;
end $do$;

-- 2. Remaining short country lists -> full ABS list (overseas address country, nationality, Australian-address country)
do $do$
declare sch jsonb := public.portal_required_schema(); countries jsonb; out jsonb := '[]'; sec jsonb; fl jsonb; nf jsonb;
begin
  select jsonb_agg(label order by (code = '1101') desc, label) into countries
    from public.avetmiss_codes where code_set = 'country' and is_active and code <> '@@@@';
  for sec in select value from jsonb_array_elements(sch) loop
    nf := '[]';
    for fl in select value from jsonb_array_elements(sec->'fields') loop
      if fl->>'name' in ('ov_country','nationality','au_country') then
        fl := fl || jsonb_build_object('options', countries, 'avetmissSet', 'country', 'searchable', true);
      end if;
      nf := nf || jsonb_build_array(fl);
    end loop;
    out := out || jsonb_build_array(jsonb_set(sec, '{fields}', nf));
  end loop;
  execute format($f$create or replace function public.portal_required_schema() returns jsonb
    language sql immutable set search_path to 'public' as %L$f$, 'select ' || quote_literal(out::text) || '::jsonb');
end $do$;

-- 3. Overseas addresses (NCVER: postcode OSPC, state 99) no longer block enrolment; street parts come from the address actually given
create or replace function public.avetmiss_student_missing(p_student uuid)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare s enrollment_students; d jsonb; m text[] := '{}'; v_overseas boolean;
begin
  select * into s from enrollment_students where id = p_student;
  if not found then return array['student record']; end if;
  d := coalesce(s.details, '{}'::jsonb);
  v_overseas := d->>'address_type' = 'Overseas Address'
    or (nullif(btrim(d->>'au_country'), '') is not null and lower(btrim(d->>'au_country')) not in ('australia', 'au'));
  if nullif(btrim(d->>'first_name'), '') is null and nullif(btrim(d->>'last_name'), '') is null then m := array_append(m, 'name'); end if;
  if nullif(btrim(d->>'dob'), '') is null then m := array_append(m, 'date of birth'); end if;
  if s.sex_code is null then m := array_append(m, 'gender'); end if;
  if s.birth_country_code is null then m := array_append(m, 'country of birth'); end if;
  if s.home_language_code is null then m := array_append(m, 'language spoken at home'); end if;
  if s.indigenous_status_code is null then m := array_append(m, 'Aboriginal or Torres Strait Islander status'); end if;
  if s.school_level_code is null then m := array_append(m, 'highest school level completed'); end if;
  if s.at_school_flag is null then m := array_append(m, 'still at secondary school'); end if;
  if s.labour_force_code is null then m := array_append(m, 'employment status'); end if;
  if s.disability_flag is null then m := array_append(m, 'disability (yes/no)'); end if;
  if s.disability_flag = 'Y' and not exists (select 1 from student_disabilities x where x.student_id = s.id) then m := array_append(m, 'disability type'); end if;
  if s.prior_education_flag is null then m := array_append(m, 'prior education (yes/no)'); end if;
  if s.prior_education_flag = 'Y' and not exists (select 1 from student_prior_education x where x.student_id = s.id) then m := array_append(m, 'prior qualifications'); end if;
  if nullif(btrim(d->>'usi_number'), '') is null
     and not exists (select 1 from application_usi u join enrollment_applications a on a.id = u.application_id where a.student_id = s.id) then
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
end $$;

create or replace function public.enrollment_students_address_split()
returns trigger language plpgsql set search_path = public as $$
declare d jsonb := coalesce(new.details, '{}'::jsonb); r record; v_street text; v_line2 text;
begin
  if d->>'address_type' = 'Overseas Address' and nullif(btrim(d->>'ov_street'), '') is not null then
    v_street := d->>'ov_street'; v_line2 := d->>'ov_line2';
  else
    v_street := d->>'au_street'; v_line2 := d->>'au_line2';
  end if;
  if tg_op = 'INSERT' or new.details is distinct from old.details then
    select * into r from avetmiss_split_street(v_street, v_line2);
    new.address_building := r.building; new.address_flat := r.flat;
    new.address_street_number := r.street_number; new.address_street_name := r.street_name;
    new.address_needs_review := r.needs_review;
  end if;
  return new;
end $$;