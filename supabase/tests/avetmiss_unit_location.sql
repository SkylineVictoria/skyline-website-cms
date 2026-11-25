begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- AVETMISS-LOCATION-FROM-TIMETABLE (20261125153850): a unit enrolment's delivery location (AVETMISS 8.0 NAT00120) comes from the
-- timetable (most face-to-face scheduled hours, theory first on a tie), else the batch's room, else the intake's classroom; the
-- class_sessions statement triggers refresh automatic locations and never touch manual ones.
-- The INSTALLED functions and triggers (pg_get_functiondef / pg_get_triggerdef of public.*) are copied into a scratch schema with
-- small fixture tables, so the live code is exercised without any LMS guard and without touching real rows. Rolled back.
-- Run: node scripts/lab/staff-lab.mjs sql
select plan(17);

create schema avetmiss_loc_t;
create table avetmiss_loc_t.locations (id uuid primary key, name text);
create table avetmiss_loc_t.classrooms (id uuid primary key, name text, location_id uuid);
create table avetmiss_loc_t.course_intakes (id uuid primary key, classroom_id uuid);
create table avetmiss_loc_t.intake_batches (id uuid primary key, intake_id uuid, room_id uuid, archived_at timestamptz);
create table avetmiss_loc_t.intake_enrolments (id uuid primary key, intake_id uuid, student_id uuid, archived_at timestamptz);
create table avetmiss_loc_t.batch_students (enrolment_id uuid, batch_id uuid, unit_id text, archived_at timestamptz);
create table avetmiss_loc_t.class_sessions (id uuid primary key default gen_random_uuid(), intake_id uuid, unit_id text, batch_id uuid,
  room_id uuid, session_type text, status text default 'scheduled', delivery text default 'face_to_face', start_time time, end_time time);
create table avetmiss_loc_t.lms_unit_students (intake_id uuid, unit_id text, student_id uuid, location_id uuid, location_is_auto boolean);

-- Copy the installed code into the scratch schema (only the schema names change).
do $copy$
declare r record; def text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('avetmiss_batch_location', 'class_sessions_avetmiss_location_ins',
                                                        'class_sessions_avetmiss_location_upd', 'class_sessions_avetmiss_location_del') loop
    def := pg_get_functiondef(r.oid);
    def := replace(def, 'FUNCTION public.', 'FUNCTION avetmiss_loc_t.');
    def := replace(def, 'SET search_path TO ''public''', 'SET search_path TO ''avetmiss_loc_t''');
    execute def;
  end loop;
  for r in select oid from pg_trigger where tgrelid = 'public.class_sessions'::regclass and tgname like 'class_sessions_avetmiss_location_%' loop
    def := pg_get_triggerdef(r.oid);
    def := replace(def, 'ON public.class_sessions', 'ON avetmiss_loc_t.class_sessions');
    def := replace(def, 'EXECUTE FUNCTION class_sessions_', 'EXECUTE FUNCTION avetmiss_loc_t.class_sessions_');
    execute def;
  end loop;
end $copy$;
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'avetmiss_loc_t'), 4, 'the four installed functions are copied');
select is((select count(*)::int from pg_trigger where tgrelid = 'avetmiss_loc_t.class_sessions'::regclass and not tgisinternal), 3, 'the three statement triggers are copied');
select ok((select bool_and(prosrc not like '%public.%') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'avetmiss_loc_t'), 'the copies read only the scratch tables');

select set_config('search_path', 'avetmiss_loc_t, ' || current_setting('search_path'), true); -- the fixtures first; pgTAP stays visible

-- ---------------------------------------------------------------- fixtures
-- Locations: A (room A), B (room B), the batch's room, the intake's classroom, and a manual one.
insert into locations values ('10000000-0000-0000-0000-00000000000a', 'Campus A'), ('10000000-0000-0000-0000-00000000000b', 'Campus B'),
  ('10000000-0000-0000-0000-0000000000ba', 'Batch campus'), ('10000000-0000-0000-0000-0000000000c1', 'Intake campus'),
  ('10000000-0000-0000-0000-0000000000ff', 'Manual campus');
insert into classrooms values ('20000000-0000-0000-0000-00000000000a', 'Room A', '10000000-0000-0000-0000-00000000000a'),
  ('20000000-0000-0000-0000-00000000000b', 'Room B', '10000000-0000-0000-0000-00000000000b'),
  ('20000000-0000-0000-0000-0000000000ba', 'Batch room', '10000000-0000-0000-0000-0000000000ba'),
  ('20000000-0000-0000-0000-0000000000c1', 'Intake classroom', '10000000-0000-0000-0000-0000000000c1');
insert into course_intakes values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000c1');
insert into intake_batches values ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000ba', null);
-- Student S (automatic locations) and student M (a manual location on U1); both in batch B1.
insert into intake_enrolments values ('50000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000005', null),
  ('50000000-0000-0000-0000-00000000000f', '30000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-00000000000f', null);
insert into batch_students values ('50000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000001', null, null),
  ('50000000-0000-0000-0000-00000000000f', '40000000-0000-0000-0000-000000000001', null, null);
insert into lms_unit_students
  select '30000000-0000-0000-0000-000000000001', u, '60000000-0000-0000-0000-000000000005', null, true from unnest(array['U1', 'U2', 'U3', 'U4']) u;
