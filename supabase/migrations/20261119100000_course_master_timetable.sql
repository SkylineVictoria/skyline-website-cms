-- MASTER-TIMETABLE (owner, 2026-11-18), stage 1 of 3: one master timetable per course.
-- LMS > Courses > a course > Master timetable: staff enter one start date and the system gives every active unit its start and
-- end date, one unit after another in whole 7-day weeks (weekends count; a unit of 2 weeks is 14 days), in the order staff set.
-- Days inside a term break (academic_breaks of the course or of every course) are not counted: a unit that would start in a
-- break starts the day after it, and a break inside a unit pushes its end later. A unit never comes before a unit it needs
-- (rto_unit_requires): the first layout puts prerequisite units first, and a saved order that breaks this is refused.
-- Staff can change a unit's weeks and move units up and down; the unit itself (cms_course_units) is not changed.
-- This stage only stores and shows the master. Intakes, batches, placement and classes still work as before; stage 2 makes the
-- intakes of a course follow these dates.
-- Additive: two tables, three functions. Rollback (manual): drop function public.rto_master_timetable(text, jsonb),
-- public.course_master_layout(text, date, jsonb), public.course_master_default_order(text); drop table
-- public.course_master_units, public.course_master_timetables.

begin;

create table if not exists public.course_master_timetables (
 course_id text primary key references public.cms_courses(id) on delete cascade,
 start_date date not null,
 updated_at timestamptz not null default now(),
 updated_by uuid
);
-- `cycle`: the master repeats when its last unit ends; stage 3 adds the following cycles. Stage 1 writes cycle 1 only.
create table if not exists public.course_master_units (
 id uuid primary key default gen_random_uuid(),
 course_id text not null references public.course_master_timetables(course_id) on delete cascade,
 cycle integer not null default 1 check (cycle >= 1),
 unit_id text not null references public.cms_course_units(id) on delete cascade,
 weeks numeric(5,1) not null check (weeks > 0 and weeks <= 104),
 sort integer not null,
 start_date date not null,
 end_date date not null,
 unique (course_id, cycle, unit_id),
 check (end_date >= start_date)
);
create index if not exists course_master_units_order_idx on public.course_master_units(course_id, cycle, sort);
alter table public.course_master_timetables enable row level security;
alter table public.course_master_units enable row level security;
revoke all on public.course_master_timetables, public.course_master_units from anon;
revoke insert, update, delete on public.course_master_timetables, public.course_master_units from authenticated;
drop policy if exists course_master_timetables_staff_read on public.course_master_timetables;
create policy course_master_timetables_staff_read on public.course_master_timetables for select to authenticated using (public.cms_is_staff());
drop policy if exists course_master_units_staff_read on public.course_master_units;
create policy course_master_units_staff_read on public.course_master_units for select to authenticated using (public.cms_is_staff());

-- The course's active units: the units other units need first (each after what it needs itself), then the rest in the course's own order.
create or replace function public.course_master_default_order(p_course text) returns table(unit_id text, weeks numeric, sort integer)
language sql stable security definer set search_path = public as $$
 select u.id, greatest(coalesce(u.duration_weeks, u.default_weeks, 1), 0.5)::numeric,
  (row_number() over (order by u.needed desc, case when u.needed then (select count(*) from public.rto_unit_requires_all(u.id)) else 0 end, u.sort, u.code))::integer
 from (select c.*, exists (select 1 from public.cms_course_units d where d.course_id = c.course_id and d.is_active and c.id in (select public.rto_unit_requires(d.id))) as needed
  from public.cms_course_units c where c.course_id = p_course and c.is_active) u;
$$;

-- Dates for the units in the order given ([{unitId, weeks}]) from a start date: whole 7-day weeks back to back, term-break
-- days not counted.
create or replace function public.course_master_layout(p_course text, p_start date, p_rows jsonb)
returns table(unit_id text, weeks numeric, sort integer, start_date date, end_date date)
language plpgsql stable security definer set search_path = public as $$
declare r record; d date := p_start; v_days integer; v_left integer; v_from date; v_guard integer;
begin
 for r in select x.value->>'unitId' as unit_id, (x.value->>'weeks')::numeric as weeks, x.ordinality::integer as sort
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality x order by x.ordinality loop
  v_days := greatest(1, round(r.weeks * 7)::integer); v_left := v_days; v_from := null; v_guard := 0;
  while v_left > 0 loop
   v_guard := v_guard + 1;
   if v_guard > 3000 then raise exception 'The term breaks leave no teaching days for this timetable.' using errcode = '22023'; end if;
   if not exists (select 1 from public.academic_breaks b where d between b.start_date and b.end_date and (b.course_id is null or b.course_id = p_course)) then
    if v_from is null then v_from := d; end if;
    v_left := v_left - 1;
    if v_left = 0 then exit; end if;
   end if;
   d := d + 1;
  end loop;
  unit_id := r.unit_id; weeks := r.weeks; sort := r.sort; start_date := v_from; end_date := d;
  return next;
  d := d + 1;
 end loop;
