-- TIMETABLE-A: locations and rooms, the academic calendar (term breaks), unit durations in half weeks, a batch's weekly sessions,
-- each course's batch timing from the SLIT master timetable, and the import of that timetable into the courses' units.
-- Additive: new tables and columns, functions replaced; data: seeded locations / rooms / upcoming breaks, course units' order,
-- weeks and hours (from the timetable), timing per batch. Past intakes in the workbook are not imported.

-- ------------------------------------------------------------------ 1. locations -> rooms (classrooms are the rooms)
create table if not exists public.locations (
 id uuid primary key default gen_random_uuid(),
 name text not null unique check (char_length(btrim(name)) between 1 and 120),
 address text check (address is null or char_length(address) <= 300),
 kind text not null default 'theory' check (kind in ('theory', 'practical')),
 sort integer not null default 0,
 is_active boolean not null default true,
 created_at timestamptz not null default now()
);
alter table public.classrooms add column if not exists location_id uuid references public.locations(id) on delete set null;
alter table public.classrooms add column if not exists sort integer not null default 0;

insert into public.locations(name, address, kind, sort) values
 ('King Street campus', 'Level 8, 310 King St, Melbourne VIC 3000', 'theory', 1),
 ('Automotive Workshop', '51 Brady St, South Melbourne VIC 3205', 'practical', 2),
 ('Carpentry, Painting and Cabinet Workshops', '271-273 Macaulay Rd, North Melbourne VIC 3051', 'practical', 3),
 ('Glass & Glazing Workshop', '181-183 Springvale Rd, Springvale VIC 3171', 'practical', 4),
 ('Springvale campus', '2A Brough St, Springvale VIC', 'practical', 5)
on conflict (name) do nothing;

-- Rooms; an existing classroom with the same name is kept and placed in its location.
with seed(name, location, sort) as (values
 ('Room 8.1', 'King Street campus', 1), ('Room 8.2', 'King Street campus', 2), ('Room 8.3', 'King Street campus', 3), ('Room 8.4', 'King Street campus', 4),
 ('Automotive Workshop', 'Automotive Workshop', 1),
 ('Carpentry Workshop', 'Carpentry, Painting and Cabinet Workshops', 1), ('Painting Workshop', 'Carpentry, Painting and Cabinet Workshops', 2),
 ('Cabinet Workshop', 'Carpentry, Painting and Cabinet Workshops', 3),
 ('Glass & Glazing Workshop', 'Glass & Glazing Workshop', 1),
 ('Springvale workshop', 'Springvale campus', 1))
update public.classrooms c set location_id = l.id, sort = s.sort, campus = coalesce(c.campus, l.name)
from seed s join public.locations l on l.name = s.location
where lower(btrim(c.name)) = lower(s.name) and c.location_id is null;
with seed(name, location, sort) as (values
 ('Room 8.1', 'King Street campus', 1), ('Room 8.2', 'King Street campus', 2), ('Room 8.3', 'King Street campus', 3), ('Room 8.4', 'King Street campus', 4),
 ('Automotive Workshop', 'Automotive Workshop', 1),
 ('Carpentry Workshop', 'Carpentry, Painting and Cabinet Workshops', 1), ('Painting Workshop', 'Carpentry, Painting and Cabinet Workshops', 2),
 ('Cabinet Workshop', 'Carpentry, Painting and Cabinet Workshops', 3),
 ('Glass & Glazing Workshop', 'Glass & Glazing Workshop', 1),
 ('Springvale workshop', 'Springvale campus', 1))
insert into public.classrooms(name, campus, location_id, sort)
select s.name, l.name, l.id, s.sort from seed s join public.locations l on l.name = s.location
where not exists (select 1 from public.classrooms c where lower(btrim(c.name)) = lower(s.name));

-- ------------------------------------------------------------------ 2. academic calendar: term breaks (public holidays: hr.public_holidays)
create table if not exists public.academic_breaks (
 id uuid primary key default gen_random_uuid(),
 label text not null check (char_length(btrim(label)) between 1 and 80),
 start_date date not null, end_date date not null,
 created_at timestamptz not null default now(),
 updated_by uuid default auth.uid(),
 check (end_date >= start_date)
);
-- SLIT's pattern in the master timetable (Victorian school holidays): about 4 weeks over summer and 2 weeks each around Easter,
-- in July and in late September. The upcoming ones, Monday to Sunday, as BSB80120 G1 (the sheet that runs furthest ahead) has them.
insert into public.academic_breaks(label, start_date, end_date)
select x.label, x.s::date, x.e::date from (values
 ('Summer break', '2026-12-21', '2027-01-17'),
 ('Term 1 break', '2027-03-22', '2027-04-04'),
 ('Term 2 break', '2027-07-05', '2027-07-18'),
 ('Term 3 break', '2027-09-27', '2027-10-10'),
 ('Summer break', '2027-12-20', '2028-01-16')) as x(label, s, e)
where not exists (select 1 from public.academic_breaks b where b.start_date <= x.e::date and b.end_date >= x.s::date);

-- A working day: Monday to Friday, not a confirmed public holiday, not in a term break.
create or replace function public.rto_is_working_day(p_day date) returns boolean
language sql stable security definer set search_path = public, hr as $$
 select extract(isodow from p_day) < 6
  and not exists(select 1 from hr.public_holidays h where h.holiday_date = p_day and h.status = 'confirmed' and not h.is_optional)
  and not exists(select 1 from public.academic_breaks b where p_day between b.start_date and b.end_date);
$$;

-- ------------------------------------------------------------------ 3. unit duration in weeks (half weeks allowed)
alter table public.cms_course_units add column if not exists duration_weeks numeric(5,1) check (duration_weeks is null or duration_weeks between 0.5 and 104);
update public.cms_course_units set duration_weeks = default_weeks where duration_weeks is null;
-- duration_weeks is the length; default_weeks (whole weeks, read by older code) follows it, and a write to default_weeks alone sets it.
create or replace function public.course_unit_weeks_sync() returns trigger
language plpgsql set search_path = public as $$
begin
 if tg_op = 'INSERT' then new.duration_weeks := coalesce(new.duration_weeks, new.default_weeks);
 elsif new.duration_weeks is distinct from old.duration_weeks then null;
 elsif new.default_weeks is distinct from old.default_weeks then new.duration_weeks := new.default_weeks;
 end if;
 new.default_weeks := least(104, greatest(1, ceil(coalesce(new.duration_weeks, new.default_weeks))))::integer;
 return new;
end $$;
drop trigger if exists course_unit_weeks_sync on public.cms_course_units;
create trigger course_unit_weeks_sync before insert or update on public.cms_course_units for each row execute function public.course_unit_weeks_sync();

