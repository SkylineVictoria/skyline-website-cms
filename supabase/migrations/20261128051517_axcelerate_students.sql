-- AXCELERATE-STUDENTS (owner 2026-11-28): import students from aXcelerate (one by name / email / mobile, or all students enrolled in
-- aXcelerate, optionally only those changed since the last import). One way only: aXcelerate is read by the Edge Function
-- axcelerate-import through axcelerateClient (GET, read-only allow-list); this migration only writes Skyline.
--   * An aXcelerate contact becomes a student (enrollment_students) of the direct-students business (agencies.is_direct), no agent.
--   * AVETMISS answers are stored the way the application form stores them (its option labels), and only when the value is a valid
--     AVETMISS code (avetmiss_code); anything else is left empty and listed as a warning, never stored as free text.
--   * Already linked: updated ("Student updated") or "Already up to date"; edited in Skyline since the last import: no overwrite, the
--     differences become conflicts ("Needs review: changed in both systems").
--   * Not linked, but a Skyline student has the same email, the same mobile, or the same name and date of birth: nothing is created,
--     a review is opened ("Needs review: possible duplicate"); the admin links it to that student, creates a new student, or dismisses it.
--   * Deleted in Skyline: on the skipped list, not brought back (undo in the Import centre).
begin;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Students are an import entity; edits and deletes of a student are tracked like the other imported records.
alter table public.axcelerate_links drop constraint if exists axcelerate_links_entity_check;
alter table public.axcelerate_links add constraint axcelerate_links_entity_check
  check (entity in ('location', 'course', 'unit', 'trainer', 'class', 'class_unit', 'break', 'student'));

drop trigger if exists axcelerate_link_touch on public.enrollment_students;
create trigger axcelerate_link_touch after update or delete on public.enrollment_students
  for each row execute function public.axcelerate_link_touch();

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Possible duplicates waiting for an admin.
create table if not exists public.axcelerate_reviews (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  run_id uuid references public.axcelerate_import_runs(id) on delete set null,
  entity text not null default 'student' check (entity in ('student')),
  axcelerate_id text not null check (char_length(axcelerate_id) between 1 and 120),
  label text,
  raw jsonb not null default '{}'::jsonb,
  candidates jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'linked', 'created', 'dismissed')),
  target_id text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists axcelerate_reviews_one_open on public.axcelerate_reviews(connection_id, entity, axcelerate_id) where status = 'open';
alter table public.axcelerate_reviews enable row level security;
revoke all on public.axcelerate_reviews from public, anon, authenticated;
grant select on public.axcelerate_reviews to authenticated;
drop policy if exists axcelerate_reviews_read on public.axcelerate_reviews;
create policy axcelerate_reviews_read on public.axcelerate_reviews for select to authenticated using (public.cms_has_permission('axcelerate.import'));

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. AVETMISS answers in the application form's words.
/**
 * The form's answer for an aXcelerate value: the AVETMISS code of p_value (numbers are also tried zero-padded, e.g. 1 -> 01), then the
 * first form option with that code, else the code list's label. Null when the value is not a code of p_set (never free text).
 */
create or replace function public.axcelerate_avetmiss_answer(p_set text, p_value text, p_options text[] default null) returns text
language plpgsql stable set search_path = public as $$
declare v text := nullif(btrim(coalesce(p_value, '')), ''); c text; o text;
begin
  if v is null then return null; end if;
  c := public.avetmiss_code(p_set, v);
  if c is null and v ~ '^[0-9]{1,3}$' then
    c := coalesce(public.avetmiss_code(p_set, lpad(v, 2, '0')), public.avetmiss_code(p_set, lpad(v, 3, '0')), public.avetmiss_code(p_set, lpad(v, 4, '0')));
  end if;
  if c is null then return null; end if;
  if p_options is not null then
    foreach o in array p_options loop
      if public.avetmiss_code(p_set, o) = c then return o; end if;
    end loop;
  end if;
  return coalesce((select a.label from public.avetmiss_codes a where a.code_set = p_set and a.code = c limit 1), c);
end $$;

/** Y / N (or true / false, 1 / 0) as the form's Yes / No; null otherwise. */
create or replace function public.axcelerate_yes_no(p_value text) returns text
language sql immutable as $$
  select case when lower(btrim(coalesce(p_value, ''))) in ('y', 'yes', 'true', '1') then 'Yes'
              when lower(btrim(coalesce(p_value, ''))) in ('n', 'no', 'false', '0') then 'No' end;
