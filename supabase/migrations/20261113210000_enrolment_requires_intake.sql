-- Course intakes (owner brief 2026-11-11, INT-01, part 2 of 2), released with the enrolment form that shows the intake dropdown.
--
-- Fallback (owner's decision 2026-11-11, so enrolment never breaks): a course with NO open intake in public.course_intakes offers the
-- previous automatic choice, the next twelve months from next month (Melbourne), as "Month YYYY". The list is made here
-- (public.course_intake_fallback), so the frontend still writes no month name or year. As soon as the course has a real open intake,
-- only the real intakes are listed and accepted.
--
-- public.portal_validate_submission is the function of 20261104120000 with one more rule at the end (public.application_intake_problem,
-- null when the intake is fine, so the SQL suites test it on its own): a course with real open intakes needs one of them, of that same
-- course, still open, with the application's preferred intake equal to its label (written by portal_save_draft_v2); a course without one
-- needs a preferred intake that is one of the fallback months listed now. A tampered course / intake pair is refused at save
-- (application_course_intake_check, 20261113200000) and here. The client is never trusted.
-- hr.sign_subject: [Intake] falls back to the month chosen for a course without real intakes.

-- The fallback months: next month and the eleven after it, first day of each, with the label the form shows.
create or replace function public.course_intake_fallback(p_course text) returns jsonb
language sql stable parallel safe set search_path = pg_catalog, public, pg_temp as $fn$
 select coalesce(jsonb_agg(jsonb_build_object('id', null, 'courseId', p_course, 'startDate', m::date, 'endDate', null, 'label', '', 'isActive', true,
   'name', to_char(m, 'FMMonth YYYY'), 'display', to_char(m, 'FMMonth YYYY'), 'open', true, 'fallback', true) order by m), '[]'::jsonb)
 from generate_series(date_trunc('month', public.course_intake_today()::timestamp) + interval '1 month', date_trunc('month', public.course_intake_today()::timestamp) + interval '12 months', interval '1 month') m $fn$;
revoke all on function public.course_intake_fallback(text) from public, anon;
grant execute on function public.course_intake_fallback(text) to authenticated, service_role;

-- True when the course (id or slug) has at least one active intake that has not started.
create or replace function public.course_has_open_intake(p_course text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
 select exists (select 1 from public.course_intakes i join public.cms_courses c on c.id = i.course_id
  where (c.id = p_course or c.slug = p_course) and i.is_active and i.start_date >= public.course_intake_today()) $fn$;
revoke all on function public.course_has_open_intake(text) from public, anon, authenticated;

-- The dropdown (security invoker as in 20261113200000: only courses the caller can see): the real open intakes, or the fallback months
-- for a visible course that has none.
create or replace function public.course_intakes_open(p_course text) returns jsonb
language sql stable security invoker set search_path = pg_catalog, public, pg_temp as $fn$
 with real as (
  select coalesce(jsonb_agg(public.course_intake_json(i) || jsonb_build_object('fallback', false) order by i.start_date), '[]'::jsonb) list
  from public.course_intakes i join public.cms_courses c on c.id = i.course_id
  where (c.id = p_course or c.slug = p_course) and i.is_active and i.start_date >= public.course_intake_today())
 select case when jsonb_array_length(real.list) > 0 then real.list
  when exists (select 1 from public.cms_courses c where c.id = p_course or c.slug = p_course) then public.course_intake_fallback(p_course)
  else '[]'::jsonb end from real $fn$;
revoke all on function public.course_intakes_open(text) from public, anon;
grant execute on function public.course_intakes_open(text) to authenticated;

create or replace function public.application_intake_problem(p_application_id uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare k record; v_values jsonb := public.application_values(p_application_id); v_first record;
begin
 for k in select c.course_id, c.intake_id from public.enrollment_application_courses c where c.application_id = p_application_id order by c.created_at loop
  if k.intake_id is null then
   -- No intake row: allowed only for a course that has no open intake (the fallback months).
   if public.course_has_open_intake(k.course_id) then return 'Choose an intake for the course'; end if;
  elsif not public.course_intake_open_for(k.intake_id, k.course_id) then return 'The chosen intake is not open for this course any more. Choose another intake.';
  end if;
 end loop;
 select c.course_id, c.intake_id into v_first from public.enrollment_application_courses c where c.application_id = p_application_id order by c.created_at limit 1;
 if not found then return null; end if;
 if v_first.intake_id is not null then
  if (v_values->>'preferred_intake') is distinct from (select public.course_intake_display(i) from public.course_intakes i where i.id = v_first.intake_id) then
   return 'The preferred intake does not match the chosen intake. Choose the intake again.';
  end if;
 elsif not exists (select 1 from jsonb_array_elements(public.course_intake_fallback(v_first.course_id)) x where x->>'display' = v_values->>'preferred_intake') then
  return 'Choose one of the listed start months for the course.';
 end if;
 return null;
end $fn$;
revoke all on function public.application_intake_problem(uuid) from public, anon, authenticated;

create or replace function public.portal_validate_submission(p_application_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare a public.enrollment_applications; s jsonb; f jsonb; vals jsonb; field_value jsonb; v_category text; label text; v_problem text;
begin
 select * into a from public.enrollment_applications where id=p_application_id;
 vals:=public.application_values(a.id);
 for s in select value from jsonb_array_elements(public.portal_required_schema()) loop
  if not public.portal_condition_met(s->'showIf',vals) then continue; end if;
  for f in select value from jsonb_array_elements(s->'fields') loop
   if not public.portal_condition_met(f->'showIf',vals) then continue; end if;
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
   elsif f->>'type' in ('select','radio') and f ? 'options' and label<>'agent_agency' and not(f->'options' ? (field_value#>>'{}')) then
    raise exception 'Invalid option: %',label using errcode='22023';
   elsif f->>'type'='date' then
    begin perform (field_value#>>'{}')::date; exception when others then raise exception 'Invalid date: %',label using errcode='22023'; end;
   elsif f->>'type'='email' and (field_value#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid email: %',label using errcode='22023';
   end if;
  end loop;
 end loop;
 if vals->>'email' is distinct from vals->>'confirm_email' then raise exception 'Email confirmation does not match' using errcode='22023'; end if;
 if a.tenant_id is not null and exists(select 1 from public.enrollment_application_courses c left join public.cms_courses cc on cc.id=c.course_id and cc.tenant_id=a.tenant_id and cc.status='Published'
  where c.application_id=a.id and cc.id is null) then raise exception 'Course is no longer published' using errcode='22023'; end if;
 -- INT-01: an open intake of the application's own course, and the label the server wrote for it.
 v_problem := public.application_intake_problem(a.id);
 if v_problem is not null then raise exception '%', v_problem using errcode='22023'; end if;
end; $function$;
revoke all on function public.portal_validate_submission(uuid) from public,anon,authenticated,service_role;

-- ------------------------------------------------------------------ template values: [Intake] for a fallback month
create or replace function hr.sign_subject(p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, hr, public, pg_temp as $f$
declare j jsonb; d jsonb; e jsonb; b jsonb; a jsonb; v_name text; v_first text; v_last text; v_address text; v_course jsonb; out jsonb; v_extra jsonb := '{}'::jsonb;
 v_today text := to_char(now() at time zone 'Australia/Melbourne', 'FMDD FMMonth YYYY');
begin
 if p_type = 'student' and to_regclass('public.enrollment_students') is not null then
  execute 'select to_jsonb(s) from public.enrollment_students s where s.id = $1' into j using p_id;
  if j is null then raise exception 'Student not found'; end if;
  d := case when jsonb_typeof(j->'details') = 'object' then j->'details' else '{}'::jsonb end;
  v_name := btrim(coalesce(j->>'full_name', ''));
  v_first := coalesce(nullif(btrim(coalesce(d->>'first_name', '')), ''), split_part(v_name, ' ', 1));
  v_last := coalesce(nullif(btrim(coalesce(d->>'last_name', '')), ''), nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), ''), '');
  v_address := array_to_string(array_remove(array[nullif(btrim(coalesce(d->>'au_street', d->>'ov_street', '')), ''), nullif(btrim(coalesce(d->>'au_suburb', d->>'ov_city', '')), ''),
   nullif(btrim(coalesce(d->>'au_state', d->>'ov_state', '')), ''), nullif(btrim(coalesce(d->>'au_postcode', d->>'ov_postcode', '')), ''), nullif(btrim(coalesce(d->>'ov_country', '')), '')], null), ', ');
  if to_regclass('public.enrollment_applications') is not null and to_regclass('public.enrollment_application_courses') is not null then
   execute 'select jsonb_build_object(''name'', c.course_title, ''code'', c.course_code, ''id'', c.course_id, ''intake_id'', c.intake_id, ''reference'', coalesce(ap.reference, ''''),
      ''agent_profile'', ap.assigned_agent_id, ''preferred'', coalesce(public.application_values(ap.id)->>''preferred_intake'', '''')) from public.enrollment_application_courses c
     join public.enrollment_applications ap on ap.id = c.application_id where ap.student_id = $1 order by ap.created_at desc, c.created_at limit 1' into v_course using p_id;
  end if;
  if v_course is not null and to_regclass('public.cms_courses') is not null then
   execute 'select $1 || jsonb_build_object(''fees'', k.fees, ''duration'', k.duration, ''cricos'', k.cricos) from public.cms_courses k where k.id = $2 or (k.code <> '''' and k.code = $3) limit 1'
    into a using v_course, v_course->>'id', v_course->>'code';
   v_course := coalesce(a, v_course);
  end if;
  -- The chosen intake (INT-01), the application reference as the student ID, and who brought the student.
  if v_course->>'intake_id' is not null then
   select jsonb_build_object('course.intake', public.course_intake_name(i), 'course.start_date', to_char(i.start_date, 'FMDD FMMonth YYYY'),
     'course.end_date', coalesce(to_char(i.end_date, 'FMDD FMMonth YYYY'), '')) into v_extra from public.course_intakes i where i.id = (v_course->>'intake_id')::uuid;
   v_extra := coalesce(v_extra, '{}'::jsonb);
  end if;
  -- A course without real intakes (the fallback months): [Intake] is the month the applicant chose; [Start Date] stays to be typed.
  if v_course is not null and v_course->>'intake_id' is null and nullif(v_course->>'preferred', '') is not null then
   v_extra := v_extra || jsonb_build_object('course.intake', v_course->>'preferred');
  end if;
  v_extra := v_extra || jsonb_build_object('student.id', coalesce(v_course->>'reference', ''),
   'agent.name', coalesce((select g.full_name from public.agents g where g.id = (j->>'agent_id')::uuid),
     (select p.full_name from public.portal_profiles p where p.id = (v_course->>'agent_profile')::uuid), ''),
   'agency.name', coalesce((select coalesce(nullif(to_jsonb(x)->>'name', ''), to_jsonb(x)->>'legal_name') from public.agencies x where x.id = (j->>'agency_id')::uuid), ''));
  out := jsonb_build_object('name', coalesce(nullif(v_name, ''), btrim(v_first || ' ' || v_last)), 'email', lower(coalesce(j->>'email', '')), 'tenant_id', j->>'tenant_id', 'values', jsonb_build_object(
   'student.first_name', v_first, 'student.last_name', v_last, 'student.full_name', coalesce(nullif(v_name, ''), btrim(v_first || ' ' || v_last)), 'student.email', coalesce(j->>'email', ''),
   'student.phone', coalesce(j->>'phone', d->>'mobile', ''), 'student.address', v_address, 'student.date_of_birth', coalesce(j->>'date_of_birth', d->>'dob', ''),
   'student.passport_number', coalesce(nullif(j->>'passport_number', ''), d->>'passport_number', ''), 'student.nationality', coalesce(nullif(j->>'nationality', ''), d->>'nationality', ''),
   'course.name', coalesce(v_course->>'name', ''), 'course.code', coalesce(v_course->>'code', ''), 'course.fees', coalesce(v_course->>'fees', ''),
   'course.duration', coalesce(v_course->>'duration', ''), 'course.cricos', coalesce(v_course->>'cricos', '')) || v_extra);
 elsif p_type = 'employee' then
  select to_jsonb(p) into j from hr.staff_profiles p where p.id = p_id;
  if j is null then raise exception 'Employee not found'; end if;
  if to_regclass('hr.employment') is not null then execute 'select to_jsonb(x) from hr.employment x where x.profile_id = $1' into e using p_id; end if;
  e := coalesce(e, '{}'::jsonb);
  v_name := btrim(regexp_replace(concat_ws(' ', j->>'first_name', j->>'middle_name', j->>'last_name'), '\s+', ' ', 'g'));
  v_address := array_to_string(array_remove(array[nullif(btrim(coalesce(j->>'address_street', '')), ''), nullif(btrim(coalesce(j->>'address_line2', '')), ''), nullif(btrim(coalesce(j->>'address_suburb', '')), ''),
   nullif(btrim(coalesce(j->>'address_state', '')), ''), nullif(btrim(coalesce(j->>'address_postcode', '')), ''), nullif(btrim(coalesce(j->>'address_country', '')), '')], null), ', ');
  out := jsonb_build_object('name', v_name, 'email', lower(coalesce(j->>'email', '')), 'values', jsonb_build_object(
   'employee.name', v_name, 'employee.first_name', coalesce(j->>'first_name', ''), 'employee.last_name', coalesce(j->>'last_name', ''), 'employee.email', coalesce(j->>'email', ''),
   'employee.phone', coalesce(j->>'phone_e164', ''), 'employee.address', v_address, 'employee.position', coalesce(e->>'job_title', ''), 'employee.department', coalesce(e->>'department', ''),
   'employee.employment_type', replace(coalesce(e->>'employment_type', ''), '_', ' '), 'employee.start_date', coalesce(e->>'joining_date', ''), 'employee.work_location', coalesce(e->>'work_location', '')));
 elsif p_type = 'agent' and to_regclass('public.agents') is not null then
  execute 'select to_jsonb(g) from public.agents g where g.id = $1' into j using p_id;
  if j is null then raise exception 'Agent not found'; end if;
  if to_regclass('public.agencies') is not null then execute 'select to_jsonb(x) from public.agencies x where x.id = $1' into b using (j->>'business_id')::uuid; end if;
  b := coalesce(b, '{}'::jsonb);
  out := jsonb_build_object('name', coalesce(j->>'full_name', ''), 'email', lower(coalesce(j->>'email', '')), 'values', jsonb_build_object(
   'agent.name', coalesce(j->>'full_name', ''), 'agent.email', coalesce(j->>'email', ''), 'agent.phone', coalesce(j->>'phone', ''), 'agent.marn', coalesce(j->>'marn', ''),
   'agency.name', coalesce(b->>'name', b->>'legal_name', ''), 'agency.abn', coalesce(b->>'registration_number', ''), 'agency.email', coalesce(b->>'email', ''), 'agency.phone', coalesce(b->>'phone', '')));
 else raise exception 'Choose a student, an employee or an agent';
 end if;
 return jsonb_set(out, '{values}', (out->'values') || jsonb_build_object('current_date', v_today));
end $f$;
revoke all on function hr.sign_subject(text, uuid) from public, anon, authenticated;
