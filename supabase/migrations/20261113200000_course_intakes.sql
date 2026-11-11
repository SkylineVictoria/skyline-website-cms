-- Course intakes (owner brief 2026-11-11, INT-01, part 1 of 2). Additive. Release FIRST (owner's order): with this migration and the staff
-- Intakes screen on the course editor, staff can record real intakes. The enrolment form that requires one ships later with
-- 20261113210000_enrolment_requires_intake.sql; until then nothing an applicant does changes (an application without an intake still saves
-- and submits exactly as today).
--
-- * public.course_intakes: one row per intake of a CMS course (start date, optional end date and label, active flag). Read by signed-in
--   portal users through RLS (active intakes of courses they can see, the course table's own rules), written only through
--   public.course_intakes_admin (CMS staff).
-- * public.course_intakes_open(course): the open intakes of a course (active, starting today or later in Melbourne), sorted, each with the
--   label the form shows, made here so no month name or year is written in the frontend.
-- * enrollment_application_courses.intake_id: the chosen intake. A trigger refuses an intake of another course or one that is not open, so a
--   tampered course / intake pair never reaches the database; portal_save_draft_v2 takes `intakeId` with each course and writes the intake's
--   own label into the application (preferred_intake and the intake column), never the client's text.
-- * hr.sign_subject: a student's values gain student.id (the application reference), course.intake, course.start_date, agent.name and
--   agency.name, so the template variables [Student ID], [Intake], [Start Date], [Agent Name] and [Agency Name] fill from the record.

create table if not exists public.course_intakes (
 id uuid primary key default gen_random_uuid(),
 course_id text not null references public.cms_courses(id) on delete cascade,
 start_date date not null,
 end_date date,
 label text,
 is_active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid,
 constraint course_intakes_end check (end_date is null or end_date >= start_date),
 constraint course_intakes_label check (label is null or char_length(btrim(label)) between 1 and 80),
 constraint course_intakes_unique unique (course_id, start_date)
);
create index if not exists course_intakes_open_idx on public.course_intakes(course_id, start_date) where is_active;
alter table public.course_intakes enable row level security;
revoke all on public.course_intakes from public, anon, authenticated;
grant select on public.course_intakes to authenticated;
grant all on public.course_intakes to service_role;
-- The course's own visibility rules apply inside the subquery (published, the caller's tenant), so an intake is visible exactly when its course is.
drop policy if exists course_intakes_read on public.course_intakes;
create policy course_intakes_read on public.course_intakes for select to authenticated using (is_active and exists (select 1 from public.cms_courses c where c.id = course_id));

-- "Today" for intakes is the Melbourne date (an intake starting today is still open today).
create or replace function public.course_intake_today() returns date
language sql stable parallel safe set search_path = pg_catalog, pg_temp as $fn$ select (now() at time zone 'Australia/Melbourne')::date $fn$;

-- The name of an intake ("February 2027", or the staff's own label) and the line the form shows ("February 2027 (starts 3 Feb 2027)").
create or replace function public.course_intake_name(i public.course_intakes) returns text
language sql stable parallel safe set search_path = pg_catalog, public, pg_temp as $fn$ select coalesce(nullif(btrim(i.label), ''), to_char(i.start_date, 'FMMonth YYYY')) $fn$;
create or replace function public.course_intake_display(i public.course_intakes) returns text
language sql stable parallel safe set search_path = pg_catalog, public, pg_temp as $fn$
 select public.course_intake_name(i) || ' (starts ' || to_char(i.start_date, 'FMDD Mon YYYY') || ')' $fn$;
create or replace function public.course_intake_json(i public.course_intakes) returns jsonb
language sql stable parallel safe set search_path = pg_catalog, public, pg_temp as $fn$
 select jsonb_build_object('id', i.id, 'courseId', i.course_id, 'startDate', i.start_date, 'endDate', i.end_date, 'label', coalesce(i.label, ''), 'isActive', i.is_active,
  'name', public.course_intake_name(i), 'display', public.course_intake_display(i), 'open', i.is_active and i.start_date >= public.course_intake_today()) $fn$;
revoke all on function public.course_intake_today() from public, anon;
revoke all on function public.course_intake_name(public.course_intakes) from public, anon;
revoke all on function public.course_intake_display(public.course_intakes) from public, anon;
revoke all on function public.course_intake_json(public.course_intakes) from public, anon;
grant execute on function public.course_intake_today(), public.course_intake_name(public.course_intakes), public.course_intake_display(public.course_intakes),
 public.course_intake_json(public.course_intakes) to authenticated, service_role;

-- True when the intake is open for this course (the course given by its id, or by its slug as the static course list does).
create or replace function public.course_intake_open_for(p_intake uuid, p_course text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
 select exists (select 1 from public.course_intakes i join public.cms_courses c on c.id = i.course_id
  where i.id = p_intake and (c.id = p_course or c.slug = p_course) and i.is_active and i.start_date >= public.course_intake_today()) $fn$;
revoke all on function public.course_intake_open_for(uuid, text) from public, anon, authenticated;

-- The intake dropdown: security invoker, so the caller sees only intakes of courses they can see.
create or replace function public.course_intakes_open(p_course text) returns jsonb
language sql stable security invoker set search_path = pg_catalog, public, pg_temp as $fn$
 select coalesce(jsonb_agg(public.course_intake_json(i) order by i.start_date), '[]'::jsonb)
 from public.course_intakes i join public.cms_courses c on c.id = i.course_id
 where (c.id = p_course or c.slug = p_course) and i.is_active and i.start_date >= public.course_intake_today() $fn$;
revoke all on function public.course_intakes_open(text) from public, anon;
grant execute on function public.course_intakes_open(text) to authenticated;

-- Staff screen (CMS > Courses > a course > Intakes): list, save, delete. CMS staff only, like the course itself.
create or replace function public.course_intakes_admin(p_action text, p_course text, p_id uuid default null, p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare i public.course_intakes; v_start date; v_end date; v_used integer;
begin
 if not public.cms_is_staff() then raise exception 'Only CMS staff can manage intakes' using errcode = '42501'; end if;
 if not exists (select 1 from public.cms_courses where id = p_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;
 p_data := coalesce(p_data, '{}'::jsonb);
 if p_action in ('save', 'delete') and p_id is not null then
  select * into i from public.course_intakes where id = p_id and course_id = p_course for update;
  if not found then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  select count(*) into v_used from public.enrollment_application_courses where intake_id = p_id;
 end if;
 if p_action = 'save' then
  begin v_start := (p_data->>'startDate')::date; v_end := nullif(p_data->>'endDate', '')::date;
  exception when others then raise exception 'Enter the dates as calendar dates' using errcode = '22023'; end;
  if v_start is null then raise exception 'Enter the start date' using errcode = '22023'; end if;
  if v_end is not null and v_end < v_start then raise exception 'The end date is before the start date' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_data->>'label', ''))) > 80 then raise exception 'Keep the label under 80 characters' using errcode = '22023'; end if;
  if p_id is not null and v_used > 0 and v_start <> i.start_date then
   raise exception 'This intake is chosen on % application(s), so its start date cannot change. Deactivate it and add a new intake instead.', v_used using errcode = '23514';
  end if;
  begin
   if p_id is null then
    insert into public.course_intakes(course_id, start_date, end_date, label, is_active, updated_by)
     values (p_course, v_start, v_end, nullif(btrim(coalesce(p_data->>'label', '')), ''), coalesce((p_data->>'isActive')::boolean, true), auth.uid());
   else
    update public.course_intakes set start_date = v_start, end_date = v_end, label = nullif(btrim(coalesce(p_data->>'label', '')), ''),
     is_active = coalesce((p_data->>'isActive')::boolean, is_active), updated_at = now(), updated_by = auth.uid() where id = p_id;
   end if;
  exception when unique_violation then raise exception 'This course already has an intake starting on %', to_char(v_start, 'FMDD Mon YYYY') using errcode = '23505';
  end;
 elsif p_action = 'delete' then
  if p_id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  if v_used > 0 then raise exception 'This intake is chosen on % application(s). Deactivate it instead of deleting it.', v_used using errcode = '23514'; end if;
  delete from public.course_intakes where id = p_id;
 elsif p_action <> 'list' then raise exception 'Unknown intake action' using errcode = '22023';
 end if;
 return coalesce((select jsonb_agg(public.course_intake_json(x) || jsonb_build_object('applications', (select count(*) from public.enrollment_application_courses k where k.intake_id = x.id))
  order by x.start_date) from public.course_intakes x where x.course_id = p_course), '[]'::jsonb);
end $fn$;
revoke all on function public.course_intakes_admin(text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.course_intakes_admin(text, text, uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ the chosen intake on the application's course row
alter table public.enrollment_application_courses add column if not exists intake_id uuid references public.course_intakes(id) on delete restrict;
create index if not exists enrollment_application_courses_intake_idx on public.enrollment_application_courses(intake_id) where intake_id is not null;

create or replace function public.application_course_intake_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
begin
 if new.intake_id is null then return new; end if;
 if tg_op = 'UPDATE' and new.intake_id is not distinct from old.intake_id and new.course_id = old.course_id then return new; end if;
 if not public.course_intake_open_for(new.intake_id, new.course_id) then
  raise exception 'This intake is not open for the chosen course. Choose the course again and pick one of its intakes.' using errcode = '22023';
 end if;
 return new;
end $fn$;
revoke all on function public.application_course_intake_check() from public, anon, authenticated;
drop trigger if exists application_course_intake_check on public.enrollment_application_courses;
create trigger application_course_intake_check before insert or update of intake_id, course_id on public.enrollment_application_courses
 for each row execute function public.application_course_intake_check();

-- The versioned draft command of 20261025153802 with `intakeId` per course. Without it, exactly the released behaviour.
create or replace function public.portal_save_draft_v2(p_application_id uuid,p_expected_version bigint,p_patch jsonb) returns bigint
language plpgsql security definer set search_path=public as $$
declare a public.enrollment_applications; d jsonb; v bigint; c jsonb; course public.cms_courses; v_intake public.course_intakes; v_intake_id uuid; v_intake_label text;
begin
 a:=public.portal_lock_draft(p_application_id,p_expected_version);
 if jsonb_typeof(p_patch) is distinct from 'object' or p_patch-array['values','courses','savedAt','preparedBy','progress','wizard','academicQualifications']<>'{}'::jsonb
 or octet_length(p_patch::text)>500000 or p_patch ? 'values' and jsonb_typeof(p_patch->'values')<>'object' then
  raise exception 'Invalid draft fields' using errcode='22023'; end if;
 d:=coalesce(a.data,'{}')|| (p_patch-'values'-'wizard');
 if p_patch ? 'values' then d:=jsonb_set(d,'{values}',coalesce(a.data->'values','{}')||(p_patch->'values')); end if;
 if p_patch ? 'wizard' then d:=jsonb_set(d,'{wizard}',coalesce(a.data->'wizard','{}')||(p_patch->'wizard')); end if;
 if p_patch ? 'courses' then
  if jsonb_typeof(p_patch->'courses')<>'array' or jsonb_array_length(p_patch->'courses')>30 then raise exception 'Invalid courses' using errcode='22023'; end if;
  delete from public.enrollment_application_courses where application_id=a.id;
  for c in select value from jsonb_array_elements(p_patch->'courses') loop
   v_intake_id:=null;
   if nullif(c->>'intakeId','') is not null then
    begin v_intake_id:=(c->>'intakeId')::uuid; exception when others then raise exception 'Invalid intake' using errcode='22023'; end;
   end if;
   if a.tenant_id is not null then
    select * into course from public.cms_courses where id=c->>'courseId' and tenant_id=a.tenant_id and status='Published' and code<>'BSB80120';
    if not found then raise exception 'Course is not published for this institution' using errcode='23503'; end if;
    insert into public.enrollment_application_courses(application_id,course_id,course_code,course_title,variant,intake_id)
    values(a.id,course.id,course.code,course.name,coalesce(c->>'variant',''),v_intake_id);
   else
    insert into public.enrollment_application_courses(application_id,course_id,course_code,course_title,variant,intake_id)
    values(a.id,c->>'courseId',c->>'code',c->>'title',coalesce(c->>'variant',''),v_intake_id);
   end if;
   -- The intake's own label is what the application records (the first course's intake), never the text the client sent.
   if v_intake_id is not null and v_intake_label is null then
    select * into v_intake from public.course_intakes where id=v_intake_id;
    v_intake_label:=public.course_intake_display(v_intake);
   end if;
  end loop;
  if v_intake_label is not null then d:=jsonb_set(d,'{values}',coalesce(d->'values','{}')||jsonb_build_object('preferred_intake',v_intake_label)); end if;
 end if;
 update public.enrollment_applications set data=d,
 student_name=coalesce(nullif(concat_ws(' ',d#>>'{values,first_name}',d#>>'{values,last_name}'),''),a.student_name),
 student_email=coalesce(d#>>'{values,email}',a.student_email),intake=coalesce(d#>>'{values,preferred_intake}',a.intake),
 completion=case when d#>>'{progress,overall}' ~ '^\d{1,3}$' then least(100,(d#>>'{progress,overall}')::integer) else a.completion end,
 updated_at=clock_timestamp() where id=a.id returning draft_version into v;
 return v;
end; $$;
revoke all on function public.portal_save_draft_v2(uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.portal_save_draft_v2(uuid,bigint,jsonb) to authenticated;

-- ------------------------------------------------------------------ template values from the student's record (20261113140000 + the intake)
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
      ''agent_profile'', ap.assigned_agent_id) from public.enrollment_application_courses c
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
