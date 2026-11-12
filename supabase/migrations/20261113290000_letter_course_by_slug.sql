-- Offer letters: the course of an application by id, then by slug, then by code (follow-up to 20261113270000, found on hosted
-- 2026-11-12). enrollment_application_courses.course_id holds the course's slug for applications made from the public course
-- pages (SLIT-2026-0080: "msf30422-certificate-iii-in-glass-and-glazing" while cms_courses.id is "course-1"), so the letter found
-- no course setup: CRICOS, fees and intake dates stayed empty. LOCAL until released.

/** The cms_courses.id an application's course row means: its id, else the course with that slug, else the one course with that code. */
create or replace function public.letter_course_id(p_course text, p_code text default null) returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select c.id from public.cms_courses c where c.id = p_course),
    (select c.id from public.cms_courses c where c.slug = p_course limit 1),
    (select min(c.id) from public.cms_courses c where nullif(btrim(p_code), '') is not null and upper(c.code) = upper(btrim(p_code)) having count(*) = 1));
$$;
revoke all on function public.letter_course_id(text, text) from public, anon;
grant execute on function public.letter_course_id(text, text) to authenticated;

create or replace function public.application_letter_values(p_application uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; v jsonb; st public.cms_settings; ac public.enrollment_application_courses; c public.cms_courses; i public.course_intakes;
 fc public.course_fee_setups; fi public.course_fee_setups; ag public.portal_profiles; agy public.agencies; fmt text; today date := (now() at time zone 'Australia/Melbourne')::date;
 v_out jsonb := '{}'::jsonb; r public.letter_variables; raw text; val text; src text; fee_src text; n numeric; tuition numeric; enrol numeric; mat numeric; oshc numeric;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return null; end if;
 v := coalesce(public.application_values(a.id), '{}'::jsonb);
 select * into st from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id order by s.id limit 1;
 if not found then select * into st from public.cms_settings s order by s.id limit 1; end if;
 fmt := coalesce(st.letter_date_format, 'DD/MM/YYYY');
 select * into ac from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id limit 1;
 if found then
  select * into c from public.cms_courses x where x.id = public.letter_course_id(ac.course_id, ac.course_code);
  select * into i from public.course_intakes x where x.id = ac.intake_id;
  select * into fc from public.course_fee_setups x where x.course_id = c.id and x.intake_id is null;
  if ac.intake_id is not null then select * into fi from public.course_fee_setups x where x.course_id = c.id and x.intake_id = ac.intake_id; end if;
 end if;
 select * into ag from public.portal_profiles x where x.id = a.assigned_agent_id;
 if not found and a.created_by is not null and exists (select 1 from public.agency_memberships m where m.user_id = a.created_by and m.role in ('agent', 'agency_admin')) then
  select * into ag from public.portal_profiles x where x.id = a.created_by;
 end if;
 select * into agy from public.agencies x where x.id = a.agency_id and not coalesce(x.is_direct, false);
 fee_src := case when fi.id is not null then 'for intake ' || coalesce(nullif(i.label, ''), to_char(i.start_date, 'DD/MM/YYYY')) else 'for every intake' end;

 for r in select * from public.letter_variables order by sort loop
  raw := ''; val := ''; src := r.source_label;
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
    elsif r.key = 'fees.total' then
     tuition := coalesce(fi.tuition_fee, fc.tuition_fee); enrol := coalesce(fi.enrolment_fee, fc.enrolment_fee); mat := coalesce(fi.material_fee, fc.material_fee); oshc := coalesce(fi.oshc_fee, fc.oshc_fee);
     raw := case when tuition is null then '' else (tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0))::text end;
     src := 'Course setup › Fees (sum, ' || fee_src || ')';
    elsif r.key = 'offer.date' then raw := today::text;
    elsif r.key = 'offer.expiry_date' then raw := (today + coalesce(st.offer_validity_days, 30))::text; src := 'Today + ' || coalesce(st.offer_validity_days, 30) || ' days (Settings › Offer validity)';
    end if;
   when 'course' then raw := coalesce(btrim(case r.source_ref when 'name' then coalesce(nullif(c.name, ''), ac.course_title) when 'code' then coalesce(nullif(c.code, ''), ac.course_code)
     when 'cricos' then c.cricos when 'duration' then c.duration when 'mode' then c.mode end), '');
   when 'intake' then
    raw := coalesce(case r.source_ref when 'label' then coalesce(nullif(btrim(i.label), ''), to_char(i.start_date, 'FMMonth YYYY')) when 'start_date' then i.start_date::text when 'end_date' then i.end_date::text end, '');
    if r.key = 'course.intake' and raw = '' then raw := coalesce(nullif(btrim(a.intake), ''), btrim(coalesce(v ->> 'preferred_intake', ''))); src := 'Application form › Preferred intake (no intake chosen)'; end if;
   when 'fee' then
    raw := coalesce(case r.source_ref when 'tuition_fee' then coalesce(fi.tuition_fee, fc.tuition_fee)::text when 'enrolment_fee' then coalesce(fi.enrolment_fee, fc.enrolment_fee)::text
      when 'material_fee' then coalesce(fi.material_fee, fc.material_fee)::text when 'oshc_fee' then coalesce(fi.oshc_fee, fc.oshc_fee)::text when 'deposit' then coalesce(fi.deposit, fc.deposit)::text
      when 'payment_plan' then coalesce(fi.payment_plan, fc.payment_plan) when 'campus' then coalesce(fi.campus, fc.campus) end, '');
    src := r.source_label || ' (' || fee_src || ')';
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
 return jsonb_build_object('values', v_out, 'context', jsonb_build_object('courseId', coalesce(c.id, ac.course_id), 'intakeId', ac.intake_id, 'feeSetup', coalesce(fi.id, fc.id),
   'courseTitle', coalesce(nullif(c.name, ''), ac.course_title), 'dateFormat', fmt));
