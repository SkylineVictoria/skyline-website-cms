-- MASTER-TIMETABLE stage 3 (owner, 2026-11-18): the master repeats in cycles, and a late joiner does the prerequisites first.
--
-- 1. Cycles. When a master's last unit ends, the course starts again: the next cycle has the same units, weeks and order, from
--    the day after the current one ends, with term-break days left out. The system does NOT make it by itself: an RTO Manager
--    creates it on the Master timetable tab ("Create the next cycle") after entering the term breaks for that period.
--    rto_master_timetable('due') lists the courses whose current cycle ends within three months (or has ended) and have no next
--    cycle yet; the CMS dashboard shows them in a popup until it is done.
--    The current cycle of a course is the earliest one that has not ended (the last one when all have). Every open intake follows
--    it. When a cycle ends and the next exists, the intakes move onto it: the same job that used to make "next intakes" (every 15
--    minutes) now does this for master courses; it makes no intakes for them (stage 2). Classes are planned again for the new dates.
--    Editing the master (the tab) edits the current cycle; later cycles are removed and are created again from the tab.
-- 2. A unit the student is already Competent in is not taken again when the master comes round (master courses only).
-- 3. Prerequisites first (master courses). A student placed after a prerequisite unit has started, and not Competent in it, is
--    given those prerequisite units for themselves first: from the join day, one after another, each for its weeks on the master,
--    term breaks left out (student_prereq_catchup). They join the group's running calendar at the first unit that starts after
--    their last prerequisite ends. The units they missed meanwhile come round in the next cycle.
-- New: table student_prereq_catchup; functions course_master_current_cycle, course_master_roll, course_master_catchup_end,
-- course_master_catchup_set. Redefined (mine, stages 1-2): rto_master_timetable, course_master_apply_intake, course_master_apply,
-- course_master_lock_intake, course_master_lock_unit, course_master_weekly_need, course_master_group_problem.
-- Patched in place with marked lines (MASTER-STAGE3): rto_batch_assign, rto_enrolment_units, rto_intake_rolling_sweep.
-- Rollback (manual): remove the MASTER-STAGE3 lines from the three patched functions; restore the redefined functions from
-- 20261119100000 / 20261119110000 / 20261119120000; drop the four new functions and table public.student_prereq_catchup.

begin;

-- ------------------------------------------------------------------ cycles
create or replace function public.course_master_current_cycle(p_course text) returns integer
language sql stable security definer set search_path = public as $$
 with c as (select cycle, max(end_date) as last_day from public.course_master_units where course_id = p_course group by cycle)
 select coalesce((select min(cycle) from c where last_day >= public.course_intake_today()), (select max(cycle) from c), 1);
$$;

create or replace function public.course_master_weekly_need(p_course text) returns numeric
language sql stable security definer set search_path = public as $$
 select max(coalesce(u.slit_hours, u.nominal_hours) / m.weeks) from public.course_master_units m join public.cms_course_units u on u.id = m.unit_id
 where m.course_id = p_course and m.cycle = public.course_master_current_cycle(p_course) and coalesce(u.slit_hours, u.nominal_hours) > 0;
$$;

create or replace function public.course_master_group_problem(p_batch uuid) returns text
language sql stable security definer set search_path = public as $$
 with g as (
  select ci.course_id, coalesce((select sum(extract(epoch from (s.end_time - s.start_time))) / 3600.0 from public.batch_sessions s where s.batch_id = b.id), 0) as weekly
  from public.batches b join public.course_intakes ci on ci.id = b.intake_id where b.id = p_batch and coalesce(ci.status, 'open') <> 'closed'),
 worst as (
  select u.code, coalesce(u.slit_hours, u.nominal_hours) as hours, m.weeks, coalesce(u.slit_hours, u.nominal_hours) / m.weeks as need
  from g join public.course_master_units m on m.course_id = g.course_id and m.cycle = public.course_master_current_cycle(g.course_id)
  join public.cms_course_units u on u.id = m.unit_id
  where coalesce(u.slit_hours, u.nominal_hours) > 0 order by 4 desc, 1 limit 1)
 select 'These class times give ' || trim(to_char(g.weekly, 'FM990.0')) || ' hours a week. The master timetable needs '
  || trim(to_char(w.need, 'FM990.0')) || ' hours a week (' || w.code || ': ' || w.hours || ' hours in ' || trim(to_char(w.weeks, 'FM990.0')) || ' week'
  || case when w.weeks = 1 then '' else 's' end || '). Add class time, or change the master timetable.'
 from g, worst w where g.weekly > 0 and g.weekly < w.need - 0.01;