$$;

/**
 * The student's values from an aXcelerate contact: {columns: {...}, details: {...}, warnings: [...]}. Only keys with a value are
 * returned, so an import never blanks a field Skyline already has.
 */
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
  v_cols jsonb;
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
  -- Disability: the flag, and the types (AVETMISS disability type codes).
  v_codes := array(select btrim(c) from unnest(string_to_array(coalesce(public.axcelerate_text(r, 'DISABILITYTYPEIDS'), ''), ',')) c where btrim(c) <> '');
  x := array_to_string(array(select c from unnest(v_codes) c where public.avetmiss_is_code('disability_type', c)), ',');
  if cardinality(v_codes) > 0 and x = '' then w := w || format('Disability types "%s" are not AVETMISS codes; left empty.', array_to_string(v_codes, ',')); end if;
  v := public.axcelerate_yes_no(public.axcelerate_text(r, 'DISABILITYFLAG', 'DISABILITY'));
  if v is null and x <> '' then v := 'Yes'; end if;
  if v is not null then d := d || jsonb_build_object('disability', v); end if;
  if x <> '' then d := d || jsonb_build_object('disability_types', x); end if;
  -- Prior education: "008A,410" (code + recognition A / E / I); rows without a valid code and recognition are not stored.
  v_codes := array(select btrim(c) from unnest(string_to_array(coalesce(public.axcelerate_text(r, 'PRIOREDUCATIONIDS'), ''), ',')) c where btrim(c) <> '');
  foreach x in array v_codes loop
    if public.avetmiss_is_code('prior_education', substring(x from '^([0-9]{3})')) and public.avetmiss_is_code('prior_education_recognition', upper(substring(x from '^[0-9]{3}([AEIaei])$'))) then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('code', substring(x from '^([0-9]{3})'), 'recognition', upper(substring(x from '^[0-9]{3}([AEIaei])$'))));
    else
      w := w || format('Prior education "%s" has no valid AVETMISS code and recognition (A / E / I); not stored.', x);
    end if;
  end loop;
  v := public.axcelerate_yes_no(public.axcelerate_text(r, 'PRIOREDUCATIONFLAG', 'PRIOREDUCATIONSTATUS'));
  if v is null and cardinality(v_codes) > 0 then v := 'Yes'; end if;
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

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. The student import.
/** Skyline's current values of the fields the import manages, in the same shape as axcelerate_student_values' flat form. */
create or replace function public.axcelerate_student_current(p_student uuid, p_keys text[]) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(k, case
           when k = 'full_name' then to_jsonb(nullif(s.full_name, ''))
           when k = 'email' then to_jsonb(nullif(lower(btrim(s.email)), ''))
           when k = 'phone' then to_jsonb(public.axcelerate_phone(s.phone))
           when k = 'date_of_birth' then to_jsonb(to_char(s.date_of_birth, 'YYYY-MM-DD'))
           else s.details->substr(k, 9) end), '{}'::jsonb)
    from public.enrollment_students s, unnest(p_keys) k where s.id = p_student;
$$;

/** {"full_name":..., "details.gender":...}: the flat list of managed fields of axcelerate_student_values. */
create or replace function public.axcelerate_student_flat(p_values jsonb) returns jsonb
language sql immutable as $$
  select coalesce(p_values->'columns', '{}'::jsonb)
      || coalesce((select jsonb_object_agg('details.' || key, value) from jsonb_each(coalesce(p_values->'details', '{}'::jsonb))
                    where key not in ('email', 'confirm_email', 'mobile', 'dob')), '{}'::jsonb);
$$;

/** Writes the managed fields into a student (only fields with a value; email only while the student has no sign-in). True when something changed. */
create or replace function public.axcelerate_student_apply(p_student uuid, p_values jsonb, p_only_empty boolean default false) returns boolean
language plpgsql set search_path = public as $$
declare s public.enrollment_students; c jsonb := coalesce(p_values->'columns', '{}'::jsonb); d jsonb := coalesce(p_values->'details', '{}'::jsonb); k text;
  v_name text; v_email text; v_phone text; v_dob date; v_details jsonb;
