-- LMS-TIDY (owner 2026-11-28: "recreate the screens under LMS, no clutter"): an intake's batch list (rto_batches 'list') also gives each
-- batch's own start and end dates (ROLLING-INTAKES), how many of its units have dates, and how many students have a unit in it (a student
-- whose later units run in another batch counts in that batch too), for the intake's Batches & timetable tab.
-- Fix (axcelerate_import_unit_results): a re-import moved an existing allocation back to the student's own batch (Himani's three later
-- units, which run in batch C2, were all in G1); an existing allocation now goes to the batch whose unit dates hold its own dates.
begin;

do $$
declare d text := pg_get_functiondef('public.rto_batches(text, jsonb)'::regprocedure); a text;
begin
  a := '''sort'', b.sort, ''archivedAt'', b.archived_at,';
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'rto_batches: list anchor not found once'; end if;
  d := replace(d, a, '''sort'', b.sort, ''archivedAt'', b.archived_at, ''startDate'', b.start_date, ''endDate'', b.end_date,
      ''unitDates'', (select count(*) from public.intake_batch_units xb where xb.batch_id = b.id),
      ''unitStudents'', (select count(distinct lu.student_id) from public.lms_unit_students lu where lu.batch_id = b.id),');
  execute d;
end $$;

do $$
declare d text := pg_get_functiondef('public.axcelerate_import_unit_results(uuid, uuid, uuid, uuid, jsonb)'::regprocedure); a text;
begin
  a := 'update public.lms_unit_students set batch_id = v_batch
         where intake_id = i.id and student_id = e.student_id and unit_id = v_unit and batch_id is distinct from v_batch';
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'axcelerate_import_unit_results: batch anchor not found once'; end if;
  d := replace(d, a, 'update public.lms_unit_students u2 set batch_id = coalesce((select xb.batch_id from public.intake_batch_units xb
             join public.intake_batches bb on bb.id = xb.batch_id
            where bb.intake_id = i.id and bb.archived_at is null and xb.unit_id = v_unit
              and u2.assigned_start_date between xb.start_date and xb.end_date order by xb.start_date desc limit 1), v_batch)
         where u2.intake_id = i.id and u2.student_id = e.student_id and u2.unit_id = v_unit
           and u2.batch_id is distinct from coalesce((select xb.batch_id from public.intake_batch_units xb
             join public.intake_batches bb on bb.id = xb.batch_id
            where bb.intake_id = i.id and bb.archived_at is null and xb.unit_id = v_unit
              and u2.assigned_start_date between xb.start_date and xb.end_date order by xb.start_date desc limit 1), v_batch)');
  d := replace(d, 'where m.enrolment_id = e.id and g.batch_id = lms_unit_students.batch_id);', 'where m.enrolment_id = e.id and g.batch_id = u2.batch_id);');
  execute d;
end $$;

commit;