$$;

create or replace function public.course_master_apply_intake(p_intake uuid) returns date
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; v_first date; v_last date; v_cycle integer;
begin
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 v_cycle := public.course_master_current_cycle(i.course_id);
 select min(m.start_date), max(m.end_date) into v_first, v_last from public.course_master_units m where m.course_id = i.course_id and m.cycle = v_cycle;
 if v_first is null then return null; end if;
 delete from public.batch_unit_overrides o using public.batches b where b.id = o.batch_id and b.intake_id = p_intake;
 delete from public.intake_units iu where iu.intake_id = p_intake
  and not exists (select 1 from public.course_master_units m where m.course_id = i.course_id and m.cycle = v_cycle and m.unit_id = iu.unit_id);
 update public.intake_units iu set start_date = m.start_date, end_date = m.end_date, sort = m.sort
 from public.course_master_units m
 where m.course_id = i.course_id and m.cycle = v_cycle and m.unit_id = iu.unit_id and iu.intake_id = p_intake
  and (iu.start_date <> m.start_date or iu.end_date <> m.end_date or iu.sort <> m.sort);
 insert into public.intake_units(intake_id, unit_id, start_date, end_date, hours, sort)
 select p_intake, m.unit_id, m.start_date, m.end_date, u.nominal_hours, m.sort
 from public.course_master_units m join public.cms_course_units u on u.id = m.unit_id
 where m.course_id = i.course_id and m.cycle = v_cycle
  and not exists (select 1 from public.intake_units iu where iu.intake_id = p_intake and iu.unit_id = m.unit_id);
 update public.course_intakes set start_date = v_first, end_date = v_last, updated_at = now()
 where id = p_intake and (start_date <> v_first or end_date is distinct from v_last);
 return v_last;
end $$;

-- As in stage 2; classes are also planned again when the 15-minute job moves the intakes onto a new cycle (rto.auto_place).
create or replace function public.course_master_apply(p_course text) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; b record; v_n integer := 0;
begin
 if not exists (select 1 from public.course_master_timetables where course_id = p_course) then return 0; end if;
 for r in select id from public.course_intakes where course_id = p_course and coalesce(status, 'open') <> 'closed' order by start_date, id loop
  perform public.course_master_apply_intake(r.id);
  v_n := v_n + 1;
  if coalesce(public.cms_is_rto_manager(), false) or public.rto_auto_placing() then
   for b in select bb.id, bb.name from public.batches bb where bb.intake_id = r.id and bb.is_active
     and exists (select 1 from public.batch_sessions s where s.batch_id = bb.id) loop
    begin
     perform public.rto_class_sessions_generate(b.id);
    exception when others then
     raise warning 'course_master_apply: classes for batch % not planned again: %', b.name, sqlerrm;
    end;
   end loop;
  end if;
 end loop;
 return v_n;
end $$;

create or replace function public.course_master_lock_intake() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_first date; v_last date;
begin
 if coalesce(new.status, 'open') = 'closed' then return new; end if;
 select min(m.start_date), max(m.end_date) into v_first, v_last from public.course_master_units m
 where m.course_id = new.course_id and m.cycle = public.course_master_current_cycle(new.course_id);
 if v_first is not null then new.start_date := v_first; new.end_date := v_last; end if;
 return new;