begin
  select * into s from public.enrollment_students where id = p_student for update;
  if s.id is null then raise exception 'Student not found' using errcode = 'P0002'; end if;
  if p_only_empty then
    for k in select jsonb_object_keys(d) loop
      if nullif(btrim(coalesce(s.details->>k, '')), '') is not null then d := d - k; end if;
    end loop;
    if nullif(btrim(s.full_name), '') is not null then c := c - 'full_name'; end if;
    if nullif(btrim(coalesce(s.email, '')), '') is not null then c := c - 'email'; d := d - 'email' - 'confirm_email'; end if;
    if nullif(btrim(coalesce(s.phone, '')), '') is not null then c := c - 'phone'; d := d - 'mobile'; end if;
    if s.date_of_birth is not null then c := c - 'date_of_birth'; d := d - 'dob'; end if;
  end if;
  if s.student_profile_id is not null then c := c - 'email'; d := d - 'email' - 'confirm_email'; end if;
  -- A mobile or email already used by another student is not copied (one of each per student).
  if c ? 'phone' and exists (select 1 from public.enrollment_students x where x.id <> p_student and public.student_phone_key(x.phone) = public.student_phone_key(c->>'phone')) then
    c := c - 'phone'; d := d - 'mobile';
  end if;
  if c ? 'email' and exists (select 1 from public.enrollment_students x where x.id <> p_student and lower(btrim(x.email)) = c->>'email') then
    c := c - 'email'; d := d - 'email' - 'confirm_email';
  end if;
  v_name := coalesce(c->>'full_name', s.full_name); v_email := coalesce(c->>'email', s.email); v_phone := coalesce(c->>'phone', s.phone);
  v_dob := coalesce((c->>'date_of_birth')::date, s.date_of_birth); v_details := coalesce(s.details, '{}'::jsonb) || d;
  if v_name is not distinct from s.full_name and v_email is not distinct from s.email and v_phone is not distinct from s.phone
     and v_dob is not distinct from s.date_of_birth and v_details = coalesce(s.details, '{}'::jsonb) then
    return false;
  end if;
  update public.enrollment_students set full_name = v_name, email = v_email, phone = v_phone, date_of_birth = v_dob, details = v_details where id = p_student;
  return true;
end $$;

/**
 * One aXcelerate contact -> one student. p_target: link to this existing student (an admin's choice on a possible duplicate; only
 * empty fields are filled, other differences become conflicts). p_create: create a new student even though a possible duplicate exists.
 * Returns {action: created | updated | unchanged | duplicate | conflict | skipped, id, warnings, conflicts?, candidates?}.
 */
