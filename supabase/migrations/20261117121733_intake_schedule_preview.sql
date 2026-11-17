-- INTAKE-PREVIEW: LMS > Intakes shows each unit's start and end date for a start date before it is saved, and a calendar.
-- intake_schedule_preview(intake, start, load) runs the same intake_generate_schedule the Save button runs (all active units, public
-- holidays and term breaks skipped, CoE / VoE pace) inside a sub-transaction that is always rolled back, and returns the units with
-- their dates, the end date and the weekdays in that span that are not teaching days (holidays / breaks). Nothing is stored.
-- Staff only. Additive.
-- Rollback (manual): drop function public.intake_schedule_preview(uuid, date, text).
begin;

create function public.intake_schedule_preview(p_intake uuid, p_start date, p_load text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_course text; v_units jsonb; v_end date; v_off jsonb; v_result jsonb;
begin
  if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
  if p_start is null then raise exception 'Choose a start date' using errcode = '22023'; end if;
  if p_load is not null and p_load not in ('coe', 'voe') then raise exception 'Unknown study load' using errcode = '22023'; end if;
  select course_id into v_course from public.course_intakes where id = p_intake;
  if v_course is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  begin
    if p_load is not null then
      execute 'update public.course_intakes set study_load = $1 where id = $2' using p_load, p_intake;
    end if;
    v_end := public.intake_generate_schedule(p_intake, p_start);
    select coalesce(jsonb_agg(jsonb_build_object('unitId', u.id, 'code', u.code, 'name', u.name, 'startDate', iu.start_date, 'endDate', iu.end_date,
      'hours', iu.hours) order by iu.sort, iu.start_date), '[]'::jsonb) into v_units
    from public.intake_units iu join public.cms_course_units u on u.id = iu.unit_id where iu.intake_id = p_intake;
    perform set_config('rto.course', v_course, true);
    select coalesce(jsonb_agg(d::date order by d), '[]'::jsonb) into v_off
    from generate_series(p_start, coalesce(v_end, p_start), interval '1 day') d
    where extract(isodow from d) < 6 and not public.rto_is_working_day(d::date);
    v_result := jsonb_build_object('startDate', p_start, 'endDate', v_end, 'units', v_units, 'offDays', v_off);
    raise exception using errcode = 'P0001', message = 'intake-preview-rollback';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'intake-preview-rollback' then raise; end if;
  end;
  return v_result;
end;
$$;

revoke all on function public.intake_schedule_preview(uuid, date, text) from public, anon;
grant execute on function public.intake_schedule_preview(uuid, date, text) to authenticated;

commit;