-- ------------------------------------------------------------------ 4. a batch's weekly sessions
create table if not exists public.batch_sessions (
 id uuid primary key default gen_random_uuid(),
 batch_id uuid not null references public.batches(id) on delete cascade,
 weekday smallint not null check (weekday between 1 and 7), -- 1 Monday ... 7 Sunday
 slot text not null check (slot in ('morning', 'afternoon', 'evening')),
 start_time time not null, end_time time not null,
 session_type text not null default 'theory' check (session_type in ('theory', 'practical', 'assessment')),
 room_id uuid references public.classrooms(id) on delete set null,
 sort integer not null default 0,
 check (end_time > start_time)
);
create index if not exists batch_sessions_batch_idx on public.batch_sessions(batch_id, weekday, start_time);
create index if not exists batch_sessions_room_idx on public.batch_sessions(room_id, weekday);

-- ------------------------------------------------------------------ 5. each course's batch timing (from the master timetable)
create table if not exists public.course_timing_templates (
 id uuid primary key default gen_random_uuid(),
 course_id text not null references public.cms_courses(id) on delete cascade,
 name text not null check (char_length(btrim(name)) between 1 and 40),
 trainer_name text check (trainer_name is null or char_length(trainer_name) <= 120),
 trainer_staff_id uuid references hr.staff_profiles(id) on delete set null,
 sessions jsonb not null default '[]'::jsonb check (jsonb_typeof(sessions) = 'array'),
 source text check (source is null or char_length(source) <= 200),
 created_at timestamptz not null default now(),
 unique (course_id, name)
);

-- ------------------------------------------------------------------ RLS: staff read, RTO Managers write
do $rls$
declare t text;
begin
 foreach t in array array['locations', 'academic_breaks', 'batch_sessions', 'course_timing_templates'] loop
  execute format('alter table public.%I enable row level security', t);
  execute format('revoke all on public.%I from anon', t);
  execute format('drop policy if exists %I on public.%I', t || '_staff_read', t);
  execute format('create policy %I on public.%I for select to authenticated using (public.cms_is_staff())', t || '_staff_read', t);
  execute format('drop policy if exists %I on public.%I', t || '_rto_write', t);
  execute format('create policy %I on public.%I for all to authenticated using (public.cms_is_rto_manager()) with check (public.cms_is_rto_manager())', t || '_rto_write', t);
 end loop;
end $rls$;


-- ------------------------------------------------------------------ 6. the generator and rto_admin read / write half weeks

create or replace function public.intake_generate_schedule(p_intake uuid, p_start date, p_units text[], p_end date) returns date
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; u record; d date; days integer; n integer := 0; total integer := 0; per integer; extra integer; last_end date; k integer := 0; cnt integer;
begin
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
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
  -- a unit lasts its weeks (half weeks allowed) of working days; holidays and term breaks are skipped
  days := case when p_end is null then greatest(1, round(coalesce(u.duration_weeks, u.default_weeks) * 5)::integer) else per + case when n <= extra then 1 else 0 end end;
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

