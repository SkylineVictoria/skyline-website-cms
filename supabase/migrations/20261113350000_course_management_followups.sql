-- COURSE-MGMT-2 (follow-ups to 20261113340000): one fee-total rule, course variants, unit selection and "fit to end date" in the
-- schedule generator, direct enrolment by RTO Managers, and granting the RTO Manager permission from the Users screen.
-- Additive: new columns, new or replaced functions, and backfills of the new columns / the derived total_fee only.

-- ------------------------------------------------------------------ 1. fee totals: one rule, one function
alter table public.course_fee_items add column if not exists included_in_total boolean;
update public.course_fee_items set included_in_total = (item_type <> 'initial_deposit') where included_in_total is null;
-- Default by type when a writer does not say: every fee counts, an initial deposit does not (it is part of the tuition, paid upfront).
create or replace function public.course_fee_item_defaults() returns trigger
language plpgsql set search_path = public as $$
begin
 new.included_in_total := coalesce(new.included_in_total, new.item_type <> 'initial_deposit');
 return new;
end $$;
drop trigger if exists course_fee_item_defaults on public.course_fee_items;
create trigger course_fee_item_defaults before insert or update on public.course_fee_items for each row execute function public.course_fee_item_defaults();
alter table public.course_fee_items alter column included_in_total set not null;

-- The total of one scope (a course's own items, or one intake's override items).
create or replace function public.course_fee_scope_total_cents(p_course text, p_intake uuid) returns bigint
language sql stable security definer set search_path = public as $$
 select coalesce(sum(amount_cents) filter (where included_in_total), 0)::bigint from public.course_fee_items
 where course_id = p_course and intake_id is not distinct from p_intake;
$$;
-- THE total: the intake's override items when it has any, else the course's. Letters (via course_fee_setups.total_fee), the
-- enrolment form, the website and the CMS course list all read this.
create or replace function public.course_fee_total_cents(p_course text, p_intake uuid default null) returns bigint
language sql stable security definer set search_path = public as $$
 select public.course_fee_scope_total_cents(p_course,
  case when p_intake is not null and exists(select 1 from public.course_fee_items where intake_id = p_intake) then p_intake end);
$$;

create or replace function public.course_fee_items_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_course text; v_intake uuid; s record;
begin
 v_course := case when tg_op = 'DELETE' then old.course_id else new.course_id end;
 v_intake := case when tg_op = 'DELETE' then old.intake_id else new.intake_id end;
 select
  sum(amount_cents) filter (where item_type = 'tuition') tuition,
  sum(amount_cents) filter (where item_type in ('enrolment', 'application')) enrolment,
  sum(amount_cents) filter (where item_type in ('material', 'other')) material,
  sum(amount_cents) filter (where item_type = 'oshc') oshc,
  sum(amount_cents) filter (where item_type = 'initial_deposit') deposit,
  count(*) n
 into s from public.course_fee_items where course_id = v_course and intake_id is not distinct from v_intake;
 update public.course_fee_setups set tuition_fee = s.tuition / 100.0, enrolment_fee = s.enrolment / 100.0, material_fee = s.material / 100.0,
  oshc_fee = s.oshc / 100.0, deposit = s.deposit / 100.0,
  total_fee = case when s.n > 0 then public.course_fee_scope_total_cents(v_course, v_intake) / 100.0 end, updated_at = now(), updated_by = auth.uid()
  where course_id = v_course and intake_id is not distinct from v_intake;
 if not found and s.n > 0 then
  insert into public.course_fee_setups(tenant_id, course_id, intake_id, tuition_fee, enrolment_fee, material_fee, oshc_fee, deposit, total_fee, updated_by)
  select c.tenant_id, v_course, v_intake, s.tuition / 100.0, s.enrolment / 100.0, s.material / 100.0, s.oshc / 100.0, s.deposit / 100.0,
   public.course_fee_scope_total_cents(v_course, v_intake) / 100.0, auth.uid()
  from public.cms_courses c where c.id = v_course;
 end if;
 return null;
end $$;
-- Bring the stored totals (read by offer letters) onto the rule once.
update public.course_fee_setups f set total_fee = public.course_fee_scope_total_cents(f.course_id, f.intake_id) / 100.0
where exists(select 1 from public.course_fee_items i where i.course_id = f.course_id and i.intake_id is not distinct from f.intake_id)
  and f.total_fee is distinct from public.course_fee_scope_total_cents(f.course_id, f.intake_id) / 100.0;

create or replace function public.rto_fee_items_json(p_course text, p_intake uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'type', f.item_type, 'label', f.label, 'amountCents', f.amount_cents, 'includedInTotal', f.included_in_total)
  order by f.sort, f.item_type), '[]'::jsonb)
 from public.course_fee_items f where f.course_id = p_course and f.intake_id is not distinct from p_intake;