end $$;

create or replace function public.course_master_lock_unit() returns trigger
language plpgsql security definer set search_path = public as $$
declare m record;
begin
 select x.start_date, x.end_date, x.sort into m from public.course_master_units x join public.course_intakes ci on ci.course_id = x.course_id
 where ci.id = new.intake_id and coalesce(ci.status, 'open') <> 'closed' and x.cycle = public.course_master_current_cycle(ci.course_id) and x.unit_id = new.unit_id;
 if found then new.start_date := m.start_date; new.end_date := m.end_date; new.sort := m.sort; end if;
 return new;
end $$;

-- A cycle ended and the next one exists: the course's intakes move onto it. Returns how many courses moved.
create or replace function public.course_master_roll() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_first date; v_n integer := 0; v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
 for r in select t.course_id, t.start_date from public.course_master_timetables t loop
  select min(m.start_date) into v_first from public.course_master_units m
  where m.course_id = r.course_id and m.cycle = public.course_master_current_cycle(r.course_id);
  continue when v_first is null;
  continue when v_first = r.start_date and not exists (
   select 1 from public.course_intakes ci where ci.course_id = r.course_id and coalesce(ci.status, 'open') <> 'closed' and ci.start_date <> v_first);
  begin
   update public.course_master_timetables set start_date = v_first, updated_at = now() where course_id = r.course_id and start_date <> v_first;
   perform set_config('rto.auto_place', 'on', true);
   perform public.course_master_apply(r.course_id);
   perform set_config('rto.auto_place', v_was, true);
   v_n := v_n + 1;
  exception when others then
   perform set_config('rto.auto_place', v_was, true);
   raise warning 'course_master_roll: % not moved to its next cycle: %', r.course_id, sqlerrm;
  end;
 end loop;
 return v_n;
end $$;

