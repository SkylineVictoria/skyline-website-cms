-- FEE-LOO: fee lines as the SLIT Letter of Offer prints them, GST per fee line, and "Other fees and charges" from Settings.
-- Additive: new columns, a widened type check, new functions, new table + seed, registry rows. No fee amount or deposit changes.
-- Data changes: "enrolment" lines become "application" lines (same amount, same included_in_total; label "Application fee"),
-- and the SLIT letter template's two fee tables are re-pointed to the shared fee function (new template version).

-- ------------------------------------------------------------------ 1. fee types, refundable, GST
alter table public.course_fee_items drop constraint if exists course_fee_items_item_type_check;
alter table public.course_fee_items add constraint course_fee_items_item_type_check
 check (item_type in ('application', 'registration', 'enrolment', 'material', 'tuition', 'other', 'oshc', 'initial_deposit'));
alter table public.course_fee_items add column if not exists refundable boolean;
alter table public.course_fee_items add column if not exists gst_treatment text not null default 'gst_free'
 check (gst_treatment in ('gst_free', 'inclusive', 'exclusive'));

-- One "Application fee (Non-Refundable)" line, also known as the enrolment fee: the separate enrolment type is merged into it.
update public.course_fee_items set item_type = 'application',
 label = case when btrim(label) = '' or lower(btrim(label)) in ('enrolment fee', 'enrollment fee') then 'Application fee' else label end
where item_type = 'enrolment';
update public.course_fee_items set refundable = item_type not in ('application', 'registration', 'enrolment') where refundable is null;

-- Defaults by type when a writer does not say: application and registration are non-refundable; the deposit and OSHC are not in the total.
create or replace function public.course_fee_item_defaults() returns trigger
language plpgsql set search_path = public as $$
begin
 new.included_in_total := coalesce(new.included_in_total, new.item_type not in ('initial_deposit', 'oshc'));
 new.refundable := coalesce(new.refundable, new.item_type not in ('application', 'registration', 'enrolment'));
 new.gst_treatment := coalesce(new.gst_treatment, 'gst_free');
 return new;
end $$;
alter table public.course_fee_items alter column refundable set not null;

-- The print order of the offer letter: application, registration, material, tuition (then other), total; the deposit after it.
create or replace function public.course_fee_type_rank(p_type text) returns integer
language sql immutable set search_path = pg_catalog as $$
 select case p_type when 'application' then 1 when 'enrolment' then 1 when 'registration' then 2 when 'material' then 3 when 'tuition' then 4
  when 'other' then 5 when 'oshc' then 6 when 'initial_deposit' then 7 else 9 end;
$$;

-- GST: exclusive adds 10%; inclusive already contains 1/11; GST-free adds nothing.
create or replace function public.course_fee_item_total_cents(p_amount bigint, p_gst text) returns bigint
language sql immutable set search_path = pg_catalog as $$
 select case when p_gst = 'exclusive' then p_amount + round(p_amount / 10.0)::bigint else p_amount end;
$$;
create or replace function public.course_fee_item_gst_cents(p_amount bigint, p_gst text) returns bigint
language sql immutable set search_path = pg_catalog as $$
 select case p_gst when 'exclusive' then round(p_amount / 10.0)::bigint when 'inclusive' then round(p_amount / 11.0)::bigint else 0 end;
$$;

create or replace function public.course_fee_scope_total_cents(p_course text, p_intake uuid) returns bigint
language sql stable security definer set search_path = public as $$
 select coalesce(sum(public.course_fee_item_total_cents(amount_cents, gst_treatment)) filter (where included_in_total), 0)::bigint
 from public.course_fee_items where course_id = p_course and intake_id is not distinct from p_intake;
$$;
create or replace function public.course_fee_scope_gst_cents(p_course text, p_intake uuid) returns bigint
language sql stable security definer set search_path = public as $$
 select coalesce(sum(public.course_fee_item_gst_cents(amount_cents, gst_treatment)) filter (where included_in_total), 0)::bigint
 from public.course_fee_items where course_id = p_course and intake_id is not distinct from p_intake;
