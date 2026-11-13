-- TIMETABLE-B: batch class timing (weekly sessions with rooms), room clashes, the rooms board, moving students between batches,
-- intake cards. Additive: helper functions; rto_batch_json, rto_intake_json and rto_course_flow replaced (every earlier action kept;
-- intake_duplicate now also copies the class timing). No data changes.

-- ------------------------------------------------------------------ 1. helpers
-- Morning / afternoon / evening from the start time (the timetable's own column labels are not reliable).
create or replace function public.rto_slot(p_start time) returns text
language sql immutable set search_path = public as $$
 select case when p_start < time '12:00' then 'morning' when p_start < time '16:00' then 'afternoon' else 'evening' end;
$$;

-- The days an intake runs: its unit dates, else its own dates (a year when it has no end yet).
create or replace function public.rto_intake_span(p_intake uuid) returns daterange
language sql stable security definer set search_path = public as $$
 select daterange(s.a, greatest(s.a, s.z), '[]') from (
  select coalesce(min(x.start_date), i.start_date) a, coalesce(max(x.end_date), i.end_date, i.start_date + 365) z
  from public.course_intakes i left join public.intake_units x on x.intake_id = i.id
  where i.id = p_intake group by i.id, i.start_date, i.end_date) s;
$$;

-- The days a batch runs: its unit dates (the batch's own where staff changed them), else its intake's.
create or replace function public.rto_batch_span(p_batch uuid) returns daterange
language sql stable security definer set search_path = public as $$
 select coalesce((select daterange(min(coalesce(o.start_date, x.start_date)), greatest(min(coalesce(o.start_date, x.start_date)), max(coalesce(o.end_date, x.end_date))), '[]')
   from public.batches b join public.intake_units x on x.intake_id = b.intake_id
   left join public.batch_unit_overrides o on o.batch_id = b.id and o.intake_unit_id = x.id
   where b.id = p_batch having count(*) > 0),
  (select public.rto_intake_span(b.intake_id) from public.batches b where b.id = p_batch));
$$;

-- A batch's weekly classes.
create or replace function public.rto_batch_sessions_json(p_batch uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'weekday', s.weekday, 'slot', s.slot, 'startTime', to_char(s.start_time, 'HH24:MI'),
   'endTime', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type, 'roomId', s.room_id, 'room', r.name, 'locationId', l.id, 'location', l.name)
   order by s.weekday, s.start_time, s.sort), '[]'::jsonb)
 from public.batch_sessions s left join public.classrooms r on r.id = s.room_id left join public.locations l on l.id = r.location_id
 where s.batch_id = p_batch;
$$;

