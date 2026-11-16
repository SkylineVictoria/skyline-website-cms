-- OFFER-LETTER-SOURCES (owner brief 2026-11-16): every course / intake / fee value of the offer letter comes from LMS by itself.
--  1. Hours per week come from the chosen intake's study load (CoE 20, VoE 40); the fee setup's text only when the intake has none.
--  2. The orientation day is a date (course_fee_setups.orientation_date; existing text values that parse as a date are migrated),
--     printed like the other dates and edited with a date picker; the per-intake fee setup row overrides the course's.
--  3. Agency details: a direct student's application belongs to the institute's own "direct" agency, which was skipped, so the agency
--     variables came back missing. The direct agency's name is used, and its blank email / phone / address fall back to Website settings.
-- Additive: one column, letter_variables rows updated, four functions redefined (restated from hosted 2026-11-16 with these changes).

alter table public.course_fee_setups add column if not exists orientation_date date;

do $$
declare f record; d date;
begin
  for f in select id, orientation from public.course_fee_setups where orientation_date is null and nullif(btrim(orientation), '') is not null loop
    d := null;
    begin
      if btrim(f.orientation) ~ '^\d{4}-\d{2}-\d{2}' then d := left(btrim(f.orientation), 10)::date;
      elsif btrim(f.orientation) ~ '^\d{1,2}/\d{1,2}/\d{4}' then d := to_date(substring(btrim(f.orientation) from '^\d{1,2}/\d{1,2}/\d{4}'), 'DD/MM/YYYY');
      end if;
    exception when others then d := null; end;
    if d is not null then update public.course_fee_setups set orientation_date = d where id = f.id; end if;
  end loop;
end $$;

update public.letter_variables set format = 'date', input_type = 'date', description = 'The orientation day of the chosen intake (Course setup › Fees, per intake or for every intake), printed as a date'
 where key = 'course.orientation';
update public.letter_variables set source_label = 'Course setup › Intakes › Students on (CoE 20 / VoE 40 hours a week)',
 description = 'Class hours a week from the chosen intake''s study load: CoE 20, VoE 40. Only an intake without a study load falls back to Course setup › Fees'
 where key = 'course.hours_per_week';

create or replace function public.cms_course_fees(p_course text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'intakeId', f.intake_id, 'tuition', f.tuition_fee, 'enrolment', f.enrolment_fee, 'material', f.material_fee,
   'oshc', f.oshc_fee, 'deposit', f.deposit, 'paymentPlan', f.payment_plan, 'campus', f.campus, 'orientation', f.orientation, 'orientationDate', f.orientation_date,
   'hoursPerWeek', f.hours_per_week, 'updatedAt', f.updated_at)
   order by f.intake_id nulls first) from public.course_fee_setups f where f.course_id = p_course), '[]'::jsonb);
end $$;

