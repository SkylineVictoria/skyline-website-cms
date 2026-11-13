-- COURSE-FLOW: one guided course flow. Course (master timetable) -> Intake (dated schedule) -> Batch (inherits the intake's unit
-- dates; stores an override only when a date differs). Additive: one new table, new functions, menu rows hidden (not deleted).

-- ------------------------------------------------------------------ 1. one menu item: Master Data › Courses
-- System menu rows cannot be deleted (admin_menu_protect); they are switched off instead. Turn them on again with
--   update public.admin_menu_items set is_enabled = true where id in ('rto_intakes', 'rto_classrooms');
update public.admin_menu_items set is_enabled = false where id in ('rto_intakes', 'rto_classrooms') and is_enabled;

-- ------------------------------------------------------------------ 2. batch unit dates: inherited, overridden only when changed
create table if not exists public.batch_unit_overrides (
 batch_id uuid not null references public.batches(id) on delete cascade,
 intake_unit_id uuid not null references public.intake_units(id) on delete cascade,
 start_date date not null, end_date date not null,
 updated_at timestamptz not null default now(),
 updated_by uuid default auth.uid(),
 primary key (batch_id, intake_unit_id),
 check (end_date >= start_date)
);
alter table public.batch_unit_overrides enable row level security;
revoke all on public.batch_unit_overrides from anon;
drop policy if exists batch_unit_overrides_staff_read on public.batch_unit_overrides;
create policy batch_unit_overrides_staff_read on public.batch_unit_overrides for select to authenticated using (public.cms_is_staff());
drop policy if exists batch_unit_overrides_rto_write on public.batch_unit_overrides;
create policy batch_unit_overrides_rto_write on public.batch_unit_overrides for all to authenticated using (public.cms_is_rto_manager()) with check (public.cms_is_rto_manager());

-- A batch: as before, plus its unit schedule (the intake's dates, or the batch's own where overridden).
create or replace function public.rto_batch_json(b public.batches) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', b.id, 'intakeId', b.intake_id, 'name', b.name, 'classroomId', b.classroom_id,
  'classroom', (select r.name from public.classrooms r where r.id = b.classroom_id), 'classDays', to_jsonb(b.class_days),
  'startTime', to_char(b.start_time, 'HH24:MI'), 'endTime', to_char(b.end_time, 'HH24:MI'), 'capacity', b.capacity, 'isActive', b.is_active,
  'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name)) order by s.first_name, s.last_name)
     from public.batch_trainers t join hr.staff_profiles s on s.id = t.staff_id where t.batch_id = b.id), '[]'::jsonb),
  'students', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'id', s.id, 'name', s.full_name, 'email', s.email, 'type', e.enrolment_type,
     'status', e.status, 'enrolledOn', e.enrolled_on) order by s.full_name) from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id
     where e.batch_id = b.id), '[]'::jsonb),
  'schedule', coalesce((select jsonb_agg(jsonb_build_object('intakeUnitId', x.id, 'code', u.code, 'name', u.name,
      'startDate', coalesce(o.start_date, x.start_date), 'endDate', coalesce(o.end_date, x.end_date),
      'intakeStartDate', x.start_date, 'intakeEndDate', x.end_date, 'overridden', o.batch_id is not null) order by x.sort, x.start_date)
     from public.intake_units x join public.cms_course_units u on u.id = x.unit_id
     left join public.batch_unit_overrides o on o.batch_id = b.id and o.intake_unit_id = x.id
     where x.intake_id = b.intake_id), '[]'::jsonb));
$$;