-- ------------------------------------------------------------------ the master timetable RPC, with cycles
-- get {courseId}; preview / save {courseId, startDate, rows: [{unitId, weeks}]}: the current cycle (as in stage 1; save also drops
--   later cycles and moves the course's intakes).
-- next_preview {courseId}: the next cycle's dates as they would be now (nothing saved). next_create {courseId}: saves it (RTO Manager).
-- due {}: courses whose current cycle ends within three months, or has ended, and have no next cycle.
create or replace function public.rto_master_timetable(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := nullif(d->>'courseId', ''); v_start date; v_rows jsonb; v_saved boolean := false;
 v_problems jsonb; v_out jsonb; v_end date; v_cycle integer; v_today date := public.course_intake_today(); v_next jsonb;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
 if p_action not in ('get', 'preview', 'save', 'next_preview', 'next_create', 'due') then raise exception 'Unknown action' using errcode = '22023'; end if;

 if p_action = 'due' then
  return coalesce((select jsonb_agg(jsonb_build_object('courseId', c.id, 'code', c.code, 'name', c.name, 'endDate', x.last_day, 'daysLeft', x.last_day - v_today) order by x.last_day)
   from public.course_master_timetables t join public.cms_courses c on c.id = t.course_id
   cross join lateral (select max(m.end_date) as last_day, max(m.cycle) as last_cycle from public.course_master_units m where m.course_id = t.course_id) x
   where x.last_day is not null and x.last_day <= (v_today + interval '3 months')::date
    and x.last_cycle = public.course_master_current_cycle(t.course_id)), '[]'::jsonb);
 end if;

 if v_course is null or not exists (select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;
 v_cycle := public.course_master_current_cycle(v_course);

 if p_action in ('next_preview', 'next_create') then
  select coalesce(jsonb_agg(jsonb_build_object('unitId', m.unit_id, 'weeks', m.weeks) order by m.sort), '[]'::jsonb), max(m.end_date) + 1
  into v_rows, v_start from public.course_master_units m join public.cms_course_units u on u.id = m.unit_id and u.is_active
  where m.course_id = v_course and m.cycle = v_cycle;
  if v_start is null then raise exception 'Save the master timetable first.' using errcode = '22023'; end if;
  if p_action = 'next_create' then
   if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'RTO Manager permission required' using errcode = '42501'; end if;
   if exists (select 1 from public.course_master_units where course_id = v_course and cycle > v_cycle) then
    raise exception 'The next cycle already exists.' using errcode = '23505';
   end if;
   insert into public.course_master_units(course_id, cycle, unit_id, weeks, sort, start_date, end_date)
   select v_course, v_cycle + 1, l.unit_id, l.weeks, l.sort, l.start_date, l.end_date from public.course_master_layout(v_course, v_start, v_rows) l;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('unitId', u.id, 'code', u.code, 'name', u.name, 'weeks', l.weeks, 'startDate', l.start_date, 'endDate', l.end_date) order by l.sort), '[]'::jsonb), max(l.end_date)
  into v_out, v_end from public.course_master_layout(v_course, v_start, v_rows) l join public.cms_course_units u on u.id = l.unit_id;
  return jsonb_build_object('courseId', v_course, 'cycle', v_cycle + 1, 'startDate', v_start, 'endDate', v_end, 'rows', v_out,
   'created', exists (select 1 from public.course_master_units where course_id = v_course and cycle = v_cycle + 1),
   'breaks', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'startDate', b.start_date, 'endDate', b.end_date, 'courseId', b.course_id) order by b.start_date)
     from public.academic_breaks b where (b.course_id is null or b.course_id = v_course) and b.end_date >= v_start and b.start_date <= v_end), '[]'::jsonb));
 end if;

 if p_action = 'get' then
  select t.start_date into v_start from public.course_master_timetables t where t.course_id = v_course;
  v_saved := found;
  if v_saved then
   select min(m.start_date) into v_start from public.course_master_units m where m.course_id = v_course and m.cycle = v_cycle;
   -- The saved order, then active units added to the course since (at the end, until staff save again).
   select coalesce(jsonb_agg(jsonb_build_object('unitId', x.unit_id, 'weeks', x.weeks) order by x.ord), '[]'::jsonb) into v_rows from (
    select m.unit_id, m.weeks, m.sort as ord from public.course_master_units m join public.cms_course_units u on u.id = m.unit_id and u.is_active
    where m.course_id = v_course and m.cycle = v_cycle
    union all
    select o.unit_id, o.weeks, 100000 + o.sort from public.course_master_default_order(v_course) o
    where not exists (select 1 from public.course_master_units m where m.course_id = v_course and m.cycle = v_cycle and m.unit_id = o.unit_id)) x;
  else
   select coalesce(jsonb_agg(jsonb_build_object('unitId', o.unit_id, 'weeks', o.weeks) order by o.sort), '[]'::jsonb) into v_rows
   from public.course_master_default_order(v_course) o;
  end if;
 else
  v_start := nullif(d->>'startDate', '')::date;
  v_rows := coalesce(d->'rows', '[]'::jsonb);
  if jsonb_typeof(v_rows) <> 'array' then raise exception 'Rows must be a list' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(v_rows) x where coalesce((x->>'weeks')::numeric, 0) <= 0 or (x->>'weeks')::numeric > 104) then
   raise exception 'Weeks must be between 0.5 and 104 for every unit.' using errcode = '22023';
  end if;
 end if;

 -- What stops this order from being saved.
 select coalesce(jsonb_agg(p.message order by p.ord), '[]'::jsonb) into v_problems from (
  select 1 as ord, 'A unit is listed twice: ' || u.code as message from (select x->>'unitId' as id from jsonb_array_elements(v_rows) x group by 1 having count(*) > 1) t
   join public.cms_course_units u on u.id = t.id
  union all
  select 2, 'Not an active unit of this course: ' || coalesce(u.code, x->>'unitId') from jsonb_array_elements(v_rows) x
   left join public.cms_course_units u on u.id = x->>'unitId' where u.id is null or u.course_id <> v_course or not u.is_active
  union all
  select 3, 'Missing from the timetable: ' || u.code from public.cms_course_units u where u.course_id = v_course and u.is_active
   and not exists (select 1 from jsonb_array_elements(v_rows) x where x->>'unitId' = u.id)
  union all
  select 4, u.code || ' needs ' || q.code || ' first: move ' || q.code || ' above it.'
  from jsonb_array_elements(v_rows) with ordinality a(x, n) join public.cms_course_units u on u.id = a.x->>'unitId'
  cross join lateral public.rto_unit_requires(u.id) req(id) join public.cms_course_units q on q.id = req.id
  where not exists (select 1 from jsonb_array_elements(v_rows) with ordinality b(x, n) where b.x->>'unitId' = q.id and b.n < a.n)) p;

 if p_action = 'save' then
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'RTO Manager permission required' using errcode = '42501'; end if;
  if v_start is null then raise exception 'Enter the start date.' using errcode = '22023'; end if;
  if jsonb_array_length(v_rows) = 0 then raise exception 'This course has no active units.' using errcode = '22023'; end if;
  if jsonb_array_length(v_problems) > 0 then raise exception '%', v_problems->>0 using errcode = '22023'; end if;
  insert into public.course_master_timetables(course_id, start_date, updated_at, updated_by) values (v_course, v_start, now(), auth.uid())
  on conflict (course_id) do update set start_date = excluded.start_date, updated_at = now(), updated_by = auth.uid();
  -- the cycle being edited and every later one: later cycles are created again from the tab
  delete from public.course_master_units where course_id = v_course and cycle >= v_cycle;
  insert into public.course_master_units(course_id, cycle, unit_id, weeks, sort, start_date, end_date)
  select v_course, v_cycle, l.unit_id, l.weeks, l.sort, l.start_date, l.end_date from public.course_master_layout(v_course, v_start, v_rows) l;
  perform public.course_master_apply(v_course);
  v_saved := true;
 end if;

 select coalesce(jsonb_agg(jsonb_build_object('unitId', u.id, 'code', u.code, 'name', u.name, 'unitType', u.unit_type,
   'hours', coalesce(u.slit_hours, u.nominal_hours), 'weeks', l.weeks, 'startDate', l.start_date, 'endDate', l.end_date,
   'prerequisites', coalesce((select jsonb_agg(q.code order by q.code) from public.rto_unit_requires(u.id) req(id) join public.cms_course_units q on q.id = req.id), '[]'::jsonb),
   'inMaster', exists (select 1 from public.course_master_units m where m.course_id = v_course and m.cycle = v_cycle and m.unit_id = u.id)) order by l.sort), '[]'::jsonb),
  max(l.end_date)
 into v_out, v_end
 from (
  select x.unit_id, x.weeks, x.sort, x.start_date, x.end_date from public.course_master_layout(v_course, v_start, v_rows) x where v_start is not null
  union all
  select r.value->>'unitId', (r.value->>'weeks')::numeric, r.ordinality::integer, null::date, null::date
  from jsonb_array_elements(v_rows) with ordinality r where v_start is null) l
 join public.cms_course_units u on u.id = l.unit_id;

 -- the cycle after this one, when it has been created
 select jsonb_build_object('cycle', v_cycle + 1, 'startDate', min(m.start_date), 'endDate', max(m.end_date)) into v_next
 from public.course_master_units m where m.course_id = v_course and m.cycle = v_cycle + 1 having count(*) > 0;

 return jsonb_build_object('courseId', v_course, 'saved', v_saved, 'startDate', v_start, 'endDate', v_end, 'rows', v_out, 'problems', v_problems,
  'canEdit', coalesce(public.cms_is_rto_manager(), false), 'cycle', v_cycle, 'next', v_next,
  'nextDue', v_saved and v_next is null and v_end is not null and v_end <= (v_today + interval '3 months')::date,
  'breaks', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'startDate', b.start_date, 'endDate', b.end_date, 'courseId', b.course_id) order by b.start_date)
    from public.academic_breaks b where (b.course_id is null or b.course_id = v_course) and (v_start is null or b.end_date >= v_start)), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------------ prerequisites first
