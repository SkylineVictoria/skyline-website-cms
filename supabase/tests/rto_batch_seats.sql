begin;
-- BATCH-SEATS (20261118100000): physical seats, the seat guard on every path, automatic new batches (own room, else "needs a room"), idempotent
-- placement, course class defaults (first batch and its calendar), permissions, and the LMS intake link getting a seat. Fixtures only; rolled back.
-- Run: node scripts/lab/staff-lab.mjs sql
select plan(92);

select set_config('rto.auto_place', 'on', false); -- fixtures and the automatic paths; switched off to prove the hand paths are closed
create temp table t(k text primary key, v text);
grant all on t to public;
create function pg_temp.v(text) returns uuid language sql stable as $$ select v::uuid from t where k = $1 $$;
create function pg_temp.put(text, text) returns void language sql as $$ insert into t values ($1, $2) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', p::text, true); end $$; -- the RPCs authorise by the signed-in CMS user, not by database role
create function pg_temp.as_admin_session(p uuid) returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claim.sub', p::text, true); end $$;

-- ---------------------------------------------------------------- fixtures
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data, aud, role) values
 ('a6000000-0000-0000-0000-000000000001', 'seat.admin@example.test', now(), '{}', 'authenticated', 'authenticated'),
 ('a6000000-0000-0000-0000-000000000002', 'seat.editor@example.test', now(), '{}', 'authenticated', 'authenticated');
insert into public.cms_users(id, name, email, role, status, auth_user_id, must_change_password, rto_manager) values
 ('seat-admin', 'Seat Admin', 'seat.admin@example.test', 'Admin', 'Active', 'a6000000-0000-0000-0000-000000000001', false, true),
 ('seat-editor', 'Seat Editor', 'seat.editor@example.test', 'Editor', 'Active', 'a6000000-0000-0000-0000-000000000002', false, false);
