-- MASTER-TIMETABLE cycle plan (owner, 2026-11-20): staff choose how many cycles of the course are scheduled ahead (counted
-- from the current cycle: a one-year course with 3 cycles runs about 3 years), at most 10 years from the current cycle's start. All of them are built at once from the
-- current cycle's units, weeks and order, each starting the day after the previous one ends, term breaks left out.
--  * Weekly alert: from 12 months before the last scheduled cycle ends, RTO Managers see an in-app alert once a week
--    (course_master_alert_seen records who saw it which week).
--  * Lock: from 3 months before that day (or after it), the course takes no new intakes, no new enrolments and no class time
--    changes until more cycles are scheduled. The 15-minute jobs (rto.auto_place = 'on') are not stopped.
--  * academic_breaks.source: 'manual' (typed by staff), 'vic_school' (Victorian school terms, Important Dates open data) or
--    'predicted' (years past the published terms, forecast from the last published year; to be checked).
-- New: columns course_master_timetables.cycles_planned, academic_breaks.source; table course_master_alert_seen; functions
-- course_master_plan_end, course_master_locked, course_master_build_cycles, rto_master_cycles, course_master_lock_guard and
-- its triggers on course_intakes, intake_enrolments and intake_class_times.
-- Rollback: drop the three triggers and the six functions, the table, and the two columns (with their checks).

alter table public.course_master_timetables add column if not exists cycles_planned integer not null default 1;
do $$ begin
 alter table public.course_master_timetables add constraint course_master_timetables_cycles_planned_range check (cycles_planned between 1 and 60);
exception when duplicate_object then null; end $$;

alter table public.academic_breaks add column if not exists source text not null default 'manual';
do $$ begin
 alter table public.academic_breaks add constraint academic_breaks_source_check check (source in ('manual', 'vic_school', 'predicted'));
exception when duplicate_object then null; end $$;

create table if not exists public.course_master_alert_seen (
 user_id uuid not null,
 course_id text not null references public.cms_courses(id) on delete cascade,
 week date not null,
 seen_at timestamptz not null default now(),
 primary key (user_id, course_id, week)
);
alter table public.course_master_alert_seen enable row level security;
revoke all on public.course_master_alert_seen from anon;
revoke insert, update, delete on public.course_master_alert_seen from authenticated;
drop policy if exists course_master_alert_seen_own on public.course_master_alert_seen;
create policy course_master_alert_seen_own on public.course_master_alert_seen for select to authenticated using (user_id = auth.uid());

-- The last day of the last scheduled cycle (null before the master timetable is saved).
create or replace function public.course_master_plan_end(p_course text) returns date
language sql stable security definer set search_path = public as $$
 select max(m.end_date) from public.course_master_units m where m.course_id = p_course
$$;

-- Locked: the master is saved and its last scheduled cycle ends within 3 months (or has ended).
create or replace function public.course_master_locked(p_course text) returns boolean
language sql stable security definer set search_path = public as $$
 select exists (select 1 from public.course_master_timetables t where t.course_id = p_course)
  and coalesce(public.course_master_plan_end(p_course) <= (public.course_intake_today() + interval '3 months')::date, false)
$$;

-- Rebuilds the cycles after the current one, up to cycles_planned in all. The current cycle is never changed (intakes follow
-- it); later cycles have no intakes yet, so they are made again with the term breaks as they are now.
create or replace function public.course_master_build_cycles(p_course text) returns void
language plpgsql security definer set search_path = public as $$
declare v_cycle integer; v_n integer; v_rows jsonb; v_start date; v_next integer;
begin
 select t.cycles_planned into v_n from public.course_master_timetables t where t.course_id = p_course;
 if v_n is null then raise exception 'Save the master timetable first.' using errcode = '22023'; end if;
 v_cycle := public.course_master_current_cycle(p_course);
 delete from public.course_master_units where course_id = p_course and cycle > v_cycle;
 select coalesce(jsonb_agg(jsonb_build_object('unitId', m.unit_id, 'weeks', m.weeks) order by m.sort), '[]'::jsonb)
 into v_rows from public.course_master_units m join public.cms_course_units u on u.id = m.unit_id and u.is_active
 where m.course_id = p_course and m.cycle = v_cycle;
 if jsonb_array_length(v_rows) = 0 then return; end if;
 for v_next in v_cycle + 1 .. v_cycle + v_n - 1 loop
  select max(m.end_date) + 1 into v_start from public.course_master_units m where m.course_id = p_course and m.cycle = v_next - 1;
  insert into public.course_master_units(course_id, cycle, unit_id, weeks, sort, start_date, end_date)
  select p_course, v_next, l.unit_id, l.weeks, l.sort, l.start_date, l.end_date from public.course_master_layout(p_course, v_start, v_rows) l;
 end loop;
end;
$$;