create table if not exists public.student_prereq_catchup (
 enrolment_id uuid not null references public.batch_enrolments(id) on delete cascade,
 unit_id text not null references public.cms_course_units(id) on delete cascade,
 start_date date not null,
 end_date date not null,
 created_at timestamptz not null default now(),
 primary key (enrolment_id, unit_id),
 check (end_date >= start_date)
);
alter table public.student_prereq_catchup enable row level security;
revoke all on public.student_prereq_catchup from anon;
revoke insert, update, delete on public.student_prereq_catchup from authenticated;
drop policy if exists student_prereq_catchup_staff_read on public.student_prereq_catchup;
create policy student_prereq_catchup_staff_read on public.student_prereq_catchup for select to authenticated using (public.cms_is_staff());

-- The units in the master's order with its weeks, as [{unitId, weeks}] for course_master_layout.
create or replace function public.course_master_catchup_rows(p_course text, p_units text[]) returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('unitId', m.unit_id, 'weeks', m.weeks) order by m.sort), '[]'::jsonb)
 from public.course_master_units m where m.course_id = p_course and m.cycle = public.course_master_current_cycle(p_course) and m.unit_id = any(p_units);
$$;
-- The last day of a student's own run of these prerequisite units when it starts on p_from.
create or replace function public.course_master_catchup_end(p_course text, p_units text[], p_from date) returns date
language sql stable security definer set search_path = public as $$
 select max(l.end_date) from public.course_master_layout(p_course, p_from, public.course_master_catchup_rows(p_course, p_units)) l;
