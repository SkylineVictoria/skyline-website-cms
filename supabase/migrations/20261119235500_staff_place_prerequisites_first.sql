-- STAFF-PLACE-PREREQS-FIRST (owner rule: a late joiner does the missed prerequisite units first): Override: place a student
-- (rto_staff_place) on a master-timetable course now goes through rto_batch_assign into the chosen intake, so a late joiner
-- gets the prerequisite catch-up and starts at the next unit, the same as automatic placement. Before, the override inserted
-- the enrolment directly and a late joiner got no units (gap found while verifying INTAKE-REPLACES-BATCH stage 4).
-- Other courses keep the direct insert.
create or replace function public.rto_staff_place(p_batch uuid, p_student uuid, p_type text, p_on date, p_reason text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare i public.course_intakes; v_on date := coalesce(p_on, public.course_intake_today()); v_enrol uuid; v_master boolean;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can place a student by hand.' using errcode = '42501'; end if;
 if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are placing this student by hand.' using errcode = '22023'; end if;
 select * into i from public.course_intakes where id = p_batch;
 if i.id is null or not public.intake_has_group(i.id) then raise exception 'Choose an active intake.' using errcode = '22023'; end if;
 if v_on < i.start_date then raise exception 'The student cannot join before the intake starts (%).', i.start_date using errcode = '22023'; end if;
 if i.end_date is not null and v_on > i.end_date then raise exception 'The student cannot join after the intake ends (%).', i.end_date using errcode = '22023'; end if;
 if not public.rto_student_on_course(p_student, i.course_id) then perform public.rto_direct_application(p_student, i.id); end if;
 v_master := exists (select 1 from public.course_master_timetables t where t.course_id = i.course_id);
 perform set_config('rto.auto_place', 'on', true);
 if v_master then
  v_enrol := public.rto_batch_assign(p_student, i.course_id, i.id, coalesce(nullif(p_type, ''), 'CoE'), v_on);
 else
  insert into public.intake_enrolments(intake_id, student_id, enrolment_type, status, enrolled_on)
  values (i.id, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_on)
  on conflict (intake_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type, enrolled_on = excluded.enrolled_on
  returning id into v_enrol;
 end if;
 perform set_config('rto.auto_place', 'off', true);
 insert into public.rto_placement_overrides(student_id, course_id, intake_id, enrolment_id, action, reason, detail)
 values (p_student, i.course_id, i.id, v_enrol, 'place', btrim(p_reason), jsonb_build_object('on', v_on, 'type', p_type));
 select * into i from public.course_intakes where id = (select intake_id from public.intake_enrolments where id = v_enrol);
 return jsonb_build_object('enrolmentId', v_enrol, 'batchId', i.id, 'batch', public.intake_group_name(i.id), 'intakeId', i.id, 'joinedOn', v_on);
end $function$;