insert into public.agencies(id, name, code) values ('c6000000-0000-0000-0000-000000000001', 'Seat Agency', 'SEAT-AG');
insert into public.enrollment_students(id, agency_id, full_name, email)
 select ('e6000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'c6000000-0000-0000-0000-000000000001', 'Seat Student ' || n, 'seat.student' || n || '@example.test' from generate_series(1, 14) n;
insert into public.locations(id, name, kind) values ('16000000-0000-0000-0000-000000000001', 'Seat Campus', 'theory');
insert into public.classrooms(id, name, capacity, is_active, location_id) values
 ('17000000-0000-0000-0000-00000000000a', 'Seat Room A', 2, true, '16000000-0000-0000-0000-000000000001'),
 ('17000000-0000-0000-0000-00000000000b', 'Seat Room B', 2, true, '16000000-0000-0000-0000-000000000001');
insert into public.cms_courses(id, slug, code, name, status) values
 ('course-seat-1', 'seat-course-1', 'SEAT1', 'Seat Course One', 'Published'), ('course-seat-2', 'seat-course-2', 'SEAT2', 'Seat Course Two', 'Published'),
 ('course-seat-3', 'seat-course-3', 'SEAT3', 'Seat Course Three', 'Published');
insert into public.cms_course_units(id, course_id, code, name, nominal_hours) values
 ('unit-seat-1', 'course-seat-1', 'SU1', 'Seat unit one', 20), ('unit-seat-2', 'course-seat-2', 'SU2', 'Seat unit two', 20), ('unit-seat-3', 'course-seat-3', 'SU3', 'Seat unit three', 20);
-- course 1: a running intake with batch G1 in Room A (Mondays); course 2: an open intake with NO batch; course 3: an open intake with no batch and no defaults
insert into public.course_intakes(id, course_id, start_date, end_date, status, is_active) values
 ('f6000000-0000-0000-0000-000000000001', 'course-seat-1', current_date - 30, current_date + 300, 'open', true),
 ('f6000000-0000-0000-0000-000000000002', 'course-seat-2', current_date + 10, current_date + 200, 'open', true),
 ('f6000000-0000-0000-0000-000000000003', 'course-seat-3', current_date + 10, current_date + 200, 'open', true);
insert into public.intake_units(intake_id, unit_id, start_date, end_date) values
 ('f6000000-0000-0000-0000-000000000001', 'unit-seat-1', current_date - 30, current_date + 300),
 ('f6000000-0000-0000-0000-000000000002', 'unit-seat-2', current_date + 10, current_date + 200),
 ('f6000000-0000-0000-0000-000000000003', 'unit-seat-3', current_date + 10, current_date + 200);
insert into public.batches(id, intake_id, name, classroom_id) values ('f6000000-0000-0000-0000-000000000011', 'f6000000-0000-0000-0000-000000000001', 'G1', '17000000-0000-0000-0000-00000000000a');
insert into public.batch_sessions(batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
 values ('f6000000-0000-0000-0000-000000000011', 1, 'morning', time '09:00', time '13:00', 'theory', '17000000-0000-0000-0000-00000000000a', 1);
select public.rto_batch_sync_legacy('f6000000-0000-0000-0000-000000000011');

-- ---------------------------------------------------------------- seats
select is(public.rto_batch_seats('f6000000-0000-0000-0000-000000000011'), 2, 'seats: the room''s seats');
insert into public.batches(id, intake_id, name, classroom_id, capacity, is_active) values ('f6000000-0000-0000-0000-000000000012', 'f6000000-0000-0000-0000-000000000001', 'GX', '17000000-0000-0000-0000-00000000000a', 1, false);
select is(public.rto_batch_seats('f6000000-0000-0000-0000-000000000012'), 1, 'seats: a batch limit below the room''s seats wins');
update public.batches set capacity = 9 where id = 'f6000000-0000-0000-0000-000000000012';
select is(public.rto_batch_seats('f6000000-0000-0000-0000-000000000012'), 2, 'seats: a batch limit above the room''s seats cannot add seats');
insert into public.batches(id, intake_id, name, is_active) values ('f6000000-0000-0000-0000-000000000013', 'f6000000-0000-0000-0000-000000000001', 'GR', false);
select is(public.rto_batch_seats('f6000000-0000-0000-0000-000000000013'), 25, 'seats: no room and no limit is 25');
insert into public.course_class_defaults(course_id, seats) values ('course-seat-1', 10);
select is(public.rto_batch_seats('f6000000-0000-0000-0000-000000000013'), 10, 'seats: the course default applies without a room');
delete from public.course_class_defaults where course_id = 'course-seat-1';

-- ---------------------------------------------------------------- the seat guard (every path)
select is(public.rto_batch_occupancy('f6000000-0000-0000-0000-000000000011', current_date), 0, 'occupancy starts at 0');
insert into public.batch_enrolments(batch_id, student_id) values ('f6000000-0000-0000-0000-000000000011', 'e6000000-0000-0000-0000-000000000001');
insert into public.batch_enrolments(batch_id, student_id) values ('f6000000-0000-0000-0000-000000000011', 'e6000000-0000-0000-0000-000000000002');
select is(public.rto_batch_occupancy('f6000000-0000-0000-0000-000000000011', current_date), 2, 'occupancy counts students in their stay');
select throws_ok($$insert into public.batch_enrolments(batch_id, student_id) values ('f6000000-0000-0000-0000-000000000011', 'e6000000-0000-0000-0000-000000000003')$$,
 '23514', 'G1 is full (2 seats).', 'a full batch refuses another student');
update public.batch_enrolments set status = 'withdrawn' where batch_id = 'f6000000-0000-0000-0000-000000000011' and student_id = 'e6000000-0000-0000-0000-000000000002';
select is(public.rto_batch_occupancy('f6000000-0000-0000-0000-000000000011', current_date), 1, 'a withdrawn student frees the seat');
insert into public.batch_enrolments(batch_id, student_id) values ('f6000000-0000-0000-0000-000000000011', 'e6000000-0000-0000-0000-000000000003');
select throws_ok($$update public.batch_enrolments set status = 'active' where batch_id = 'f6000000-0000-0000-0000-000000000011' and student_id = 'e6000000-0000-0000-0000-000000000002'$$,
 '23514', 'G1 is full (2 seats).', 'bringing a withdrawn student back needs a free seat');
select throws_ok($$insert into public.batch_enrolments(batch_id, student_id) values ('f6000000-0000-0000-0000-000000000011', 'e6000000-0000-0000-0000-000000000004')$$,
 '23514', 'G1 is full (2 seats).', 'the guard covers a plain insert (carry-over, move and LMS use the same table)');
select ok(not exists(select 1 from public.batch_enrolments where student_id = 'e6000000-0000-0000-0000-000000000004'), 'a refused student is not left half placed');
select is(public.rto_batch_occupancy('f6000000-0000-0000-0000-000000000011', current_date + 400), 0, 'seats free again once everyone''s last unit has ended');

-- ---------------------------------------------------------------- automatic new batches (as an RTO Manager)
select pg_temp.as_user('a6000000-0000-0000-0000-000000000001');
select pg_temp.put('r4', public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000004', 'intakeId', 'f6000000-0000-0000-0000-000000000001'))::text);
select is((select v::jsonb->>'batch' from t where k = 'r4'), 'G2', 'a full G1: the next student opens G2');
select is((select v::jsonb->>'openedBatch' from t where k = 'r4'), 'true', 'the answer says a batch was opened');
select is((select classroom_id from public.batches where name = 'G2' and intake_id = 'f6000000-0000-0000-0000-000000000001'), '17000000-0000-0000-0000-00000000000b'::uuid, 'G2 takes the other free room (never the same room at the same time)');
select is((select auto_created from public.batches where name = 'G2' and intake_id = 'f6000000-0000-0000-0000-000000000001'), true, 'G2 is marked as opened by the system');
select is((select count(*)::int from public.batch_sessions s join public.batches b on b.id = s.batch_id where b.name = 'G2' and b.intake_id = 'f6000000-0000-0000-0000-000000000001' and s.weekday = 1 and s.room_id = '17000000-0000-0000-0000-00000000000b'),
 1, 'G2 has the same weekly class, in its own room');
select ok((select count(*) from public.class_sessions c join public.batches b on b.id = c.batch_id where b.name = 'G2' and b.intake_id = 'f6000000-0000-0000-0000-000000000001') > 0, 'an RTO Manager''s new batch has its dated classes at once');
select pg_temp.put('r5', public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000005', 'intakeId', 'f6000000-0000-0000-0000-000000000001'))::text);
select is((select v::jsonb->>'batch' from t where k = 'r5') || '/' || (select v::jsonb->>'openedBatch' from t where k = 'r5'), 'G2/false', 'the next student takes the free seat in G2, no new batch');
select pg_temp.put('r6', public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000006', 'intakeId', 'f6000000-0000-0000-0000-000000000001'))::text);
select is((select v::jsonb->>'batch' from t where k = 'r6'), 'G3', 'G1 and G2 full: G3 opens');
select is((select classroom_id is null from public.batches where name = 'G3' and intake_id = 'f6000000-0000-0000-0000-000000000001'), true, 'no free room left: G3 is opened without a room (needs a room)');
select pg_temp.put('r6b', public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000007', 'intakeId', 'f6000000-0000-0000-0000-000000000001'))::text);
select is((select v::jsonb->>'batch' from t where k = 'r6b'), 'G3', 'students wait in the roomless batch instead of opening a new one each time');
select is((select (public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000004', 'intakeId', 'f6000000-0000-0000-0000-000000000001')))->>'enrolmentId'),
 (select (v::jsonb->>'enrolmentId') from t where k = 'r4'), 'placing the same student again changes nothing (idempotent)');
select is((select count(*)::int from public.batches where intake_id = 'f6000000-0000-0000-0000-000000000001' and auto_created), 2, 'and no extra batch was opened by the repeat');
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id where b.intake_id = 'f6000000-0000-0000-0000-000000000001' and e.student_id = 'e6000000-0000-0000-0000-000000000004'), 1, 'the student has one place');

-- the board
select ok((select jsonb_array_length(public.rto_batch_place('seat_board')) >= 3), 'the seat board lists the batches');
select is((select (x->>'occupied') || '/' || (x->>'seats') from jsonb_array_elements(public.rto_batch_place('seat_board')) x where x->>'batch' = 'G1' and x->>'intakeId' = 'f6000000-0000-0000-0000-000000000001'), '2/2', 'the board shows seats in use');
select is((select (x->>'needsRoom')::boolean from jsonb_array_elements(public.rto_batch_place('seat_board')) x where x->>'batch' = 'G3' and x->>'intakeId' = 'f6000000-0000-0000-0000-000000000001'), true, 'the board flags a batch that needs a room');
select is((select (rto_batch_json(b))->>'seats' from public.batches b where b.id = 'f6000000-0000-0000-0000-000000000011'), '2', 'the batch JSON carries the seats');
select is((select (rto_batch_json(b))->>'occupied' from public.batches b where b.id = 'f6000000-0000-0000-0000-000000000011'), '2', 'and the seats in use');

-- ---------------------------------------------------------------- manual open
select is((select (public.rto_batch_place('batch_open', jsonb_build_object('batchId', 'f6000000-0000-0000-0000-000000000011')))->>'name'), 'G4', 'an RTO Manager can open a batch by hand (next free name)');

-- ---------------------------------------------------------------- course class defaults: first batch and calendar
select throws_ok($$select public.rto_batch_place('defaults_set', jsonb_build_object('courseId', 'course-seat-2', 'sessions', jsonb_build_array(jsonb_build_object('weekday', 9, 'startTime', '09:00', 'endTime', '13:00'))))$$,
 '22023', 'Each class needs a day (1-7), a start and a later end time, and a type.', 'defaults refuse an impossible class');
select is((public.rto_batch_place('defaults_set', jsonb_build_object('courseId', 'course-seat-2', 'seats', 3, 'classroomId', '17000000-0000-0000-0000-00000000000a',
 'sessions', jsonb_build_array(jsonb_build_object('weekday', 2, 'startTime', '10:00', 'endTime', '14:00', 'type', 'theory'))))->>'seats'), '3', 'defaults are saved');
select is((select jsonb_array_length(public.rto_batch_place('defaults_get', jsonb_build_object('courseId', 'course-seat-2'))->'sessions')), 1, 'and read back');
select pg_temp.put('r7', public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000008', 'courseId', 'course-seat-2'))::text);
select is((select v::jsonb->>'batch' from t where k = 'r7'), 'G1', 'an intake with no batch gets its first batch from the course defaults');
select is((select count(*)::int from public.batch_sessions where batch_id = (select (v::jsonb->>'batchId')::uuid from t where k = 'r7')), 1, 'with the course''s weekly class');
select ok((select count(*) from public.class_sessions where batch_id = (select (v::jsonb->>'batchId')::uuid from t where k = 'r7')) > 0, 'and its dated calendar generated from the units');
select is((select v::jsonb->>'intakeId' from t where k = 'r7'), 'f6000000-0000-0000-0000-000000000002', 'the student was placed in the course''s open intake');
select is((select (v::jsonb->>'seats') from t where k = 'r7'), '2', 'seats: the default asked for 3 but the room has 2');

-- ---------------------------------------------------------------- permissions
select pg_temp.as_user('a6000000-0000-0000-0000-000000000002');
select throws_ok($$select public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000009', 'intakeId', 'f6000000-0000-0000-0000-000000000001'))$$,
 '42501', 'Only an Admin or an RTO Manager can place students.', 'an editor cannot place students');
select throws_ok($$select public.rto_batch_place('defaults_set', jsonb_build_object('courseId', 'course-seat-2'))$$, '42501', 'Only an RTO Manager can change course class defaults.', 'an editor cannot change course defaults');
select lives_ok($$select public.rto_batch_place('seat_board')$$, 'staff can read the seat board');
reset role;
select ok(not has_function_privilege('anon', 'public.rto_batch_place(text, jsonb)', 'execute') and not has_function_privilege('authenticated', 'public.rto_batch_assign(uuid, text, uuid, text, date)', 'execute'),
 'anonymous cannot call the screens'' RPC and no browser can call the allocator directly');

-- ---------------------------------------------------------------- the LMS intake link gets a seat
select pg_temp.as_admin_session('a6000000-0000-0000-0000-000000000001');
insert into public.lms_intake_students(intake_id, student_id) values ('f6000000-0000-0000-0000-000000000002', 'e6000000-0000-0000-0000-000000000010');
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id where b.intake_id = 'f6000000-0000-0000-0000-000000000002' and e.student_id = 'e6000000-0000-0000-0000-000000000010' and e.status = 'active'), 1,
 'allocating a student to an intake in the LMS gives them a batch seat');
insert into public.lms_intake_students(intake_id, student_id) values ('f6000000-0000-0000-0000-000000000003', 'e6000000-0000-0000-0000-000000000011');
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id where b.intake_id = 'f6000000-0000-0000-0000-000000000003'), 0,
 'an intake no batch can be made for leaves the LMS allocation standing without a seat');
select ok((select public.rto_batch_place('unplaced') @> jsonb_build_array(jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000011')) is not null
 and exists(select 1 from jsonb_array_elements(public.rto_batch_place('unplaced')) x where x->>'studentId' = 'e6000000-0000-0000-0000-000000000011')), 'and lists the student under "needs a batch"');
select ok(not exists(select 1 from jsonb_array_elements(public.rto_batch_place('unplaced')) x where x->>'studentId' = 'e6000000-0000-0000-0000-000000000010'), 'a placed student is not listed');

-- ---------------------------------------------------------------- Joins on (20261118110000)
insert into public.batches(id, intake_id, name, capacity) values ('f6000000-0000-0000-0000-000000000020', 'f6000000-0000-0000-0000-000000000001', 'JT', 5);
select set_config('rto.auto_place', 'off', false);
select throws_ok($$insert into public.batch_enrolments(batch_id, student_id) values ('f6000000-0000-0000-0000-000000000020', 'e6000000-0000-0000-0000-000000000012')$$, '42501',
 'Students are placed in batches automatically when their offer is accepted.', 'a student cannot be added to a batch by hand');
select throws_ok($$select public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000012', 'intakeId', 'f6000000-0000-0000-0000-000000000001'))$$, '42501',
 'Students are placed in batches automatically when their offer is accepted.', 'nor placed through the old assign call');
select ok(to_regprocedure('public.rto_batch_join(uuid,uuid,text,date)') is null, 'the hand-picked join no longer exists');
select set_config('rto.auto_place', 'on', false);

-- ---------------------------------------------------------------- Prerequisites first (20261118120000)
insert into public.cms_courses(id, slug, code, name, status) values ('course-seat-4', 'seat-course-4', 'SEAT4', 'Seat Course Four', 'Published');
insert into public.cms_course_units(id, course_id, code, name, nominal_hours, tga_prerequisites, sort) values
 ('unit-pa', 'course-seat-4', 'SPA1', 'Prerequisite unit', 20, null, 1), ('unit-pb', 'course-seat-4', 'SPB1', 'Needs the prerequisite', 20, 'SPA1', 2), ('unit-pc', 'course-seat-4', 'SPC1', 'Regular unit', 20, null, 3);
insert into public.course_intakes(id, course_id, start_date, end_date, status, is_active) values ('f6000000-0000-0000-0000-000000000004', 'course-seat-4', current_date - 30, current_date + 60, 'open', true);
insert into public.intake_units(intake_id, unit_id, start_date, end_date, sort) values
 ('f6000000-0000-0000-0000-000000000004', 'unit-pa', current_date - 30, current_date - 20, 1), ('f6000000-0000-0000-0000-000000000004', 'unit-pb', current_date - 19, current_date + 30, 2),
 ('f6000000-0000-0000-0000-000000000004', 'unit-pc', current_date + 31, current_date + 60, 3);
insert into public.batches(id, intake_id, name, capacity) values ('f6000000-0000-0000-0000-000000000040', 'f6000000-0000-0000-0000-000000000004', 'PR', 5);
with ins as (insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on) values ('f6000000-0000-0000-0000-000000000040', 'e6000000-0000-0000-0000-000000000011', 'CoE', 'active', current_date - 25) returning id) select pg_temp.put('pr_early', (select id::text from ins));
with ins as (insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on) values ('f6000000-0000-0000-0000-000000000040', 'e6000000-0000-0000-0000-000000000012', 'CoE', 'active', current_date - 5) returning id) select pg_temp.put('pr_late', (select id::text from ins));
select is((select count(*)::int from public.rto_enrolment_units(pg_temp.v('pr_early'))), 3, 'joining while the prerequisite runs: the student takes every unit');
select is((select count(*)::int from public.rto_enrolment_units(pg_temp.v('pr_late'))), 0, 'joining after the prerequisite ended: no unit of this intake now (prerequisites first, in the next intake)');
select ok(exists(select 1 from public.rto_unit_requires('unit-pb') r where r = 'unit-pa'), 'the prerequisite is read from the unit''s Training.gov.au text');
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id where e.student_id = 'e6000000-0000-0000-0000-000000000012' and ci.course_id = 'course-seat-4' and e.carry_over and ci.id <> 'f6000000-0000-0000-0000-000000000004'), 1, 'the late joiner is carried into the next intake of the course');
select is((select count(*)::int from public.rto_enrolment_units(pg_temp.v('pr_early')) where unit_id = 'unit-pa'), 1, 'the running prerequisite is among the early joiner''s units');