$$;
-- THE GST of a course or intake (same scope rule as course_fee_total_cents).
create or replace function public.course_fee_gst_cents(p_course text, p_intake uuid default null) returns bigint
language sql stable security definer set search_path = public as $$
 select public.course_fee_scope_gst_cents(p_course,
  case when p_intake is not null and exists(select 1 from public.course_fee_items where intake_id = p_intake) then p_intake end);
$$;
revoke all on function public.course_fee_scope_gst_cents(text, uuid) from public, anon, authenticated;

create or replace function public.rto_fee_items_json(p_course text, p_intake uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'type', f.item_type, 'label', f.label, 'amountCents', f.amount_cents, 'includedInTotal', f.included_in_total,
   'refundable', f.refundable, 'gstTreatment', f.gst_treatment) order by public.course_fee_type_rank(f.item_type), f.sort), '[]'::jsonb)
 from public.course_fee_items f where f.course_id = p_course and f.intake_id is not distinct from p_intake;
$$;

create or replace function public.public_course_facts(p_slug text, p_tenant uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object(
  'showFees', c.show_fees, 'feeNote', c.fee_note, 'variant', c.variant_label,
  'totalCents', case when c.show_fees then public.course_fee_total_cents(c.id) end,
  'gstCents', case when c.show_fees then public.course_fee_gst_cents(c.id) end,
  'items', case when c.show_fees then (select coalesce(jsonb_agg(jsonb_build_object('type', f.item_type, 'label', f.label, 'amountCents', f.amount_cents,
       'includedInTotal', f.included_in_total, 'refundable', f.refundable, 'gstTreatment', f.gst_treatment) order by public.course_fee_type_rank(f.item_type), f.sort), '[]'::jsonb)
     from public.course_fee_items f where f.course_id = c.id and f.intake_id is null and f.item_type <> 'oshc') end,
  'intakes', coalesce((select jsonb_agg(jsonb_build_object('name', public.intake_auto_name(i.course_id, i.start_date, i.end_date), 'startDate', i.start_date, 'endDate', i.end_date) order by i.start_date)
     from public.course_intakes i where i.course_id = c.id and i.status = 'open' and i.start_date >= current_date), '[]'::jsonb))
 from public.cms_courses c
 where c.slug = p_slug and c.status = 'Published' and c.is_active and c.tenant_id is not distinct from p_tenant
 limit 1;
$$;

-- ------------------------------------------------------------------ 2. Settings › Other fees and charges (page 5 of the letter)
create table if not exists public.letter_other_fees (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id),
 label text not null check (char_length(btrim(label)) between 1 and 200),
 amount_cents bigint check (amount_cents is null or amount_cents between 0 and 100000000), -- null prints "Free"
 is_active boolean not null default true,
 sort integer not null default 0,
 updated_at timestamptz not null default now(),
 updated_by uuid default auth.uid()
);
alter table public.letter_other_fees enable row level security;
revoke all on public.letter_other_fees from anon;
drop policy if exists letter_other_fees_staff_read on public.letter_other_fees;
create policy letter_other_fees_staff_read on public.letter_other_fees for select to authenticated using (public.cms_is_staff());
drop policy if exists letter_other_fees_admin_write on public.letter_other_fees;
create policy letter_other_fees_admin_write on public.letter_other_fees for all to authenticated using (public.cms_is_admin()) with check (public.cms_is_admin());

-- Seeded from the SLIT letter (its wording), plus the RPL fee from the owner's list.
insert into public.letter_other_fees(tenant_id, label, amount_cents, sort)
select null, x.label, x.cents, x.n from (values
 ('Application Fee (also known as Enrolment Fee)', 25000, 1),
 ('Change of COE details (On student request)', 5000, 2),
 ('Re-issue of Letter of Offer', 0, 3),
 ('Overdue tuition fee per week', 10000, 4),
 ('Deferment of Enrolment', 5000, 5),
 ('Re-Assessment 3rd Attempt', 25000, 6),
 ('Re-enrolment of unit fee after 3rd attempt or non Attendance at first', 25000, 7),
 ('New Enrolment & Re-enrolment fee', 25000, 8),
 ('Holiday Reference Letter (1st Free)', 2000, 9),
 ('Enrolment/Attendance Letter (1st free)', 2000, 10),
 ('Leave Letter (one free on every term break)', 2000, 11),
 ('Invitation letter for Family Members', 2000, 12),
 ('Release Letter (Subject to approval as per SLIT transfer policy and ESOS act)', 0, 13),
 ('Record extraction after 1 year of completion (one free per year)', 1000, 14),
 ('Re-issuing of Certificate/Transcripts', 5000, 15),
 ('Student ID Card', null, 16),
 ('Re-issue of Student ID Card', 2000, 17),
 ('RPL fee per unit', 20000, 18),
 ('Registration FEES (Future Graduate Diploma)', 75000, 19)
) as x(label, cents, n)
where not exists (select 1 from public.letter_other_fees);