create or replace function public.axcelerate_import_student(p_connection uuid, p_run uuid, p_actor uuid, p_rec jsonb,
  p_target uuid default null, p_create boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ax text := public.axcelerate_text(p_rec, 'CONTACTID', 'ID');
  v_vals jsonb := public.axcelerate_student_values(p_rec);
  v_cols jsonb := v_vals->'columns'; v_det jsonb := v_vals->'details'; v_warn jsonb := v_vals->'warnings';
  v_flat jsonb := public.axcelerate_student_flat(v_vals);
  v_name text; v_raw jsonb; l public.axcelerate_links; v_old jsonb; v_id uuid; v_business uuid; v_tenant uuid; v_cands jsonb; v_n int; v_detail text; v_hint text; v_changed boolean;
begin
  if v_ax is null then raise exception 'The contact has no aXcelerate contact ID' using errcode = '22023'; end if;
  v_name := coalesce(v_cols->>'full_name', 'aXcelerate contact ' || v_ax);
  v_raw := coalesce(p_rec, '{}'::jsonb) || jsonb_build_object('NAME', v_name);
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'student', v_ax) then return public.axcelerate_outcome('skipped', null, jsonb_build_object('name', v_name)); end if;

  -- An admin linked this contact to an existing student.
  if p_target is not null then
    if not exists (select 1 from public.enrollment_students where id = p_target) then raise exception 'Student not found' using errcode = 'P0002'; end if;
    if exists (select 1 from public.axcelerate_links where connection_id = p_connection and entity = 'student' and target_id = p_target::text and axcelerate_id <> v_ax) then
      raise exception 'This student is already linked to another aXcelerate contact.' using errcode = '23505';
    end if;
    v_changed := public.axcelerate_student_apply(p_target, v_vals, true);
    v_old := public.axcelerate_student_current(p_target, array(select jsonb_object_keys(v_flat)));
    perform public.axcelerate_link_save(p_connection, p_run, 'student', v_ax, 'public.enrollment_students', p_target::text, v_raw);
    -- Differences left after filling the empty fields are Skyline's values: the admin decides them one by one.
    update public.axcelerate_links set edited_in_skyline_at = clock_timestamp(), last_imported_at = clock_timestamp() - interval '1 second'
     where connection_id = p_connection and entity = 'student' and axcelerate_id = v_ax returning * into l;
    v_n := public.axcelerate_conflicts_record(l.id, p_run, v_old, v_flat);
    return public.axcelerate_outcome(case when v_n > 0 then 'conflict' else 'updated' end, p_target::text,
      jsonb_build_object('name', v_name, 'warnings', v_warn, 'conflicts', v_n));
  end if;

  l := public.axcelerate_link_find(p_connection, 'student', v_ax);
  if l.id is not null then
    v_old := public.axcelerate_student_current(l.target_id::uuid, array(select jsonb_object_keys(v_flat)));
    if v_old = '{}'::jsonb and not exists (select 1 from public.enrollment_students where id = l.target_id::uuid) then
      delete from public.axcelerate_links where id = l.id; l := null;
    elsif l.edited_in_skyline_at is not null and l.edited_in_skyline_at > l.last_imported_at then
      v_n := public.axcelerate_conflicts_record(l.id, p_run, v_old, v_flat);
      perform public.axcelerate_link_save(p_connection, p_run, 'student', v_ax, 'public.enrollment_students', l.target_id, v_raw);
      return public.axcelerate_outcome(case when v_n > 0 then 'conflict' else 'unchanged' end, l.target_id,
        jsonb_build_object('name', v_name, 'warnings', v_warn, 'conflicts', v_n));
    else
      v_changed := public.axcelerate_student_apply(l.target_id::uuid, v_vals, false);
      perform public.axcelerate_link_save(p_connection, p_run, 'student', v_ax, 'public.enrollment_students', l.target_id, v_raw);
      return public.axcelerate_outcome(case when v_changed then 'updated' else 'unchanged' end, l.target_id, jsonb_build_object('name', v_name, 'warnings', v_warn));
    end if;
  end if;

  -- Not linked yet: a Skyline student with the same email, mobile, or name and date of birth is a possible duplicate.
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.full_name, 'email', s.email, 'phone', s.phone, 'dob', s.date_of_birth,
           'studentNumber', s.student_number, 'reasons', to_jsonb(array_remove(array[
             case when v_cols->>'email' is not null and lower(btrim(s.email)) = v_cols->>'email' then 'same email' end,
             case when v_cols->>'phone' is not null and public.student_phone_key(s.phone) = public.student_phone_key(v_cols->>'phone') then 'same mobile' end,
             case when v_cols->>'date_of_birth' is not null and s.date_of_birth = (v_cols->>'date_of_birth')::date
                       and lower(btrim(s.full_name)) = lower(btrim(concat_ws(' ', v_det->>'first_name', v_det->>'last_name'))) then 'same name and date of birth' end], null)),
           'linked', exists (select 1 from public.axcelerate_links x where x.entity = 'student' and x.target_id = s.id::text))), '[]'::jsonb)
    into v_cands
    from public.enrollment_students s
   where (v_cols->>'email' is not null and lower(btrim(s.email)) = v_cols->>'email')
      or (v_cols->>'phone' is not null and public.student_phone_key(s.phone) = public.student_phone_key(v_cols->>'phone'))
      or (v_cols->>'date_of_birth' is not null and s.date_of_birth = (v_cols->>'date_of_birth')::date
          and lower(btrim(s.full_name)) = lower(btrim(concat_ws(' ', v_det->>'first_name', v_det->>'last_name'))));
  if jsonb_array_length(v_cands) > 0 and not p_create then
    insert into public.axcelerate_reviews(connection_id, run_id, axcelerate_id, label, raw, candidates)
    values (p_connection, p_run, v_ax, left(v_name, 200), v_raw, v_cands)
    on conflict (connection_id, entity, axcelerate_id) where status = 'open'
      do update set run_id = excluded.run_id, label = excluded.label, raw = excluded.raw, candidates = excluded.candidates, updated_at = now();
    return public.axcelerate_outcome('duplicate', null, jsonb_build_object('name', v_name, 'warnings', v_warn, 'candidates', v_cands));
  end if;
  if p_create and v_cols->>'email' is not null and exists (select 1 from public.enrollment_students where lower(btrim(email)) = v_cols->>'email') then
    raise exception 'A student with the email % already exists in Skyline: link this contact to that student instead.', v_cols->>'email' using errcode = '23505';
  end if;
  if v_cols->>'phone' is not null and exists (select 1 from public.enrollment_students where public.student_phone_key(phone) = public.student_phone_key(v_cols->>'phone')) then
    v_cols := v_cols - 'phone'; v_det := v_det - 'mobile';
    v_warn := v_warn || to_jsonb('The mobile number belongs to another Skyline student; left empty.'::text);
  end if;

  select id into v_business from public.agencies where is_direct order by created_at limit 1;
  if v_business is null then raise exception 'Skyline has no direct-students business to put imported students in.' using errcode = 'P0002'; end if;
  select tenant_id into v_tenant from public.integration_connections where id = p_connection;
  begin
    insert into public.enrollment_students(agency_id, tenant_id, agent_id, full_name, email, phone, date_of_birth, details)
    values (v_business, v_tenant, null, v_name, v_cols->>'email', v_cols->>'phone', (v_cols->>'date_of_birth')::date, v_det)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    if v_hint = 'email_taken' then
      raise exception 'Not imported: %. Change the email in aXcelerate or Skyline, then import again.',
        rtrim(coalesce(nullif(v_detail, ''), (v_cols->>'email') || ' is already used by another role in Skyline'), '.') using errcode = '23505';
    end if;
    raise;
  end;
  perform public.axcelerate_link_save(p_connection, p_run, 'student', v_ax, 'public.enrollment_students', v_id::text, v_raw);
  return public.axcelerate_outcome('created', v_id::text, jsonb_build_object('name', v_name, 'warnings', v_warn));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Reviews (possible duplicates): link to a student, create a new student, or dismiss.