-- ---------------------------------------------------------------- Late joiner goes to the next intake (20261118150000)
select ok(public.rto_prereq_missed('e6000000-0000-0000-0000-000000000009', 'f6000000-0000-0000-0000-000000000004', current_date), 'joining today, the prerequisite unit has ended: missed');
select ok(not public.rto_prereq_missed('e6000000-0000-0000-0000-000000000009', 'f6000000-0000-0000-0000-000000000004', current_date - 25), 'joining while it runs: not missed');
select pg_temp.put('late', public.rto_batch_place('assign', jsonb_build_object('studentId', 'e6000000-0000-0000-0000-000000000009', 'intakeId', 'f6000000-0000-0000-0000-000000000004', 'type', 'CoE'))::text);
select isnt((select v::jsonb->>'intakeId' from t where k = 'late'), 'f6000000-0000-0000-0000-000000000004', 'a late joiner is placed in the next intake');
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id where b.intake_id = 'f6000000-0000-0000-0000-000000000004' and e.student_id = 'e6000000-0000-0000-0000-000000000009'), 0, 'and takes no seat in the intake they missed');
select is((select count(*)::int from public.rto_enrolment_units((select (v::jsonb->>'enrolmentId')::uuid from t where k = 'late'))), 3, 'where they take every unit, prerequisite first');

