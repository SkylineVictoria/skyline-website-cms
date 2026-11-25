-- AVETMISS-OUTCOMES (2026-11-25, owner chose "Relax the trigger"): unit enrolments stay permanent, but their AVETMISS result
-- fields can now be recorded. lms_allocation_private.preserve_allocation (trigger lms_unit_students_permanent and
-- lms_intake_students_permanent) refused every UPDATE, including the Phase 1 outcome columns, so LMS > Results could not save.
-- Now, for lms_unit_students only, an UPDATE that leaves the allocation itself unchanged (intake, unit, student, course,
-- allocated at, planned start / end dates, carried-from intake) is allowed: outcome, actual dates, delivery mode, location,
-- funding source, evidence and recorded at / by may change. Deletes and every lms_intake_students change are refused as before
-- (test accounts @blackhole.postmarkapp.com may still be deleted).
begin;
create or replace function lms_allocation_private.preserve_allocation()
 returns trigger language plpgsql set search_path to ''
as $function$
begin
 if tg_op = 'DELETE' and exists (select 1 from public.enrollment_students s where s.id = old.student_id and lower(coalesce(s.email, '')) like '%@blackhole.postmarkapp.com') then
  return old;
 end if;
 -- Nested: lms_intake_students has no unit_id, and Postgres does not promise to stop evaluating an AND early.
 if tg_op = 'UPDATE' and tg_table_name = 'lms_unit_students' then
  if new.intake_id is not distinct from old.intake_id and new.unit_id is not distinct from old.unit_id
     and new.student_id is not distinct from old.student_id and new.course_id is not distinct from old.course_id
     and new.allocated_at is not distinct from old.allocated_at
     and new.assigned_start_date is not distinct from old.assigned_start_date and new.assigned_end_date is not distinct from old.assigned_end_date
     and new.carried_from_intake_id is not distinct from old.carried_from_intake_id then
   return new;
  end if;
 end if;
 raise exception 'Student allocations are permanent. Their original intake and dates must be retained.' using errcode='23514';
end $function$;
commit;
