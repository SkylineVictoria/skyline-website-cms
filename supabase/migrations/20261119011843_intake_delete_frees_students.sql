-- INTAKE-DELETE-FREE (owner, 2026-11-19): an intake with students or applications can be deleted. Its students are taken out
-- (their batch places are removed, logged as a staff "remove" with the reason "Intake deleted") and wait for staff to choose a new
-- intake (Override > Place a student); the automatic placement does not put them back by itself. Applications that named the intake
-- keep the course with no intake. Deleting is still refused when the intake holds records that must be kept: issued certificates or
-- statements, assessments set for its batches, or final attendance registers. Draft attendance goes with it.
-- rto_admin('intake_delete') patched in place; returns {deleted, freed}. Rollback (manual): restore the two refusals from 20261113400000.
do $$
declare d text := pg_get_functiondef('public.rto_admin(text,jsonb)'::regprocedure);
 a text := $a$  if exists(select 1 from public.batch_enrolments e join public.batches bb on bb.id = e.batch_id where bb.intake_id = v_id) then
   raise exception 'Students are enrolled in this intake. Close it instead.' using errcode = '23503';
  end if;
  if exists(select 1 from public.enrollment_application_courses where intake_id = v_id) then
   raise exception 'Applications use this intake. Close it instead.' using errcode = '23503';
  end if;
  delete from public.course_intakes where id = v_id;
  return jsonb_build_object('deleted', found);$a$;
 b text := $b$  if exists(select 1 from public.course_completions cc join public.batches bb on bb.id = cc.batch_id where bb.intake_id = v_id) then
   raise exception 'Certificates were issued from this intake, so it cannot be deleted. Close it instead.' using errcode = '23503';
  end if;
  if exists(select 1 from public.asm_assignments aa join public.batches bb on bb.id = aa.batch_id where bb.intake_id = v_id) then
   raise exception 'Assessments are set for this intake''s batches. Cancel them in Assessments first, or close the intake instead.' using errcode = '23503';
  end if;
  if exists(select 1 from public.lms_attendance_register g join public.batches bb on bb.id = g.batch_id where bb.intake_id = v_id and g.state = 'final') then
   raise exception 'Attendance has been recorded for this intake, so it cannot be deleted. Close it instead.' using errcode = '23503';
  end if;
  perform set_config('rto.carry_over_planning', 'on', true);
  -- the students wait for staff to choose a new intake (not placed back automatically)
  insert into public.rto_placement_overrides(student_id, course_id, batch_id, enrolment_id, action, reason, detail)
  select distinct on (e.student_id) e.student_id, ci.course_id, null, null, 'remove', 'Intake deleted: choose a new intake for this student',
   jsonb_build_object('intake', ci.start_date, 'intakeName', ci.name)
  from public.batch_enrolments e join public.batches bb on bb.id = e.batch_id join public.course_intakes ci on ci.id = bb.intake_id
  where bb.intake_id = v_id and e.status in ('active', 'deferred');
  get diagnostics v_n = row_count;
  delete from public.lms_attendance_marks m using public.lms_attendance_register g, public.batches bb
   where m.register_id = g.id and g.batch_id = bb.id and bb.intake_id = v_id;
  update public.batch_enrolments set continues_enrolment_id = null
   where continues_enrolment_id in (select e.id from public.batch_enrolments e join public.batches bb on bb.id = e.batch_id where bb.intake_id = v_id);
  delete from public.batch_enrolments e using public.batches bb where bb.id = e.batch_id and bb.intake_id = v_id;
  update public.enrollment_application_courses set intake_id = null where intake_id = v_id;
  update public.lms_unit_students set carried_from_intake_id = null where carried_from_intake_id = v_id;
  perform set_config('rto.carry_over_planning', '', true);
  delete from public.course_intakes where id = v_id;
  return jsonb_build_object('deleted', found, 'freed', v_n);$b$;
begin
 if position('Intake deleted: choose a new intake' in d) > 0 then return; end if;
 if position(a in d) = 0 then raise exception 'rto_admin intake_delete anchor not found'; end if;
 if position('v_n' in d) = 0 then
  -- declare the counter used above
  d := regexp_replace(d, E'\ndeclare', E'\ndeclare v_n integer := 0;', '');
 end if;
 execute replace(d, a, b);
end $$;