create or replace function public.axcelerate_review_decide(p_review uuid, p_action text, p_student uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.axcelerate_reviews; v_out jsonb;
begin
  perform public.axcelerate_require();
  select * into r from public.axcelerate_reviews where id = p_review and status = 'open' for update;
  if r.id is null then raise exception 'This review is already decided.' using errcode = '55000'; end if;
  if p_action = 'link' then
    if p_student is null or not exists (select 1 from jsonb_array_elements(r.candidates) c where c->>'id' = p_student::text) then
      raise exception 'Choose one of the students listed.' using errcode = '22023';
    end if;
    v_out := public.axcelerate_import_student(r.connection_id, r.run_id, auth.uid(), r.raw, p_student, false);
  elsif p_action = 'create' then
    v_out := public.axcelerate_import_student(r.connection_id, r.run_id, auth.uid(), r.raw, null, true);
  elsif p_action = 'dismiss' then
    v_out := public.axcelerate_outcome('dismissed', null);
  else
    raise exception 'Unknown decision.' using errcode = '22023';
  end if;
  update public.axcelerate_reviews set status = case p_action when 'link' then 'linked' when 'create' then 'created' else 'dismissed' end,
         target_id = v_out->>'id', decided_by = auth.uid(), decided_at = now(), updated_at = now() where id = r.id;
  perform public.axcelerate_audit(r.connection_id, auth.uid(), 'axcelerate_review_decided',
    jsonb_build_object('review', r.id, 'axcelerateId', r.axcelerate_id, 'decision', p_action, 'student', v_out->>'id'));
  return v_out;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Conflicts: student fields can be taken from aXcelerate too (columns, and details.<answer>). Replaces the 20261128041517 version.
create or replace function public.axcelerate_conflict_decide(p_conflict uuid, p_take_axcelerate boolean) returns void
language plpgsql security definer set search_path = public, hr as $$
declare k public.axcelerate_conflicts; l public.axcelerate_links; v_allowed text[]; v_col text;
begin
  perform public.axcelerate_require();
  select * into k from public.axcelerate_conflicts where id = p_conflict and status = 'open' for update;
  if k.id is null then raise exception 'This conflict is already decided.' using errcode = '55000'; end if;
  select * into l from public.axcelerate_links where id = k.link_id;
  if p_take_axcelerate then
    perform set_config('axcelerate.importing', 'on', true);
    perform set_config('hr.actor', auth.uid()::text, true);
    if l.target_table = 'public.enrollment_students' then
      if k.field like 'details.%' then
        update public.enrollment_students set details = coalesce(details, '{}'::jsonb) || jsonb_build_object(substr(k.field, 9), k.axcelerate_value)
         where id = l.target_id::uuid;
      elsif k.field in ('full_name', 'email', 'phone', 'date_of_birth') then
        if k.field = 'email' and exists (select 1 from public.enrollment_students where id = l.target_id::uuid and student_profile_id is not null) then
          raise exception 'This student signs in with their email: change it on the student''s page.' using errcode = '22023';
        end if;
        execute format('update public.enrollment_students set %I = (select (jsonb_populate_record(null::public.enrollment_students, jsonb_build_object(%L, $1))).%I) where id = $2',
                       k.field, k.field, k.field) using k.axcelerate_value, l.target_id::uuid;
        if k.field = 'email' then
          update public.enrollment_students set details = details || jsonb_build_object('email', k.axcelerate_value, 'confirm_email', k.axcelerate_value) where id = l.target_id::uuid;
        elsif k.field = 'phone' then
          update public.enrollment_students set details = details || jsonb_build_object('mobile', k.axcelerate_value) where id = l.target_id::uuid;
        elsif k.field = 'date_of_birth' then
          update public.enrollment_students set details = details || jsonb_build_object('dob', k.axcelerate_value) where id = l.target_id::uuid;
        end if;
      else
        raise exception 'This field cannot be taken from aXcelerate.' using errcode = '22023';
      end if;
    else
      v_allowed := case l.target_table
        when 'hr.staff_profiles' then array['first_name', 'last_name', 'email']
        when 'public.locations' then array['name', 'address', 'suburb', 'postcode', 'state_code']
        when 'public.cms_courses' then array['name']
        when 'public.course_intakes' then array['name', 'start_date', 'end_date', 'capacity', 'status']
        when 'public.academic_breaks' then array['label', 'start_date', 'end_date'] else array[]::text[] end;
      v_col := k.field;
      if not v_col = any(v_allowed) then raise exception 'This field cannot be taken from aXcelerate.' using errcode = '22023'; end if;
      execute format('update %s set %I = (select (jsonb_populate_record(null::%s, jsonb_build_object(%L, $1))).%I) where id::text = $2',
                     l.target_table, v_col, l.target_table, v_col, v_col)
        using k.axcelerate_value, l.target_id;
    end if;
  end if;
  update public.axcelerate_conflicts set status = case when p_take_axcelerate then 'take_axcelerate' else 'keep_skyline' end, decided_by = auth.uid(), decided_at = now() where id = k.id;
  perform public.axcelerate_audit(l.connection_id, auth.uid(), 'axcelerate_conflict_decided',
    jsonb_build_object('conflict', k.id, 'entity', l.entity, 'field', k.field, 'decision', case when p_take_axcelerate then 'take_axcelerate' else 'keep_skyline' end));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 7. The Import centre: open reviews too, and when students were last imported (for "only changed since the last import").
create or replace function public.axcelerate_import_overview(p_connection uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_conn uuid := coalesce(p_connection, public.axcelerate_connection_for_scope()); c record;
begin
  perform public.axcelerate_require();
  select id, status, last_success_at, credential_configured into c from public.integration_connections where id = v_conn and connector_id = 'axcelerate';
  return jsonb_build_object(
    'connection', case when c.id is null then null else jsonb_build_object('id', c.id, 'status', c.status, 'lastSuccessAt', c.last_success_at, 'saved', c.credential_configured) end,
    'runs', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('startedByName', (select coalesce(u.name, u.email) from public.cms_users u where u.auth_user_id = r.started_by limit 1),
                        'openErrors', (select count(*) from public.axcelerate_import_errors e where e.run_id = r.id and e.resolved_at is null)) order by r.started_at desc)
                      from (select * from public.axcelerate_import_runs where connection_id = v_conn order by started_at desc limit 25) r), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (select e.* from public.axcelerate_import_errors e join public.axcelerate_import_runs r on r.id = e.run_id
                         where r.connection_id = v_conn and e.resolved_at is null order by e.created_at desc limit 200) e), '[]'::jsonb),
    'conflicts', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'field', k.field, 'skyline', k.skyline_value, 'axcelerate', k.axcelerate_value, 'createdAt', k.created_at,
                         'entity', l.entity, 'axcelerateId', l.axcelerate_id, 'targetTable', l.target_table, 'targetId', l.target_id,
                         'label', coalesce(l.raw->>'NAME', l.raw->>'label', l.axcelerate_id)) order by k.created_at desc)
                         from public.axcelerate_conflicts k join public.axcelerate_links l on l.id = k.link_id where l.connection_id = v_conn and k.status = 'open'), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'entity', v.entity, 'axcelerateId', v.axcelerate_id, 'label', v.label, 'candidates', v.candidates,
                         'email', v.raw->>'EMAILADDRESS', 'mobile', v.raw->>'MOBILEPHONE', 'dob', v.raw->>'DOB', 'createdAt', v.created_at) order by v.created_at desc)
                         from public.axcelerate_reviews v where v.connection_id = v_conn and v.status = 'open'), '[]'::jsonb),
    'studentsImportedAt', (select max(r.started_at) from public.axcelerate_import_runs r where r.connection_id = v_conn and r.status = 'done'
                            and 'students' = any(r.entities) and r.cursor->>'scope' = 'all'),
    'skipped', coalesce((select jsonb_agg(to_jsonb(s) order by s.skipped_at desc) from public.axcelerate_skipped s where s.connection_id = v_conn), '[]'::jsonb),
    'linked', coalesce((select jsonb_object_agg(entity, n) from (select entity, count(*) n from public.axcelerate_links where connection_id = v_conn group by entity) x), '{}'::jsonb),
    'audit', coalesce((select jsonb_agg(jsonb_build_object('at', a.created_at, 'who', a.actor_name, 'action', a.action, 'detail', a.detail) order by a.created_at desc)
                       from (select * from public.portal_audit_log where target_type = 'axcelerate' and target_id = coalesce(v_conn::text, '') order by created_at desc limit 200) a), '[]'::jsonb),
    'permission', coalesce((select jsonb_agg(jsonb_build_object('userId', u.auth_user_id, 'name', u.name, 'email', u.email,
                         'granted', exists (select 1 from public.cms_permissions p where p.user_id = u.auth_user_id and p.permission = 'axcelerate.import')) order by u.name)
                         from public.cms_users u where u.role = 'Admin' and u.status = 'Active' and u.auth_user_id is not null), '[]'::jsonb));
