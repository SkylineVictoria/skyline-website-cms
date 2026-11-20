-- VoE weekly calendar (owner, 2026-11-20): each course has two weekly calendars. The CoE one is the master timetable (one unit at a
-- time, 20 hours a week). The VoE one is saved here: a VoE student may study up to 40 hours a week, at most two units at the same
-- time. Allocation 'automatic' fills every week to 40 h (one unit 40 h, or two 20 h + 20 h); 'manual' gives each unit its own
-- hours a week. The CMS works the dates out (src/pages/admin/lib/masterDates.ts voeLayout) and this saves them after checking:
-- active units of the course only, each unit once, no day with more than two units, and (manual) no day over 40 hours.
-- It does not change which calendar intakes follow (they follow the master timetable as before).
-- New: tables course_voe_calendars, course_voe_units; function rto_voe_calendar. Rollback: drop the function and both tables.

create table if not exists public.course_voe_calendars (
 course_id text primary key references public.cms_courses(id) on delete cascade,
 method text not null check (method in ('automatic', 'manual')),
 start_date date not null,
 updated_at timestamptz not null default now(),
 updated_by uuid
);
create table if not exists public.course_voe_units (
 course_id text not null references public.course_voe_calendars(course_id) on delete cascade,
 unit_id text not null references public.cms_course_units(id) on delete cascade,
 sort integer not null,
 rates numeric(4,1)[] not null,
 start_date date not null,
 end_date date not null check (end_date >= start_date),
 primary key (course_id, unit_id)
);
alter table public.course_voe_calendars enable row level security;
alter table public.course_voe_units enable row level security;
revoke all on public.course_voe_calendars, public.course_voe_units from anon;
revoke insert, update, delete on public.course_voe_calendars, public.course_voe_units from authenticated;
drop policy if exists course_voe_calendars_staff_read on public.course_voe_calendars;
create policy course_voe_calendars_staff_read on public.course_voe_calendars for select to authenticated using (public.cms_is_staff());
drop policy if exists course_voe_units_staff_read on public.course_voe_units;
create policy course_voe_units_staff_read on public.course_voe_units for select to authenticated using (public.cms_is_staff());

create or replace function public.rto_voe_calendar(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := nullif(d->>'courseId', ''); v_method text := d->>'method';
 v_start date; v_bad text; v_rows jsonb := coalesce(d->'rows', '[]'::jsonb);
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
 if p_action not in ('get', 'save') then raise exception 'Unknown action' using errcode = '22023'; end if;
 if v_course is null or not exists (select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;

 if p_action = 'save' then
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'RTO Manager permission required' using errcode = '42501'; end if;
  if v_method is null or v_method not in ('automatic', 'manual') then raise exception 'Choose Automatic or Manual allocation.' using errcode = '22023'; end if;
  begin v_start := (d->>'startDate')::date; exception when others then v_start := null; end;
  if v_start is null then raise exception 'The VoE calendar needs a start date.' using errcode = '22023'; end if;
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 or jsonb_array_length(v_rows) > 200 then raise exception 'The VoE calendar has no units.' using errcode = '22023'; end if;

  create temp table if not exists voe_rows (unit_id text, sort integer, rates numeric[], start_date date, end_date date) on commit drop;
  truncate voe_rows;
  insert into voe_rows
  select x.value->>'unitId', x.ordinality::integer,
   coalesce((select array_agg(r::numeric) from jsonb_array_elements_text(coalesce(x.value->'rates', '[]'::jsonb)) r), '{}'),
   (x.value->>'startDate')::date, (x.value->>'endDate')::date
  from jsonb_array_elements(v_rows) with ordinality x;

  select coalesce(r.unit_id, '(no unit)') into v_bad from voe_rows r
  where r.unit_id is null or r.start_date is null or r.end_date is null or r.end_date < r.start_date or r.start_date < v_start
   or not exists (select 1 from public.cms_course_units u where u.id = r.unit_id and u.course_id = v_course and u.is_active)
   or cardinality(r.rates) = 0 or exists (select 1 from unnest(r.rates) q where q <= 0 or q > 40) limit 1;
  if v_bad is not null then raise exception 'A unit of the VoE calendar is not valid: %.', v_bad using errcode = '22023'; end if;
  if (select count(*) <> count(distinct unit_id) from voe_rows) then raise exception 'A unit is listed twice.' using errcode = '22023'; end if;

  -- No day with more than two units; manual: no day over 40 hours (automatic fills each day to exactly 40).
  select to_char(g, 'DD Mon YYYY') into v_bad
  from generate_series((select min(start_date) from voe_rows), (select max(end_date) from voe_rows), interval '1 day') g
  cross join lateral (select count(*) as n, coalesce(sum((select max(q) from unnest(r.rates) q)), 0) as hrs from voe_rows r where g::date between r.start_date and r.end_date) x
  where x.n > 2 or (v_method = 'manual' and x.hrs > 40) limit 1;
  if v_bad is not null then raise exception 'On % the VoE calendar has more than two units or more than 40 hours.', v_bad using errcode = '22023'; end if;

  insert into public.course_voe_calendars(course_id, method, start_date, updated_at, updated_by) values (v_course, v_method, v_start, now(), auth.uid())
  on conflict (course_id) do update set method = excluded.method, start_date = excluded.start_date, updated_at = now(), updated_by = auth.uid();
  delete from public.course_voe_units where course_id = v_course;
  insert into public.course_voe_units(course_id, unit_id, sort, rates, start_date, end_date)
  select v_course, unit_id, sort, rates, start_date, end_date from voe_rows;
 end if;

 return jsonb_build_object('courseId', v_course,
  'saved', exists (select 1 from public.course_voe_calendars where course_id = v_course),
  'method', (select method from public.course_voe_calendars where course_id = v_course),
  'startDate', (select start_date from public.course_voe_calendars where course_id = v_course),
  'updatedAt', (select updated_at from public.course_voe_calendars where course_id = v_course),
  'canEdit', coalesce(public.cms_is_rto_manager(), false),
  'rows', coalesce((select jsonb_agg(jsonb_build_object('unitId', v.unit_id, 'code', u.code, 'rates', to_jsonb(v.rates), 'startDate', v.start_date, 'endDate', v.end_date) order by v.sort)
   from public.course_voe_units v join public.cms_course_units u on u.id = v.unit_id where v.course_id = v_course), '[]'::jsonb));
end;
$$;
revoke all on function public.rto_voe_calendar(text, jsonb) from public, anon;
grant execute on function public.rto_voe_calendar(text, jsonb) to authenticated;