create or replace function public.rto_admin(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
 d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := nullif(d->>'courseId', ''); v_id uuid; i public.course_intakes; b public.batches;
 x jsonb; n integer := 0; v_keep text[] := '{}'; v_uid text; v_count integer; v_rto boolean := public.cms_is_rto_manager(); v_direct integer := 0;
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_action in ('course_save', 'units_save', 'fees_save', 'intake_save', 'schedule_save', 'intake_delete', 'intake_fees_save', 'batch_save', 'batch_delete', 'classroom_save')
    and not v_rto then
  raise exception 'Only an RTO Manager can change courses, intakes, schedules and batches.' using errcode = '42501';
 end if;
 if p_action in ('enrol', 'unenrol') and not (v_rto or public.cms_is_admin()) then
  raise exception 'Only an Admin or an RTO Manager can enrol students.' using errcode = '42501';
 end if;
 if p_action in ('set_rto_manager') and not (v_rto or public.cms_is_admin()) then
  raise exception 'Only an Admin or an RTO Manager can grant the RTO Manager permission.' using errcode = '42501';
 end if;

 if p_action = 'me' then
  return jsonb_build_object('rtoManager', v_rto, 'admin', public.cms_is_admin());

 elsif p_action = 'course_list' then
  return coalesce((select jsonb_agg(public.rto_course_json(c) order by c.display_order, c.name, c.variant_label) from public.cms_courses c where nullif(btrim(c.name), '') is not null), '[]'::jsonb);

 elsif p_action = 'course_get' then
  if not exists(select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return (select jsonb_build_object('course', public.rto_course_json(c),
   'units', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'code', u.code, 'name', u.name, 'unitType', u.unit_type, 'category', u.category,
      'defaultWeeks', coalesce(u.duration_weeks, u.default_weeks), 'nominalHours', u.nominal_hours, 'isActive', u.is_active,
      'scheduled', exists(select 1 from public.intake_units s where s.unit_id = u.id)) order by u.sort, u.code)
     from public.cms_course_units u where u.course_id = c.id), '[]'::jsonb),
   'fees', public.rto_fee_items_json(c.id, null),
   'intakes', coalesce((select jsonb_agg(public.rto_intake_json(ci) order by ci.start_date) from public.course_intakes ci where ci.course_id = c.id), '[]'::jsonb),
   'batches', coalesce((select jsonb_agg(public.rto_batch_json(bb) || jsonb_build_object('intakeName', public.rto_intake_json(ci)->>'name') order by ci.start_date, bb.name)
     from public.batches bb join public.course_intakes ci on ci.id = bb.intake_id where ci.course_id = c.id), '[]'::jsonb))
   from public.cms_courses c where c.id = v_course);

 elsif p_action = 'course_save' then
  update public.cms_courses set
   name = coalesce(nullif(btrim(d->>'name'), ''), name), code = coalesce(btrim(d->>'code'), code), cricos = coalesce(btrim(d->>'cricos'), cricos),
   category = coalesce(d->>'category', category), training_package = coalesce(d->>'trainingPackage', training_package),
   duration = coalesce(d->>'duration', duration), mode = coalesce(d->>'mode', mode),
   campus = case when d ? 'campus' then nullif(btrim(d->>'campus'), '') else campus end,
   tga_url = case when d ? 'tgaUrl' then nullif(btrim(d->>'tgaUrl'), '') else tga_url end,
   variant_label = case when d ? 'variantLabel' then nullif(btrim(d->>'variantLabel'), '') else variant_label end,
   is_active = coalesce((d->>'isActive')::boolean, is_active), updated_at = now()
  where id = v_course;
  if not found then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return public.rto_admin('course_get', jsonb_build_object('courseId', v_course));

 elsif p_action = 'website_save' then
  update public.cms_courses set
   show_fees = coalesce((d->>'showFees')::boolean, show_fees),
   fee_note = case when d ? 'feeNote' then nullif(btrim(d->>'feeNote'), '') else fee_note end,
   seo_title = case when d ? 'seoTitle' then nullif(btrim(d->>'seoTitle'), '') else seo_title end,
   seo_description = case when d ? 'seoDescription' then nullif(btrim(d->>'seoDescription'), '') else seo_description end,
   featured = coalesce((d->>'homepageCarousel')::boolean, featured),
   homepage_carousel = coalesce((d->>'homepageCarousel')::boolean, homepage_carousel), updated_at = now()
  where id = v_course;
  if not found then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return (select public.rto_course_json(c) from public.cms_courses c where c.id = v_course);

 elsif p_action = 'units_save' then
  if not exists(select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;
  for x in select value from jsonb_array_elements(coalesce(d->'units', '[]'::jsonb)) loop
   n := n + 1;
   if btrim(coalesce(x->>'code', '')) = '' or btrim(coalesce(x->>'name', '')) = '' then raise exception 'Each unit needs a code and a name.' using errcode = '22023'; end if;
   v_uid := nullif(x->>'id', '');
   if v_uid is not null and exists(select 1 from public.cms_course_units where id = v_uid and course_id = v_course) then
    update public.cms_course_units set code = btrim(x->>'code'), name = btrim(x->>'name'),
     unit_type = coalesce(nullif(x->>'unitType', ''), unit_type),
     category = case when coalesce(nullif(x->>'unitType', ''), unit_type) = 'elective' then (case when category ilike '%elective%' then category else 'Elective' end) else 'Core' end,
     duration_weeks = coalesce(nullif(x->>'defaultWeeks', '')::numeric, duration_weeks), nominal_hours = nullif(x->>'nominalHours', '')::integer,
     is_active = coalesce((x->>'isActive')::boolean, is_active), sort = n
    where id = v_uid;
   else
    v_uid := 'unit-' || replace(gen_random_uuid()::text, '-', '');
    insert into public.cms_course_units(id, course_id, code, name, category, sort, unit_type, duration_weeks, nominal_hours, is_active, tenant_id)
    select v_uid, v_course, btrim(x->>'code'), btrim(x->>'name'), case when x->>'unitType' = 'elective' then 'Elective' else 'Core' end, n,
     coalesce(nullif(x->>'unitType', ''), 'core'), coalesce(nullif(x->>'defaultWeeks', '')::numeric, 4), nullif(x->>'nominalHours', '')::integer,
     coalesce((x->>'isActive')::boolean, true), c.tenant_id
    from public.cms_courses c where c.id = v_course;
   end if;
   v_keep := v_keep || v_uid;
  end loop;
  update public.cms_course_units u set is_active = false where u.course_id = v_course and u.id <> all(v_keep) and exists(select 1 from public.intake_units s where s.unit_id = u.id);
  delete from public.cms_course_units u where u.course_id = v_course and u.id <> all(v_keep) and not exists(select 1 from public.intake_units s where s.unit_id = u.id);
  return public.rto_admin('course_get', jsonb_build_object('courseId', v_course));

 elsif p_action in ('fees_save', 'intake_fees_save') then
  v_id := nullif(d->>'intakeId', '')::uuid;
  if p_action = 'intake_fees_save' then
   select course_id into v_course from public.course_intakes where id = v_id;
   if v_course is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  elsif not exists(select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002';
  else v_id := null;
  end if;
  delete from public.course_fee_items where course_id = v_course and intake_id is not distinct from v_id;
  insert into public.course_fee_items(course_id, intake_id, item_type, label, amount_cents, sort, included_in_total, refundable, gst_treatment)
  select v_course, v_id, e.value->>'type', btrim(coalesce(e.value->>'label', '')), (e.value->>'amountCents')::bigint,
   public.course_fee_type_rank(e.value->>'type') * 100 + e.ordinality::integer,
   (e.value->>'includedInTotal')::boolean, (e.value->>'refundable')::boolean, coalesce(nullif(e.value->>'gstTreatment', ''), 'gst_free')
  from jsonb_array_elements(coalesce(d->'items', '[]'::jsonb)) with ordinality e;
  return case when p_action = 'fees_save' then public.rto_admin('course_get', jsonb_build_object('courseId', v_course))
              else public.rto_admin('intake_get', jsonb_build_object('intakeId', v_id)) end;

 elsif p_action = 'intake_list' then
  return coalesce((select jsonb_agg(public.rto_intake_json(ci) order by ci.start_date desc) from public.course_intakes ci), '[]'::jsonb);

 elsif p_action = 'intake_get' then
  select * into i from public.course_intakes where id = nullif(d->>'intakeId', '')::uuid;
  if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('intake', public.rto_intake_json(i),
   'schedule', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'unitId', s.unit_id, 'code', u.code, 'name', u.name, 'unitType', u.unit_type,
      'startDate', s.start_date, 'endDate', s.end_date, 'hours', s.hours) order by s.sort, s.start_date)
     from public.intake_units s join public.cms_course_units u on u.id = s.unit_id where s.intake_id = i.id), '[]'::jsonb),
   'batches', coalesce((select jsonb_agg(public.rto_batch_json(bb) order by bb.name) from public.batches bb where bb.intake_id = i.id), '[]'::jsonb),
   'fees', public.rto_fee_items_json(i.course_id, i.id),
   'courseFees', public.rto_fee_items_json(i.course_id, null));

 elsif p_action = 'intake_save' then
  v_id := nullif(d->>'id', '')::uuid;
  if v_id is null then
   if not exists(select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;
   if nullif(d->>'startDate', '') is null then raise exception 'Choose a start date.' using errcode = '22023'; end if;
   insert into public.course_intakes(course_id, start_date, end_date, name, campus, capacity, status, is_active, updated_by)
   values (v_course, (d->>'startDate')::date, nullif(d->>'endDate', '')::date, nullif(btrim(d->>'name'), ''), nullif(btrim(d->>'campus'), ''),
    nullif(d->>'capacity', '')::integer, coalesce(nullif(d->>'status', ''), 'draft'), coalesce(nullif(d->>'status', ''), 'draft') = 'open', auth.uid())
   returning id into v_id;
  else
   update public.course_intakes set
    start_date = coalesce(nullif(d->>'startDate', '')::date, start_date),
    end_date = case when d ? 'endDate' then nullif(d->>'endDate', '')::date else end_date end,
    name = case when d ? 'name' then nullif(btrim(d->>'name'), '') else name end,
    campus = case when d ? 'campus' then nullif(btrim(d->>'campus'), '') else campus end,
    capacity = case when d ? 'capacity' then nullif(d->>'capacity', '')::integer else capacity end,
    status = coalesce(nullif(d->>'status', ''), status), updated_at = now(), updated_by = auth.uid()
   where id = v_id;
   if not found then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  end if;
  if coalesce((d->>'generate')::boolean, false) then
   perform public.intake_generate_schedule(v_id, (select start_date from public.course_intakes where id = v_id),
    case when jsonb_typeof(d->'unitIds') = 'array' then array(select jsonb_array_elements_text(d->'unitIds')) end, nullif(d->>'fitEnd', '')::date);
  end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', v_id));

 elsif p_action = 'schedule_save' then
  v_id := nullif(d->>'intakeId', '')::uuid;
  if not exists(select 1 from public.course_intakes where id = v_id) then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  for x in select value from jsonb_array_elements(coalesce(d->'rows', '[]'::jsonb)) loop
   n := n + 1;
   update public.intake_units set start_date = (x->>'startDate')::date, end_date = (x->>'endDate')::date, hours = nullif(x->>'hours', '')::integer, sort = n
   where id = (x->>'id')::uuid and intake_id = v_id;
  end loop;
  update public.course_intakes ci set start_date = s.first_day, end_date = s.last_day, updated_at = now()
  from (select min(start_date) first_day, max(end_date) last_day from public.intake_units where intake_id = v_id) s
  where ci.id = v_id and s.first_day is not null;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', v_id));

 elsif p_action = 'intake_delete' then
  v_id := nullif(d->>'intakeId', '')::uuid;
  if exists(select 1 from public.batch_enrolments e join public.batches bb on bb.id = e.batch_id where bb.intake_id = v_id) then
   raise exception 'Students are enrolled in this intake. Close it instead.' using errcode = '23503';
  end if;
  if exists(select 1 from public.enrollment_application_courses where intake_id = v_id) then
   raise exception 'Applications use this intake. Close it instead.' using errcode = '23503';
  end if;
  delete from public.course_intakes where id = v_id;
  return jsonb_build_object('deleted', found);

 elsif p_action = 'batch_save' then
  v_id := nullif(d->>'id', '')::uuid;
  if v_id is null then
   insert into public.batches(intake_id, name, classroom_id, class_days, start_time, end_time, capacity, is_active)
   values ((d->>'intakeId')::uuid, btrim(d->>'name'), nullif(d->>'classroomId', '')::uuid,
    coalesce((select array_agg(value) from jsonb_array_elements_text(d->'classDays')), '{}'), nullif(d->>'startTime', '')::time, nullif(d->>'endTime', '')::time,
    nullif(d->>'capacity', '')::integer, coalesce((d->>'isActive')::boolean, true))
   returning * into b;
  else
   update public.batches set name = coalesce(nullif(btrim(d->>'name'), ''), name), classroom_id = nullif(d->>'classroomId', '')::uuid,
    class_days = coalesce((select array_agg(value) from jsonb_array_elements_text(d->'classDays')), '{}'),
    start_time = nullif(d->>'startTime', '')::time, end_time = nullif(d->>'endTime', '')::time,
    capacity = nullif(d->>'capacity', '')::integer, is_active = coalesce((d->>'isActive')::boolean, is_active)
   where id = v_id returning * into b;
   if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  end if;
  if d ? 'trainerIds' then
   delete from public.batch_trainers t where t.batch_id = b.id and t.staff_id::text not in (select jsonb_array_elements_text(d->'trainerIds'));
   insert into public.batch_trainers(batch_id, staff_id) select b.id, value::uuid from jsonb_array_elements_text(d->'trainerIds') on conflict do nothing;
  end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.intake_id));

 elsif p_action = 'batch_delete' then
  select * into b from public.batches where id = nullif(d->>'batchId', '')::uuid;
  if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  if exists(select 1 from public.batch_enrolments where batch_id = b.id and status in ('active', 'deferred', 'completed')) then
   raise exception 'Students are enrolled in this batch. Make it inactive instead.' using errcode = '23503';
  end if;
  delete from public.batches where id = b.id;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.intake_id));

 elsif p_action = 'enrol' then
  select * into b from public.batches where id = nullif(d->>'batchId', '')::uuid;
  if b.id is null then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  select * into i from public.course_intakes where id = b.intake_id;
  for x in select value from jsonb_array_elements(coalesce(d->'students', '[]'::jsonb)) loop
   if not public.rto_student_on_course((x->>'id')::uuid, i.course_id) then
    -- RTO Managers may enrol anyone: the student gets a draft application marked "direct enrolment". Admins keep the application rule.
    if not v_rto then raise exception 'A selected student has no application for this course.' using errcode = '22023'; end if;
    perform public.rto_direct_application((x->>'id')::uuid, i.id);
    v_direct := v_direct + 1;
   end if;
   insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status)
   values (b.id, (x->>'id')::uuid, coalesce(nullif(x->>'type', ''), 'CoE'), 'active')
   on conflict (batch_id, student_id) do update set enrolment_type = excluded.enrolment_type, status = 'active';
  end loop;
  select count(*) into v_count from public.batch_enrolments where batch_id = b.id and status in ('active', 'deferred');
  if b.capacity is not null and v_count > b.capacity then raise exception 'This batch is full (% places).', b.capacity using errcode = '23514'; end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.intake_id)) || jsonb_build_object('directApplications', v_direct);

 elsif p_action = 'unenrol' then
  update public.batch_enrolments e set status = 'withdrawn' where e.id = nullif(d->>'enrolmentId', '')::uuid returning (select intake_id from public.batches where id = e.batch_id) into v_id;
  if v_id is null then raise exception 'Enrolment not found' using errcode = 'P0002'; end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', v_id));

 elsif p_action = 'classroom_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'campus', r.campus, 'capacity', r.capacity, 'isActive', r.is_active) order by r.name) from public.classrooms r), '[]'::jsonb);

 elsif p_action = 'classroom_save' then
  v_id := nullif(d->>'id', '')::uuid;
  if v_id is null then
   insert into public.classrooms(name, campus, capacity, is_active) values (btrim(d->>'name'), nullif(btrim(d->>'campus'), ''), nullif(d->>'capacity', '')::integer, coalesce((d->>'isActive')::boolean, true));
  else
   update public.classrooms set name = coalesce(nullif(btrim(d->>'name'), ''), name), campus = nullif(btrim(d->>'campus'), ''), capacity = nullif(d->>'capacity', '')::integer,
    is_active = coalesce((d->>'isActive')::boolean, is_active) where id = v_id;
  end if;
  return public.rto_admin('classroom_list', '{}'::jsonb);

 elsif p_action = 'staff_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name), 'email', s.email) order by s.first_name, s.last_name)
   from hr.staff_profiles s where s.status = 'active'), '[]'::jsonb);

 elsif p_action = 'student_search' then
  -- Students on the course; an RTO Manager may also ask for every student ("all"): those without an application are marked.
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.full_name, 'email', s.email, 'linked', s.linked) order by s.linked desc, s.full_name)
   from (select st.*, public.rto_student_on_course(st.id, v_course) linked from public.enrollment_students st
         where st.status = 'Active'
           and (public.rto_student_on_course(st.id, v_course) or (v_rto and coalesce((d->>'all')::boolean, false)))
           and (coalesce(d->>'q', '') = '' or st.full_name ilike '%' || (d->>'q') || '%' or st.email ilike '%' || (d->>'q') || '%')
         order by st.full_name limit 50) s), '[]'::jsonb);

 elsif p_action = 'student_studies' then
  v_id := nullif(d->>'studentId', '')::uuid;
  return jsonb_build_object(
   'enrolments', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'type', e.enrolment_type, 'status', e.status, 'enrolledOn', e.enrolled_on,
      'batchId', bb.id, 'batch', bb.name, 'intakeId', ci.id, 'intake', public.rto_intake_json(ci)->>'name', 'startDate', ci.start_date, 'endDate', ci.end_date,
      'courseId', c.id, 'course', public.course_name_variant(c.code, c.name, c.variant_label), 'courseCode', c.code) order by ci.start_date desc)
     from public.batch_enrolments e join public.batches bb on bb.id = e.batch_id join public.course_intakes ci on ci.id = bb.intake_id join public.cms_courses c on c.id = ci.course_id
     where e.student_id = v_id), '[]'::jsonb),
   'options', coalesce((select jsonb_agg(jsonb_build_object('courseId', c.id, 'course', public.course_name_variant(c.code, c.name, c.variant_label), 'courseCode', c.code,
      'linked', public.rto_student_on_course(v_id, c.id),
      'intakes', coalesce((select jsonb_agg(jsonb_build_object('id', ci.id, 'name', public.rto_intake_json(ci)->>'name', 'status', ci.status,
          'batches', coalesce((select jsonb_agg(jsonb_build_object('id', bb.id, 'name', bb.name)) from public.batches bb where bb.intake_id = ci.id and bb.is_active), '[]'::jsonb))
        order by ci.start_date) from public.course_intakes ci where ci.course_id = c.id and ci.status in ('open', 'full', 'draft')), '[]'::jsonb))
      order by c.code, c.name, c.variant_label)
     from public.cms_courses c where public.rto_student_on_course(v_id, c.id) or (v_rto and c.is_active and nullif(btrim(c.name), '') is not null)), '[]'::jsonb));

 elsif p_action = 'rto_role_get' then
  return (select jsonb_build_object('rtoManager', u.rto_manager, 'canManage', v_rto or public.cms_is_admin()) from public.cms_users u where u.id = d->>'userId');

 elsif p_action = 'set_rto_manager' then
  if not coalesce((d->>'value')::boolean, false)
     and not exists(select 1 from public.cms_users where rto_manager and status = 'Active' and id <> d->>'userId') then
   raise exception 'At least one active RTO Manager must remain.' using errcode = '23514';
  end if;
  update public.cms_users set rto_manager = coalesce((d->>'value')::boolean, false) where id = d->>'userId';
  if not found then raise exception 'User not found' using errcode = 'P0002'; end if;
  return public.rto_admin('rto_role_get', jsonb_build_object('userId', d->>'userId'));

 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $$;