-- "$250", "$12.50", "Free": as the letter prints them.
create or replace function public.letter_other_fee_amount(p_cents bigint) returns text
language sql immutable set search_path = pg_catalog as $$
 select case when p_cents is null then 'Free'
  when p_cents % 100 = 0 then '$' || to_char(p_cents / 100, 'FM999,999,990')
  else '$' || to_char(p_cents / 100.0, 'FM999,999,990.00') end;
$$;

-- Admins replace the list in one go (order = array order); the letter reads it for the application's institution, else the shared list.
create or replace function public.letter_other_fees_save(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x jsonb; n integer := 0; v_keep uuid[] := '{}'; v_id uuid;
begin
 if not public.cms_is_admin() then raise exception 'Only an administrator can change other fees and charges.' using errcode = '42501'; end if;
 for x in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
  n := n + 1;
  if btrim(coalesce(x->>'label', '')) = '' then raise exception 'Each fee needs a label.' using errcode = '22023'; end if;
  v_id := nullif(x->>'id', '')::uuid;
  if v_id is not null and exists(select 1 from public.letter_other_fees where id = v_id) then
   update public.letter_other_fees set label = btrim(x->>'label'), amount_cents = nullif(x->>'amountCents', '')::bigint,
    is_active = coalesce((x->>'isActive')::boolean, true), sort = n, updated_at = now(), updated_by = auth.uid() where id = v_id;
  else
   insert into public.letter_other_fees(tenant_id, label, amount_cents, is_active, sort)
   values (null, btrim(x->>'label'), nullif(x->>'amountCents', '')::bigint, coalesce((x->>'isActive')::boolean, true), n) returning id into v_id;
  end if;
  v_keep := v_keep || v_id;
 end loop;
 delete from public.letter_other_fees where tenant_id is null and id <> all(v_keep);
 return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'amountCents', amount_cents, 'isActive', is_active) order by sort)
  from public.letter_other_fees where tenant_id is null), '[]'::jsonb);
end $$;
revoke all on function public.letter_other_fees_save(jsonb) from public, anon;
grant execute on function public.letter_other_fees_save(jsonb) to authenticated;

-- ------------------------------------------------------------------ 3. letter variables
insert into public.letter_variables(key, grp, label, description, source_kind, source_ref, source_label, format, input_type, required, editable_source, aliases, sample, sort) values
 ('fees.application_label', 'Fees', 'Application fee label', '"Application fee", with "(Non-Refundable)" when the line is not refundable', 'fee', 'application', 'Master Data › Courses › Fees', 'text', 'text', false, false, '{}', 'Application fee (Non-Refundable)', 302),
 ('fees.application', 'Fees', 'Application fee', 'The application fee line (also known as the enrolment fee)', 'fee', 'application', 'Master Data › Courses › Fees', 'money', 'money', false, false, '{application fee}', 'AUD$250.00', 303),
 ('fees.registration_label', 'Fees', 'Registration fee label', '"Registration fee", with "(Non-Refundable)" when the line is not refundable', 'fee', 'registration', 'Master Data › Courses › Fees', 'text', 'text', false, false, '{}', 'Registration fee (Non-Refundable)', 304),
 ('fees.registration', 'Fees', 'Registration fee', 'The registration fee line ($0 when the course has none)', 'fee', 'registration', 'Master Data › Courses › Fees', 'money', 'money', false, false, '{registration fee}', 'AUD$0.00', 305),
 ('fees.gst', 'Fees', 'GST included', 'GST contained in the total fee (taxable lines only); print inside {{#if gst}} ... {{/if}}', 'computed', 'gst', 'Master Data › Courses › Fees (GST)', 'money', 'money', false, false, '{gst}', 'AUD$0.00', 341),
 ('charges.label', 'Institute', 'Other fee: name', 'One row of Settings › Other fees and charges; print inside {{#each other_fees}} ... {{/each}}', 'institute', 'other_fees', 'Website settings › Other fees and charges', 'text', 'text', false, false, '{}', 'Change of COE details', 720),
 ('charges.amount', 'Institute', 'Other fee: amount', 'The amount of that row ("Free" when it has none)', 'institute', 'other_fees', 'Website settings › Other fees and charges', 'text', 'text', false, false, '{}', '$50', 721)
