-- BATCH-SEATS: physical seats, automatic new batches, one placement entry point, and the LMS intake link tied to a batch.
--
-- Model (owner, 2026-11-18): an INTAKE is a course's dated unit timeline; a BATCH is a class group in a room with physical seats; a STUDENT has
-- both (their intake in the LMS study plan, their seat in a batch). One batch can hold students of different intakes.
--  * Seats: the smaller of the batch's own limit and the seats of the room(s) it uses; with neither set, the course's default seats, else 25.
--    Seats in use = students whose stay (start to last unit) covers the day. Enforced by a trigger on batch_enrolments, so EVERY path
--    (manual enrol, move, carry-over, LMS allocation) refuses a full batch the same way.
--  * public.rto_batch_pick / rto_batch_assign: the first batch with a free seat (the intake's own batches first, then other running
--    batches of the course); when all are full a new one is opened (G2, G3, ...) from the latest batch: same weekly classes and trainers,
--    in ANOTHER free room (a second group cannot sit in the same room at the same time), else without a room, shown as "needs a room".
--  * The carry-over planner picks its batch the same way (it used to ignore seats).
--  * Course class defaults: weekly pattern, room and seats per course, so an intake gets its first batch (and so its dated calendar) at once.
--  * A student allocated to an intake in the LMS is placed in a batch (warning, never an error, when no batch can be made).
-- Additive: one column (batches.auto_created), one table, new functions and triggers; rto_batch_json (seats, occupied, autoCreated) and
-- rto_carry_over_plan (batch pick) and rto_direct_application (no intake link for an intake that has started) are patched in place with exact anchors.
-- Rollback (manual): drop triggers batch_enrolments_seat_guard and lms_intake_students_place; drop the rto_batch_* / rto_intake_default_batch /
-- rto_open_intake / rto_batch_place functions; restore rto_batch_json (20261117130000) and rto_carry_over_plan (20261117213518); drop
-- table public.course_class_defaults; alter table public.batches drop column auto_created.
begin;

alter table public.batches add column auto_created boolean not null default false;

-- ------------------------------------------------------------------ course class defaults
create table public.course_class_defaults(
 course_id text primary key references public.cms_courses(id) on delete cascade,
 seats integer check (seats between 1 and 500),
 classroom_id uuid references public.classrooms(id) on delete set null,
 -- [{"weekday": 1-7, "startTime": "09:00", "endTime": "13:00", "type": "theory|practical|assessment"}]
 sessions jsonb not null default '[]'::jsonb check (jsonb_typeof(sessions) = 'array' and jsonb_array_length(sessions) <= 21),
 updated_at timestamptz not null default now(),
 updated_by uuid default auth.uid()
);
alter table public.course_class_defaults enable row level security;
revoke all on public.course_class_defaults from public, anon, authenticated;

-- ------------------------------------------------------------------ seats
/** Seats of a batch: its own limit and its rooms' seats, whichever is smaller; else the course default; else 25. */
create function public.rto_batch_seats(p_batch uuid) returns integer
language sql stable security definer set search_path = public as $$
 select coalesce(least(b.capacity, rc.cap), d.seats, 25)
 from public.batches b
 join public.course_intakes ci on ci.id = b.intake_id
 left join lateral (select min(r.capacity) as cap from public.classrooms r
   where r.capacity is not null and (r.id = b.classroom_id or r.id in (select s.room_id from public.batch_sessions s where s.batch_id = b.id))) rc on true
 left join public.course_class_defaults d on d.course_id = ci.course_id
 where b.id = p_batch;
$$;

/** Students of the batch whose stay covers the day: started, not withdrawn, and their last unit has not ended. */
create function public.rto_batch_occupancy(p_batch uuid, p_on date default current_date) returns integer
language sql stable security definer set search_path = public as $$
 select count(*)::integer from public.batch_enrolments e
 where e.batch_id = p_batch and e.status in ('active', 'deferred') and e.enrolled_on <= p_on
  and coalesce((select max(u.end_date) from public.rto_enrolment_units(e.id) u), p_on) >= p_on;
$$;

