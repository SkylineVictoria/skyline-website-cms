-- COURSE-MGMT: one course record (cms_courses) with units, fee line items, intakes (= master timetable) with a unit schedule,
-- classrooms, batches, trainers and student enrolments. Additive only: no table or column is dropped and no row is deleted.
-- The old website columns (cms_courses.fees text) stay in place but are no longer the source of fees.

-- ------------------------------------------------------------------ roles
-- RTO Manager is a permission on a CMS user (the existing roles stay Admin / Editor). Every current Admin gets it, so nobody who
-- edits courses today is locked out; an Admin can take it away again.
alter table public.cms_users add column if not exists rto_manager boolean not null default false;
update public.cms_users set rto_manager = true where role = 'Admin' and not rto_manager;

create or replace function public.cms_is_rto_manager() returns boolean
language sql stable security definer set search_path = public as $$
 select auth.uid() is not null and exists(select 1 from public.cms_users where auth_user_id = auth.uid() and status = 'Active' and not must_change_password and rto_manager);
$$;
revoke all on function public.cms_is_rto_manager() from public, anon;
grant execute on function public.cms_is_rto_manager() to authenticated;

-- ------------------------------------------------------------------ course facts and website settings
alter table public.cms_courses
 add column if not exists tga_url text check (tga_url is null or tga_url ~* '^https://[^\s<>"]{3,255}$'),
 add column if not exists campus text check (campus is null or char_length(campus) <= 200),
 add column if not exists is_active boolean not null default true,
 add column if not exists show_fees boolean not null default true,
 add column if not exists fee_note text check (fee_note is null or char_length(fee_note) <= 1000),
 add column if not exists seo_title text check (seo_title is null or char_length(seo_title) <= 120),
 add column if not exists seo_description text check (seo_description is null or char_length(seo_description) <= 320),
 add column if not exists homepage_carousel boolean not null default false;
update public.cms_courses set tga_url = 'https://training.gov.au/Training/Details/' || btrim(code)
 where tga_url is null and btrim(coalesce(code, '')) ~ '^[A-Za-z0-9]{4,20}$';
update public.cms_courses set homepage_carousel = true where featured and not homepage_carousel;

-- ------------------------------------------------------------------ units
alter table public.cms_course_units
 add column if not exists unit_type text not null default 'core' check (unit_type in ('core', 'elective')),
 add column if not exists default_weeks integer not null default 4 check (default_weeks between 1 and 104),
 add column if not exists nominal_hours integer check (nominal_hours is null or nominal_hours between 0 and 5000),
 add column if not exists is_active boolean not null default true;
update public.cms_course_units set unit_type = 'elective' where lower(coalesce(category, '')) like '%elective%' and unit_type <> 'elective';

-- ------------------------------------------------------------------ intakes (= the master timetable)
alter table public.course_intakes
 add column if not exists name text check (name is null or char_length(name) <= 160),
 add column if not exists campus text check (campus is null or char_length(campus) <= 200),
 add column if not exists capacity integer check (capacity is null or capacity between 1 and 10000),
 add column if not exists status text not null default 'open' check (status in ('draft', 'open', 'full', 'closed'));
update public.course_intakes set status = case when is_active then 'open' else 'closed' end where status = 'open' and not is_active;

-- is_active (read by the enrolment form and its server checks) is "status = open"; either column may be written.
create or replace function public.course_intake_status_sync() returns trigger
language plpgsql set search_path = public as $$
begin
 if tg_op = 'INSERT' then
  if not new.is_active and new.status = 'open' then new.status := 'closed'; end if;
 elsif new.status is distinct from old.status then null;
 elsif new.is_active is distinct from old.is_active then new.status := case when new.is_active then 'open' else 'closed' end;
 end if;
 new.is_active := new.status = 'open';
 return new;
end $$;
drop trigger if exists course_intake_status_sync on public.course_intakes;
create trigger course_intake_status_sync before insert or update on public.course_intakes for each row execute function public.course_intake_status_sync();

