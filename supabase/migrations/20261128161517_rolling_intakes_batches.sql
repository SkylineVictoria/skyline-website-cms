-- ROLLING-INTAKES (owner 2026-11-28): "SLIT's intakes never end."
--   1. A course has ONE ongoing intake per study load (CoE / VoE): no end date, Open (Closed only when an admin closes it),
--      found or made by (course, study load) (course_ongoing_intake). Its name is the course code and title; no capacity.
--   2. Every aXcelerate class is a batch inside that intake: code from the end of the class name ("-G1" -> G1; else the next free
--      code), name = class name, its own start date, end date and capacity, linked to the aXcelerate class (entity 'batch').
--   4. Unit dates belong to each batch (intake_batch_units, from its class); students follow their batch's unit dates
--      (allocations carry the batch and its dates). The intake's own units are the course calendar's current cycle (a template).
--   5. Applications and offers: the ongoing intake with a start date chosen from the upcoming batch starts and calendar cycle
--      starts (course_join_options); the offer's start is the chosen date and its end is calculated from it (course_offer_end).
--   6. A re-import turns the intake imported per class ("BSB80120 - JAN 2026 TO DEC 2026 -G1") into the ongoing intake with
--      batch G1 (same records, no duplicates, no end date).
-- Seats: an ongoing intake is not limited as a whole (capacity lives on its batches).
begin;

-- 1. Schema ------------------------------------------------------------------------------------------------------------------
alter table public.course_intakes add column if not exists ongoing boolean not null default false;
comment on column public.course_intakes.ongoing is 'ROLLING-INTAKES: the course''s one ongoing intake of this study load (no end date; batches carry the dates).';
create unique index if not exists course_intakes_one_ongoing on public.course_intakes (course_id, lower(study_load)) where ongoing and archived_at is null;

alter table public.intake_batches add column if not exists start_date date, add column if not exists end_date date;
alter table public.intake_batches add constraint intake_batches_dates_order check (start_date is null or end_date is null or end_date >= start_date);