revoke all on function public.rto_admin(text, jsonb) from public, anon;
grant execute on function public.rto_admin(text, jsonb) to authenticated;

-- ------------------------------------------------------------------ 7. import: SLIT master timetable (MASTER TIMETABLE_SLIT.xlsx, 13 Nov 2026)
-- Each course's units: order, weeks and hours from the first full cycle of its G1 sheet (a week shared by two units is split by
-- their sessions; 4 hours a session). Units of the course that are not in the sheet keep their data and move after. Timing per
-- batch: the most common week of each sheet (days, times, theory / practical / assessment, room). Trainers are linked only when
-- exactly one staff record has the name.


-- AUR30620 from sheet AUR30620_G1
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('AURLTE102', 1, 1.5, 28),
 ('AURETR131', 2, 1.0, 24),
 ('AURLTD104', 3, 1.5, 32),
 ('AURLTD105', 4, 1.5, 32),
 ('AURLTZ101', 5, 1.5, 28),
 ('AURTTA104', 6, 1.0, 24),
 ('AURLTD106', 7, 1.0, 24),
 ('AURETR143', 8, 1.5, 28),
 ('AURLTJ102', 9, 2.0, 28),
 ('AURTTA017', 10, 1.0, 24),
 ('AURTTB015', 11, 1.0, 24),
 ('AURTTC001', 12, 1.0, 24),
 ('AURTTD002', 13, 1.0, 24),
 ('AURTTZ102', 14, 1.0, 24),
 ('AURTTK102', 15, 1.0, 20),
 ('AURAFA103', 16, 1.5, 32),
 ('AURETD101', 17, 1.5, 28),
 ('AURETR010', 18, 1.5, 28),
 ('AURETR011', 19, 1.0, 24),
 ('AURETR120', 20, 1.5, 32),
 ('AURETR122', 21, 1.5, 28),
 ('AURETR128', 22, 1.5, 28),
 ('AURTTE104', 23, 2.0, 40),
 ('AURTTA118', 24, 2.0, 40),
 ('AURTTB101', 25, 2.0, 40),
 ('AURTTC103', 26, 2.0, 40),
 ('AURTTF101', 27, 2.0, 40),
 ('AURLTB103', 28, 1.5, 32),
 ('AURACA101', 29, 1.0, 20),
 ('AURAEA002', 30, 1.5, 32),
 ('AURASA102', 31, 1.5, 32),
 ('AURETR112', 32, 1.5, 32),
 ('AURETR123', 33, 1.5, 28),
 ('AURETR125', 34, 1.5, 32),
 ('AURETR129', 35, 1.0, 24),
 ('AURETR130', 36, 0.5, 12)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'AUR30620' and coalesce(variant_label, '') = '' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'AUR30620' and coalesce(variant_label, '') = '' order by id limit 1) and u.code not in ('AURLTE102', 'AURETR131', 'AURLTD104', 'AURLTD105', 'AURLTZ101', 'AURTTA104', 'AURLTD106', 'AURETR143', 'AURLTJ102', 'AURTTA017', 'AURTTB015', 'AURTTC001', 'AURTTD002', 'AURTTZ102', 'AURTTK102', 'AURAFA103', 'AURETD101', 'AURETR010', 'AURETR011', 'AURETR120', 'AURETR122', 'AURETR128', 'AURTTE104', 'AURTTA118', 'AURTTB101', 'AURTTC103', 'AURTTF101', 'AURLTB103', 'AURACA101', 'AURAEA002', 'AURASA102', 'AURETR112', 'AURETR123', 'AURETR125', 'AURETR129', 'AURETR130') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'AUR30620' and coalesce(variant_label, '') = '' order by id limit 1), 'G1', 'Shaminder Grewal', null, jsonb_build_array(
  jsonb_build_object('weekday', 1, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.3' order by id limit 1)),
  jsonb_build_object('weekday', 1, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.3' order by id limit 1)),
  jsonb_build_object('weekday', 5, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Automotive Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 5, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Automotive Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'assessment', 'roomId', (select id from public.classrooms where name = 'Room 8.3' order by id limit 1))), 'SLIT master timetable, sheet AUR30620_G1'
where (select id from public.cms_courses where code = 'AUR30620' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'AUR30620' and coalesce(variant_label, '') = '' order by id limit 1), 'G2', 'Shaminder Grewal', null, jsonb_build_array(
  jsonb_build_object('weekday', 1, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.3' order by id limit 1)),
  jsonb_build_object('weekday', 1, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.3' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Automotive Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Automotive Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'assessment', 'roomId', (select id from public.classrooms where name = 'Room 8.3' order by id limit 1))), 'SLIT master timetable, sheet AUR30620_G2'
where (select id from public.cms_courses where code = 'AUR30620' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- AUR40216 from sheet AUR40216
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('AURLTD109', 1, 3.0, 60),
 ('AURLTX104', 2, 3.0, 60),
 ('AURMTF002', 3, 2.0, 40),
 ('AURMTQ001', 4, 2.0, 40),
 ('AURTTA021', 5, 5.0, 100),
 ('AURLTE104', 6, 3.0, 60),
 ('AURTTA125', 7, 3.0, 60),
 ('BSBOPS305', 8, 2.0, 40),
 ('AURTTR101', 9, 4.0, 80),
 ('AURETR037', 10, 3.0, 60)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'AUR40216' and coalesce(variant_label, '') = '' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'AUR40216' and coalesce(variant_label, '') = '' order by id limit 1) and u.code not in ('AURLTD109', 'AURLTX104', 'AURMTF002', 'AURMTQ001', 'AURTTA021', 'AURLTE104', 'AURTTA125', 'BSBOPS305', 'AURTTR101', 'AURETR037') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'AUR40216' and coalesce(variant_label, '') = '' order by id limit 1), 'G1', 'Behzad Aziz', null, jsonb_build_array(
  jsonb_build_object('weekday', 5, 'slot', 'afternoon', 'start', '12:30', 'end', '16:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 5, 'slot', 'evening', 'start', '17:30', 'end', '21:30', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Automotive Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'afternoon', 'start', '12:30', 'end', '16:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '17:30', 'end', '21:30', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Automotive Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'afternoon', 'start', '12:30', 'end', '16:30', 'type', 'assessment', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1))), 'SLIT master timetable, sheet AUR40216'
where (select id from public.cms_courses where code = 'AUR40216' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- BSB80120 from sheet BSB80120_G1
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('BSBOPS601', 1, 5.0, 100),
 ('BSBLDR811', 2, 5.0, 100),
 ('BSBSTR801', 3, 5.0, 100),
 ('BSBHRM613', 4, 5.0, 100),
 ('TAELED803', 5, 5.0, 100),
 ('BSBLDR601', 6, 5.0, 100),
 ('BSBHRM611', 7, 5.0, 100),
 ('BSBCRT611', 8, 5.0, 100)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'BSB80120' and coalesce(variant_label, '') = '' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'BSB80120' and coalesce(variant_label, '') = '' order by id limit 1) and u.code not in ('BSBOPS601', 'BSBLDR811', 'BSBSTR801', 'BSBHRM613', 'TAELED803', 'BSBLDR601', 'BSBHRM611', 'BSBCRT611') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'BSB80120' and coalesce(variant_label, '') = '' order by id limit 1), 'G1', 'Hardik Amin', null, jsonb_build_array(
  jsonb_build_object('weekday', 1, 'slot', 'afternoon', 'start', '12:00', 'end', '16:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 1, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 2, 'slot', 'afternoon', 'start', '12:00', 'end', '16:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 2, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 3, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'assessment', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1))), 'SLIT master timetable, sheet BSB80120_G1'
where (select id from public.cms_courses where code = 'BSB80120' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'BSB80120' and coalesce(variant_label, '') = '' order by id limit 1), 'G2', 'Mehul Patel', null, jsonb_build_array(
  jsonb_build_object('weekday', 1, 'slot', 'afternoon', 'start', '12:00', 'end', '16:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 1, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 2, 'slot', 'afternoon', 'start', '12:00', 'end', '16:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 2, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 3, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'assessment', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1))), 'SLIT master timetable, sheet BSB80120_G2'