-- ------------------------------------------------------------------ fee line items (total is always calculated)
create table if not exists public.course_fee_items (
 id uuid primary key default gen_random_uuid(),
 course_id text not null references public.cms_courses(id) on delete cascade,
 intake_id uuid references public.course_intakes(id) on delete cascade,
 item_type text not null check (item_type in ('application', 'enrolment', 'tuition', 'material', 'oshc', 'initial_deposit', 'other')),
 label text not null default '' check (char_length(label) <= 120),
 amount_cents bigint not null check (amount_cents between 0 and 100000000),
 sort integer not null default 0,
 updated_at timestamptz not null default now(),
 updated_by uuid default auth.uid()
);
create index if not exists course_fee_items_course_idx on public.course_fee_items(course_id, intake_id, sort);

-- Existing fees become line items once (course rows and intake overrides). A course with only a total keeps it as one tuition item.
insert into public.course_fee_items(course_id, intake_id, item_type, label, amount_cents, sort)
select f.course_id, f.intake_id, x.item_type, x.label, round(x.amount * 100)::bigint, x.sort
from public.course_fee_setups f
cross join lateral (values
  ('enrolment', 'Enrolment fee', f.enrolment_fee, 1),
  ('tuition', case when f.tuition_fee is null and f.material_fee is null then 'Course fee' else 'Tuition fee' end,
     case when f.tuition_fee is null and f.material_fee is null then f.total_fee else f.tuition_fee end, 2),
  ('material', 'Non-tuition / materials', f.material_fee, 3),
  ('oshc', 'OSHC', f.oshc_fee, 4),
  ('initial_deposit', 'Initial deposit', f.deposit, 5)
) as x(item_type, label, amount, sort)
where x.amount is not null and x.amount > 0
  and exists(select 1 from public.cms_courses c where c.id = f.course_id)
  and not exists(select 1 from public.course_fee_items i where i.course_id = f.course_id and i.intake_id is not distinct from f.intake_id);

-- Offer letters and the enrolment form keep reading course_fee_setups: every change to the items writes the matching row there.
-- total_fee = tuition + materials + OSHC + other (the course cost, as before); enrolment / application and the deposit are separate.
create or replace function public.course_fee_items_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_course text; v_intake uuid; s record;
begin
 v_course := coalesce(new.course_id, old.course_id); v_intake := case when tg_op = 'DELETE' then old.intake_id else new.intake_id end;
 select
  sum(amount_cents) filter (where item_type = 'tuition') tuition,
  sum(amount_cents) filter (where item_type in ('enrolment', 'application')) enrolment,
  sum(amount_cents) filter (where item_type in ('material', 'other')) material,
  sum(amount_cents) filter (where item_type = 'oshc') oshc,
  sum(amount_cents) filter (where item_type = 'initial_deposit') deposit,
  sum(amount_cents) filter (where item_type in ('tuition', 'material', 'other', 'oshc')) total,
  count(*) n
 into s from public.course_fee_items where course_id = v_course and intake_id is not distinct from v_intake;
 update public.course_fee_setups set tuition_fee = s.tuition / 100.0, enrolment_fee = s.enrolment / 100.0, material_fee = s.material / 100.0,
  oshc_fee = s.oshc / 100.0, deposit = s.deposit / 100.0, total_fee = s.total / 100.0, updated_at = now(), updated_by = auth.uid()
  where course_id = v_course and intake_id is not distinct from v_intake;
 if not found and s.n > 0 then
  insert into public.course_fee_setups(tenant_id, course_id, intake_id, tuition_fee, enrolment_fee, material_fee, oshc_fee, deposit, total_fee, updated_by)
  select c.tenant_id, v_course, v_intake, s.tuition / 100.0, s.enrolment / 100.0, s.material / 100.0, s.oshc / 100.0, s.deposit / 100.0, s.total / 100.0, auth.uid()
  from public.cms_courses c where c.id = v_course;
 end if;
 return null;
end $$;
drop trigger if exists course_fee_items_sync on public.course_fee_items;
create trigger course_fee_items_sync after insert or update or delete on public.course_fee_items for each row execute function public.course_fee_items_sync();