create or replace function public.rto_master_cycles(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := nullif(d->>'courseId', ''); v_n integer; v_cycle integer;
 v_today date := public.course_intake_today(); v_week date := date_trunc('week', public.course_intake_today())::date;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
 if p_action not in ('get', 'set', 'rebuild', 'alerts', 'alerts_seen') then raise exception 'Unknown action' using errcode = '22023'; end if;

 -- Courses whose last scheduled cycle ends within 12 months; seenThisWeek: this user has had this week's alert.
 if p_action in ('alerts', 'alerts_seen') then
  if p_action = 'alerts_seen' and auth.uid() is not null then
   insert into public.course_master_alert_seen(user_id, course_id, week)
   select auth.uid(), t.course_id, v_week from public.course_master_timetables t
   where public.course_master_plan_end(t.course_id) <= (v_today + interval '12 months')::date
   on conflict do nothing;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('courseId', c.id, 'code', c.code, 'name', c.name, 'planEnd', x.plan_end,
     'daysLeft', x.plan_end - v_today, 'locked', public.course_master_locked(c.id), 'cyclesPlanned', t.cycles_planned,
     'seenThisWeek', exists (select 1 from public.course_master_alert_seen s where s.user_id = auth.uid() and s.course_id = c.id and s.week = v_week))
    order by x.plan_end)
   from public.course_master_timetables t join public.cms_courses c on c.id = t.course_id
   cross join lateral (select public.course_master_plan_end(t.course_id) as plan_end) x
   where x.plan_end is not null and x.plan_end <= (v_today + interval '12 months')::date), '[]'::jsonb);
 end if;

 if v_course is null or not exists (select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;

 if p_action in ('set', 'rebuild') then
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'RTO Manager permission required' using errcode = '42501'; end if;
  if not exists (select 1 from public.course_master_timetables where course_id = v_course) then raise exception 'Save the master timetable first.' using errcode = '22023'; end if;
  if p_action = 'set' then
   v_n := nullif(d->>'cycles', '')::integer;
   if v_n is null or v_n < 1 or v_n > 60 then raise exception 'Choose at least 1 cycle.' using errcode = '22023'; end if;
   update public.course_master_timetables set cycles_planned = v_n, updated_at = now(), updated_by = auth.uid() where course_id = v_course;
  end if;
  perform public.course_master_build_cycles(v_course);
  -- At most 10 years ahead: the whole call (and the new number) is undone when the last cycle would end later.
  if public.course_master_plan_end(v_course) >= ((select min(m.start_date) from public.course_master_units m
      where m.course_id = v_course and m.cycle = public.course_master_current_cycle(v_course)) + interval '10 years')::date then
   raise exception 'Too many cycles: the calendar can be planned at most 10 years ahead.' using errcode = '22023';
  end if;
 end if;

 v_cycle := public.course_master_current_cycle(v_course);
 return jsonb_build_object('courseId', v_course,
  'saved', exists (select 1 from public.course_master_timetables where course_id = v_course),
  'cyclesPlanned', coalesce((select cycles_planned from public.course_master_timetables where course_id = v_course), 1),
  'currentCycle', v_cycle, 'planEnd', public.course_master_plan_end(v_course), 'locked', public.course_master_locked(v_course),
  'canEdit', coalesce(public.cms_is_rto_manager(), false),
  'cycles', coalesce((select jsonb_agg(jsonb_build_object('cycle', x.cycle, 'startDate', x.s, 'endDate', x.e) order by x.cycle)
   from (select m.cycle, min(m.start_date) as s, max(m.end_date) as e from public.course_master_units m
         where m.course_id = v_course and m.cycle >= v_cycle group by m.cycle) x), '[]'::jsonb));
end;
$$;
revoke all on function public.rto_master_cycles(text, jsonb) from public, anon;
grant execute on function public.rto_master_cycles(text, jsonb) to authenticated;
revoke all on function public.course_master_build_cycles(text) from public, anon, authenticated;

-- No new intakes, enrolments or class time changes on a locked course, except by the 15-minute jobs. Deletes are not
-- guarded (a course delete cascades through these tables).
create or replace function public.course_master_lock_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_course text; v_end date;
begin
 if public.rto_auto_placing() then return new; end if;
 if tg_table_name = 'course_intakes' then v_course := new.course_id;
 else select ci.course_id into v_course from public.course_intakes ci where ci.id = new.intake_id;
 end if;
 if v_course is not null and public.course_master_locked(v_course) then
  v_end := public.course_master_plan_end(v_course);
  raise exception 'This course is locked: its last scheduled cycle ends on %. An RTO Manager must schedule more cycles on the course''s Weekly Calendar first.',
   to_char(v_end, 'DD Mon YYYY') using errcode = '55000';
 end if;
 return new;
end;
$$;

drop trigger if exists course_intakes_master_lock on public.course_intakes;
create trigger course_intakes_master_lock before insert on public.course_intakes
 for each row execute function public.course_master_lock_guard();
drop trigger if exists intake_enrolments_master_lock on public.intake_enrolments;
create trigger intake_enrolments_master_lock before insert on public.intake_enrolments
 for each row execute function public.course_master_lock_guard();
drop trigger if exists intake_class_times_master_lock on public.intake_class_times;
create trigger intake_class_times_master_lock before insert or update on public.intake_class_times
 for each row execute function public.course_master_lock_guard();
