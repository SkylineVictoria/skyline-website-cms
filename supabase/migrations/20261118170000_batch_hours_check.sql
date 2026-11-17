-- BATCH-HOURS-CHECK (2026-11-18): does a batch's weekly timetable give enough class hours to finish the course by the intake's end? A batch with, say,
-- one 4-hour class a week against a 180- or 700-hour course silently got no class calendar (generation refuses). This reads, per batch: the course hours
-- the intake teaches, the hours a week the batch's classes give, the teaching weeks of the intake (term breaks excluded) and the hours a week needed.
-- Read only; staff only. Additive.
create function public.rto_batches_hours_check(p_batches uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb := '{}'::jsonb; b record; v_needed numeric; v_weekly numeric; v_start date; v_end date; v_break integer; v_weeks numeric; v_req numeric; v_fits boolean; v_msg text;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 for b in select ba.id, ba.intake_id, i.course_id, i.start_date, i.end_date from public.batches ba join public.course_intakes i on i.id = ba.intake_id where ba.id = any(p_batches) loop
  select coalesce(sum(coalesce(cu.slit_hours, cu.nominal_hours, 0)), 0) into v_needed from public.intake_units iu join public.cms_course_units cu on cu.id = iu.unit_id where iu.intake_id = b.intake_id;
  select coalesce(sum(extract(epoch from (s.end_time - s.start_time)) / 3600.0), 0) into v_weekly from public.batch_sessions s where s.batch_id = b.id;
  v_start := b.start_date;
  v_end := coalesce(b.end_date, (select max(end_date) from public.intake_units where intake_id = b.intake_id), b.start_date);
  select coalesce(sum(greatest(0, least(ab.end_date, v_end) - greatest(ab.start_date, v_start) + 1)), 0) into v_break
  from public.academic_breaks ab where (ab.course_id is null or ab.course_id = b.course_id) and ab.end_date >= v_start and ab.start_date <= v_end;
  v_weeks := greatest(1, (v_end - v_start + 1 - v_break) / 7.0);
  v_req := round(v_needed / v_weeks, 1);
  v_fits := v_needed = 0 or v_weekly >= v_req * 0.95;
  v_msg := case when v_needed = 0 then null
   when v_weekly = 0 then 'This batch has no weekly classes, so it has no class calendar. Set its class days and times.'
   when not v_fits then format('Weekly classes give %s h; this course needs about %s h a week (%s h over %s teaching weeks) to finish by %s. Add classes, or move the intake end date.',
     round(v_weekly, 1), v_req, round(v_needed), round(v_weeks), to_char(v_end, 'DD Mon YYYY')) end;
  r := r || jsonb_build_object(b.id::text, jsonb_build_object('needed', round(v_needed), 'weekly', round(v_weekly, 1), 'weeks', round(v_weeks), 'requiredPerWeek', v_req, 'fits', v_fits, 'message', v_msg));
 end loop;
 return r;
end $$;
revoke all on function public.rto_batches_hours_check(uuid[]) from public, anon;
grant execute on function public.rto_batches_hours_check(uuid[]) to authenticated;