-- ---------------------------------------------------------------- Student study card (20261118130000)
select is((select jsonb_array_length(public.admin_student_study('e6000000-0000-0000-0000-000000000011'))), 1, 'the student page lists where the student studies');
select is((select jsonb_array_length(public.admin_student_study('e6000000-0000-0000-0000-000000000011')->0->'units')), 3, 'with the units they take');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000099');
select throws_ok($$select public.admin_student_study('e6000000-0000-0000-0000-000000000011')$$, '42501', 'Sign in to the CMS first.', 'only staff can read it');
select pg_temp.as_admin_session('a6000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------- Student progress (20261118140000)
select is((select (public.admin_student_progress('e6000000-0000-0000-0000-000000000011')->0->>'total')::int), 3, 'progress counts every unit of the student''s intake');
select is((select (public.admin_student_progress('e6000000-0000-0000-0000-000000000011')->0->>'competent')::int), 0, 'and none are competent without a result');
select ok((select count(*) from jsonb_array_elements(public.admin_student_progress('e6000000-0000-0000-0000-000000000012')) c, jsonb_array_elements(c->'units') u
 where c->>'courseCode' = 'SEAT4' and u->>'code' = 'SPA1' and u->>'status' = 'competent') = 0 and (select count(*) from jsonb_array_elements(public.admin_student_progress('e6000000-0000-0000-0000-000000000012')) c, jsonb_array_elements(c->'units') u
 where c->>'courseCode' = 'SEAT4' and u->>'code' = 'SPA1') = 1, 'the late joiner''s missed prerequisite is listed once and not as finished');
select is((select jsonb_array_length(public.admin_student_schedule('e6000000-0000-0000-0000-000000000011', current_date, current_date + 30))), 0, 'the staff schedule reads (no classes generated for the fixture)');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000099');
select throws_ok($$select public.admin_student_progress('e6000000-0000-0000-0000-000000000011')$$, '42501', 'Sign in to the CMS first.', 'only staff can read a student''s progress');
select pg_temp.as_admin_session('a6000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------- Automatic placement (20261118180000)
select set_config('rto.auto_place', 'off', false);
insert into public.enrollment_applications(id, agency_id, status, student_name, student_email, student_id) values
 ('b6000000-0000-0000-0000-000000000013', 'c6000000-0000-0000-0000-000000000001', 'submitted', 'Seat Student 13', 'seat.student13@example.test', 'e6000000-0000-0000-0000-000000000013'),
 ('b6000000-0000-0000-0000-000000000014', 'c6000000-0000-0000-0000-000000000001', 'submitted', 'Seat Student 14', 'seat.student14@example.test', 'e6000000-0000-0000-0000-000000000014');
select set_config('portal.draft_command', 'b6000000-0000-0000-0000-000000000013', false);
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id) values ('b6000000-0000-0000-0000-000000000013', 'course-seat-2', 'SEAT2', 'Seat Course Two', 'f6000000-0000-0000-0000-000000000002');
select set_config('portal.draft_command', 'b6000000-0000-0000-0000-000000000014', false);
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id) values ('b6000000-0000-0000-0000-000000000014', 'course-seat-3', 'SEAT3', 'Seat Course Three', 'f6000000-0000-0000-0000-000000000003');
select is((select count(*)::int from public.batch_enrolments where student_id = 'e6000000-0000-0000-0000-000000000013'), 0, 'a submitted application places nobody');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000099');
update public.enrollment_applications set status = 'offer_accepted' where id = 'b6000000-0000-0000-0000-000000000013';
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id where e.student_id = 'e6000000-0000-0000-0000-000000000013' and b.intake_id = 'f6000000-0000-0000-0000-000000000002' and e.status = 'active'), 1,
 'accepting the offer places the student in a batch of the application''s intake, with nobody choosing');
