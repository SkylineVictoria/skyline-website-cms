-- TIMETABLE-VIEWS (owner, 2026-11-19): LMS > Timetable shows every class in calendar views (month / week / day), by trainer, by room,
-- by student, and the intakes on a timeline, so admins see who teaches and studies what and when. Read-only; Admins and RTO Managers.
--   admin_calendar_people()                          filter lists: courses, intakes, batches, trainers, rooms, placed students
--   admin_class_calendar(from, to, filter)           classes in a range (up to 93 days) with unit, batch, intake, room, trainers,
--                                                    expected students and the attendance register state; filter keys courseId,
--                                                    intakeId, batchId, staffId, roomId, studentId
--   admin_class_session_students(session)            the students expected in one class and their attendance mark
--   admin_intakes_timeline(from, to)                 intakes overlapping a range with their units' dates, batches and students
-- A class's trainers: the unit's trainers in that batch, else the batch's trainers (as my_class_schedule). A student is expected in a
-- class when the class's unit is one of their enrolment's units (rto_enrolment_units: join date, prerequisites first, carry-over).
-- Additive. Rollback (manual): drop the four functions.
begin;

create function public.admin_calendar_can() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false);
$$;

create function public.admin_calendar_people() returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
begin
  if not public.admin_calendar_can() then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'courses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name) order by c.code)
      from public.cms_courses c where exists (select 1 from public.course_intakes i where i.course_id = c.id)), '[]'::jsonb),
    'intakes', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'courseId', i.course_id, 'startDate', i.start_date, 'endDate', i.end_date,
      'status', i.status) order by i.start_date) from public.course_intakes i where i.is_active), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'intakeId', b.intake_id) order by b.name)
      from public.batches b where b.is_active), '[]'::jsonb),
    'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)) order by p.first_name, p.last_name)
      from hr.staff_profiles p where p.id in (select staff_id from public.batch_trainers union select staff_id from public.batch_unit_trainers)), '[]'::jsonb),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'campus', r.campus) order by r.campus, r.sort, r.name)
      from public.classrooms r where r.is_active), '[]'::jsonb),
    'students', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.full_name, 'email', s.email) order by s.full_name)
      from public.enrollment_students s where exists (select 1 from public.batch_enrolments e where e.student_id = s.id and e.status in ('active', 'deferred'))), '[]'::jsonb));
end;
$$;

create function public.admin_class_calendar(p_from date, p_to date, p_filter jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_course text := nullif(f->>'courseId', ''); v_intake uuid := nullif(f->>'intakeId', '')::uuid; v_batch uuid := nullif(f->>'batchId', '')::uuid;
  v_staff uuid := nullif(f->>'staffId', '')::uuid; v_room uuid := nullif(f->>'roomId', '')::uuid; v_student uuid := nullif(f->>'studentId', '')::uuid;
begin
  if not public.admin_calendar_can() then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 93 then raise exception 'Choose up to 93 days' using errcode = '22023'; end if;
  return coalesce((
    with s as (
      select cs.*, b.name batch_name, b.intake_id, ci.course_id, ci.start_date intake_start, ci.end_date intake_end
      from public.class_sessions cs join public.batches b on b.id = cs.batch_id join public.course_intakes ci on ci.id = b.intake_id
      where cs.session_date between p_from and p_to
        and (v_course is null or ci.course_id = v_course) and (v_intake is null or b.intake_id = v_intake)
        and (v_batch is null or cs.batch_id = v_batch) and (v_room is null or cs.room_id = v_room)),
    -- each placed student's units, read once per enrolment
    eu as (
      select e.id enrolment_id, e.batch_id, e.student_id, u.unit_id
      from public.batch_enrolments e cross join lateral public.rto_enrolment_units(e.id) u
      where e.status in ('active', 'deferred') and e.batch_id in (select distinct batch_id from s)),
    t as (
      select s.id session_id, coalesce(
        (select jsonb_agg(distinct jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)))
          from public.batch_unit_trainers ut join public.intake_units iu on iu.id = ut.intake_unit_id join hr.staff_profiles p on p.id = ut.staff_id
          where ut.batch_id = s.batch_id and iu.unit_id = s.unit_id),
        (select jsonb_agg(distinct jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)))
          from public.batch_trainers bt join hr.staff_profiles p on p.id = bt.staff_id where bt.batch_id = s.batch_id),
        '[]'::jsonb) trainers
      from s)
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'date', s.session_date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
      'type', s.session_type, 'status', s.status, 'batchId', s.batch_id, 'batch', s.batch_name, 'intakeId', s.intake_id,
      'intakeStart', s.intake_start, 'intakeEnd', s.intake_end, 'courseId', s.course_id, 'courseCode', c.code, 'courseName', c.name,
      'unitId', s.unit_id, 'unitCode', u.code, 'unitName', u.name, 'roomId', s.room_id, 'room', r.name, 'campus', r.campus,
      'trainers', t.trainers,
      'students', (select count(distinct eu.student_id) from eu where eu.batch_id = s.batch_id and (s.unit_id is null or eu.unit_id = s.unit_id)),
      'attendance', (select reg.state from public.lms_attendance_register reg join public.intake_units iu on iu.id = reg.intake_unit_id
        where reg.batch_id = s.batch_id and iu.unit_id = s.unit_id and reg.class_date = s.session_date limit 1))
      order by s.session_date, s.start_time, s.batch_name)
    from s join t on t.session_id = s.id join public.cms_courses c on c.id = s.course_id
    left join public.cms_course_units u on u.id = s.unit_id left join public.classrooms r on r.id = s.room_id
    where (v_staff is null or t.trainers @> jsonb_build_array(jsonb_build_object('id', v_staff)))
      and (v_student is null or exists (select 1 from eu where eu.batch_id = s.batch_id and eu.student_id = v_student
        and (s.unit_id is null or eu.unit_id = s.unit_id)))), '[]'::jsonb);
