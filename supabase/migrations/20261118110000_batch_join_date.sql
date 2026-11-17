-- JOIN-DATE (2026-11-18): place a student in a chosen batch on a chosen day ("Joins on"). The automatic path already takes a day through
-- rto_batch_place('assign', {on}); this is the same for a batch picked by hand. The seat guard still decides whether the batch has a free seat
-- for the days the student attends (from the join day to the end of their last unit). Additive.
create function public.rto_batch_join(p_batch uuid, p_student uuid, p_type text default 'CoE', p_on date default current_date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b public.batches; i public.course_intakes; v_enrol uuid; v_on date := coalesce(p_on, current_date);
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then
  raise exception 'Only an Admin or an RTO Manager can place students.' using errcode = '42501';
 end if;
 select * into b from public.batches where id = p_batch;
 if b.id is null or not b.is_active then raise exception 'Choose an active batch.' using errcode = '22023'; end if;
 select * into i from public.course_intakes where id = b.intake_id;
 if v_on < i.start_date then raise exception 'The student cannot join before the intake starts (%).', i.start_date using errcode = '22023'; end if;
 if i.end_date is not null and v_on > i.end_date then raise exception 'The student cannot join after the intake ends (%).', i.end_date using errcode = '22023'; end if;
 if not public.rto_student_on_course(p_student, i.course_id) then
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'The student has no application for this course.' using errcode = '22023'; end if;
  perform public.rto_direct_application(p_student, i.id);
 end if;
 insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on)
 values (p_batch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_on)
 on conflict (batch_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type, enrolled_on = excluded.enrolled_on
 returning id into v_enrol;
 return jsonb_build_object('enrolmentId', v_enrol, 'batchId', b.id, 'batch', b.name, 'intakeId', b.intake_id, 'joinedOn', v_on,
  'seats', public.rto_batch_seats(b.id), 'occupied', public.rto_batch_occupancy(b.id, v_on));
end $$;
revoke all on function public.rto_batch_join(uuid, uuid, text, date) from public, anon;
grant execute on function public.rto_batch_join(uuid, uuid, text, date) to authenticated;