create function public.rto_batch_seat_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_seats integer;
begin
 if new.status not in ('active', 'deferred') then return new; end if;
 if tg_op = 'UPDATE' and old.batch_id = new.batch_id and old.status in ('active', 'deferred') then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_seats:' || new.batch_id::text, 0));
 v_seats := public.rto_batch_seats(new.batch_id);
 if public.rto_batch_occupancy(new.batch_id, new.enrolled_on) >= v_seats then
  raise exception '% is full (% seats).', (select name from public.batches where id = new.batch_id), v_seats using errcode = '23514';
 end if;
 return new;
end $$;
create trigger batch_enrolments_seat_guard before insert or update of status, batch_id, enrolled_on on public.batch_enrolments
 for each row execute function public.rto_batch_seat_guard();

-- ------------------------------------------------------------------ opening a batch
/** The next free name of the intake: G1, G2, ... */
create function public.rto_batch_next_name(p_intake uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_n integer := 1;
begin
 while exists(select 1 from public.batches where intake_id = p_intake and name = 'G' || v_n) loop v_n := v_n + 1; end loop;
 return 'G' || v_n;
end $$;

/**
 * Opens a new batch like p_src (same weekly classes, trainers, unit trainers, own unit dates when it stays in the same intake) in
 * p_intake (default: the same intake). A second group cannot sit in the same room at the same time, so it takes another active room
 * of the same location with seats that is free at every weekly slot while the two intakes overlap; none free: no room ("needs a room").
 * Dated classes are generated here only for an RTO Manager (the generator is theirs); otherwise staff generate them from the batch.
 */
create function public.rto_batch_clone(p_src uuid, p_intake uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.batches; si public.course_intakes; ti public.course_intakes; v_new uuid; v_room uuid; v_src_room uuid; v_loc uuid; v_seats integer;
begin
 select * into s from public.batches where id = p_src;
 if s.id is null then return null; end if;
 select * into si from public.course_intakes where id = s.intake_id;
 select * into ti from public.course_intakes where id = coalesce(p_intake, s.intake_id);
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_clone:' || ti.id::text, 0));
 v_src_room := coalesce(s.classroom_id, (select x.room_id from public.batch_sessions x where x.batch_id = s.id and x.room_id is not null order by x.sort limit 1));
 select r.location_id into v_loc from public.classrooms r where r.id = v_src_room;
 v_seats := public.rto_batch_seats(s.id);
 select r.id into v_room from public.classrooms r
 where r.is_active and coalesce(r.capacity, 0) > 0 and r.id is distinct from v_src_room
  and (v_loc is null or r.location_id is not distinct from v_loc)
  and not exists(
   select 1 from public.batch_sessions o join public.batches ob on ob.id = o.batch_id and ob.is_active
    join public.course_intakes oi on oi.id = ob.intake_id
    join public.batch_sessions mine on mine.batch_id = s.id and mine.weekday = o.weekday and mine.start_time < o.end_time and o.start_time < mine.end_time
   where coalesce(o.room_id, ob.classroom_id) = r.id
    and oi.start_date <= coalesce(ti.end_date, 'infinity'::date) and coalesce(oi.end_date, 'infinity'::date) >= ti.start_date)
 order by (r.capacity >= v_seats) desc, r.capacity desc, r.name limit 1;

 insert into public.batches(intake_id, name, classroom_id, class_days, start_time, end_time, capacity, is_active, auto_created)
 values (ti.id, public.rto_batch_next_name(ti.id), v_room, s.class_days, s.start_time, s.end_time, s.capacity, true, true) returning id into v_new;
 insert into public.batch_trainers(batch_id, staff_id) select v_new, t.staff_id from public.batch_trainers t where t.batch_id = s.id on conflict do nothing;
 insert into public.batch_unit_trainers(batch_id, intake_unit_id, staff_id)
 select v_new, nu.id, t.staff_id from public.batch_unit_trainers t
  join public.intake_units ou on ou.id = t.intake_unit_id join public.intake_units nu on nu.intake_id = ti.id and nu.unit_id = ou.unit_id
 where t.batch_id = s.id on conflict do nothing;
 insert into public.batch_sessions(batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
 select v_new, x.weekday, x.slot, x.start_time, x.end_time, x.session_type, v_room, x.sort from public.batch_sessions x where x.batch_id = s.id;
 if ti.id = si.id then
  insert into public.batch_unit_overrides(batch_id, intake_unit_id, start_date, end_date)
  select v_new, o.intake_unit_id, o.start_date, o.end_date from public.batch_unit_overrides o where o.batch_id = s.id;
 end if;
 perform public.rto_batch_sync_legacy(v_new);
 if exists(select 1 from public.batch_sessions where batch_id = v_new) and coalesce(public.cms_is_rto_manager(), false) then
  begin
   perform set_config('rto.course', ti.course_id, true);
   perform public.rto_class_sessions_generate(v_new);
  exception when others then
   raise warning 'rto_batch_clone: classes for the new batch not generated: %', sqlerrm;
  end;
 end if;
 return v_new;
end $$;

/** The first batch of an intake that has none, made from the course's class defaults (the pattern, room and seats set on the course). */
create function public.rto_intake_default_batch(p_intake uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare ti public.course_intakes; d public.course_class_defaults; v_new uuid; x jsonb; n integer := 0; v_slot text;
begin
 select * into ti from public.course_intakes where id = p_intake;
 select * into d from public.course_class_defaults where course_id = ti.course_id;
 if d.course_id is null or jsonb_array_length(d.sessions) = 0 then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_clone:' || ti.id::text, 0));
 select id into v_new from public.batches where intake_id = ti.id and is_active order by name limit 1;
 if v_new is not null then return v_new; end if;
 insert into public.batches(intake_id, name, classroom_id, capacity, is_active, auto_created)
 values (ti.id, 'G1', d.classroom_id, d.seats, true, true) returning id into v_new;
 for x in select value from jsonb_array_elements(d.sessions) loop
  n := n + 1;
  insert into public.batch_sessions(batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
  values (v_new, (x->>'weekday')::integer, public.rto_slot((x->>'startTime')::time), (x->>'startTime')::time, (x->>'endTime')::time,
   coalesce(nullif(x->>'type', ''), 'theory'), d.classroom_id, n);
 end loop;
 perform public.rto_batch_sync_legacy(v_new);
 if coalesce(public.cms_is_rto_manager(), false) then
  begin
   perform set_config('rto.course', ti.course_id, true);
   perform public.rto_class_sessions_generate(v_new);
  exception when others then
   raise warning 'rto_intake_default_batch: classes not generated: %', sqlerrm;
  end;
 end if;
 return v_new;
end $$;

/**
 * A batch with a free seat for a student of p_intake on p_on. The intake's own batches first (the one named p_prefer first), then, unless
 * p_same, other running batches of the course; when every one is full a new batch is opened from the latest batch. Null: no batch could be made
 * (no batch to copy and no class defaults on the course).
 */
create function public.rto_batch_pick(p_intake uuid, p_prefer text default null, p_on date default current_date, p_same boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare ti public.course_intakes; b record; v_src uuid;
begin
 select * into ti from public.course_intakes where id = p_intake;
 if ti.id is null then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_pick:' || ti.course_id, 0));
 for b in
  select bb.id from public.batches bb join public.course_intakes ci on ci.id = bb.intake_id
  where bb.is_active and ci.course_id = ti.course_id and ci.study_load = ti.study_load
   and (ci.id = ti.id or (not p_same and ci.status = 'open' and ci.start_date <= p_on and coalesce(ci.end_date, 'infinity'::date) >= p_on))
  order by (ci.id = ti.id) desc, (bb.name = p_prefer) desc, ci.start_date, bb.name
 loop
  if public.rto_batch_occupancy(b.id, p_on) < public.rto_batch_seats(b.id) then return b.id; end if;
 end loop;
 -- Every batch is full (or there is none): open another from the intake's latest batch, else the course's latest batch, else the defaults.
 select bb.id into v_src from public.batches bb where bb.intake_id = ti.id and bb.is_active order by bb.name desc, bb.created_at desc limit 1;
 if v_src is null then
  select bb.id into v_src from public.batches bb join public.course_intakes ci on ci.id = bb.intake_id
  where bb.is_active and ci.course_id = ti.course_id and ci.study_load = ti.study_load order by ci.start_date desc, bb.name limit 1;
 end if;
 if v_src is null then return public.rto_intake_default_batch(ti.id); end if;
 return public.rto_batch_clone(v_src, ti.id);
end $$;

-- ------------------------------------------------------------------ placing a student
/** The intake a student joins on a day when none is named: the first open intake running that day, else the next one to start. */
create function public.rto_open_intake(p_course text, p_on date default current_date) returns uuid
language sql stable security definer set search_path = public as $$
 select ci.id from public.course_intakes ci
 where ci.course_id = p_course and ci.is_active and ci.status = 'open' and coalesce(ci.end_date, 'infinity'::date) >= p_on
 order by (ci.start_date <= p_on) desc, ci.start_date, ci.id limit 1;
$$;

/** THE placement: an intake (given, or found, or the next one made) and a batch with a seat. Idempotent: a student already placed there keeps their place. */
create function public.rto_batch_assign(p_student uuid, p_course text, p_intake uuid default null, p_type text default 'CoE', p_on date default current_date) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_intake uuid := p_intake; v_batch uuid; v_enrol uuid; v_latest uuid;
begin
 if v_intake is null then
  v_intake := public.rto_open_intake(p_course, p_on);
  if v_intake is null then
   select ci.id into v_latest from public.course_intakes ci where ci.course_id = p_course order by ci.start_date desc limit 1;
   if v_latest is not null then v_intake := public.rto_intake_auto_next(v_latest); end if;
  end if;
  if v_intake is null then raise exception 'This course has no open intake. Add one first.' using errcode = '22023'; end if;
 end if;
 select e.id into v_enrol from public.batch_enrolments e join public.batches b on b.id = e.batch_id
 where b.intake_id = v_intake and e.student_id = p_student and e.status in ('active', 'deferred') order by e.carry_over, e.enrolled_on limit 1;
 if v_enrol is not null then return v_enrol; end if;
 v_batch := public.rto_batch_pick(v_intake, null, p_on);
 if v_batch is null then
  raise exception 'No batch could be opened for this intake. Set the course''s class days and times first.' using errcode = '22023';
 end if;
 if not public.rto_student_on_course(p_student, p_course) then
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'The student has no application for this course.' using errcode = '22023'; end if;
  perform public.rto_direct_application(p_student, v_intake);
 end if;
 insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on)
 values (v_batch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', p_on)
 on conflict (batch_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type
 returning id into v_enrol;
 return v_enrol;
end $$;

revoke all on function public.rto_batch_seats(uuid), public.rto_batch_occupancy(uuid, date), public.rto_batch_seat_guard(), public.rto_batch_next_name(uuid),
 public.rto_batch_clone(uuid, uuid), public.rto_intake_default_batch(uuid), public.rto_batch_pick(uuid, text, date, boolean),
 public.rto_open_intake(text, date), public.rto_batch_assign(uuid, text, uuid, text, date) from public, anon, authenticated;

-- ------------------------------------------------------------------ the screens' RPC
create function public.rto_batch_place(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_rto boolean := coalesce(public.cms_is_rto_manager(), false); v_admin boolean := coalesce(public.cms_is_admin(), false);
 v_enrol uuid; b public.batches; v_before integer; v_new uuid; v_course text; v_on date;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;

 if p_action = 'assign' then
  if not (v_rto or v_admin) then raise exception 'Only an Admin or an RTO Manager can place students.' using errcode = '42501'; end if;
  v_on := coalesce(nullif(d->>'on', '')::date, current_date);
  v_course := coalesce(nullif(d->>'courseId', ''), (select course_id from public.course_intakes where id = nullif(d->>'intakeId', '')::uuid));
  if v_course is null then raise exception 'Choose a course or an intake.' using errcode = '22023'; end if;
  select count(*) into v_before from public.batches where is_active and intake_id in (select id from public.course_intakes where course_id = v_course);
  v_enrol := public.rto_batch_assign((d->>'studentId')::uuid, v_course, nullif(d->>'intakeId', '')::uuid, coalesce(d->>'type', 'CoE'), v_on);
  select b2.* into b from public.batches b2 join public.batch_enrolments e on e.batch_id = b2.id where e.id = v_enrol;
  return jsonb_build_object('enrolmentId', v_enrol, 'batchId', b.id, 'batch', b.name, 'intakeId', b.intake_id, 'seats', public.rto_batch_seats(b.id),
   'occupied', public.rto_batch_occupancy(b.id, v_on),
   'openedBatch', (select count(*) from public.batches where is_active and intake_id in (select id from public.course_intakes where course_id = v_course)) > v_before);

 elsif p_action = 'batch_open' then
  if not v_rto then raise exception 'Only an RTO Manager can open batches.' using errcode = '42501'; end if;
  v_new := public.rto_batch_clone((d->>'batchId')::uuid, nullif(d->>'intakeId', '')::uuid);
  if v_new is null then raise exception 'Batch not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('batchId', v_new, 'name', (select name from public.batches where id = v_new), 'needsRoom', (select classroom_id is null from public.batches where id = v_new));

 elsif p_action = 'defaults_get' then
  return coalesce((select jsonb_build_object('courseId', course_id, 'seats', seats, 'classroomId', classroom_id, 'sessions', sessions)
   from public.course_class_defaults where course_id = d->>'courseId'), jsonb_build_object('courseId', d->>'courseId', 'seats', null, 'classroomId', null, 'sessions', '[]'::jsonb));

 elsif p_action = 'defaults_set' then
  if not v_rto then raise exception 'Only an RTO Manager can change course class defaults.' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(d->'sessions', '[]'::jsonb)) <> 'array' then raise exception 'Sessions must be a list.' using errcode = '22023'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(d->'sessions', '[]'::jsonb)) x
   where coalesce((x->>'weekday')::integer, 0) not between 1 and 7 or (x->>'startTime') !~ '^[0-2][0-9]:[0-5][0-9]$' or (x->>'endTime') !~ '^[0-2][0-9]:[0-5][0-9]$'
    or (x->>'endTime')::time <= (x->>'startTime')::time or coalesce(nullif(x->>'type', ''), 'theory') not in ('theory', 'practical', 'assessment')) then
   raise exception 'Each class needs a day (1-7), a start and a later end time, and a type.' using errcode = '22023';
  end if;
  insert into public.course_class_defaults(course_id, seats, classroom_id, sessions, updated_at, updated_by)
  values (d->>'courseId', nullif(d->>'seats', '')::integer, nullif(d->>'classroomId', '')::uuid, coalesce(d->'sessions', '[]'::jsonb), now(), auth.uid())
  on conflict (course_id) do update set seats = excluded.seats, classroom_id = excluded.classroom_id, sessions = excluded.sessions, updated_at = now(), updated_by = auth.uid();
  return public.rto_batch_place('defaults_get', jsonb_build_object('courseId', d->>'courseId'));

 elsif p_action = 'seat_board' then
  -- Every active batch by location: room, seats, students now, and whether it still needs a room.
  return coalesce((select jsonb_agg(jsonb_build_object('batchId', bb.id, 'batch', bb.name, 'course', c.name, 'courseId', c.id, 'intakeId', ci.id, 'intakeStart', ci.start_date,
    'room', r.name, 'location', l.name, 'seats', public.rto_batch_seats(bb.id), 'occupied', public.rto_batch_occupancy(bb.id, current_date),
    'needsRoom', bb.classroom_id is null, 'autoCreated', bb.auto_created) order by l.name nulls last, r.name nulls last, c.name, ci.start_date, bb.name)
   from public.batches bb join public.course_intakes ci on ci.id = bb.intake_id join public.cms_courses c on c.id = ci.course_id
   left join public.classrooms r on r.id = bb.classroom_id left join public.locations l on l.id = r.location_id
   where bb.is_active and ci.status in ('open', 'draft') and coalesce(ci.end_date, 'infinity'::date) >= current_date), '[]'::jsonb);

 elsif p_action = 'unplaced' then
  -- Students allocated to an intake in the LMS who have no seat in any batch of that intake yet.
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'intakeId', ci.id, 'courseId', ci.course_id, 'course', c.name, 'intakeStart', ci.start_date)
    order by ci.start_date, s.full_name)
   from public.lms_intake_students li join public.course_intakes ci on ci.id = li.intake_id join public.cms_courses c on c.id = ci.course_id
   join public.enrollment_students s on s.id = li.student_id
   where not exists(select 1 from public.batch_enrolments e join public.batches bb on bb.id = e.batch_id
     where bb.intake_id = li.intake_id and e.student_id = li.student_id and e.status in ('active', 'deferred', 'completed'))), '[]'::jsonb);
 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $$;
revoke all on function public.rto_batch_place(text, jsonb) from public, anon;
grant execute on function public.rto_batch_place(text, jsonb) to authenticated;

-- ------------------------------------------------------------------ patch two existing functions in place (exact anchors, exact counts)
create function pg_temp.seat_patch(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn); v_new text;
begin
 if position(p_old in v_def) = 0 then raise exception 'seat patch: anchor not found in %', p_fn; end if;
 if (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old) <> 1 then raise exception 'seat patch: anchor is not unique in %', p_fn; end if;
 v_new := replace(v_def, p_old, p_new);
 execute v_new;
end $$;

-- Each batch shows its seats, the students in them now, and whether staff or the system opened it.
select pg_temp.seat_patch('public.rto_batch_json(public.batches)'::regprocedure,
 $a$'capacity', b.capacity, 'isActive', b.is_active,$a$,
 $a$'capacity', b.capacity, 'seats', public.rto_batch_seats(b.id), 'occupied', public.rto_batch_occupancy(b.id, current_date), 'autoCreated', b.auto_created, 'isActive', b.is_active,$a$);

-- The carry-over planner puts a student in a batch with a free seat of the same intake (it used to take the first batch whatever its seats).
select pg_temp.seat_patch('public.rto_carry_over_plan(uuid, text)'::regprocedure,
 $a$select b.id into v_batch from public.batches b where b.intake_id = n.id and b.is_active order by (b.name = l.batch_name) desc, b.name, b.id limit 1;$a$,
 $a$v_batch := public.rto_batch_pick(n.id, l.batch_name, greatest((select ci2.start_date from public.course_intakes ci2 where ci2.id = n.id), v_today), true);$a$);

-- A student who joins a RUNNING intake has no application for it: the direct application must not name an intake that has already started
-- (the application rules only accept intakes that have not started), or placing a late joiner fails.
select pg_temp.seat_patch('public.rto_direct_application(uuid, uuid)'::regprocedure,
 $a$case when i.status = 'open' then i.id end$a$,
 $a$case when i.status = 'open' and i.start_date >= public.course_intake_today() then i.id end$a$);

-- ------------------------------------------------------------------ the LMS intake link gets a seat
create function public.rto_lms_place_student() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_course text;
begin
 select ci.course_id into v_course from public.course_intakes ci where ci.id = new.intake_id;
 if exists(select 1 from public.batch_enrolments e join public.batches b on b.id = e.batch_id
   where b.intake_id = new.intake_id and e.student_id = new.student_id and e.status in ('active', 'deferred', 'completed')) then
  return null;
 end if;
 begin
  perform public.rto_batch_assign(new.student_id, v_course, new.intake_id, 'CoE', greatest((new.enrolled_at at time zone 'Australia/Melbourne')::date, (select start_date from public.course_intakes where id = new.intake_id)));
 exception when others then
  -- The LMS allocation stands; the student is listed under "needs a batch" (rto_batch_place unplaced) until a batch can be made.
  raise warning 'rto_lms_place_student: %', sqlerrm;
 end;
 return null;
end $$;
revoke all on function public.rto_lms_place_student() from public, anon, authenticated;
create trigger lms_intake_students_place after insert on public.lms_intake_students for each row execute function public.rto_lms_place_student();

commit;