where (select id from public.cms_courses where code = 'BSB80120' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- CPC30220 from sheet CPC30220
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('CPCCCM3005', 1, 1.0, 20),
 ('CPCCOM1012', 2, 1.0, 20),
 ('CPCCOM1013', 3, 1.0, 20),
 ('CPCCOM1014', 4, 1.0, 20),
 ('CPCCOM1015', 5, 1.0, 20),
 ('CPCCCM3001', 6, 1.0, 20),
 ('CPCCWHS2001', 7, 1.0, 20),
 ('CPCCCM2008', 8, 1.0, 20),
 ('CPCCCM2012', 9, 1.0, 20),
 ('CPCCCA3007', 10, 2.0, 40),
 ('CPCCCA2002', 11, 1.0, 20),
 ('CPCCCA3002', 12, 1.0, 20),
 ('CPCCCA3017', 13, 1.0, 20),
 ('CPCCCA3028', 14, 1.0, 20),
 ('CPCCCA3001', 15, 2.0, 40),
 ('CPCCCA3010', 16, 3.0, 60),
 ('CPCCCA3006', 17, 1.0, 20),
 ('CPCCCA3016', 18, 2.0, 40),
 ('CPCCCO2013', 19, 1.0, 20),
 ('CPCCCA3024', 20, 1.0, 20),
 ('CPCCCA3025', 21, 2.0, 40),
 ('CPCCCA3008', 22, 2.0, 32),
 ('CPCCCA2011', 23, 1.0, 16),
 ('CPCCCA3012', 24, 2.0, 24),
 ('CPCCCA3014', 25, 2.0, 40),
 ('CPCCSF2004', 26, 3.0, 60),
 ('CPCCCA3003', 27, 2.0, 40),
 ('CPCCCA3005', 28, 2.0, 24),
 ('CPCCCA3004', 29, 3.0, 36),
 ('CPCCCM2002', 30, 1.0, 8),
 ('CPCCOM3001', 31, 2.0, 36),
 ('CPCCCM2006', 32, 1.0, 20),
 ('CPCCOM3006', 33, 1.0, 20),
 ('CPCWHS3001', 34, 1.0, 20)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'CPC30220' and coalesce(variant_label, '') = '' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'CPC30220' and coalesce(variant_label, '') = '' order by id limit 1) and u.code not in ('CPCCCM3005', 'CPCCOM1012', 'CPCCOM1013', 'CPCCOM1014', 'CPCCOM1015', 'CPCCCM3001', 'CPCCWHS2001', 'CPCCCM2008', 'CPCCCM2012', 'CPCCCA3007', 'CPCCCA2002', 'CPCCCA3002', 'CPCCCA3017', 'CPCCCA3028', 'CPCCCA3001', 'CPCCCA3010', 'CPCCCA3006', 'CPCCCA3016', 'CPCCCO2013', 'CPCCCA3024', 'CPCCCA3025', 'CPCCCA3008', 'CPCCCA2011', 'CPCCCA3012', 'CPCCCA3014', 'CPCCSF2004', 'CPCCCA3003', 'CPCCCA3005', 'CPCCCA3004', 'CPCCCM2002', 'CPCCOM3001', 'CPCCCM2006', 'CPCCOM3006', 'CPCWHS3001') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'CPC30220' and coalesce(variant_label, '') = '' order by id limit 1), 'G1', null, null, jsonb_build_array(
  jsonb_build_object('weekday', 4, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 4, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '17:00', 'end', '21:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '13:00', 'end', '17:00', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Carpentry Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'evening', 'start', '17:00', 'end', '21:00', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Carpentry Workshop' order by id limit 1))), 'SLIT master timetable, sheet CPC30220'
