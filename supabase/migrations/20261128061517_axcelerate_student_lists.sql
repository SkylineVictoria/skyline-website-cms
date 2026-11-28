-- AXCELERATE-STUDENT-LISTS (owner 2026-11-28): the aXcelerate student import read list fields as text. aXcelerate sends
-- PRIOREDUCATIONIDS / DISABILITYTYPEIDS as JSON arrays (["008I"], ["11","12"]); read as text, "[\"008I\"]" gave no code,
-- avetmiss_is_code(NULL) is true by design, and the prior education row was inserted with a NULL code, failing the whole student
-- (not-null violation on student_prior_education.prior_education_code).
--   * axcelerate_list_items: a JSON array's items, or comma-separated text; each item trimmed.
--   * axcelerate_student_values: prior education items are 3 digits + A / E / I (008I = 008, I), names from PRIOREDUCATIONNAMES in the
--     same order; disability types from the array; a bad item is skipped with a warning, never failing the student.
--   * student_details_avetmiss_sync: explicit NOT NULL checks before avetmiss_is_code and before inserting into
--     student_prior_education and student_disabilities (a row without a code is skipped).
begin;

/** The items of a list field: a JSON array's elements, or comma-separated text (trimmed; empty items dropped unless p_keep_empty). */
create or replace function public.axcelerate_list_items(p jsonb, p_key text, p_keep_empty boolean default false) returns text[]
language sql immutable set search_path = public as $$
  select coalesce(array_agg(item order by n) filter (where p_keep_empty or item <> ''), '{}')
    from (
      select btrim(e.value #>> '{}') as item, e.n
        from jsonb_array_elements(case when jsonb_typeof(p->p_key) = 'array' then p->p_key else '[]'::jsonb end) with ordinality e(value, n)
      union all
      select btrim(t.value), t.n
        from unnest(case when jsonb_typeof(p->p_key) in ('string', 'number') then string_to_array(p->>p_key, ',') else '{}'::text[] end) with ordinality t(value, n)
    ) x;
$$;

create or replace function public.axcelerate_student_values(p_rec jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  r jsonb := coalesce(p_rec, '{}'::jsonb); d jsonb := '{}'::jsonb; w text[] := '{}'; v text; a text; v_codes text[]; x text; v_rows jsonb := '[]'::jsonb;
  v_first text := left(public.axcelerate_text(r, 'GIVENNAME', 'FIRSTNAME'), 100);
  v_last text := left(public.axcelerate_text(r, 'SURNAME', 'LASTNAME'), 100);
  v_middle text := left(public.axcelerate_text(r, 'MIDDLENAME'), 100);
  v_email text := lower(public.axcelerate_text(r, 'EMAILADDRESS', 'EMAIL'));
  v_phone text := public.axcelerate_phone(public.axcelerate_text(r, 'MOBILEPHONE', 'MOBILE', 'PHONE'));
  v_dob date := public.axcelerate_date(public.axcelerate_text(r, 'DOB', 'DATEOFBIRTH'));
  v_street text; v_line2 text; v_suburb text; v_state text; v_post text; v_res boolean;
  v_cols jsonb; v_items text[]; v_names text[]; v_code text; v_recog text; i int;
begin
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$') then
    w := w || format('Email "%s" is not a valid address; left empty.', v_email); v_email := null;
  end if;
  if public.axcelerate_text(r, 'MOBILEPHONE', 'MOBILE', 'PHONE') is not null and v_phone is null then
    w := w || 'The mobile number is not a valid phone number; left empty.';
  end if;
  if v_dob is not null and (v_dob > current_date or v_dob < current_date - interval '100 years') then
    w := w || format('Date of birth %s is not valid; left empty.', v_dob); v_dob := null;
  end if;
  if v_first is not null then d := d || jsonb_build_object('first_name', v_first); end if;
  if v_last is not null then d := d || jsonb_build_object('last_name', v_last); end if;
  if v_middle is not null then d := d || jsonb_build_object('middle_name', v_middle); end if;
  v := left(public.axcelerate_text(r, 'PREFERREDNAME'), 100); if v is not null then d := d || jsonb_build_object('preferred_name', v); end if;
  if v_email is not null then d := d || jsonb_build_object('email', v_email, 'confirm_email', v_email); end if;
  if v_phone is not null then d := d || jsonb_build_object('mobile', v_phone); end if;
  if v_dob is not null then d := d || jsonb_build_object('dob', to_char(v_dob, 'YYYY-MM-DD')); end if;

  -- AVETMISS answers (codes from aXcelerate; stored only when they are codes of the AVETMISS lists).
  v := public.axcelerate_text(r, 'SEX', 'GENDER');
  if v is not null then a := public.axcelerate_avetmiss_answer('sex', v, array['Male', 'Female', 'Prefer not to say']);
    if a is null then w := w || format('Sex "%s" is not an AVETMISS code; left empty.', v); else d := d || jsonb_build_object('gender', a); end if; end if;
  v := public.axcelerate_text(r, 'INDIGENOUSSTATUSID', 'INDIGENOUSSTATUS', 'ATSI');
  if v is not null then a := public.axcelerate_avetmiss_answer('indigenous_status', v, array['No', 'Yes, Aboriginal', 'Yes, Torres Strait Islander', 'Yes, Aboriginal and Torres Strait Islander']);
    if a is null then w := w || format('Indigenous status "%s" is not an AVETMISS code; left empty.', v); else d := d || jsonb_build_object('atsi', a); end if; end if;
  v := public.axcelerate_text(r, 'LABOURFORCEID', 'LABOURFORCESTATUSID', 'EMPLOYMENTSTATUSID');
  if v is not null then a := public.axcelerate_avetmiss_answer('labour_force', v, array['Full-Time Employee - 01', 'Part-Time Employee - 02',
      'Self-Employment Not Employing Others - 03', 'Self employed - employing others - 04', 'Employed - Unpaid Worker in Family Business - 05',
      'Unemployed - Seeking Full-Time Work - 06', 'Unemployed - Seeking Part-Time Work - 07', 'Not Employed - Not Seeking Employment - 08']);
    if a is null then w := w || format('Labour force status "%s" is not an AVETMISS code; left empty.', v); else d := d || jsonb_build_object('employment', a); end if; end if;
  v := public.axcelerate_text(r, 'HIGHESTSCHOOLLEVELID', 'SCHOOLLEVELID', 'HIGHESTSCHOOLLEVEL');
  if v is not null then a := public.axcelerate_avetmiss_answer('school_level', v, array['Year 12 or equivalent - 12', 'Year 11 or equivalent - 11',
      'Year 10 or equivalent - 10', 'Year 9 or equivalent - 09', 'Year 8 or below - 08', 'Never attended school - 02']);
    if a is null then w := w || format('Highest school level "%s" is not an AVETMISS code; left empty.', v); else d := d || jsonb_build_object('school_level', a); end if; end if;
  v := public.axcelerate_text(r, 'HIGHESTSCHOOLLEVELYEAR', 'YEARHIGHESTSCHOOLLEVELCOMPLETED', 'SCHOOLLEVELYEAR');
  if v is not null then
    if v ~ '^[0-9]{4}$' and v::int between 1920 and extract(year from current_date)::int then d := d || jsonb_build_object('year_completed', v);
    else w := w || format('Year school completed "%s" is not a 4-digit year; left empty.', v); end if;
  end if;
  v := public.axcelerate_text(r, 'ATSCHOOLFLAG', 'STILLATSCHOOL');
  if v is not null then a := public.axcelerate_yes_no(v);
    if a is null then w := w || format('Still at school "%s" is not Y or N; left empty.', v); else d := d || jsonb_build_object('secondary_enrolled', a); end if; end if;
  v := public.axcelerate_text(r, 'COUNTRYOFBIRTHID', 'COUNTRYOFBIRTH', 'BIRTHCOUNTRYID');
  if v is not null then a := public.axcelerate_avetmiss_answer('country', v);
    if a is null then w := w || format('Country of birth "%s" is not an AVETMISS (SACC) code; left empty.', v); else d := d || jsonb_build_object('birth_country', a); end if; end if;
  v := public.axcelerate_text(r, 'MAINLANGUAGEID', 'LANGUAGEID', 'HOMELANGUAGEID');
  if v is not null then a := public.avetmiss_code('language', v);
    if a is null and v ~ '^[0-9]{1,3}$' then a := public.avetmiss_code('language', lpad(v, 4, '0')); end if;
    if a is null then w := w || format('Language "%s" is not an AVETMISS (ASCL) code; left empty.', v);
    elsif a = '1201' then d := d || jsonb_build_object('language_home', 'No, English only - 1201');
    else d := d || jsonb_build_object('language_home', 'Yes, language other than English', 'language_other', public.axcelerate_avetmiss_answer('language', a)); end if;
  end if;
  v := public.axcelerate_text(r, 'SPOKENENGLISHPROFICIENCYID', 'ENGLISHPROFICIENCYID', 'ENGLISHPROFICIENCY');
  if v is not null then
    if public.avetmiss_is_code('english_proficiency', v) then d := d || jsonb_build_object('english_proficiency_code', v);
    else w := w || format('English proficiency "%s" is not an AVETMISS code; left empty.', v); end if;
  end if;
  -- Disability: the flag, and the types (AVETMISS disability type codes). aXcelerate sends a JSON array (["11","12"]) or, in older
  -- records, comma-separated text; each item is checked on its own and a bad item is skipped with a warning.
  v_codes := '{}';
  foreach x in array public.axcelerate_list_items(r, 'DISABILITYTYPEIDS') loop
    if x ~ '^[0-9]{1,2}$' and public.avetmiss_code('disability_type', lpad(x, 2, '0')) is not null then
      v_codes := v_codes || public.avetmiss_code('disability_type', lpad(x, 2, '0'));
    else
      w := w || format('Disability type "%s" is not an AVETMISS code; skipped.', x);
    end if;
  end loop;
  x := array_to_string(array(select distinct c from unnest(v_codes) c order by c), ',');
  v := public.axcelerate_yes_no(public.axcelerate_text(r, 'DISABILITYFLAG', 'DISABILITY'));
  if v is null and x <> '' then v := 'Yes'; end if;
  if v is not null then d := d || jsonb_build_object('disability', v); end if;
  if x <> '' then d := d || jsonb_build_object('disability_types', x); end if;
  -- Prior education: each item is 3 digits plus the recognition letter A / E / I ("008I" = code 008, recognition I), from a JSON array
  -- or comma-separated text; PRIOREDUCATIONNAMES (same order) gives the qualification's name. A bad item is skipped with a warning.
  v_items := public.axcelerate_list_items(r, 'PRIOREDUCATIONIDS');
  v_names := public.axcelerate_list_items(r, 'PRIOREDUCATIONNAMES', true);
  for i in 1 .. coalesce(array_length(v_items, 1), 0) loop
    x := upper(v_items[i]);
    v_code := substring(x from '^([0-9]{3})[AEI]$');
    v_recog := substring(x from '^[0-9]{3}([AEI])$');
    if v_code is not null and v_recog is not null
       and public.avetmiss_is_code('prior_education', v_code) and public.avetmiss_is_code('prior_education_recognition', v_recog) then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('code', v_code, 'recognition', v_recog,
        'name', left(nullif(btrim(coalesce(v_names[i], '')), ''), 200))));
    else
      w := w || format('Prior education "%s" is not an AVETMISS code with a recognition letter (A / E / I), e.g. 008I; skipped.', v_items[i]);
    end if;
  end loop;
  v := public.axcelerate_yes_no(public.axcelerate_text(r, 'PRIOREDUCATIONFLAG', 'PRIOREDUCATIONSTATUS'));
  if v is null and jsonb_array_length(v_rows) > 0 then v := 'Yes'; end if;
  if v is not null then d := d || jsonb_build_object('prior_ed', v); end if;
  if jsonb_array_length(v_rows) > 0 then d := d || jsonb_build_object('prior_education', v_rows); end if;
  -- USI (format only; Skyline never asks aXcelerate or the USI registry from here).
  v := upper(public.axcelerate_text(r, 'USI'));
  if v is not null then
    if v ~ '^[A-HJ-NP-Z2-9]{10}$' then d := d || jsonb_build_object('usi', v); else w := w || format('USI "%s" is not in the USI format; left empty.', v); end if;
  end if;
  -- Address: the residential one (S...) first, else the postal one; Australian addresses only (state and postcode checked).
  v_res := public.axcelerate_text(r, 'SADDRESS1', 'SSTREETNAME', 'SCITY') is not null;
  if v_res then
    v_street := coalesce(nullif(btrim(concat_ws(' ', public.axcelerate_text(r, 'SUNITNO'), public.axcelerate_text(r, 'SSTREETNO'), public.axcelerate_text(r, 'SSTREETNAME'))), ''), public.axcelerate_text(r, 'SADDRESS1'));
    v_line2 := public.axcelerate_text(r, 'SADDRESS2'); v_suburb := public.axcelerate_text(r, 'SCITY');
    v_state := upper(public.axcelerate_text(r, 'SSTATE')); v_post := public.axcelerate_text(r, 'SPOSTCODE');
  else
    v_street := coalesce(nullif(btrim(concat_ws(' ', public.axcelerate_text(r, 'UNITNO'), public.axcelerate_text(r, 'STREETNO'), public.axcelerate_text(r, 'STREETNAME'))), ''), public.axcelerate_text(r, 'ADDRESS1'));
    v_line2 := public.axcelerate_text(r, 'ADDRESS2'); v_suburb := public.axcelerate_text(r, 'CITY');
    v_state := upper(public.axcelerate_text(r, 'STATE')); v_post := public.axcelerate_text(r, 'POSTCODE');
  end if;
  if v_street is not null or v_suburb is not null then
    if v_state is not null and public.avetmiss_code('state', v_state) is not null and (v_post is null or v_post ~ '^[0-9]{4}$') then
      d := d || jsonb_strip_nulls(jsonb_build_object('address_type', 'Australian Address', 'au_street', left(v_street, 200), 'au_line2', left(v_line2, 200),
                 'au_suburb', left(v_suburb, 100), 'au_state', v_state, 'au_zip', v_post));
    else
      w := w || format('The address (%s) is not a complete Australian address (state, 4-digit postcode); not stored.', concat_ws(', ', v_street, v_suburb, v_state, v_post));
    end if;
  end if;

  v_cols := jsonb_strip_nulls(jsonb_build_object(
    'full_name', nullif(btrim(concat_ws(' ', v_first, v_middle, v_last)), ''),
    'email', v_email, 'phone', v_phone, 'date_of_birth', to_char(v_dob, 'YYYY-MM-DD')));
  return jsonb_build_object('columns', v_cols, 'details', d, 'warnings', to_jsonb(w));