-- ------------------------------------------------------------------ schedule, classrooms, batches
create table if not exists public.intake_units (
 id uuid primary key default gen_random_uuid(),
 intake_id uuid not null references public.course_intakes(id) on delete cascade,
 unit_id text not null references public.cms_course_units(id) on delete restrict,
 start_date date not null, end_date date not null,
 hours integer check (hours is null or hours between 0 and 5000),
 sort integer not null default 0,
 check (end_date >= start_date)
);
create index if not exists intake_units_intake_idx on public.intake_units(intake_id, sort);
create index if not exists intake_units_unit_idx on public.intake_units(unit_id);

create table if not exists public.classrooms (
 id uuid primary key default gen_random_uuid(),
 name text not null check (char_length(btrim(name)) between 1 and 120),
 campus text check (campus is null or char_length(campus) <= 200),
 capacity integer check (capacity is null or capacity between 1 and 10000),
 is_active boolean not null default true,
 created_at timestamptz not null default now()
);

create table if not exists public.batches (
 id uuid primary key default gen_random_uuid(),
 intake_id uuid not null references public.course_intakes(id) on delete cascade,
 name text not null check (char_length(btrim(name)) between 1 and 60),
 classroom_id uuid references public.classrooms(id) on delete set null,
 class_days text[] not null default '{}' check (class_days <@ array['Mon','Tue','Wed','Thu','Fri','Sat','Sun']),
 start_time time, end_time time,
 capacity integer check (capacity is null or capacity between 1 and 10000),
 is_active boolean not null default true,
 created_at timestamptz not null default now(),
 unique (intake_id, name),
 check (start_time is null or end_time is null or end_time > start_time)
);

create table if not exists public.batch_trainers (
 batch_id uuid not null references public.batches(id) on delete cascade,
 staff_id uuid not null references hr.staff_profiles(id) on delete cascade,
 primary key (batch_id, staff_id)
);

create table if not exists public.batch_enrolments (
 id uuid primary key default gen_random_uuid(),
 batch_id uuid not null references public.batches(id) on delete cascade,
 student_id uuid not null references public.enrollment_students(id) on delete cascade,
 enrolment_type text not null default 'CoE' check (enrolment_type in ('CoE', 'VoE', 'Domestic')),
 status text not null default 'active' check (status in ('active', 'deferred', 'withdrawn', 'completed')),
 enrolled_on date not null default current_date,
 created_by uuid default auth.uid(),
 unique (batch_id, student_id)
);
create index if not exists batch_enrolments_student_idx on public.batch_enrolments(student_id);

-- ------------------------------------------------------------------ RLS: staff read, RTO managers write; Admins may enrol
alter table public.course_fee_items enable row level security;
alter table public.intake_units enable row level security;
alter table public.classrooms enable row level security;
alter table public.batches enable row level security;
alter table public.batch_trainers enable row level security;
alter table public.batch_enrolments enable row level security;
do $rls$
declare t text;
begin
 foreach t in array array['course_fee_items','intake_units','classrooms','batches','batch_trainers','batch_enrolments'] loop
  execute format('revoke all on public.%I from anon', t);
  execute format('drop policy if exists %I on public.%I', t || '_staff_read', t);
  execute format('create policy %I on public.%I for select to authenticated using (public.cms_is_staff())', t || '_staff_read', t);
  execute format('drop policy if exists %I on public.%I', t || '_rto_write', t);
  execute format('create policy %I on public.%I for all to authenticated using (public.cms_is_rto_manager()) with check (public.cms_is_rto_manager())', t || '_rto_write', t);
 end loop;
end $rls$;
drop policy if exists batch_enrolments_admin_write on public.batch_enrolments;
create policy batch_enrolments_admin_write on public.batch_enrolments for all to authenticated using (public.cms_is_admin()) with check (public.cms_is_admin());

-- ------------------------------------------------------------------ helpers
create or replace function public.course_fee_total_cents(p_course text, p_intake uuid default null) returns bigint
language sql stable security definer set search_path = public as $$
 -- An intake's own items replace the course's when it has any.
 select coalesce(sum(amount_cents) filter (where item_type <> 'initial_deposit'), 0)::bigint from public.course_fee_items
 where course_id = p_course and intake_id is not distinct from (case when p_intake is not null and exists(select 1 from public.course_fee_items where intake_id = p_intake) then p_intake end);