create or replace function public.cms_course_fee_save(p_course text, p_intake uuid, p_data jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.cms_courses; f public.course_fee_setups; v_orient date;
 num constant text := '^\s*[0-9]{1,9}(\.[0-9]{1,2})?\s*$';
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can do this.' using errcode = '42501'; end if;
 select * into c from public.cms_courses where id = p_course;
 if not found then raise exception 'Course not found' using errcode = '22023'; end if;
 if p_intake is not null and not exists (select 1 from public.course_intakes i where i.id = p_intake and i.course_id = p_course) then raise exception 'The intake is not one of this course''s' using errcode = '22023'; end if;
 if exists (select 1 from jsonb_each_text(coalesce(p_data, '{}'::jsonb) - 'paymentPlan' - 'campus' - 'orientation' - 'orientationDate' - 'hoursPerWeek') e where nullif(btrim(e.value), '') is not null and e.value !~ num) then
  raise exception 'Enter fees as amounts, for example 14500 or 14500.00' using errcode = '22023';
 end if;
 -- The orientation day: a date (YYYY-MM-DD from the date picker); anything else is refused.
 if nullif(btrim(coalesce(p_data->>'orientationDate', '')), '') is not null then
  if btrim(p_data->>'orientationDate') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose the orientation day from the calendar' using errcode = '22023'; end if;
  begin v_orient := btrim(p_data->>'orientationDate')::date; exception when others then raise exception 'Choose the orientation day from the calendar' using errcode = '22023'; end;
 end if;
 insert into public.course_fee_setups as x(tenant_id, course_id, intake_id, tuition_fee, enrolment_fee, material_fee, oshc_fee, deposit, payment_plan, campus, orientation, orientation_date, hours_per_week, updated_by)
 values (c.tenant_id, p_course, p_intake, nullif(btrim(p_data->>'tuition'), '')::numeric, nullif(btrim(p_data->>'enrolment'), '')::numeric, nullif(btrim(p_data->>'material'), '')::numeric,
   nullif(btrim(p_data->>'oshc'), '')::numeric, nullif(btrim(p_data->>'deposit'), '')::numeric, nullif(btrim(p_data->>'paymentPlan'), ''), nullif(btrim(p_data->>'campus'), ''),
   nullif(btrim(p_data->>'orientation'), ''), v_orient, nullif(btrim(p_data->>'hoursPerWeek'), ''), auth.uid())
 on conflict (course_id, intake_id) do update set tuition_fee = excluded.tuition_fee, enrolment_fee = excluded.enrolment_fee, material_fee = excluded.material_fee,
   oshc_fee = excluded.oshc_fee, deposit = excluded.deposit, payment_plan = excluded.payment_plan, campus = excluded.campus, orientation = excluded.orientation,
   orientation_date = excluded.orientation_date, hours_per_week = excluded.hours_per_week, updated_at = now(), updated_by = auth.uid()
 returning * into f;
 return to_jsonb(f);
end $$;

create or replace function public.application_letter_course(p_ac enrollment_application_courses, p_fmt text, p_settings cms_settings, p_intake_text text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.cms_courses; i public.course_intakes; fc public.course_fee_setups; fi public.course_fee_setups; r public.letter_variables; v_out jsonb := '{}'::jsonb;
 raw text; val text; src text; fee_src text; v_code text; v_name text; tuition numeric; enrol numeric; mat numeric; oshc numeric;
 v_scope uuid; v_items boolean := false; v_reg numeric; v_dep numeric; v_total numeric; v_gst numeric; v_app_label text; v_reg_label text; v_disc numeric := 0; v_disc_amt numeric := 0;
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
 -- COURSE-MGMT-2: a course variant (e.g. 52 Weeks) is printed with the name, so two records with one code stay distinguishable.
 if v_name <> '' then v_name := v_name || public.course_variant_suffix(v_name, c.variant_label); end if;
 tuition := coalesce(fi.tuition_fee, fc.tuition_fee); enrol := coalesce(fi.enrolment_fee, fc.enrolment_fee); mat := coalesce(fi.material_fee, fc.material_fee); oshc := coalesce(fi.oshc_fee, fc.oshc_fee);
 -- FEE-LOO: the fee lines (Master Data › Courses › Fees) are the source: the intake's override lines when it has any, else the course's.
 if c.id is not null then
  v_scope := case when p_ac.intake_id is not null and exists(select 1 from public.course_fee_items x where x.intake_id = p_ac.intake_id) then p_ac.intake_id end;
  v_items := exists(select 1 from public.course_fee_items x where x.course_id = c.id and x.intake_id is not distinct from v_scope);
 end if;
 if v_items then
  select sum(x.amount_cents) filter (where x.item_type in ('application', 'enrolment')) / 100.0, sum(x.amount_cents) filter (where x.item_type = 'registration') / 100.0,
   sum(x.amount_cents) filter (where x.item_type = 'material') / 100.0, sum(x.amount_cents) filter (where x.item_type = 'tuition') / 100.0,
   sum(x.amount_cents) filter (where x.item_type = 'oshc') / 100.0, sum(x.amount_cents) filter (where x.item_type = 'initial_deposit') / 100.0,
   coalesce(nullif(btrim(regexp_replace((array_agg(x.label order by x.sort) filter (where x.item_type in ('application', 'enrolment')))[1], '\s*\(non-refundable\)\s*$', '', 'i')), ''), 'Application fee')
    || case when coalesce(bool_and(x.refundable) filter (where x.item_type in ('application', 'enrolment')), false) then '' else ' (Non-Refundable)' end,
   coalesce(nullif(btrim(regexp_replace((array_agg(x.label order by x.sort) filter (where x.item_type = 'registration'))[1], '\s*\(non-refundable\)\s*$', '', 'i')), ''), 'Registration fee')
    || case when coalesce(bool_and(x.refundable) filter (where x.item_type = 'registration'), false) then '' else ' (Non-Refundable)' end
  into enrol, v_reg, mat, tuition, oshc, v_dep, v_app_label, v_reg_label
  from public.course_fee_items x where x.course_id = c.id and x.intake_id is not distinct from v_scope;
  v_total := public.course_fee_scope_total_cents(c.id, v_scope) / 100.0;
  v_gst := public.course_fee_scope_gst_cents(c.id, v_scope) / 100.0;
  fee_src := case when v_scope is not null then 'for intake ' || coalesce(nullif(i.label, ''), to_char(i.start_date, 'DD/MM/YYYY')) else 'for every intake' end;
 end if;
 v_disc := least(greatest(coalesce(p_ac.discount_percent, 0), 0), 100);
 v_disc_amt := case when tuition is null then 0 else round(tuition * v_disc / 100, 2) end;
 if v_items and v_total is not null then v_total := v_total - v_disc_amt; end if;
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
   when 'course.orientation' then
    -- OFFER-LETTER-SOURCES: the orientation day is a date (the intake's fee setup first, then the course's); an older text value still prints as written.
    raw := coalesce(coalesce(fi.orientation_date, fc.orientation_date)::text, nullif(btrim(coalesce(fi.orientation, fc.orientation)), ''), '');
    src := r.source_label || ' (' || case when fi.orientation_date is not null or (fi.orientation_date is null and fc.orientation_date is null and fi.orientation is not null) then 'for this intake' else 'for every intake' end || ')';
   when 'course.hours_per_week' then
    -- OFFER-LETTER-SOURCES: from the intake's study load (CoE 20, VoE 40); only an intake without one falls back to the fee setup's text.
    if i.study_load in ('coe', 'voe') then
     raw := case i.study_load when 'coe' then '20' else '40' end;
     src := 'Course setup › Intakes › Students on (' || upper(i.study_load) || ', ' || raw || ' hours a week)';
    else
     raw := coalesce(btrim(coalesce(fi.hours_per_week, fc.hours_per_week)), ''); src := 'Course setup › Fees › Hours per week (' || fee_src || ')';
    end if;
   when 'fees.tuition' then raw := coalesce(tuition::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.enrolment' then raw := coalesce(enrol::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.material' then raw := coalesce(mat::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.oshc' then raw := coalesce(oshc::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.deposit' then raw := case when v_items then coalesce(v_dep::text, '') else coalesce(coalesce(fi.deposit, fc.deposit)::text, '') end; src := r.source_label || ' (' || fee_src || ')';
   when 'fees.application' then raw := coalesce(enrol::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.application_label' then raw := coalesce(v_app_label, 'Application fee (Non-Refundable)');
   when 'fees.registration' then raw := coalesce(v_reg, 0)::text; src := r.source_label || ' (' || fee_src || ')';
   when 'fees.registration_label' then raw := coalesce(v_reg_label, 'Registration fee (Non-Refundable)');
   when 'fees.gst' then raw := coalesce(v_gst, 0)::text; src := r.source_label || ' (' || fee_src || ')';
   when 'fees.payment_plan' then raw := coalesce(coalesce(fi.payment_plan, fc.payment_plan), ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.total' then
    if v_items then raw := v_total::text; src := 'Master Data › Courses › Fees (total of the lines in the total, ' || fee_src || ')';
    else
    raw := coalesce(coalesce(fi.total_fee, fc.total_fee)::text, case when tuition is null then '' else (tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0))::text end);
    src := case when coalesce(fi.total_fee, fc.total_fee) is not null then 'Master Data › Courses › Total fee (' || fee_src || ')' else 'Course setup › Fees (sum, ' || fee_src || ')' end;
    end if;
   when 'fees.discount_percent' then raw := trim_scale(v_disc)::text || '%';
   when 'fees.discount_amount' then raw := v_disc_amt::text;
   when 'fees.tuition_after_discount' then raw := case when tuition is null then '' else (tuition - v_disc_amt)::text end; src := r.source_label || ' (' || fee_src || ')';
   else raw := '';
  end case;
  if r.key = 'fees.total' and v_disc_amt > 0 then
   if not v_items and raw ~ '^-?[0-9]+(\.[0-9]+)?$' then raw := (raw::numeric - v_disc_amt)::text; end if;
   src := src || ', less ' || trim_scale(v_disc) || '% discount';
  end if;
  val := case r.format when 'date' then public.letter_format_date(raw, p_fmt) when 'money' then case when raw ~ '^-?[0-9]+(\.[0-9]+)?$' then public.letter_format_money(raw::numeric) else raw end else raw end;
  v_out := v_out || jsonb_build_object(r.key, jsonb_build_object('value', coalesce(val, ''), 'raw', coalesce(raw, ''), 'source', src, 'missing', coalesce(btrim(val), '') = ''));
 end loop;
 return v_out || jsonb_build_object('_discount', v_disc > 0, '_courseId', c.id, '_intakeId', p_ac.intake_id, '_feeSetup', coalesce(fi.id, fc.id), '_title', coalesce(nullif(v_name, ''), p_ac.course_title),
   '_fees', v_items or tuition is not null,
   '_start', i.start_date, '_end', i.end_date, '_total', case when v_items then v_total else coalesce(fi.total_fee, fc.total_fee, case when tuition is null then null else tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0) end) - v_disc_amt end);
end $$;

create or replace function public.application_letter_values(p_application uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a public.enrollment_applications; v jsonb; st public.cms_settings; ac public.enrollment_application_courses; ag public.portal_profiles; agy public.agencies;
 fmt text; today date := (now() at time zone 'Australia/Melbourne')::date; v_out jsonb := '{}'::jsonb; r public.letter_variables; raw text; val text; src text;
 v_charges jsonb := '[]'::jsonb; v_courses jsonb := '[]'::jsonb; v_first jsonb := '{}'::jsonb; v_one jsonb; v_min date; v_max date; v_sum numeric := 0; v_sum_ok boolean := true; v_intake_text text;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return null; end if;
 v := coalesce(public.application_values(a.id), '{}'::jsonb);
 select * into st from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id order by s.id limit 1;
 if not found then select * into st from public.cms_settings s order by s.id limit 1; end if;
 fmt := coalesce(st.letter_date_format, 'DD/MM/YYYY');
 -- FEE-LOO: Settings › Other fees and charges ({{#each other_fees}} rows): the institution's own list, else the shared one.
 select coalesce(jsonb_agg(jsonb_build_object(
    'charges.label', jsonb_build_object('value', f.label, 'raw', f.label, 'source', 'Website settings › Other fees and charges', 'missing', false),
    'charges.amount', jsonb_build_object('value', public.letter_other_fee_amount(f.amount_cents), 'raw', coalesce(f.amount_cents::text, ''), 'source', 'Website settings › Other fees and charges', 'missing', false))
   order by f.sort, f.label), '[]'::jsonb)
 into v_charges from public.letter_other_fees f
 where f.is_active and f.tenant_id is not distinct from (case when exists(select 1 from public.letter_other_fees g where g.tenant_id = a.tenant_id) then a.tenant_id end);
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
 -- OFFER-LETTER-SOURCES: the application's agency, the institute's own "direct students" agency included (its blank details fall back to Website settings below).
 select * into agy from public.agencies x where x.id = a.agency_id;

 for r in select * from public.letter_variables order by sort loop
  if v_first ? r.key then v_out := v_out || jsonb_build_object(r.key, v_first -> r.key); continue; end if;
  if r.key like 'charges.%' then
   v_out := v_out || jsonb_build_object(r.key, coalesce(v_charges -> 0 -> r.key, jsonb_build_object('value', '', 'raw', '', 'source', r.source_label, 'missing', false))); continue;
  end if;
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
   when 'agency' then
    raw := coalesce(btrim(case r.source_ref when 'name' then agy.name when 'business_email' then agy.business_email when 'phone' then agy.phone when 'address' then agy.address end), '');
    -- A direct student's "agency" is the institute itself: its blank contact details are the institute's from Website settings.
    if raw = '' and coalesce(agy.is_direct, false) then
     raw := coalesce(btrim(case r.source_ref when 'name' then st.name when 'business_email' then coalesce(nullif(btrim(st.admissions_email), ''), st.email) when 'phone' then st.phone when 'address' then st.address end), '');
     src := 'Direct student: Website settings › ' || case r.source_ref when 'name' then 'Institute name' when 'business_email' then 'Admissions email' when 'phone' then 'Phone' else 'Address' end;
    end if;
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
 return jsonb_build_object('values', v_out, 'charges', v_charges,
   'courses', coalesce((select jsonb_agg(c - '_courseId' - '_intakeId' - '_feeSetup' - '_title' - '_start' - '_end' - '_total' order by n) from jsonb_array_elements(v_courses) with ordinality as t(c, n)), '[]'::jsonb),
   'context', jsonb_build_object('courseId', v_first ->> '_courseId', 'intakeId', v_first ->> '_intakeId', 'feeSetup', v_first ->> '_feeSetup', 'courseTitle', v_first ->> '_title',
     'feesSetUp', coalesce((v_first ->> '_fees')::boolean, false),
     'dateFormat', fmt, 'courseCount', jsonb_array_length(v_courses),
     'gst', exists(select 1 from jsonb_array_elements(v_courses) x where coalesce(nullif(x -> 'fees.gst' ->> 'raw', ''), '0')::numeric > 0)));
end $$;