end $$;

/** Which of these aXcelerate contacts are already Skyline students (the search results show "Already imported"). */
create or replace function public.axcelerate_students_linked(p_connection uuid, p_ids text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(l.axcelerate_id, l.target_id), '{}'::jsonb) from public.axcelerate_links l
   where l.connection_id = p_connection and l.entity = 'student' and l.axcelerate_id = any(p_ids);
$$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 8. Grants: the import writers are for the Edge Function (service role) only; the review decision checks the permission itself.
revoke all on function public.axcelerate_avetmiss_answer(text, text, text[]) from public, anon, authenticated;
revoke all on function public.axcelerate_yes_no(text) from public, anon, authenticated;
revoke all on function public.axcelerate_student_values(jsonb) from public, anon, authenticated;
revoke all on function public.axcelerate_student_current(uuid, text[]) from public, anon, authenticated;
revoke all on function public.axcelerate_student_flat(jsonb) from public, anon, authenticated;
revoke all on function public.axcelerate_student_apply(uuid, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.axcelerate_import_student(uuid, uuid, uuid, jsonb, uuid, boolean) from public, anon, authenticated;
revoke all on function public.axcelerate_students_linked(uuid, text[]) from public, anon, authenticated;
grant execute on function public.axcelerate_avetmiss_answer(text, text, text[]), public.axcelerate_yes_no(text), public.axcelerate_student_values(jsonb),
  public.axcelerate_student_current(uuid, text[]), public.axcelerate_student_flat(jsonb), public.axcelerate_student_apply(uuid, jsonb, boolean),
  public.axcelerate_import_student(uuid, uuid, uuid, jsonb, uuid, boolean), public.axcelerate_students_linked(uuid, text[]) to service_role;
revoke all on function public.axcelerate_review_decide(uuid, text, uuid) from public, anon;
grant execute on function public.axcelerate_review_decide(uuid, text, uuid) to authenticated, service_role;
revoke all on function public.axcelerate_conflict_decide(uuid, boolean) from public, anon;
grant execute on function public.axcelerate_conflict_decide(uuid, boolean) to authenticated, service_role;
revoke all on function public.axcelerate_import_overview(uuid) from public, anon;
grant execute on function public.axcelerate_import_overview(uuid) to authenticated, service_role;

commit;