insert into lms_unit_students values ('30000000-0000-0000-0000-000000000001', 'U1', '60000000-0000-0000-0000-00000000000f', '10000000-0000-0000-0000-0000000000ff', false);

create function pg_temp.loc(p_unit text, p_student text default '60000000-0000-0000-0000-000000000005') returns text language sql stable as $$
  select l.name from avetmiss_loc_t.lms_unit_students u left join avetmiss_loc_t.locations l on l.id = u.location_id
   where u.intake_id = '30000000-0000-0000-0000-000000000001' and u.unit_id = p_unit and u.student_id = p_student::uuid $$;
create function pg_temp.resolve(p_unit text) returns text language sql stable as $$
  select l.name from avetmiss_loc_t.locations l
   where l.id = avetmiss_loc_t.avetmiss_batch_location('30000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000005', p_unit) $$;

-- ---------------------------------------------------------------- U1: theory 60 h in room A, practical 40 h in room B (one statement)
insert into class_sessions (intake_id, unit_id, batch_id, room_id, session_type, start_time, end_time)
  select '30000000-0000-0000-0000-000000000001'::uuid, 'U1', '40000000-0000-0000-0000-000000000001'::uuid, '20000000-0000-0000-0000-00000000000a'::uuid, 'theory', '08:00'::time, '14:00'::time from generate_series(1, 10)
  union all
  select '30000000-0000-0000-0000-000000000001'::uuid, 'U1', '40000000-0000-0000-0000-000000000001'::uuid, '20000000-0000-0000-0000-00000000000b'::uuid, 'practical', '09:00'::time, '14:00'::time from generate_series(1, 8);
select is(pg_temp.loc('U1'), 'Campus A', 'theory 60 h in room A beats practical 40 h in room B (insert trigger)');
select is(pg_temp.loc('U1', '60000000-0000-0000-0000-00000000000f'), 'Manual campus', 'a manual location is not overwritten on insert');

-- ---------------------------------------------------------------- U2: equal hours, theory in room B, practical in room A
insert into class_sessions (intake_id, unit_id, batch_id, room_id, session_type, start_time, end_time) values
  ('30000000-0000-0000-0000-000000000001', 'U2', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', 'practical', '09:00', '19:00'),
  ('30000000-0000-0000-0000-000000000001', 'U2', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000b', 'theory', '09:00', '19:00');
select is(pg_temp.loc('U2'), 'Campus B', 'equal hours: the theory room''s location wins');

-- ---------------------------------------------------------------- U3: no sessions -> batch room, then intake classroom
select is(pg_temp.resolve('U3'), 'Batch campus', 'no sessions: the batch''s room');
update intake_batches set room_id = null where id = '40000000-0000-0000-0000-000000000001';
select is(pg_temp.resolve('U3'), 'Intake campus', 'no sessions and no batch room: the intake''s classroom');
update intake_batches set room_id = '20000000-0000-0000-0000-0000000000ba' where id = '40000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------- U4: cancelled and online sessions are ignored
insert into class_sessions (intake_id, unit_id, batch_id, room_id, session_type, status, delivery, start_time, end_time) values
  ('30000000-0000-0000-0000-000000000001', 'U4', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', 'theory', 'scheduled', 'face_to_face', '09:00', '12:00'),
  ('30000000-0000-0000-0000-000000000001', 'U4', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000b', 'theory', 'cancelled', 'face_to_face', '08:00', '20:00'),
  ('30000000-0000-0000-0000-000000000001', 'U4', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000b', 'theory', 'scheduled', 'online', '08:00', '20:00');
select is(pg_temp.loc('U4'), 'Campus A', 'cancelled and online sessions do not count');
update class_sessions set status = 'cancelled' where unit_id = 'U4' and room_id = '20000000-0000-0000-0000-00000000000a';
select is(pg_temp.loc('U4'), 'Batch campus', 'with every face-to-face session cancelled the batch room is used (update trigger)');

-- ---------------------------------------------------------------- moving sessions: automatic follows, manual stays
update class_sessions set room_id = '20000000-0000-0000-0000-00000000000b' where unit_id = 'U1' and room_id = '20000000-0000-0000-0000-00000000000a';
select is(pg_temp.loc('U1'), 'Campus B', 'moving the theory sessions to room B moves the automatic location (update trigger)');
select is(pg_temp.loc('U1', '60000000-0000-0000-0000-00000000000f'), 'Manual campus', 'a manual location is not overwritten on update');
select ok((select location_is_auto from lms_unit_students where unit_id = 'U1' and student_id = '60000000-0000-0000-0000-00000000000f') = false, 'and stays manual');
delete from class_sessions where unit_id = 'U1';
select is(pg_temp.loc('U1'), 'Batch campus', 'deleting the unit''s sessions falls back to the batch room (delete trigger)');
select is(pg_temp.loc('U1', '60000000-0000-0000-0000-00000000000f'), 'Manual campus', 'a manual location is not overwritten on delete');

-- ---------------------------------------------------------------- the migration file holds the installed code
select ok(pg_get_functiondef('public.avetmiss_batch_location(uuid, uuid, text)'::regprocedure) like '%order by sum(secs) desc, bool_or(session_type = ''theory'') desc, location_id%', 'most hours, then theory, then location_id');
select ok(pg_get_functiondef('public.class_sessions_avetmiss_location_upd()'::regprocedure) like '%(u.location_id is null or u.location_is_auto)%', 'triggers touch automatic or empty locations only');

select * from finish();
rollback;