where (select id from public.cms_courses where code = 'CPC30220' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- CPC30620 from sheet CPC30620
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('CPCCCM3005', 1, 1.0, 20),
 ('CPCCOM1012', 2, 1.0, 20),
 ('CPCCOM1013', 3, 1.0, 20),
 ('CPCCOM1014', 4, 1.0, 20),
 ('CPCCOM1015', 5, 1.0, 20),
 ('CPCCCM3001', 6, 1.0, 20),
 ('CPCCWHS2001', 7, 1.0, 20),
 ('CPCCCM2008', 8, 1.0, 20),
 ('CPCCCM2012', 9, 1.0, 20),
 ('CPCCPD3035', 10, 2.0, 36),
 ('CPCCPB3026', 11, 2.0, 32),
 ('CPCCPD2011', 12, 2.0, 32),
 ('CPCCPD2012', 13, 2.0, 32),
 ('CPCCOM2001', 14, 1.0, 16),
 ('CPCCPD2013', 15, 2.0, 24),
 ('CPCCPD3021', 16, 2.0, 32),
 ('CPCCPD3022', 17, 2.0, 32),
 ('CPCCPD3023', 18, 2.0, 32),
 ('CPCCPD3024', 19, 2.0, 32),
 ('CPCCPD3025', 20, 2.0, 32),
 ('CPCCPD3026', 21, 2.0, 32),
 ('CPCCPD3027', 22, 2.0, 32),
 ('CPCCPD3028', 23, 2.0, 32),
 ('CPCCPD3029', 24, 3.0, 48),
 ('CPCCPD3030', 25, 2.0, 32),
 ('CPCCPD3031', 26, 2.0, 32),
 ('CPCCPD3034', 27, 3.0, 48),
 ('CPCCPD3036', 28, 2.0, 32),
 ('BSBESB301', 29, 2.0, 32)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'CPC30620' and coalesce(variant_label, '') = '' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'CPC30620' and coalesce(variant_label, '') = '' order by id limit 1) and u.code not in ('CPCCCM3005', 'CPCCOM1012', 'CPCCOM1013', 'CPCCOM1014', 'CPCCOM1015', 'CPCCCM3001', 'CPCCWHS2001', 'CPCCCM2008', 'CPCCCM2012', 'CPCCPD3035', 'CPCCPB3026', 'CPCCPD2011', 'CPCCPD2012', 'CPCCOM2001', 'CPCCPD2013', 'CPCCPD3021', 'CPCCPD3022', 'CPCCPD3023', 'CPCCPD3024', 'CPCCPD3025', 'CPCCPD3026', 'CPCCPD3027', 'CPCCPD3028', 'CPCCPD3029', 'CPCCPD3030', 'CPCCPD3031', 'CPCCPD3034', 'CPCCPD3036', 'BSBESB301') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'CPC30620' and coalesce(variant_label, '') = '' order by id limit 1), 'G1', null, null, jsonb_build_array(
  jsonb_build_object('weekday', 4, 'slot', 'evening', 'start', '17:00', 'end', '21:00', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Painting Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'morning', 'start', '13:00', 'end', '17:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '17:00', 'end', '21:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '13:00', 'end', '17:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1))), 'SLIT master timetable, sheet CPC30620'
where (select id from public.cms_courses where code = 'CPC30620' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- MSF30322 from sheet MSF30322
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('CPCCWHS2001', 1, 1.0, 16),
 ('MSMENV272', 2, 2.0, 32),
 ('MSMSUP102', 3, 2.0, 32),
 ('MSMSUP106', 4, 2.0, 32),
 ('BSBOPS304', 5, 2.0, 32),
 ('MSFGN2001', 6, 2.0, 24),
 ('MSFGN3005', 7, 1.0, 16),
 ('MSFFM3030', 8, 2.0, 32),
 ('MSFFM3031', 9, 1.0, 16),
 ('MSFFM3029', 10, 1.0, 16),
 ('MSFFM2013', 11, 1.0, 16),
 ('MSFFM2018', 12, 1.0, 16),
 ('MSFFM2017', 13, 2.0, 32),
 ('MSFFM2016', 14, 2.0, 32),
 ('MSFFM3042', 15, 2.0, 32),
 ('MSFFM3041', 16, 1.0, 16),
 ('CPCCJN3003', 17, 2.0, 32),
 ('CPCCCA3014', 18, 2.0, 32),
 ('CPCCPB3004', 19, 2.0, 32),
 ('CPCCWC3004', 20, 2.0, 32),
 ('MSFFL2038', 21, 2.0, 32),
 ('CPCSHP3005', 22, 2.0, 32),
 ('MSFCP3001', 23, 2.0, 32),
 ('MSMOPS363', 24, 2.0, 32)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'MSF30322' and coalesce(variant_label, '') = '' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'MSF30322' and coalesce(variant_label, '') = '' order by id limit 1) and u.code not in ('CPCCWHS2001', 'MSMENV272', 'MSMSUP102', 'MSMSUP106', 'BSBOPS304', 'MSFGN2001', 'MSFGN3005', 'MSFFM3030', 'MSFFM3031', 'MSFFM3029', 'MSFFM2013', 'MSFFM2018', 'MSFFM2017', 'MSFFM2016', 'MSFFM3042', 'MSFFM3041', 'CPCCJN3003', 'CPCCCA3014', 'CPCCPB3004', 'CPCCWC3004', 'MSFFL2038', 'CPCSHP3005', 'MSFCP3001', 'MSMOPS363') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'MSF30322' and coalesce(variant_label, '') = '' order by id limit 1), 'G1', null, null, jsonb_build_array(
  jsonb_build_object('weekday', 4, 'slot', 'evening', 'start', '17:00', 'end', '21:00', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Glass & Glazing Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '17:00', 'end', '21:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1))), 'SLIT master timetable, sheet MSF30322'
where (select id from public.cms_courses where code = 'MSF30322' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- MSF30422 from sheet MSF30422
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('CPCWHS1001', 1, 1.0, 16),
 ('CPCCWHS2001', 2, 1.0, 16),
 ('HLTAID011', 3, 1.0, 16),
 ('MSMSUP102', 4, 2.0, 32),
 ('MSMSUP106', 5, 2.0, 32),
 ('MSMENV272', 6, 2.0, 32),
 ('MSFGN3001', 7, 2.0, 24),
 ('MSFGN2001', 8, 2.0, 32),
 ('MSFGG3039', 9, 2.0, 32),
 ('MSFGG2013', 10, 2.0, 32),
 ('MSFGG2014', 11, 2.0, 32),
 ('MSFGG2015', 12, 2.0, 32),
 ('MSFGG2016', 13, 2.0, 32),
 ('MSFGG2011', 14, 2.0, 32),
 ('MSFGG3034', 15, 2.0, 32),
 ('MSFGG3033', 16, 2.0, 32),
 ('CPCCCM2006', 17, 2.0, 32),
 ('CPCCCM2010', 18, 2.0, 32),
 ('MSFGG3036', 19, 2.0, 32),
 ('MSFGG3029', 20, 2.0, 32),
 ('MSFGN3006', 21, 2.0, 32),
 ('MSFGG4019', 22, 2.0, 32),
 ('BSBWHS411', 23, 1.0, 16)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'MSF30422' and coalesce(variant_label, '') = '' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'MSF30422' and coalesce(variant_label, '') = '' order by id limit 1) and u.code not in ('CPCWHS1001', 'CPCCWHS2001', 'HLTAID011', 'MSMSUP102', 'MSMSUP106', 'MSMENV272', 'MSFGN3001', 'MSFGN2001', 'MSFGG3039', 'MSFGG2013', 'MSFGG2014', 'MSFGG2015', 'MSFGG2016', 'MSFGG2011', 'MSFGG3034', 'MSFGG3033', 'CPCCCM2006', 'CPCCCM2010', 'MSFGG3036', 'MSFGG3029', 'MSFGN3006', 'MSFGG4019', 'BSBWHS411') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'MSF30422' and coalesce(variant_label, '') = '' order by id limit 1), 'G1', null, null, jsonb_build_array(
  jsonb_build_object('weekday', 2, 'slot', 'evening', 'start', '17:00', 'end', '21:00', 'type', 'practical', 'roomId', (select id from public.classrooms where name = 'Glass & Glazing Workshop' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '17:00', 'end', '21:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.1' order by id limit 1))), 'SLIT master timetable, sheet MSF30422'
where (select id from public.cms_courses where code = 'MSF30422' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- RII50520 from sheet RII50520_G1
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('CPPBDN6106', 1, 2.0, 40),
 ('CPPCOM4001', 2, 2.0, 40),
 ('RIICWD501E', 3, 4.0, 80),
 ('RIICWD505E', 4, 3.0, 60),
 ('RIICWD518E', 5, 3.0, 60),
 ('RIICWD525E', 6, 3.0, 60),
 ('RIICWD527E', 7, 4.0, 72),
 ('BSBPMG537', 8, 3.0, 60),
 ('BSBINS501', 9, 2.0, 40),
 ('RIILAT402E', 10, 2.0, 40),
 ('BSBSTR601', 11, 4.0, 80)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'RII50520' and coalesce(variant_label, '') = '' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'RII50520' and coalesce(variant_label, '') = '' order by id limit 1) and u.code not in ('CPPBDN6106', 'CPPCOM4001', 'RIICWD501E', 'RIICWD505E', 'RIICWD518E', 'RIICWD525E', 'RIICWD527E', 'BSBPMG537', 'BSBINS501', 'RIILAT402E', 'BSBSTR601') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'RII50520' and coalesce(variant_label, '') = '' order by id limit 1), 'G1', 'Aalap Nayak', null, jsonb_build_array(
  jsonb_build_object('weekday', 5, 'slot', 'evening', 'start', '16:00', 'end', '20:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'morning', 'start', '12:00', 'end', '16:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1))), 'SLIT master timetable, sheet RII50520_G1'