$$;

create or replace function public.intake_auto_name(p_course text, p_start date, p_end date) returns text
language sql stable set search_path = public as $$
 select btrim(coalesce(nullif(btrim(c.code), ''), c.name) || ' ' || to_char(p_start, 'Mon YYYY') || coalesce(' – ' || to_char(p_end, 'Mon YYYY'), ''))
 from public.cms_courses c where c.id = p_course;
$$;

-- Working days: Monday to Friday that are not a confirmed (non-optional) public holiday.
create or replace function public.rto_is_working_day(p_day date) returns boolean
language sql stable security definer set search_path = public, hr as $$
 select extract(isodow from p_day) < 6 and not exists(select 1 from hr.public_holidays h where h.holiday_date = p_day and h.status = 'confirmed' and not h.is_optional);
$$;
create or replace function public.rto_next_working_day(p_day date) returns date
language plpgsql stable set search_path = public as $$
declare d date := p_day;
begin
 while not public.rto_is_working_day(d) loop d := d + 1; end loop;
 return d;
end $$;

-- Lays the course's active units out one after another from p_start (each unit = default_weeks x 5 working days) and returns the end.
create or replace function public.intake_generate_schedule(p_intake uuid, p_start date) returns date
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; u record; d date; days integer; n integer := 0; last_end date;
begin
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 delete from public.intake_units where intake_id = p_intake;
 d := public.rto_next_working_day(p_start); last_end := p_start;
 for u in select * from public.cms_course_units where course_id = i.course_id and is_active order by sort, code loop
  n := n + 1;
  days := u.default_weeks * 5;
  last_end := d;
  while days > 1 loop last_end := public.rto_next_working_day(last_end + 1); days := days - 1; end loop;
  insert into public.intake_units(intake_id, unit_id, start_date, end_date, hours, sort) values (p_intake, u.id, d, last_end, u.nominal_hours, n);
  d := public.rto_next_working_day(last_end + 1);
 end loop;
 update public.course_intakes set start_date = p_start, end_date = case when n > 0 then last_end else coalesce(end_date, p_start) end, updated_at = now() where id = p_intake;
 return last_end;
end $$;
revoke all on function public.intake_generate_schedule(uuid, date) from public, anon, authenticated;

-- ------------------------------------------------------------------ JSON shapes for the CMS
create or replace function public.rto_course_json(c public.cms_courses) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', c.id, 'slug', c.slug, 'code', c.code, 'name', c.name, 'cricos', c.cricos, 'category', c.category,
  'trainingPackage', c.training_package, 'duration', c.duration, 'mode', c.mode, 'campus', c.campus, 'tgaUrl', c.tga_url, 'isActive', c.is_active,
  'status', c.status, 'featured', c.featured, 'homepageCarousel', c.featured, 'displayOrder', c.display_order, 'showFees', c.show_fees,
  'feeNote', c.fee_note, 'seoTitle', c.seo_title, 'seoDescription', c.seo_description, 'image', c.image, 'shortDescription', c.short_description,
  'totalCents', public.course_fee_total_cents(c.id),
  'units', (select count(*) from public.cms_course_units u where u.course_id = c.id),
  'activeUnits', (select count(*) from public.cms_course_units u where u.course_id = c.id and u.is_active),
  'openIntakes', (select count(*) from public.course_intakes i where i.course_id = c.id and i.status = 'open' and coalesce(i.end_date, i.start_date) >= current_date),
  'nextIntake', (select min(i.start_date) from public.course_intakes i where i.course_id = c.id and i.status = 'open' and i.start_date >= current_date));
$$;