end $function$;
revoke all on function public.application_letter_values(uuid) from public, anon, authenticated;

create or replace function public.portal_letter_save_to_source(p_application uuid, p_key text, p_value text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.letter_variables; a public.enrollment_applications; ac public.enrollment_application_courses; v text := btrim(coalesce(p_value, '')); n numeric; v_fee jsonb;
 v_row public.course_fee_setups;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found or not public.portal_is_slit_admin() or not public.portal_can_access_application(a.id) then raise exception 'Reviewer access required' using errcode = '42501'; end if;
 select * into r from public.letter_variables where key = p_key;
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
  update public.enrollment_applications set data = jsonb_set(coalesce(data, '{}'::jsonb), array['values', r.source_ref], to_jsonb(v), true)
   where id = a.id;
  -- An answer kept on the student's record (identity fields) is updated there too, so the application shows the same value.
  update public.enrollment_students s set details = jsonb_set(coalesce(s.details, '{}'::jsonb), array[r.source_ref], to_jsonb(v), true)
   where s.id = a.student_id and coalesce(s.details, '{}'::jsonb) ? r.source_ref;
 else
  if not public.cms_is_admin() then raise exception 'Only an administrator can change % in %', r.label, r.source_label using errcode = '42501'; end if;
  if r.source_kind = 'institute' then
   if r.source_ref not in ('name', 'short_name', 'address', 'phone', 'email', 'admissions_email', 'rto', 'cricos', 'abn', 'website') then raise exception 'Not editable' using errcode = '42501'; end if;
   execute format('update public.cms_settings set %I = $1, updated_at = now() where id = (select s.id from public.cms_settings s where s.tenant_id is not distinct from $2 order by s.id limit 1)', r.source_ref) using v, a.tenant_id;
  elsif r.source_kind = 'course' then
   if r.source_ref not in ('cricos', 'duration', 'mode') then raise exception 'Not editable' using errcode = '42501'; end if;
   select * into ac from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id limit 1;
   if public.letter_course_id(ac.course_id, ac.course_code) is null then raise exception 'The application has no course from the course list' using errcode = '22023'; end if;
   execute format('update public.cms_courses set %I = $1, updated_at = now() where id = $2', r.source_ref) using v, public.letter_course_id(ac.course_id, ac.course_code);
  elsif r.source_kind = 'fee' then
   select * into ac from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id limit 1;
   if public.letter_course_id(ac.course_id, ac.course_code) is null then raise exception 'The application has no course from the course list' using errcode = '22023'; end if;
   -- Saved on the intake's fees when the intake has its own, otherwise on the course's fees for every intake.
   select * into v_row from public.course_fee_setups x where x.course_id = public.letter_course_id(ac.course_id, ac.course_code) and x.intake_id = ac.intake_id;
   if not found then select * into v_row from public.course_fee_setups x where x.course_id = public.letter_course_id(ac.course_id, ac.course_code) and x.intake_id is null; end if;
   v_fee := jsonb_build_object('tuition', v_row.tuition_fee, 'enrolment', v_row.enrolment_fee, 'material', v_row.material_fee, 'oshc', v_row.oshc_fee, 'deposit', v_row.deposit,
     'paymentPlan', v_row.payment_plan, 'campus', v_row.campus);
   v_fee := v_fee || jsonb_build_object(case r.source_ref when 'tuition_fee' then 'tuition' when 'enrolment_fee' then 'enrolment' when 'material_fee' then 'material' when 'oshc_fee' then 'oshc'
     when 'deposit' then 'deposit' when 'payment_plan' then 'paymentPlan' when 'campus' then 'campus' end, v);
   perform public.cms_course_fee_save(public.letter_course_id(ac.course_id, ac.course_code), case when v_row.id is null then null else v_row.intake_id end, jsonb_strip_nulls(v_fee));
  else
   raise exception '% cannot be saved to its source from here', r.label using errcode = '42501';
  end if;
 end if;
 insert into public.portal_audit_log(actor, actor_name, actor_role, action, target_type, target_id, application_id, detail)
 values (auth.uid(), coalesce(auth.jwt()->>'email', 'Authorized reviewer'), 'slit_admin', 'letter_value_saved_to_source', 'application', a.id::text, a.id,
   jsonb_build_object('key', r.key, 'source', r.source_label, 'value', left(v, 500)));
 return public.application_letter_values(a.id);
end $function$;