end $$;

create or replace function public.student_details_avetmiss_sync()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v jsonb := coalesce(new.details, '{}'::jsonb);
  o jsonb := case when tg_op = 'UPDATE' then coalesce(old.details, '{}'::jsonb) else '{}'::jsonb end;
  v_text text; v_rows jsonb; r jsonb;
begin
  v_text := btrim(coalesce(v->>'english_proficiency_code', ''));
  if v_text is distinct from btrim(coalesce(o->>'english_proficiency_code', '')) and v_text <> '' and avetmiss_is_code('english_proficiency', v_text) then
    update enrollment_students set english_proficiency_code = v_text where id = new.id and english_proficiency_code is distinct from v_text;
  end if;
  v_text := btrim(coalesce(v->>'year_completed', ''));
  if v_text is distinct from btrim(coalesce(o->>'year_completed', '')) and v_text ~ '^[0-9]{4}$'
     and v_text::int between 1900 and extract(year from current_date)::int then
    update enrollment_students set school_level_year = v_text where id = new.id and school_level_year is distinct from v_text;
  end if;
  -- avetmiss_is_code is true for NULL (an empty answer is allowed), so the code and the recognition are checked for NULL first:
  -- a row without them is skipped, never inserted (AXCELERATE-STUDENT-LISTS).
  if (v->'prior_education') is distinct from (o->'prior_education') and nullif(btrim(coalesce(v->>'prior_education', '')), '') is not null then
    begin
      v_rows := case jsonb_typeof(v->'prior_education') when 'array' then v->'prior_education' else (v->>'prior_education')::jsonb end;
    exception when others then v_rows := null; end;
    if jsonb_typeof(v_rows) = 'array' and exists (select 1 from jsonb_array_elements(v_rows) x
         where jsonb_typeof(x) = 'object' and nullif(btrim(x->>'code'), '') is not null and nullif(btrim(x->>'recognition'), '') is not null
           and avetmiss_is_code('prior_education', btrim(x->>'code')) and avetmiss_is_code('prior_education_recognition', btrim(x->>'recognition'))) then
      delete from student_prior_education where student_id = new.id;
      for r in select * from jsonb_array_elements(v_rows) loop
        if jsonb_typeof(r) = 'object' and nullif(btrim(r->>'code'), '') is not null and nullif(btrim(r->>'recognition'), '') is not null
           and avetmiss_is_code('prior_education', btrim(r->>'code')) and avetmiss_is_code('prior_education_recognition', btrim(r->>'recognition')) then
          insert into student_prior_education(student_id, prior_education_code, recognition_code, qualification_name)
          values (new.id, btrim(r->>'code'), btrim(r->>'recognition'), left(nullif(btrim(coalesce(r->>'name', '')), ''), 200))
          on conflict do nothing;
        end if;
      end loop;
    end if;
  end if;
  if (v->>'disability_types') is distinct from (o->>'disability_types') and nullif(btrim(coalesce(v->>'disability_types', '')), '') is not null then
    if exists (select 1 from unnest(string_to_array(v->>'disability_types', ',')) c
                where nullif(btrim(c), '') is not null and avetmiss_is_code('disability_type', btrim(c))) then
      delete from student_disabilities where student_id = new.id;
      insert into student_disabilities(student_id, disability_type_code)
      select distinct new.id, btrim(c) from unnest(string_to_array(v->>'disability_types', ',')) c
       where nullif(btrim(c), '') is not null and avetmiss_is_code('disability_type', btrim(c))
      on conflict do nothing;
    end if;
  end if;
  return null;
end $function$;

revoke all on function public.axcelerate_list_items(jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.axcelerate_list_items(jsonb, text, boolean) to service_role;

commit;