create or replace function public.rto_intake_json(i public.course_intakes) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', i.id, 'courseId', i.course_id, 'courseCode', c.code, 'courseName', c.name,
  'name', coalesce(nullif(btrim(i.name), ''), public.intake_auto_name(i.course_id, i.start_date, i.end_date)),
  'customName', nullif(btrim(i.name), ''), 'startDate', i.start_date, 'endDate', i.end_date, 'campus', coalesce(i.campus, c.campus),
  'capacity', i.capacity, 'status', i.status,
  'enrolled', (select count(distinct e.student_id) from public.batch_enrolments e join public.batches b on b.id = e.batch_id where b.intake_id = i.id and e.status in ('active', 'deferred')),
  'batches', (select count(*) from public.batches b where b.intake_id = i.id),
  'units', (select count(*) from public.intake_units x where x.intake_id = i.id),
  'trainers', coalesce((select jsonb_agg(distinct btrim(s.first_name || ' ' || s.last_name)) from public.batch_trainers t join public.batches b on b.id = t.batch_id
     join hr.staff_profiles s on s.id = t.staff_id where b.intake_id = i.id), '[]'::jsonb),
  'hasFeeOverride', exists(select 1 from public.course_fee_items f where f.intake_id = i.id))
 from public.cms_courses c where c.id = i.course_id;
$$;

create or replace function public.rto_batch_json(b public.batches) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', b.id, 'intakeId', b.intake_id, 'name', b.name, 'classroomId', b.classroom_id,
  'classroom', (select r.name from public.classrooms r where r.id = b.classroom_id), 'classDays', to_jsonb(b.class_days),
  'startTime', to_char(b.start_time, 'HH24:MI'), 'endTime', to_char(b.end_time, 'HH24:MI'), 'capacity', b.capacity, 'isActive', b.is_active,
  'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name)) order by s.first_name, s.last_name)
     from public.batch_trainers t join hr.staff_profiles s on s.id = t.staff_id where t.batch_id = b.id), '[]'::jsonb),
  'students', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'id', s.id, 'name', s.full_name, 'email', s.email, 'type', e.enrolment_type,
     'status', e.status, 'enrolledOn', e.enrolled_on) order by s.full_name) from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id
     where e.batch_id = b.id), '[]'::jsonb));
$$;

create or replace function public.rto_fee_items_json(p_course text, p_intake uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'type', f.item_type, 'label', f.label, 'amountCents', f.amount_cents) order by f.sort, f.item_type), '[]'::jsonb)
 from public.course_fee_items f where f.course_id = p_course and f.intake_id is not distinct from p_intake;
$$;

-- Students linked to a course: they have an application for it.
create or replace function public.rto_student_on_course(p_student uuid, p_course text) returns boolean
language sql stable security definer set search_path = public as $$
 select exists(select 1 from public.enrollment_applications a join public.enrollment_application_courses ac on ac.application_id = a.id
  where a.student_id = p_student and ac.course_id = p_course);
$$;