$$;
-- Store that run on the student's enrolment.
create or replace function public.course_master_catchup_set(p_enrolment uuid, p_units text[], p_from date) returns void
language plpgsql security definer set search_path = public as $$
declare v_course text;
begin
 select ci.course_id into v_course from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id where e.id = p_enrolment;
 if v_course is null or p_units is null or p_from is null then return; end if;
 delete from public.student_prereq_catchup where enrolment_id = p_enrolment;
 insert into public.student_prereq_catchup(enrolment_id, unit_id, start_date, end_date)
 select p_enrolment, l.unit_id, l.start_date, l.end_date from public.course_master_layout(v_course, p_from, public.course_master_catchup_rows(v_course, p_units)) l;
end $$;

-- ------------------------------------------------------------------ the patches
do $patch$
declare p record; d text; f text;
begin
 -- rto_batch_assign: the prerequisites a late joiner of a master course missed run for the student from the join day; the
 -- student then joins the running calendar at the first unit that starts after them. v_from keeps the join day, v_p the units.
 f := 'public.rto_batch_assign(uuid,text,uuid,text,date)';
 d := pg_get_functiondef(f::regprocedure);
 if position('MASTER-STAGE3' in d) = 0 then
  for p in select * from (values
   ($a$  -- a later intake that teaches them on or after the join day (made automatically if there is none yet)$a$,
    $b$  if v_p is not null and exists (select 1 from public.course_master_timetables t where t.course_id = v_src.course_id) then -- MASTER-STAGE3
   v_from := v_on;
   v_return := public.course_master_catchup_end(v_src.course_id, v_p, v_on);
   v_on := coalesce((select min(iu.start_date) from public.intake_units iu where iu.intake_id = v_intake and iu.start_date > v_return), v_return + 1);
  end if;$b$, true),
   ($a$ returning id into v_enrol;$a$,
    $b$ if v_return is not null and v_p is not null and exists (select 1 from public.course_master_timetables t where t.course_id = p_course) then -- MASTER-STAGE3
  perform public.course_master_catchup_set(v_enrol, v_p, v_from);
 end if;$b$, false)) as t(anchor, added, before) loop
   if position(p.anchor in d) = 0 then raise exception 'MASTER-STAGE3: anchor not found in %', f; end if;
   d := replace(d, p.anchor, case when p.before then p.added || E'\n' || p.anchor else p.anchor || E'\n' || p.added end);
  end loop;
  execute d;
 end if;

 -- rto_enrolment_units: a student's own prerequisite run counts as planned (so the units that need it are theirs once it ends),
 -- is listed with its own dates, and a unit already Competent before it starts is not taken again on a master course.
 f := 'public.rto_enrolment_units(uuid)';
 d := pg_get_functiondef(f::regprocedure);
 if position('MASTER-STAGE3' in d) = 0 then
  for p in select * from (values
   ($a$ planned as ($a$, $b$ planned0 as ( -- MASTER-STAGE3$b$),
   ($a$  group by eu.unit_id),$a$,
    $b$  group by eu.unit_id),
 own as (select cu.unit_id, cu.start_date, cu.end_date, cu.enrolment_id from e join public.batch_enrolments c on c.student_id = e.student_id and c.status in ('active', 'deferred', 'completed')
  join public.student_prereq_catchup cu on cu.enrolment_id = c.id),
 planned as (select z.unit_id, max(z.end_date) as end_date from (select unit_id, end_date from planned0 union all select unit_id, end_date from own) z group by z.unit_id),
 on_master as (select exists (select 1 from e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
   join public.course_master_timetables t on t.course_id = ci.course_id) as yes),$b$),
   ($a$  else u.end_date >= e.enrolled_on and not missed.m$a$,
    $b$  else u.end_date >= e.enrolled_on and not missed.m
   and not exists (select 1 from own o where o.enrolment_id = e.id and o.unit_id = u.unit_id)
   and not ((select yes from on_master) and exists (select 1 from public.rto_unit_outcome(e.student_id, u.unit_id) o where o.outcome = 'C' and o.signed_on < u.start_date))$b$),
   ($a$and not exists (select 1 from planned pl where pl.unit_id = q.req_unit and pl.end_date < u.start_date)) end;$a$,
    $b$and not exists (select 1 from planned pl where pl.unit_id = q.req_unit and pl.end_date < u.start_date)) end
 union all
 select u.intake_unit_id, o.unit_id, o.start_date, o.end_date, u.sort from e join own o on o.enrolment_id = e.id join bu u on u.unit_id = o.unit_id where not e.carry_over;$b$)) as t(anchor, added) loop
   if position(p.anchor in d) = 0 then raise exception 'MASTER-STAGE3: anchor not found in %', f; end if;
   d := replace(d, p.anchor, p.added);
  end loop;
  execute d;
 end if;

 -- the 15-minute job: master courses move onto their next cycle when the current one has ended
 f := 'public.rto_intake_rolling_sweep()';
 d := pg_get_functiondef(f::regprocedure);
 if position('MASTER-STAGE3' in d) = 0 then
  if position('  return n;' in d) = 0 then raise exception 'MASTER-STAGE3: anchor not found in %', f; end if;
  execute replace(d, '  return n;', E'  begin perform public.course_master_roll(); exception when others then raise warning ''course_master_roll: %'', sqlerrm; end; -- MASTER-STAGE3\n  return n;');
 end if;
end $patch$;

revoke all on function public.course_master_current_cycle(text), public.course_master_roll(), public.course_master_catchup_rows(text, text[]),
 public.course_master_catchup_end(text, text[], date), public.course_master_catchup_set(uuid, text[], date) from public, anon, authenticated;
revoke all on function public.course_master_weekly_need(text), public.course_master_group_problem(uuid), public.course_master_apply_intake(uuid),
 public.course_master_apply(text), public.course_master_lock_intake(), public.course_master_lock_unit() from public, anon, authenticated;
revoke all on function public.rto_master_timetable(text, jsonb) from public, anon;
grant execute on function public.rto_master_timetable(text, jsonb) to authenticated;

commit;