end $$;

-- get {courseId}; preview / save {courseId, startDate, rows: [{unitId, weeks}]} (rows in teaching order).
-- Reading and preview: CMS staff. Save: RTO Manager.
create or replace function public.rto_master_timetable(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := nullif(d->>'courseId', ''); v_start date; v_rows jsonb; v_saved boolean := false;
 v_problems jsonb; v_out jsonb; v_end date;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
 if p_action not in ('get', 'preview', 'save') then raise exception 'Unknown action' using errcode = '22023'; end if;
 if v_course is null or not exists (select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;

 if p_action = 'get' then
  select t.start_date into v_start from public.course_master_timetables t where t.course_id = v_course;
  v_saved := found;
  if v_saved then
   -- The saved order, then active units added to the course since (at the end, until staff save again).
   select coalesce(jsonb_agg(jsonb_build_object('unitId', x.unit_id, 'weeks', x.weeks) order by x.ord), '[]'::jsonb) into v_rows from (
    select m.unit_id, m.weeks, m.sort as ord from public.course_master_units m join public.cms_course_units u on u.id = m.unit_id and u.is_active
    where m.course_id = v_course and m.cycle = 1
    union all
    select o.unit_id, o.weeks, 100000 + o.sort from public.course_master_default_order(v_course) o
    where not exists (select 1 from public.course_master_units m where m.course_id = v_course and m.cycle = 1 and m.unit_id = o.unit_id)) x;
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
  delete from public.course_master_units where course_id = v_course and cycle = 1;
  insert into public.course_master_units(course_id, cycle, unit_id, weeks, sort, start_date, end_date)
  select v_course, 1, l.unit_id, l.weeks, l.sort, l.start_date, l.end_date from public.course_master_layout(v_course, v_start, v_rows) l;
  v_saved := true;
 end if;

 select coalesce(jsonb_agg(jsonb_build_object('unitId', u.id, 'code', u.code, 'name', u.name, 'unitType', u.unit_type,
   'hours', coalesce(u.slit_hours, u.nominal_hours), 'weeks', l.weeks, 'startDate', l.start_date, 'endDate', l.end_date,
   'prerequisites', coalesce((select jsonb_agg(q.code order by q.code) from public.rto_unit_requires(u.id) req(id) join public.cms_course_units q on q.id = req.id), '[]'::jsonb),
   'inMaster', exists (select 1 from public.course_master_units m where m.course_id = v_course and m.cycle = 1 and m.unit_id = u.id)) order by l.sort), '[]'::jsonb),
  max(l.end_date)
 into v_out, v_end
 from (
  select x.unit_id, x.weeks, x.sort, x.start_date, x.end_date from public.course_master_layout(v_course, v_start, v_rows) x where v_start is not null
  union all
  select r.value->>'unitId', (r.value->>'weeks')::numeric, r.ordinality::integer, null::date, null::date
  from jsonb_array_elements(v_rows) with ordinality r where v_start is null) l
 join public.cms_course_units u on u.id = l.unit_id;

 return jsonb_build_object('courseId', v_course, 'saved', v_saved, 'startDate', v_start, 'endDate', v_end, 'rows', v_out, 'problems', v_problems,
  'canEdit', coalesce(public.cms_is_rto_manager(), false),
  'breaks', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'startDate', b.start_date, 'endDate', b.end_date, 'courseId', b.course_id) order by b.start_date)
    from public.academic_breaks b where (b.course_id is null or b.course_id = v_course) and (v_start is null or b.end_date >= v_start)), '[]'::jsonb));
end $$;

revoke all on function public.course_master_default_order(text), public.course_master_layout(text, date, jsonb), public.rto_master_timetable(text, jsonb) from public, anon;
revoke all on function public.course_master_default_order(text), public.course_master_layout(text, date, jsonb) from authenticated;
grant execute on function public.rto_master_timetable(text, jsonb) to authenticated;

commit;