end;
$$;

create function public.admin_class_session_students(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cs public.class_sessions;
begin
  if not public.admin_calendar_can() then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
  select * into cs from public.class_sessions where id = p_session;
  if cs.id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.full_name, 'email', st.email, 'joined', e.enrolled_on,
      'carryOver', e.carry_over, 'prereqFirst', e.prereq_first, 'status', e.status,
      'mark', (select m.status from public.lms_attendance_register reg join public.intake_units iu on iu.id = reg.intake_unit_id
        join public.lms_attendance_marks m on m.register_id = reg.id and m.enrolment_id = e.id
        where reg.batch_id = cs.batch_id and iu.unit_id = cs.unit_id and reg.class_date = cs.session_date limit 1))
      order by st.full_name)
    from public.batch_enrolments e join public.enrollment_students st on st.id = e.student_id
    where e.batch_id = cs.batch_id and e.status in ('active', 'deferred')
      and (cs.unit_id is null or exists (select 1 from public.rto_enrolment_units(e.id) u where u.unit_id = cs.unit_id))), '[]'::jsonb);
end;
$$;

create function public.admin_intakes_timeline(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.admin_calendar_can() then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then raise exception 'Choose up to three years' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'courseId', i.course_id, 'courseCode', c.code, 'courseName', c.name,
      'startDate', i.start_date, 'endDate', coalesce(i.end_date, (select max(end_date) from public.intake_units where intake_id = i.id), i.start_date),
      'status', i.status, 'studyLoad', i.study_load, 'autoCreated', coalesce(i.auto_created, false),
      'batches', (select count(*) from public.batches b where b.intake_id = i.id and b.is_active),
      'students', (select count(distinct e.student_id) from public.batch_enrolments e join public.batches b on b.id = e.batch_id
        where b.intake_id = i.id and e.status in ('active', 'deferred')),
      'units', coalesce((select jsonb_agg(jsonb_build_object('code', u.code, 'name', u.name, 'start', iu.start_date, 'end', iu.end_date)
        order by iu.start_date, iu.sort) from public.intake_units iu join public.cms_course_units u on u.id = iu.unit_id where iu.intake_id = i.id), '[]'::jsonb))
      order by c.code, i.start_date)
    from public.course_intakes i join public.cms_courses c on c.id = i.course_id
    where i.is_active and i.start_date <= p_to
      and coalesce(i.end_date, (select max(end_date) from public.intake_units where intake_id = i.id), i.start_date) >= p_from), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_calendar_can(), public.admin_calendar_people(), public.admin_class_calendar(date, date, jsonb),
  public.admin_class_session_students(uuid), public.admin_intakes_timeline(date, date) from public, anon;
grant execute on function public.admin_calendar_can(), public.admin_calendar_people(), public.admin_class_calendar(date, date, jsonb),
  public.admin_class_session_students(uuid), public.admin_intakes_timeline(date, date) to authenticated;

commit;