select ok(exists(select 1 from public.class_sessions cs join public.batches b on b.id = cs.batch_id where b.intake_id = 'f6000000-0000-0000-0000-000000000002'), 'and the batch has its class calendar');
update public.enrollment_applications set status = 'withdrawn' where id = 'b6000000-0000-0000-0000-000000000013';
select is((select status from public.batch_enrolments where student_id = 'e6000000-0000-0000-0000-000000000013' order by enrolled_on desc limit 1), 'withdrawn', 'a withdrawn application withdraws the placement');
update public.enrollment_applications set status = 'offer_accepted' where id = 'b6000000-0000-0000-0000-000000000014';
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id where e.student_id = 'e6000000-0000-0000-0000-000000000014'), 0, 'a course that cannot open a batch leaves the student waiting');
select pg_temp.as_admin_session('a6000000-0000-0000-0000-000000000001');
select ok(exists(select 1 from jsonb_array_elements(public.rto_placement_waiting()) x where x->>'studentId' = 'e6000000-0000-0000-0000-000000000014'), 'and lists them as waiting');
select public.rto_batch_place('defaults_set', jsonb_build_object('courseId', 'course-seat-3', 'seats', 5, 'sessions', jsonb_build_array(jsonb_build_object('weekday', 3, 'startTime', '09:00', 'endTime', '13:00', 'type', 'theory'))));
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id where e.student_id = 'e6000000-0000-0000-0000-000000000014' and e.status = 'active'), 1, 'setting the course''s usual classes places the waiting student by itself');
select is(public.rto_auto_place_sweep(), 0, 'the sweep has nothing left to place');
select set_config('rto.auto_place', 'on', false);

