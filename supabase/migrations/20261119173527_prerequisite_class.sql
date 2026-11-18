-- PREREQ-CLASS (owner, 2026-11-19): a student who joins late, after a prerequisite unit has started, is assigned to the course's
-- Prerequisite class for those units (their catch-up dates, student_prereq_catchup), and joins their intake's group at the next
-- regular unit start when the prerequisites are done (unchanged, stage 3 + JOIN-AT-NEXT-UNIT).
--  * One Prerequisite class per course (prereq_classes), made automatically the first time a student needs one. Staff set its
--    trainer, room and weekly class times once (prereq_class_times); every late joiner of the course is in it.
--  * Its classes are real dated classes: on each weekly class time inside a member's catch-up dates for a unit, public holidays and
--    term breaks skipped (prereq_class_sessions; computed, never stored, so they follow the students' dates).
--  * Shown to the student (My timetable) and the trainer (My classes) through my_prereq_classes, and to staff in LMS > Timetable
--    (admin_prereq_sessions). Attendance for these classes is not recorded yet.
-- New: tables prereq_classes, prereq_class_times; functions prereq_class_ensure (trigger), prereq_class_sessions,
-- prereq_class_admin (get / save; RTO Managers save, Admins and RTO Managers read), my_prereq_classes, admin_prereq_sessions.
-- Additive. Rollback (manual): drop the five functions, trigger prereq_catchup_class on student_prereq_catchup, and the two tables.
begin;

create table if not exists public.prereq_classes (
  id uuid primary key default gen_random_uuid(),
  course_id text not null unique references public.cms_courses(id) on delete cascade,
  name text not null default 'Prerequisites',
  trainer_id uuid,
  room_id uuid references public.classrooms(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.prereq_class_times (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.prereq_classes(id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null check (end_time > start_time),
  session_type text not null default 'theory' check (session_type in ('theory', 'practical', 'assessment')),
  room_id uuid references public.classrooms(id) on delete set null
);
alter table public.prereq_classes enable row level security;
alter table public.prereq_class_times enable row level security;
revoke all on public.prereq_classes, public.prereq_class_times from anon, authenticated;

-- The course's Prerequisite class exists as soon as a student is given prerequisites to catch up.
create or replace function public.prereq_class_ensure() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.prereq_classes(course_id)
  select ci.course_id from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
  where e.id = new.enrolment_id
  on conflict (course_id) do nothing;
  return new;
end;
$$;
drop trigger if exists prereq_catchup_class on public.student_prereq_catchup;
create trigger prereq_catchup_class after insert on public.student_prereq_catchup for each row execute function public.prereq_class_ensure();
insert into public.prereq_classes(course_id)
select distinct ci.course_id from public.student_prereq_catchup cu join public.batch_enrolments e on e.id = cu.enrolment_id
  join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
on conflict (course_id) do nothing;

-- Dated classes of the Prerequisite classes between two days: each weekly class time on the days of a member's catch-up for a unit.
create or replace function public.prereq_class_sessions(p_from date, p_to date, p_course text default null)
returns table(class_id uuid, course_id text, unit_id text, session_date date, start_time time, end_time time, session_type text,
  room_id uuid, trainer_id uuid, student_ids uuid[])
language sql stable security definer set search_path = public as $$
  select pc.id, pc.course_id, cu.unit_id, d::date, t.start_time, t.end_time, t.session_type, coalesce(t.room_id, pc.room_id), pc.trainer_id,
    array_agg(distinct e.student_id)
  from public.prereq_classes pc
  join public.prereq_class_times t on t.class_id = pc.id
  join public.course_intakes ci on ci.course_id = pc.course_id
  join public.batches b on b.intake_id = ci.id
  join public.batch_enrolments e on e.batch_id = b.id and e.status in ('active', 'deferred')
  join public.student_prereq_catchup cu on cu.enrolment_id = e.id
  cross join lateral generate_series(greatest(cu.start_date, p_from), least(cu.end_date, p_to), interval '1 day') d
  where (p_course is null or pc.course_id = p_course)
    and extract(isodow from d) = t.weekday and public.rto_is_working_day(d::date)
  group by pc.id, pc.course_id, cu.unit_id, d, t.start_time, t.end_time, t.session_type, coalesce(t.room_id, pc.room_id), pc.trainer_id;
$$;

create or replace function public.prereq_class_admin(p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, hr as $$
declare v_course text := nullif(p_data->>'courseId', ''); v_class public.prereq_classes; x jsonb;
begin
  if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
    raise exception 'Admins and RTO Managers only' using errcode = '42501';
  end if;
  if v_course is null then raise exception 'Choose a course' using errcode = '22023'; end if;
  if p_action = 'save' then
    if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'Only an RTO Manager can change the Prerequisite class' using errcode = '42501'; end if;
    insert into public.prereq_classes(course_id) values (v_course) on conflict (course_id) do nothing;
    update public.prereq_classes set trainer_id = nullif(p_data->>'trainerId', '')::uuid, room_id = nullif(p_data->>'roomId', '')::uuid,
      updated_at = now() where course_id = v_course returning * into v_class;
    delete from public.prereq_class_times where class_id = v_class.id;
    for x in select value from jsonb_array_elements(coalesce(p_data->'times', '[]'::jsonb)) loop
      insert into public.prereq_class_times(class_id, weekday, start_time, end_time, session_type, room_id)
      values (v_class.id, (x->>'weekday')::smallint, (x->>'start')::time, (x->>'end')::time, coalesce(nullif(x->>'type', ''), 'theory'),
        nullif(x->>'roomId', '')::uuid);
    end loop;
  elsif p_action <> 'get' then
    raise exception 'Unknown action' using errcode = '22023';
  end if;
  select * into v_class from public.prereq_classes where course_id = v_course;
  return jsonb_build_object(
    'class', case when v_class.id is null then null else jsonb_build_object('id', v_class.id, 'name', v_class.name, 'trainerId', v_class.trainer_id,
      'roomId', v_class.room_id) end,
    'times', coalesce((select jsonb_agg(jsonb_build_object('weekday', t.weekday, 'start', to_char(t.start_time, 'HH24:MI'), 'end', to_char(t.end_time, 'HH24:MI'),
      'type', t.session_type, 'roomId', t.room_id) order by t.weekday, t.start_time) from public.prereq_class_times t where t.class_id = v_class.id), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(m order by m->>'from') from (
      select jsonb_build_object('studentId', st.id, 'name', st.full_name, 'email', st.email, 'intake', ci.name, 'intakeStart', ci.start_date,
        'from', min(cu.start_date), 'to', max(cu.end_date),
        'returnOn', (select min(iu.start_date) from public.intake_units iu where iu.intake_id = ci.id and iu.start_date > max(cu.end_date)),
        'units', jsonb_agg(jsonb_build_object('code', u.code, 'name', u.name, 'start', cu.start_date, 'end', cu.end_date) order by cu.start_date)) m
      from public.student_prereq_catchup cu join public.batch_enrolments e on e.id = cu.enrolment_id and e.status in ('active', 'deferred')
      join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id and ci.course_id = v_course
      join public.enrollment_students st on st.id = e.student_id join public.cms_course_units u on u.id = cu.unit_id
      group by st.id, st.full_name, st.email, ci.id, ci.name, ci.start_date) q), '[]'::jsonb));
end;
$$;

-- The signed-in student's (member) or trainer's (the class's trainer) Prerequisite classes, in the my_class_schedule session shape.
create or replace function public.my_prereq_classes(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public, hr as $$
declare v_student uuid := public.portal_student_id(); v_staff uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 120 then raise exception 'Choose up to 120 days' using errcode = '22023'; end if;
  if v_student is null then v_staff := public.asm_trainer_profile(); end if;
  if v_student is null and v_staff is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', 'prereq:' || s.class_id || ':' || s.unit_id || ':' || s.session_date || ':' || s.start_time,
      'date', s.session_date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type,
      'status', 'scheduled', 'batchName', 'Prerequisites', 'courseName', coalesce(nullif(c.name, ''), c.code), 'courseCode', c.code,
      'unitCode', u.code, 'unitName', u.name, 'room', r.name, 'campus', r.campus, 'prerequisite', true,
      'trainers', coalesce((select btrim(p.first_name || ' ' || p.last_name) from hr.staff_profiles p where p.id = s.trainer_id), ''))
      order by s.session_date, s.start_time)
    from public.prereq_class_sessions(p_from, p_to) s join public.cms_courses c on c.id = s.course_id
    left join public.cms_course_units u on u.id = s.unit_id left join public.classrooms r on r.id = s.room_id
    where (v_student is not null and v_student = any(s.student_ids)) or (v_staff is not null and s.trainer_id = v_staff)), '[]'::jsonb);
end;
$$;

-- Prerequisite classes for LMS > Timetable, in the admin_class_calendar shape (filters: courseId, staffId, roomId, studentId).
create or replace function public.admin_prereq_sessions(p_from date, p_to date, p_filter jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, hr as $$
declare f jsonb := coalesce(p_filter, '{}'::jsonb);
begin
  if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
    raise exception 'Admins and RTO Managers only' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 93 then raise exception 'Choose up to 93 days' using errcode = '22023'; end if;
  if nullif(f->>'intakeId', '') is not null or nullif(f->>'batchId', '') is not null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', 'prereq:' || s.class_id || ':' || s.unit_id || ':' || s.session_date || ':' || s.start_time,
      'date', s.session_date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type,
      'status', 'scheduled', 'batchId', null, 'batch', 'Prerequisites', 'intakeId', null, 'intakeStart', null, 'intakeEnd', null,
      'courseId', s.course_id, 'courseCode', c.code, 'courseName', c.name, 'unitId', s.unit_id, 'unitCode', u.code, 'unitName', u.name,
      'roomId', s.room_id, 'room', r.name, 'campus', r.campus, 'prerequisite', true,
      'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name))) from hr.staff_profiles p where p.id = s.trainer_id), '[]'::jsonb),
      'students', cardinality(s.student_ids), 'attendance', null,
      'studentList', (select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.full_name, 'email', st.email) order by st.full_name)
        from public.enrollment_students st where st.id = any(s.student_ids)))
      order by s.session_date, s.start_time)
    from public.prereq_class_sessions(p_from, p_to, nullif(f->>'courseId', '')) s join public.cms_courses c on c.id = s.course_id
    left join public.cms_course_units u on u.id = s.unit_id left join public.classrooms r on r.id = s.room_id
    where (nullif(f->>'staffId', '') is null or s.trainer_id = (f->>'staffId')::uuid)
      and (nullif(f->>'roomId', '') is null or s.room_id = (f->>'roomId')::uuid)
      and (nullif(f->>'studentId', '') is null or (f->>'studentId')::uuid = any(s.student_ids))), '[]'::jsonb);
end;
$$;

revoke all on function public.prereq_class_ensure(), public.prereq_class_sessions(date, date, text), public.prereq_class_admin(text, jsonb),
  public.my_prereq_classes(date, date), public.admin_prereq_sessions(date, date, jsonb) from public, anon;
grant execute on function public.prereq_class_admin(text, jsonb), public.my_prereq_classes(date, date), public.admin_prereq_sessions(date, date, jsonb) to authenticated;

commit;