on conflict (key) do nothing;


-- ------------------------------------------------------------------ 4. functions: rto_admin keeps refundable / GST; letters read the fee lines

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

CREATE OR REPLACE FUNCTION public.application_letter_course(p_ac enrollment_application_courses, p_fmt text, p_settings cms_settings, p_intake_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.cms_courses; i public.course_intakes; fc public.course_fee_setups; fi public.course_fee_setups; r public.letter_variables; v_out jsonb := '{}'::jsonb;
 raw text; val text; src text; fee_src text; v_code text; v_name text; tuition numeric; enrol numeric; mat numeric; oshc numeric;
 v_scope uuid; v_items boolean := false; v_reg numeric; v_dep numeric; v_total numeric; v_gst numeric; v_app_label text; v_reg_label text;
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
 if v_name <> '' then v_name := v_name || public.course_variant_suffix(v_name, c.variant_label); end if;
 tuition := coalesce(fi.tuition_fee, fc.tuition_fee); enrol := coalesce(fi.enrolment_fee, fc.enrolment_fee); mat := coalesce(fi.material_fee, fc.material_fee); oshc := coalesce(fi.oshc_fee, fc.oshc_fee);
 -- FEE-LOO: the fee lines (Master Data › Courses › Fees) are the source: the intake's override lines when it has any, else the course's.
 if c.id is not null then
  v_scope := case when p_ac.intake_id is not null and exists(select 1 from public.course_fee_items x where x.intake_id = p_ac.intake_id) then p_ac.intake_id end;
  v_items := exists(select 1 from public.course_fee_items x where x.course_id = c.id and x.intake_id is not distinct from v_scope);
 end if;
 if v_items then
  select sum(x.amount_cents) filter (where x.item_type in ('application', 'enrolment')) / 100.0, sum(x.amount_cents) filter (where x.item_type = 'registration') / 100.0,
   sum(x.amount_cents) filter (where x.item_type = 'material') / 100.0, sum(x.amount_cents) filter (where x.item_type = 'tuition') / 100.0,
   sum(x.amount_cents) filter (where x.item_type = 'oshc') / 100.0, sum(x.amount_cents) filter (where x.item_type = 'initial_deposit') / 100.0,
   coalesce(nullif(btrim(regexp_replace((array_agg(x.label order by x.sort) filter (where x.item_type in ('application', 'enrolment')))[1], '\s*\(non-refundable\)\s*$', '', 'i')), ''), 'Application fee')
    || case when coalesce(bool_and(x.refundable) filter (where x.item_type in ('application', 'enrolment')), false) then '' else ' (Non-Refundable)' end,
   coalesce(nullif(btrim(regexp_replace((array_agg(x.label order by x.sort) filter (where x.item_type = 'registration'))[1], '\s*\(non-refundable\)\s*$', '', 'i')), ''), 'Registration fee')
    || case when coalesce(bool_and(x.refundable) filter (where x.item_type = 'registration'), false) then '' else ' (Non-Refundable)' end
  into enrol, v_reg, mat, tuition, oshc, v_dep, v_app_label, v_reg_label
  from public.course_fee_items x where x.course_id = c.id and x.intake_id is not distinct from v_scope;
  v_total := public.course_fee_scope_total_cents(c.id, v_scope) / 100.0;
  v_gst := public.course_fee_scope_gst_cents(c.id, v_scope) / 100.0;
  fee_src := case when v_scope is not null then 'for intake ' || coalesce(nullif(i.label, ''), to_char(i.start_date, 'DD/MM/YYYY')) else 'for every intake' end;
 end if;
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
   when 'fees.deposit' then raw := case when v_items then coalesce(v_dep::text, '') else coalesce(coalesce(fi.deposit, fc.deposit)::text, '') end; src := r.source_label || ' (' || fee_src || ')';
   when 'fees.application' then raw := coalesce(enrol::text, ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.application_label' then raw := coalesce(v_app_label, 'Application fee (Non-Refundable)');
   when 'fees.registration' then raw := coalesce(v_reg, 0)::text; src := r.source_label || ' (' || fee_src || ')';
   when 'fees.registration_label' then raw := coalesce(v_reg_label, 'Registration fee (Non-Refundable)');
   when 'fees.gst' then raw := coalesce(v_gst, 0)::text; src := r.source_label || ' (' || fee_src || ')';
   when 'fees.payment_plan' then raw := coalesce(coalesce(fi.payment_plan, fc.payment_plan), ''); src := r.source_label || ' (' || fee_src || ')';
   when 'fees.total' then
    if v_items then raw := v_total::text; src := 'Master Data › Courses › Fees (total of the lines in the total, ' || fee_src || ')';
    else
    raw := coalesce(coalesce(fi.total_fee, fc.total_fee)::text, case when tuition is null then '' else (tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0))::text end);
    src := case when coalesce(fi.total_fee, fc.total_fee) is not null then 'Master Data › Courses › Total fee (' || fee_src || ')' else 'Course setup › Fees (sum, ' || fee_src || ')' end;
    end if;
   else raw := '';
  end case;
  val := case r.format when 'date' then public.letter_format_date(raw, p_fmt) when 'money' then case when raw ~ '^-?[0-9]+(\.[0-9]+)?$' then public.letter_format_money(raw::numeric) else raw end else raw end;
  v_out := v_out || jsonb_build_object(r.key, jsonb_build_object('value', coalesce(val, ''), 'raw', coalesce(raw, ''), 'source', src, 'missing', coalesce(btrim(val), '') = ''));
 end loop;
 return v_out || jsonb_build_object('_courseId', c.id, '_intakeId', p_ac.intake_id, '_feeSetup', coalesce(fi.id, fc.id), '_title', coalesce(nullif(v_name, ''), p_ac.course_title),
   '_start', i.start_date, '_end', i.end_date, '_total', case when v_items then v_total else coalesce(fi.total_fee, fc.total_fee, case when tuition is null then null else tuition + coalesce(enrol, 0) + coalesce(mat, 0) + coalesce(oshc, 0) end) end);
end $function$;

CREATE OR REPLACE FUNCTION public.application_letter_values(p_application uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; v jsonb; st public.cms_settings; ac public.enrollment_application_courses; ag public.portal_profiles; agy public.agencies;
 fmt text; today date := (now() at time zone 'Australia/Melbourne')::date; v_out jsonb := '{}'::jsonb; r public.letter_variables; raw text; val text; src text;
 v_charges jsonb := '[]'::jsonb; v_courses jsonb := '[]'::jsonb; v_first jsonb := '{}'::jsonb; v_one jsonb; v_min date; v_max date; v_sum numeric := 0; v_sum_ok boolean := true; v_intake_text text;
begin
 select * into a from public.enrollment_applications where id = p_application;
 if not found then return null; end if;
 v := coalesce(public.application_values(a.id), '{}'::jsonb);
 select * into st from public.cms_settings s where s.tenant_id is not distinct from a.tenant_id order by s.id limit 1;
 if not found then select * into st from public.cms_settings s order by s.id limit 1; end if;
 fmt := coalesce(st.letter_date_format, 'DD/MM/YYYY');
 -- FEE-LOO: Settings › Other fees and charges ({{#each other_fees}} rows): the institution's own list, else the shared one.
 select coalesce(jsonb_agg(jsonb_build_object(
    'charges.label', jsonb_build_object('value', f.label, 'raw', f.label, 'source', 'Website settings › Other fees and charges', 'missing', false),
    'charges.amount', jsonb_build_object('value', public.letter_other_fee_amount(f.amount_cents), 'raw', coalesce(f.amount_cents::text, ''), 'source', 'Website settings › Other fees and charges', 'missing', false))
   order by f.sort, f.label), '[]'::jsonb)
 into v_charges from public.letter_other_fees f
 where f.is_active and f.tenant_id is not distinct from (case when exists(select 1 from public.letter_other_fees g where g.tenant_id = a.tenant_id) then a.tenant_id end);
 v_intake_text := coalesce(nullif(btrim(a.intake), ''), btrim(coalesce(v ->> 'preferred_intake', '')));
 for ac in select * from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at, x.id loop
  v_one := public.application_letter_course(ac, fmt, st, v_intake_text);
  v_courses := v_courses || jsonb_build_array(v_one);
  if (v_one ->> '_start') is not null then v_min := least(coalesce(v_min, (v_one ->> '_start')::date), (v_one ->> '_start')::date); end if;
  if (v_one ->> '_end') is not null then v_max := greatest(coalesce(v_max, (v_one ->> '_end')::date), (v_one ->> '_end')::date); end if;
  if (v_one ->> '_total') is null then v_sum_ok := false; else v_sum := v_sum + (v_one ->> '_total')::numeric; end if;
 end loop;
 if jsonb_array_length(v_courses) = 0 then ac := null; v_first := public.application_letter_course(ac, fmt, st, v_intake_text); v_sum_ok := false;
 else v_first := v_courses -> 0; end if;
 select * into ag from public.portal_profiles x where x.id = a.assigned_agent_id;
 if not found and a.created_by is not null and exists (select 1 from public.agency_memberships m where m.user_id = a.created_by and m.role in ('agent', 'agency_admin')) then
  select * into ag from public.portal_profiles x where x.id = a.created_by;
 end if;
 select * into agy from public.agencies x where x.id = a.agency_id and not coalesce(x.is_direct, false);

 for r in select * from public.letter_variables order by sort loop
  if v_first ? r.key then v_out := v_out || jsonb_build_object(r.key, v_first -> r.key); continue; end if;
  if r.key like 'charges.%' then
   v_out := v_out || jsonb_build_object(r.key, coalesce(v_charges -> 0 -> r.key, jsonb_build_object('value', '', 'raw', '', 'source', r.source_label, 'missing', false))); continue;
  end if;
  raw := ''; src := r.source_label;
  case r.source_kind
   when 'application' then
    raw := btrim(coalesce(case when jsonb_typeof(v -> r.source_ref) = 'array' then (select string_agg(x, ', ') from jsonb_array_elements_text(v -> r.source_ref) x) else v ->> r.source_ref end, ''));
    if r.key = 'student.email' and raw = '' then raw := lower(btrim(coalesce(a.student_email, ''))); src := 'Application › Student email'; end if;
    if r.key = 'student.nationality' and raw = '' then raw := btrim(coalesce(v ->> 'citizenship', '')); src := 'Application form › Citizenship'; end if;
   when 'record' then
    raw := case r.source_ref when 'reference' then coalesce(a.reference, '') when 'submitted_at' then coalesce(to_char(a.submitted_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD'), '') else '' end;
   when 'computed' then
    if r.key = 'student.full_name' then
     raw := btrim(regexp_replace(concat_ws(' ', nullif(public.letter_format_name(v ->> 'title'), ''), nullif(public.letter_format_name(v ->> 'first_name'), ''), nullif(public.letter_format_name(v ->> 'middle_name'), ''),
       nullif(public.letter_format_name(v ->> 'last_name'), '')), '\s+', ' ', 'g'));
     if coalesce(nullif(btrim(v ->> 'first_name'), ''), nullif(btrim(v ->> 'last_name'), '')) is null then raw := ''; end if;
    elsif r.key = 'student.address' then
     raw := concat_ws(', ', nullif(btrim(v ->> 'au_street'), ''), nullif(btrim(v ->> 'au_line2'), ''),
       nullif(btrim(concat_ws(' ', nullif(btrim(v ->> 'au_suburb'), ''), nullif(btrim(v ->> 'au_state'), ''), nullif(btrim(v ->> 'au_zip'), ''))), ''));
    elsif r.key = 'offer.date' then raw := today::text;
    elsif r.key = 'offer.expiry_date' then raw := (today + coalesce(st.offer_validity_days, 30))::text; src := 'Today + ' || coalesce(st.offer_validity_days, 30) || ' days (Website settings › Offer validity)';
    elsif r.key = 'offer.first_start_date' then raw := coalesce(v_min::text, '');
    elsif r.key = 'offer.last_end_date' then raw := coalesce(v_max::text, '');
    elsif r.key = 'fees.combined_total' then raw := case when v_sum_ok then v_sum::text else '' end;
    end if;
   when 'agent' then raw := coalesce(btrim(case r.source_ref when 'full_name' then ag.full_name when 'email' then ag.email when 'phone' then ag.phone end), '');
   when 'agency' then raw := coalesce(btrim(case r.source_ref when 'name' then agy.name when 'business_email' then agy.business_email when 'phone' then agy.phone when 'address' then agy.address end), '');
   when 'institute' then raw := coalesce(btrim(to_jsonb(st) ->> r.source_ref), '');
   when 'entered' then raw := 'Nil';
   else raw := '';
  end case;
  val := case r.format
   when 'date' then public.letter_format_date(raw, fmt)
   when 'name' then case when r.key = 'student.full_name' then raw else public.letter_format_name(raw) end
   when 'money' then case when raw ~ '^-?[0-9]+(\.[0-9]+)?$' then public.letter_format_money(raw::numeric) else raw end
   else raw end;
  v_out := v_out || jsonb_build_object(r.key, jsonb_build_object('value', coalesce(val, ''), 'raw', coalesce(raw, ''), 'source', src,
    'missing', r.source_kind not in ('render', 'entered') and coalesce(btrim(val), '') = ''));
 end loop;
 return jsonb_build_object('values', v_out, 'charges', v_charges,
   'courses', coalesce((select jsonb_agg(c - '_courseId' - '_intakeId' - '_feeSetup' - '_title' - '_start' - '_end' - '_total' order by n) from jsonb_array_elements(v_courses) with ordinality as t(c, n)), '[]'::jsonb),
   'context', jsonb_build_object('courseId', v_first ->> '_courseId', 'intakeId', v_first ->> '_intakeId', 'feeSetup', v_first ->> '_feeSetup', 'courseTitle', v_first ->> '_title',
     'dateFormat', fmt, 'courseCount', jsonb_array_length(v_courses),
     'gst', exists(select 1 from jsonb_array_elements(v_courses) x where coalesce(nullif(x -> 'fees.gst' ->> 'raw', ''), '0')::numeric > 0)));
end $function$;

CREATE OR REPLACE FUNCTION public.letter_template_unmapped(p_html text)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with src as (select regexp_replace(coalesce(p_html, ''), '<[^>]*>', '', 'g') as t),
  found as (
    select '{{' || btrim(m[1]) || '}}' tok, 'curly' kind, btrim(m[1]) raw from src, regexp_matches(src.t, '\{\{\s*([^{}]{1,80}?)\s*\}\}', 'g') m
    union all select '$[' || m[1] || ']', 'old', m[1] from src, regexp_matches(src.t, '\$\[([^\[\]]{1,80})\]', 'g') m
    union all select '{' || m[1] || ':inline}', 'old', m[1] from src, regexp_matches(src.t, '\{([A-Za-z][A-Za-z0-9_ ]{0,60}):inline\}', 'g') m
    union all select '[' || m[1] || ']', 'bracket', m[1] from src, regexp_matches(src.t, '(?:^|[^$])\[([^\[\]\n]{1,80})\]', 'g') m
  )
  select coalesce(array_agg(distinct tok order by tok), '{}') from found f
  where (f.kind = 'curly' and lower(f.raw) not in ('#each courses', '#each other_fees', '/each', '#if multiple_courses', '#if gst', '/if')
          and (not exists (select 1 from public.letter_variables v where v.key = lower(btrim(split_part(f.raw, '|', 1))))
            or (position('|' in f.raw) > 0 and lower(btrim(split_part(f.raw, '|', 2))) not in ('upper', 'lower', 'raw', 'title')
                and lower(btrim(split_part(f.raw, '|', 2))) !~ '^h[0-9]{2,3}$')))
     or f.kind = 'old'
     or (f.kind = 'bracket' and exists (select 1 from public.letter_variables v, unnest(v.aliases) al where public.letter_norm(al) = public.letter_norm(f.raw)));
$function$;


-- ------------------------------------------------------------------ 5. the SLIT letter: fee rows from the shared fee function, other fees from Settings
-- Only these two tables change: "Total Fees and Charges" prints Application / Registration / Material / Tuition / Total (and GST when a
-- line is taxable), the deposit after it as before; page 5's "Other fees and charges" rows come from the list (the OSHC note stays).
do $tpl$
declare
 t hr.sign_templates; b text; b0 text; v_admin uuid;
 cell_l constant text := '<td style="width:100%"><span style="font-size:8.3pt"><span style="color:#333333"><strong>';
 cell_r constant text := '</strong></span></span></td><td style="text-align:right;width:187.5pt"><span style="font-size:8.3pt"><span style="color:#333333">';
 cell_e constant text := '</span></span></td></tr>';
 rows text;
 other text;
begin
 select * into t from hr.sign_templates where category = 'student_offer_letter' and name = 'SLIT Letter of Offer and Written Agreement' and deleted_at is null order by version desc limit 1;
 if t.id is null then raise notice 'SLIT letter not found: template unchanged'; return; end if;
 if position('{{fees.application_label}}' in t.body_html) > 0 then raise notice 'SLIT letter already uses the shared fee lines'; return; end if;
 b := t.body_html; b0 := b;

 rows := '<tr>' || cell_l || '{{fees.application_label}}:' || cell_r || '{{fees.application}}' || cell_e
  || '<tr>' || cell_l || '{{fees.registration_label}}:' || cell_r || '{{fees.registration}}' || cell_e
  || '<tr>' || cell_l || 'Material fee:' || cell_r || '{{fees.material}}' || cell_e
  || '<tr>' || cell_l || 'Tuition fee:' || cell_r || '{{fees.tuition}}' || cell_e
  || '<tr>' || cell_l || 'Total fee:' || cell_r || '{{fees.total}}' || cell_e
  || '<tr><td colspan="2">{{#if gst}}</td></tr>'
  || '<tr>' || cell_l || 'GST included:' || cell_r || '{{fees.gst}}' || cell_e
  || '<tr><td colspan="2">{{/if}}</td></tr>';
 -- From the Application fee row to the end of the Total Fee row (just before the table closes and {{/each}}).
 b := regexp_replace(b, '<tr>\s*<td style="width:100%"><span style="font-size:8\.3pt"><span style="color:#333333"><strong>Application fee \(Non-Refundable\):.*?(</tbody></table><p>\{\{/each\}\}</p><p>\{\{#if multiple_courses\}\})', rows || '\1');
 if b = b0 then raise exception 'SLIT letter: the Total Fees and Charges rows were not found'; end if;
 b := replace(b, '<strong>Initial Deposit</strong>', '<strong>Initial deposit</strong>');

 other := '<table style="width:514.5pt"><tbody><tr><td colspan="2">{{#each other_fees}}</td></tr>'
  || '<tr><td style="width:438.8pt"><span style="font-size:8.3pt"><span style="color:#333333">{{charges.label}}</span></span></td>'
  || '<td style="text-align:center;width:75.8pt"><span style="font-size:8.3pt"><span style="color:#333333">{{charges.amount}}</span></span></td></tr>'
  || '<tr><td colspan="2">{{/each}}</td></tr>'
  || '<tr><td colspan="2" style="width:514.5pt"><span style="font-size:8.3pt"><span style="color:#333333">Overseas Student Health Cover: All international students are required by the Australian Government to pay OSHC and maintain cover for the full length of their visa.</span></span></td></tr>'
  || '</tbody></table>';
 b0 := b;
 b := regexp_replace(b, '(Other fees and charges.*?)<table style="width:514\.5pt">.*?</table>', '\1' || other);
 if b = b0 then raise exception 'SLIT letter: the Other fees and charges table was not found'; end if;

 select c.auth_user_id into v_admin from public.cms_users c where c.role = 'Admin' and c.status = 'Active' and c.auth_user_id is not null order by c.created_at, c.id limit 1;
 update hr.sign_templates set body_html = b, version = version + 1, updated_at = now() where id = t.id returning * into t;
 insert into hr.sign_template_versions(template_id, version, snapshot, created_by) values (t.id, t.version, to_jsonb(t), coalesce(v_admin, t.created_by));
end $tpl$;