-- Room clashes: another active batch uses the same room on the same weekday at an overlapping time while both batches run.
-- p_sessions: [{weekday, startTime, endTime, roomId}]; the days compared are the batch's (or, for a new batch, its intake's).
create or replace function public.rto_session_clashes(p_batch uuid, p_intake uuid, p_sessions jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
 with mine as (
  select (s->>'weekday')::smallint weekday, (s->>'startTime')::time st, (s->>'endTime')::time et, (s->>'roomId')::uuid room_id
  from jsonb_array_elements(case when jsonb_typeof(p_sessions) = 'array' then p_sessions else '[]'::jsonb end) s
  where nullif(s->>'roomId', '') is not null and nullif(s->>'startTime', '') is not null and nullif(s->>'endTime', '') is not null
    and nullif(s->>'weekday', '') is not null and (s->>'endTime')::time > (s->>'startTime')::time
 ), span as (select coalesce(case when p_batch is not null then public.rto_batch_span(p_batch) end, public.rto_intake_span(p_intake)) r)
 select coalesce(jsonb_agg(distinct jsonb_build_object('roomId', m.room_id, 'room', r.name, 'weekday', m.weekday,
   'startTime', to_char(m.st, 'HH24:MI'), 'endTime', to_char(m.et, 'HH24:MI'), 'otherBatchId', ob.id, 'otherBatch', ob.name,
   'otherCourseCode', oc.code, 'otherIntakeId', oi.id, 'otherStart', to_char(o.start_time, 'HH24:MI'), 'otherEnd', to_char(o.end_time, 'HH24:MI'))), '[]'::jsonb)
 from mine m cross join span
 join public.batch_sessions o on o.room_id = m.room_id and o.weekday = m.weekday and o.start_time < m.et and m.st < o.end_time
 join public.batches ob on ob.id = o.batch_id and ob.is_active and ob.id is distinct from p_batch
 join public.course_intakes oi on oi.id = ob.intake_id
 join public.cms_courses oc on oc.id = oi.course_id
 join public.classrooms r on r.id = m.room_id
 where span.r is not null and public.rto_batch_span(ob.id) && span.r;
$$;

-- The older batch fields (days, first and last time, classroom) follow the sessions, so letters and older screens stay right.
create or replace function public.rto_batch_sync_legacy(p_batch uuid) returns void
language sql security definer set search_path = public as $$
 update public.batches b set
  class_days = coalesce((select array_agg(d order by n) from (select distinct s.weekday n, (array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])[s.weekday] d
     from public.batch_sessions s where s.batch_id = b.id) z), '{}'),
  start_time = (select min(s.start_time) from public.batch_sessions s where s.batch_id = b.id),
  end_time = (select max(s.end_time) from public.batch_sessions s where s.batch_id = b.id),
  classroom_id = coalesce((select s.room_id from public.batch_sessions s where s.batch_id = b.id and s.room_id is not null
     order by (s.session_type = 'theory') desc, s.weekday, s.start_time limit 1), case when exists(select 1 from public.batch_sessions s where s.batch_id = b.id) then null else b.classroom_id end)
 where b.id = p_batch;
$$;

-- Locations with their rooms (rooms without a location last, as "Other rooms").
create or replace function public.rto_locations_rooms() returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(x.j order by x.o, x.n), '[]'::jsonb) from (
  select 0 o, l.sort n, jsonb_build_object('id', l.id, 'name', l.name, 'address', l.address, 'kind', l.kind,
   'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'capacity', r.capacity, 'isActive', r.is_active) order by r.sort, r.name)
     from public.classrooms r where r.location_id = l.id), '[]'::jsonb)) j
  from public.locations l where l.is_active
  union all
  select 1, 0, jsonb_build_object('id', null, 'name', 'Other rooms', 'address', null, 'kind', 'theory',
   'rooms', jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'capacity', r.capacity, 'isActive', r.is_active) order by r.name))
  from public.classrooms r where r.location_id is null or not exists(select 1 from public.locations l where l.id = r.location_id and l.is_active)
  having count(*) > 0) x;
$$;

-- ------------------------------------------------------------------ 2. a batch: as before, plus its weekly classes, dates and course
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
     where x.intake_id = b.intake_id), '[]'::jsonb),
  'sessions', public.rto_batch_sessions_json(b.id),
  'startDate', lower(public.rto_batch_span(b.id)), 'endDate', upper(public.rto_batch_span(b.id)) - 1);
$$;

-- ------------------------------------------------------------------ 3. an intake: as before, plus its batches (for the cards) and hours
create or replace function public.rto_intake_json(i public.course_intakes) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', i.id, 'courseId', i.course_id, 'courseCode', c.code,
  'courseName', public.course_name_variant(c.code, c.name, c.variant_label),
  'name', coalesce(nullif(btrim(i.name), ''), public.intake_auto_name(i.course_id, i.start_date, i.end_date)),
  'customName', nullif(btrim(i.name), ''), 'startDate', i.start_date, 'endDate', i.end_date, 'campus', coalesce(i.campus, c.campus),
  'capacity', i.capacity, 'status', i.status,
  'enrolled', (select count(distinct e.student_id) from public.batch_enrolments e join public.batches b on b.id = e.batch_id where b.intake_id = i.id and e.status in ('active', 'deferred')),
  'batches', (select count(*) from public.batches b where b.intake_id = i.id),
  'units', (select count(*) from public.intake_units x where x.intake_id = i.id),
  'trainers', coalesce((select jsonb_agg(distinct btrim(s.first_name || ' ' || s.last_name)) from public.batch_trainers t join public.batches b on b.id = t.batch_id
     join hr.staff_profiles s on s.id = t.staff_id where b.intake_id = i.id), '[]'::jsonb),
  'hasFeeOverride', exists(select 1 from public.course_fee_items f where f.intake_id = i.id),
  'hours', (select sum(x.hours) from public.intake_units x where x.intake_id = i.id),
  'courseDuration', c.duration,
  'batchList', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'capacity', b.capacity, 'isActive', b.is_active,
     'enrolled', (select count(*) from public.batch_enrolments e where e.batch_id = b.id and e.status in ('active', 'deferred')),
     'days', to_jsonb(b.class_days)) order by b.name) from public.batches b where b.intake_id = i.id), '[]'::jsonb))
 from public.cms_courses c where c.id = i.course_id;