where (select id from public.cms_courses where code = 'RII50520' and coalesce(variant_label, '') = '' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- RII60520 (104 Weeks) from sheet RII60520_G1
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('BSBWHS616', 1, 5.0, 100),
 ('BSBSTR601', 2, 5.0, 100),
 ('BSBPMG530', 3, 5.0, 100),
 ('RIILAT402E', 4, 5.0, 96),
 ('RIICWD601E', 5, 10.0, 200),
 ('RIIQUA601E', 6, 10.0, 200),
 ('RIICWD533E', 7, 10.0, 200),
 ('RIICWD534E', 8, 2.0, 40),
 ('BSBOPS601', 9, 5.0, 100),
 ('BSBPMG632', 10, 5.0, 100),
 ('BSBTWK502', 11, 5.0, 100)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '104 Weeks' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '104 Weeks' order by id limit 1) and u.code not in ('BSBWHS616', 'BSBSTR601', 'BSBPMG530', 'RIILAT402E', 'RIICWD601E', 'RIIQUA601E', 'RIICWD533E', 'RIICWD534E', 'BSBOPS601', 'BSBPMG632', 'BSBTWK502') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '104 Weeks' order by id limit 1), 'G1', 'Aalap Nayak', null, jsonb_build_array(
  jsonb_build_object('weekday', 5, 'slot', 'evening', 'start', '16:00', 'end', '20:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'morning', 'start', '12:00', 'end', '16:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1))), 'SLIT master timetable, sheet RII60520_G1'
