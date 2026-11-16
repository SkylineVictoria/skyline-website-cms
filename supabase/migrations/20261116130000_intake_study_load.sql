-- INTAKE-STUDY-LOAD: an intake is CoE (20 class hours a week) or VoE (40 class hours a week).
-- The unit timeline is laid out at that rate (a VoE unit takes half the weeks), and class timing must give at least
-- that many hours a week. Additive: one column (default 'coe', so existing intakes keep their timelines), the timeline
-- function redefined with the rate, and two small functions to read and set the study load.

alter table public.course_intakes add column if not exists study_load text not null default 'coe';
do $$ begin
 if not exists(select 1 from pg_constraint where conname = 'course_intakes_study_load_check') then
  alter table public.course_intakes add constraint course_intakes_study_load_check check (study_load in ('coe', 'voe'));
 end if;
end $$;

-- As in 20261113400000, but a unit's working days are its weeks x 5 divided by 2 for a VoE intake (40 hours a week).
create or replace function public.intake_generate_schedule(p_intake uuid, p_start date, p_units text[], p_end date) returns date
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; u record; d date; days integer; n integer := 0; total integer := 0; per integer; extra integer; last_end date; k integer := 0; cnt integer;
 v_rate numeric;
begin
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 v_rate := case when i.study_load = 'voe' then 2 else 1 end;
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

-- Study load of each intake ({intakeId: 'coe' | 'voe'}), for any CMS staff; p_course null = every course.
create or replace function public.rto_intake_loads(p_course text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_object_agg(id, study_load) from public.course_intakes where p_course is null or course_id = p_course), '{}'::jsonb);
end $$;

-- Set an intake's study load (RTO Manager) and lay its unit timeline out again at the new rate, keeping its units.
create or replace function public.rto_intake_load_set(p_intake uuid, p_load text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; v_units text[];
begin
 if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can change an intake.' using errcode = '42501'; end if;
 if p_load not in ('coe', 'voe') then raise exception 'Choose CoE or VoE.' using errcode = '22023'; end if;
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 select array_agg(unit_id::text) into v_units from public.intake_units where intake_id = p_intake;
 update public.course_intakes set study_load = p_load, updated_at = now(), updated_by = auth.uid() where id = p_intake;
 perform public.intake_generate_schedule(p_intake, i.start_date, v_units, null);
 return jsonb_build_object('intakeId', p_intake, 'studyLoad', p_load,
  'endDate', (select end_date from public.course_intakes where id = p_intake));
end $$;

do $$ declare f text; begin
 foreach f in array array['rto_intake_loads(text)', 'rto_intake_load_set(uuid, text)'] loop
  execute format('revoke all on function public.%s from public, anon', f);
  execute format('grant execute on function public.%s to authenticated', f);
 end loop;
end $$;