$$;

-- ------------------------------------------------------------------ 2. course variants
alter table public.cms_courses add column if not exists variant_label text check (variant_label is null or char_length(variant_label) <= 60);
update public.cms_courses set variant_label = btrim(duration)
 where btrim(code) = 'RII60520' and variant_label is null and nullif(btrim(duration), '') is not null;

-- "CODE Name (variant)": how a course is picked or printed.
create or replace function public.course_label(p_code text, p_name text, p_variant text) returns text
language sql immutable set search_path = pg_catalog as $$
 select btrim(concat_ws(' ', nullif(btrim(coalesce(p_code, '')), ''), nullif(btrim(coalesce(p_name, '')), ''))
  || coalesce(' (' || nullif(btrim(coalesce(p_variant, '')), '') || ')', ''));
$$;

create or replace function public.intake_auto_name(p_course text, p_start date, p_end date) returns text
language sql stable set search_path = public as $$
 select btrim(coalesce(nullif(btrim(c.code), ''), c.name) || coalesce(' (' || nullif(btrim(c.variant_label), '') || ')', '') || ' '
  || to_char(p_start, 'Mon YYYY') || coalesce(' – ' || to_char(p_end, 'Mon YYYY'), ''))
 from public.cms_courses c where c.id = p_course;
$$;

-- Enrolment form course list: the variant is part of the title, so two records with one code are two choices.
create or replace function public.portal_course_options() returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('courseId', id, 'code', code,
   'title', name || coalesce(' (' || nullif(btrim(variant_label), '') || ')', ''), 'variant', coalesce(btrim(variant_label), '')) order by name, variant_label), '[]')
 from public.cms_courses where tenant_id = public.tenant_current() and status = 'Published' and code <> 'BSB80120' and
 (public.tenant_has_role(tenant_id, array['tenant_admin', 'staff']) or public.tenant_agency_access(tenant_id, public.portal_agency_id()));
$$;

create or replace function public.rto_course_json(c public.cms_courses) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', c.id, 'slug', c.slug, 'code', c.code, 'name', c.name, 'variantLabel', c.variant_label,
  'label', public.course_label(c.code, c.name, c.variant_label), 'cricos', c.cricos, 'category', c.category,
  'trainingPackage', c.training_package, 'duration', c.duration, 'mode', c.mode, 'campus', c.campus, 'tgaUrl', c.tga_url, 'isActive', c.is_active,
  'status', c.status, 'featured', c.featured, 'homepageCarousel', c.featured, 'displayOrder', c.display_order, 'showFees', c.show_fees,
  'feeNote', c.fee_note, 'seoTitle', c.seo_title, 'seoDescription', c.seo_description, 'image', c.image, 'shortDescription', c.short_description,
  'totalCents', public.course_fee_total_cents(c.id),
  'depositCents', (select sum(amount_cents) from public.course_fee_items f where f.course_id = c.id and f.intake_id is null and f.item_type = 'initial_deposit'),
  'units', (select count(*) from public.cms_course_units u where u.course_id = c.id),
  'activeUnits', (select count(*) from public.cms_course_units u where u.course_id = c.id and u.is_active),
  'openIntakes', (select count(*) from public.course_intakes i where i.course_id = c.id and i.status = 'open' and coalesce(i.end_date, i.start_date) >= current_date),
  'nextIntake', (select min(i.start_date) from public.course_intakes i where i.course_id = c.id and i.status = 'open' and i.start_date >= current_date));
$$;

create or replace function public.rto_intake_json(i public.course_intakes) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', i.id, 'courseId', i.course_id, 'courseCode', c.code,
  'courseName', c.name || coalesce(' (' || nullif(btrim(c.variant_label), '') || ')', ''),
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