-- ---------------------------------------------------------------- Staff override (20261118180000)
select set_config('rto.auto_place', 'off', false);
insert into public.batches(id, intake_id, name, capacity) values ('f6000000-0000-0000-0000-000000000050', 'f6000000-0000-0000-0000-000000000001', 'OV', 4), ('f6000000-0000-0000-0000-000000000051', 'f6000000-0000-0000-0000-000000000001', 'OV2', 4);
select throws_ok($$select public.rto_staff_place('f6000000-0000-0000-0000-000000000050', 'e6000000-0000-0000-0000-000000000008', 'CoE', current_date, '  ')$$, '22023', 'Say why you are placing this student by hand.', 'an override needs a reason');
select is((public.rto_staff_place('f6000000-0000-0000-0000-000000000050', 'e6000000-0000-0000-0000-000000000008', 'CoE', current_date, 'Joined late after a phone call'))->>'batch', 'OV', 'staff can place a student by hand, with a reason');
select is((select count(*)::int from public.rto_placement_overrides where student_id = 'e6000000-0000-0000-0000-000000000008' and action = 'place' and reason = 'Joined late after a phone call'), 1, 'and it is recorded');
select pg_temp.put('ov_enrol', (select id::text from public.batch_enrolments where batch_id = 'f6000000-0000-0000-0000-000000000050' and student_id = 'e6000000-0000-0000-0000-000000000008'));
select is((public.rto_staff_move(pg_temp.v('ov_enrol'), 'f6000000-0000-0000-0000-000000000051', 'Timetable clash'))->>'batchId', 'f6000000-0000-0000-0000-000000000051', 'staff can move a student to another batch of the course');
select is((select batch_id::text from public.batch_enrolments where id = pg_temp.v('ov_enrol')), 'f6000000-0000-0000-0000-000000000051', 'and the move happened');
select throws_ok($$select public.rto_staff_remove((select id from public.batch_enrolments where batch_id = 'f6000000-0000-0000-0000-000000000051' limit 1), '')$$, '22023', 'Say why you are removing this student.', 'removing needs a reason');
select is((public.rto_staff_remove(pg_temp.v('ov_enrol'), 'Withdrew by phone'))->>'status', 'withdrawn', 'staff can remove a student');
select pg_temp.as_user('a6000000-0000-0000-0000-000000000002');
select throws_ok($$select public.rto_staff_place('f6000000-0000-0000-0000-000000000050', 'e6000000-0000-0000-0000-000000000008', 'CoE', current_date, 'x')$$, '42501', 'Only an Admin or an RTO Manager can place a student by hand.', 'an editor cannot override');
select pg_temp.as_admin_session('a6000000-0000-0000-0000-000000000001');
-- the automation leaves a removed student alone
insert into public.enrollment_applications(id, agency_id, status, student_name, student_email, student_id) values ('b6000000-0000-0000-0000-000000000008', 'c6000000-0000-0000-0000-000000000001', 'submitted', 'Seat Student 8', 'seat.student8@example.test', 'e6000000-0000-0000-0000-000000000008');
select set_config('portal.draft_command', 'b6000000-0000-0000-0000-000000000008', false);
insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, intake_id) values ('b6000000-0000-0000-0000-000000000008', 'course-seat-1', 'SEAT1', 'Seat Course One', null);
update public.enrollment_applications set status = 'offer_accepted' where id = 'b6000000-0000-0000-0000-000000000008';
select is((select count(*)::int from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id where e.student_id = 'e6000000-0000-0000-0000-000000000008' and ci.course_id = 'course-seat-1' and e.status = 'active'), 0, 'a student staff removed is not placed again by the automation');
select ok(not exists(select 1 from jsonb_array_elements(public.rto_placement_waiting()) x where x->>'studentId' = 'e6000000-0000-0000-0000-000000000008'), 'nor listed as waiting');
select is((select jsonb_array_length(public.rto_placement_overrides_list('e6000000-0000-0000-0000-000000000008'))), 3, 'the override log shows place, move and remove');
select set_config('rto.auto_place', 'on', false);

-- ---------------------------------------------------------------- Hours check (20261118170000)
select is((public.rto_batches_hours_check(array['f6000000-0000-0000-0000-000000000020'::uuid])->'f6000000-0000-0000-0000-000000000020'->>'fits')::boolean, false, 'a batch with no weekly classes cannot fit the course hours');
select ok((public.rto_batches_hours_check(array['f6000000-0000-0000-0000-000000000020'::uuid])->'f6000000-0000-0000-0000-000000000020'->>'message') like '%no weekly classes%', 'and says so');
select is((public.rto_batches_hours_check(array['f6000000-0000-0000-0000-000000000011'::uuid])->'f6000000-0000-0000-0000-000000000011'->>'fits')::boolean, true, 'a batch whose classes give enough hours fits');

-- ---------------------------------------------------------------- the two patched functions
select ok(pg_get_functiondef('public.rto_carry_over_plan(uuid, text)'::regprocedure) like '%rto_batch_pick(n.id%', 'the carry-over planner picks batches by free seats');
select * from finish();
rollback;
