-- COURSE-BREAKS: a term break can belong to one course (course_id) or to every course (course_id null, as before).
-- The day checks read the course being scheduled from the transaction setting rto.course, which the unit timeline
-- (intake_generate_schedule) and the class generator (rto_class_sessions_generate) set; with no course set, every
-- break applies. Additive: one nullable column; four functions redefined.

alter table public.academic_breaks add column if not exists course_id text references public.cms_courses(id) on delete cascade;
create index if not exists academic_breaks_course_idx on public.academic_breaks(course_id, start_date);

-- The break applies to the course being scheduled: a break for every course, or one for that course.
create or replace function public.rto_break_on(p_day date) returns boolean
language sql stable security definer set search_path = public as $$
 select exists(select 1 from public.academic_breaks b where p_day between b.start_date and b.end_date
  and (b.course_id is null or nullif(current_setting('rto.course', true), '') is null or b.course_id = current_setting('rto.course', true)));
$$;

-- A working day (unit timeline): Monday to Friday, not a confirmed public holiday, not in a term break of the course.
create or replace function public.rto_is_working_day(p_day date) returns boolean
language sql stable security definer set search_path = public, hr as $$
 select extract(isodow from p_day) < 6
  and not exists(select 1 from hr.public_holidays h where h.holiday_date = p_day and h.status = 'confirmed' and not h.is_optional)
  and not public.rto_break_on(p_day);
$$;

-- A teaching day (dated classes, weekends included): not a confirmed public holiday, not in a term break of the course.
create or replace function public.rto_is_teaching_day(p_day date) returns boolean
language sql stable security definer set search_path = public, hr as $$
 select not exists(select 1 from hr.public_holidays h where h.holiday_date = p_day and h.status = 'confirmed' and not h.is_optional)
  and not public.rto_break_on(p_day);
$$;

-- As in 20261116130000, with the course set for the term-break check.
create or replace function public.intake_generate_schedule(p_intake uuid, p_start date, p_units text[], p_end date) returns date
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; u record; d date; days integer; n integer := 0; total integer := 0; per integer; extra integer; last_end date; k integer := 0; cnt integer;
 v_rate numeric;
begin
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 v_rate := case when i.study_load = 'voe' then 2 else 1 end;
 -- Term breaks of this course (and breaks for all courses) apply: rto_is_working_day reads rto.course.
 perform set_config('rto.course', i.course_id, true);
 select count(*) into cnt from public.cms_course_units where course_id = i.course_id and is_active and (p_units is null or unit_type = 'core' or id = any(p_units));
 if p_end is not null then
  if p_end < p_start then raise exception 'The end date is before the start date.' using errcode = '22023'; end if;
  d := public.rto_next_working_day(p_start);
  while d <= p_end loop total := total + 1; d := public.rto_next_working_day(d + 1); end loop;
  if cnt > 0 and total < cnt then raise exception 'There are % working days for % units; choose a later end date or fewer units.', total, cnt using errcode = '22023'; end if;
  per := case when cnt > 0 then total / cnt else 0 end; extra := case when cnt > 0 then total % cnt else 0 end;
 end if;
 delete from public.intake_units where intake_id = p_intake;
 d := public.rto_next_working_day(p_start); last_end := p_start;
 for u in select * from public.cms_course_units where course_id = i.course_id and is_active and (p_units is null or unit_type = 'core' or id = any(p_units)) order by sort, code loop
  n := n + 1;
  days := case when p_end is null then greatest(1, round(coalesce(u.duration_weeks, u.default_weeks) * 5 / v_rate)::integer) else per + case when n <= extra then 1 else 0 end end;
  last_end := d; k := days;
  while k > 1 loop last_end := public.rto_next_working_day(last_end + 1); k := k - 1; end loop;
  insert into public.intake_units(intake_id, unit_id, start_date, end_date, hours, sort) values (p_intake, u.id, d, last_end, u.nominal_hours, n);
  d := public.rto_next_working_day(last_end + 1);
 end loop;
 update public.course_intakes set start_date = p_start,
  end_date = case when p_end is not null then p_end when n > 0 then last_end else coalesce(end_date, p_start) end, updated_at = now()
 where id = p_intake;
 return coalesce(p_end, last_end);
end $$;