where (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '104 Weeks' order by id limit 1) is not null
on conflict (course_id, name) do nothing;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '104 Weeks' order by id limit 1), 'G2', 'Hardik Amin', null, jsonb_build_array(
  jsonb_build_object('weekday', 5, 'slot', 'evening', 'start', '16:00', 'end', '20:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'morning', 'start', '12:00', 'end', '16:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.4' order by id limit 1))), 'SLIT master timetable, sheet RII60520_G2'
where (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '104 Weeks' order by id limit 1) is not null
on conflict (course_id, name) do nothing;

-- RII60520 (52 Weeks) from sheet RII60520_Package_2_
update public.cms_course_units u set sort = v.sort, duration_weeks = v.weeks, nominal_hours = v.hours
from (values
 ('RIIQUA601E', 1, 2.0, 40),
 ('RIICWD533E', 2, 4.0, 80),
 ('RIICWD507D', 3, 4.0, 80),
 ('RIICWD509E', 4, 4.0, 80),
 ('RIICWD526E', 5, 4.0, 80),
 ('BSBPMG531', 6, 2.0, 40),
 ('BSBPMG632', 7, 2.0, 40),
 ('BSBWHS616', 8, 2.0, 40),
 ('BSBTWK502', 9, 3.0, 60),
 ('RIICWD601E', 10, 8.0, 160)
) as v(code, sort, weeks, hours)
where u.course_id = (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '52 Weeks' order by id limit 1) and u.code = v.code;
update public.cms_course_units u set sort = 1000 + u.sort where u.course_id = (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '52 Weeks' order by id limit 1) and u.code not in ('RIIQUA601E', 'RIICWD533E', 'RIICWD507D', 'RIICWD509E', 'RIICWD526E', 'BSBPMG531', 'BSBPMG632', 'BSBWHS616', 'BSBTWK502', 'RIICWD601E') and u.sort < 1000;
insert into public.course_timing_templates(course_id, name, trainer_name, trainer_staff_id, sessions, source)
select (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '52 Weeks' order by id limit 1), 'G1', 'Aalap Nayak', null, jsonb_build_array(
  jsonb_build_object('weekday', 5, 'slot', 'evening', 'start', '16:00', 'end', '20:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'morning', 'start', '12:00', 'end', '16:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 6, 'slot', 'evening', 'start', '16:30', 'end', '20:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'morning', 'start', '09:00', 'end', '13:00', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1)),
  jsonb_build_object('weekday', 7, 'slot', 'evening', 'start', '13:30', 'end', '17:30', 'type', 'theory', 'roomId', (select id from public.classrooms where name = 'Room 8.2' order by id limit 1))), 'SLIT master timetable, sheet RII60520_Package_2_'
where (select id from public.cms_courses where code = 'RII60520' and coalesce(variant_label, '') = '52 Weeks' order by id limit 1) is not null
on conflict (course_id, name) do nothing;