-- ------------------------------------------------------------------ 3. the flow's own actions (same roles as rto_admin)
create or replace function public.rto_course_flow(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
 d jsonb := coalesce(p_data, '{}'::jsonb); src public.course_intakes; v_new uuid; v_delta integer; v_start date; b public.batches; nb uuid; x record;
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can change intakes, batches and schedules.' using errcode = '42501'; end if;

 if p_action = 'intake_duplicate' then
  -- A copy at a new start date: unit dates move by the same number of days; batches, trainers, classrooms, times and batch date
  -- overrides are copied; students are not. The copy starts as a draft.
  select * into src from public.course_intakes where id = nullif(d->>'intakeId', '')::uuid;
  if src.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  v_start := nullif(d->>'startDate', '')::date;
  if v_start is null then raise exception 'Choose the new start date.' using errcode = '22023'; end if;
  if exists(select 1 from public.course_intakes where course_id = src.course_id and start_date = v_start) then
   raise exception 'This course already has an intake starting on that date.' using errcode = '23505';
  end if;
  v_delta := v_start - src.start_date;
  insert into public.course_intakes(course_id, start_date, end_date, name, campus, capacity, status, is_active, updated_by)
  values (src.course_id, v_start, src.end_date + v_delta, null, src.campus, src.capacity, 'draft', false, auth.uid()) returning id into v_new;
  create temp table if not exists pg_temp.rto_unit_map(old_id uuid primary key, new_id uuid) on commit drop;
  delete from pg_temp.rto_unit_map;
  for x in select * from public.intake_units where intake_id = src.id order by sort loop
   insert into pg_temp.rto_unit_map(old_id, new_id) values (x.id, gen_random_uuid());
   insert into public.intake_units(id, intake_id, unit_id, start_date, end_date, hours, sort)
   select m.new_id, v_new, x.unit_id, x.start_date + v_delta, x.end_date + v_delta, x.hours, x.sort from pg_temp.rto_unit_map m where m.old_id = x.id;
  end loop;
  for b in select * from public.batches where intake_id = src.id order by name loop
   insert into public.batches(intake_id, name, classroom_id, class_days, start_time, end_time, capacity, is_active)
   values (v_new, b.name, b.classroom_id, b.class_days, b.start_time, b.end_time, b.capacity, b.is_active) returning id into nb;
   insert into public.batch_trainers(batch_id, staff_id) select nb, t.staff_id from public.batch_trainers t where t.batch_id = b.id;
   insert into public.batch_unit_overrides(batch_id, intake_unit_id, start_date, end_date)
   select nb, m.new_id, o.start_date + v_delta, o.end_date + v_delta from public.batch_unit_overrides o join pg_temp.rto_unit_map m on m.old_id = o.intake_unit_id where o.batch_id = b.id;
  end loop;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', v_new));

 elsif p_action = 'batch_override_set' then
  select * into b from public.batches where id = nullif(d->>'batchId', '')::uuid;
  if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  if not exists(select 1 from public.intake_units where id = nullif(d->>'intakeUnitId', '')::uuid and intake_id = b.intake_id) then
   raise exception 'That unit is not on this batch''s intake.' using errcode = '22023';
  end if;
  if (d->>'endDate')::date < (d->>'startDate')::date then raise exception 'The end date is before the start date.' using errcode = '22023'; end if;
  -- The same dates as the intake are not an override.
  if exists(select 1 from public.intake_units where id = (d->>'intakeUnitId')::uuid and start_date = (d->>'startDate')::date and end_date = (d->>'endDate')::date) then
   delete from public.batch_unit_overrides where batch_id = b.id and intake_unit_id = (d->>'intakeUnitId')::uuid;
  else
   insert into public.batch_unit_overrides(batch_id, intake_unit_id, start_date, end_date) values (b.id, (d->>'intakeUnitId')::uuid, (d->>'startDate')::date, (d->>'endDate')::date)
   on conflict (batch_id, intake_unit_id) do update set start_date = excluded.start_date, end_date = excluded.end_date, updated_at = now(), updated_by = auth.uid();
  end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.intake_id));

 elsif p_action = 'batch_override_reset' then
  select * into b from public.batches where id = nullif(d->>'batchId', '')::uuid;
  if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  delete from public.batch_unit_overrides where batch_id = b.id and (nullif(d->>'intakeUnitId', '') is null or intake_unit_id = (d->>'intakeUnitId')::uuid);
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.intake_id));
 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $$;
revoke all on function public.rto_course_flow(text, jsonb) from public, anon;
grant execute on function public.rto_course_flow(text, jsonb) to authenticated;

-- ------------------------------------------------------------------ 4. application forms: the new intakes, labelled for choosing
-- "Feb 2027 (1 Feb 2027 – 17 Dec 2027) · Campus". Both the public Enrol Now form and the staff application form read
-- course_intakes_open (open = status Open, starting today or later, earliest first; full and closed are hidden).
create or replace function public.course_intake_display(i public.course_intakes) returns text
language sql stable set search_path = pg_catalog, public, pg_temp as $$
 select to_char(i.start_date, 'Mon YYYY') || ' (' || to_char(i.start_date, 'FMDD Mon YYYY') || coalesce(' – ' || to_char(i.end_date, 'FMDD Mon YYYY'), '') || ')'
  || coalesce(' · ' || nullif(btrim(coalesce(i.campus, (select c.campus from public.cms_courses c where c.id = i.course_id))), ''), '');
$$;

-- The fallback months (next twelve) are offered only while a course has no intakes at all; once a course has intakes, only its
-- open ones are offered (a course whose intakes are all full or closed offers none).
create or replace function public.course_intakes_open(p_course text) returns jsonb
language sql stable set search_path = pg_catalog, public, pg_temp as $$
 with real as (
  select coalesce(jsonb_agg(public.course_intake_json(i) || jsonb_build_object('fallback', false) order by i.start_date), '[]'::jsonb) list
  from public.course_intakes i join public.cms_courses c on c.id = i.course_id
  where (c.id = p_course or c.slug = p_course) and i.is_active and i.start_date >= public.course_intake_today())
 select case when jsonb_array_length(real.list) > 0 then real.list
  when exists (select 1 from public.cms_courses c where c.id = p_course or c.slug = p_course)
   and not exists (select 1 from public.course_intakes i join public.cms_courses c on c.id = i.course_id where c.id = p_course or c.slug = p_course)
   then public.course_intake_fallback(p_course)
  else '[]'::jsonb end from real;
$$;
