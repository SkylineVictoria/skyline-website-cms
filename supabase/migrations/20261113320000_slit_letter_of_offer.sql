-- The real SLIT Letter of Offer (owner brief 2026-11-12, follow-up). LOCAL until released.
--  * Institute details: the Website settings (public.cms_settings: Settings and Contact Information in the CMS) are the one source of
--    every {{institute.*}} variable ("Fill and save to source" writes there). Empty fields are prefilled from the legacy SLIT letter;
--    + legal_name (the line in the footer).
--  * Course name without its code ({{course.name}} printed "MSF30422 MSF30422 ..."), {{course.code_and_name}}; location defaults to the
--    head office address; orientation day and hours per week in the fee setup; emergency contact; first start / last end across courses.
--  * Packaged offers: {{#each courses}} ... {{/each}} repeats per course of the application (course and fee variables of that course);
--    {{#if multiple_courses}} ... {{/if}} only for more than one course; {{fees.combined_total}}; the deposit once (first course).
--  * CC: the agent (or, without an agent email, the agency's main email) gets a copy of the offer letter, its resend and the CoE / VoE;
--    the copies are recorded in the status history.
--  * Templates: the real "SLIT Letter of Offer and Written Agreement" (from the aXcelerate letter, every placeholder mapped) becomes the
--    active default; the starter "Standard Letter of Offer" gets the standard letterhead and footer and stays as an inactive example.

/* ------------------------------------------------------------------ Website settings: the institute details */
alter table public.cms_settings add column if not exists legal_name text;
do $$ begin
  alter table public.cms_settings add constraint cms_settings_legal_name_check check (legal_name is null or char_length(legal_name) <= 200);
exception when duplicate_object then null; end $$;
-- Only what is empty, on the main site's settings (a tenant keeps its own).
update public.cms_settings set
  address = coalesce(nullif(btrim(address), ''), 'Level 8, 310 King Street, Melbourne VIC 3000'),
  phone = coalesce(nullif(btrim(phone), ''), '+61 3 9125 1661'),
  email = coalesce(nullif(btrim(email), ''), 'info@slit.edu.au'),
  admissions_email = coalesce(nullif(btrim(admissions_email), ''), 'admission@slit.edu.au'),
  website = coalesce(nullif(btrim(website), ''), 'https://slit.edu.au/'),
  rto = coalesce(nullif(btrim(rto), ''), '45989'),
  cricos = coalesce(nullif(btrim(cricos), ''), '04114B'),
  abn = coalesce(nullif(btrim(abn), ''), '20 643 760 721'),
  legal_name = coalesce(nullif(btrim(legal_name), ''), 'INDOPACIFIC GLOBAL PTY LTD T/A Skyline Institute of Technology (SLIT)')
where tenant_id is null;

/* ------------------------------------------------------------------ fee setup: orientation day, hours per week */
alter table public.course_fee_setups
  add column if not exists orientation text check (orientation is null or char_length(orientation) <= 200),
  add column if not exists hours_per_week text check (hours_per_week is null or char_length(hours_per_week) <= 20);

create or replace function public.cms_course_fees(p_course text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'intakeId', f.intake_id, 'tuition', f.tuition_fee, 'enrolment', f.enrolment_fee, 'material', f.material_fee,
   'oshc', f.oshc_fee, 'deposit', f.deposit, 'paymentPlan', f.payment_plan, 'campus', f.campus, 'orientation', f.orientation, 'hoursPerWeek', f.hours_per_week, 'updatedAt', f.updated_at)
   order by f.intake_id nulls first) from public.course_fee_setups f where f.course_id = p_course), '[]'::jsonb);
end $$;

create or replace function public.cms_course_fee_save(p_course text, p_intake uuid, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.cms_courses; f public.course_fee_setups;
 num constant text := '^\s*[0-9]{1,9}(\.[0-9]{1,2})?\s*$';
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 select * into c from public.cms_courses where id = p_course;
 if not found then raise exception 'Course not found' using errcode = '22023'; end if;
 if p_intake is not null and not exists (select 1 from public.course_intakes i where i.id = p_intake and i.course_id = p_course) then raise exception 'The intake is not one of this course''s' using errcode = '22023'; end if;
 if exists (select 1 from jsonb_each_text(coalesce(p_data, '{}'::jsonb) - 'paymentPlan' - 'campus' - 'orientation' - 'hoursPerWeek') e where nullif(btrim(e.value), '') is not null and e.value !~ num) then
  raise exception 'Enter fees as amounts, for example 14500 or 14500.00' using errcode = '22023';
 end if;
 insert into public.course_fee_setups as x(tenant_id, course_id, intake_id, tuition_fee, enrolment_fee, material_fee, oshc_fee, deposit, payment_plan, campus, orientation, hours_per_week, updated_by)
 values (c.tenant_id, p_course, p_intake, nullif(btrim(p_data->>'tuition'), '')::numeric, nullif(btrim(p_data->>'enrolment'), '')::numeric, nullif(btrim(p_data->>'material'), '')::numeric,
   nullif(btrim(p_data->>'oshc'), '')::numeric, nullif(btrim(p_data->>'deposit'), '')::numeric, nullif(btrim(p_data->>'paymentPlan'), ''), nullif(btrim(p_data->>'campus'), ''),
   nullif(btrim(p_data->>'orientation'), ''), nullif(btrim(p_data->>'hoursPerWeek'), ''), auth.uid())
 on conflict (course_id, intake_id) do update set tuition_fee = excluded.tuition_fee, enrolment_fee = excluded.enrolment_fee, material_fee = excluded.material_fee,
   oshc_fee = excluded.oshc_fee, deposit = excluded.deposit, payment_plan = excluded.payment_plan, campus = excluded.campus, orientation = excluded.orientation,
   hours_per_week = excluded.hours_per_week, updated_at = now(), updated_by = auth.uid()
 returning * into f;
 return to_jsonb(f);
end $$;

/* ------------------------------------------------------------------ registry additions */
insert into public.letter_variables(key, grp, label, description, source_kind, source_ref, source_label, format, input_type, required, editable_source, aliases, sample, sort) values
 ('institute.legal_name', 'Institute', 'Legal name', 'The registered business name (footer)', 'institute', 'legal_name', 'Website settings › Legal name', 'text', 'text', false, true,
  '{legal name,registered name,trading name}', 'INDOPACIFIC GLOBAL PTY LTD T/A Skyline Institute of Technology (SLIT)', 602),
 ('course.code_and_name', 'Course', 'Course code and name', 'The code, then the name without the code repeated', 'computed', 'code,name', 'Course setup › Code + Name', 'text', 'text', true, false,
  '{qualification code and name,course code and name}', 'BSB50120 Diploma of Business', 205),
 ('course.orientation', 'Course', 'Orientation day', 'From the fee setup of the course or intake', 'fee', 'orientation', 'Course setup › Fees › Orientation day', 'text', 'text', false, true,
  '{orientation,orientation day,orientation date}', '02/02/2027, 9:30 am', 285),
 ('course.hours_per_week', 'Course', 'Hours per week', 'From the fee setup of the course or intake', 'fee', 'hours_per_week', 'Course setup › Fees › Hours per week', 'text', 'text', false, true,
  '{hours per week,hrs/week,hours}', '20', 286),
 ('student.emergency_contact_name', 'Student', 'Emergency contact', '', 'application', 'ec_name', 'Application form › Emergency contact name', 'name', 'text', false, true,
  '{emergency contact,emergency contact name}', 'Ravi Patel', 152),
 ('student.emergency_contact_phone', 'Student', 'Emergency contact number', '', 'application', 'ec_phone', 'Application form › Emergency contact phone', 'text', 'tel', false, true,
  '{emergency contact number,emergency contact phone}', '+61 412 000 000', 153),
 ('offer.first_start_date', 'Application', 'First start date', 'The earliest start date of the courses on the application', 'computed', 'start_date', 'Course setup › Intakes (earliest)', 'date', 'date', false, false,
  '{first commencement date,first start date}', '03/02/2027', 535),
 ('offer.last_end_date', 'Application', 'Last end date', 'The latest end date of the courses on the application', 'computed', 'end_date', 'Course setup › Intakes (latest)', 'date', 'date', false, false,
  '{last expected completion date,last end date}', '02/02/2029', 536),
 ('fees.combined_total', 'Fees', 'Combined total', 'Total fees of every course on the application (packaged offers)', 'computed', 'total', 'Course setup › Fees (all courses)', 'money', 'money', false, false,
  '{combined total,package total}', 'AUD$30,800.00', 345)
on conflict (key) do update set grp = excluded.grp, label = excluded.label, description = excluded.description, source_kind = excluded.source_kind, source_ref = excluded.source_ref,
  source_label = excluded.source_label, format = excluded.format, input_type = excluded.input_type, required = excluded.required, editable_source = excluded.editable_source,
  aliases = excluded.aliases, sample = excluded.sample, sort = excluded.sort;
update public.letter_variables set source_label = replace(source_label, 'Settings ›', 'Website settings ›') where key like 'institute.%' and source_label like 'Settings ›%';
update public.letter_variables set description = 'The course name without its code' where key = 'course.name';
update public.letter_variables set description = 'From the fee setup; without one the head office address (Website settings)', source_label = 'Course setup › Fees › Campus (else Website settings › Address)'
 where key = 'course.campus';

/* ------------------------------------------------------------------ the values: one course */
/**
 * The course and fee variables of one course row of an application: { key: { value, raw, source, missing } }. The course by id, slug or
 * code (20261113290000); the name without a leading code; the intake (else the application's preferred intake); fees of the intake over
 * the course's; location from the fee setup, else the head office address.
 */
create or replace function public.application_letter_course(p_ac public.enrollment_application_courses, p_fmt text, p_settings public.cms_settings, p_intake_text text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.cms_courses; i public.course_intakes; fc public.course_fee_setups; fi public.course_fee_setups; r public.letter_variables; v_out jsonb := '{}'::jsonb;
 raw text; val text; src text; fee_src text; v_code text; v_name text; tuition numeric; enrol numeric; mat numeric; oshc numeric;
begin
 if p_ac.course_id is not null then
  select * into c from public.cms_courses x where x.id = public.letter_course_id(p_ac.course_id, p_ac.course_code);
  select * into i from public.course_intakes x where x.id = p_ac.intake_id;
  if c.id is not null then
   select * into fc from public.course_fee_setups x where x.course_id = c.id and x.intake_id is null;
   if p_ac.intake_id is not null then select * into fi from public.course_fee_setups x where x.course_id = c.id and x.intake_id = p_ac.intake_id; end if;
  end if;
 end if;
 fee_src := case when fi.id is not null then 'for intake ' || coalesce(nullif(i.label, ''), to_char(i.start_date, 'DD/MM/YYYY')) else 'for every intake' end;
 v_code := coalesce(nullif(btrim(c.code), ''), nullif(btrim(p_ac.course_code), ''), '');
 v_name := coalesce(nullif(btrim(c.name), ''), nullif(btrim(p_ac.course_title), ''), '');
 if v_code <> '' and upper(v_name) like upper(v_code) || '%' then v_name := btrim(regexp_replace(substr(v_name, char_length(v_code) + 1), '^[\s:–—-]+', '')); end if;
 tuition := coalesce(fi.tuition_fee, fc.tuition_fee); enrol := coalesce(fi.enrolment_fee, fc.enrolment_fee); mat := coalesce(fi.material_fee, fc.material_fee); oshc := coalesce(fi.oshc_fee, fc.oshc_fee);
 for r in select * from public.letter_variables x where x.key like 'course.%' or (x.key like 'fees.%' and x.key <> 'fees.combined_total') order by x.sort loop
  raw := ''; src := r.source_label;
  case r.key
   when 'course.name' then raw := v_name;
   when 'course.code' then raw := v_code;
   when 'course.code_and_name' then raw := btrim(concat_ws(' ', nullif(v_code, ''), nullif(v_name, '')));
   when 'course.cricos' then raw := coalesce(btrim(c.cricos), '');
   when 'course.duration' then raw := coalesce(btrim(c.duration), '');
   when 'course.mode' then raw := coalesce(btrim(c.mode), '');
   when 'course.intake' then
    raw := coalesce(nullif(btrim(i.label), ''), to_char(i.start_date, 'FMMonth YYYY'), '');
    if raw = '' then raw := coalesce(btrim(p_intake_text), ''); src := 'Application form › Preferred intake (no intake chosen)'; end if;
   when 'course.start_date' then raw := coalesce(i.start_date::text, '');
   when 'course.end_date' then raw := coalesce(i.end_date::text, '');
   when 'course.campus' then
    raw := coalesce(nullif(btrim(coalesce(fi.campus, fc.campus)), ''), '');
    if raw = '' then raw := coalesce(btrim(p_settings.address), ''); src := 'Website settings › Address (no campus in the fee setup)'; else src := r.source_label || ' (' || fee_src || ')'; end if;
   when 'course.orientation' then raw := coalesce(btrim(coalesce(fi.orientation, fc.orientation)), ''); src := r.source_label || ' (' || fee_src || ')';
   when 'course.hours_per_week' then raw := coalesce(btrim(coalesce(fi.hours_per_week, fc.hours_per_week)), ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.tuition' then raw := coalesce(tuition::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.enrolment' then raw := coalesce(enrol::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.material' then raw := coalesce(mat::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.oshc' then raw := coalesce(oshc::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.deposit' then raw := coalesce(coalesce(fi.deposit, fc.deposit)::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.payment_plan' then raw := coalesce(coalesce(fi.payment_plan, fc.payment_plan), ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.total' then
    raw := case when tuition is null then '' else (tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0))::text end;
    src := 'Course setup › Fees (sum, ' || fee_src || ')';
   else raw := '';
  end case;
  val := case r.format when 'date' then public.letter_format_date(raw, p_fmt) when 'money' then case when raw ~ '^-?[0-9]+(\.[0-9]+)?$' then public.letter_format_money(raw::numeric) else raw end else raw end;
  v_out := v_out || jsonb_build_object(r.key, jsonb_build_object('value', coalesce(val, ''), 'raw', coalesce(raw, ''), 'source', src, 'missing', coalesce(btrim(val), '') = ''));
 end loop;
 return v_out || jsonb_build_object('_courseId', c.id, '_intakeId', p_ac.intake_id, '_feeSetup', coalesce(fi.id, fc.id), '_title', coalesce(nullif(v_name, ''), p_ac.course_title),
   '_start', i.start_date, '_end', i.end_date, '_total', case when tuition is null then null else tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0) end);
end $$;
revoke all on function public.application_letter_course(public.enrollment_application_courses, text, public.cms_settings, text) from public, anon, authenticated;

/* ------------------------------------------------------------------ the values: the application */
/**
 * Every registry variable of an application ({ key: { value, raw, source, missing } }, course and fee variables from its first course),
 * plus `courses`: the course and fee variables of each of its courses in order (for {{#each courses}}), and the context.
 */
create or replace function public.application_letter_values(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a public.enrollment_applications; v jsonb; st public.cms_settings; ac public.enrollment_application_courses; ag public.portal_profiles; agy public.agencies;
 fmt text; today date := (now() at time zone 'Australia/Melbourne')::date; v_out jsonb := '{}'::jsonb; r public.letter_variables; raw text; val text; src text;
 v_courses jsonb := '[]'::jsonb; v_first jsonb := '{}'::jsonb; v_one jsonb; v_min date; v_max date; v_sum numeric := 0; v_sum_ok boolean := true; v_intake_text text;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return null; end if;
 v := coalesce(public.application_values(a.id), '{}'::jsonb);
 select * into st from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id order by s.id limit 1;
 if not found then select * into st from public.cms_settings s order by s.id limit 1; end if;
 fmt := coalesce(st.letter_date_format, 'DD/MM/YYYY');
 v_intake_text := coalesce(nullif(btrim(a.intake), ''), btrim(coalesce(v ->> 'preferred_intake', '')));
 for ac in select * from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id loop
  v_one := public.application_letter_course(ac, fmt, st, v_intake_text);
  v_courses := v_courses || jsonb_build_array(v_one);
  if (v_one ->> '_start') is not null then v_min := least(coalesce(v_min, (v_one ->> '_start')::date), (v_one ->> '_start')::date); end if;
  if (v_one ->> '_end') is not null then v_max := greatest(coalesce(v_max, (v_one ->> '_end')::date), (v_one ->> '_end')::date); end if;
  if (v_one ->> '_total') is null then v_sum_ok := false; else v_sum := v_sum + (v_one ->> '_total')::numeric; end if;
 end loop;
 if jsonb_array_length(v_courses) = 0 then ac := null; v_first := public.application_letter_course(ac, fmt, st, v_intake_text); v_sum_ok := false;
 else v_first := v_courses -> 0; end if;
 select * into ag from public.portal_profiles x where x.id = a.assigned_agent_id;
 if not found and a.created_by is not null and exists (select 1 from public.agency_memberships m where m.user_id = a.created_by and m.role in ('agent', 'agency_admin')) then
  select * into ag from public.portal_profiles x where x.id = a.created_by;
 end if;
 select * into agy from public.agencies x where x.id = a.agency_id and not coalesce(x.is_direct, false);

 for r in select * from public.letter_variables order by sort loop
  if v_first ? r.key then v_out := v_out || jsonb_build_object(r.key, v_first -> r.key); continue; end if;
  raw := ''; src := r.source_label;
  case r.source_kind
   when 'application' then
    raw := btrim(coalesce(case when jsonb_typeof(v -> r.source_ref) = 'array' then (select string_agg(x, ', ') from jsonb_array_elements_text(v -> r.source_ref) x) else v ->> r.source_ref end, ''));
    if r.key = 'student.email' and raw = '' then raw := lower(btrim(coalesce(a.student_email, ''))); src := 'Application › Student email'; end if;
    if r.key = 'student.nationality' and raw = '' then raw := btrim(coalesce(v ->> 'citizenship', '')); src := 'Application form › Citizenship'; end if;
   when 'record' then
    raw := case r.source_ref when 'reference' then coalesce(a.reference, '') when 'submitted_at' then coalesce(to_char(a.submitted_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD'), '') else '' end;
   when 'computed' then
    if r.key = 'student.full_name' then
     raw := btrim(regexp_replace(concat_ws(' ', nullif(public.letter_format_name(v ->> 'title'), ''), nullif(public.letter_format_name(v ->> 'first_name'), ''), nullif(public.letter_format_name(v ->> 'middle_name'), ''),
       nullif(public.letter_format_name(v ->> 'last_name'), '')), '\s+', ' ', 'g'));
     if coalesce(nullif(btrim(v ->> 'first_name'), ''), nullif(btrim(v ->> 'last_name'), '')) is null then raw := ''; end if;
    elsif r.key = 'student.address' then
     raw := concat_ws(', ', nullif(btrim(v ->> 'au_street'), ''), nullif(btrim(v ->> 'au_line2'), ''),
       nullif(btrim(concat_ws(' ', nullif(btrim(v ->> 'au_suburb'), ''), nullif(btrim(v ->> 'au_state'), ''), nullif(btrim(v ->> 'au_zip'), ''))), ''));
    elsif r.key = 'offer.date' then raw := today::text;
    elsif r.key = 'offer.expiry_date' then raw := (today + coalesce(st.offer_validity_days, 30))::text; src := 'Today + ' || coalesce(st.offer_validity_days, 30) || ' days (Website settings › Offer validity)';
    elsif r.key = 'offer.first_start_date' then raw := coalesce(v_min::text, '');
    elsif r.key = 'offer.last_end_date' then raw := coalesce(v_max::text, '');
    elsif r.key = 'fees.combined_total' then raw := case when v_sum_ok then v_sum::text else '' end;
    end if;
   when 'agent' then raw := coalesce(btrim(case r.source_ref when 'full_name' then ag.full_name when 'email' then ag.email when 'phone' then ag.phone end), '');
   when 'agency' then raw := coalesce(btrim(case r.source_ref when 'name' then agy.name when 'business_email' then agy.business_email when 'phone' then agy.phone when 'address' then agy.address end), '');
   when 'institute' then raw := coalesce(btrim(to_jsonb(st) ->> r.source_ref), '');
   when 'entered' then raw := 'Nil';
   else raw := '';
  end case;
  val := case r.format
   when 'date' then public.letter_format_date(raw, fmt)
   when 'name' then case when r.key = 'student.full_name' then raw else public.letter_format_name(raw) end
   when 'money' then case when raw ~ '^-?[0-9]+(\.[0-9]+)?$' then public.letter_format_money(raw::numeric) else raw end
   else raw end;
  v_out := v_out || jsonb_build_object(r.key, jsonb_build_object('value', coalesce(val, ''), 'raw', coalesce(raw, ''), 'source', src,
    'missing', r.source_kind not in ('render', 'entered') and coalesce(btrim(val), '') = ''));
 end loop;
 return jsonb_build_object('values', v_out,
   'courses', coalesce((select jsonb_agg(c - '_courseId' - '_intakeId' - '_feeSetup' - '_title' - '_start' - '_end' - '_total' order by n) from jsonb_array_elements(v_courses) with ordinality as t(c, n)), '[]'::jsonb),
   'context', jsonb_build_object('courseId', v_first ->> '_courseId', 'intakeId', v_first ->> '_intakeId', 'feeSetup', v_first ->> '_feeSetup', 'courseTitle', v_first ->> '_title',
     'dateFormat', fmt, 'courseCount', jsonb_array_length(v_courses)));
end $$;
revoke all on function public.application_letter_values(uuid) from public, anon, authenticated;

/* ------------------------------------------------------------------ save to source: the new fields */
create or replace function public.portal_letter_save_to_source(p_application uuid, p_key text, p_value text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.letter_variables; a public.enrollment_applications; ac public.enrollment_application_courses; v text := btrim(coalesce(p_value, '')); v_fee jsonb;
 v_row public.course_fee_setups; v_course text; v_field text;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 select * into r from public.letter_variables where key = split_part(p_key, '#', 1);
 if not found then raise exception 'Unknown variable %', p_key using errcode = '22023'; end if;
 if not r.editable_source then raise exception '% cannot be saved to its source from here; change it in %', r.label, r.source_label using errcode = '42501'; end if;
 if v = '' then raise exception 'Enter a value for %', r.label using errcode = '22023'; end if;
 if char_length(v) > 2000 then raise exception '% is too long', r.label using errcode = '22023'; end if;
 if r.input_type = 'date' then
  if v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter % as a date', r.label using errcode = '22023'; end if;
  perform v::date;
 end if;
 if r.input_type = 'money' then
  v := regexp_replace(v, '^(AUD)?\$?\s*|,', '', 'g');
  if v !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then raise exception 'Enter % as an amount, for example 14500.00', r.label using errcode = '22023'; end if;
 end if;
 if r.source_kind = 'application' then
  if not public.application_student_active(a.id) then raise exception 'This student is disabled, so their applications are locked' using errcode = '42501'; end if;
  update public.enrollment_applications set data = jsonb_set(coalesce(data, '{}'::jsonb), array['values', r.source_ref], to_jsonb(v), true) where id = a.id;
  update public.enrollment_students s set details = jsonb_set(coalesce(s.details, '{}'::jsonb), array[r.source_ref], to_jsonb(v), true)
   where s.id = a.student_id and coalesce(s.details, '{}'::jsonb) ? r.source_ref;
 else
  if not public.cms_is_admin() then raise exception 'Only an administrator can change % in %', r.label, r.source_label using errcode = '42501'; end if;
  -- A course variable of the n-th course (key#n, packaged offers) saves to that course's setup.
  select * into ac from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id
   offset coalesce(nullif(split_part(p_key, '#', 2), '')::integer, 0) limit 1;
  if r.source_kind = 'institute' then
   if r.source_ref not in ('name', 'short_name', 'address', 'phone', 'email', 'admissions_email', 'rto', 'cricos', 'abn', 'website', 'legal_name') then raise exception 'Not editable' using errcode = '42501'; end if;
   execute format('update public.cms_settings set %I = $1, updated_at = now() where id = (select s.id from public.cms_settings s where s.tenant_id is not distinct from $2 order by s.id limit 1)', r.source_ref) using v, a.tenant_id;
  elsif r.source_kind = 'course' then
   if r.source_ref not in ('cricos', 'duration', 'mode') then raise exception 'Not editable' using errcode = '42501'; end if;
   v_course := public.letter_course_id(ac.course_id, ac.course_code);
   if v_course is null then raise exception 'The application has no course from the course list' using errcode = '22023'; end if;
   execute format('update public.cms_courses set %I = $1, updated_at = now() where id = $2', r.source_ref) using v, v_course;
  elsif r.source_kind = 'fee' then
   v_course := public.letter_course_id(ac.course_id, ac.course_code);
   if v_course is null then raise exception 'The application has no course from the course list' using errcode = '22023'; end if;
   select * into v_row from public.course_fee_setups x where x.course_id = v_course and x.intake_id = ac.intake_id;
   if not found then select * into v_row from public.course_fee_setups x where x.course_id = v_course and x.intake_id is null; end if;
   v_fee := jsonb_build_object('tuition', v_row.tuition_fee, 'enrolment', v_row.enrolment_fee, 'material', v_row.material_fee, 'oshc', v_row.oshc_fee, 'deposit', v_row.deposit,
     'paymentPlan', v_row.payment_plan, 'campus', v_row.campus, 'orientation', v_row.orientation, 'hoursPerWeek', v_row.hours_per_week);
   v_field := case r.source_ref when 'tuition_fee' then 'tuition' when 'enrolment_fee' then 'enrolment' when 'material_fee' then 'material' when 'oshc_fee' then 'oshc'
     when 'deposit' then 'deposit' when 'payment_plan' then 'paymentPlan' when 'campus' then 'campus' when 'orientation' then 'orientation' when 'hours_per_week' then 'hoursPerWeek' end;
   if v_field is null then raise exception 'Not editable' using errcode = '42501'; end if;
   perform public.cms_course_fee_save(v_course, case when v_row.id is null then null else v_row.intake_id end, jsonb_strip_nulls(v_fee || jsonb_build_object(v_field, v)));
  else
   raise exception '% cannot be saved to its source from here', r.label using errcode = '42501';
  end if;
 end if;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(auth.jwt()->>'email', 'Authorized reviewer'), 'slit_admin', 'letter_value_saved_to_source', 'application', a.id::text, a.id,
   jsonb_build_object('key', p_key, 'source', r.source_label, 'value', left(v, 500)));
 return public.application_letter_values(a.id);
end $$;

/* ------------------------------------------------------------------ blocks in templates */
/** The {{key}} tokens a template uses (modifiers and the block markers #each / /each / #if / /if left out), in order of first use. */
create or replace function public.letter_template_keys(p_html text) returns text[] language sql immutable parallel safe set search_path = pg_catalog as $$
  select coalesce(array_agg(k order by first), '{}') from (
    select lower(btrim(split_part(m[1], '|', 1))) k, min(n) first
    from regexp_matches(regexp_replace(coalesce(p_html, ''), '<[^>]*>', '', 'g'), '\{\{\s*([^{}]{1,80}?)\s*\}\}', 'g') with ordinality as t(m, n)
    where btrim(m[1]) !~ '^[#/]' group by 1) s;
$$;

/** As 20261113300000, with the block markers {{#each courses}} {{/each}} {{#if multiple_courses}} {{/if}} allowed. */
create or replace function public.letter_template_unmapped(p_html text) returns text[] language sql stable security definer set search_path = public as $$
  with src as (select regexp_replace(coalesce(p_html, ''), '<[^>]*>', '', 'g') as t),
  found as (
    select '{{' || btrim(m[1]) || '}}' tok, 'curly' kind, btrim(m[1]) raw from src, regexp_matches(src.t, '\{\{\s*([^{}]{1,80}?)\s*\}\}', 'g') m
    union all select '$[' || m[1] || ']', 'old', m[1] from src, regexp_matches(src.t, '\$\[([^\[\]]{1,80})\]', 'g') m
    union all select '{' || m[1] || ':inline}', 'old', m[1] from src, regexp_matches(src.t, '\{([A-Za-z][A-Za-z0-9_ ]{0,60}):inline\}', 'g') m
    union all select '[' || m[1] || ']', 'bracket', m[1] from src, regexp_matches(src.t, '(?:^|[^$])\[([^\[\]\n]{1,80})\]', 'g') m
  )
  select coalesce(array_agg(distinct tok order by tok), '{}') from found f
  where (f.kind = 'curly' and lower(f.raw) not in ('#each courses', '/each', '#if multiple_courses', '/if')
          and (not exists (select 1 from public.letter_variables v where v.key = lower(btrim(split_part(f.raw, '|', 1))))
            or (position('|' in f.raw) > 0 and lower(btrim(split_part(f.raw, '|', 2))) not in ('upper', 'lower', 'raw', 'title')
                and lower(btrim(split_part(f.raw, '|', 2))) !~ '^h[0-9]{2,3}$')))
     or f.kind = 'old'
     or (f.kind = 'bracket' and exists (select 1 from public.letter_variables v, unnest(v.aliases) al where public.letter_norm(al) = public.letter_norm(f.raw)));
$$;

/* ------------------------------------------------------------------ CC: the agent gets a copy */
alter table public.enrollment_offer_letters add column if not exists cc_emails text[];
/**
 * Who is copied on an application's letters: the agent (assigned, else the one who started it) when they have an email; without one,
 * the agency's main email (a warning says so). Nothing for a direct student.
 */
create or replace function public.application_cc_default(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a public.enrollment_applications; p public.portal_profiles; g public.agencies; v_agent boolean;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 select * into p from public.portal_profiles x where x.id = a.assigned_agent_id;
 if not found and a.created_by is not null and exists (select 1 from public.agency_memberships m where m.user_id = a.created_by and m.role in ('agent', 'agency_admin')) then
  select * into p from public.portal_profiles x where x.id = a.created_by;
 end if;
 select * into g from public.agencies x where x.id = a.agency_id;
 v_agent := p.id is not null;
 if not v_agent and (g.id is null or coalesce(g.is_direct, false)) then return jsonb_build_object('applies', false); end if;
 return jsonb_build_object('applies', true, 'agentName', coalesce(p.full_name, ''), 'agentEmail', lower(btrim(coalesce(p.email, ''))), 'agencyName', coalesce(g.name, ''),
   'agencyEmail', lower(btrim(coalesce(g.business_email, ''))),
   'email', coalesce(nullif(lower(btrim(coalesce(p.email, ''))), ''), nullif(lower(btrim(coalesce(g.business_email, ''))), '')),
   'warning', case when nullif(btrim(coalesce(p.email, '')), '') is not null then null
     when nullif(btrim(coalesce(g.business_email, '')), '') is not null then case when v_agent then 'The agent has no email: the copy goes to the agency''s main email' else 'No agent is assigned: the copy goes to the agency''s main email' end
     else 'Neither the agent nor the agency has an email: no copy can be sent' end);
end $$;
revoke all on function public.application_cc_default(uuid) from public, anon;
grant execute on function public.application_cc_default(uuid) to authenticated;

/**
 * After Issue offer letter, Resend offer letter or Issue CoE / VoE: copies the email just queued for the recipient to the CC address
 * (only the application's agent or agency email), and records the copy in the status history.
 */
create or replace function public.portal_notification_cc(p_application uuid, p_event text, p_emails text[]) returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.enrollment_applications; o public.admission_event_outbox; d public.notification_deliveries; v_default jsonb; v_allowed text[]; v_sent text[] := '{}'; e text; h uuid;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if p_event not in ('offer_letter_issued', 'coe_voe_issued') then raise exception 'No copy for %', p_event using errcode = '22023'; end if;
 v_default := public.application_cc_default(a.id);
 v_allowed := array_remove(array[nullif(v_default->>'agentEmail', ''), nullif(v_default->>'agencyEmail', '')], null);
 select * into o from public.admission_event_outbox x where x.application_id = a.id and x.event = p_event and x.created_at > now() - interval '10 minutes' order by x.created_at desc limit 1;
 if not found then raise exception 'There is no email to copy' using errcode = '22023'; end if;
 select * into d from public.notification_deliveries x where x.outbox_id = o.id order by x.created_at limit 1;
 if not found then raise exception 'There is no email to copy' using errcode = '22023'; end if;
 foreach e in array coalesce(p_emails, '{}') loop
  e := lower(btrim(e));
  if e = '' or e = lower(d.recipient_email) then continue; end if;
  if not (e = any(v_allowed)) then raise exception '% is not the agent or agency of this application', e using errcode = '42501'; end if;
  insert into public.notification_deliveries(outbox_id, tenant_id, application_id, recipient_user, recipient_email, event, template_source, template_version_id, sender, subject, body, state, state_reason, created_at)
  values (o.id, d.tenant_id, d.application_id, null, e, d.event, d.template_source, d.template_version_id, d.sender, d.subject, d.body, d.state, d.state_reason, clock_timestamp())
  on conflict do nothing;
  v_sent := v_sent || e;
 end loop;
 if cardinality(v_sent) > 0 then
  -- The status change just made gets the copy on its history line; a resend (no status change) gets a line of its own.
  select x.id into h from public.enrollment_application_status_history x where x.application_id = a.id and x.created_at > now() - interval '10 minutes'
   and x.new_status = a.status order by x.created_at desc limit 1;
  if h is not null and not coalesce((o.payload->>'resend')::boolean, false) then
   update public.enrollment_application_status_history set note = left(concat_ws(' · ', nullif(note, ''), 'CC: ' || array_to_string(v_sent, ', ')), 1000) where id = h;
  else
   insert into public.enrollment_application_status_history(application_id, previous_status, new_status, actor, actor_name, actor_role, note, tenant_id, action_key)
   values (a.id, a.status, a.status, auth.uid(), coalesce(auth.jwt()->>'email', 'Reviewer'), 'slit_admin', left('Offer letter resent · CC: ' || array_to_string(v_sent, ', '), 1000), a.tenant_id, 'resend_offer');
  end if;
  update public.enrollment_offer_letters set cc_emails = (select array_agg(distinct x) from unnest(coalesce(cc_emails, '{}') || v_sent) x)
   where id = (select z.id from public.enrollment_offer_letters z where z.application_id = a.id order by z.issued_at desc limit 1) and p_event = 'offer_letter_issued';
 end if;
 return jsonb_build_object('cc', to_jsonb(v_sent));
end $$;
revoke all on function public.portal_notification_cc(uuid, text, text[]) from public, anon;
grant execute on function public.portal_notification_cc(uuid, text, text[]) to authenticated;

/* ------------------------------------------------------------------ templates: letterhead, footer, the real SLIT letter */
create or replace function public.letter_standard_header() returns text language sql immutable set search_path = pg_catalog as $$
  select '<table style="border:none;width:100%"><tr><td style="width:45%;vertical-align:middle">{{institute.logo|h60}}</td>'
    || '<td style="width:55%;text-align:right;vertical-align:middle">'
    || '<p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#333333">Head Office: {{institute.address}}</span></span></p>'
    || '<p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#333333">RTO: {{institute.rto}}  CRICOS: {{institute.cricos}}</span></span></p>'
    || '<p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#333333">Email: {{institute.email}}</span></span></p>'
    || '<p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#333333">Phone: {{institute.phone}}</span></span></p>'
    || '<p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#333333">Web: {{institute.website}}</span></span></p></td></tr></table>';
$$;
create or replace function public.letter_standard_footer(p_title text default 'LETTER OF OFFER AND WRITTEN AGREEMENT', p_version text default 'Version Oct 2024') returns text language sql immutable set search_path = pg_catalog as $$
  select '<p style="text-align:center;margin-bottom:0pt"><span style="font-size:7.5pt">' || coalesce(p_title, '') || ' · ' || coalesce(p_version, '')
    || ' · Student Initial ______________ · Page {{page.number}} of {{page.total}}</span></p>'
    || '<p style="text-align:center;margin-bottom:0pt"><span style="font-size:7pt">{{institute.legal_name}} · ABN: {{institute.abn}}</span></p>';
$$;
grant execute on function public.letter_standard_header() to authenticated;
grant execute on function public.letter_standard_footer(text, text) to authenticated;

do $$
declare v_admin uuid; t hr.sign_templates; v_unmapped text[];
begin
 select c.auth_user_id into v_admin from public.cms_users c where c.role = 'Admin' and c.status = 'Active' and c.auth_user_id is not null order by c.created_at, c.id limit 1;
 -- The starter keeps its body, gets the standard letterhead and footer, and stays as an inactive example.
 update hr.sign_templates set header_html = public.letter_standard_header(), footer_html = public.letter_standard_footer(), is_default = false, status = 'archived',
   version = version + 1, updated_at = now()
  where category = 'student_offer_letter' and name = 'Standard Letter of Offer' and deleted_at is null and header_html is distinct from public.letter_standard_header()
  returning * into t;
 if t.id is not null then insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), coalesce(v_admin, t.created_by)); end if;
 if exists (select 1 from hr.sign_templates where category = 'student_offer_letter' and name = 'SLIT Letter of Offer and Written Agreement' and deleted_at is null) then return; end if;
 if v_admin is null then raise notice 'No active CMS admin: the SLIT letter was not seeded'; return; end if;
 update hr.sign_templates set is_default = false where category = 'student_offer_letter' and is_default;
 insert into hr.sign_templates(name, title, body, body_html, header_html, footer_html, kind, audience, category, is_default, bracket_variables, created_by)
 values ('SLIT Letter of Offer and Written Agreement', 'Letter of Offer and Written Agreement', 'Letter of Offer and Written Agreement', $legacy$<br>
<div>
<div style="text-align:center">
<h2><span style="color:#333333"><span style="font-size:12pt">LETTER OF OFFER AND WRITTEN AGREEMENT</span></span></h2>
<div>Date: {{offer.date}}</div>
<table>
<tbody>
<tr>
<td style="width:270.8pt"><span style="color:#333333"><span style="font-size:7.5pt"><strong>Student No:</strong> {{application.reference}}</span></span></td>
<td style="width:270.8pt"><span style="color:#333333"><span style="font-size:7.5pt"><strong>Name:</strong> {{student.full_name}}</span></span></td>
</tr>
<tr>
<td style="width:270.8pt"><span style="color:#333333"><span style="font-size:7.5pt"><strong>Contact No.: </strong>{{student.mobile}}</span></span></td>
<td style="width:225pt"><span style="color:#333333"><span style="font-size:7.5pt"><strong>Passport No:</strong> {{student.passport_number}}</span></span></td>
</tr>
<tr>
<td style="width:270.8pt"><span style="color:#333333"><span style="font-size:7.5pt"><strong>Date of Birth:</strong> {{student.dob}}</span></span></td>
<td style="width:270.8pt"><span style="color:#333333"><span style="font-size:7.5pt"><strong>Email: </strong>{{student.email}}</span></span></td>
</tr>
<tr>
<td style="width:270.8pt"><span style="color:#333333"><span style="font-size:7.5pt"><strong>Address: </strong>{{student.address}}</span></span></td>
<td style="width:270.8pt"><span style="color:#333333"><span style="font-size:7.5pt"><strong>Agent: </strong>{{agency.name}}</span></span></td>
</tr>
</tbody>
</table>
<div><br>
<span style="color:#333333"><strong>Dear {{student.full_name}},</strong><br>
Congratulations!<br>
INDOPACIFIC GLOBAL PTY LTD T/A Skyline Institute of Technology (SLIT) is pleased to offer you a<strong> conditional place </strong>in the following program as an international student in Australia. Your offer is outlined in detail below. It is important that you read your offer letter carefully. This offer is subject to availability of places in the program. As places are limited, it is in your interest to accept your offer as soon as possible and return the 'Acceptance Agreement' attached to this offer letter.<br>
<br>
<strong>Your Offer Details:</strong><br>
<strong>Orientation Day (compulsory attendance): </strong> <span style="font-weight:bold">{{course.orientation}}</span>                                        </span></div>
<table style="width:100%">
<tbody>
<tr>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt"><strong>CRICOS Course Code</strong></span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt"><strong>Course Code &amp; Name</strong></span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt"><strong>Start Date - End Date</strong></span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt"><strong>Location</strong></span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt"><strong>Hrs/Week</strong></span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt"><strong>Total Duration Weeks</strong></span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt"><strong>Tuition Fee (Only)</strong></span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt"><strong>Mode of Delivery</strong></span></span></td>
</tr>
<tr><td colspan="8">{{#each courses}}</td></tr><tr>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt">{{course.cricos}}</span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt">{{course.code_and_name}}</span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt">{{course.start_date}} to<br>
{{course.end_date}}</span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt">{{course.campus}}</span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt">20</span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt">{{course.duration}}</span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt">{{fees.tuition}}</span></span></td>
<td style="text-align:center"><span style="color:#333333"><span style="font-size:8.3pt">{{course.mode}}</span></span></td>
</tr><tr><td colspan="8">{{/each}}</td></tr>
</tbody>
</table>
<div>
<div><span style="color:#333333"><span style="font-size:7.5pt"><span style="font-size:8.3pt"><strong>Total Fees and Charges </strong></span></span></span></div>
<div><span style="color:#333333"><span style="font-size:7.5pt"><span style="font-size:8.3pt">All fees are in Australian dollars (AUD) </span></span></span></div>
</div>
<p>{{#each courses}}</p><div><span style="color:#333333"><span style="font-size:7.5pt"><span style="font-size:8.3pt"><strong>{{course.code_and_name}}</strong></span> </span></span>
<table style="width:100%;border:none">
</table>
<table style="width:100%">
<tbody>
<tr>
<td style="width:100%"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Application fee (Non-Refundable):</strong></span></span></td>
<td style="text-align:right;width:187.5pt"><span style="font-size:8.3pt"><span style="color:#333333">{{fees.enrolment}}</span></span></td>
</tr>
<tr>
<td style="width:100%"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Material Fee:</strong></span></span></td>
<td style="text-align:right;width:187.5pt"><span style="font-size:8.3pt"><span style="color:#333333">{{fees.material}}</span></span></td>
</tr>
<tr>
<td style="width:100%"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Tuition Fee</strong>:</span></span></td>
<td style="text-align:right;width:187.5pt"><span style="font-size:8.3pt"><span style="color:#333333">{{fees.tuition}}</span></span></td>
</tr>
<tr>
<td style="width:100%"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Total Fee</strong>: </span></span></td>
<td style="text-align:right;width:187.5pt"><span style="font-size:8.3pt"><span style="color:#333333">{{fees.total}}</span></span></td>
</tr>
</tbody></table><p>{{/each}}</p><p>{{#if multiple_courses}}</p><table style="width:100%"><tbody><tr><td style="width:100%"><strong>Combined total (all courses)</strong></td><td style="text-align:right">{{fees.combined_total}}</td></tr></tbody></table><p>{{/if}}</p><table style="width:100%"><tbody><tr>
<td style="width:100%"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Initial Deposit</strong></span></span></td>
<td style="text-align:right;width:187.5pt"><span style="font-size:8.3pt"><span style="color:#333333">{{fees.deposit}}</span></span></td>
</tr>
</tbody>
</table>
<span style="color:#333333">  <span style="font-size:7.5pt"> </span> <span style="font-size:7.5pt">  </span><span style="font-size:7.5pt"> </span></span></div>
<table style="width:100%">
<tbody>
<tr>
</tr>
</tbody>
</table>
<div><span style="color:#333333"><span style="font-size:8.3pt"> </span><strong><span style="font-size:8.3pt">The outstanding payments can be paid in full, or paid in either Monthly or Quarterly instalments, according to the payment plan</span>.</strong></span></div>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">If you wish to pay Monthly or Quarterly, please advices at the time of orientation . For further Fees and Information, please refer to the Fees and Refund Policy.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Prior to commencement, the student must have OSHC arranged (OSHC - Overseas Student Health Cover It is mandatory that you and your dependants maintain the appropriate health cover during the entire duration of your stay in Australia on a Student visa. We have partnered with Konpare to help you compare and purchase an appropriate OSHC by using the following link: slit.konpare.online)</span></span></li>
</ul>
<table style="width:100%;border:none">
<tbody>
<tr>
<td><span style="color:#333333"><span style="font-size:8.3pt"><strong>First Commencement Date:</strong> {{offer.first_start_date}} </span></span></td>
<td style="text-align:right"><span style="color:#333333"><span style="font-size:8.3pt"><strong>Last Expected End Date:</strong> {{offer.last_end_date}}</span></span><br>
 </td>
</tr>
<tr>
</tr>
<tr>
<td colspan="2"><span style="color:#333333"><span style="font-size:8.3pt"><strong>NOTE: "YOU MUST ADVISE SKYLINE INSTITUTE WITHIN 7 DAYS OF ANY CHANGE IN ADDRESS WHILE ENROLLED IN THE COURSE"</strong></span></span></td>
</tr>
<tr>
<td colspan="2"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Condition(s) of the Offer (IF ANY): </strong><br>
<strong>{{offer.conditions}}</strong></span></span></td>
</tr>
</tbody>
</table>
</div>
<div style="text-align:justify">
<div style="text-align:justify"><strong>Offer Condition Regarding INTERNATIONAL STUDENT Provider Limits</strong></div>
<div style="text-align:justify"><span style="font-size:7.5pt">This offer of a place in the mentioned course(s) at Skyline Institution of Technology is conditional upon the following:</span></div>
<ul>
<li><span style="font-size:7.5pt">Passage of Legislation: The Education Services for Overseas Students Amendment (Quality and Integrity) Bill 2024 (the "Bill") is currently before the Australian Parliament. This Bill proposes to introduce limits on the number of international students that education providers can enroll ("Provider Limits").</span></li>
<li><span style="font-size:7.5pt">Implementation of Provider Limits: If the Bill is passed and Provider Limits are implemented, Skyline Institution of Technology will be subject to those limits. This may affect our ability to offer you a place in the course, even if you have met all other conditions of this offer.</span></li>
<li><span style="font-size:7.5pt">Prioritization of Enrollments: In the event that Provider Limits prevent Skyline Institution of Technology from offering you a place in the course, we will prioritize enrollments based on the date the application was received and other relevant factors.</span></li>
<li><span style="font-size:7.5pt">No Guarantee of Enrollment: This offer letter does not guarantee enrollment in the course. Enrollment will be commenced only after the passage of the Bill, the finalization of Provider Limits, and confirmation that Skyline Institution of Technology has capacity to enroll you within those limits.</span></li>
<li><span style="font-size:7.5pt">Withdrawal of Offer: Skyline Institution of Technology reserves the right to withdraw this offer if the implementation of Provider Limits prevents us from offering you a place in the course. In such circumstances, any refundable fees paid will be refunded in accordance with our refund policy.</span></li>
</ul>
<div style="text-align:justify"><span style="font-size:7.5pt">Please note: This condition is in place to ensure that Skyline Institution of Technology complies with any Provider Limits that may be implemented. We understand that this may cause uncertainty, and we will endeavor to provide you with updates on the progress of the Bill and its potential impact on your offer.</span></div>
<div style="text-align:justify"><span style="font-size:7.5pt">Please confirm your understanding and acceptance of this condition by signing and returning a copy of this offer letter.</span></div>
<hr><span style="color:#333333"><span style="font-size:7.5pt">If you commence your studies on the above date, your tuition fees will be calculated in accordance with SLIT fees that are current at the time of signing the Acceptance Agreement and will be held at that rate for the duration of your studies in this course. If you change your enrolment from the above course to another, then you will receive a separate offer letter clearly stating the conditions of the new offer letter, including but not limited to the payment of fees obligations. You will also be required to complete and sign another Acceptance Agreement.</span></span></div>
<div style="text-align:justify"><span style="font-size:8.3pt"><span style="color:#333333">As per SLIT fees and refund policy, late payment of fees attracts fines. Students are liable to pay AUD$100 per week in fines until their fees are paid if they fail to pay their tuition fees on time. All tuition fees are payable as specified within this letter of offer. For more detailed information on the payment of fees, please check SLIT fees and refund policy available in the Student Handbook and on the SLIT web site at <u>https://slit.edu.au.</u></span></span></div>
<span style="font-size:7.5pt"><span style="color:#333333">It is a requirement that the student identified within this Letter of Offer signs the accompanying 'Acceptance Agreement' concurrently with or prior to paying the course fees.<br>
According to the requirements of the National Code 2018 Standard 3, the 'Acceptance of Offer' is the formalisation of enrolment and is also recognized as the student written agreement. This Acceptance of Offer must be signed solely by the student named in this letter of offer.<br>
You are expected to arrive in Australia at least 48 hours prior to the commencement of your orientation program to ensure you are adequately<br>
prepared for your orientation session and to start your course.</span></span>
<p><span style="font-size:7.5pt"><span style="color:#333333"><strong>If you require further information or assistance, please do not hesitate to contact SLIT Admissions at</strong> <em>admission@slit.edu.au</em> or <strong>ca</strong></span>ll +61 3 9125 1661.</span></p>
<span style="font-size:8.3pt"><span style="color:#333333">We trust the information provided will enable you to plan your education journey at Skyline Institute of Technology and we look forward to welcoming you soon.<br>
<br>
Yours sincerely,<br>
SLIT Admin<br>
<br>
<br><br>
The student identified within this Letter of Offer must sign the accompanying Acceptance Agreement concurrently with or prior to paying the course prepaid fees. This Acceptance Agreement must be signed solely by the student. By submitting a signed Acceptance Agreement, applicants indicate that they have read, understood, and will abide by all required SLIT policies and procedures and terms and conditions – particularly those regarding Fees and Refunds, Withdrawals and Deferrals.</span></span>
<ol>
<li><span style="font-size:8.3pt"><span style="color:#333333">SLIT reserves the right at any time to withdraw course offers. The decision to withdraw an offer may be based upon any of the following instances:</span></span>
<ol>
<li><span style="font-size:8.3pt"><span style="color:#333333">Inaccurate information supplied by an applicant or party acting on behalf of an applicant;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Questionable or misleading documentation supplied or,</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Removal or suspension of a course offered</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">At the discretion of SLIT management.</span></span></li>
</ol>
</li>
<li><span style="font-size:8.3pt"><span style="color:#333333">All applicants will be informed of a withdrawal of course offer in writing within five (5) business days. Course offers are subject to review by SLIT Management at any time – this refers to prospective, current, and re-enrolling students.</span></span></li>
</ol>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong>COE Request Checklist:</strong></span></span>
<table style="width:516.8pt">
<tbody>
<tr>
<td style="width:474.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Checklist</strong></span></span></td>
<td style="width:42.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Tick</span></span></td>
</tr>
<tr>
<td style="width:474.8pt"><span style="font-size:8.3pt"><span style="color:#333333">I have read, understood, signed, dated, and returned the Acceptance Agreement.</span></span></td>
<td style="width:42.8pt"><span style="font-size:8.3pt"><span style="color:#333333"></span></span></td>
</tr>
<tr>
<td style="width:474.8pt"><span style="font-size:8.3pt"><span style="color:#333333">I have received, read, and understood the letter of offer.</span></span></td>
<td style="width:42.8pt"><span style="font-size:8.3pt"><span style="color:#333333"></span></span></td>
</tr>
<tr>
<td style="width:474.8pt"><span style="font-size:8.3pt"><span style="color:#333333">I have submitted all relevant, valid authentic and certified documents (e.g. previous qualifications, English proficiency Certificates IELTS scores etc.).</span></span></td>
<td style="width:42.8pt"><span style="font-size:8.3pt"><span style="color:#333333"></span></span></td>
</tr>
<tr>
<td style="width:474.8pt"><span style="font-size:8.3pt"><span style="color:#333333">I have returned all required additional forms as requested by SLIT.</span></span></td>
<td style="width:42.8pt"><span style="font-size:8.3pt"><span style="color:#333333"></span></span></td>
</tr>
<tr>
<td style="width:474.8pt"><span style="font-size:8.3pt"><span style="color:#333333">I have submitted payment of all relevant fees including but not limited to tuition, enrolment and all other additional fees as defined in this letter of offer and acceptance agreement in the specified manner.</span></span></td>
<td style="width:42.8pt"><span style="font-size:8.3pt"><span style="color:#333333"></span></span></td>
</tr>
</tbody>
</table>
 
<div><span style="font-size:8.3pt"><span style="color:#333333"><strong>Terms used within this Acceptance of Offer includes:</strong></span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Skyline Institute of Technology Pty Ltd will be referred to as '<strong>SLIT</strong>'</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Electronic Confirmation of Enrolment is '<strong>eCoE</strong>', or Confirmation of Enrolment '<strong>CoE</strong>'</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Department of Home Affairs will be referred to as '<strong>DHA</strong>'</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Commonwealth Department of Education will be referred to as '<strong>DET</strong>'</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Education Services for Overseas Students Act 2000 (or most recent version of this Act) will be referred to as '<strong>ESOS Act</strong>'</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">National Code of Practice for Registration Authorities and Providers of Education and Training to Overseas students 2018 (or most recent version of this legislation) will be referred to as 'National Code 2018'</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Commonwealth Register of Institutions and Courses for Overseas Students will be referred to as '<strong>CRICOS</strong>'</span></span></li>
</ul>
</div>
  <br>
<h1 style="text-align:center"><span style="font-size:12pt"><span style="color:#333333">Acceptance Agreement</span></span></h1>
<strong>(The student is responsible for keeping a copy of the written agreement and receipts of any payments of tuition and non-tuition fees)</strong><br>
The requirements of Standard 3 of the National Code 2018 require that all students must enter into a written agreement with SLIT that clearly sets out specified information about the course and the conditions of enrolment, before or at the same time as accepting any money from prospective students.<br>
<br>
This Acceptance Agreement constitutes the Standard 3 National Code 2018 requirement for a written agreement requiring a valid and authentic student signature. Acceptance of this Acceptance Agreement by the student, together with the required payments, enables SLIT to issue a Confirmation of Enrolment (CoE) to the student before they can apply for a student visa (where this is applicable).<br>
This agreement between the parties (SLIT and you as the student) comprises an Enrolment Offer from SLIT and an Acceptance by the applicant student.
<div>
<h2><span style="font-size:8.3pt"><span style="color:#333333">Parties to the Agreement</span></span></h2>
</div>
<span style="font-size:8.3pt"> <span style="color:#333333"> The parties to this enrolment offer and acceptance agreement are </span></span>
<table style="width:532.5pt">
<tbody>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>Skyline Institute of Technology Pty Ltd </strong><br>
Level 8, 310 King Street, Melbourne VIC - 3000</span></span></td>
</tr>
</tbody>
</table>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong> AND</strong></span></span>
<table>
<tbody>
<tr>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Student No </strong>(provided by SLIT)<strong>:</strong> {{application.reference}}</span></span></td>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Name:</strong> {{student.full_name}}</span></span></td>
</tr>
<tr>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Contact No.: </strong>{{student.mobile}}</span></span></td>
<td style="width:225pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Passport No:</strong> {{student.passport_number}}</span></span></td>
</tr>
<tr>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Date of Birth:</strong> {{student.dob}}</span></span></td>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Email: </strong>{{student.email}}</span></span></td>
</tr>
<tr>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Address: </strong>{{student.address}}</span></span></td>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Nationality: </strong>{{student.nationality}}</span></span></td>
</tr>
<tr>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Country of Birth: </strong>{{student.country_of_birth}}</span></span></td>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Gender: </strong>{{student.gender}}</span></span></td>
</tr>
<tr>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Emergency Contact Name: </strong>{{student.emergency_contact_name}}</span></span></td>
<td style="width:270.8pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Emergency Contact No. </strong>{{student.emergency_contact_phone}}</span></span></td>
</tr>
</tbody>
</table>
<div>
<h2><span style="font-size:8.3pt"><span style="color:#333333">Acceptance Agreement - Terms and Conditions of Enrolment</span></span></h2>
</div>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong>1. Student Contact Details</strong><br>
It is a requirement of the student visa that you advise SLIT of your current contact details, including residential address, phone number email address and next of kin upon arrival into Australia. If you change your contact details you are required to notify SLIT within 5 days of any change. Your failure to notify SLIT that you have changed your contact details may result in cancellation of your visa by DHA. The Application for Change of Details Form is available from Student Support, SLIT web site <u>http://slit.edu.au</u> or alternatively you can update your details via the online student portal at any time.<br>
As part of the obligations under Student Identifier Act 2014, you must obtain a USI (Unique Student Identifier) upon arrival in Australia and advise your USI to SLIT prior to starting your course.<br>
<strong>2.Electronic Communication</strong><br>
SLIT communicates with all its students via the email address provided in their application and on their current contact details record in the Student Management System. It is an ongoing responsibility for students to check their email regularly as all important communication regarding course progress, attendance and due fees will be sent to their email account. This information will also be available via the online student portal account.<br>
<strong>3.Course Progression and Attendance</strong><br>
Regular attendance is a requirement for all students. International students must attend a minimum of 80% of classes for the duration of their course. If students fail to meet this requirement, their enrolment with SLIT will be cancelled and the student will be reported to DHA and their visa may be cancelled as a result of insufficient attendance.<br>
If students do not achieve satisfactory course progress (more than 50%) they will have to attend counselling with Student Support. If the student fails to meet the progress subsequently, they will be reported to DHA and their visa may be cancelled. For more information see P19 Course progress and Procedure.<br>
 <br>
<strong>4.Payment of Fees</strong><br>
All payments are made to SLIT as defined within the payment schedule outlined in the letter of offer, as a condition of enrolment. Payment of fees secures the student a place in their chosen course(s) and fixes the price of the course(s) for the period for which they have paid. Course fees are subject to change without prior notice. Any such change will not affect any payment you have already made.</span></span><br>
 <br><br>
<span style="font-size:8.3pt"><span style="color:#333333">Fees are to be paid in Australian dollars only by electronic transfer or bank draft using your <strong>Student ID number </strong>as the Bank description/reference</span></span>
<table style="width:524.3pt">
<tbody>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>Bank:</strong></span></span></td>
<td style="width:288pt"><span style="font-size:8.3pt"><span style="color:#333333">Commonwealth Bank </span></span></td>
</tr>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>Account Name:</strong></span></span></td>
<td style="width:288pt"><span style="font-size:8.3pt"><span style="color:#333333">Skyline Institute of Technology</span></span></td>
</tr>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>BSB</strong>:</span></span></td>
<td style="width:288pt"><span style="font-size:8.3pt"><span style="color:#333333">063 622</span></span></td>
</tr>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>Account No:</strong></span></span></td>
<td style="width:288pt"><span style="font-size:8.3pt"><span style="color:#333333">1116 5161</span></span></td>
</tr>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>SWIFT code:</strong></span></span></td>
<td style="width:288pt"><span style="font-size:8.3pt"><span style="color:#333333">CTBAAU2S</span></span></td>
</tr>
</tbody>
</table>
<br>
<span style="font-size:8.3pt"><span style="color:#333333"> <br>
 <br>
Tuition fees can also be paid by EFTPOS at SLIT. Students will not be issued a certificate or statement of attainment at the completion of the course while any fees are still outstanding.<br>
<strong>Enrolment Fee ($250 in total- Non Refundable) </strong>All students must pay a non-refundable enrolment fee. This fee should be paid with the first tuition fee.<br>
<strong>Material Fee (between $500 - $1500 depending on the course)</strong> The material fee covers any workbooks, subscriptions, online and physical resources that you will be using while studying with SLIT.<br>
<strong>Due date for fees</strong> The Enrolment fee and first instalment of your tuition fee are due and payable upon receiving your Letter of Offer and returning of the signed Acceptance Agreement.<br>
<strong>Late payment fee</strong> A late payment fee of $100 will be applied for each week your fee payment is delayed until your fees are paid. Should fees remain overdue for more than 14 days SLIT will inform the student of their intention to report them for non-payment of fees to DHA.<br>
While student fees are outstanding students will not be permitted to attend their scheduled class until the outstanding fees have been paid in full.</span></span>
<div style="text-align:justify"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Re- Assessment  </strong>It is inevitable that some students will not meet the requirements of the assessment evidence and will be judged as not yet-competent for a unit of competency or not satisfactory for a task. At Skyline Institute of Technology, our approach to these situations is the work with the student in order to address deficiencies and to build their skill and knowledge in preparation for additional two assessments. This will be undertaken within the scheduled training plan or may be completed under alternative arrangements agreed between the student and the assessor. In some rare circumstances, students may find it difficult to develop the necessary skills and knowledge within the constraints of the scheduled training plan. When this occurs, arrangements may be agreed to that allows the student to undertake additional learning in their own time and return for additional assessment at a time suitable time for Skyline Institute of Technology. This may be during a period of reduced training activity or at a time when planned assessments are occurring, term breaks or holidays and it is convenient to facilitate the additional assessment of the student. As a general guide, assessors are to make alternative arrangements to provide opportunities for assessment within the constraints of available time and resources. In all circumstances, the assessment is to be a planned activity that is conducted in accordance with the assessment procedures in the following section. You must apply to extend the training and assessment plan. Note a fee may be incurred if more than one request to extend the training plan applies. In some cases, after alternative arrangements have been exhausted, it will be suitable to find a student as not-yet-competent and record this result with their statement of attainment. The student is given 2 attempts free of charge. The student can request to be reassessed after the 2 attempts at a cost of $250 per unit and any attempt thereafter.</span></span></div>
<span style="font-size:8.3pt"><span style="color:#333333"><strong>Other fees and charges </strong><br>
Students may incur other fees for additional services as stated below:</span></span>
<table style="width:514.5pt">
<tbody>
<tr>
<td style="width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Application Fee (also known as Enrolment Fee) </span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$250</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Change of COE details (On student request)</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$50</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Re-issue of Letter of Offer</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$0</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Overdue tuition fee per week</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$100</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Deferment of Enrolment</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$50</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Re-Assessment 3rd Attempt</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$250</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Re-enrolment of unit fee after 3rd attempt or non Attendance at first</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$250</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">New Enrolment &amp; Re-enrolment fee</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$250</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Holiday Reference Letter (1st Free)</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$20</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Enrolment/Attendance Letter (1st free)</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$20</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Leave Letter (one free on every term break)</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$20</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Invitation letter for Family Members</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$20</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Release Letter (Subject to approval as per SLIT transfer policy and ESOS act)</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$0</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Record extraction after 1 year of completion (one free per year)</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$10</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Re-issuing of Certificate/Transcripts</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$50</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Student ID Card</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Free</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Re-issue of Student ID Card</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$20</span></span></td>
</tr>
<tr>
<td style="text-align:center;width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">Registration FEES (Future Graduate Diploma)</span></span></td>
<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">$750</span></span></td>
</tr>
<tr>
<td colspan="2" style="width:514.5pt"><span style="font-size:8.3pt"><span style="color:#333333">Overseas Student Health Cover: All international students are required by the Australian Government to pay OSHC and maintain cover for the full length of their visa.</span></span></td>
</tr>
</tbody>
</table>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong>5. Tuition Protection</strong></span></span>
<div style="text-align:justify"><span style="font-size:8.3pt"><span style="color:#333333">Course fees for international students studying on an Australian student visa are protected by the Tuition Protection Service under the Education Services for Overseas Students (ESOS) Act 2000. Detailed information about the way tuition protection is managed within SLIT is outlined below in the Refund Policy. Further details about the Australian Government's Tuition Protection Service can be found at www.tps.gov.au<br>
In accordance with the legislated requirements of the ESOS Act, SLIT will not request pre-paid fees of more than $1500 from international students.<br>
As part of the requirements of the Tuition Protection Service, SLIT maintains an account exclusively for tuition fees received from international students studying on a student visa. SLIT pays any tuition fees received from student visa holders into this account within 5 working days of receiving these fees.<br>
SLIT ensures that there is always a sufficient balance within this account to repay tuition fees to all non-commenced students that have applied to study on a student visa. The money held in this account is unable to be used to cover any other debts and money is only moved from this account once a student has commenced each of the study periods defined for their selected course.</span></span></div>
<span style="font-size:8.3pt"><span style="color:#333333">Students do have the right to elect to pay more than $1500 and must tick the option available as part of the signature block of this agreement.<br>
<strong>Compulsory Recording of Tuition Fees Paid</strong><br>
SLIT must record all tuition fees paid by international students in the Provider Registration and International Student Management System (PRISMS) monthly.<br>
<strong>6. Refund policy</strong></span></span>
<div style="text-align:justify"><span style="font-size:8.3pt"><span style="color:#333333">In the unlikely event of default by SLIT, the provisions of the ESOS Act 2000 and the ESOS Regulations 2001 cover such situations. In the circumstances of provider default where the refund option is chosen by the student, SLIT must refund the student all course fees.<br>
This written agreement, and the right to make complaints and seek appeals of decisions and action under various processes, does not affect the rights of the student to take action under the Australian Consumer Law if the Australian Consumer Law applies.<br>
For the full refund policy or to claim a refund please refer to the Student Handbook available at http://www.slit.edu.au.  A refund will be honoured by SLIT within 28 days of the request and only to the person who paid for himself/herself or on behalf of a student. The request for a refund is done by contacting SLIT via email at admission@slit.edu.au or by phone at +61 3 91250 1661.</span></span></div>
<span style="font-size:8.3pt"><span style="color:#333333"><strong>Provider Default Occurs</strong> <br>
Under section 46A of the ESOS Act a registered provider defaults, in relation to an overseas student or intending overseas student and a course at a location, if: </span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">The provider fails to start providing the course to the student at the location on the agreed starting day , or </span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">after the course starts but before it is completed, it ceases to be provided to the student at the location; and the student has not withdrawn from the course before the default day.</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong>Notifying the Secretary, the TPS Director and students</strong></span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Under section 46B of the ESOS Act, SLIT must notify the Secretary and the TPS Director of the default within 3 business days of the default occurring. Under section 46B SLIT must also notify students in relation to whom SLIT has defaulted.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The notices must be in writing and meet the requirements of section 46B.</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong>Provider obligation period</strong> </span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Under section 46D of the ESOS Act, SLIT has 14 days after the day of the default (the provider obligation period) to satisfy SLIT tuition protection obligations to the student as set out in the section.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">If SLIT fails to discharge its obligations to the student under section 46D, it is an offence under section 46E of the ESOS Act and serious penalties apply.</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong>Notification of the outcome- discharge of obligations</strong></span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Under section 46F of the ESOS Act, SLIT has 7 days after the end of its obligation period to give a notice to the Secretary and the TPS Director of the outcome of the discharge of its obligations. This notice must comply with the requirements of section 46F</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">If SLIT does not meet its obligations affected students may be assisted by the TPS Director.</span></span></li>
</ul>
<h4><span style="font-size:8.3pt"><span style="color:#333333"><strong>Purpose of Policy</strong></span></span></h4>
<span style="font-size:8.3pt"> <span style="color:#333333"> The purpose of this policy is to ensure that SLIT adopts a refund policy that is fair to students who have valid reasons for requesting refunds and who give SLIT sufficient notice, while at the same time protecting SLIT from suffering economic loss that may be caused by refund requests that are not submitted within the required timeframe.</span></span>
<h4><span style="font-size:8.3pt"><span style="color:#333333"><strong>Scope</strong></span></span></h4>
<span style="font-size:8.3pt"> <span style="color:#333333"> This policy and procedure apply to all the fees received from all the students enrolled by SLIT as well as fees received from all the prospective students who pay an advance fee when applying for a place at SLIT. As such this policy is also a part of Student Written Agreement.<br>
 <br>
This policy also applies to any education agents or college’s overseas offices collecting any student fees on behalf of SLIT.</span></span>
<h4><span style="font-size:8.3pt"><span style="color:#333333"><strong>Definitions</strong></span></span></h4>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong>Course</strong>: A program of study leading to a qualification or an award. A course may comprise of units or modules<br>
<strong>Study Period</strong>: means an academic term within a course. Usually, there are four study periods in a year.<br>
<strong>Tuition Fee</strong>: Covers the cost of providing the course of study and use of resources at SLIT. Tuition Fee does not include Overseas Student Health Cover (OSHC), administration costs including enrolment/application fee, home stay booking fee and airport pick-up fee and costs related to equipment or training material purchases<br>
<strong>Materials Fee</strong>: Covers the cost of learning materials and resources provided by SLIT<br>
<strong>Application Fee</strong>: Covers the administrative costs of enrolment<br>
<strong>Fees</strong>: A total of tuition, materials and application fees<br>
<strong>Pre-paid Tuition Fees</strong>: Tuition fees paid in advance prior to commencement of the course or a study period<br>
<strong>Principal Course of Study</strong>: Means the main or the final course of study to be undertaken by an overseas student where a student visa has been issued for multiple courses of study<br>
<strong>CoE Start Date</strong>: Refers to the day on which the course was scheduled to start, or a later day agreed upon between SLIT and the student – as mentioned in the Confirmation of Enrolment (CoE). Also referred to as the Agreed Start Date.<br>
<strong>Term Start Date</strong>: Date on which an academic term commences as per SLIT’s yearly academic program calendar. Academic program calendar is published on college’s website and also available from SLIT reception<br>
<strong>International Students</strong>: All those students who are on either on a student visa or a temporary visa that allows them to undertake formal studies in Australia<br>
<strong>TPS</strong>: Tuition Protection Scheme (enacted on 20th of March 2012 as part of the Government's second phase response to the Baird Review) replacing Tuition Assurance Scheme and ESOS Assurance Fund</span></span>
<h4><span style="font-size:8.3pt"><span style="color:#333333"><strong>Legislative Context</strong></span></span></h4>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">National Vocational Education and Training Regulator Act 2011 (Cth)</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The ESOS Act 2000</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The National Code 2018</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">ESOS Regulations 2001</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The Education Services for Overseas Students Legislation Amendment (Tuition Protection Service and Other Measures) Act 2012</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The Education Services for Overseas Students (Registration Charges) Amendment (Tuition Protection Service) Act 2012</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The Education Services for Overseas Students (TPS Levies) Act 2012</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The Australian Consumer Law 2011</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333">  </span></span><strong style="font-size:8.3pt">Policy</strong>
<ol>
<li><span style="font-size:8.3pt"><span style="color:#333333">The fees and charges required to be paid to SLIT by a student will be as specified in a signed written agreement between the student and SLIT that is entered into prior to the student commencing in the course(s) to which the agreement pertains.</span></span> <span style="font-size:8.3pt"> <span style="color:#333333">  </span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">SLIT shall publish an annual Fee Schedule listing all the tuition fees and charges, including refundable and non-refundable fees. This schedule will be available on SLIT’s website.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The only refundable fees are the tuition fees (unless otherwise stated in the student agreement against any fee/s listed). Fee refunds will be based on unexpended (unused) tuition fees.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where an enrolment change is necessitated by illness or other exceptional and compassionate circumstances beyond the student’s control and which prevent the student from completing studies in that study period, any refund of tuition fees is contingent upon approval of the refund by the CEO</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Fees and charges may be consolidated under a “package” if the student is enrolled in more than one course at SLIT. The types of fees and charges payable to SLIT by a student may include, without being limited to, the following:</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Tuition fees (including fees referred to as course or program fees)</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Materials fee</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Application fee</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Reassessment or unit re-sit fee</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Late payment fees or charges (e.g., Late Submissions Fee)</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Fees for services</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Fees for re-issuance of AQF certification</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">SLIT does not allow its education agents to collect any tuition fees on its behalf. In exceptional circumstances where payments to an agent are approved and made under specific written instructions of SLIT, SLIT will treat these payments as payments made to SLIT. The following refund conditions and procedures will apply to all the fees whether paid directly to SLIT or through an approved agent of SLIT. </span></span></li>
</ul>
</li>
</ol>
<h5><span style="font-size:8.3pt"><span style="color:#333333"><strong>          Full Refund of Tuition Fees</strong></span></span></h5>
<span style="font-size:8.3pt"> <span style="color:#333333"> All unexpended (unused) tuition fees will be refunded in full where:</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">The course does not start on the agreed starting date which is notified in the Letter of Offer;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The course stops being provided after it starts and before it is completed;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The Course is not provided fully to the student because SLIT has a sanction imposed by a government regulator; or</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">An offer of a place is withdrawn by SLIT and no incorrect or incomplete information has been provided by the student;</span></span></li>
</ul>
<br>
<span style="font-size:8.3pt"><span style="color:#333333">and in compassionate and compelling circumstances (supporting documents/evidence must be provided where possible) at any time where;</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">A student is unable to obtain a student visa; resulting in not being able to come to Australia;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Illness or disability prevents a student from taking up the course;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">A student is withdrawing due to a serious health issue/death of a close family member of the student; or</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where a student formally withdraws from a course <strong>more than eight (8) weeks </strong>before the CoE start date;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Other special or extenuating circumstances preventing a student from taking up or continuing the course, including political, civil or natural events, and personal well-being, will be considered on a case-to-case basis on review of the supporting evidence at the discretion of the CEO.</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333"> The Student will have the right to choose whether to seek a full refund of the fees, or to accept a place in another course. If the student chooses placement in another course, SLIT shall ask the student to sign a new student agreement to confirm acceptance of the placement.</span></span>
<h5><span style="font-size:8.3pt"><span style="color:#333333"><strong>            Additional Requirements for On-Shore and Transferring Students</strong></span></span></h5>
<h5><span style="font-size:8.3pt"><span style="color:#333333"><strong>     Partial Refund of Tuition Fees</strong></span></span></h5>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">On-shore students transferring to another provider or changing their visa status to any other visa (other than a Protection Visa) will not be eligible for a full refund. Partial refund to be considered as per clause below</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Partial refunds of the amounts specified below will be provided in the following circumstances:</span></span>
<h5><span style="font-size:8.3pt"><span style="color:#333333"><strong>Off-Shore Students (New Commencements)</strong></span></span></h5>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where a student formally withdraws from a course <strong>more than four (4) weeks </strong>before the CoE start date, 8<strong>0% </strong>of the tuition fees paid for that term or study period and any other unexpended (unused) or pre-paid tuition fees will be refunded.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where a student formally withdraws from a course <strong>less than four (4) weeks </strong>before the CoE start date,</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333"><strong>50% </strong>of the tuition fees paid for that term or study period and any other unexpended (unused) tuition fees will be refunded.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where a student formally withdraws from a course <strong>less than two (2) weeks </strong>before the agreed CoE start date, <strong>25% </strong>of the tuition fees paid for that term or study period and any other unexpended (unused) tuition fees will be refunded.</span></span></li>
</ul>
<h5><span style="font-size:8.3pt"><span style="color:#333333"><strong>On-Shore Students (Transferring Students)</strong></span></span></h5>
<span style="font-size:8.3pt"> <span style="color:#333333"> On-shore students transferring to another provider or changing their visa status to any other visa (other than a Protection Visa), <strong>will only be eligible for a maximum of 50% refund of the unexpended (unused) or pre-paid tuition fees </strong>in the following circumstances;</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where a student formally withdraws from a course four (4) weeks prior to course commencement, <strong>only 50% </strong>of the tuition fees paid for the course and any other unexpended (unused) or pre-paid tuition fees will be refunded;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where a student formally withdraws from a course after commencement and prior to four (4) weeks of the start date of an <strong>academic term </strong>(as per SLIT’s Academic Calendar published on the college website) <strong>only 50% </strong>of the tuition fees paid for that term or study period and any other unexpended (unused) or pre-paid tuition fees will be refunded;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">On-shore students who defer commencement of their studies will not be eligible for any refunds for the deferred term.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where compassionate and compelling circumstances apply beyond student’s control, refunds will be considered on a case-to-case basis on review of the supporting evidence at the discretion of the CEO.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">On-Shore students who withdraw less than four (4) weeks prior to course commencement or start of an academic term shall not be eligible for any refund.</span></span></li>
</ul>
<h5><span style="font-size:8.3pt"><span style="color:#333333"><strong>No Refund of Fees</strong></span></span></h5>
<span style="font-size:8.3pt"> <span style="color:#333333"> In certain circumstances, students will not be entitled for a refund of tuition fees. These circumstances include;</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Where a student formally withdraws from;</span></span></li>
</ul>
<span style="font-size:8.3pt"><span style="color:#333333">a single course within SLIT; or</span></span><br>
<span style="font-size:8.3pt"><span style="color:#333333">the first course within a packaged program comprised of two or more courses within one or more SLIT schools/institutions</span></span> <span style="font-size:8.3pt"> <span style="color:#333333"> <strong>after the CoE start date</strong>, the student will not be entitled for a refund and will still be liable for the tuition fee for that/current term or study period. Any other unexpended (unused) or pre-paid tuition fees for future terms/study periods will be refunded as per the terms of this refund policy;</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Leave of absence, deferral, and suspension of studies do not entitle a student for a refund of tuition fees for the duration for which such absence, deferment or suspension were affected;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">A student whose enrolment is either suspended or cancelled by SLIT for academic and personal misconduct during an enrolment period, including but not limited to misbehaviour or non-payment of fees to SLIT, shall not be eligible for a refund for that term;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">A Student whose visa is cancelled by Department of Human Affairs (DHA – formally DIBP) during an enrolment period while in Australia for any reason (other than issuance of a Protection Visa) shall not be</span></span></li>
<li>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">A student, who supplies incorrect or fraudulent information or document to obtain a place at SLIT, shall not be eligible for a refund.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Any fees listed as “non-refundable” in the student letter of offer, or the student agreement (written agreement) shall not be part of any refund.</span></span></li>
</ul>
</li>
</ul>
<h5><span style="font-size:8.3pt"><span style="color:#333333"><strong>Penalties for Non-payment or Late Payment of Fees</strong></span></span></h5>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">A late payment charge of $50 may apply where a student (or their agent in case of an international student) has not paid tuition fees by the fee due date notified to the student.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">A student who has outstanding fees owing to SLIT will not be permitted further enrolment (except where any Commonwealth or State legislation or code of practice provides otherwise) and will have their academic results withheld (as such will not be eligible to graduate) until the fee debt is paid in full.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">A student who has not paid tuition fees by the fee due date may have their enrolment cancelled at SLIT.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">A student whose enrolment has been cancelled due to non-payment of fees may apply for reinstatement of the enrolment at any time, provided the student pays in full any outstanding amount owing to SLIT.</span></span></li>
</ul>
<h4><span style="font-size:8.3pt"><span style="color:#333333"><strong>Procedure for Claiming Refunds</strong></span></span></h4>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">All refund claims must be submitted in writing via college’s Refund Request Form accompanied by appropriate supporting documents as specified to SLIT reception.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">All refund applications must be made and signed in person by the student. Where it is not possible for a student to be present in person (e.g. students residing overseas or international students) to claim a refund, the student must send a scanned copy of their signed forms to the Student Admissions Officer either by email or facsimile. On receipts of email or facsimile applications, the Student Admissions Officer will verify student’s signatures on records and may also telephone the student to verify student’s identity. No refunds will be made on email or facsimile applications until the time when student’s identity has been verified.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">All applications for the refund will be authorised by the Chief Executive Officer or the Finance Manager.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">When an amount is refunded to an international student, SLIT will provide the student with a statement explaining how the refund amount has been calculated.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">A refund of fees in relation to an international student will be made in the same currency in which the fees were paid and be made to the party who entered into the written agreement with SLIT, unless that person directs SLIT otherwise in writing.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">In normal circumstance, SLIT will refund the amount within four (4) weeks after receipt of the completed and signed Refund Request Form together with appropriate supporting documents.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Payments will be made to students by electronic transfer in their nominated bank accounts.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">For any refund to be paid to any other person than the students, a written authorisation from the student will</span></span></li>
</ul>
<h4><span style="font-size:8.3pt"><span style="color:#333333"><strong>Grievances and Appeals</strong></span></span></h4>
<span style="font-size:8.3pt"> <span style="color:#333333"> A student may appeal against a decision made with respect to fees, including refunds, and the appeal must be lodged in writing according to the processes for appeals as detailed in the Student Complaints and Appeals Policy and Procedure.<br>
Availability of SLIT’s complaints and appeals processes does not remove the right of a student or an intending student to take action under Australia’s consumer protection laws or to lodge an appeal with a relevant external body or to take other legal action.</span></span>
<h4><span style="font-size:8.3pt"><span style="color:#333333"><strong>Responsibility</strong></span></span></h4>
<span style="font-size:8.3pt"> <span style="color:#333333"> </span><span style="color:#333333"> The Accounts Payable Officer has the responsibility to process the refund claims and provide the student details and fee status to CEO for approval.<br>
CEO has the responsibility to make a final decision about all the refund claims.<br>
CEO has the responsibility to effectively implement the policy and maintain this policy and procedure.<br>
Any enquiries or complaints regarding fee related matters should be forwarded to the accounts Team at – </span><a href="mailto:accounts@slit.edu.au"><span style="color:#333333">accounts@slit.edu.au</span></a><br>
<span style="color:#333333">Any complaints or breaches in relation to this policy should be reported to the Chief Executive Officer in person or by email to: </span><a href="mailto:ceo@slit.edu.au"><span style="color:#333333">ceo@slit.edu.au</span></a><br>
<span style="color:#333333"> <br>
<strong>7. English Language &amp; Entry Requirements</strong><br>
To enter SLIT course all students must have a minimum IELTS score of 6.0 in total with no band under 5.5 points (or equivalent). Students must have a minimum of year 12 (or equivalent) and be 18 years or older. Evidence in the form of original or certified documents must be provided upon registration. Courses are delivered in English which includes technical and specific terms. All student prior to commencement must undertake a Language, Literacy and Numeracy test via </span><a href="https://quiz.llnrobot.com.au/"><span style="color:#333333">https://quiz.llnrobot.com.au</span></a><span style="color:#333333"> This is to determine if any additional LLN support maybe need for the individual student.<br>
<strong>8. Permission to work</strong><br>
If you and your family members are granted student visas you will be allowed to work up to 40 hours per fortnight once your course has commenced. Neither you nor your family members may commence work until you (the principal visa holder) have commenced studying. While the course you are studying is in session, you cannot work more than 40 hours per fortnight. You can work an unlimited number of hours during recognised periods of vacation, which are set and advised in advance by your education provider. Family members will be allowed to work up to 40 hours per fortnight throughout the year.<br>
<strong>9. Unique Student Identifier</strong><br>
All students studying in Australia are required to hold a USI number. As a student of SLIT, you will be required upon commencement to provide SLIT with this number. You can provide SLIT permission to apply for this number for you. The permission form is located as part of your application form or alternatively, contact Student Support upon arrival to assist. Additional information about the USI can be found at </span><a href="http://www.usi.gov.au/"><span style="color:#333333">www.usi.gov.au</span></a><br>
<span style="color:#333333"><strong>10. Deferment, Suspension and Cancellation of Enrolment</strong><br>
In compliance with the requirements of the National Code 2018, SLIT may defer, temporarily suspend or cancel the enrolment of a current student for the following reasons:</span></span>
<ol>
<li><span style="font-size:8.3pt"><span style="color:#333333">Compassionate or compelling reasons that are deemed out of the student's control (for example prolonged illness wherein a medical certificate clearly deems student unfit to study for an extended period)</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Misbehaviour or misconduct by the student and/or under strict disciplinary action</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Failure to make payment of fees on time as per the payment schedule defined on the letter of offer.</span></span></li>
</ol>
<span style="font-size:8.3pt"> <span style="color:#333333"> Cancellation or suspension of student CoE may affect the student visa. Students will be notified in writing of SLIT's 'Intention to Report' to DHA for not meeting Student Visa conditions. The student has the right to appeal within 20 days (of the issued letter of 'Intention to Report') the decision through SLIT's internal complaints and appeals policy.<br>
<strong>11. Approved Leave</strong><br>
DHA will only permit approval for leave for major illness, accident, or exceptional compassionate circumstances. DHA does not accept reasons such as weddings, pregnancy and childbirth, cultural and religious activities as acceptable reasons for leave. The length of approved leave is to be strictly connected with the reason for the leave. Students are required to apply in writing for approved leave and submit any supporting documents. If leave is granted beyond two-weeks students will be required to defer their studies for the duration of the leave period and reapply at DHA for their visa once the leave is completed.<br>
<strong>12. Transfer Between Registered Providers</strong><br>
Students are not allowed to transfer to a different provider until they have completed six (6) months of their principal course as outlined in Standard 7 of the National Code 2018 and the SLIT Student Transfer Policy. A 'transfer' is equal to a 'withdrawal'. SLIT will grant a letter of release only if SLIT is unable to continue to provide the course or the student has had a change in welfare and accommodation arrangements and is no longer within reasonable travelling time to SLIT.<br>
<strong>13.Complaints and Appeals</strong><br>
In the event of a dispute between an individual student and SLIT, a formal complaints policy and procedure is in place to facilitate a resolution to the matter. The SLIT Complaints policy outlines that:</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">You are given the opportunity to present your case at no cost</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">You may be accompanied and assisted by a support person at any stage of the process</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">The complaints process must commence within 10 days of the formal lodgement of your complaint in writing with supporting evidence and that all reasonable measures are taken to finalise the process as soon as is practicable</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">You will be supplied with a written statement of the outcome including details of the reasons for the outcome You have the right to appeal the outcome decision within 7 days of notification of the outcome</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">You have to right to appeal an outcome decision via an external authority such as ASQA or the Overseas Ombudsman.</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333"> </span><span style="color:#333333">  The Complaints policy does not circumscribe the student's right to pursue other legal remedies. The Complaints policy is published in the Student Handbook that can be download from </span><a href="http://slit.edu.au/"><span style="color:#333333">http://slit.edu.au</span></a><br>
<strong>14. ESOS Framework</strong><br>
Australia has a reputation as a safe, progressive and dynamic place to study. We maintain this reputation by providing quality education delivered in accordance with the ESOS Framework, which is the consumer protection specifically developed for overseas students. A description of the ESOS framework is available at <u>https://internationaleducation.gov.au/regulatory-information/pages/regulatoryinformation.aspx</u>.<br>
Please note that information is collected by SLIT during each student's enrolment in order to meet its obligations under the ESOS framework. This is to ensure students' compliance with the conditions of their visas and their obligations under Australian immigration laws. The authority to collect this information is contained in the ESOS Framework. Information collected about each student during enrolment can be provided, in certain circumstances, to the Australian Government and designated authorities and, if relevant, the Tuition Protection Service. In other instances, information collected during enrolment can be disclosed without the student's consent where authorised or required by law.<br>
<strong>15.Publicity</strong><br>
As a student of SLIT and through the signing of this Acceptance Agreement you agree that photographs, videos, artwork or other works, as well as recorded or written testimonials and details of your achievements may be used by SLIT, or by a third party agent of SLIT, for promotional purposes including in its printed and online marketing materials and on any social media network such as Facebook, Instagram without further consent or notification; and you give consent to SLIT storing, or transferring this media across international borders.<br>
 You may at any time remove this agreement in writing and from time to time SLIT may request that you complete a Promotional Consent Form for specific marketing purposes. You agree that some of this media may never be deleted due to backup features.<br>
<strong> 16.Overseas Student Health Cover (OSHC)</strong><br>
Students studying on a student visa in Australia are required to have appropriate medical insurance for the duration of their stay within<br>
Australia. You can arrange this by yourself or SLIT Student Support can assist you with this. If you need SLIT to assist you with your OSHC requirements contact Student Support to discuss. Students can contact DHA to confirm medical insurance requirements for their visa. SLIT is not responsible for any student's medical expenses.<br>
<strong>17.Financial Loss</strong><br>
SLIT will not be held responsible for any financial loss that is incurred by the student in the event of any occurrence outside the control of the College, including but not limited to:</span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Changes to transport or other services including delays, suspension, industrial action (including strikes) or schedule changes Natural disasters, acts of terrorism, outbreaks of disease or warnings of outbreak of disease, or war</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Accident or illness involving the student or anyone else not employed by SLIT</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Breach of immigration regulations</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Breach of Australian or International law that results in arrest or conviction</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Cancellation of the course, accommodation arrangements or another service as a result of any of the above</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333"> <strong>18.Financial Capacity</strong><br>
During your studies with SLIT, we will require you from time to time to confirm that you are still able to maintain your financial capacity to continue paying for your study and living expenses.<br>
<strong>19.Changing Courses</strong><br>
Under the Student Visa (Subclass 500) all students are required to maintain enrolment with a course of study at the same or high AQF level for which their visa is granted. Students who are considering changing their course of study to a lower level AQF course will be in breach of their visa conditions and this may result in the Student Visa being cancelled by DHA. To change to a lower level AQF course a student must apply to DHA for a new visa and be granted the new visa before changing to said lower level AQF course.<br>
<strong>20.Change of Services</strong><br>
SLIT reserves its right to change particulars of the services that it offers including but not limited to changes to prices including tuition fees; material fees and general fees and charges, course offerings including course structure and length, facilitates, intake dates and dates of courses where circumstances that are beyond SLIT's control necessitate such changes to occur.<br>
<strong>21.Student Disciplinary Actions</strong><br>
All SLIT students are subject to the SLIT disciplinary policy and procedure and to Australian Law. SLIT reserves the right to expel any student who are considered to have contravened these conditions. In this situation SLIT will notify DHA within 24 hours and if the situation requires it State or Federal Law Enforcement and will not issue any fee refunds in such a situation.<br>
<strong>22.Privacy Statement</strong><br>
Under the Data Provision Requirements 2012, Skyline Institute of Technology is required to collect personal information about you and to disclose that personal information to the National Centre for Vocational Education Research Ltd (NCVER).<br>
Your personal information (including the personal information contained on this enrolment form), may be used or disclosed by SLIT for statistical, administrative, regulatory and research purposes. SLIT may disclose your personal information for these purposes to:</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Commonwealth and State or Territory government departments and authorised agencies; and NCVER.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Personal information that has been disclosed to NCVER may be used or disclosed by NCVER for the following purposes: populating authenticated VET transcripts;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Facilitating statistics and research relating to education, including surveys and data linkage;</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Pre-populating RTO student enrolment forms;</span></span></li>
</ul>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Understanding how the VET market operates, for policy, workforce planning and consumer information; and administering VET, including program administration, regulation, monitoring, and evaluation.</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333"> </span><span style="color:#333333"> You may receive a student survey which may be administered by a government department or NCVER employee, agent or third-party contractor or other authorised agencies. Please note you may opt out of the survey at the time of being contacted.<br>
NCVER will collect, hold, use and disclose your personal information in accordance with the Privacy Act 1988 (Cth), the National VET Data Policy and all NCVER policies and protocols (including those published on NCVER's website at </span><a href="http://ahsi.rtomanager.com.au/WeCoReports/www.ncver.edu.au"><span style="color:#333333">www.ncver.edu.au</span></a><span style="color:#333333">).<br>
SLIT will retain records of all written agreements as well as receipts of payment made by students under this written agreement for a minimum of 2 years after the person ceases to be an accepted student.<br>
<br> <strong>Acceptance by Applicant</strong><br>
I have read this acceptance agreement and I confirm that I understand the following in relation to accepting this offer.</span></span>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">I acknowledge that the acceptance agreement also constitutes a written agreement between SLIT and myself as defined in Standard 3 of the National Code 2018</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I have included my required pre-paid deposit and I am aware that I may elect to pay more as the pre-paid deposit and must indicate such in the signature block of this agreement</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I will always be enrolled as a full-time student</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I am aware that the program is not a scholarship, employment, or immigration program.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">As an international student, I must fund my entire studies independently and leave Australia when my studies are completed and /or when my visa expires.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I must make satisfactory academic progress. If I do not do this, SLIT has the right to cancel my enrolment.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I must attend at least 80% of all scheduled classes in each study period. This is a visa condition and if I do not do this, I will be in breach of my visa conditions and SLIT may cancel my enrolment.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I must pay tuition fees according to the tuition fee payment schedule outlined in this document. This is a condition of my ongoing enrolment. Failure to pay my fees on time may result in cancellation of my enrolment. I agree to be severally liable to the debts arising from fees owing.</span></span></li>
<li><span style="font-size:8.3pt">By accepting this offer, I agree to adhere to the specified tuition payment plan. Should my payments fall into arrears, SLIT is authorized to forward my personal and account information to a debt collection agency for the purpose of recovering the overdue amount. I will be held responsible for paying the full outstanding balance, in addition to any administrative or collection fees that arise from this process.</span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">In signing this acceptance agreement, I permit SLIT to take pictures/videos of academic activities and use it for SLIT's promotional purposes. These pictures and videos or any such material created involving students remains the property of SLIT and SLIT does not owe any monetary benefits towards its students for any promotional material that has been created</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I have read the information provided about the ESOS framework and I understand the key provisions. I must meet the costs of Overseas Student Health Cover for the period of my enrolment and will provide evidence of cover at my induction.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I must fulfill the requirements of my Student Visa as specified by the Australian government and those conditions are outlined in this acceptance.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I must provide SLIT with my address in Australia and a local telephone number on which I am able to be contacted. I must notify SLIT of any change of address while I am enrolled in the above course(s). This notification must be provided within 5 days.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I cannot transfer to another institution within the first six (6) months of my arrival in Australia (or if my program is of less than six month's duration) unless I have a letter of offer from another provider and I am being granted a release letter by SLIT. The National Code 2018 restricts the movement of students between registered providers, and SLIT will provide a release letter only under exceptional circumstances, where it is considered in the best interest of the student.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I understand that in accordance with the Education for Overseas Students Act 2000, SLIT is required to advise the Department of Home Affairs if I do not meet any of these conditions.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I am aware that as a student studying in Australia, I am required to hold a USI number and to provide that number to SLIT upon commencement of my course</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I acknowledge SLIT is not responsible or liable for personal injury whilst I attend the college (including the time spent in class or on excursions, and travel to and from the college).</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I must not plagiarise, collude, or cheat in the development of submissions for assessment tasks. This is a condition of ongoing enrolment. I understand that if the SLIT Management determines that I have been involved in plagiarism, collusion or cheating in the development of the submission for an assessment task, penalties may apply which include the recording of an unsatisfactory outcome for the assessment task, suspension or cancellation of enrolment.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">In the event of an emergency, I give my permission to be treated by a member of SLIT staff qualified in First Aid until Emergency Services arrive</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I understand that SLIT is obliged by law to keep confidential student records on file for administrative purposes only.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">I have received clear and sufficient information about RPL and credit transfer</span></span></li>
</ul>
<br>
<br> <strong>I understand and agree that if I study on a student visa, I must meet the following Student Visa conditions:</strong>
<ul>
<li><span style="font-size:8.3pt"><span style="color:#333333">Maintain a full-time enrolment in my course for 20 hours per week. Maintain at least an 80% attendance record.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Maintain and achieve satisfactory academic course progress.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Maintain payment of Tuition fees by the commencement of each term or as per specified dates within the payment schedule contained within this letter of offer.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Maintain the appropriate level of OSHC coverage for the duration of my stay in Australia.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Notify SLIT and DHA within 7 days of any change to my residential address, postal address and or contact details.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Not exceed 40 hours of paid work per fortnight on days when I do not need to attend my course and not commence any form of work until after the commencement of my course.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Remain enrolled with SLIT for the first 6 months of my principal course.</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Notify SLIT within 5 days if you are changing to another provider</span></span></li>
<li><span style="font-size:8.3pt"><span style="color:#333333">Notify SLIT if I have been absent for more than 3 consecutive days</span></span></li>
</ul>
<span style="font-size:8.3pt"> <span style="color:#333333"> </span><span style="color:#333333"> <strong><em>Please note under Standard 3 clause 3.4.5 of National code of practice for Provider of Education and Training to Overseas Students 2018 “This written agreement, and the right to make complaints and seek appeals of decisions and action under various processes, does not affect the rights of the student to take action under the Australian Consumer Law if the Australian Consumer Law applies”.</em></strong><br>
To accept the enrolment offer made to you, please read this agreement carefully, sign it and return it with evidence of your payment to SLIT by emailing it to </span><a href="mailto:admission@slit.edu.au"><span style="color:#333333">admission@slit.edu.au</span></a><br>
<span style="color:#333333">You must also read the Student Handbook which is available on the SLIT web site </span><a href="http://slit.edu.au/"><span style="color:#333333">https://slit.edu.au</span></a><br>
<span style="color:#333333">You will have to sign the last page of this Student Handbook at Orientation time to confirm that you have read, understood, and agreed to its conditions.<br>
These Terms and Conditions do not circumscribe the Student's right to pursue any other legal remedies.<br>
<strong>I elect to pay more than the SLIT required pre-paid fee:   YES              NO   </strong></span></span><br>
 
<table style="width:100%">
<tbody>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>Student's Name:</strong></span></span></td>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>{{student.full_name}}                                                              </strong></span></span></td>
</tr>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>Date of Birth:</strong></span></span></td>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>{{student.dob}}</strong></span></span></td>
</tr>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>Student Signature:</strong></span></span></td>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>        <br>
           </strong></span></span></td>
</tr>
<tr>
<td><span style="font-size:8.3pt"><span style="color:#333333"><strong>Date:</strong></span></span></td>
<td><span style="font-size:8.3pt"><span style="color:#333333"></span></span></td>
</tr>
</tbody>
</table>
<span style="font-size:8.3pt"> <span style="color:#333333">                                          </span></span><br>
 
<div>
<table>
<tbody>
<tr>
<td colspan="7" style="width:684pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>ADMIN USE ONLY</strong></span></span></td>
</tr>
<tr>
<td colspan="7" style="width:684pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Offer</strong></span></span></td>
</tr>
<tr>
<td colspan="2" style="width:227.3pt"><span style="font-size:8.3pt"><span style="color:#333333"> ACCEPTED  </span></span></td>
<td colspan="3" style="width:226.5pt"><span style="font-size:8.3pt"><span style="color:#333333">DEFERRED   </span></span></td>
<td colspan="2" style="width:226.5pt"><span style="font-size:8.3pt"><span style="color:#333333">DECLINED   </span></span></td>
</tr>
<tr>
<td colspan="7" style="width:684pt"><span style="font-size:8.3pt"><span style="color:#333333"><strong>Payment</strong></span></span></td>
</tr>
<tr>
<td style="width:225pt"><span style="font-size:8.3pt"><span style="color:#333333">Payment Made:</span></span></td>
<td colspan="2" style="width:112.5pt"><span style="font-size:8.3pt"><span style="color:#333333">Yes   </span></span></td>
<td style="width:75pt"><span style="font-size:8.3pt"><span style="color:#333333">No   </span></span></td>
<td colspan="2" style="width:112.5pt"><span style="font-size:8.3pt"><span style="color:#333333">Date:</span></span></td>
<td style="width:75pt"> </td>
</tr>
</tbody>
</table>
</div>
</li>
</ul>
</div><br>$legacy$,
   public.letter_standard_header(), public.letter_standard_footer(), 'text', 'student', 'student_offer_letter', true, false, v_admin)
 returning * into t;
 v_unmapped := public.letter_template_unmapped(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html));
 if t.status <> 'active' or cardinality(v_unmapped) > 0 then raise exception 'The SLIT letter has unmapped tokens: %', v_unmapped; end if;
 insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), v_admin);
end $$;


/* ------------------------------------------------------------------ issuing: the several-courses part */
-- As 20261113270000; the variables of {{#if multiple_courses}} parts count only for an application with more than one course.
create or replace function public.portal_offer_letter_issue_template(p_application uuid, p_template uuid, p_template_version integer, p_file_name text, p_content_base64 text, p_manual jsonb DEFAULT '[]'::jsonb, p_conditions text DEFAULT ''::text, p_message text DEFAULT ''::text, p_override_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
declare a public.enrollment_applications; t hr.sign_templates; v_unmapped text[]; v_keys text[]; v_vals jsonb; k text; r public.letter_variables; m jsonb;
 v_missing text[] := '{}'; v_manual jsonb := '[]'::jsonb; v_used jsonb := '{}'::jsonb; v_bytes bytea; v_route jsonb; v_id uuid; v_name text; v_mismatch boolean;
 v_notes text[] := '{}'; v_conditions text;
begin
 select * into a from public.enrollment_applications where id = p_application for update;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 if not exists (select 1 from public.application_status_actions x where x.actor = 'staff' and x.from_status = a.status and x.kind = 'offer_letter') then
  raise exception 'An offer letter cannot be issued while the application is %', public.portal_status_label(a.status) using errcode = '22023';
 end if;
 select * into t from hr.sign_templates where id = p_template and category = 'student_offer_letter' and deleted_at is null;
 if not found then raise exception 'Choose an offer letter template' using errcode = '22023'; end if;
 if t.status <> 'active' then raise exception 'The template "%" is inactive', t.name using errcode = '22023'; end if;
 if t.version is distinct from p_template_version then raise exception 'The template "%" changed since the preview was made. Refresh the preview', t.name using errcode = '40001'; end if;
 v_unmapped := public.letter_template_unmapped(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html));
 if cardinality(v_unmapped) > 0 then raise exception 'The template has unmapped variables: %', array_to_string(v_unmapped, ', ') using errcode = '22023'; end if;

 -- {{#if multiple_courses}} ... {{/if}} prints only for an application with more than one course: its variables are not asked for otherwise.
 v_keys := public.letter_template_keys(case when (select count(*) from public.enrollment_application_courses x where x.application_id = a.id) > 1
   then concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html)
   else regexp_replace(concat_ws(' ', t.title, t.header_html, t.body_html, t.footer_html), '\{\{\s*#if multiple_courses\s*\}\}.*?\{\{\s*/if\s*\}\}', '', 'g') end);
 v_vals := public.application_letter_values(a.id) -> 'values';
 v_conditions := coalesce(nullif(btrim(coalesce(p_conditions, '')), ''), 'Nil');
 foreach k in array v_keys loop
  select * into r from public.letter_variables where key = k;
  if r.source_kind = 'render' then continue; end if;
  if r.source_kind = 'entered' then v_used := v_used || jsonb_build_object(k, v_conditions); continue; end if;
  select x into m from jsonb_array_elements(coalesce(p_manual, '[]'::jsonb)) x where x->>'key' = k limit 1;
  if not coalesce((v_vals -> k ->> 'missing')::boolean, true) and coalesce(m->>'mode', '') <> 'letter' then
   v_used := v_used || jsonb_build_object(k, v_vals -> k ->> 'value');
   if m->>'mode' = 'source' then
    v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', left(v_vals -> k ->> 'value', 500), 'mode', 'source', 'by', auth.uid(), 'at', now()));
    v_notes := v_notes || (r.label || ' (saved to ' || r.source_label || ')');
   end if;
   continue;
  end if;
  if m is not null and m->>'mode' in ('letter', 'source') and nullif(btrim(coalesce(m->>'value', '')), '') is not null then
   v_used := v_used || jsonb_build_object(k, left(btrim(m->>'value'), 2000));
   v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', left(btrim(m->>'value'), 500), 'mode', 'letter', 'by', auth.uid(), 'at', now()));
   v_notes := v_notes || (r.label || ' (this letter only)');
  elsif m is not null and m->>'mode' = 'blank' and not r.required then
   v_used := v_used || jsonb_build_object(k, '');
   v_manual := v_manual || jsonb_build_array(jsonb_build_object('key', k, 'label', r.label, 'value', '', 'mode', 'blank', 'by', auth.uid(), 'at', now()));
   v_notes := v_notes || (r.label || ' (left blank)');
  else
   v_missing := v_missing || r.label;
  end if;
 end loop;
 if cardinality(v_missing) > 0 then
  raise exception '% detail(s) missing: %', cardinality(v_missing), array_to_string(v_missing, ', ') using errcode = '22023';
 end if;

 begin v_bytes := decode(coalesce(p_content_base64, ''), 'base64'); exception when others then raise exception 'The letter is not a PDF' using errcode = '22023'; end;
 if v_bytes is null or length(v_bytes) < 5 or substring(v_bytes from 1 for 5) <> '\x255044462d'::bytea then raise exception 'The letter is not a PDF' using errcode = '22023'; end if;
 if length(v_bytes) > 3145728 then raise exception 'The letter is larger than 3 MB' using errcode = '22023'; end if;
 v_mismatch := public.application_declaration_mismatch(a.id);
 if v_mismatch and nullif(btrim(coalesce(p_override_note, '')), '') is null then
  raise exception 'The declarant name and digital signature do not match. Add a note to issue the offer letter anyway' using errcode = '22023';
 end if;
 v_route := public.application_offer_recipient(a.id);
 if coalesce(v_route->>'email', '') = '' then raise exception 'There is no email address to send the offer letter to' using errcode = '22023'; end if;
 select coalesce((select p.full_name from public.portal_profiles p where p.auth_user_id = auth.uid() limit 1), (select c.name from public.cms_users c where c.auth_user_id = auth.uid() limit 1), auth.jwt()->>'email', '') into v_name;
 insert into public.enrollment_offer_letters(application_id, tenant_id, source, template_id, file_name, size_bytes, sha256, content, message, override_note,
   recipient_kind, recipient_name, recipient_email, issued_by, issued_by_name, template_name, template_version, variable_values, manual_values)
 values (a.id, a.tenant_id, 'template', t.id, left(coalesce(nullif(btrim(p_file_name), ''), 'Offer letter.pdf'), 200), length(v_bytes), encode(extensions.digest(v_bytes, 'sha256'), 'hex'), v_bytes,
   left(coalesce(p_message, ''), 2000), left(coalesce(p_override_note, ''), 500), v_route->>'kind', coalesce(v_route->>'name', ''), v_route->>'email', auth.uid(), coalesce(v_name, ''),
   t.name, t.version, v_used, v_manual)
 returning id into v_id;
 perform set_config('portal.offer_command', a.id::text, true);
 perform public.portal_set_application_status(a.id, 'offer_issued',
   left(concat_ws(' · ', 'Offer letter sent to ' || (v_route->>'kind') || ' ' || (v_route->>'email') || ' (template "' || t.name || '" v' || t.version || ')', nullif(btrim(p_message), ''),
     case when cardinality(v_notes) > 0 then 'Filled by hand: ' || array_to_string(v_notes, '; ') end,
     case when v_mismatch then 'Declaration mismatch accepted: ' || btrim(p_override_note) end), 1000));
 perform set_config('portal.offer_command', '', true);
 return jsonb_build_object('id', v_id, 'recipient', v_route, 'manual', v_manual);
end $function$;