$$;

-- ------------------------------------------------------------------ 4. the flow's actions
-- Reading (any CMS user): locations_rooms, timing_list, clash_check, rooms_board, batch_get.
-- Students (Admin or RTO Manager): student_move, enrolment_set. Everything else: RTO Manager.
create or replace function public.rto_course_flow(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
 d jsonb := coalesce(p_data, '{}'::jsonb); src public.course_intakes; v_new uuid; v_delta integer; v_start date; b public.batches; nb uuid; x record;
 v_id uuid; v_from date; v_to date; en public.batch_enrolments; tb public.batches; v_count integer; v_old uuid; v_rto boolean := public.cms_is_rto_manager();
 v_s jsonb; v_st time; v_et time; v_wd integer;
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_action in ('student_move', 'enrolment_set') then
  if not (v_rto or public.cms_is_admin()) then raise exception 'Only an Admin or an RTO Manager can move or remove students.' using errcode = '42501'; end if;
 elsif p_action not in ('locations_rooms', 'timing_list', 'clash_check', 'rooms_board', 'batch_get') and not v_rto then
  raise exception 'Only an RTO Manager can change intakes, batches and schedules.' using errcode = '42501';
 end if;

 if p_action = 'intake_duplicate' then
  -- A copy at a new start date: unit dates move by the same number of days; batches, trainers, class timing and the batches' own
  -- unit dates are copied; students are not. The copy starts as a draft.
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
   insert into public.batch_sessions(batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
   select nb, s2.weekday, s2.slot, s2.start_time, s2.end_time, s2.session_type, s2.room_id, s2.sort from public.batch_sessions s2 where s2.batch_id = b.id;
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
  -- The same dates as the intake: the batch simply follows the intake.
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

 elsif p_action = 'locations_rooms' then
  return public.rto_locations_rooms();

 elsif p_action = 'timing_list' then
  -- The course's class timing from the master timetable, one per batch name (G1, G2 ...).
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'trainerName', t.trainer_name, 'trainerStaffId', t.trainer_staff_id,
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('weekday', (e->>'weekday')::int, 'startTime', e->>'start', 'endTime', e->>'end',
       'type', coalesce(e->>'type', 'theory'), 'roomId', e->>'roomId', 'room', (select r.name from public.classrooms r where r.id::text = e->>'roomId'))
       order by (e->>'weekday')::int, e->>'start') from jsonb_array_elements(t.sessions) e), '[]'::jsonb)) order by t.name)
   from public.course_timing_templates t where t.course_id = nullif(d->>'courseId', '')), '[]'::jsonb);

 elsif p_action = 'clash_check' then
  return public.rto_session_clashes(nullif(d->>'batchId', '')::uuid, nullif(d->>'intakeId', '')::uuid, d->'sessions');

 elsif p_action = 'batch_setup' then
  -- Create or change a batch: name (new: the next free G1, G2 ...), capacity, active, trainers and its weekly classes.
  v_id := nullif(d->>'batchId', '')::uuid;
  if v_id is null then
   if not exists(select 1 from public.course_intakes where id = nullif(d->>'intakeId', '')::uuid) then raise exception 'Intake not found' using errcode = 'P0002'; end if;
   insert into public.batches(intake_id, name, capacity, is_active)
   values ((d->>'intakeId')::uuid,
    coalesce(nullif(btrim(d->>'name'), ''), 'G' || (coalesce((select max(substring(name from '^G(\d+)$')::integer) from public.batches where intake_id = (d->>'intakeId')::uuid), 0) + 1)),
    nullif(d->>'capacity', '')::integer, true)
   returning * into b;
  else
   select * into b from public.batches where id = v_id;
   if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
   update public.batches set
    name = case when d ? 'name' then coalesce(nullif(btrim(d->>'name'), ''), name) else name end,
    capacity = case when d ? 'capacity' then nullif(d->>'capacity', '')::integer else capacity end,
    is_active = case when d ? 'isActive' then coalesce((d->>'isActive')::boolean, is_active) else is_active end
   where id = b.id returning * into b;
  end if;
  if d ? 'trainerIds' then
   delete from public.batch_trainers t where t.batch_id = b.id and t.staff_id::text not in (select jsonb_array_elements_text(d->'trainerIds'));
   insert into public.batch_trainers(batch_id, staff_id) select b.id, value::uuid from jsonb_array_elements_text(d->'trainerIds') on conflict do nothing;
  end if;
  if jsonb_typeof(d->'sessions') = 'array' then
   delete from public.batch_sessions where batch_id = b.id;
   v_count := 0;
   for v_s in select value from jsonb_array_elements(d->'sessions') loop
    v_count := v_count + 1;
    v_wd := nullif(v_s->>'weekday', '')::integer; v_st := nullif(v_s->>'startTime', '')::time; v_et := nullif(v_s->>'endTime', '')::time;
    if v_wd is null or v_wd not between 1 and 7 then raise exception 'Each class needs a day.' using errcode = '22023'; end if;
    if v_st is null or v_et is null or v_et <= v_st then raise exception 'Each class needs an end time after its start time.' using errcode = '22023'; end if;
    insert into public.batch_sessions(batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
    values (b.id, v_wd, public.rto_slot(v_st), v_st, v_et, coalesce(nullif(v_s->>'type', ''), 'theory'), nullif(v_s->>'roomId', '')::uuid, v_count);
   end loop;
   perform public.rto_batch_sync_legacy(b.id);
  end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.intake_id))
   || jsonb_build_object('batchId', b.id, 'clashes', public.rto_session_clashes(b.id, b.intake_id, public.rto_batch_sessions_json(b.id)));

 elsif p_action = 'session_add' then
  -- The rooms board: put a batch into a room for one weekday and part of the day.
  select * into b from public.batches where id = nullif(d->>'batchId', '')::uuid;
  if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  v_wd := nullif(d->>'weekday', '')::integer;
  if v_wd is null or v_wd not between 1 and 7 then raise exception 'Choose a day.' using errcode = '22023'; end if;
  v_st := coalesce(nullif(d->>'startTime', '')::time, case d->>'slot' when 'morning' then time '09:00' when 'afternoon' then time '13:00' else time '17:00' end);
  v_et := coalesce(nullif(d->>'endTime', '')::time, case d->>'slot' when 'morning' then time '13:00' when 'afternoon' then time '17:00' else time '21:00' end);
  insert into public.batch_sessions(batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
  values (b.id, v_wd, public.rto_slot(v_st), v_st, v_et, coalesce(nullif(d->>'type', ''), 'theory'), nullif(d->>'roomId', '')::uuid,
   (select coalesce(max(sort), 0) + 1 from public.batch_sessions where batch_id = b.id))
  returning id into v_new;
  perform public.rto_batch_sync_legacy(b.id);
  return jsonb_build_object('sessionId', v_new, 'clashes', public.rto_session_clashes(b.id, b.intake_id, public.rto_batch_sessions_json(b.id)));

 elsif p_action = 'session_delete' then
  delete from public.batch_sessions where id = nullif(d->>'sessionId', '')::uuid returning batch_id into v_id;
  if v_id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  perform public.rto_batch_sync_legacy(v_id);
  return jsonb_build_object('deleted', true, 'batchId', v_id);

 elsif p_action = 'batch_get' then
  -- One batch for its own page: the batch, its intake, the other batches of the intake and room clashes.
  select * into b from public.batches where id = nullif(d->>'batchId', '')::uuid;
  if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('batch', public.rto_batch_json(b), 'intake', (select public.rto_intake_json(ci) from public.course_intakes ci where ci.id = b.intake_id),
   'siblings', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'capacity', o.capacity,
      'enrolled', (select count(*) from public.batch_enrolments e where e.batch_id = o.id and e.status in ('active', 'deferred'))) order by o.name)
     from public.batches o where o.intake_id = b.intake_id and o.id <> b.id and o.is_active), '[]'::jsonb),
   'clashes', public.rto_session_clashes(b.id, b.intake_id, public.rto_batch_sessions_json(b.id)),
   'rtoManager', v_rto, 'admin', public.cms_is_admin());

 elsif p_action = 'batch_trainers_set' then
  select * into b from public.batches where id = nullif(d->>'batchId', '')::uuid;
  if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  delete from public.batch_trainers t where t.batch_id = b.id and t.staff_id::text not in (select jsonb_array_elements_text(coalesce(d->'trainerIds', '[]'::jsonb)));
  insert into public.batch_trainers(batch_id, staff_id) select b.id, value::uuid from jsonb_array_elements_text(coalesce(d->'trainerIds', '[]'::jsonb)) on conflict do nothing;
  return public.rto_batch_json(b);

 elsif p_action = 'student_move' then
  -- Move a student to another batch of the same intake (the enrolment keeps its type and date).
  select * into en from public.batch_enrolments where id = nullif(d->>'enrolmentId', '')::uuid;
  if en.id is null then raise exception 'Enrolment not found' using errcode = 'P0002'; end if;
  select * into tb from public.batches where id = nullif(d->>'toBatchId', '')::uuid;
  if tb.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  v_old := en.batch_id;
  if tb.id = v_old then return jsonb_build_object('enrolmentId', en.id, 'fromBatchId', v_old, 'toBatchId', tb.id); end if;
  if (select intake_id from public.batches where id = v_old) <> tb.intake_id then
   raise exception 'Students move between batches of the same intake.' using errcode = '22023';
  end if;
  if exists(select 1 from public.batch_enrolments where batch_id = tb.id and student_id = en.student_id and status in ('active', 'deferred', 'completed')) then
   raise exception 'This student is already in %.', tb.name using errcode = '23505';
  end if;
  delete from public.batch_enrolments where batch_id = tb.id and student_id = en.student_id and status = 'withdrawn';
  update public.batch_enrolments set batch_id = tb.id where id = en.id;
  select count(*) into v_count from public.batch_enrolments where batch_id = tb.id and status in ('active', 'deferred');
  if tb.capacity is not null and v_count > tb.capacity then raise exception '% is full (% places).', tb.name, tb.capacity using errcode = '23514'; end if;
  return jsonb_build_object('enrolmentId', en.id, 'fromBatchId', v_old, 'toBatchId', tb.id);

 elsif p_action = 'enrolment_set' then
  -- Remove a student from a batch (withdrawn) or bring them back (active), e.g. Undo.
  if coalesce(d->>'status', '') not in ('active', 'withdrawn') then raise exception 'Unknown status' using errcode = '22023'; end if;
  update public.batch_enrolments set status = d->>'status' where id = nullif(d->>'enrolmentId', '')::uuid returning * into en;
  if en.id is null then raise exception 'Enrolment not found' using errcode = 'P0002'; end if;
  select * into tb from public.batches where id = en.batch_id;
  select count(*) into v_count from public.batch_enrolments where batch_id = tb.id and status in ('active', 'deferred');
  if en.status = 'active' and tb.capacity is not null and v_count > tb.capacity then raise exception '% is full (% places).', tb.name, tb.capacity using errcode = '23514'; end if;
  return jsonb_build_object('enrolmentId', en.id, 'status', en.status, 'batchId', en.batch_id);

 elsif p_action = 'rooms_board' then
  -- Every class of the active batches that run in the chosen dates, the rooms by location, and those batches (to put one in a room).
  v_from := coalesce(nullif(d->>'from', '')::date, current_date); v_to := greatest(v_from, coalesce(nullif(d->>'to', '')::date, v_from + 6));
  return jsonb_build_object('locations', public.rto_locations_rooms(),
   'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'batchId', bb.id, 'batch', bb.name, 'intakeId', ci.id,
      'intakeName', coalesce(nullif(btrim(ci.name), ''), public.intake_auto_name(ci.course_id, ci.start_date, ci.end_date)), 'courseId', ci.course_id, 'courseCode', c.code,
      'weekday', s.weekday, 'slot', s.slot, 'startTime', to_char(s.start_time, 'HH24:MI'), 'endTime', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type,
      'roomId', s.room_id, 'batchStart', lower(sp.r), 'batchEnd', upper(sp.r) - 1,
      'trainers', coalesce((select jsonb_agg(btrim(st.first_name || ' ' || st.last_name)) from public.batch_trainers t join hr.staff_profiles st on st.id = t.staff_id where t.batch_id = bb.id), '[]'::jsonb))
      order by s.weekday, s.start_time)
     from public.batch_sessions s join public.batches bb on bb.id = s.batch_id and bb.is_active
     join public.course_intakes ci on ci.id = bb.intake_id join public.cms_courses c on c.id = ci.course_id
     cross join lateral (select public.rto_batch_span(bb.id) r) sp
     where sp.r && daterange(v_from, v_to, '[]')), '[]'::jsonb),
   'batches', coalesce((select jsonb_agg(jsonb_build_object('id', bb.id, 'name', bb.name, 'courseCode', c.code, 'intakeId', ci.id,
      'intakeName', coalesce(nullif(btrim(ci.name), ''), public.intake_auto_name(ci.course_id, ci.start_date, ci.end_date))) order by c.code, ci.start_date, bb.name)
     from public.batches bb join public.course_intakes ci on ci.id = bb.intake_id join public.cms_courses c on c.id = ci.course_id
     where bb.is_active and public.rto_batch_span(bb.id) && daterange(v_from, v_to, '[]')), '[]'::jsonb));

 elsif p_action = 'room_save' then
  -- A room in a location (create or rename / move / capacity / active).
  v_id := nullif(d->>'id', '')::uuid;
  if v_id is null then
   if nullif(btrim(d->>'name'), '') is null then raise exception 'Give the room a name.' using errcode = '22023'; end if;
   insert into public.classrooms(name, campus, capacity, is_active, location_id, sort)
   values (btrim(d->>'name'), (select name from public.locations where id = nullif(d->>'locationId', '')::uuid), nullif(d->>'capacity', '')::integer, true,
    nullif(d->>'locationId', '')::uuid, coalesce((select max(sort) + 1 from public.classrooms where location_id = nullif(d->>'locationId', '')::uuid), 1));
  else
   update public.classrooms set
    name = case when d ? 'name' then coalesce(nullif(btrim(d->>'name'), ''), name) else name end,
    location_id = case when d ? 'locationId' then nullif(d->>'locationId', '')::uuid else location_id end,
    campus = case when d ? 'locationId' then (select name from public.locations where id = nullif(d->>'locationId', '')::uuid) else campus end,
    capacity = case when d ? 'capacity' then nullif(d->>'capacity', '')::integer else capacity end,
    is_active = case when d ? 'isActive' then coalesce((d->>'isActive')::boolean, is_active) else is_active end
   where id = v_id;
   if not found then raise exception 'Room not found' using errcode = 'P0002'; end if;
  end if;
  return public.rto_locations_rooms();
 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $$;
revoke all on function public.rto_course_flow(text, jsonb) from public, anon;
grant execute on function public.rto_course_flow(text, jsonb) to authenticated;

do $grants$
declare f text;
begin
 foreach f in array array['rto_intake_span(uuid)', 'rto_batch_span(uuid)', 'rto_batch_sessions_json(uuid)', 'rto_session_clashes(uuid, uuid, jsonb)',
   'rto_batch_sync_legacy(uuid)', 'rto_locations_rooms()'] loop
  execute format('revoke all on function public.%s from public, anon, authenticated', f);
 end loop;
end $grants$;