create or replace function public.public_course_facts(p_slug text, p_tenant uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object(
  'showFees', c.show_fees, 'feeNote', c.fee_note, 'variant', c.variant_label,
  'totalCents', case when c.show_fees then public.course_fee_total_cents(c.id) end,
  'items', case when c.show_fees then (select coalesce(jsonb_agg(jsonb_build_object('type', f.item_type, 'label', f.label, 'amountCents', f.amount_cents,
       'includedInTotal', f.included_in_total) order by f.sort), '[]'::jsonb)
     from public.course_fee_items f where f.course_id = c.id and f.intake_id is null) end,
  'intakes', coalesce((select jsonb_agg(jsonb_build_object('name', public.intake_auto_name(i.course_id, i.start_date, i.end_date), 'startDate', i.start_date, 'endDate', i.end_date) order by i.start_date)
     from public.course_intakes i where i.course_id = c.id and i.status = 'open' and i.start_date >= current_date), '[]'::jsonb))
 from public.cms_courses c
 where c.slug = p_slug and c.status = 'Published' and c.is_active and c.tenant_id is not distinct from p_tenant
 limit 1;
$$;

-- ------------------------------------------------------------------ 3. schedule generator: chosen units, or fit to an end date
-- p_units: the units to schedule (active core units are always included); null = every active unit.
-- p_end: "fit to end date" - the working days from start to p_end are shared evenly between the units; null = each unit's default weeks.
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
  days := case when p_end is null then u.default_weeks * 5 else per + case when n <= extra then 1 else 0 end end;
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
create or replace function public.intake_generate_schedule(p_intake uuid, p_start date) returns date
language sql security definer set search_path = public as $$ select public.intake_generate_schedule(p_intake, p_start, null::text[], null::date); $$;
revoke all on function public.intake_generate_schedule(uuid, date, text[], date), public.intake_generate_schedule(uuid, date) from public, anon, authenticated;

-- ------------------------------------------------------------------ 4. direct enrolment
alter table public.enrollment_applications add column if not exists source text check (source is null or char_length(source) <= 40);

-- An RTO Manager enrolling a student who has no application for the course: a draft application marked "direct enrolment".
create or replace function public.rto_direct_application(p_student uuid, p_intake uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare st public.enrollment_students; i public.course_intakes; c public.cms_courses; v_app uuid;
begin
 select * into st from public.enrollment_students where id = p_student;
 if st.id is null then raise exception 'Student not found' using errcode = 'P0002'; end if;
 select * into i from public.course_intakes where id = p_intake;
 select * into c from public.cms_courses where id = i.course_id;
 insert into public.enrollment_applications(agency_id, student_id, student_name, student_email, tenant_id, status, source, data)
 values (st.agency_id, st.id, coalesce(st.full_name, ''), coalesce(st.email, ''), st.tenant_id, 'draft', 'direct enrolment', jsonb_build_object('source', 'direct enrolment'))
 returning id into v_app;
 perform set_config('portal.draft_command', v_app::text, true);
 insert into public.enrollment_application_courses(application_id, course_id, course_code, course_title, variant, intake_id)
 values (v_app, c.id, coalesce(c.code, ''), coalesce(c.name, ''), coalesce(btrim(c.variant_label), ''), case when i.status = 'open' then i.id end);
 perform set_config('portal.draft_command', '', true);
 return v_app;
end $$;
revoke all on function public.rto_direct_application(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ rto_admin (replaces 20261113340000's; same actions plus the follow-ups)
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
  insert into public.course_fee_items(course_id, intake_id, item_type, label, amount_cents, sort, included_in_total)
  select v_course, v_id, e.value->>'type', btrim(coalesce(e.value->>'label', '')), (e.value->>'amountCents')::bigint, e.ordinality::integer,
   (e.value->>'includedInTotal')::boolean
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
      'courseId', c.id, 'course', c.name || coalesce(' (' || nullif(btrim(c.variant_label), '') || ')', ''), 'courseCode', c.code) order by ci.start_date desc)
     from public.batch_enrolments e join public.batches bb on bb.id = e.batch_id join public.course_intakes ci on ci.id = bb.intake_id join public.cms_courses c on c.id = ci.course_id
     where e.student_id = v_id), '[]'::jsonb),
   'options', coalesce((select jsonb_agg(jsonb_build_object('courseId', c.id, 'course', c.name || coalesce(' (' || nullif(btrim(c.variant_label), '') || ')', ''), 'courseCode', c.code,
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
revoke all on function public.course_fee_scope_total_cents(text, uuid), public.course_fee_item_defaults() from public, anon, authenticated;

-- ------------------------------------------------------------------ offer letters: the course name carries the variant
-- (application_letter_course as live on hosted, with only the variant line added.)
CREATE OR REPLACE FUNCTION public.application_letter_course(p_ac enrollment_application_courses, p_fmt text, p_settings cms_settings, p_intake_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.cms_courses; i public.course_intakes; fc public.course_fee_setups; fi public.course_fee_setups; r public.letter_variables; v_out jsonb := '{}'::jsonb;
 raw text; val text; src text; fee_src text; v_code text; v_name text; tuition numeric; enrol numeric; mat numeric; oshc numeric;
begin
 if p_ac.course_id is not null then
  select * into c from public.cms_courses x where x.id = public.letter_course_id(p_ac.course_id, p_ac.course_code);
  select * into i from public.course_intakes x where x.id = p_ac.intake_id;
  if c.id is not null then
   select * into fc from public.course_fee_setups x where x.course_id = c.id and x.intake_id is null;
   if p_ac.intake_id is not null then select * into fi from public.course_fee_setups x where x.course_id = c.id and x.intake_id = p_ac.intake_id; end if;
  end if;
 end if;
 fee_src := case when fi.id is not null then 'for intake ' || coalesce(nullif(i.label, ''), to_char(i.start_date, 'DD/MM/YYYY')) else 'for every intake' end;
 v_code := coalesce(nullif(btrim(c.code), ''), nullif(btrim(p_ac.course_code), ''), '');
 v_name := coalesce(nullif(btrim(c.name), ''), nullif(btrim(p_ac.course_title), ''), '');
 if v_code <> '' and upper(v_name) like upper(v_code) || '%' then v_name := btrim(regexp_replace(substr(v_name, char_length(v_code) + 1), '^[\s:–—-]+', '')); end if;
 -- COURSE-MGMT-2: a course variant (e.g. 52 Weeks) is printed with the name, so two records with one code stay distinguishable.
 if nullif(btrim(coalesce(c.variant_label, '')), '') is not null and v_name <> '' then v_name := v_name || ' (' || btrim(c.variant_label) || ')'; end if;
 tuition := coalesce(fi.tuition_fee, fc.tuition_fee); enrol := coalesce(fi.enrolment_fee, fc.enrolment_fee); mat := coalesce(fi.material_fee, fc.material_fee); oshc := coalesce(fi.oshc_fee, fc.oshc_fee);
 for r in select * from public.letter_variables x where x.key like 'course.%' or (x.key like 'fees.%' and x.key <> 'fees.combined_total') order by x.sort loop
  raw := ''; src := r.source_label;
  case r.key
   when 'course.name' then raw := v_name;
   when 'course.code' then raw := v_code;
   when 'course.code_and_name' then raw := btrim(concat_ws(' ', nullif(v_code, ''), nullif(v_name, '')));
   when 'course.cricos' then raw := coalesce(btrim(c.cricos), '');
   when 'course.duration' then raw := coalesce(btrim(c.duration), '');
   when 'course.mode' then raw := coalesce(btrim(c.mode), '');
   when 'course.intake' then
    raw := coalesce(nullif(btrim(i.label), ''), to_char(i.start_date, 'FMMonth YYYY'), '');
    if raw = '' then raw := coalesce(btrim(p_intake_text), ''); src := 'Application form › Preferred intake (no intake chosen)'; end if;
   when 'course.start_date' then raw := coalesce(i.start_date::text, '');
   when 'course.end_date' then raw := coalesce(i.end_date::text, '');
   when 'course.campus' then
    raw := coalesce(nullif(btrim(coalesce(fi.campus, fc.campus)), ''), '');
    if raw = '' then raw := coalesce(btrim(p_settings.address), ''); src := 'Website settings › Address (no campus in the fee setup)'; else src := r.source_label || ' (' || fee_src || ')'; end if;
   when 'course.orientation' then raw := coalesce(btrim(coalesce(fi.orientation, fc.orientation)), ''); src := r.source_label || ' (' || fee_src || ')';
   when 'course.hours_per_week' then raw := coalesce(btrim(coalesce(fi.hours_per_week, fc.hours_per_week)), ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.tuition' then raw := coalesce(tuition::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.enrolment' then raw := coalesce(enrol::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.material' then raw := coalesce(mat::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.oshc' then raw := coalesce(oshc::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.deposit' then raw := coalesce(coalesce(fi.deposit, fc.deposit)::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.payment_plan' then raw := coalesce(coalesce(fi.payment_plan, fc.payment_plan), ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.total' then
    raw := coalesce(coalesce(fi.total_fee, fc.total_fee)::text, case when tuition is null then '' else (tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0))::text end);
    src := case when coalesce(fi.total_fee, fc.total_fee) is not null then 'Master Data › Courses › Total fee (' || fee_src || ')' else 'Course setup › Fees (sum, ' || fee_src || ')' end;
   else raw := '';
  end case;
  val := case r.format when 'date' then public.letter_format_date(raw, p_fmt) when 'money' then case when raw ~ '^-?[0-9]+(\.[0-9]+)?$' then public.letter_format_money(raw::numeric) else raw end else raw end;
  v_out := v_out || jsonb_build_object(r.key, jsonb_build_object('value', coalesce(val, ''), 'raw', coalesce(raw, ''), 'source', src, 'missing', coalesce(btrim(val), '') = ''));
 end loop;
 return v_out || jsonb_build_object('_courseId', c.id, '_intakeId', p_ac.intake_id, '_feeSetup', coalesce(fi.id, fc.id), '_title', coalesce(nullif(v_name, ''), p_ac.course_title),
   '_start', i.start_date, '_end', i.end_date, '_total', coalesce(fi.total_fee, fc.total_fee, case when tuition is null then null else tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0) end));
end $function$;