-- As in 20261116110000, with the course set for the term-break check.
create or replace function public.rto_class_sessions_generate(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare
 v_intake public.course_intakes; v_from date; v_day date; v_end date; v_fallback text;
 v_units text[] := '{}'; v_th numeric[] := '{}'; v_pr numeric[] := '{}'; v_as numeric[] := '{}';
 v_types text[]; v_left numeric; v_i int; v_pick int; v_len numeric; v_created int := 0; v_kept int; v_guard int := 0;
 u record; s record; k record;
begin
 if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can generate class sessions.' using errcode = '42501'; end if;
 select i.* into v_intake from public.batches b join public.course_intakes i on i.id = b.intake_id where b.id = p_batch;
 if not found then raise exception 'Batch not found.' using errcode = 'P0002'; end if;
 -- Term breaks of this course (and breaks for all courses) apply: rto_is_teaching_day reads rto.course.
 perform set_config('rto.course', v_intake.course_id, true);
 select array_agg(distinct session_type) into v_types from public.batch_sessions where batch_id = p_batch;
 if v_types is null then raise exception 'Set the batch''s weekly class times first.' using errcode = '22023'; end if;
 v_fallback := case when 'theory' = any(v_types) then 'theory' when 'practical' = any(v_types) then 'practical' else 'assessment' end;

 -- Units in teaching order: the intake's unit schedule, else the course's active units. Hours: the accepted SLIT split,
 -- else 40 / 40 / 20 of the nominal hours (the same suggestion the Units page makes).
 for u in
  with ordered as (
   select cu.id, cu.code, cu.slit_hours, cu.theory_hours, cu.practical_hours, cu.assessment_hours, cu.nominal_hours, iu.sort as o
    from public.intake_units iu join public.cms_course_units cu on cu.id = iu.unit_id where iu.intake_id = v_intake.id
   union all
   select cu.id, cu.code, cu.slit_hours, cu.theory_hours, cu.practical_hours, cu.assessment_hours, cu.nominal_hours, cu.sort
    from public.cms_course_units cu
    where cu.course_id = v_intake.course_id and cu.is_active
     and not exists(select 1 from public.intake_units iu where iu.intake_id = v_intake.id))
  select id, coalesce(slit_hours, nominal_hours, 0) as total,
   coalesce(theory_hours, round(coalesce(nominal_hours, 0) * 0.4)) as th,
   coalesce(practical_hours, round(coalesce(nominal_hours, 0) * 0.4)) as pr,
   coalesce(assessment_hours, coalesce(nominal_hours, 0) - 2 * round(coalesce(nominal_hours, 0) * 0.4)) as asm
  from ordered order by o, code
 loop
  continue when u.total <= 0;
  v_units := v_units || u.id::text; v_th := v_th || u.th::numeric; v_pr := v_pr || u.pr::numeric; v_as := v_as || u.asm::numeric;
 end loop;
 if cardinality(v_units) = 0 then raise exception 'This intake has no units with hours. Set unit hours first.' using errcode = '22023'; end if;
 for v_i in 1..cardinality(v_units) loop
  if not 'practical' = any(v_types) then
   if v_fallback = 'theory' then v_th[v_i] := v_th[v_i] + v_pr[v_i]; else v_as[v_i] := v_as[v_i] + v_pr[v_i]; end if;
   v_pr[v_i] := 0;
  end if;
  if not 'assessment' = any(v_types) then
   if v_fallback = 'theory' then v_th[v_i] := v_th[v_i] + v_as[v_i]; else v_pr[v_i] := v_pr[v_i] + v_as[v_i]; end if;
   v_as[v_i] := 0;
  end if;
  if not 'theory' = any(v_types) then
   if v_fallback = 'practical' then v_pr[v_i] := v_pr[v_i] + v_th[v_i]; else v_as[v_i] := v_as[v_i] + v_th[v_i]; end if;
   v_th[v_i] := 0;
  end if;
 end loop;

 v_from := case when exists(select 1 from public.class_sessions where batch_id = p_batch)
  then greatest(v_intake.start_date, current_date) else v_intake.start_date end;
 delete from public.class_sessions where batch_id = p_batch and not is_manual and session_date >= v_from;
 -- hours already taught or fixed by hand come off each unit
 for k in select unit_id, session_type, sum(extract(epoch from end_time - start_time) / 3600) as h
  from public.class_sessions where batch_id = p_batch and status = 'scheduled' and unit_id is not null group by 1, 2 loop
  v_i := array_position(v_units, k.unit_id);
  continue when v_i is null;
  if k.session_type = 'theory' then v_th[v_i] := v_th[v_i] - k.h;
  elsif k.session_type = 'practical' then v_pr[v_i] := v_pr[v_i] - k.h;
  else v_as[v_i] := v_as[v_i] - k.h; end if;
 end loop;
 select count(*) into v_kept from public.class_sessions where batch_id = p_batch;

 v_day := v_from;
 loop
  v_left := 0;
  for v_i in 1..cardinality(v_units) loop
   v_left := v_left + greatest(v_th[v_i], 0) + greatest(v_pr[v_i], 0) + greatest(v_as[v_i], 0);
  end loop;
  exit when v_left <= 0;
  v_guard := v_guard + 1;
  if v_guard > 1500 then raise exception 'These weekly class times cannot fit the unit hours within four years.' using errcode = '22023'; end if;
  if public.rto_is_teaching_day(v_day) then
   for s in select * from public.batch_sessions where batch_id = p_batch and weekday = extract(isodow from v_day)::int order by start_time loop
    continue when exists(select 1 from public.class_sessions c where c.batch_id = p_batch and c.session_date = v_day and c.start_time = s.start_time);
    v_pick := null;
    for v_i in 1..cardinality(v_units) loop
     if (s.session_type = 'theory' and v_th[v_i] > 0) or (s.session_type = 'practical' and v_pr[v_i] > 0)
      or (s.session_type = 'assessment' and v_as[v_i] > 0) then v_pick := v_i; exit; end if;
    end loop;
    continue when v_pick is null;
    v_len := extract(epoch from s.end_time - s.start_time) / 3600;
    if s.session_type = 'theory' then v_th[v_pick] := v_th[v_pick] - v_len;
    elsif s.session_type = 'practical' then v_pr[v_pick] := v_pr[v_pick] - v_len;
    else v_as[v_pick] := v_as[v_pick] - v_len; end if;
    insert into public.class_sessions(batch_id, session_date, start_time, end_time, session_type, room_id, unit_id)
     values (p_batch, v_day, s.start_time, s.end_time, s.session_type, s.room_id, v_units[v_pick]);
    v_created := v_created + 1;
   end loop;
  end if;
  v_day := v_day + 1;
 end loop;
 select max(session_date) into v_end from public.class_sessions where batch_id = p_batch;
 return jsonb_build_object('created', v_created, 'kept', v_kept, 'from', v_from, 'endDate', v_end,
  'clashes', public.rto_class_session_clashes(p_batch));
end $$;

revoke all on function public.rto_break_on(date) from public, anon;
grant execute on function public.rto_break_on(date) to authenticated;
