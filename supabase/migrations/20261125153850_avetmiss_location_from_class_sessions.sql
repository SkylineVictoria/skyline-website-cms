-- AVETMISS-LOCATION-FROM-TIMETABLE (2026-11-25, owner): a unit enrolment's delivery location (AVETMISS 8.0 NAT00120,
-- Training organisation delivery location identifier) comes from where its classes are actually timetabled.
-- APPLIED on hosted before this file existed and recorded as 20261125153850; the SQL below was taken from the live database
-- (pg_get_functiondef / pg_get_triggerdef), not rewritten. Do not re-apply by hand.
--
-- public.avetmiss_batch_location(p_intake, p_student, p_unit), in order:
--   a) the student's batch class_sessions for that intake + unit (status 'scheduled', delivery 'face_to_face', room linked to a
--      location): the location with the most hours; a tie goes to theory before practical, then location_id;
--   b) else the batch's room; c) else the intake's classroom.
-- Statement-level triggers on class_sessions (transition tables) refresh lms_unit_students.location_id where location_is_auto
-- is true or location_id is null; a manual location (location_is_auto = false) is never overwritten.

CREATE OR REPLACE FUNCTION public.avetmiss_batch_location(p_intake uuid, p_student uuid, p_unit text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with my_batches as (
    select bs.batch_id, (bs.unit_id is not null) unit_specific
      from intake_enrolments e
      join batch_students bs on bs.enrolment_id = e.id and bs.archived_at is null
                            and (bs.unit_id = p_unit or bs.unit_id is null)
     where e.intake_id = p_intake and e.student_id = p_student and e.archived_at is null
  ),
  sessions as (
    select c.location_id, s.session_type, extract(epoch from (s.end_time - s.start_time)) secs
      from class_sessions s
      join classrooms c on c.id = s.room_id and c.location_id is not null
     where s.intake_id = p_intake and s.unit_id = p_unit
       and s.status = 'scheduled' and s.delivery = 'face_to_face'
       and (s.batch_id is null
            or s.batch_id in (select batch_id from my_batches)
            or not exists (select 1 from my_batches))
  )
  select coalesce(
    (select location_id from sessions
      group by location_id
      order by sum(secs) desc, bool_or(session_type = 'theory') desc, location_id
      limit 1),
    (select c.location_id
       from my_batches mb
       join intake_batches b on b.id = mb.batch_id and b.archived_at is null
       join classrooms c on c.id = b.room_id and c.location_id is not null
      order by mb.unit_specific desc
      limit 1),
    (select c.location_id
       from course_intakes ci
       join classrooms c on c.id = ci.classroom_id and c.location_id is not null
      where ci.id = p_intake)
  );
$function$;

CREATE OR REPLACE FUNCTION public.class_sessions_avetmiss_location_ins()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update lms_unit_students u
     set location_id = coalesce(avetmiss_batch_location(u.intake_id, u.student_id, u.unit_id), u.location_id), location_is_auto = true
    from (select distinct intake_id, unit_id from new_rows where intake_id is not null and unit_id is not null) c
   where u.intake_id = c.intake_id and u.unit_id = c.unit_id and (u.location_id is null or u.location_is_auto);
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.class_sessions_avetmiss_location_upd()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update lms_unit_students u
     set location_id = coalesce(avetmiss_batch_location(u.intake_id, u.student_id, u.unit_id), u.location_id), location_is_auto = true
    from (select intake_id, unit_id from new_rows union select intake_id, unit_id from old_rows) c
   where c.intake_id is not null and c.unit_id is not null
     and u.intake_id = c.intake_id and u.unit_id = c.unit_id and (u.location_id is null or u.location_is_auto);
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.class_sessions_avetmiss_location_del()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update lms_unit_students u
     set location_id = coalesce(avetmiss_batch_location(u.intake_id, u.student_id, u.unit_id), u.location_id), location_is_auto = true
    from (select distinct intake_id, unit_id from old_rows where intake_id is not null and unit_id is not null) c
   where u.intake_id = c.intake_id and u.unit_id = c.unit_id and (u.location_id is null or u.location_is_auto);
  return null;
end $function$;

drop trigger if exists class_sessions_avetmiss_location_ins on public.class_sessions;
drop trigger if exists class_sessions_avetmiss_location_upd on public.class_sessions;
drop trigger if exists class_sessions_avetmiss_location_del on public.class_sessions;
CREATE TRIGGER class_sessions_avetmiss_location_ins AFTER INSERT ON public.class_sessions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION class_sessions_avetmiss_location_ins();
CREATE TRIGGER class_sessions_avetmiss_location_upd AFTER UPDATE ON public.class_sessions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION class_sessions_avetmiss_location_upd();
CREATE TRIGGER class_sessions_avetmiss_location_del AFTER DELETE ON public.class_sessions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION class_sessions_avetmiss_location_del();

-- Backfill: every automatic (or empty) unit enrolment location from the rule above; manual locations untouched.
update public.lms_unit_students u
   set location_id = coalesce(public.avetmiss_batch_location(u.intake_id, u.student_id, u.unit_id), u.location_id),
       location_is_auto = true
 where u.location_id is null or u.location_is_auto;