-- ------------------------------------------------------------------ one CMS entry point (roles enforced here and by RLS)
create or replace function public.rto_admin(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
 d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := nullif(d->>'courseId', ''); v_id uuid; i public.course_intakes; b public.batches;
 x jsonb; n integer := 0; v_keep text[] := '{}'; v_uid text; v_count integer;
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_action in ('course_save', 'units_save', 'fees_save', 'intake_save', 'schedule_save', 'intake_delete', 'intake_fees_save', 'batch_save', 'batch_delete', 'classroom_save')
    and not public.cms_is_rto_manager() then
  raise exception 'Only an RTO Manager can change courses, intakes, schedules and batches.' using errcode = '42501';
 end if;
 if p_action in ('enrol', 'unenrol') and not (public.cms_is_rto_manager() or public.cms_is_admin()) then
  raise exception 'Only an Admin or an RTO Manager can enrol students.' using errcode = '42501';
 end if;

 if p_action = 'me' then
  return jsonb_build_object('rtoManager', public.cms_is_rto_manager(), 'admin', public.cms_is_admin());

 elsif p_action = 'course_list' then
  return coalesce((select jsonb_agg(public.rto_course_json(c) order by c.display_order, c.name) from public.cms_courses c where nullif(btrim(c.name), '') is not null), '[]'::jsonb);

 elsif p_action = 'course_get' then
  if not exists(select 1 from public.cms_courses where id = v_course) then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return (select jsonb_build_object('course', public.rto_course_json(c),
   'units', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'code', u.code, 'name', u.name, 'unitType', u.unit_type, 'category', u.category,
      'defaultWeeks', u.default_weeks, 'nominalHours', u.nominal_hours, 'isActive', u.is_active,
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
   is_active = coalesce((d->>'isActive')::boolean, is_active), updated_at = now()
  where id = v_course;
  if not found then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return public.rto_admin('course_get', jsonb_build_object('courseId', v_course));

 elsif p_action = 'website_save' then
  -- Website editors (any CMS user) change marketing settings only; facts and fees are edited in the course.
  update public.cms_courses set
   show_fees = coalesce((d->>'showFees')::boolean, show_fees),
   fee_note = case when d ? 'feeNote' then nullif(btrim(d->>'feeNote'), '') else fee_note end,
   seo_title = case when d ? 'seoTitle' then nullif(btrim(d->>'seoTitle'), '') else seo_title end,
   seo_description = case when d ? 'seoDescription' then nullif(btrim(d->>'seoDescription'), '') else seo_description end,
   -- "Featured" is what leads the homepage carousel; homepage_carousel mirrors it.
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
     default_weeks = coalesce(nullif(x->>'defaultWeeks', '')::integer, default_weeks), nominal_hours = nullif(x->>'nominalHours', '')::integer,
     is_active = coalesce((x->>'isActive')::boolean, is_active), sort = n
    where id = v_uid;
   else
    v_uid := 'unit-' || replace(gen_random_uuid()::text, '-', '');
    insert into public.cms_course_units(id, course_id, code, name, category, sort, unit_type, default_weeks, nominal_hours, is_active, tenant_id)
    select v_uid, v_course, btrim(x->>'code'), btrim(x->>'name'), case when x->>'unitType' = 'elective' then 'Elective' else 'Core' end, n,
     coalesce(nullif(x->>'unitType', ''), 'core'), coalesce(nullif(x->>'defaultWeeks', '')::integer, 4), nullif(x->>'nominalHours', '')::integer,
     coalesce((x->>'isActive')::boolean, true), c.tenant_id
    from public.cms_courses c where c.id = v_course;
   end if;
   v_keep := v_keep || v_uid;
  end loop;
  -- A removed unit that an intake schedule uses is only deactivated; one that was never scheduled is removed.
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
  insert into public.course_fee_items(course_id, intake_id, item_type, label, amount_cents, sort)
  select v_course, v_id, e.value->>'type', btrim(coalesce(e.value->>'label', '')), (e.value->>'amountCents')::bigint, e.ordinality::integer
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
   perform public.intake_generate_schedule(v_id, (select start_date from public.course_intakes where id = v_id));
  end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', v_id));

 elsif p_action = 'schedule_save' then
  v_id := nullif(d->>'intakeId', '')::uuid;
  if not exists(select 1 from public.course_intakes where id = v_id) then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  for x in select value from jsonb_array_elements(coalesce(d->'rows', '[]'::jsonb)) loop
   n := n + 1;
   update public.intake_units set start_date = (x->>'startDate')::date, end_date = (x->>'endDate')::date,
    hours = nullif(x->>'hours', '')::integer, sort = n
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
    raise exception 'A selected student has no application for this course.' using errcode = '22023';
   end if;
   insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status)
   values (b.id, (x->>'id')::uuid, coalesce(nullif(x->>'type', ''), 'CoE'), 'active')
   on conflict (batch_id, student_id) do update set enrolment_type = excluded.enrolment_type, status = 'active';
  end loop;
  select count(*) into v_count from public.batch_enrolments where batch_id = b.id and status in ('active', 'deferred');
  if b.capacity is not null and v_count > b.capacity then raise exception 'This batch is full (% places).', b.capacity using errcode = '23514'; end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.intake_id));

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
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.full_name, 'email', s.email) order by s.full_name)
   from (select * from public.enrollment_students st
         where public.rto_student_on_course(st.id, v_course)
           and (coalesce(d->>'q', '') = '' or st.full_name ilike '%' || (d->>'q') || '%' or st.email ilike '%' || (d->>'q') || '%')
         order by st.full_name limit 50) s), '[]'::jsonb);

 elsif p_action = 'student_studies' then
  v_id := nullif(d->>'studentId', '')::uuid;
  return jsonb_build_object(
   'enrolments', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'type', e.enrolment_type, 'status', e.status, 'enrolledOn', e.enrolled_on,
      'batchId', bb.id, 'batch', bb.name, 'intakeId', ci.id, 'intake', public.rto_intake_json(ci)->>'name', 'startDate', ci.start_date, 'endDate', ci.end_date,
      'courseId', c.id, 'course', c.name, 'courseCode', c.code) order by ci.start_date desc)
     from public.batch_enrolments e join public.batches bb on bb.id = e.batch_id join public.course_intakes ci on ci.id = bb.intake_id join public.cms_courses c on c.id = ci.course_id
     where e.student_id = v_id), '[]'::jsonb),
   'options', coalesce((select jsonb_agg(jsonb_build_object('courseId', c.id, 'course', c.name, 'courseCode', c.code,
      'intakes', coalesce((select jsonb_agg(jsonb_build_object('id', ci.id, 'name', public.rto_intake_json(ci)->>'name', 'status', ci.status,
          'batches', coalesce((select jsonb_agg(jsonb_build_object('id', bb.id, 'name', bb.name)) from public.batches bb where bb.intake_id = ci.id and bb.is_active), '[]'::jsonb))
        order by ci.start_date) from public.course_intakes ci where ci.course_id = c.id and ci.status in ('open', 'full', 'draft')), '[]'::jsonb)) order by c.name)
     from public.cms_courses c where public.rto_student_on_course(v_id, c.id)), '[]'::jsonb));

 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $$;