create table public.intake_batch_units (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.intake_batches(id) on delete restrict,
  unit_id text not null references public.cms_course_units(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  sort integer not null default 1,
  trainer_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intake_batch_units_dates check (end_date >= start_date),
  constraint intake_batch_units_key unique (batch_id, unit_id)
);
comment on table public.intake_batch_units is 'ROLLING-INTAKES: each batch''s own unit dates (from its class); students of the batch follow them.';
alter table public.intake_batch_units enable row level security;
create policy intake_batch_units_staff_read on public.intake_batch_units for select using (public.cms_is_admin() or public.cms_is_rto_manager());
grant select on public.intake_batch_units to authenticated;

-- 2. The ongoing intake ------------------------------------------------------------------------------------------------------
create or replace function public.course_intake_ongoing_name(p_course text) returns text
language sql stable security definer set search_path = public as $$
  select left(btrim(concat_ws(' – ', nullif(btrim(c.code), ''), nullif(btrim(c.name), ''))), 160) from public.cms_courses c where c.id = p_course;
$$;

/** The course's ongoing intake of a study load (coe / voe), made when it has none (Open, no end date, no capacity). */
create or replace function public.course_ongoing_intake(p_course text, p_load text, p_start date default null, p_actor uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_load text := lower(coalesce(nullif(btrim(p_load), ''), 'coe')); v_name text := public.course_intake_ongoing_name(p_course);
  v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  if v_load not in ('coe', 'voe') then raise exception 'Choose CoE or VoE' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('course_ongoing_intake:' || p_course || ':' || v_load, 0));
  select id into v_id from public.course_intakes where course_id = p_course and lower(study_load) = v_load and ongoing and archived_at is null;
  if v_id is not null then return v_id; end if;
  perform set_config('rto.auto_place', 'on', true);
  insert into public.course_intakes(course_id, start_date, end_date, label, name, capacity, status, study_load, ongoing, updated_by)
  values (p_course, coalesce(p_start, public.course_intake_today()), null, left(coalesce(v_name, p_course), 80), v_name, null, 'open', v_load, true, p_actor)
  returning id into v_id;
  perform set_config('rto.auto_place', v_was, true);
  return v_id;
end $$;

-- The course calendar sets the dates of a dated intake; an ongoing intake keeps its start and has no end.
create or replace function public.course_master_lock_intake() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_first date; v_last date; v_kind text;
begin
  if new.ongoing then new.end_date := null; return new; end if;
  if coalesce(new.status, 'open') = 'closed' then return new; end if;
  v_kind := public.course_master_kind_for(new.course_id, new.study_load);
  select min(r.start_date), max(r.end_date) into v_first, v_last
    from public.course_master_rows(new.course_id, v_kind, public.course_master_cycle_for(new.course_id, v_kind)) r;
  if v_first is not null then new.start_date := v_first; new.end_date := v_last; end if;
  return new;
end $$;
drop trigger if exists course_master_lock_intake on public.course_intakes;
create trigger course_master_lock_intake before insert or update of start_date, end_date, status, course_id, ongoing on public.course_intakes
  for each row execute function public.course_master_lock_intake();

create or replace function public.course_master_apply_intake(p_intake uuid) returns date
language plpgsql security definer set search_path to 'public' as $$
declare i public.course_intakes; v_first date; v_last date; v_kind text; v_cycle integer;
begin
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  v_kind := public.course_master_kind_for(i.course_id, i.study_load);
  v_cycle := public.course_master_cycle_for(i.course_id, v_kind);
  select min(m.start_date), max(m.end_date) into v_first, v_last from public.course_master_rows(i.course_id, v_kind, v_cycle) m;
  if v_first is null then return null; end if;
  delete from public.intake_units iu where iu.intake_id = p_intake
    and not exists (select 1 from public.course_master_rows(i.course_id, v_kind, v_cycle) m where m.unit_id = iu.unit_id);
  update public.intake_units iu
     set start_date = m.start_date, end_date = m.end_date, sort = m.sort, master_kind = v_kind, master_cycle = m.cycle, master_unit_id = m.id
    from public.course_master_rows(i.course_id, v_kind, v_cycle) m
   where m.unit_id = iu.unit_id and iu.intake_id = p_intake
     and (iu.start_date <> m.start_date or iu.end_date <> m.end_date or iu.sort <> m.sort or iu.master_unit_id is distinct from m.id);
  insert into public.intake_units (intake_id, unit_id, start_date, end_date, hours, sort, master_kind, master_cycle, master_unit_id)
  select p_intake, m.unit_id, m.start_date, m.end_date, u.nominal_hours, m.sort, v_kind, m.cycle, m.id
    from public.course_master_rows(i.course_id, v_kind, v_cycle) m join public.cms_course_units u on u.id = m.unit_id
   where not exists (select 1 from public.intake_units iu where iu.intake_id = p_intake and iu.unit_id = m.unit_id);
  -- An ongoing intake keeps its own start and has no end (its batches carry the dates).
  if not i.ongoing then
    update public.course_intakes set start_date = v_first, end_date = v_last, updated_at = now()
     where id = p_intake and (start_date <> v_first or end_date is distinct from v_last);
  end if;
  return v_last;
end $$;

-- Seats: an ongoing intake is never full as a whole (capacity lives on its batches).
create or replace function public.rto_batch_seat_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_seats integer;
begin
 if new.status not in ('tentative', 'active', 'deferred', 'suspended') then return new; end if;
 if tg_op = 'UPDATE' and old.intake_id = new.intake_id and old.status in ('tentative', 'active', 'deferred', 'suspended') then return new; end if;
 if exists (select 1 from public.course_intakes ci where ci.id = new.intake_id and ci.ongoing) then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_seats:' || new.intake_id::text, 0));
 v_seats := public.rto_batch_seats(new.intake_id);
 if public.rto_batch_occupancy(new.intake_id, new.enrolled_on) >= v_seats then
  raise exception '% is full (% seats).', public.intake_group_name(new.intake_id), v_seats using errcode = '23514';
 end if;
 return new;
end $$;

/**
 * The course end for a start in an intake: a batch starting that day ends with the batch; otherwise one full cycle of the course
 * calendar from the start (the length of the calendar cycle running on, or next after, that day). Null when neither is known.
 */
create or replace function public.course_offer_end(p_intake uuid, p_start date) returns date
language plpgsql stable security definer set search_path = public as $$
declare i public.course_intakes; v_kind text; v_end date; v_first date; v_last date;
begin
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null or p_start is null then return null; end if;
  select max(b.end_date) into v_end from public.intake_batches b where b.intake_id = i.id and b.archived_at is null and b.start_date = p_start;
  if v_end is not null then return v_end; end if;
  v_kind := public.course_master_kind_for(i.course_id, i.study_load);
  with c as (
    select cycle, min(start_date) as f, max(end_date) as l from public.course_coe_units where v_kind = 'coe' and course_id = i.course_id group by cycle
    union all
    select cycle, min(start_date), max(end_date) from public.course_voe_units where v_kind = 'voe' and course_id = i.course_id
       and start_date is not null and end_date is not null group by cycle)
  select f, l into v_first, v_last from c where l >= p_start order by f limit 1;
  if v_first is null then return null; end if;
  return p_start + (v_last - v_first);
end $$;

-- A Qualification in an ongoing intake: from the day the student starts to one course length later.
create or replace function public.intake_enrolments_course_dates() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_start date; v_end date; v_ongoing boolean;
begin
  if new.intake_id is not null and (new.course_start_date is null or new.course_end_date is null
     or (tg_op = 'UPDATE' and old.intake_id is distinct from new.intake_id)) then
    select ongoing into v_ongoing from public.course_intakes where id = new.intake_id;
    if coalesce(v_ongoing, false) then
      if tg_op = 'UPDATE' and old.intake_id is distinct from new.intake_id then new.course_start_date := null; new.course_end_date := null; end if;
      new.course_start_date := coalesce(new.course_start_date, new.enrolled_on, public.course_intake_today());
      new.course_end_date := coalesce(new.course_end_date, public.course_offer_end(new.intake_id, new.course_start_date));
      if new.course_end_date < new.course_start_date then new.course_end_date := new.course_start_date; end if;
      return new;
    end if;
    select min(iu.start_date), max(iu.end_date) into v_start, v_end from public.intake_units iu where iu.intake_id = new.intake_id;
    select coalesce(v_start, ci.start_date), coalesce(v_end, ci.end_date) into v_start, v_end from public.course_intakes ci where ci.id = new.intake_id;
    if tg_op = 'UPDATE' and old.intake_id is distinct from new.intake_id then
      new.course_start_date := greatest(coalesce(new.enrolled_on, v_start), v_start);
      new.course_end_date := v_end;
    else
      new.course_start_date := coalesce(new.course_start_date, greatest(coalesce(new.enrolled_on, v_start), v_start));
      new.course_end_date := coalesce(new.course_end_date, v_end);
    end if;
    if new.course_end_date < new.course_start_date then new.course_end_date := new.course_start_date; end if;
  end if;
  return new;
end $$;

-- What the forms show for an intake: an ongoing intake is its course code and title (and campus), never a group or a date.
create or replace function public.course_intake_display(i public.course_intakes) returns text
language sql stable set search_path to 'pg_catalog', 'public', 'pg_temp' as $$
 select case when i.ongoing then coalesce(nullif(btrim(i.name), ''), public.course_intake_ongoing_name(i.course_id), 'Ongoing intake')
   else to_char(i.start_date, 'Mon YYYY') || ' (' || to_char(i.start_date, 'FMDD Mon YYYY') || coalesce(' – ' || to_char(i.end_date, 'FMDD Mon YYYY'), '') || ')' end
  || coalesce(' · ' || nullif(btrim(coalesce(i.campus, (select c.campus from public.cms_courses c where c.id = i.course_id))), ''), '');
$$;

-- The ongoing intake is always offered while it is open.
create or replace function public.course_intake_offered(p_course text) returns setof uuid
language sql stable security definer set search_path to 'pg_catalog', 'public', 'pg_temp' as $$
  with c as (select public.course_resolve_id(p_course) cid), t as (select public.course_intake_today() d),
  m as (select exists (select 1 from public.course_coe_timetables x, c where x.course_id = c.cid) on_master),
  live as (
    select i.* from public.course_intakes i, c where i.course_id = c.cid and i.is_active and coalesce(i.status, 'open') not in ('closed', 'draft'))
  select l.id from live l where l.ongoing
  union
  select l.id from live l, t, m where not l.ongoing and m.on_master and coalesce(l.end_date, l.start_date) >= t.d
  union
  select l.id from live l, t, m where not l.ongoing and not m.on_master and l.start_date <= t.d and coalesce(l.end_date, l.start_date) >= t.d
  union
  select n.id from (
    select l.id, row_number() over (partition by l.study_load order by l.start_date, l.id) as rn from live l, t, m
     where not l.ongoing and not m.on_master and l.start_date > t.d) n where n.rn <= public.rule_int('lms.intake_upcoming_per_load', 1);
$$;

/**
 * The start dates of a course for the application form. A dated intake: as before (its day one and its unit starts). The ongoing
 * intake: the upcoming batch starts and the course calendar's upcoming cycle starts (day one), and, when the rule allows joining at
 * any unit, the upcoming unit starts of its batches; each with the course end calculated from that start.
 */
create or replace function public.course_join_options(p_course text) returns jsonb
language plpgsql security definer set search_path to 'pg_catalog', 'public', 'pg_temp' as $$
declare v_cid text := public.course_resolve_id(p_course); v_today date := public.course_intake_today(); v_old jsonb; v_list jsonb; v_ongoing jsonb;
  v_any boolean := public.rule_text('lms.join_dates', 'Any unit start date') <> 'Intake day one only';
begin
  v_old := public.course_intakes_open(p_course);
  if v_cid is null then return v_old; end if;
  select coalesce(jsonb_agg(public.course_intake_json(i) || jsonb_build_object(
      'fallback', false, 'running', i.start_date <= v_today, 'joinDate', s.d, 'firstDay', s.d = i.start_date,
      'studyLoad', i.study_load, 'unitCode', cu.code, 'unitName', cu.name, 'prereqFirst', p.missed,
      'option', format('Starts %s – %s (%s)%s', to_char(s.d, 'FMDD Mon YYYY'),
        case when s.d = i.start_date then 'day one of the course' else coalesce(cu.code || ' ' || cu.name, 'next unit') end,
        public.course_intake_name(i), case when p.missed then ' · missed prerequisites first' else '' end))
    order by s.d, i.start_date, i.id), '[]'::jsonb) into v_list
  from public.course_intakes i
  cross join lateral (
    select distinct z.d from (select i.start_date d union all select u.start_date from public.intake_units u where u.intake_id = i.id and v_any) z
     where z.d >= v_today and (i.end_date is null or z.d <= i.end_date)) s
  left join lateral (select u.unit_id from public.intake_units u where u.intake_id = i.id and u.start_date = s.d order by u.sort, u.id limit 1) fu on true
  left join public.cms_course_units cu on cu.id = fu.unit_id
  cross join lateral (select s.d > i.start_date and exists (
      select 1 from public.intake_units q cross join lateral public.rto_unit_requires(q.unit_id) r(unit_id)
        join public.intake_units pr on pr.intake_id = i.id and pr.unit_id = r.unit_id
       where q.intake_id = i.id and q.start_date >= s.d and pr.start_date < s.d) missed) p
  where i.id in (select public.course_intake_offered(v_cid)) and not i.ongoing;

  -- The ongoing intakes: batch starts, calendar cycle starts and (rule) the batches' unit starts.
  select coalesce(jsonb_agg(public.course_intake_json(i) || jsonb_build_object(
      'fallback', false, 'running', true, 'joinDate', s.d, 'firstDay', s.first_day, 'studyLoad', i.study_load,
      'unitCode', cu.code, 'unitName', cu.name, 'prereqFirst', false, 'batchCode', s.batch_code,
      'courseEndDate', public.course_offer_end(i.id, s.d),
      'option', format('Starts %s – %s (%s)', to_char(s.d, 'FMDD Mon YYYY'),
        case when s.first_day then 'day one of the course' else coalesce(cu.code || ' ' || cu.name, 'next unit') end,
        public.course_intake_display(i)))
    order by s.d, i.id), '[]'::jsonb) into v_ongoing
  from public.course_intakes i
  cross join lateral (
    select z.d, bool_or(z.first_day) as first_day, min(z.unit_id) filter (where not z.first_day) as unit_id, min(z.batch_code) as batch_code from (
      select b.start_date as d, true as first_day, null::text as unit_id, b.code as batch_code from public.intake_batches b
       where b.intake_id = i.id and b.archived_at is null and b.start_date is not null
      union all
      select x.f, true, null, null from (
        select cycle, min(start_date) as f from public.course_coe_units where course_id = i.course_id and public.course_master_kind_for(i.course_id, i.study_load) = 'coe' group by cycle
        union all
        select cycle, min(start_date) from public.course_voe_units where course_id = i.course_id and start_date is not null
           and public.course_master_kind_for(i.course_id, i.study_load) = 'voe' group by cycle) x
      union all
      select bu.start_date, false, bu.unit_id, b.code from public.intake_batch_units bu join public.intake_batches b on b.id = bu.batch_id
       where b.intake_id = i.id and b.archived_at is null and v_any) z
     where z.d >= v_today
     group by z.d) s
  left join public.cms_course_units cu on cu.id = s.unit_id
  where i.id in (select public.course_intake_offered(v_cid)) and i.ongoing;
  v_list := v_list || v_ongoing;

  if jsonb_array_length(v_list) > 0 then return v_list; end if;
  if not v_any then
    return coalesce((select jsonb_agg(x.v order by x.n) from jsonb_array_elements(v_old) with ordinality x(v, n)
      where not coalesce((x.v->>'running')::boolean, false)), '[]'::jsonb);
  end if;
  return v_old;
end $$;

-- 3. Classes per batch: a batch with its own unit dates is timetabled on them (else on the intake's); an ongoing intake is always
--    generated batch by batch.
do $$
declare d text := pg_get_functiondef('public.course_master_classes(uuid)'::regprocedure); a text; b text;
begin
  a := 'v_created integer := 0; v_kept integer; v_end date;';
  if position(a in d) = 0 then raise exception 'course_master_classes: declare anchor not found'; end if;
  d := replace(d, a, 'v_created integer := 0; v_kept integer; v_end date; v_bstart date;');
  a := 'gt.batch_id = gb.id)) > 1 then';
  if position(a in d) = 0 then raise exception 'course_master_classes: batch anchor not found'; end if;
  d := replace(d, a, 'gt.batch_id = gb.id)) > 1 - coalesce(v_intake.ongoing, false)::integer then');
  a := 'v_from := case when';
  if position(a in d) = 0 then raise exception 'course_master_classes: from anchor not found'; end if;
  d := replace(d, a, 'v_bstart := coalesce((select gb2.start_date from public.intake_batches gb2 where gb2.id::text = nullif(current_setting(''lms.gen_batch'', true), '''')
    and exists (select 1 from public.intake_batch_units x where x.batch_id = gb2.id)), v_intake.start_date);
 v_from := case when');
  a := 'greatest(v_intake.start_date, current_date) else v_intake.start_date end';
  if position(a in d) = 0 then raise exception 'course_master_classes: start anchor not found'; end if;
  d := replace(d, a, 'greatest(v_bstart, current_date) else v_bstart end');
  a := 'from public.intake_units iu join public.cms_course_units cu on cu.id = iu.unit_id where iu.intake_id = v_intake.id order by iu.sort, iu.start_date loop';
  if position(a in d) = 0 then raise exception 'course_master_classes: units anchor not found'; end if;
  b := 'from (select bu.unit_id, bu.start_date, bu.end_date, bu.sort, null::integer as hours from public.intake_batch_units bu
         where bu.batch_id::text = nullif(current_setting(''lms.gen_batch'', true), '''')
        union all
        select x.unit_id, x.start_date, x.end_date, x.sort, x.hours from public.intake_units x where x.intake_id = v_intake.id
         and not exists (select 1 from public.intake_batch_units y where y.batch_id::text = nullif(current_setting(''lms.gen_batch'', true), ''''))) iu
  join public.cms_course_units cu on cu.id = iu.unit_id order by iu.sort, iu.start_date loop';
  d := replace(d, a, b);
  execute d;
end $$;

-- 4. Offers: the ongoing intake's start is the date chosen on the application, its end one course length later.
do $$
declare d text := pg_get_functiondef('public.application_letter_course(public.enrollment_application_courses, text, public.cms_settings, text)'::regprocedure); a text;
begin
  a := 'v_cricos_tuition boolean := false;';
  if position(a in d) = 0 then raise exception 'application_letter_course: declare anchor not found'; end if;
  d := replace(d, a, 'v_cricos_tuition boolean := false; v_start date; v_end date; v_join text;');
  a := ' fee_src := case when fi.id is not null';
  if position(a in d) = 0 then raise exception 'application_letter_course: body anchor not found'; end if;
  d := replace(d, a, ' v_start := i.start_date; v_end := i.end_date;
 if i.ongoing then
  select ea.data->''values''->>''intake_join_date'' into v_join from public.enrollment_applications ea where ea.id = p_ac.application_id;
  v_start := case when v_join ~ ''^\d{4}-\d{2}-\d{2}$'' then v_join::date end;
  if v_start is null then
   select min(z.d) into v_start from (select (x->>''joinDate'')::date d from jsonb_array_elements(public.course_join_options(i.course_id)) x
     where x->>''id'' = i.id::text and x->>''joinDate'' is not null) z;
  end if;
  v_end := public.course_offer_end(i.id, v_start);
 end if;
' || a);
  a := 'when ''course.start_date'' then raw := coalesce(i.start_date::text, '''');';
  if position(a in d) = 0 then raise exception 'application_letter_course: start anchor not found'; end if;
  d := replace(d, a, 'when ''course.start_date'' then raw := coalesce(v_start::text, '''');');
  a := 'when ''course.end_date'' then raw := coalesce(i.end_date::text, '''');';
  if position(a in d) = 0 then raise exception 'application_letter_course: end anchor not found'; end if;
  d := replace(d, a, 'when ''course.end_date'' then raw := coalesce(v_end::text, '''');');
  a := '''_start'', i.start_date, ''_end'', i.end_date';
  if position(a in d) = 0 then raise exception 'application_letter_course: result anchor not found'; end if;
  d := replace(d, a, '''_start'', v_start, ''_end'', v_end');
  execute d;
end $$;

-- 5. Merging an intake into the ongoing intake (owner 2026-11-28: the intake Skyline made for Himani's later units becomes a batch
--    of the ongoing intake; rows are moved, never deleted, allocations keep their dates and results).
do $$
declare d text := pg_get_functiondef('lms_allocation_private.preserve_allocation()'::regprocedure); a text;
begin
  a := ' -- STUDENT-DELETE-EVERYTHING: the confirmed delete of this one student (admin_student_purge).';
  if position(a in d) = 0 then raise exception 'preserve_allocation: anchor not found'; end if;
  d := replace(d, a, ' -- ROLLING-INTAKES: an intake merged into the course''s ongoing intake (public.rto_intake_merge) moves its allocations and
 -- roster to that intake, with the same unit, student, course, allocation time and dates.
 if coalesce(current_setting(''skyline.merging_intake'', true), '''') = old.intake_id::text then
  if tg_op = ''DELETE'' and tg_table_name = ''lms_intake_students'' then
   return old;
  end if;
  if tg_op = ''UPDATE'' and tg_table_name = ''lms_unit_students'' then
   if new.intake_id::text = current_setting(''skyline.merge_target'', true) and new.unit_id = old.unit_id and new.student_id = old.student_id
      and new.course_id = old.course_id and new.allocated_at = old.allocated_at
      and new.assigned_start_date is not distinct from old.assigned_start_date and new.assigned_end_date is not distinct from old.assigned_end_date then
    return new;
   end if;
  end if;
 end if;
' || a);
  execute d;
end $$;

/**
 * Merges a dated intake into the course's ongoing intake: its batches become batches of the ongoing intake (code C<cycle> of the
 * calendar cycle it ran, name "<course> C<cycle>", its unit dates as the batch's own), with their class times, classes, trainers,
 * registers and assessments; its students' roster and unit allocations move with the same dates and results; a student's second
 * Qualification for the course is archived (their Qualification in the ongoing intake is kept), else it moves. The merged intake is
 * closed and archived (never deleted). Returns the first moved batch.
 */
create or replace function public.rto_intake_merge(p_from uuid, p_into uuid, p_actor uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare f public.course_intakes; t public.course_intakes; b record; r record; q record; v_code text; v_cycle integer; v_batch uuid; n integer;
  v_was text := coalesce(current_setting('rto.auto_place', true), ''); v_ccode text;
begin
  select * into f from public.course_intakes where id = p_from;
  select * into t from public.course_intakes where id = p_into;
  if f.id is null or t.id is null or f.course_id <> t.course_id or f.id = t.id then raise exception 'Choose two intakes of the same course.' using errcode = '22023'; end if;
  if not t.ongoing then raise exception 'An intake is merged into the course''s ongoing intake.' using errcode = '22023'; end if;
  if f.ongoing then raise exception 'The ongoing intake cannot be merged.' using errcode = '22023'; end if;
  perform set_config('rto.auto_place', 'on', true);
  perform set_config('skyline.merging_intake', p_from::text, true);
  perform set_config('skyline.merge_target', p_into::text, true);
  select code into v_ccode from public.cms_courses where id = f.course_id;
  select max(master_cycle) into v_cycle from public.intake_units where intake_id = p_from;
  for b in select * from public.intake_batches where intake_id = p_from order by sort, code loop
    v_code := coalesce('C' || v_cycle, b.code); n := 1;
    while exists (select 1 from public.intake_batches x where x.intake_id = p_into and lower(x.code) = lower(v_code)) loop
      v_code := coalesce('C' || v_cycle, b.code) || '-' || n; n := n + 1;
    end loop;
    update public.intake_batches
       set intake_id = p_into, code = v_code,
           name = case when name is null or name ~* '^batch [0-9]+$' then left(btrim(concat_ws(' ', v_ccode, v_code)), 120) else name end,
           capacity = coalesce(capacity, case when f.capacity between 1 and 1000 then f.capacity end), room_id = coalesce(room_id, f.classroom_id),
           start_date = coalesce((select min(start_date) from public.intake_units where intake_id = p_from), f.start_date),
           end_date = coalesce((select max(end_date) from public.intake_units where intake_id = p_from), f.end_date),
           sort = coalesce((select max(sort) from public.intake_batches where intake_id = p_into), 0) + 1, updated_at = now(), updated_by = p_actor
     where id = b.id;
    insert into public.intake_batch_units(batch_id, unit_id, start_date, end_date, sort, trainer_id)
    select b.id, u.unit_id, u.start_date, u.end_date, u.sort, u.trainer_id from public.intake_units u where u.intake_id = p_from
    on conflict (batch_id, unit_id) do nothing;
    v_batch := coalesce(v_batch, b.id);
  end loop;
  update public.intake_class_times set intake_id = p_into where intake_id = p_from;
  update public.class_sessions set intake_id = p_into where intake_id = p_from;
  update public.intake_trainers set intake_id = p_into where intake_id = p_from;
  update public.lms_attendance_register g set intake_id = p_into,
         intake_unit_id = coalesce((select u2.id from public.intake_units u1 join public.intake_units u2 on u2.intake_id = p_into and u2.unit_id = u1.unit_id
                                     where u1.id = g.intake_unit_id), g.intake_unit_id)
   where g.intake_id = p_from;
  update public.asm_assignments g set intake_id = p_into,
         intake_unit_id = coalesce((select u2.id from public.intake_units u1 join public.intake_units u2 on u2.intake_id = p_into and u2.unit_id = u1.unit_id
                                     where u1.id = g.intake_unit_id), g.intake_unit_id)
   where g.intake_id = p_from;
  update public.asm_unit_outcomes set intake_id = p_into where intake_id = p_from;
  update public.enrollment_application_courses set intake_id = p_into where intake_id = p_from;
  update public.rto_placement_overrides set intake_id = p_into where intake_id = p_from;
  -- Qualifications: a second one of a student who has one in the ongoing intake is archived; otherwise it moves.
  for q in select e.* from public.intake_enrolments e where e.intake_id = p_from and e.archived_at is null loop
    if exists (select 1 from public.intake_enrolments x where x.intake_id = p_into and x.student_id = q.student_id and x.archived_at is null) then
      update public.batch_students set archived_at = now(), archive_reason = 'Intake merged into the ongoing intake'
       where enrolment_id = q.id and archived_at is null;
      update public.intake_enrolments set archived_at = now(), status_note = left(coalesce(status_note || ' ', '') || 'Merged into the course''s ongoing intake.', 2000)
       where id = q.id;
    else
      update public.intake_enrolments set intake_id = p_into where id = q.id;
    end if;
  end loop;
  -- Roster and allocations (same dates and results); a unit the student already has in the ongoing intake stays where it is.
  for r in select * from public.lms_intake_students where intake_id = p_from loop
    insert into public.lms_intake_students(intake_id, student_id, enrolled_at) values (p_into, r.student_id, r.enrolled_at) on conflict do nothing;
    update public.lms_unit_students a set intake_id = p_into
     where a.intake_id = p_from and a.student_id = r.student_id
       and not exists (select 1 from public.lms_unit_students x where x.intake_id = p_into and x.student_id = a.student_id and x.unit_id = a.unit_id);
    insert into public.batch_students(enrolment_id, batch_id, unit_id)
    select e.id, a.batch_id, a.unit_id from public.lms_unit_students a
      join public.intake_enrolments e on e.intake_id = p_into and e.student_id = a.student_id and e.archived_at is null
     where a.intake_id = p_into and a.student_id = r.student_id and a.batch_id in (select id from public.intake_batches where intake_id = p_into)
       and a.batch_id is distinct from (select z.batch_id from public.batch_students z where z.enrolment_id = e.id and z.unit_id is null and z.archived_at is null limit 1)
       and not exists (select 1 from public.batch_students z where z.enrolment_id = e.id and z.batch_id = a.batch_id and z.unit_id = a.unit_id and z.archived_at is null);
    if not exists (select 1 from public.lms_unit_students a where a.intake_id = p_from and a.student_id = r.student_id) then
      delete from public.lms_intake_students where intake_id = p_from and student_id = r.student_id;
    end if;
  end loop;
  update public.course_intakes set status = 'closed', archived_at = now(), archive_reason = left('Merged into ' || coalesce(t.name, 'the ongoing intake'), 500),
         updated_at = now(), updated_by = p_actor
   where id = p_from;
  update public.course_intakes set start_date = least(start_date, coalesce((select min(start_date) from public.intake_batches where intake_id = p_into), start_date))
   where id = p_into;
  perform set_config('skyline.merging_intake', '', true);
  perform set_config('skyline.merge_target', '', true);
  perform set_config('rto.auto_place', v_was, true);
  return v_batch;
end $$;
revoke all on function public.rto_intake_merge(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.rto_intake_merge(uuid, uuid, uuid) to service_role;

-- 6. aXcelerate: a class is a batch of the ongoing intake ------------------------------------------------------------------
/** The batch code at the end of an aXcelerate class / workshop name ("... -G1", "BSBLDR601_BSB80120_G1" -> G1), or null. */
create or replace function public.axcelerate_batch_code(p_name text) returns text
language sql immutable set search_path = public as $$
  select upper((regexp_match(coalesce(p_name, ''), '(?:^|[^A-Za-z0-9])([A-Za-z]{1,4}[0-9]{1,4})\s*$'))[1]);
$$;

/**
 * The batch of an aXcelerate class (p_key: its instance ID, or 'group:<code>' for a group known only from its workshops) in an
 * intake: the linked batch, else the batch of that code (not linked to another class), else the intake's untouched first batch,
 * else a new one (the code, or the next free Bn). Name, dates and capacity from aXcelerate. Returns the batch id.
 */
create or replace function public.axcelerate_batch_ensure(p_connection uuid, p_run uuid, p_actor uuid, p_intake uuid, p_key text, p_name text,
  p_start date, p_end date, p_capacity integer, p_trainer uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare l public.axcelerate_links; v_id uuid; v_code text := public.axcelerate_batch_code(p_name); v_room uuid; n integer := 1; v_taken boolean;
begin
  l := public.axcelerate_link_find(p_connection, 'batch', p_key);
  if l.id is not null then
    select id into v_id from public.intake_batches where id = l.target_id::uuid and intake_id = p_intake and archived_at is null;
  end if;
  if v_id is null and v_code is not null then
    select b.id into v_id from public.intake_batches b where b.intake_id = p_intake and b.archived_at is null and lower(b.code) = lower(v_code)
       and not exists (select 1 from public.axcelerate_links x where x.entity = 'batch' and x.target_id = b.id::text and x.axcelerate_id <> p_key
                         and x.axcelerate_id not like 'group:%');
  end if;
  if v_id is null then
    -- The intake's automatic first batch, still untouched (no class times, classes, students or link).
    select b.id into v_id from public.intake_batches b where b.intake_id = p_intake and b.archived_at is null
       and not exists (select 1 from public.intake_class_times t where t.batch_id = b.id)
       and not exists (select 1 from public.class_sessions s where s.batch_id = b.id)
       and not exists (select 1 from public.batch_students s where s.batch_id = b.id)
       and not exists (select 1 from public.lms_unit_students s where s.batch_id = b.id)
       and not exists (select 1 from public.intake_batch_units u where u.batch_id = b.id)
       and not exists (select 1 from public.axcelerate_links x where x.entity = 'batch' and x.target_id = b.id::text)
     order by b.sort, b.code limit 1;
  end if;
  v_taken := v_code is null or exists (select 1 from public.intake_batches b where b.intake_id = p_intake and lower(b.code) = lower(v_code)
                                       and b.id is distinct from v_id);
  if v_taken then
    if v_id is not null then select code into v_code from public.intake_batches where id = v_id; end if;
    if v_id is null or v_code is null then
      loop
        v_code := 'B' || n;
        exit when not exists (select 1 from public.intake_batches b where b.intake_id = p_intake and lower(b.code) = lower(v_code));
        n := n + 1;
      end loop;
    end if;
  end if;
  select classroom_id into v_room from public.course_intakes where id = p_intake;
  if v_id is null then
    insert into public.intake_batches(intake_id, code, name, room_id, capacity, default_trainer_id, sort, start_date, end_date, updated_by)
    values (p_intake, v_code, left(coalesce(p_name, v_code), 120), v_room, case when p_capacity between 1 and 1000 then p_capacity end, p_trainer,
            coalesce((select max(sort) from public.intake_batches where intake_id = p_intake), 0) + 1, p_start, greatest(p_end, p_start), p_actor)
    returning id into v_id;
  else
    update public.intake_batches
       set code = v_code, name = left(coalesce(p_name, name), 120), room_id = coalesce(room_id, v_room),
           capacity = case when p_capacity between 1 and 1000 then p_capacity else capacity end,
           default_trainer_id = coalesce(default_trainer_id, p_trainer), start_date = coalesce(p_start, start_date),
           end_date = greatest(coalesce(p_end, end_date), coalesce(p_start, start_date)), updated_at = now(), updated_by = p_actor
     where id = v_id;
  end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'batch', p_key, 'public.intake_batches', v_id::text,
    jsonb_build_object('name', p_name, 'code', v_code, 'start', p_start, 'end', p_end, 'capacity', p_capacity));
  return v_id;
end $$;

/** A batch's own unit dates (upsert); the batch's start and end follow its units. */
create or replace function public.axcelerate_batch_unit(p_batch uuid, p_unit text, p_start date, p_end date, p_sort integer, p_trainer uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_unit is null or p_start is null then return null; end if;
  insert into public.intake_batch_units(batch_id, unit_id, start_date, end_date, sort, trainer_id)
  values (p_batch, p_unit, p_start, greatest(coalesce(p_end, p_start), p_start), coalesce(p_sort, 1), p_trainer)
  on conflict (batch_id, unit_id) do update set start_date = excluded.start_date, end_date = excluded.end_date,
     sort = excluded.sort, trainer_id = coalesce(excluded.trainer_id, intake_batch_units.trainer_id), updated_at = now()
  returning id into v_id;
  update public.intake_batches b set start_date = x.f, end_date = x.l, updated_at = now()
    from (select min(start_date) f, max(end_date) l from public.intake_batch_units where batch_id = p_batch) x
   where b.id = p_batch and (b.start_date is distinct from x.f or b.end_date is distinct from x.l);
  return v_id;
end $$;

/** Mon-Fri 9:00-13:00 for an imported batch without class times, and its classes on its own unit dates. Returns a warning, or null. */
create or replace function public.axcelerate_batch_timetable(p_batch uuid, p_trainer uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public, hr as $$
declare b public.intake_batches; v_room uuid; v_was text := coalesce(current_setting('rto.auto_place', true), '');
  v_gen text := coalesce(current_setting('lms.gen_batch', true), '');
begin
  select * into b from public.intake_batches where id = p_batch;
  if b.id is null then return null; end if;
  begin
    perform set_config('rto.auto_place', 'on', true);
    if not exists (select 1 from public.intake_class_times where batch_id = p_batch) then
      v_room := coalesce(b.room_id, public.axcelerate_class_room(b.intake_id, p_actor));
      update public.intake_batches set room_id = coalesce(room_id, v_room) where id = p_batch;
      insert into public.intake_class_times(intake_id, batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort, trainer_id)
      select b.intake_id, p_batch, d.wd, 'morning', time '09:00', time '13:00', d.kind, v_room, d.wd, coalesce(p_trainer, b.default_trainer_id)
        from (values (1, 'theory'), (2, 'practical'), (3, 'theory'), (4, 'practical'), (5, 'assessment')) d(wd, kind);
    end if;
    if exists (select 1 from public.intake_batch_units where batch_id = p_batch) then
      perform set_config('lms.gen_batch', p_batch::text, true);
      perform public.course_master_classes(b.intake_id);
      perform set_config('lms.gen_batch', v_gen, true);
    end if;
    perform set_config('rto.auto_place', v_was, true);
    return null;
  exception when others then
    perform set_config('lms.gen_batch', v_gen, true);
    perform set_config('rto.auto_place', v_was, true);
    return format('Batch %s: weekly class times and classes were not set: %s Set them on the Intakes page.', b.code, sqlerrm);
  end;
end $$;

/**
 * One aXcelerate class: a batch of the course's ongoing intake of its study load (CoE only for a course on the CRICOS register).
 * The intake imported earlier for this class (one intake per class) becomes the ongoing intake when the course has none yet
 * (same records). The batch gets the class's name, code, dates, capacity, trainer and its own unit dates, weekly class times and
 * classes; the course's CoE and VoE calendars are built from the class's unit dates (10 cycles). Returns the intake.
 */
create or replace function public.axcelerate_import_class(p_connection uuid, p_run uuid, p_actor uuid, p_rec jsonb, p_course text, p_units jsonb, p_trainer uuid, p_location uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ax text := public.axcelerate_text(p_rec, 'INSTANCEID', 'ID');
  v_name text := left(coalesce(public.axcelerate_text(p_rec, 'NAME'), 'aXcelerate class ' || v_ax), 160);
  v_start date := public.axcelerate_date(p_rec->>'STARTDATE'); v_end date := public.axcelerate_date(p_rec->>'FINISHDATE');
  v_cap int := nullif(regexp_replace(coalesce(p_rec->>'MAXPARTICIPANTS', ''), '[^0-9]', '', 'g'), '')::int;
  v_load text; v_campus text; l public.axcelerate_links; v_id uuid; v_ongoing uuid; v_batch uuid; u jsonb; v_bu uuid; n_units int := 0;
  v_warn jsonb := '[]'::jsonb; v_w text; v_was text := coalesce(current_setting('rto.auto_place', true), ''); v_action text := 'updated';
  v_ustart date; v_uend date; v_old uuid; v_mb uuid; v_mc integer;
begin
  if v_ax is null then raise exception 'The class has no aXcelerate instance ID' using errcode = '22023'; end if;
  if p_course is null then raise exception 'The class % has no course', v_name using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'class', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  select min(public.axcelerate_date(x->>'start')), max(public.axcelerate_date(x->>'end')) into v_ustart, v_uend
    from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x;
  v_start := coalesce(v_start, v_ustart);
  if v_start is null then raise exception 'The class % has no start date', v_name using errcode = '22023'; end if;
  v_end := greatest(coalesce(v_end, v_uend, v_start), v_start, coalesce(v_uend, v_start));
  select case when coalesce(nullif(btrim(cricos), ''), cricos_course_code) is not null then 'coe' else 'voe' end
    into v_load from public.cms_courses where id = p_course;
  v_load := coalesce(v_load, 'voe');
  select left(name, 200) into v_campus from public.locations where id = p_location;
  perform set_config('rto.auto_place', 'on', true);

  select id into v_ongoing from public.course_intakes where course_id = p_course and lower(study_load) = v_load and ongoing and archived_at is null;
  l := public.axcelerate_link_find(p_connection, 'class', v_ax);
  if l.id is not null then
    select id into v_id from public.course_intakes where id = l.target_id::uuid and course_id = p_course;
    if v_id is null then delete from public.axcelerate_links where id = l.id; l := null; end if;
  end if;
  if v_id is not null and v_ongoing is null then
    -- The intake imported earlier for this class becomes the course's ongoing intake (same records, no end date).
    update public.course_intakes set ongoing = true, end_date = null, capacity = null, status = 'open', study_load = v_load,
           name = public.course_intake_ongoing_name(p_course), label = left(coalesce(public.course_intake_ongoing_name(p_course), label), 80),
           start_date = least(start_date, v_start), campus = coalesce(v_campus, campus), updated_at = now(), updated_by = p_actor
     where id = v_id;
    v_ongoing := v_id;
  elsif v_id is not null and v_id <> v_ongoing then
    v_warn := v_warn || to_jsonb(format('The class was imported earlier as its own intake (%s); its batch is now in the course''s ongoing intake. Move its students on the Intakes page.',
      (select coalesce(name, label) from public.course_intakes where id = v_id)));
  end if;
  if v_ongoing is null then
    v_ongoing := public.course_ongoing_intake(p_course, v_load, v_start, p_actor);
    v_action := 'created';
  end if;
  v_id := v_ongoing;
  update public.course_intakes set campus = coalesce(campus, v_campus), start_date = least(start_date, v_start), updated_at = now()
   where id = v_id and (campus is null or start_date > v_start);
  -- The intakes Skyline made for later repetitions of this course (one intake each) become batches of the ongoing intake.
  for v_old in select ci.id from public.course_intakes ci where ci.course_id = p_course and lower(ci.study_load) = v_load and not ci.ongoing
                 and ci.auto_created and ci.archived_at is null order by ci.start_date loop
    select max(master_cycle) into v_mc from public.intake_units where intake_id = v_old;
    v_mb := public.rto_intake_merge(v_old, v_id, p_actor);
    if v_mb is not null then
      if v_mc is not null then
        perform public.axcelerate_link_save(p_connection, p_run, 'batch', 'cycle:' || p_course || ':' || v_load || ':' || v_mc, 'public.intake_batches', v_mb::text,
          jsonb_build_object('mergedIntake', v_old, 'cycle', v_mc));
      end if;
      v_warn := v_warn || to_jsonb(format('The intake Skyline made for a later repetition was merged into the ongoing intake as batch %s.',
        (select code from public.intake_batches where id = v_mb)));
    end if;
  end loop;

  v_batch := public.axcelerate_batch_ensure(p_connection, p_run, p_actor, v_id, v_ax, v_name, v_start, v_end, v_cap, p_trainer);
  for u in select * from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) loop
    v_bu := public.axcelerate_batch_unit(v_batch, u->>'unitId', coalesce(public.axcelerate_date(u->>'start'), v_start),
      greatest(coalesce(public.axcelerate_date(u->>'end'), v_end), coalesce(public.axcelerate_date(u->>'start'), v_start)),
      coalesce(nullif(u->>'order', '')::int, 0) + n_units + 1, p_trainer);
    if v_bu is not null then
      perform public.axcelerate_link_save(p_connection, p_run, 'class_unit', v_ax || ':' || (u->>'unitId'), 'public.intake_batch_units', v_bu::text, u);
      n_units := n_units + 1;
    end if;
  end loop;
  -- The class's own dates stay on the batch (its units may start before or end after the class dates aXcelerate lists).
  update public.intake_batches set start_date = least(start_date, v_start), end_date = greatest(end_date, v_end) where id = v_batch;
  update public.course_intakes set start_date = (select min(start_date) from public.intake_batches where intake_id = v_id and archived_at is null)
   where id = v_id and start_date > (select min(start_date) from public.intake_batches where intake_id = v_id and archived_at is null);
  if p_trainer is not null then
    insert into public.intake_trainers(intake_id, staff_id, batch_id) values (v_id, p_trainer, v_batch) on conflict do nothing;
  end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'class', v_ax, 'public.course_intakes', v_id::text, p_rec);
  v_w := public.axcelerate_unit_hours(p_course);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  -- The course's CoE and VoE calendars from the class's unit dates (10 cycles; the intake's own units follow the current cycle).
  v_w := public.axcelerate_course_calendars(p_connection, p_run, p_actor, p_course, v_ax, p_units);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  v_w := public.axcelerate_batch_timetable(v_batch, p_trainer, p_actor);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  perform set_config('rto.auto_place', v_was, true);
  return public.axcelerate_outcome(v_action, v_id::text,
    jsonb_build_object('units', n_units, 'batch', v_batch, 'batchCode', (select code from public.intake_batches where id = v_batch), 'warnings', v_warn));
end $$;

/**
 * The student's units by batch: each unit aXcelerate enrols them in (TYPE s) is allocated in the ongoing intake to the batch of its
 * aXcelerate workshop (the group at the end of the workshop's name, e.g. "BSBSTR801_BSB80120_G2" -> G2; the student's own class's
 * batch when the workshop names no group), on that batch's unit dates (the workshop's dates are the batch's dates for the unit; a
 * batch known only from workshops is made, with its weekly class times and classes). Allocations are permanent: an existing one keeps
 * its dates. Then aXcelerate's unit results on each allocation. Returns {units, allocated, missed, warnings}.
 */
create or replace function public.axcelerate_import_unit_results(p_connection uuid, p_run uuid, p_actor uuid, p_enrolment uuid, p_units jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.intake_enrolments; i public.course_intakes; c public.cms_courses; u jsonb; w jsonb; v_unit text; v_code text; v_out text; r public.lms_unit_students;
  l public.axcelerate_links; v_start date; v_end date; v_res jsonb := '[]'::jsonb; v_key text; v_loc uuid; v_act text; v_class text;
  v_home uuid; v_batch uuid; v_group text; v_ws date; v_we date; v_alloc jsonb; v_missed jsonb; v_warn jsonb := '[]'::jsonb; v_w text;
  v_touched uuid[] := '{}'; v_b uuid; bu public.intake_batch_units; v_trainer uuid; v_cyc record;
begin
  perform public.axcelerate_importing(p_actor);
  select * into e from public.intake_enrolments where id = p_enrolment;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  select * into i from public.course_intakes where id = e.intake_id;
  select * into c from public.cms_courses where id = i.course_id;
  select id into v_loc from public.locations where name = i.campus order by created_at limit 1;
  -- The student's own class (the Qualification's aXcelerate class) is their home batch.
  select x.raw->>'INSTANCEID' into v_class from public.axcelerate_links x
   where x.connection_id = p_connection and x.entity = 'qualification' and x.target_id = p_enrolment::text limit 1;
  if v_class is not null then
    select b.id into v_home from public.axcelerate_links x join public.intake_batches b on b.id::text = x.target_id
     where x.connection_id = p_connection and x.entity = 'batch' and x.axcelerate_id = v_class and b.intake_id = i.id limit 1;
  end if;
  v_home := coalesce(v_home, public.intake_default_batch(i.id));
  select staff_id into v_trainer from public.intake_trainers where batch_id = v_home limit 1;
  -- The Qualification's batch is the home batch (the automatic one is moved).
  begin
    update public.batch_students set batch_id = v_home where enrolment_id = e.id and unit_id is null and archived_at is null and batch_id <> v_home
       and not exists (select 1 from public.batch_students z where z.enrolment_id = e.id and z.batch_id = v_home and z.unit_id is null and z.archived_at is null);
    insert into public.batch_students(enrolment_id, batch_id) select e.id, v_home
     where not exists (select 1 from public.batch_students z where z.enrolment_id = e.id and z.unit_id is null and z.archived_at is null);
  exception when others then
    v_warn := v_warn || to_jsonb('The student''s batch was not set: ' || sqlerrm);
  end;
  insert into public.lms_intake_students(intake_id, student_id, enrolled_at)
  values (i.id, e.student_id, coalesce(e.enrolled_on, i.start_date)::timestamptz) on conflict do nothing;

  for u in select * from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) loop
    v_code := upper(coalesce(public.axcelerate_text(u, 'CODE'), ''));
    v_out := public.axcelerate_text(u, 'OUTCOMECODE');
    v_start := public.axcelerate_date(public.axcelerate_text(u, 'COMMENCEDDATE', 'STARTDATE'));
    v_end := public.axcelerate_date(public.axcelerate_text(u, 'COMPLETIONDATE', 'FINISHDATE'));
    v_unit := null;
    select id into v_unit from public.cms_course_units where course_id = i.course_id and upper(code) = v_code order by is_active desc limit 1;
    if v_unit is null then
      v_res := v_res || jsonb_build_object('code', v_code, 'action', 'error', 'message', 'This unit is not in the course in Skyline.');
      continue;
    end if;
    -- The unit's batch: its workshop's group, on the workshop's dates.
    w := case when jsonb_typeof(u->'WORKSHOP') = 'object' then u->'WORKSHOP' end;
    v_group := public.axcelerate_batch_code(public.axcelerate_text(w, 'NAME'));
    v_ws := public.axcelerate_date(public.axcelerate_text(w, 'STARTDATE'));
    v_we := public.axcelerate_date(public.axcelerate_text(w, 'FINISHDATE'));
    v_batch := v_home;
    if v_group is not null and lower(v_group) <> lower((select code from public.intake_batches where id = v_home)) then
      select b.id into v_batch from public.intake_batches b where b.intake_id = i.id and b.archived_at is null and lower(b.code) = lower(v_group);
      if v_batch is null and v_ws is not null then
        v_batch := public.axcelerate_batch_ensure(p_connection, p_run, p_actor, i.id, 'group:' || i.course_id || ':' || v_group,
          btrim(concat_ws(' ', nullif(btrim(c.code), ''), v_group)), v_ws, v_we, null, v_trainer);
      end if;
      v_batch := coalesce(v_batch, v_home);
    end if;
    if v_ws is not null then
      perform public.axcelerate_batch_unit(v_batch, v_unit, v_ws, coalesce(v_we, v_ws),
        coalesce((select sort from public.cms_course_units where id = v_unit), 1), v_trainer);
      if not v_batch = any(v_touched) then v_touched := v_touched || v_batch; end if;
    end if;
    select * into bu from public.intake_batch_units where batch_id = v_batch and unit_id = v_unit;
    -- No workshop, and the unit is not in the student's own batch on or after its aXcelerate start (a unit aXcelerate plans for a later
    -- repetition): the batch of the course calendar's cycle that runs it then (code C<cycle>), on aXcelerate's start for the unit.
    if v_ws is null and v_start is not null and (bu.id is null or bu.end_date < v_start)
       and not exists (select 1 from public.lms_unit_students a where a.student_id = e.student_id and a.course_id = i.course_id and a.unit_id = v_unit) then
      select x.cycle, x.start_date, x.end_date into v_cyc from (
        select cycle, start_date, end_date from public.course_coe_units where course_id = i.course_id and unit_id = v_unit and public.course_master_kind_for(i.course_id, i.study_load) = 'coe'
        union all
        select cycle, start_date, end_date from public.course_voe_units where course_id = i.course_id and unit_id = v_unit and start_date is not null
           and public.course_master_kind_for(i.course_id, i.study_load) = 'voe') x
       order by abs(x.start_date - v_start), x.cycle limit 1;
      if v_cyc.cycle is not null then
        v_batch := public.axcelerate_batch_ensure(p_connection, p_run, p_actor, i.id, 'cycle:' || i.course_id || ':' || lower(i.study_load) || ':' || v_cyc.cycle,
          btrim(concat_ws(' ', nullif(btrim(c.code), ''), 'C' || v_cyc.cycle)), null, null, null, v_trainer);
        -- The cycle's units on the calendar's dates (kept once set), this unit on aXcelerate's start.
        insert into public.intake_batch_units(batch_id, unit_id, start_date, end_date, sort, trainer_id)
        select v_batch, m.unit_id, m.start_date, m.end_date, m.sort, v_trainer
          from public.course_master_rows(i.course_id, public.course_master_kind_for(i.course_id, i.study_load), v_cyc.cycle) m
        on conflict (batch_id, unit_id) do nothing;
        perform public.axcelerate_batch_unit(v_batch, v_unit, v_start, coalesce(v_end, v_start + (v_cyc.end_date - v_cyc.start_date)),
          coalesce((select sort from public.intake_batch_units where batch_id = v_batch and unit_id = v_unit), 1), v_trainer);
        -- A unit ends before the next one of the batch starts.
        update public.intake_batch_units t set end_date = greatest(t.start_date, n.next_start - 1), updated_at = now()
          from (select id, lead(start_date) over (order by start_date, sort) as next_start from public.intake_batch_units where batch_id = v_batch) n
         where t.id = n.id and n.next_start is not null and n.next_start > t.start_date and t.end_date >= n.next_start;
        update public.intake_batches b set start_date = x.f, end_date = x.l from (select min(start_date) f, max(end_date) l from public.intake_batch_units where batch_id = v_batch) x where b.id = v_batch;
        if not v_batch = any(v_touched) then v_touched := v_touched || v_batch; end if;
        select * into bu from public.intake_batch_units where batch_id = v_batch and unit_id = v_unit;
      end if;
    end if;
    -- The allocation (permanent: an existing one keeps its dates; one without a batch gets this one).
    begin
      if not exists (select 1 from public.lms_unit_students a where a.student_id = e.student_id and a.course_id = i.course_id and a.unit_id = v_unit) then
        if bu.id is null then
          v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'error',
            'message', 'aXcelerate gave no dates for this unit (no workshop and not in the class): it was not allocated.');
          continue;
        end if;
        insert into public.lms_unit_students(intake_id, unit_id, student_id, course_id, assigned_start_date, assigned_end_date, batch_id, funding_source_code, location_id)
        values (i.id, v_unit, e.student_id, i.course_id, bu.start_date, bu.end_date, v_batch, e.funding_source_code, v_loc);
      else
        update public.lms_unit_students set batch_id = v_batch
         where intake_id = i.id and student_id = e.student_id and unit_id = v_unit and batch_id is distinct from v_batch
           and not exists (select 1 from public.lms_attendance_marks m join public.lms_attendance_register g on g.id = m.register_id
                            where m.enrolment_id = e.id and g.batch_id = lms_unit_students.batch_id);
      end if;
    exception when others then
      v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'error', 'message', 'Not allocated: ' || sqlerrm);
      continue;
    end;
    if v_out is null then
      v_res := v_res || jsonb_build_object('code', v_code, 'action', 'open', 'batch', (select code from public.intake_batches where id = v_batch));
      continue;
    end if;
    if not public.avetmiss_is_code('outcome', v_out) then
      v_res := v_res || jsonb_build_object('code', v_code, 'action', 'error', 'message', format('"%s" is not an AVETMISS outcome code.', v_out));
      continue;
    end if;
    v_key := p_enrolment::text || ':' || v_unit;
    l := public.axcelerate_link_find(p_connection, 'unit_result', v_key);
    begin
      select * into r from public.lms_unit_students where student_id = e.student_id and course_id = i.course_id and unit_id = v_unit
       order by (intake_id = i.id) desc, assigned_start_date desc limit 1;
      if r.outcome_code is not null and r.outcome_code is distinct from v_out
            and (l.id is null or r.outcome_recorded_at > l.last_imported_at + interval '5 seconds') then
        v_res := v_res || jsonb_build_object('code', v_code, 'outcome', r.outcome_code, 'action', 'kept',
          'message', format('Skyline has result %s (kept); aXcelerate has %s.', r.outcome_code, v_out));
        continue;
      elsif r.outcome_code is not distinct from v_out
            and r.actual_start_date is not distinct from (case when v_out = '85' then null else coalesce(v_start, r.actual_start_date, r.assigned_start_date) end)
            and r.actual_end_date is not distinct from (case when v_out in ('70', '85') then null else coalesce(v_end, r.actual_end_date) end) then
        perform public.axcelerate_link_save(p_connection, p_run, 'unit_result', v_key, 'public.lms_unit_students', v_key, u);
        v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'unchanged');
        continue;
      else
        v_act := 'updated';
      end if;
      update public.lms_unit_students
         set outcome_code = v_out,
             actual_start_date = case when v_out = '85' then null else coalesce(v_start, actual_start_date, assigned_start_date) end,
             actual_end_date = case when v_out in ('70', '85') then null else coalesce(v_end, actual_end_date) end,
             outcome_recorded_at = now(), outcome_recorded_by = p_actor,
             outcome_evidence_note = left('Imported from aXcelerate (unit enrolment ' || coalesce(public.axcelerate_text(u, 'ENROLID'), '?')
               || ', status ' || coalesce(public.axcelerate_text(u, 'STATUS'), '?') || ')', 2000),
             location_id = coalesce(location_id, v_loc),
             funding_source_code = coalesce(funding_source_code, e.funding_source_code)
       where intake_id = r.intake_id and student_id = e.student_id and unit_id = v_unit;
      perform public.axcelerate_link_save(p_connection, p_run, 'unit_result', v_key, 'public.lms_unit_students', v_key, u);
      v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', v_act);
    exception when others then
      v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'error', 'message', sqlerrm);
    end;
  end loop;
  -- Batches that got unit dates from the workshops get their weekly class times and classes.
  foreach v_b in array v_touched loop
    if v_b <> v_home or not exists (select 1 from public.class_sessions s where s.batch_id = v_b) then
      v_w := public.axcelerate_batch_timetable(v_b, v_trainer, p_actor);
      if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
    end if;
  end loop;
  select coalesce(jsonb_agg(cu.code || coalesce(' (' || b.code || ')', '') order by a.assigned_start_date, cu.code), '[]'::jsonb) into v_alloc
    from public.lms_unit_students a join public.cms_course_units cu on cu.id = a.unit_id left join public.intake_batches b on b.id = a.batch_id
   where a.student_id = e.student_id and a.course_id = i.course_id;
  select coalesce(jsonb_agg(cu.code order by cu.sort, cu.code), '[]'::jsonb) into v_missed from public.cms_course_units cu
   where cu.course_id = i.course_id and cu.is_active and not lms_allocation_private.unit_completed(e.student_id, cu.id)
     and not exists (select 1 from public.lms_unit_students a where a.student_id = e.student_id and a.course_id = i.course_id and a.unit_id = cu.id);
  return jsonb_build_object('units', v_res, 'allocated', v_alloc, 'missed', v_missed, 'warnings', v_warn);
end $$;

revoke all on function public.course_ongoing_intake(text, text, date, uuid), public.course_intake_ongoing_name(text),
  public.axcelerate_batch_ensure(uuid, uuid, uuid, uuid, text, text, date, date, integer, uuid),
  public.axcelerate_batch_unit(uuid, text, date, date, integer, uuid), public.axcelerate_batch_timetable(uuid, uuid, uuid),
  public.course_offer_end(uuid, date) from public, anon, authenticated;
grant execute on function public.course_ongoing_intake(text, text, date, uuid),
  public.axcelerate_batch_ensure(uuid, uuid, uuid, uuid, text, text, date, date, integer, uuid),
  public.axcelerate_batch_unit(uuid, text, date, date, integer, uuid), public.axcelerate_batch_timetable(uuid, uuid, uuid) to service_role;
grant execute on function public.course_offer_end(uuid, date), public.course_intake_ongoing_name(text) to authenticated;

commit;