revoke all on function public.rto_admin(text, jsonb) from public, anon;
grant execute on function public.rto_admin(text, jsonb) to authenticated;
revoke all on function public.rto_course_json(public.cms_courses), public.rto_intake_json(public.course_intakes), public.rto_batch_json(public.batches),
 public.rto_fee_items_json(text, uuid), public.rto_student_on_course(uuid, text), public.course_fee_items_sync(), public.rto_is_working_day(date)
 from public, anon, authenticated;

-- ------------------------------------------------------------------ public website: fees from line items, upcoming open intakes
create or replace function public.public_course_facts(p_slug text, p_tenant uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object(
  'showFees', c.show_fees, 'feeNote', c.fee_note,
  'totalCents', case when c.show_fees then public.course_fee_total_cents(c.id) end,
  'items', case when c.show_fees then (select coalesce(jsonb_agg(jsonb_build_object('type', f.item_type, 'label', f.label, 'amountCents', f.amount_cents) order by f.sort), '[]'::jsonb)
     from public.course_fee_items f where f.course_id = c.id and f.intake_id is null and f.item_type <> 'initial_deposit') end,
  'intakes', coalesce((select jsonb_agg(jsonb_build_object('name', public.intake_auto_name(i.course_id, i.start_date, i.end_date), 'startDate', i.start_date, 'endDate', i.end_date) order by i.start_date)
     from public.course_intakes i where i.course_id = c.id and i.status = 'open' and i.start_date >= current_date), '[]'::jsonb))
 from public.cms_courses c
 where c.slug = p_slug and c.status = 'Published' and c.is_active and c.tenant_id is not distinct from p_tenant
 limit 1;
$$;
revoke all on function public.public_course_facts(text, uuid) from public;
grant execute on function public.public_course_facts(text, uuid) to anon, authenticated;

-- ------------------------------------------------------------------ menu: Intakes next to Master Data › Courses
insert into public.admin_menu_items (id, parent_id, label, route, icon_key, sort_order, permission_key, permission_scope, is_system)
select 'rto_intakes', m.parent_id, 'Intakes & Batches', '/admin/intakes', 'calendar', m.sort_order + 1, 'cms.read', 'current', true
from public.admin_menu_items m where m.id = 'agency_course_fees'
on conflict (id) do nothing;
