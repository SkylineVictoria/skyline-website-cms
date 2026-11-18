-- INTAKE-REPLACES-BATCH stage 2b: every database function works from the intake (96 functions; written from the hosted
-- pg_get_functiondef of 2026-11-19 by mapping batches -> course_intakes, batch_sessions -> intake_class_times,
-- batch_trainers -> intake_trainers, batch_unit_trainers -> intake_units.trainer_id, batch_unit_overrides -> intake unit dates,
-- batch_id -> intake_id). Function names, arguments and JSON keys are unchanged (screens keep working; batchId values are
-- intake ids since stage 2a). rto_batch_json now takes a course_intakes row. The triggers that watched batch_id now watch
-- intake_id; the master weekly-hours check and the carry-over schedule trigger move to intake_class_times / course_intakes.
-- One transaction: if anything fails nothing changes.
begin;

-- ==== g1_rto_admin
-- rto_batch_json(b course_intakes)
drop function if exists public.rto_batch_json(public.batches);
CREATE OR REPLACE FUNCTION public.rto_batch_json(b course_intakes)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select jsonb_build_object('id', b.id, 'intakeId', b.id, 'name', public.intake_group_name(b.id), 'classroomId', b.classroom_id,
  'classroom', (select r.name from public.classrooms r where r.id = b.classroom_id), 'classDays', to_jsonb(b.class_days),
  'startTime', to_char(b.start_time, 'HH24:MI'), 'endTime', to_char(b.end_time, 'HH24:MI'), 'capacity', b.capacity, 'seats', public.rto_batch_seats(b.id), 'occupied', public.rto_batch_occupancy(b.id, current_date), 'autoCreated', b.auto_created, 'isActive', public.intake_has_group(b.id),
  'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name)) order by s.first_name, s.last_name)
     from public.intake_trainers t join hr.staff_profiles s on s.id = t.staff_id where t.intake_id = b.id), '[]'::jsonb),
  'students', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'id', s.id, 'name', s.full_name, 'email', s.email, 'type', e.enrolment_type,
     'status', e.status, 'enrolledOn', e.enrolled_on, 'path', public.rto_enrolment_path(e)) order by s.full_name) from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id
     where e.intake_id = b.id), '[]'::jsonb),
  'schedule', coalesce((select jsonb_agg(jsonb_build_object('intakeUnitId', x.id, 'code', u.code, 'name', u.name,
      'startDate', x.start_date, 'endDate', x.end_date,
      'intakeStartDate', x.start_date, 'intakeEndDate', x.end_date, 'overridden', false) order by x.sort, x.start_date)
     from public.intake_units x join public.cms_course_units u on u.id = x.unit_id
     where x.intake_id = b.id), '[]'::jsonb),
  'sessions', public.rto_batch_sessions_json(b.id),
  'startDate', lower(public.rto_batch_span(b.id)), 'endDate', upper(public.rto_batch_span(b.id)) - 1);
$function$;
-- same grants as the old rto_batch_json(batches): postgres and service_role only
revoke all on function public.rto_batch_json(public.course_intakes) from public, anon, authenticated;
grant execute on function public.rto_batch_json(public.course_intakes) to service_role;

-- rto_batch_sessions_json(uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_sessions_json(p_batch uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'weekday', s.weekday, 'slot', s.slot, 'startTime', to_char(s.start_time, 'HH24:MI'),
   'endTime', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type, 'roomId', s.room_id, 'room', r.name, 'locationId', l.id, 'location', l.name)
   order by s.weekday, s.start_time, s.sort), '[]'::jsonb)
 from public.intake_class_times s left join public.classrooms r on r.id = s.room_id left join public.locations l on l.id = r.location_id
 where s.intake_id = p_batch;
$function$;

-- rto_batch_units(uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_units(p_batch uuid)
 RETURNS TABLE(intake_unit_id uuid, unit_id text, start_date date, end_date date, sort integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select x.id, x.unit_id, x.start_date, x.end_date, x.sort
 from public.intake_units x
 where x.intake_id = p_batch;
$function$;

-- rto_batch_seats(uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_seats(p_batch uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select coalesce(least(ci.capacity, rc.cap), d.seats, 25)
 from public.course_intakes ci
 left join lateral (select min(r.capacity) as cap from public.classrooms r
   where r.capacity is not null and (r.id = ci.classroom_id or r.id in (select s.room_id from public.intake_class_times s where s.intake_id = ci.id))) rc on true
 left join public.course_class_defaults d on d.course_id = ci.course_id
 where ci.id = p_batch;
$function$;

-- rto_batch_span(uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_span(p_batch uuid)
 RETURNS daterange
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select coalesce((select daterange(min(x.start_date), greatest(min(x.start_date), max(x.end_date)), '[]')
   from public.intake_units x
   where x.intake_id = p_batch having count(*) > 0),
  (select public.rto_intake_span(ci.id) from public.course_intakes ci where ci.id = p_batch));
$function$;

-- rto_batch_occupancy(uuid,date)
CREATE OR REPLACE FUNCTION public.rto_batch_occupancy(p_batch uuid, p_on date DEFAULT CURRENT_DATE)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select count(*)::integer from public.batch_enrolments e
 where e.intake_id = p_batch and e.status in ('active', 'deferred') and e.enrolled_on <= p_on
  and coalesce((select max(u.end_date) from public.rto_enrolment_units(e.id) u), p_on) >= p_on;
$function$;

-- rto_batch_next_name(uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_next_name(p_intake uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 -- An intake is one class group: its group is named after the intake (no G1, G2, ... any more).
 return coalesce(public.intake_group_name(p_intake), 'G1');
end $function$;

-- rto_intake_default_batch(uuid)
CREATE OR REPLACE FUNCTION public.rto_intake_default_batch(p_intake uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare ti public.course_intakes; d public.course_class_defaults; x jsonb; n integer := 0;
begin
 select * into ti from public.course_intakes where id = p_intake;
 select * into d from public.course_class_defaults where course_id = ti.course_id;
 if d.course_id is null or jsonb_array_length(d.sessions) = 0 then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_clone:' || ti.id::text, 0));
 -- the intake is the class group: when its group is set up, it is the answer
 if public.intake_has_group(ti.id) then return ti.id; end if;
 update public.course_intakes set classroom_id = d.classroom_id, capacity = coalesce(capacity, d.seats), updated_at = now()
 where id = ti.id;
 for x in select value from jsonb_array_elements(d.sessions) loop
  n := n + 1;
  insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
  values (ti.id, (x->>'weekday')::integer, public.rto_slot((x->>'startTime')::time), (x->>'startTime')::time, (x->>'endTime')::time,
   coalesce(nullif(x->>'type', ''), 'theory'), d.classroom_id, n);
 end loop;
 perform public.rto_batch_sync_legacy(ti.id);
 if (coalesce(public.cms_is_rto_manager(), false) or public.rto_auto_placing()) then
  begin
   perform set_config('rto.course', ti.course_id, true);
   perform public.rto_class_sessions_generate(ti.id);
  exception when others then
   raise warning 'rto_intake_default_batch: classes not generated: %', sqlerrm;
  end;
 end if;
 return ti.id;
end $function$;

-- rto_batch_sync_legacy(uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_sync_legacy(p_batch uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 update public.course_intakes ci set
  class_days = coalesce((select array_agg(d order by n) from (select distinct s.weekday n, (array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])[s.weekday] d
     from public.intake_class_times s where s.intake_id = ci.id) z), '{}'),
  start_time = (select min(s.start_time) from public.intake_class_times s where s.intake_id = ci.id),
  end_time = (select max(s.end_time) from public.intake_class_times s where s.intake_id = ci.id),
  classroom_id = coalesce((select s.room_id from public.intake_class_times s where s.intake_id = ci.id and s.room_id is not null
     order by (s.session_type = 'theory') desc, s.weekday, s.start_time limit 1), case when exists(select 1 from public.intake_class_times s where s.intake_id = ci.id) then null else ci.classroom_id end)
 where ci.id = p_batch;
$function$;

-- rto_batch_unit_trainer(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_unit_trainer(p_batch_id uuid, p_intake_unit_id uuid, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if not public.cms_is_staff() then raise exception 'Sign in first' using errcode='42501'; end if;
 if not exists(select 1 from public.intake_units u where u.intake_id=p_batch_id and u.id=p_intake_unit_id) then raise exception 'Unit is not part of this intake'; end if;
 if p_staff_id is null then
  if not public.cms_is_rto_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  update public.intake_units set trainer_id=null where id=p_intake_unit_id and intake_id=p_batch_id;
 else
  if not public.cms_is_rto_manager() then raise exception 'Not authorized' using errcode='42501'; end if;
  if not exists(select 1 from public.intake_trainers where intake_id=p_batch_id and staff_id=p_staff_id) then raise exception 'Assign trainer to intake first' using errcode='22023'; end if;
  update public.intake_units set trainer_id=p_staff_id where id=p_intake_unit_id and intake_id=p_batch_id;
 end if;
 return jsonb_build_object('trainerId',p_staff_id);
end $function$;

-- rto_batch_unit_trainers_get(uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_unit_trainers_get(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select case when public.cms_is_staff() then coalesce((select jsonb_object_agg(id::text,trainer_id::text) from public.intake_units where intake_id=p_batch_id and trainer_id is not null),'{}'::jsonb) else '{}'::jsonb end
$function$;

-- rto_batches_hours_check(uuid[])
CREATE OR REPLACE FUNCTION public.rto_batches_hours_check(p_batches uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r jsonb := '{}'::jsonb; b record; v_needed numeric; v_weekly numeric; v_start date; v_end date; v_break integer; v_weeks numeric; v_req numeric; v_fits boolean; v_msg text;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 for b in select i.id, i.id as intake_id, i.course_id, i.start_date, i.end_date from public.course_intakes i where i.id = any(p_batches) loop
  select coalesce(sum(coalesce(cu.slit_hours, cu.nominal_hours, 0)), 0) into v_needed from public.intake_units iu join public.cms_course_units cu on cu.id = iu.unit_id where iu.intake_id = b.intake_id;
  select coalesce(sum(extract(epoch from (s.end_time - s.start_time)) / 3600.0), 0) into v_weekly from public.intake_class_times s where s.intake_id = b.id;
  v_start := b.start_date;
  v_end := coalesce(b.end_date, (select max(end_date) from public.intake_units where intake_id = b.intake_id), b.start_date);
  select coalesce(sum(greatest(0, least(ab.end_date, v_end) - greatest(ab.start_date, v_start) + 1)), 0) into v_break
  from public.academic_breaks ab where (ab.course_id is null or ab.course_id = b.course_id) and ab.end_date >= v_start and ab.start_date <= v_end;
  v_weeks := greatest(1, (v_end - v_start + 1 - v_break) / 7.0);
  v_req := round(v_needed / v_weeks, 1);
  v_fits := v_needed = 0 or v_weekly >= v_req * 0.95;
  v_msg := case when v_needed = 0 then null
   when v_weekly = 0 then 'This intake has no weekly classes, so it has no class calendar. Set its class days and times.'
   when not v_fits then format('Weekly classes give %s h; this course needs about %s h a week (%s h over %s teaching weeks) to finish by %s. Add classes, or move the intake end date.',
     round(v_weekly, 1), v_req, round(v_needed), round(v_weeks), to_char(v_end, 'DD Mon YYYY')) end;
  r := r || jsonb_build_object(b.id::text, jsonb_build_object('needed', round(v_needed), 'weekly', round(v_weekly, 1), 'weeks', round(v_weeks), 'requiredPerWeek', v_req, 'fits', v_fits, 'message', v_msg));
 end loop;
 return r;
end $function$;

-- rto_intake_json(course_intakes)
CREATE OR REPLACE FUNCTION public.rto_intake_json(i course_intakes)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select jsonb_build_object('id', i.id, 'courseId', i.course_id, 'courseCode', c.code,
  'courseName', public.course_name_variant(c.code, c.name, c.variant_label),
  'name', coalesce(nullif(btrim(i.name), ''), public.intake_auto_name(i.course_id, i.start_date, i.end_date)),
  'customName', nullif(btrim(i.name), ''), 'startDate', i.start_date, 'endDate', i.end_date, 'campus', coalesce(i.campus, c.campus),
  'capacity', i.capacity, 'status', i.status,
  'enrolled', (select count(distinct e.student_id) from public.batch_enrolments e where e.intake_id = i.id and e.status in ('active', 'deferred')),
  'batches', case when public.intake_has_group(i.id) then 1 else 0 end,
  'units', (select count(*) from public.intake_units x where x.intake_id = i.id),
  'trainers', coalesce((select jsonb_agg(distinct btrim(s.first_name || ' ' || s.last_name)) from public.intake_trainers t
     join hr.staff_profiles s on s.id = t.staff_id where t.intake_id = i.id), '[]'::jsonb),
  'hasFeeOverride', exists(select 1 from public.course_fee_items f where f.intake_id = i.id),
  'hours', (select sum(x.hours) from public.intake_units x where x.intake_id = i.id),
  'courseDuration', c.duration,
  'batchList', case when public.intake_has_group(i.id) then jsonb_build_array(jsonb_build_object('id', i.id, 'name', public.intake_group_name(i.id), 'capacity', i.capacity, 'isActive', true,
     'enrolled', (select count(*) from public.batch_enrolments e where e.intake_id = i.id and e.status in ('active', 'deferred')),
     'days', to_jsonb(i.class_days))) else '[]'::jsonb end)
 from public.cms_courses c where c.id = i.course_id;
$function$;

-- rto_admin(text,jsonb)
CREATE OR REPLACE FUNCTION public.rto_admin(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_n integer := 0;
 d jsonb := coalesce(p_data, '{}'::jsonb); v_course text := nullif(d->>'courseId', ''); v_id uuid; i public.course_intakes;
 x jsonb; n integer := 0; v_keep text[] := '{}'; v_uid text; v_count integer; v_rto boolean := public.cms_is_rto_manager(); v_direct integer := 0;
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_action in ('course_save', 'units_save', 'fees_save', 'intake_save', 'schedule_save', 'intake_delete', 'intake_fees_save', 'batch_save', 'batch_delete', 'classroom_save')
    and not v_rto then
  raise exception 'Only an RTO Manager can change courses, intakes, schedules and class groups.' using errcode = '42501';
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
   'batches', coalesce((select jsonb_agg(public.rto_batch_json(ci) || jsonb_build_object('intakeName', public.rto_intake_json(ci)->>'name') order by ci.start_date, public.intake_group_name(ci.id))
     from public.course_intakes ci where ci.course_id = c.id and public.intake_has_group(ci.id)), '[]'::jsonb))
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
   'batches', case when public.intake_has_group(i.id) then jsonb_build_array(public.rto_batch_json(i)) else '[]'::jsonb end,
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
  if exists(select 1 from public.lms_intake_students ls join public.enrollment_students st on st.id = ls.student_id
     where ls.intake_id = v_id and lower(coalesce(st.email, '')) not like '%@blackhole.postmarkapp.com') then
   raise exception 'Students are permanently allocated to this intake, so it cannot be deleted. Close it instead.' using errcode = '23503';
  end if;
  if exists(select 1 from public.course_completions cc where cc.intake_id = v_id) then
   raise exception 'Certificates were issued from this intake, so it cannot be deleted. Close it instead.' using errcode = '23503';
  end if;
  if exists(select 1 from public.asm_assignments aa where aa.intake_id = v_id) then
   raise exception 'Assessments are set for this intake. Cancel them in Assessments first, or close the intake instead.' using errcode = '23503';
  end if;
  if exists(select 1 from public.lms_attendance_register g where g.intake_id = v_id and g.state = 'final') then
   raise exception 'Attendance has been recorded for this intake, so it cannot be deleted. Close it instead.' using errcode = '23503';
  end if;
  perform set_config('rto.carry_over_planning', 'on', true);
  -- the students wait for staff to choose a new intake (not placed back automatically)
  insert into public.rto_placement_overrides(student_id, course_id, enrolment_id, action, reason, detail)
  select distinct on (e.student_id) e.student_id, ci.course_id, null, 'remove', 'Intake deleted: choose a new intake for this student',
   jsonb_build_object('intake', ci.start_date, 'intakeName', ci.name)
  from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
  where e.intake_id = v_id and e.status in ('active', 'deferred');
  get diagnostics v_n = row_count;
  delete from public.lms_attendance_marks m using public.lms_attendance_register g
   where m.register_id = g.id and g.intake_id = v_id;
  update public.batch_enrolments set continues_enrolment_id = null
   where continues_enrolment_id in (select e.id from public.batch_enrolments e where e.intake_id = v_id);
  delete from public.batch_enrolments e where e.intake_id = v_id;
  for x in select distinct to_jsonb(ac.application_id) as v from public.enrollment_application_courses ac where ac.intake_id = v_id loop
   perform set_config('portal.draft_command', x #>> '{}', true);
   update public.enrollment_application_courses set intake_id = null where intake_id = v_id and application_id = (x #>> '{}')::uuid;
  end loop;
  perform set_config('portal.draft_command', '', true);
  update public.lms_unit_students set carried_from_intake_id = null where carried_from_intake_id = v_id;
  perform set_config('rto.carry_over_planning', '', true);
  delete from public.course_intakes where id = v_id;
  return jsonb_build_object('deleted', found, 'freed', v_n);

 elsif p_action = 'batch_save' then
  -- An intake is one class group: saving its "batch" sets the intake's room, days, times, seats and trainers.
  v_id := nullif(d->>'id', '')::uuid;
  if v_id is null then
   v_id := nullif(d->>'intakeId', '')::uuid;
   if not exists(select 1 from public.course_intakes where id = v_id) then raise exception 'Intake not found' using errcode = 'P0002'; end if;
   if public.intake_has_group(v_id) then
    raise exception 'An intake is one class group: it already has its room, trainer and class times.' using errcode = '23505';
   end if;
  end if;
  if not coalesce((d->>'isActive')::boolean, true) then
   -- made inactive: the intake's group is cleared
   update public.course_intakes set classroom_id = null, updated_at = now(), updated_by = auth.uid() where id = v_id returning * into i;
   if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
   delete from public.intake_class_times where intake_id = i.id;
   delete from public.intake_trainers where intake_id = i.id;
   return public.rto_admin('intake_get', jsonb_build_object('intakeId', i.id));
  end if;
  update public.course_intakes set classroom_id = nullif(d->>'classroomId', '')::uuid,
   class_days = coalesce((select array_agg(value) from jsonb_array_elements_text(d->'classDays')), '{}'),
   start_time = nullif(d->>'startTime', '')::time, end_time = nullif(d->>'endTime', '')::time,
   capacity = nullif(d->>'capacity', '')::integer, updated_at = now(), updated_by = auth.uid()
  where id = v_id returning * into i;
  if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  if d ? 'trainerIds' then
   delete from public.intake_trainers t where t.intake_id = i.id and t.staff_id::text not in (select jsonb_array_elements_text(d->'trainerIds'));
   insert into public.intake_trainers(intake_id, staff_id) select i.id, value::uuid from jsonb_array_elements_text(d->'trainerIds') on conflict do nothing;
  end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', i.id));

 elsif p_action = 'batch_delete' then
  -- removing the "batch" clears the intake's group (room, class times, trainers)
  select * into i from public.course_intakes where id = coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  if exists(select 1 from public.batch_enrolments where intake_id = i.id and status in ('active', 'deferred', 'completed')) then
   raise exception 'Students are enrolled in this intake. Make it inactive instead.' using errcode = '23503';
  end if;
  update public.course_intakes set classroom_id = null, updated_at = now(), updated_by = auth.uid() where id = i.id;
  delete from public.intake_class_times where intake_id = i.id;
  delete from public.intake_trainers where intake_id = i.id;
  update public.intake_units set trainer_id = null where intake_id = i.id and trainer_id is not null;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', i.id));

 elsif p_action = 'enrol' then
  select * into i from public.course_intakes where id = coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  for x in select value from jsonb_array_elements(coalesce(d->'students', '[]'::jsonb)) loop
   if not public.rto_student_on_course((x->>'id')::uuid, i.course_id) then
    -- RTO Managers may enrol anyone: the student gets a draft application marked "direct enrolment". Admins keep the application rule.
    if not v_rto then raise exception 'A selected student has no application for this course.' using errcode = '22023'; end if;
    perform public.rto_direct_application((x->>'id')::uuid, i.id);
    v_direct := v_direct + 1;
   end if;
   insert into public.batch_enrolments(intake_id, student_id, enrolment_type, status)
   values (i.id, (x->>'id')::uuid, coalesce(nullif(x->>'type', ''), 'CoE'), 'active')
   on conflict (intake_id, student_id) do update set enrolment_type = excluded.enrolment_type, status = 'active';
  end loop;
  select count(*) into v_count from public.batch_enrolments where intake_id = i.id and status in ('active', 'deferred');
  if i.capacity is not null and v_count > i.capacity then raise exception 'This intake is full (% places).', i.capacity using errcode = '23514'; end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', i.id)) || jsonb_build_object('directApplications', v_direct);

 elsif p_action = 'unenrol' then
  update public.batch_enrolments e set status = 'withdrawn' where e.id = nullif(d->>'enrolmentId', '')::uuid returning e.intake_id into v_id;
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
      'batchId', ci.id, 'batch', public.intake_group_name(ci.id), 'intakeId', ci.id, 'intake', public.rto_intake_json(ci)->>'name', 'startDate', ci.start_date, 'endDate', ci.end_date,
      'courseId', c.id, 'course', public.course_name_variant(c.code, c.name, c.variant_label), 'courseCode', c.code) order by ci.start_date desc)
     from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id join public.cms_courses c on c.id = ci.course_id
     where e.student_id = v_id), '[]'::jsonb),
   'options', coalesce((select jsonb_agg(jsonb_build_object('courseId', c.id, 'course', public.course_name_variant(c.code, c.name, c.variant_label), 'courseCode', c.code,
      'linked', public.rto_student_on_course(v_id, c.id),
      'intakes', coalesce((select jsonb_agg(jsonb_build_object('id', ci.id, 'name', public.rto_intake_json(ci)->>'name', 'status', ci.status,
          'batches', case when public.intake_has_group(ci.id) then jsonb_build_array(jsonb_build_object('id', ci.id, 'name', public.intake_group_name(ci.id))) else '[]'::jsonb end)
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
end $function$;

-- ==== g4_sessions
-- rto_carry_over_open_units(uuid,text,boolean)
CREATE OR REPLACE FUNCTION public.rto_carry_over_open_units(p_student uuid, p_course text, p_fixed_only boolean)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 with en as (
  select e.id, e.intake_id from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
  where e.student_id = p_student and ci.course_id = p_course and e.status in ('active', 'deferred', 'completed')
   and not (p_fixed_only and public.rto_enrolment_pending(e))),
 needed as (select distinct iu.unit_id from en join public.intake_units iu on iu.intake_id = en.intake_id),
 taken as (select u.unit_id, u.start_date from en cross join lateral public.rto_enrolment_units(en.id) u)
 select coalesce(array_agg(n.unit_id order by n.unit_id), '{}')
 from needed n left join lateral public.rto_unit_outcome(p_student, n.unit_id) o on true
 where o.outcome is distinct from 'C'
  and not exists (select 1 from taken t where t.unit_id = n.unit_id and (o.outcome is null or o.signed_on < t.start_date));
$function$;

-- rto_carry_over_plan(uuid,text)
CREATE OR REPLACE FUNCTION public.rto_carry_over_plan(p_student uuid, p_course text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_today date := public.course_intake_today(); v_was text := coalesce(current_setting('rto.carry_over_planning', true), '');
 l record; n record; v_out text[]; v_free date; v_prev uuid; v_enrol uuid; v_batch uuid; v_units text[]; v_from date; v_to date; v_keep uuid[] := '{}'; v_go boolean := true;
 v_seen uuid[] := '{}'; v_round integer; v_latest uuid;
begin
 if p_student is null or p_course is null then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_carry_over:' || p_student::text || ':' || p_course, 0));
 perform set_config('rto.carry_over_planning', 'on', true);

 select e.id, e.status, e.carry_over, e.enrolment_type, e.intake_id as group_id, public.intake_group_name(ci.id) as group_name, ci.id as intake_id, ci.start_date, ci.study_load into l
 from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
 where e.student_id = p_student and ci.course_id = p_course and e.status in ('active', 'deferred', 'completed') and not public.rto_enrolment_pending(e) and not coalesce(e.prereq_first, false)
 order by ci.start_date desc, e.enrolled_on desc, e.id limit 1;

 if exists (select 1 from public.course_completions cc where cc.student_id = p_student and cc.course_id = p_course and cc.kind = 'certificate' and cc.revoked_at is null) then
  update public.batch_enrolments e set status = 'completed' from public.course_intakes ci
  where ci.id = e.intake_id and ci.course_id = p_course and e.student_id = p_student
   and e.status in ('active', 'deferred') and not public.rto_enrolment_pending(e);
  v_go := false;
 end if;

 if v_go and l.id is not null and exists (
  select 1 from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
  where e.student_id = p_student and ci.course_id = p_course and e.status in ('active', 'deferred') and not public.rto_enrolment_pending(e)) then
  perform public.rto_intake_auto_next(l.intake_id);
  v_out := public.rto_carry_over_open_units(p_student, p_course, true);
  select greatest(coalesce(max(u.end_date), v_today - 1), v_today - 1) into v_free
  from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
  cross join lateral public.rto_enrolment_units(e.id) u
  where e.student_id = p_student and ci.course_id = p_course and e.status in ('active', 'deferred', 'completed') and not public.rto_enrolment_pending(e);
  v_prev := l.id;

  if l.carry_over and l.status in ('active', 'deferred') and cardinality(v_out) > 0 then
   select array_agg(distinct u.unit_id), max(u.end_date) into v_units, v_to from public.rto_batch_units(l.group_id) u
   where u.unit_id = any(v_out) and u.start_date > v_free;
   v_units := public.rto_prereq_ready(l.group_id, v_units, v_out);
   select max(u.end_date) into v_to from public.rto_batch_units(l.group_id) u where u.unit_id = any(v_units);
   if v_units is not null then
    insert into public.batch_enrolment_units(enrolment_id, unit_id) select l.id, unnest(v_units) on conflict do nothing;
    v_out := array(select unnest(v_out) except select unnest(v_units));
    v_free := greatest(v_free, v_to);
   end if;
  end if;

  for v_round in 1..5 loop
   for n in select ci.id from public.course_intakes ci
    where ci.course_id = p_course and ci.is_active and ci.study_load = l.study_load and ci.start_date > l.start_date and ci.id <> all(v_seen)
    order by ci.start_date, ci.id loop
    exit when cardinality(v_out) = 0;
    v_seen := v_seen || n.id;
    v_enrol := null; v_batch := null;
    select e.id, e.intake_id into v_enrol, v_batch from public.batch_enrolments e
    where e.intake_id = n.id and e.student_id = p_student and public.rto_enrolment_pending(e) order by e.id limit 1;
    continue when v_enrol is null and exists (select 1 from public.batch_enrolments e where e.intake_id = n.id and e.student_id = p_student);
    if v_batch is null then
     v_batch := public.rto_batch_pick(n.id, l.group_name, greatest((select ci2.start_date from public.course_intakes ci2 where ci2.id = n.id), v_today), true);
    end if;
    continue when v_batch is null;
    select array_agg(distinct u.unit_id), min(u.start_date), max(u.end_date) into v_units, v_from, v_to from public.rto_batch_units(v_batch) u
    where u.unit_id = any(v_out) and u.start_date > v_free;
    v_units := public.rto_prereq_ready(v_batch, v_units, v_out);
    select min(u.start_date), max(u.end_date) into v_from, v_to from public.rto_batch_units(v_batch) u where u.unit_id = any(v_units);
    continue when v_units is null;
    if v_enrol is null then
     insert into public.batch_enrolments(intake_id, student_id, enrolment_type, status, enrolled_on, carry_over, continues_enrolment_id)
     values (v_batch, p_student, l.enrolment_type, 'active', v_from, true, v_prev) returning id into v_enrol;
    else
     update public.batch_enrolments set enrolled_on = v_from, continues_enrolment_id = v_prev
     where id = v_enrol and (enrolled_on <> v_from or continues_enrolment_id is distinct from v_prev);
    end if;
    delete from public.batch_enrolment_units where enrolment_id = v_enrol and unit_id <> all(v_units);
    insert into public.batch_enrolment_units(enrolment_id, unit_id) select v_enrol, unnest(v_units) on conflict do nothing;
    v_keep := v_keep || v_enrol; v_prev := v_enrol; v_free := v_to;
    v_out := array(select unnest(v_out) except select unnest(v_units));
   end loop;
   exit when cardinality(v_out) = 0 or v_round = 5;
   select ci.id into v_latest from public.course_intakes ci where ci.course_id = p_course and ci.study_load = l.study_load
   order by ci.start_date desc, ci.id limit 1;
   exit when public.rto_intake_auto_next(v_latest) is null;
  end loop;
 end if;

 delete from public.batch_enrolments e using public.course_intakes ci
 where ci.id = e.intake_id and ci.course_id = p_course and e.student_id = p_student
  and public.rto_enrolment_pending(e) and e.id <> all(v_keep);
 perform set_config('rto.carry_over_planning', v_was, true);
end $function$;

-- rto_carry_over_run(text)
CREATE OR REPLACE FUNCTION public.rto_carry_over_run(p_course text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_n integer := 0;
begin
 for r in select distinct e.student_id, ci.course_id from public.batch_enrolments e
  join public.course_intakes ci on ci.id = e.intake_id
  where e.status in ('active', 'deferred') and (p_course is null or ci.course_id = p_course) loop
  perform public.rto_carry_over_plan(r.student_id, r.course_id);
  v_n := v_n + 1;
 end loop;
 return v_n;
end $function$;

-- rto_carry_over_on_enrolment()
CREATE OR REPLACE FUNCTION public.rto_carry_over_on_enrolment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_course text;
begin
 if coalesce(current_setting('rto.carry_over_planning', true), '') = 'on' then return null; end if;
 begin
  for v_course in select distinct ci.course_id from public.course_intakes ci
   where ci.id in (case when tg_op <> 'INSERT' then old.intake_id end, case when tg_op <> 'DELETE' then new.intake_id end) loop
   perform public.rto_carry_over_plan(case when tg_op = 'DELETE' then old.student_id else new.student_id end, v_course);
  end loop;
 exception when others then
  raise warning 'rto_carry_over (enrolment): %', sqlerrm;
 end;
 return null;
end $function$;

-- rto_carry_over_on_outcome()
CREATE OR REPLACE FUNCTION public.rto_carry_over_on_outcome()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_course text;
begin
 begin
  for v_course in select distinct ci.course_id from public.batch_enrolments e
   join public.course_intakes ci on ci.id = e.intake_id
   where e.student_id = new.student_id and e.status in ('active', 'deferred')
    and exists (select 1 from public.intake_units iu where iu.intake_id = ci.id and iu.unit_id = new.unit_id) loop
   perform public.rto_carry_over_plan(new.student_id, v_course);
  end loop;
 exception when others then
  raise warning 'rto_carry_over (outcome): %', sqlerrm;
 end;
 return null;
end $function$;

-- rto_carry_over_on_schedule()
CREATE OR REPLACE FUNCTION public.rto_carry_over_on_schedule()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_course text;
begin
 if coalesce(current_setting('rto.carry_over_planning', true), '') = 'on' then return null; end if;
 begin
  if tg_table_name = 'course_intakes' then
   -- the transition rows are intakes themselves
   for v_course in select distinct ci.course_id from rto_changed x join public.course_intakes ci on ci.id = x.id loop
    perform public.rto_carry_over_run(v_course);
   end loop;
  else
   -- intake_units, intake_class_times (and any table whose rows carry intake_id)
   for v_course in select distinct ci.course_id from rto_changed x join public.course_intakes ci on ci.id = x.intake_id loop
    perform public.rto_carry_over_run(v_course);
   end loop;
  end if;
 exception when others then
  raise warning 'rto_carry_over (schedule): %', sqlerrm;
 end;
 return null;
end $function$;

-- rto_class_sessions_generate(uuid)
CREATE OR REPLACE FUNCTION public.rto_class_sessions_generate(p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
declare
 v_intake public.course_intakes; v_from date; v_day date; v_end date; v_fallback text;
 v_units text[] := '{}'; v_th numeric[] := '{}'; v_pr numeric[] := '{}'; v_as numeric[] := '{}';
 v_types text[]; v_left numeric; v_i int; v_pick int; v_len numeric; v_created int := 0; v_kept int; v_guard int := 0;
 u record; s record; k record;
begin
 if not (public.cms_is_rto_manager() or public.rto_auto_placing()) then raise exception 'Only an RTO Manager can generate class sessions.' using errcode = '42501'; end if;
 select i.* into v_intake from public.course_intakes i where i.id = p_batch;
 if not found then raise exception 'Intake not found.' using errcode = 'P0002'; end if;
 if exists (select 1 from public.course_master_timetables t where t.course_id = v_intake.course_id) then return public.course_master_classes(p_batch); end if; -- MASTER-STAGE2
 -- Term breaks of this course (and breaks for all courses) apply: rto_is_teaching_day reads rto.course.
 perform set_config('rto.course', v_intake.course_id, true);
 select array_agg(distinct session_type) into v_types from public.intake_class_times where intake_id = p_batch;
 if v_types is null then raise exception 'Set the intake''s weekly class times first.' using errcode = '22023'; end if;
 v_fallback := case when 'theory' = any(v_types) then 'theory' when 'practical' = any(v_types) then 'practical' else 'assessment' end;

 -- Units in teaching order: the intake's unit schedule, else the course's active units. Hours: the accepted SLIT split,
 -- else 40 / 40 / 20 of the nominal hours (the same suggestion the Units page makes).
 for u in
  with ordered as (
   select cu.id, cu.code, cu.slit_hours, cu.theory_hours, cu.practical_hours, cu.assessment_hours, cu.nominal_hours, iu.sort as o
    from public.intake_units iu join public.cms_course_units cu on cu.id = iu.unit_id where iu.intake_id = v_intake.id
   union all
   select cu.id, cu.code, cu.slit_hours, cu.theory_hours, cu.practical_hours, cu.assessment_hours, cu.nominal_hours, cu.sort
    from public.cms_course_units cu
    where cu.course_id = v_intake.course_id and cu.is_active
     and not exists(select 1 from public.intake_units iu where iu.intake_id = v_intake.id))
  select id, coalesce(slit_hours, nominal_hours, 0) as total,
   coalesce(theory_hours, round(coalesce(nominal_hours, 0) * 0.4)) as th,
   coalesce(practical_hours, round(coalesce(nominal_hours, 0) * 0.4)) as pr,
   coalesce(assessment_hours, coalesce(nominal_hours, 0) - 2 * round(coalesce(nominal_hours, 0) * 0.4)) as asm
  from ordered order by o, code
 loop
  continue when u.total <= 0;
  v_units := v_units || u.id::text; v_th := v_th || u.th::numeric; v_pr := v_pr || u.pr::numeric; v_as := v_as || u.asm::numeric;
 end loop;
 if cardinality(v_units) = 0 then raise exception 'This intake has no units with hours. Set unit hours first.' using errcode = '22023'; end if;
 for v_i in 1..cardinality(v_units) loop
  if not 'practical' = any(v_types) then
   if v_fallback = 'theory' then v_th[v_i] := v_th[v_i] + v_pr[v_i]; else v_as[v_i] := v_as[v_i] + v_pr[v_i]; end if;
   v_pr[v_i] := 0;
  end if;
  if not 'assessment' = any(v_types) then
   if v_fallback = 'theory' then v_th[v_i] := v_th[v_i] + v_as[v_i]; else v_pr[v_i] := v_pr[v_i] + v_as[v_i]; end if;
   v_as[v_i] := 0;
  end if;
  if not 'theory' = any(v_types) then
   if v_fallback = 'practical' then v_pr[v_i] := v_pr[v_i] + v_th[v_i]; else v_as[v_i] := v_as[v_i] + v_th[v_i]; end if;
   v_th[v_i] := 0;
  end if;
 end loop;

 v_from := case when exists(select 1 from public.class_sessions where intake_id = p_batch)
  then greatest(v_intake.start_date, current_date) else v_intake.start_date end;
 delete from public.class_sessions where intake_id = p_batch and not is_manual and session_date >= v_from;
 -- hours already taught or fixed by hand come off each unit
 for k in select unit_id, session_type, sum(extract(epoch from end_time - start_time) / 3600) as h
  from public.class_sessions where intake_id = p_batch and status = 'scheduled' and unit_id is not null group by 1, 2 loop
  v_i := array_position(v_units, k.unit_id);
  continue when v_i is null;
  if k.session_type = 'theory' then v_th[v_i] := v_th[v_i] - k.h;
  elsif k.session_type = 'practical' then v_pr[v_i] := v_pr[v_i] - k.h;
  else v_as[v_i] := v_as[v_i] - k.h; end if;
 end loop;
 select count(*) into v_kept from public.class_sessions where intake_id = p_batch;

 v_day := v_from;
 loop
  v_left := 0;
  for v_i in 1..cardinality(v_units) loop
   v_left := v_left + greatest(v_th[v_i], 0) + greatest(v_pr[v_i], 0) + greatest(v_as[v_i], 0);
  end loop;
  exit when v_left <= 0;
  v_guard := v_guard + 1;
  if v_guard > 1500 then raise exception 'These weekly class times cannot fit the unit hours within four years.' using errcode = '22023'; end if;
  if public.rto_is_teaching_day(v_day) then
   for s in select * from public.intake_class_times where intake_id = p_batch and weekday = extract(isodow from v_day)::int order by start_time loop
    continue when exists(select 1 from public.class_sessions c where c.intake_id = p_batch and c.session_date = v_day and c.start_time = s.start_time);
    v_pick := null;
    for v_i in 1..cardinality(v_units) loop
     if (s.session_type = 'theory' and v_th[v_i] > 0) or (s.session_type = 'practical' and v_pr[v_i] > 0)
      or (s.session_type = 'assessment' and v_as[v_i] > 0) then v_pick := v_i; exit; end if;
    end loop;
    continue when v_pick is null;
    v_len := extract(epoch from s.end_time - s.start_time) / 3600;
    if s.session_type = 'theory' then v_th[v_pick] := v_th[v_pick] - v_len;
    elsif s.session_type = 'practical' then v_pr[v_pick] := v_pr[v_pick] - v_len;
    else v_as[v_pick] := v_as[v_pick] - v_len; end if;
    insert into public.class_sessions(intake_id, session_date, start_time, end_time, session_type, room_id, unit_id)
     values (p_batch, v_day, s.start_time, s.end_time, s.session_type, s.room_id, v_units[v_pick])
     on conflict (intake_id, session_date, start_time) do nothing;
    v_created := v_created + 1;
   end loop;
  end if;
  v_day := v_day + 1;
 end loop;
 select max(session_date) into v_end from public.class_sessions where intake_id = p_batch;
 return jsonb_build_object('created', v_created, 'kept', v_kept, 'from', v_from, 'endDate', v_end,
  'clashes', public.rto_class_session_clashes(p_batch));
end $function$;

-- rto_class_sessions_list(uuid,date,date)
CREATE OR REPLACE FUNCTION public.rto_class_sessions_list(p_batch uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
  raise exception 'Choose a date range of up to 400 days.' using errcode = '22023'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id', c.id, 'batchId', c.intake_id, 'batch', g.name, 'courseCode', co.code, 'date', c.session_date,
   'startTime', c.start_time, 'endTime', c.end_time, 'type', c.session_type, 'roomId', c.room_id, 'room', r.name,
   'unitId', c.unit_id, 'unitCode', u.code, 'unitName', u.name, 'status', c.status, 'manual', c.is_manual,
   'trainers', (select coalesce(string_agg(btrim(concat_ws(' ', sp.first_name, sp.last_name)), ', '), '')
     from public.intake_trainers it join hr.staff_profiles sp on sp.id = it.staff_id where it.intake_id = c.intake_id))
   order by c.session_date, c.start_time, g.name)
  from public.class_sessions c
  join public.course_intakes i on i.id = c.intake_id
  cross join lateral (select public.intake_group_name(c.intake_id) as name) g
  join public.cms_courses co on co.id = i.course_id
  left join public.classrooms r on r.id = c.room_id
  left join public.cms_course_units u on u.id = c.unit_id
  where (p_batch is null or c.intake_id = p_batch) and c.session_date between p_from and p_to), '[]'::jsonb);
end $function$;

-- rto_class_sessions_reset(uuid,boolean)
CREATE OR REPLACE FUNCTION public.rto_class_sessions_reset(p_batch uuid, p_regenerate boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_removed int; v_out jsonb := '{}'::jsonb;
begin
 if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can remove or recreate a course calendar.' using errcode = '42501'; end if;
 if not exists(select 1 from public.course_intakes where id = p_batch) then raise exception 'Intake not found.' using errcode = 'P0002'; end if;
 delete from public.class_sessions where intake_id = p_batch;
 get diagnostics v_removed = row_count;
 if p_regenerate then v_out := public.rto_class_sessions_generate(p_batch); end if;
 return v_out || jsonb_build_object('removed', v_removed);
end $function$;

-- rto_class_session_update(uuid,jsonb)
CREATE OR REPLACE FUNCTION public.rto_class_session_update(p_id uuid, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.class_sessions;
begin
 if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can change class sessions.' using errcode = '42501'; end if;
 if p_data ? 'status' and p_data->>'status' not in ('scheduled', 'cancelled') then
  raise exception 'Status must be scheduled or cancelled.' using errcode = '22023'; end if;
 update public.class_sessions set
  status = coalesce(p_data->>'status', status),
  room_id = case when p_data ? 'roomId' then nullif(p_data->>'roomId', '')::uuid else room_id end,
  session_date = coalesce((p_data->>'date')::date, session_date),
  start_time = coalesce((p_data->>'startTime')::time, start_time),
  end_time = coalesce((p_data->>'endTime')::time, end_time),
  is_manual = true, updated_at = now(), updated_by = auth.uid()
 where id = p_id returning * into v;
 if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
 return jsonb_build_object('id', v.id, 'clashes', public.rto_class_session_clashes(v.intake_id));
end $function$;

-- rto_class_session_clashes(uuid)
CREATE OR REPLACE FUNCTION public.rto_class_session_clashes(p_batch uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select coalesce(jsonb_agg(jsonb_build_object('date', a.session_date, 'startTime', a.start_time, 'room', r.name, 'otherBatch', public.intake_group_name(o.intake_id))
  order by a.session_date, a.start_time), '[]'::jsonb)
 from public.class_sessions a
 join public.class_sessions o on o.room_id = a.room_id and o.session_date = a.session_date and o.intake_id <> a.intake_id
  and o.status = 'scheduled' and o.start_time < a.end_time and a.start_time < o.end_time
 join public.classrooms r on r.id = a.room_id
 join public.course_intakes oi on oi.id = o.intake_id
 where a.intake_id = p_batch and a.status = 'scheduled';
$function$;

-- rto_session_clashes(uuid,uuid,jsonb)
CREATE OR REPLACE FUNCTION public.rto_session_clashes(p_batch uuid, p_intake uuid, p_sessions jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 with mine as (
  select (s->>'weekday')::smallint weekday, (s->>'startTime')::time st, (s->>'endTime')::time et, (s->>'roomId')::uuid room_id
  from jsonb_array_elements(case when jsonb_typeof(p_sessions) = 'array' then p_sessions else '[]'::jsonb end) s
  where nullif(s->>'roomId', '') is not null and nullif(s->>'startTime', '') is not null and nullif(s->>'endTime', '') is not null
    and nullif(s->>'weekday', '') is not null and (s->>'endTime')::time > (s->>'startTime')::time
 ), span as (select coalesce(case when p_batch is not null then public.rto_batch_span(p_batch) end, public.rto_intake_span(p_intake)) r)
 select coalesce(jsonb_agg(distinct jsonb_build_object('roomId', m.room_id, 'room', r.name, 'weekday', m.weekday,
   'startTime', to_char(m.st, 'HH24:MI'), 'endTime', to_char(m.et, 'HH24:MI'), 'otherBatchId', oi.id, 'otherBatch', public.intake_group_name(oi.id),
   'otherCourseCode', oc.code, 'otherIntakeId', oi.id, 'otherStart', to_char(o.start_time, 'HH24:MI'), 'otherEnd', to_char(o.end_time, 'HH24:MI'))), '[]'::jsonb)
 from mine m cross join span
 join public.intake_class_times o on o.room_id = m.room_id and o.weekday = m.weekday and o.start_time < m.et and m.st < o.end_time
 join public.course_intakes oi on oi.id = o.intake_id and public.intake_has_group(oi.id) and oi.id is distinct from coalesce(p_batch, p_intake)
 join public.cms_courses oc on oc.id = oi.course_id
 join public.classrooms r on r.id = m.room_id
 where span.r is not null and public.rto_batch_span(oi.id) && span.r;
$function$;

-- ==== g3_placement
-- rto_batch_seat_guard()
CREATE OR REPLACE FUNCTION public.rto_batch_seat_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_seats integer;
begin
 if new.status not in ('active', 'deferred') then return new; end if;
 if tg_op = 'UPDATE' and old.intake_id = new.intake_id and old.status in ('active', 'deferred') then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_seats:' || new.intake_id::text, 0));
 v_seats := public.rto_batch_seats(new.intake_id);
 if public.rto_batch_occupancy(new.intake_id, new.enrolled_on) >= v_seats then
  raise exception '% is full (% seats).', public.intake_group_name(new.intake_id), v_seats using errcode = '23514';
 end if;
 return new;
end $function$;

-- batch_enrolments_auto_only()
CREATE OR REPLACE FUNCTION public.batch_enrolments_auto_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
 if public.rto_auto_placing() or coalesce(current_setting('rto.carry_over_planning', true), '') = 'on' then return new; end if;
 raise exception 'Students are placed in intakes automatically when their offer is accepted.' using errcode = '42501';
end $function$;

-- rto_batch_pick(uuid,text,date,boolean)
CREATE OR REPLACE FUNCTION public.rto_batch_pick(p_intake uuid, p_prefer text DEFAULT NULL::text, p_on date DEFAULT CURRENT_DATE, p_same boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare ti public.course_intakes; b record; v_src uuid;
begin
 select * into ti from public.course_intakes where id = p_intake;
 if ti.id is null then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_pick:' || ti.course_id, 0));
 if exists (select 1 from public.course_master_timetables t where t.course_id = ti.course_id) then -- MASTER-STAGE2: an intake is one group
  for b in select ci.id from public.course_intakes ci
    where public.intake_has_group(ci.id) and ci.course_id = ti.course_id and ci.study_load = ti.study_load
     and (ci.id = ti.id or (not p_same and ci.is_active and ci.status = 'open' and coalesce(ci.end_date, 'infinity'::date) >= p_on))
    order by (ci.id = ti.id) desc, ci.name nulls last, ci.created_at loop
   if public.rto_batch_occupancy(b.id, p_on) < public.rto_batch_seats(b.id) then return b.id; end if;
  end loop;
  -- an intake without a group gets it from the course's usual class times, when those give the hours the master needs
  if not public.intake_has_group(ti.id)
   and coalesce((select sum(extract(epoch from ((x->>'endTime')::time - (x->>'startTime')::time))) / 3600.0
     from public.course_class_defaults cd, jsonb_array_elements(cd.sessions) x where cd.course_id = ti.course_id), 0)
    >= coalesce(public.course_master_weekly_need(ti.course_id), 0) - 0.01 then
   return public.rto_intake_default_batch(ti.id);
  end if;
  return null;
 end if;
 for b in
  select ci.id from public.course_intakes ci
  where public.intake_has_group(ci.id) and ci.course_id = ti.course_id and ci.study_load = ti.study_load
   and (ci.id = ti.id or (not p_same and ci.status = 'open' and ci.start_date <= p_on and coalesce(ci.end_date, 'infinity'::date) >= p_on))
  order by (ci.id = ti.id) desc, (public.intake_group_name(ci.id) = p_prefer) desc, ci.start_date
 loop
  if public.rto_batch_occupancy(b.id, p_on) < public.rto_batch_seats(b.id) then return b.id; end if;
 end loop;
 -- An intake is one group: a full intake never gets another one (the student waits).
 if public.intake_has_group(ti.id) then return null; end if;
 -- This intake has no group yet: set it up from an intake whose class times work (dated classes first, then the most weekly hours).
 select ci.id into v_src from public.course_intakes ci
 where ci.id <> ti.id and public.intake_has_group(ci.id) and ci.course_id = ti.course_id and ci.study_load = ti.study_load
 order by exists (select 1 from public.class_sessions cs where cs.intake_id = ci.id) desc,
  (select coalesce(sum(extract(epoch from (s.end_time - s.start_time))), 0) from public.intake_class_times s where s.intake_id = ci.id) desc,
  ci.start_date desc limit 1;
 if v_src is null then return public.rto_intake_default_batch(ti.id); end if;
 return public.rto_batch_clone(v_src, ti.id);
end $function$;

-- rto_batch_assign(uuid,text,uuid,text,date)
CREATE OR REPLACE FUNCTION public.rto_batch_assign(p_student uuid, p_course text, p_intake uuid DEFAULT NULL::uuid, p_type text DEFAULT 'CoE'::text, p_on date DEFAULT CURRENT_DATE)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_intake uuid := p_intake; v_batch uuid; v_enrol uuid; v_latest uuid; v_on date := p_on; v_next uuid; v_src public.course_intakes;
 v_pbatch uuid; v_p text[]; v_from date; v_to date; v_return date; v_round integer; v_penrol uuid; v_was text; n record; v_n integer;
begin
 if not public.rto_auto_placing() then raise exception 'Students are placed in intakes automatically when their offer is accepted.' using errcode = '42501'; end if;
 if v_intake is null then
  v_intake := public.rto_open_intake(p_course, v_on);
  if v_intake is null then
   select ci.id into v_latest from public.course_intakes ci where ci.course_id = p_course order by ci.start_date desc limit 1;
   if v_latest is not null then v_intake := public.rto_intake_auto_next(v_latest); end if;
  end if;
  if v_intake is null then raise exception 'This course has no open intake. Add one first.' using errcode = '22023'; end if;
 end if;
 select e.id into v_enrol from public.batch_enrolments e
 where e.intake_id = v_intake and e.student_id = p_student and e.status in ('active', 'deferred') order by e.carry_over, e.enrolled_on limit 1;
 if v_enrol is not null then return v_enrol; end if;
 if public.rto_prereq_missed(p_student, v_intake, v_on) then
  select * into v_src from public.course_intakes where id = v_intake;
  -- the prerequisite units this student missed here (they ended before the join day and are not Competent)
  select array_agg(distinct p.unit_id) into v_p from public.intake_units p
  where p.intake_id = v_intake and p.start_date < v_on
   and exists (select 1 from public.intake_units x where x.intake_id = v_intake and x.unit_id <> p.unit_id and p.unit_id in (select public.rto_unit_requires_all(x.unit_id)))
   and not exists (select 1 from public.rto_unit_outcome(p_student, p.unit_id) o where o.outcome = 'C');
  if v_p is not null and exists (select 1 from public.course_master_timetables t where t.course_id = v_src.course_id) then -- MASTER-STAGE3
   v_from := v_on;
   -- JOIN-AT-NEXT-UNIT: prerequisites that run while the student is still catching up are added too, until the list is stable
   for v_round in 1..10 loop
    v_return := public.course_master_catchup_end(v_src.course_id, v_p, v_from);
    v_on := coalesce((select min(iu.start_date) from public.intake_units iu where iu.intake_id = v_intake and iu.start_date > v_return), v_return + 1);
    select count(*) into v_n from unnest(v_p);
    select array_agg(distinct p.unit_id) into v_p from public.intake_units p
    where p.intake_id = v_intake and p.start_date < v_on
     and exists (select 1 from public.intake_units x where x.intake_id = v_intake and x.unit_id <> p.unit_id and p.unit_id in (select public.rto_unit_requires_all(x.unit_id)))
     and not exists (select 1 from public.rto_unit_outcome(p_student, p.unit_id) o where o.outcome = 'C');
    exit when cardinality(v_p) = v_n;
   end loop;
  end if;
  -- a later intake that teaches them on or after the join day (made automatically if there is none yet)
  for v_round in 1..3 loop
   for n in select ci.id, ci.start_date from public.course_intakes ci
     where ci.course_id = v_src.course_id and ci.study_load = v_src.study_load and ci.is_active and coalesce(ci.status, 'open') = 'open' and ci.start_date > v_src.start_date
     order by ci.start_date, ci.id loop
    v_pbatch := public.rto_batch_pick(n.id, null, greatest(n.start_date, v_on), true);
    continue when v_pbatch is null;
    select min(u.start_date) into v_from from public.rto_batch_units(v_pbatch) u where u.unit_id = any(v_p);
    if v_from is not null and v_from >= v_on then v_next := n.id; exit; end if;
    v_pbatch := null;
   end loop;
   exit when v_next is not null;
   select ci.id into v_latest from public.course_intakes ci where ci.course_id = v_src.course_id and ci.study_load = v_src.study_load order by ci.start_date desc, ci.id limit 1;
   exit when public.rto_intake_auto_next(v_latest) is null;
  end loop;
  if v_next is not null then
   -- prerequisites that also end before the student could come back are added, until stable
   v_return := v_on;
   for v_round in 1..6 loop
    select max(u.end_date) into v_to from public.rto_batch_units(v_pbatch) u where u.unit_id = any(v_p);
    select min(iu.start_date) into v_return from public.intake_units iu where iu.intake_id = v_intake and iu.start_date > v_to;
    exit when v_return is null;
    select count(*) into v_n from unnest(v_p);
    select array_agg(distinct p.unit_id) into v_p from public.intake_units p
    where p.intake_id = v_intake and p.start_date < v_return
     and exists (select 1 from public.intake_units x where x.intake_id = v_intake and x.unit_id <> p.unit_id and p.unit_id in (select public.rto_unit_requires_all(x.unit_id)))
     and not exists (select 1 from public.rto_unit_outcome(p_student, p.unit_id) o where o.outcome = 'C');
    exit when cardinality(v_p) = v_n;
   end loop;
   select min(u.start_date) into v_from from public.rto_batch_units(v_pbatch) u where u.unit_id = any(v_p);
   if v_return is not null and v_from >= v_on then
    v_was := coalesce(current_setting('rto.carry_over_planning', true), '');
    perform set_config('rto.carry_over_planning', 'on', true);
    insert into public.batch_enrolments(intake_id, student_id, enrolment_type, status, enrolled_on, carry_over, prereq_first)
    values (v_pbatch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_from, true, true)
    on conflict (intake_id, student_id) do update set status = 'active', enrolled_on = excluded.enrolled_on, carry_over = true, prereq_first = true
    returning id into v_penrol;
    delete from public.batch_enrolment_units where enrolment_id = v_penrol;
    insert into public.batch_enrolment_units(enrolment_id, unit_id) select v_penrol, unnest(v_p) on conflict do nothing;
    perform set_config('rto.carry_over_planning', v_was, true);
    v_on := v_return;  -- back to the running intake at the start of its next unit after the prerequisites
   else
    -- nothing left to come back to: start that intake from its first day
    select ci.start_date into v_on from public.course_intakes ci where ci.id = v_next;
    v_intake := v_next;
    select e.id into v_enrol from public.batch_enrolments e
    where e.intake_id = v_intake and e.student_id = p_student and e.status in ('active', 'deferred') order by e.carry_over, e.enrolled_on limit 1;
    if v_enrol is not null then return v_enrol; end if;
   end if;
  end if;
 end if;
 -- coming back after prerequisites: this intake only (not another running intake)
 v_batch := public.rto_batch_pick(v_intake, null, v_on, v_penrol is not null);
 if v_batch is null then
  raise exception 'No intake with a free seat could be found for this student. Set the course''s class days and times first.' using errcode = '22023';
 end if;
 if not public.rto_student_on_course(p_student, p_course) then
  perform public.rto_direct_application(p_student, v_intake);
 end if;
 insert into public.batch_enrolments(intake_id, student_id, enrolment_type, status, enrolled_on)
 values (v_batch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_on)
 on conflict (intake_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type
 returning id into v_enrol;
 if v_return is not null and v_p is not null and exists (select 1 from public.course_master_timetables t where t.course_id = p_course) then -- MASTER-STAGE3
  perform public.course_master_catchup_set(v_enrol, v_p, v_from);
 end if;
 return v_enrol;
end $function$;

-- rto_batch_place(text,jsonb)
CREATE OR REPLACE FUNCTION public.rto_batch_place(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_rto boolean := coalesce(public.cms_is_rto_manager(), false); v_admin boolean := coalesce(public.cms_is_admin(), false);
 v_enrol uuid; b public.course_intakes; v_before integer; v_new uuid; v_course text; v_on date; v_target uuid;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;

 if p_action = 'assign' then
  if not (v_rto or v_admin) then raise exception 'Only an Admin or an RTO Manager can place students.' using errcode = '42501'; end if;
  v_on := coalesce(nullif(d->>'on', '')::date, current_date);
  v_course := coalesce(nullif(d->>'courseId', ''), (select course_id from public.course_intakes where id = nullif(d->>'intakeId', '')::uuid));
  if v_course is null then raise exception 'Choose a course or an intake.' using errcode = '22023'; end if;
  select count(*) into v_before from public.course_intakes where course_id = v_course and public.intake_has_group(id);
  v_enrol := public.rto_batch_assign((d->>'studentId')::uuid, v_course, nullif(d->>'intakeId', '')::uuid, coalesce(d->>'type', 'CoE'), v_on);
  select ci.* into b from public.course_intakes ci join public.batch_enrolments e on e.intake_id = ci.id where e.id = v_enrol;
  return jsonb_build_object('enrolmentId', v_enrol, 'batchId', b.id, 'batch', public.intake_group_name(b.id), 'intakeId', b.id, 'seats', public.rto_batch_seats(b.id),
   'occupied', public.rto_batch_occupancy(b.id, v_on),
   'openedBatch', (select count(*) from public.course_intakes where course_id = v_course and public.intake_has_group(id)) > v_before);

 elsif p_action = 'batch_open' then
  if not v_rto then raise exception 'Only an RTO Manager can open intakes.' using errcode = '42501'; end if;
  v_target := coalesce(nullif(d->>'intakeId', '')::uuid, nullif(d->>'batchId', '')::uuid);
  if v_target is null or not exists (select 1 from public.course_intakes where id = v_target) then raise exception 'Intake not found.' using errcode = 'P0002'; end if;
  if public.intake_has_group(v_target) then
   raise exception 'An intake is one class group: it already has its room, trainer and class times.' using errcode = '23505';
  end if;
  v_new := public.rto_batch_clone(coalesce(nullif(d->>'batchId', '')::uuid, v_target), v_target);
  if v_new is null then raise exception 'Intake not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('batchId', v_new, 'name', public.intake_group_name(v_new), 'needsRoom', (select classroom_id is null from public.course_intakes where id = v_new));

 elsif p_action = 'defaults_get' then
  return coalesce((select jsonb_build_object('courseId', course_id, 'seats', seats, 'classroomId', classroom_id, 'sessions', sessions)
   from public.course_class_defaults where course_id = d->>'courseId'), jsonb_build_object('courseId', d->>'courseId', 'seats', null, 'classroomId', null, 'sessions', '[]'::jsonb));

 elsif p_action = 'defaults_set' then
  if not v_rto then raise exception 'Only an RTO Manager can change course class defaults.' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(d->'sessions', '[]'::jsonb)) <> 'array' then raise exception 'Sessions must be a list.' using errcode = '22023'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(d->'sessions', '[]'::jsonb)) x
   where coalesce((x->>'weekday')::integer, 0) not between 1 and 7 or (x->>'startTime') !~ '^[0-2][0-9]:[0-5][0-9]$' or (x->>'endTime') !~ '^[0-2][0-9]:[0-5][0-9]$'
    or (x->>'endTime')::time <= (x->>'startTime')::time or coalesce(nullif(x->>'type', ''), 'theory') not in ('theory', 'practical', 'assessment')) then
   raise exception 'Each class needs a day (1-7), a start and a later end time, and a type.' using errcode = '22023';
  end if;
  insert into public.course_class_defaults(course_id, seats, classroom_id, sessions, updated_at, updated_by)
  values (d->>'courseId', nullif(d->>'seats', '')::integer, nullif(d->>'classroomId', '')::uuid, coalesce(d->'sessions', '[]'::jsonb), now(), auth.uid())
  on conflict (course_id) do update set seats = excluded.seats, classroom_id = excluded.classroom_id, sessions = excluded.sessions, updated_at = now(), updated_by = auth.uid();
  return public.rto_batch_place('defaults_get', jsonb_build_object('courseId', d->>'courseId'));

 elsif p_action = 'seat_board' then
  return coalesce((select jsonb_agg(jsonb_build_object('batchId', ci.id, 'batch', public.intake_group_name(ci.id), 'course', c.name, 'courseId', c.id, 'intakeId', ci.id, 'intakeStart', ci.start_date,
    'room', r.name, 'location', l.name, 'seats', public.rto_batch_seats(ci.id), 'occupied', public.rto_batch_occupancy(ci.id, current_date),
    'needsRoom', ci.classroom_id is null, 'autoCreated', ci.auto_created) order by l.name nulls last, r.name nulls last, c.name, ci.start_date)
   from public.course_intakes ci join public.cms_courses c on c.id = ci.course_id
   left join public.classrooms r on r.id = ci.classroom_id left join public.locations l on l.id = r.location_id
   where public.intake_has_group(ci.id) and ci.status in ('open', 'draft') and coalesce(ci.end_date, 'infinity'::date) >= current_date), '[]'::jsonb);

 elsif p_action = 'unplaced' then
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'intakeId', ci.id, 'courseId', ci.course_id, 'course', c.name, 'intakeStart', ci.start_date)
    order by ci.start_date, s.full_name)
   from public.lms_intake_students li join public.course_intakes ci on ci.id = li.intake_id join public.cms_courses c on c.id = ci.course_id
   join public.enrollment_students s on s.id = li.student_id
   where not exists(select 1 from public.batch_enrolments e
     where e.intake_id = li.intake_id and e.student_id = li.student_id and e.status in ('active', 'deferred', 'completed'))), '[]'::jsonb);
 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $function$;

-- rto_auto_place_one(uuid)
CREATE OR REPLACE FUNCTION public.rto_auto_place_one(p_app uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.enrollment_applications; c record; i public.course_intakes; n integer := 0;
begin
 select * into a from public.enrollment_applications where id = p_app;
 if a.id is null or a.student_id is null or a.status not in ('offer_accepted', 'coe_issued', 'enrolled') then return 0; end if;
 for c in select * from public.enrollment_application_courses where application_id = a.id loop
  if exists (select 1 from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
   where e.student_id = a.student_id and ci.course_id = c.course_id and e.status in ('active', 'deferred', 'completed')) then continue; end if;
  -- Staff removed this student from the course by hand: leave them out.
  if exists (select 1 from public.rto_placement_overrides o where o.student_id = a.student_id and o.course_id = c.course_id and o.action = 'remove'
   and not exists (select 1 from public.rto_placement_overrides o2 where o2.student_id = o.student_id and o2.course_id = o.course_id and o2.action = 'place' and o2.at > o.at)) then continue; end if;
  i := null;
  if c.intake_id is not null then select * into i from public.course_intakes where id = c.intake_id; end if;
  begin
   perform set_config('rto.auto_place', 'on', true);
   perform public.rto_batch_assign(a.student_id, c.course_id, c.intake_id, case when i.study_load = 'voe' then 'VoE' else 'CoE' end,
    greatest(public.course_intake_today(), coalesce(i.start_date, public.course_intake_today())));
   n := n + 1;
  exception when others then null;
  end;
  perform set_config('rto.auto_place', 'off', true);
 end loop;
 return n;
end $function$;

-- rto_application_placement()
CREATE OR REPLACE FUNCTION public.rto_application_placement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if new.status in ('offer_accepted', 'coe_issued', 'enrolled') and old.status is distinct from new.status then
  begin perform public.rto_auto_place_one(new.id); exception when others then null; end;
 elsif new.status in ('withdrawn', 'rejected') and old.status in ('offer_accepted', 'coe_issued', 'enrolled') then
  update public.batch_enrolments e set status = 'withdrawn'
  where e.student_id = new.student_id and e.status in ('active', 'deferred')
   and e.intake_id in (select ci.id from public.course_intakes ci
    where ci.course_id in (select c.course_id from public.enrollment_application_courses c where c.application_id = new.id));
 end if;
 return new;
end $function$;

-- rto_lms_place_student()
CREATE OR REPLACE FUNCTION public.rto_lms_place_student()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_course text;
begin
 select ci.course_id into v_course from public.course_intakes ci where ci.id = new.intake_id;
 if exists(select 1 from public.batch_enrolments e
   where e.intake_id = new.intake_id and e.student_id = new.student_id and e.status in ('active', 'deferred', 'completed')) then
  return null;
 end if;
 begin
  perform set_config('rto.auto_place', 'on', true);
  perform public.rto_batch_assign(new.student_id, v_course, new.intake_id, 'CoE', greatest((new.enrolled_at at time zone 'Australia/Melbourne')::date, (select start_date from public.course_intakes where id = new.intake_id)));
 exception when others then null;
 end;
 perform set_config('rto.auto_place', 'off', true);
 return null;
end $function$;

-- rto_staff_place(uuid,uuid,text,date,text)
CREATE OR REPLACE FUNCTION public.rto_staff_place(p_batch uuid, p_student uuid, p_type text, p_on date, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare i public.course_intakes; v_on date := coalesce(p_on, public.course_intake_today()); v_enrol uuid;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can place a student by hand.' using errcode = '42501'; end if;
 if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are placing this student by hand.' using errcode = '22023'; end if;
 select * into i from public.course_intakes where id = p_batch;
 if i.id is null or not public.intake_has_group(i.id) then raise exception 'Choose an active intake.' using errcode = '22023'; end if;
 if v_on < i.start_date then raise exception 'The student cannot join before the intake starts (%).', i.start_date using errcode = '22023'; end if;
 if i.end_date is not null and v_on > i.end_date then raise exception 'The student cannot join after the intake ends (%).', i.end_date using errcode = '22023'; end if;
 if not public.rto_student_on_course(p_student, i.course_id) then perform public.rto_direct_application(p_student, i.id); end if;
 perform set_config('rto.auto_place', 'on', true);
 insert into public.batch_enrolments(intake_id, student_id, enrolment_type, status, enrolled_on)
 values (i.id, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_on)
 on conflict (intake_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type, enrolled_on = excluded.enrolled_on
 returning id into v_enrol;
 perform set_config('rto.auto_place', 'off', true);
 insert into public.rto_placement_overrides(student_id, course_id, intake_id, enrolment_id, action, reason, detail)
 values (p_student, i.course_id, i.id, v_enrol, 'place', btrim(p_reason), jsonb_build_object('on', v_on, 'type', p_type));
 return jsonb_build_object('enrolmentId', v_enrol, 'batchId', i.id, 'batch', public.intake_group_name(i.id), 'intakeId', i.id, 'joinedOn', v_on);
end $function$;

-- rto_staff_move(uuid,uuid,text)
CREATE OR REPLACE FUNCTION public.rto_staff_move(p_enrolment uuid, p_to_batch uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.batch_enrolments; src public.course_intakes; dst public.course_intakes;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can move a student.' using errcode = '42501'; end if;
 if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are moving this student.' using errcode = '22023'; end if;
 select * into e from public.batch_enrolments where id = p_enrolment;
 if e.id is null then raise exception 'Enrolment not found.' using errcode = 'P0002'; end if;
 select * into src from public.course_intakes where id = e.intake_id;
 select * into dst from public.course_intakes where id = p_to_batch;
 if dst.id is null or not public.intake_has_group(dst.id) or dst.course_id <> src.course_id then raise exception 'Choose an active intake of the same course.' using errcode = '22023'; end if;
 if exists (select 1 from public.batch_enrolments x where x.intake_id = p_to_batch and x.student_id = e.student_id and x.id <> e.id and x.status in ('active', 'deferred')) then raise exception 'The student is already in that intake.' using errcode = '22023'; end if;
 update public.batch_enrolments set intake_id = p_to_batch where id = e.id;
 insert into public.rto_placement_overrides(student_id, course_id, intake_id, enrolment_id, action, reason, detail)
 values (e.student_id, src.course_id, p_to_batch, e.id, 'move', btrim(p_reason), jsonb_build_object('from', e.intake_id));
 return jsonb_build_object('enrolmentId', e.id, 'batchId', p_to_batch);
end $function$;

-- rto_staff_remove(uuid,text)
CREATE OR REPLACE FUNCTION public.rto_staff_remove(p_enrolment uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.batch_enrolments; ci public.course_intakes;
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or coalesce(public.cms_is_admin(), false)) then raise exception 'Only an Admin or an RTO Manager can remove a student.' using errcode = '42501'; end if;
 if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why you are removing this student.' using errcode = '22023'; end if;
 select * into e from public.batch_enrolments where id = p_enrolment;
 if e.id is null then raise exception 'Enrolment not found.' using errcode = 'P0002'; end if;
 select c.* into ci from public.course_intakes c where c.id = e.intake_id;
 update public.batch_enrolments set status = 'withdrawn' where id = e.id;
 insert into public.rto_placement_overrides(student_id, course_id, intake_id, enrolment_id, action, reason) values (e.student_id, ci.course_id, e.intake_id, e.id, 'remove', btrim(p_reason));
 return jsonb_build_object('enrolmentId', e.id, 'status', 'withdrawn');
end $function$;

-- rto_placement_waiting()
CREATE OR REPLACE FUNCTION public.rto_placement_waiting()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'courseId', c.course_id, 'courseName', coalesce(nullif(c.course_title, ''), c.course_code),
   'intakeId', c.intake_id, 'since', a.updated_at) order by a.updated_at)
  from public.enrollment_applications a join public.enrollment_application_courses c on c.application_id = a.id join public.enrollment_students s on s.id = a.student_id
  where a.status in ('offer_accepted', 'coe_issued', 'enrolled')
   and not exists (select 1 from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
    where e.student_id = a.student_id and ci.course_id = c.course_id and e.status in ('active', 'deferred', 'completed'))
   and not exists (select 1 from public.rto_placement_overrides o where o.student_id = a.student_id and o.course_id = c.course_id and o.action = 'remove'
    and not exists (select 1 from public.rto_placement_overrides o2 where o2.student_id = o.student_id and o2.course_id = o.course_id and o2.action = 'place' and o2.at > o.at))), '[]'::jsonb);
end $function$;

-- rto_placement_overrides_list(uuid)
CREATE OR REPLACE FUNCTION public.rto_placement_overrides_list(p_student uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('action', o.action, 'reason', o.reason, 'at', o.at, 'batch', public.intake_group_name(o.intake_id), 'detail', o.detail) order by o.at desc)
  from public.rto_placement_overrides o where o.student_id = p_student), '[]'::jsonb);
end $function$;

-- rto_enrolment_path(batch_enrolments)
CREATE OR REPLACE FUNCTION public.rto_enrolment_path(e batch_enrolments)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 with c as (select ci.course_id from public.course_intakes ci where ci.id = e.intake_id),
 mine as (select * from public.rto_enrolment_units(e.id)),
 owed as (select public.rto_carry_over_open_units(e.student_id, (select course_id from c), false) as units)
 select jsonb_build_object(
  'carryOver', e.carry_over,
  'unitIds', coalesce((select jsonb_agg(m.intake_unit_id order by m.sort, m.start_date) from mine m), '[]'::jsonb),
  'skipped', (select count(*) from public.rto_batch_units(e.intake_id)) - (select count(*) from mine),
  'joinedAt', (select u.code from mine m join public.cms_course_units u on u.id = m.unit_id order by m.start_date, m.sort limit 1),
  'from', (select jsonb_build_object('enrolmentId', p.id, 'batchId', pi.id, 'batch', public.intake_group_name(pi.id), 'intake', public.course_intake_name(pi))
    from public.batch_enrolments p join public.course_intakes pi on pi.id = p.intake_id
    where p.id = e.continues_enrolment_id),
  'next', (select jsonb_build_object('enrolmentId', x.id, 'batchId', xi.id, 'batch', public.intake_group_name(xi.id), 'intake', public.course_intake_name(xi), 'startDate', x.enrolled_on,
     'units', (select count(*) from public.batch_enrolment_units eu where eu.enrolment_id = x.id))
    from public.batch_enrolments x join public.course_intakes xi on xi.id = x.intake_id
    where x.continues_enrolment_id = e.id and x.carry_over and x.status <> 'withdrawn' order by x.enrolled_on limit 1),
  'owed', cardinality((select units from owed)),
  'finishDate', case when cardinality((select units from owed)) = 0 then (
    select max(u.end_date) from public.batch_enrolments a join public.course_intakes ai on ai.id = a.intake_id
    cross join lateral public.rto_enrolment_units(a.id) u
    where a.student_id = e.student_id and ai.course_id = (select course_id from c) and a.status in ('active', 'deferred', 'completed')) end);
$function$;

-- rto_enrolment_pending(batch_enrolments)
CREATE OR REPLACE FUNCTION public.rto_enrolment_pending(e batch_enrolments)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select e.carry_over and not coalesce(e.prereq_first, false) and e.status in ('active', 'deferred') and e.enrolled_on > public.course_intake_today()
  and not exists (select 1 from public.lms_attendance_marks m where m.enrolment_id = e.id);
$function$;

-- rto_enrolment_units(uuid)
CREATE OR REPLACE FUNCTION public.rto_enrolment_units(p_enrolment uuid)
 RETURNS TABLE(intake_unit_id uuid, unit_id text, start_date date, end_date date, sort integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 with e as (select * from public.batch_enrolments where id = p_enrolment),
 bu as (select u.* from e cross join lateral public.rto_batch_units(e.intake_id) u),
 req as (select b.unit_id, r.req_unit from bu b cross join lateral public.rto_unit_requires_all(b.unit_id) as r(req_unit)),
 -- units this student has planned in another enrolment (prerequisites-first or carry-over), with the day each ends
 planned0 as ( -- MASTER-STAGE3
  select eu.unit_id, max(x.end_date) as end_date
  from e join public.batch_enrolments c on c.student_id = e.student_id and c.id <> e.id and c.status in ('active', 'deferred', 'completed')
  join public.batch_enrolment_units eu on eu.enrolment_id = c.id
  cross join lateral public.rto_batch_units(c.intake_id) x
  where x.unit_id = eu.unit_id
  group by eu.unit_id),
 own as (select cu.unit_id, cu.start_date, cu.end_date, cu.enrolment_id from e join public.batch_enrolments c on c.student_id = e.student_id and c.status in ('active', 'deferred', 'completed')
  join public.student_prereq_catchup cu on cu.enrolment_id = c.id),
 planned as (select z.unit_id, max(z.end_date) as end_date from (select unit_id, end_date from planned0 union all select unit_id, end_date from own) z group by z.unit_id),
 on_master as (select exists (select 1 from e join public.course_intakes ci on ci.id = e.intake_id
   join public.course_master_timetables t on t.course_id = ci.course_id) as yes),
 missed as (select exists (
   select 1 from e, bu p
   where p.start_date < e.enrolled_on
    and exists (select 1 from req q where q.unit_id <> p.unit_id and q.req_unit = p.unit_id)
    and not exists (select 1 from public.rto_unit_outcome(e.student_id, p.unit_id) o where o.outcome = 'C')
    and not exists (select 1 from planned pl where pl.unit_id = p.unit_id and pl.end_date < e.enrolled_on)) as m)
 select u.intake_unit_id, u.unit_id, u.start_date, u.end_date, u.sort
 from e cross join bu u cross join missed
 where case when e.carry_over then exists (select 1 from public.batch_enrolment_units eu where eu.enrolment_id = e.id and eu.unit_id = u.unit_id)
  else u.start_date >= e.enrolled_on and not missed.m /* JOIN-AT-NEXT-UNIT */
   and not exists (select 1 from own o where o.enrolment_id = e.id and o.unit_id = u.unit_id)
   and not ((select yes from on_master) and exists (select 1 from public.rto_unit_outcome(e.student_id, u.unit_id) o where o.outcome = 'C' and o.signed_on < u.start_date))
   and not exists (
    select 1 from req q join bu p on p.unit_id = q.req_unit
    where q.unit_id = u.unit_id and p.start_date < e.enrolled_on
     and not exists (select 1 from public.rto_unit_outcome(e.student_id, q.req_unit) o where o.outcome = 'C' and o.signed_on <= u.start_date)
     and not exists (select 1 from planned pl where pl.unit_id = q.req_unit and pl.end_date < u.start_date)) end
 union all
 select u.intake_unit_id, o.unit_id, o.start_date, o.end_date, u.sort from e join own o on o.enrolment_id = e.id join bu u on u.unit_id = o.unit_id where not e.carry_over;
$function$;

-- student_enrolled_unit_ids(uuid)
CREATE OR REPLACE FUNCTION public.student_enrolled_unit_ids(p_student uuid)
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select distinct iu.unit_id
  from public.batch_enrolments e
  join public.intake_units iu on iu.intake_id = e.intake_id
  where p_student is not null and e.student_id = p_student and e.status in ('active', 'deferred', 'completed');
$function$;

-- ==== g2_course_flow
-- rto_batch_clone(uuid,uuid)
CREATE OR REPLACE FUNCTION public.rto_batch_clone(p_src uuid, p_intake uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.course_intakes; si public.course_intakes; ti public.course_intakes; v_new uuid; v_room uuid; v_src_room uuid; v_loc uuid; v_seats integer;
begin
 -- An intake is the class group: p_src is the source intake, p_intake the intake that gets the same group settings.
 select * into s from public.course_intakes where id = p_src;
 if s.id is null or not public.intake_has_group(s.id) then return null; end if;
 si := s;
 select * into ti from public.course_intakes where id = coalesce(p_intake, s.id);
 if ti.id is null then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_batch_clone:' || ti.id::text, 0));
 -- the target intake already has its group (or is the source itself): never a second group
 if ti.id = si.id or public.intake_has_group(ti.id) then
  raise exception 'An intake is one class group: it already has its room, trainer and class times.' using errcode = '23505';
 end if;
 v_src_room := coalesce(s.classroom_id, (select x.room_id from public.intake_class_times x where x.intake_id = s.id and x.room_id is not null order by x.sort limit 1));
 select r.location_id into v_loc from public.classrooms r where r.id = v_src_room;
 v_seats := public.rto_batch_seats(s.id);
 select r.id into v_room from public.classrooms r
 where r.is_active and coalesce(r.capacity, 0) > 0 and r.id is distinct from v_src_room
  and (v_loc is null or r.location_id is not distinct from v_loc)
  and not exists(
   select 1 from public.intake_class_times o
    join public.course_intakes oi on oi.id = o.intake_id
    join public.intake_class_times mine on mine.intake_id = s.id and mine.weekday = o.weekday and mine.start_time < o.end_time and o.start_time < mine.end_time
   where coalesce(o.room_id, oi.classroom_id) = r.id and oi.id <> ti.id
    and oi.start_date <= coalesce(ti.end_date, 'infinity'::date) and coalesce(oi.end_date, 'infinity'::date) >= ti.start_date)
 order by (r.capacity >= v_seats) desc, r.capacity desc, r.name limit 1;

 update public.course_intakes set classroom_id = v_room, class_days = s.class_days, start_time = s.start_time, end_time = s.end_time,
  capacity = s.capacity, updated_at = now()
 where id = ti.id;
 v_new := ti.id;
 insert into public.intake_trainers(intake_id, staff_id) select v_new, t.staff_id from public.intake_trainers t where t.intake_id = s.id on conflict do nothing;
 update public.intake_units nu set trainer_id = ou.trainer_id
 from public.intake_units ou
 where ou.intake_id = s.id and ou.trainer_id is not null and nu.intake_id = ti.id and nu.unit_id = ou.unit_id and nu.trainer_id is null;
 insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
 select v_new, x.weekday, x.slot, x.start_time, x.end_time, x.session_type, v_room, x.sort from public.intake_class_times x where x.intake_id = s.id;
 perform public.rto_batch_sync_legacy(v_new);
 if exists(select 1 from public.intake_class_times where intake_id = v_new) and (coalesce(public.cms_is_rto_manager(), false) or public.rto_auto_placing()) then
  begin
   perform set_config('rto.course', ti.course_id, true);
   perform public.rto_class_sessions_generate(v_new);
  exception when others then
   raise warning 'rto_batch_clone: classes for the intake not generated: %', sqlerrm;
  end;
 end if;
 return v_new;
end $function$;

-- rto_intake_auto_next(uuid)
CREATE OR REPLACE FUNCTION public.rto_intake_auto_next(p_intake uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare src public.course_intakes; v_last date; v_start date; v_delta integer; v_new uuid; b record; x record; nb uuid; v_was text;
begin
 select * into src from public.course_intakes where id = p_intake;
 if src.id is null then return null; end if;
 if exists (select 1 from public.course_master_timetables t where t.course_id = src.course_id) then return null; end if; -- MASTER-STAGE2
 perform pg_advisory_xact_lock(hashtextextended('rto_intake_next:' || src.course_id || ':' || src.study_load, 0));
 if exists (select 1 from public.course_intakes ci where ci.course_id = src.course_id and ci.study_load = src.study_load and ci.start_date > src.start_date) then
  return null;
 end if;
 if not public.intake_has_group(src.id) then return null; end if;
 select max(end_date) into v_last from public.intake_units where intake_id = src.id;
 if v_last is null then return null; end if;
 v_was := coalesce(current_setting('rto.course', true), '');
 perform set_config('rto.course', src.course_id, true);
 v_start := public.rto_next_working_day(greatest(v_last, coalesce(src.end_date, v_last)) + 1);
 perform set_config('rto.course', v_was, true);
 v_delta := v_start - src.start_date;
 if exists (select 1 from public.course_intakes where course_id = src.course_id and start_date = v_start) then return null; end if;

 -- the new intake gets the same group settings (room, days, times, seats) as its source
 insert into public.course_intakes(course_id, start_date, end_date, name, campus, capacity, status, study_load, auto_created,
  classroom_id, class_days, start_time, end_time)
 values (src.course_id, v_start, coalesce(src.end_date, v_last) + v_delta, null, src.campus, src.capacity, 'open', src.study_load, true,
  src.classroom_id, src.class_days, src.start_time, src.end_time)
 returning id into v_new;

 create temp table if not exists rto_auto_unit_map(old_id uuid primary key, new_id uuid) on commit drop;
 delete from rto_auto_unit_map;
 for x in select * from public.intake_units where intake_id = src.id order by sort, start_date loop
  insert into rto_auto_unit_map(old_id, new_id) values (x.id, gen_random_uuid());
  insert into public.intake_units(id, intake_id, unit_id, start_date, end_date, hours, sort, trainer_id)
  select m.new_id, v_new, x.unit_id, x.start_date + v_delta, x.end_date + v_delta, x.hours, x.sort, x.trainer_id from rto_auto_unit_map m where m.old_id = x.id;
 end loop;

 insert into public.intake_trainers(intake_id, staff_id) select v_new, t.staff_id from public.intake_trainers t where t.intake_id = src.id on conflict do nothing;
 insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
 select v_new, s.weekday, s.slot, s.start_time, s.end_time, s.session_type, s.room_id, s.sort from public.intake_class_times s where s.intake_id = src.id;
 -- Dated classes: the generator is for RTO Managers; for anyone else staff generate them from the intake later.
 if exists (select 1 from public.intake_class_times where intake_id = v_new) and coalesce(public.cms_is_rto_manager(), false) then
  begin
   perform public.rto_class_sessions_generate(v_new);
  exception when others then
   raise warning 'rto_intake_auto_next: classes for intake % not generated: %', public.intake_group_name(v_new), sqlerrm;
  end;
 end if;
 perform set_config('rto.course', v_was, true);
 return v_new;
end $function$;

-- rto_intake_rolling_sweep()
CREATE OR REPLACE FUNCTION public.rto_intake_rolling_sweep()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l record; v_new uuid; b record; n integer := 0; v_today date := public.course_intake_today(); v_end date;
begin
  for l in
    select distinct on (ci.course_id, ci.study_load) ci.*
    from public.course_intakes ci where ci.is_active and coalesce(ci.status, 'open') not in ('closed', 'draft')
    order by ci.course_id, ci.study_load, ci.start_date desc, ci.id
  loop
    v_end := coalesce(l.end_date, (select max(end_date) from public.intake_units where intake_id = l.id), l.start_date);
    continue when v_end < v_today;  -- an intake that already ended: staff start the course again by hand
    continue when coalesce((to_jsonb(l)->>'auto_created')::boolean, false)
      and v_today < l.start_date + ((v_end - l.start_date) / 2);  -- automatic and not yet halfway
    begin
      v_new := public.rto_intake_auto_next(l.id);
      if v_new is not null then
        n := n + 1;
        perform set_config('rto.auto_place', 'on', true);
        if public.intake_has_group(v_new) and exists (select 1 from public.intake_class_times s where s.intake_id = v_new) then
          begin
            perform set_config('rto.course', l.course_id, true);
            perform public.rto_class_sessions_generate(v_new);
          exception when others then raise warning 'rto_intake_rolling_sweep: classes for intake % not generated: %', v_new, sqlerrm;
          end;
        end if;
        perform set_config('rto.auto_place', 'off', true);
      end if;
    exception when others then
      perform set_config('rto.auto_place', 'off', true);
      raise warning 'rto_intake_rolling_sweep: intake % not rolled: %', l.id, sqlerrm;
    end;
  end loop;
  begin perform public.course_master_roll(); exception when others then raise warning 'course_master_roll: %', sqlerrm; end; -- MASTER-STAGE3
  return n;
end;
$function$;

-- course_master_apply(text)
CREATE OR REPLACE FUNCTION public.course_master_apply(p_course text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; b record; v_n integer := 0;
begin
 if not exists (select 1 from public.course_master_timetables where course_id = p_course) then return 0; end if;
 for r in select id from public.course_intakes where course_id = p_course and coalesce(status, 'open') <> 'closed' order by start_date, id loop
  perform public.course_master_apply_intake(r.id);
  v_n := v_n + 1;
  if coalesce(public.cms_is_rto_manager(), false) or public.rto_auto_placing() then
   if public.intake_has_group(r.id) and exists (select 1 from public.intake_class_times s where s.intake_id = r.id) then
    begin
     perform public.rto_class_sessions_generate(r.id);
    exception when others then
     raise warning 'course_master_apply: classes for intake % not planned again: %', public.intake_group_name(r.id), sqlerrm;
    end;
   end if;
  end if;
 end loop;
 return v_n;
end $function$;

-- course_master_apply_intake(uuid)
CREATE OR REPLACE FUNCTION public.course_master_apply_intake(p_intake uuid)
 RETURNS date
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare i public.course_intakes; v_first date; v_last date; v_cycle integer;
begin
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 v_cycle := public.course_master_current_cycle(i.course_id);
 select min(m.start_date), max(m.end_date) into v_first, v_last from public.course_master_units m where m.course_id = i.course_id and m.cycle = v_cycle;
 if v_first is null then return null; end if;
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
end $function$;

-- course_master_classes(uuid)
CREATE OR REPLACE FUNCTION public.course_master_classes(p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
declare v_intake public.course_intakes; v_from date; v_day date; v_left numeric; v_len numeric; v_created integer := 0; v_kept integer; v_end date;
 v_short jsonb := '[]'::jsonb; u record; s record; v_was text := coalesce(current_setting('rto.course', true), '');
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or public.rto_auto_placing()) then
  raise exception 'Only an RTO Manager can generate class sessions.' using errcode = '42501';
 end if;
 -- p_batch is the intake id (an intake is its class group)
 select i.* into v_intake from public.course_intakes i where i.id = p_batch;
 if not found then raise exception 'Intake not found.' using errcode = 'P0002'; end if;
 if not exists (select 1 from public.intake_class_times where intake_id = p_batch) then
  raise exception 'Set the intake''s weekly class times first.' using errcode = '22023';
 end if;
 perform set_config('rto.course', v_intake.course_id, true);
 v_from := case when exists (select 1 from public.class_sessions where intake_id = p_batch) then greatest(v_intake.start_date, current_date) else v_intake.start_date end;
 -- every planned class from today on is laid out again (the master may have moved earlier or later); past and hand-changed ones stay
 delete from public.class_sessions where intake_id = p_batch and not is_manual and session_date >= least(v_from, current_date);
 select count(*) into v_kept from public.class_sessions where intake_id = p_batch;

 for u in select iu.unit_id, cu.code, iu.start_date, iu.end_date, coalesce(cu.slit_hours, cu.nominal_hours, iu.hours, 0)::numeric as hours
  from public.intake_units iu join public.cms_course_units cu on cu.id = iu.unit_id where iu.intake_id = v_intake.id order by iu.sort, iu.start_date loop
  -- hours already taught or fixed by hand come off the unit
  select u.hours - coalesce(sum(extract(epoch from (c.end_time - c.start_time)) / 3600.0), 0) into v_left
  from public.class_sessions c where c.intake_id = p_batch and c.unit_id = u.unit_id and c.status = 'scheduled';
  v_day := greatest(u.start_date, v_from);
  while v_left > 0 and v_day <= u.end_date loop
   if public.rto_is_teaching_day(v_day) then
    for s in select * from public.intake_class_times where intake_id = p_batch and weekday = extract(isodow from v_day)::integer order by start_time loop
     exit when v_left <= 0;
     continue when exists (select 1 from public.class_sessions c where c.intake_id = p_batch and c.session_date = v_day and c.start_time = s.start_time);
     v_len := extract(epoch from (s.end_time - s.start_time)) / 3600.0;
     insert into public.class_sessions(intake_id, session_date, start_time, end_time, session_type, room_id, unit_id)
     values (p_batch, v_day, s.start_time, s.end_time, s.session_type, s.room_id, u.unit_id);
     v_left := v_left - v_len; v_created := v_created + 1;
    end loop;
   end if;
   v_day := v_day + 1;
  end loop;
  -- a unit whose hours did not fit in what is left of its dates (holidays, or it has already begun)
  if v_left > 0.01 and u.end_date >= v_from then
   v_short := v_short || jsonb_build_object('code', u.code, 'hoursShort', round(v_left, 1));
  end if;
 end loop;
 perform set_config('rto.course', v_was, true);
 select max(session_date) into v_end from public.class_sessions where intake_id = p_batch;
 return jsonb_build_object('created', v_created, 'kept', v_kept, 'from', v_from, 'endDate', v_end, 'short', v_short,
  'clashes', public.rto_class_session_clashes(p_batch));
end $function$;

-- course_master_group_problem(uuid)
CREATE OR REPLACE FUNCTION public.course_master_group_problem(p_batch uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 with g as (
  select ci.course_id, coalesce((select sum(extract(epoch from (s.end_time - s.start_time))) / 3600.0 from public.intake_class_times s where s.intake_id = ci.id), 0) as weekly
  from public.course_intakes ci where ci.id = p_batch and coalesce(ci.status, 'open') <> 'closed'),
 worst as (
  select u.code, coalesce(u.slit_hours, u.nominal_hours) as hours, m.weeks, coalesce(u.slit_hours, u.nominal_hours) / m.weeks as need
  from g join public.course_master_units m on m.course_id = g.course_id and m.cycle = public.course_master_current_cycle(g.course_id)
  join public.cms_course_units u on u.id = m.unit_id
  where coalesce(u.slit_hours, u.nominal_hours) > 0 order by 4 desc, 1 limit 1)
 select 'These class times give ' || trim(to_char(g.weekly, 'FM990.0')) || ' hours a week. The master timetable needs '
  || trim(to_char(w.need, 'FM990.0')) || ' hours a week (' || w.code || ': ' || w.hours || ' hours in ' || trim(to_char(w.weeks, 'FM990.0')) || ' week'
  || case when w.weeks = 1 then '' else 's' end || '). Add class time, or change the master timetable.'
 from g, worst w where g.weekly > 0 and g.weekly < w.need - 0.01;
$function$;

-- course_master_group_hours()
CREATE OR REPLACE FUNCTION public.course_master_group_hours()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_problem text;
begin
 -- trigger on intake_class_times: NEW / OLD are class time rows of an intake
 v_problem := public.course_master_group_problem(case when tg_op = 'DELETE' then old.intake_id else new.intake_id end);
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
 return null;
end $function$;

-- course_master_one_group()
CREATE OR REPLACE FUNCTION public.course_master_one_group()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 -- an intake is its own class group: nothing to guard any more (removed in stage 4)
 return new;
end $function$;

-- course_master_lock_override()
CREATE OR REPLACE FUNCTION public.course_master_lock_override()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 -- unit dates live on the intake units (course_master_lock_unit); nothing to guard here (removed in stage 4)
 return coalesce(new, old);
end $function$;

-- course_master_catchup_set(uuid,text[],date)
CREATE OR REPLACE FUNCTION public.course_master_catchup_set(p_enrolment uuid, p_units text[], p_from date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_course text;
begin
 select ci.course_id into v_course from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id where e.id = p_enrolment;
 if v_course is null or p_units is null or p_from is null then return; end if;
 delete from public.student_prereq_catchup where enrolment_id = p_enrolment;
 insert into public.student_prereq_catchup(enrolment_id, unit_id, start_date, end_date)
 select p_enrolment, l.unit_id, l.start_date, l.end_date from public.course_master_layout(v_course, p_from, public.course_master_catchup_rows(v_course, p_units)) l;
end $function$;

-- rto_course_flow(text,jsonb)
CREATE OR REPLACE FUNCTION public.rto_course_flow(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
 d jsonb := coalesce(p_data, '{}'::jsonb); src public.course_intakes; v_new uuid; v_delta integer; v_start date; b public.course_intakes; nb uuid; x record;
 v_id uuid; v_from date; v_to date; en public.batch_enrolments; tb public.course_intakes; v_count integer; v_old uuid; v_rto boolean := public.cms_is_rto_manager();
 v_s jsonb; v_st time; v_et time; v_wd integer;
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_action in ('student_move', 'enrolment_set') then
  if not (v_rto or public.cms_is_admin()) then raise exception 'Only an Admin or an RTO Manager can move or remove students.' using errcode = '42501'; end if;
 elsif p_action not in ('locations_rooms', 'timing_list', 'clash_check', 'rooms_board', 'batch_get') and not v_rto then
  raise exception 'Only an RTO Manager can change intakes and schedules.' using errcode = '42501';
 end if;

 if p_action = 'intake_duplicate' then
  -- A copy at a new start date: unit dates move by the same number of days; the intake's group (room, days, times, seats),
  -- trainers, unit trainers and class timing are copied; students are not. The copy starts as a draft.
  select * into src from public.course_intakes where id = nullif(d->>'intakeId', '')::uuid;
  if src.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  v_start := nullif(d->>'startDate', '')::date;
  if v_start is null then raise exception 'Choose the new start date.' using errcode = '22023'; end if;
  if exists(select 1 from public.course_intakes where course_id = src.course_id and start_date = v_start) then
   raise exception 'This course already has an intake starting on that date.' using errcode = '23505';
  end if;
  v_delta := v_start - src.start_date;
  insert into public.course_intakes(course_id, start_date, end_date, name, campus, capacity, status, is_active, updated_by,
   classroom_id, class_days, start_time, end_time)
  values (src.course_id, v_start, src.end_date + v_delta, null, src.campus, src.capacity, 'draft', false, auth.uid(),
   src.classroom_id, src.class_days, src.start_time, src.end_time) returning id into v_new;
  create temp table if not exists pg_temp.rto_unit_map(old_id uuid primary key, new_id uuid) on commit drop;
  delete from pg_temp.rto_unit_map;
  for x in select * from public.intake_units where intake_id = src.id order by sort loop
   insert into pg_temp.rto_unit_map(old_id, new_id) values (x.id, gen_random_uuid());
   insert into public.intake_units(id, intake_id, unit_id, start_date, end_date, hours, sort, trainer_id)
   select m.new_id, v_new, x.unit_id, x.start_date + v_delta, x.end_date + v_delta, x.hours, x.sort, x.trainer_id from pg_temp.rto_unit_map m where m.old_id = x.id;
  end loop;
  insert into public.intake_trainers(intake_id, staff_id) select v_new, t.staff_id from public.intake_trainers t where t.intake_id = src.id on conflict do nothing;
  insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
  select v_new, s2.weekday, s2.slot, s2.start_time, s2.end_time, s2.session_type, s2.room_id, s2.sort from public.intake_class_times s2 where s2.intake_id = src.id;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', v_new));

 elsif p_action = 'batch_override_set' then
  -- The intake is the class group: a unit's own dates are the intake unit's dates.
  select * into b from public.course_intakes where id = coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  if b.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  if not exists(select 1 from public.intake_units where id = nullif(d->>'intakeUnitId', '')::uuid and intake_id = b.id) then
   raise exception 'That unit is not on this intake.' using errcode = '22023';
  end if;
  if (d->>'endDate')::date < (d->>'startDate')::date then raise exception 'The end date is before the start date.' using errcode = '22023'; end if;
  if coalesce(b.status, 'open') <> 'closed' and exists(select 1 from public.course_master_timetables t where t.course_id = b.course_id) then
   raise exception 'This course follows its master timetable: change the unit dates on the course''s Master timetable.' using errcode = '22023';
  end if;
  update public.intake_units set start_date = (d->>'startDate')::date, end_date = (d->>'endDate')::date
  where id = (d->>'intakeUnitId')::uuid and intake_id = b.id
   and (start_date <> (d->>'startDate')::date or end_date <> (d->>'endDate')::date);
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.id));

 elsif p_action = 'batch_override_reset' then
  -- No separate dates exist any more: the intake unit's dates are the dates.
  select * into b from public.course_intakes where id = coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  if b.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.id));

 elsif p_action = 'locations_rooms' then
  return public.rto_locations_rooms();

 elsif p_action = 'timing_list' then
  -- The course's class timing from the master timetable, one per batch name (G1, G2 ...).
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'trainerName', t.trainer_name, 'trainerStaffId', t.trainer_staff_id,
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('weekday', (e->>'weekday')::int, 'startTime', e->>'start', 'endTime', e->>'end',
       'type', coalesce(e->>'type', 'theory'), 'roomId', e->>'roomId', 'room', (select r.name from public.classrooms r where r.id::text = e->>'roomId'))
       order by (e->>'weekday')::int, e->>'start') from jsonb_array_elements(t.sessions) e), '[]'::jsonb)) order by t.name)
   from public.course_timing_templates t where t.course_id = nullif(d->>'courseId', '')), '[]'::jsonb);

 elsif p_action = 'clash_check' then
  return public.rto_session_clashes(coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid, nullif(d->>'intakeId', '')::uuid, d->'sessions');

 elsif p_action = 'batch_setup' then
  -- Set up or change the intake's group: seats, trainers and its weekly classes (an intake is one class group).
  v_id := coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  select * into b from public.course_intakes where id = v_id;
  if b.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  if d ? 'capacity' then
   update public.course_intakes set capacity = nullif(d->>'capacity', '')::integer, updated_at = now() where id = b.id returning * into b;
  end if;
  if d ? 'isActive' and coalesce((d->>'isActive')::boolean, true) = false then
   -- switching the group off clears the intake's room, class times and trainers
   update public.course_intakes set classroom_id = null, updated_at = now() where id = b.id returning * into b;
   delete from public.intake_class_times where intake_id = b.id;
   delete from public.intake_trainers where intake_id = b.id;
   perform public.rto_batch_sync_legacy(b.id);
  else
   if d ? 'trainerIds' then
    delete from public.intake_trainers t where t.intake_id = b.id and t.staff_id::text not in (select jsonb_array_elements_text(d->'trainerIds'));
    insert into public.intake_trainers(intake_id, staff_id) select b.id, value::uuid from jsonb_array_elements_text(d->'trainerIds') on conflict do nothing;
   end if;
   if jsonb_typeof(d->'sessions') = 'array' then
    delete from public.intake_class_times where intake_id = b.id;
    v_count := 0;
    for v_s in select value from jsonb_array_elements(d->'sessions') loop
     v_count := v_count + 1;
     v_wd := nullif(v_s->>'weekday', '')::integer; v_st := nullif(v_s->>'startTime', '')::time; v_et := nullif(v_s->>'endTime', '')::time;
     if v_wd is null or v_wd not between 1 and 7 then raise exception 'Each class needs a day.' using errcode = '22023'; end if;
     if v_st is null or v_et is null or v_et <= v_st then raise exception 'Each class needs an end time after its start time.' using errcode = '22023'; end if;
     insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
     values (b.id, v_wd, public.rto_slot(v_st), v_st, v_et, coalesce(nullif(v_s->>'type', ''), 'theory'), nullif(v_s->>'roomId', '')::uuid, v_count);
    end loop;
    perform public.rto_batch_sync_legacy(b.id);
   end if;
  end if;
  return public.rto_admin('intake_get', jsonb_build_object('intakeId', b.id))
   || jsonb_build_object('batchId', b.id, 'clashes', public.rto_session_clashes(b.id, b.id, public.rto_batch_sessions_json(b.id)));

 elsif p_action = 'session_add' then
  -- The rooms board: put an intake into a room for one weekday and part of the day.
  select * into b from public.course_intakes where id = coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  if b.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  v_wd := nullif(d->>'weekday', '')::integer;
  if v_wd is null or v_wd not between 1 and 7 then raise exception 'Choose a day.' using errcode = '22023'; end if;
  v_st := coalesce(nullif(d->>'startTime', '')::time, case d->>'slot' when 'morning' then time '09:00' when 'afternoon' then time '13:00' else time '17:00' end);
  v_et := coalesce(nullif(d->>'endTime', '')::time, case d->>'slot' when 'morning' then time '13:00' when 'afternoon' then time '17:00' else time '21:00' end);
  insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
  values (b.id, v_wd, public.rto_slot(v_st), v_st, v_et, coalesce(nullif(d->>'type', ''), 'theory'), nullif(d->>'roomId', '')::uuid,
   (select coalesce(max(sort), 0) + 1 from public.intake_class_times where intake_id = b.id))
  returning id into v_new;
  perform public.rto_batch_sync_legacy(b.id);
  return jsonb_build_object('sessionId', v_new, 'clashes', public.rto_session_clashes(b.id, b.id, public.rto_batch_sessions_json(b.id)));

 elsif p_action = 'session_delete' then
  delete from public.intake_class_times where id = nullif(d->>'sessionId', '')::uuid returning intake_id into v_id;
  if v_id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  perform public.rto_batch_sync_legacy(v_id);
  return jsonb_build_object('deleted', true, 'batchId', v_id);

 elsif p_action = 'batch_get' then
  -- One intake's group for its own page: the group, its intake (the same row; no other groups) and room clashes.
  select * into b from public.course_intakes where id = coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  if b.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('batch', public.rto_batch_json(b), 'intake', public.rto_intake_json(b),
   'siblings', '[]'::jsonb,
   'clashes', public.rto_session_clashes(b.id, b.id, public.rto_batch_sessions_json(b.id)),
   'rtoManager', v_rto, 'admin', public.cms_is_admin());

 elsif p_action = 'batch_trainers_set' then
  select * into b from public.course_intakes where id = coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  if b.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  delete from public.intake_trainers t where t.intake_id = b.id and t.staff_id::text not in (select jsonb_array_elements_text(coalesce(d->'trainerIds', '[]'::jsonb)));
  insert into public.intake_trainers(intake_id, staff_id) select b.id, value::uuid from jsonb_array_elements_text(coalesce(d->'trainerIds', '[]'::jsonb)) on conflict do nothing;
  return public.rto_batch_json(b);

 elsif p_action = 'student_move' then
  -- An intake is one class group: a student can only "move" to the group they are already in.
  select * into en from public.batch_enrolments where id = nullif(d->>'enrolmentId', '')::uuid;
  if en.id is null then raise exception 'Enrolment not found' using errcode = 'P0002'; end if;
  select * into tb from public.course_intakes where id = coalesce(nullif(d->>'toBatchId', ''), nullif(d->>'toIntakeId', ''))::uuid;
  if tb.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
  v_old := en.intake_id;
  if tb.id = v_old then return jsonb_build_object('enrolmentId', en.id, 'fromBatchId', v_old, 'toBatchId', tb.id); end if;
  raise exception 'Students move only within the same intake.' using errcode = '22023';

 elsif p_action = 'enrolment_set' then
  -- Remove a student from an intake (withdrawn) or bring them back (active), e.g. Undo.
  if coalesce(d->>'status', '') not in ('active', 'withdrawn') then raise exception 'Unknown status' using errcode = '22023'; end if;
  update public.batch_enrolments set status = d->>'status' where id = nullif(d->>'enrolmentId', '')::uuid returning * into en;
  if en.id is null then raise exception 'Enrolment not found' using errcode = 'P0002'; end if;
  select * into tb from public.course_intakes where id = en.intake_id;
  select count(*) into v_count from public.batch_enrolments where intake_id = tb.id and status in ('active', 'deferred');
  if en.status = 'active' and tb.capacity is not null and v_count > tb.capacity then raise exception '% is full (% places).', public.intake_group_name(tb.id), tb.capacity using errcode = '23514'; end if;
  return jsonb_build_object('enrolmentId', en.id, 'status', en.status, 'batchId', en.intake_id);

 elsif p_action = 'rooms_board' then
  -- Every class of the intakes with a group that run in the chosen dates, the rooms by location, and those intakes (to put one in a room).
  v_from := coalesce(nullif(d->>'from', '')::date, current_date); v_to := greatest(v_from, coalesce(nullif(d->>'to', '')::date, v_from + 6));
  return jsonb_build_object('locations', public.rto_locations_rooms(),
   'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'batchId', ci.id, 'batch', public.intake_group_name(ci.id), 'intakeId', ci.id,
      'intakeName', coalesce(nullif(btrim(ci.name), ''), public.intake_auto_name(ci.course_id, ci.start_date, ci.end_date)), 'courseId', ci.course_id, 'courseCode', c.code,
      'weekday', s.weekday, 'slot', s.slot, 'startTime', to_char(s.start_time, 'HH24:MI'), 'endTime', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type,
      'roomId', s.room_id, 'batchStart', lower(sp.r), 'batchEnd', upper(sp.r) - 1,
      'trainers', coalesce((select jsonb_agg(btrim(st.first_name || ' ' || st.last_name)) from public.intake_trainers t join hr.staff_profiles st on st.id = t.staff_id where t.intake_id = ci.id), '[]'::jsonb))
      order by s.weekday, s.start_time)
     from public.intake_class_times s
     join public.course_intakes ci on ci.id = s.intake_id join public.cms_courses c on c.id = ci.course_id
     cross join lateral (select public.rto_batch_span(ci.id) r) sp
     where sp.r && daterange(v_from, v_to, '[]')), '[]'::jsonb),
   'batches', coalesce((select jsonb_agg(jsonb_build_object('id', ci.id, 'name', public.intake_group_name(ci.id), 'courseCode', c.code, 'intakeId', ci.id,
      'intakeName', coalesce(nullif(btrim(ci.name), ''), public.intake_auto_name(ci.course_id, ci.start_date, ci.end_date))) order by c.code, ci.start_date, public.intake_group_name(ci.id))
     from public.course_intakes ci join public.cms_courses c on c.id = ci.course_id
     where public.intake_has_group(ci.id) and public.rto_batch_span(ci.id) && daterange(v_from, v_to, '[]')), '[]'::jsonb));

 elsif p_action = 'room_save' then
  -- A room in a location (create or rename / move / capacity / active).
  v_id := nullif(d->>'id', '')::uuid;
  if v_id is null then
   if nullif(btrim(d->>'name'), '') is null then raise exception 'Give the room a name.' using errcode = '22023'; end if;
   insert into public.classrooms(name, campus, capacity, is_active, location_id, sort)
   values (btrim(d->>'name'), (select name from public.locations where id = nullif(d->>'locationId', '')::uuid), nullif(d->>'capacity', '')::integer, true,
    nullif(d->>'locationId', '')::uuid, coalesce((select max(sort) + 1 from public.classrooms where location_id = nullif(d->>'locationId', '')::uuid), 1));
  else
   update public.classrooms set
    name = case when d ? 'name' then coalesce(nullif(btrim(d->>'name'), ''), name) else name end,
    location_id = case when d ? 'locationId' then nullif(d->>'locationId', '')::uuid else location_id end,
    campus = case when d ? 'locationId' then (select name from public.locations where id = nullif(d->>'locationId', '')::uuid) else campus end,
    capacity = case when d ? 'capacity' then nullif(d->>'capacity', '')::integer else capacity end,
    is_active = case when d ? 'isActive' then coalesce((d->>'isActive')::boolean, is_active) else is_active end
   where id = v_id;
   if not found then raise exception 'Room not found' using errcode = 'P0002'; end if;
  end if;
  return public.rto_locations_rooms();
 end if;
 raise exception 'Unknown action' using errcode = '22023';
end $function$;

-- ==== g8_attendance
-- lms_session_trainer(p_session uuid)
CREATE OR REPLACE FUNCTION public.lms_session_trainer(p_session uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.class_sessions cs
    where cs.id = p_session and public.asm_trainer_profile() is not null
      and (exists (select 1 from public.intake_trainers it where it.intake_id = cs.intake_id and it.staff_id = public.asm_trainer_profile())
        or exists (select 1 from public.intake_units iu
          where iu.intake_id = cs.intake_id and iu.trainer_id = public.asm_trainer_profile() and iu.unit_id = cs.unit_id)));
$function$;

-- lms_attendance(p_action text, p_batch_id uuid, p_unit_id uuid, p_class_date date, p_marks jsonb, p_state text)
CREATE OR REPLACE FUNCTION public.lms_attendance(p_action text, p_batch_id uuid, p_unit_id uuid DEFAULT NULL::uuid, p_class_date date DEFAULT NULL::date, p_marks jsonb DEFAULT '[]'::jsonb, p_state text DEFAULT 'draft'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_register uuid; v_entry jsonb; v_enrolment uuid; v_status text;
begin
 if not public.cms_is_staff() then raise exception 'CMS staff access required' using errcode='42501'; end if;
 if not exists(select 1 from public.course_intakes where id=p_batch_id) then raise exception 'Intake not found'; end if;
 if p_action='history' then
 return coalesce((select jsonb_agg(jsonb_build_object('date',class_date,'unitId',intake_unit_id,'state',state) order by class_date desc) from (select * from public.lms_attendance_register where intake_id=p_batch_id order by class_date desc limit 60) t),'[]'::jsonb);
 end if;
 if p_unit_id is null or p_class_date is null then raise exception 'Unit and class date required'; end if;
 if not exists(select 1 from public.intake_units u where u.intake_id=p_batch_id and u.id=p_unit_id) then raise exception 'Unit does not belong to intake'; end if;
 select id into v_register from public.lms_attendance_register where intake_id=p_batch_id and intake_unit_id=p_unit_id and class_date=p_class_date;
 if p_action='get' then
 return jsonb_build_object('state',coalesce((select state from public.lms_attendance_register where id=v_register),'new'),'marks',coalesce((select jsonb_object_agg(enrolment_id::text,status) from public.lms_attendance_marks where register_id=v_register),'{}'::jsonb));
 elsif p_action='save' then
 if not public.cms_is_rto_manager() then raise exception 'RTO Manager permission required' using errcode='42501'; end if;
 if p_state not in ('draft','final') then raise exception 'Invalid state'; end if;
 insert into public.lms_attendance_register(intake_id,intake_unit_id,class_date,state,updated_by)
 values(p_batch_id,p_unit_id,p_class_date,p_state,auth.uid())
 on conflict(intake_id,intake_unit_id,class_date) do update set state=excluded.state,updated_at=now(),updated_by=excluded.updated_by returning id into v_register;
 delete from public.lms_attendance_marks where register_id=v_register;
 for v_entry in select value from jsonb_array_elements(p_marks) loop
 v_enrolment := (v_entry->>'enrolmentId')::uuid; v_status:=v_entry->>'status';
 if v_status not in ('present','absent','late','excused') then raise exception 'Invalid attendance status'; end if;
 if not exists(select 1 from public.batch_enrolments where id=v_enrolment and intake_id=p_batch_id and status in ('active','deferred')) then raise exception 'Student is not enrolled in this intake'; end if;
 insert into public.lms_attendance_marks(register_id,enrolment_id,status) values(v_register,v_enrolment,v_status);
 end loop;
 return jsonb_build_object('saved',true,'state',p_state);
 end if;
 raise exception 'Unknown action';
end $function$;

-- lms_attendance_summary(p_batch uuid, p_student uuid)
CREATE OR REPLACE FUNCTION public.lms_attendance_summary(p_batch uuid DEFAULT NULL::uuid, p_student uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
  if p_batch is null and p_student is null then raise exception 'Choose an intake or a student' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(row order by row->>'studentName') from (
      select jsonb_build_object('enrolmentId', e.id, 'studentId', s.id, 'studentName', s.full_name, 'enrolmentStatus', e.status,
        'batchId', ci.id, 'batchName', public.intake_group_name(ci.id), 'courseName', coalesce(nullif(c.name, ''), c.code),
        'classes', count(m.status), 'present', count(*) filter (where m.status = 'present'), 'late', count(*) filter (where m.status = 'late'),
        'absent', count(*) filter (where m.status = 'absent'), 'excused', count(*) filter (where m.status = 'excused')) as row
      from public.batch_enrolments e
      join public.enrollment_students s on s.id = e.student_id
      join public.course_intakes ci on ci.id = e.intake_id
      join public.cms_courses c on c.id = ci.course_id
      left join public.lms_attendance_marks m on m.enrolment_id = e.id
        and exists (select 1 from public.lms_attendance_register r where r.id = m.register_id and r.state = 'final')
      where (p_batch is null or e.intake_id = p_batch) and (p_student is null or e.student_id = p_student)
      group by e.id, s.id, ci.id, c.id) t), '[]'::jsonb);
end;
$function$;

-- trainer_session_attendance(p_session uuid)
CREATE OR REPLACE FUNCTION public.trainer_session_attendance(p_session uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cs public.class_sessions; v_iu uuid; v_reg public.lms_attendance_register;
begin
  select * into cs from public.class_sessions where id = p_session;
  if cs.id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  if not (public.lms_session_trainer(p_session) or coalesce(public.cms_is_staff(), false)) then raise exception 'Only the trainer of this class can mark it' using errcode = '42501'; end if;
  select iu.id into v_iu from public.intake_units iu where iu.intake_id = cs.intake_id and iu.unit_id = cs.unit_id limit 1;
  if v_iu is null then raise exception 'This class has no unit, so attendance cannot be marked' using errcode = '22023'; end if;
  select * into v_reg from public.lms_attendance_register where intake_id = cs.intake_id and intake_unit_id = v_iu and class_date = cs.session_date;
  return jsonb_build_object('sessionId', cs.id, 'date', cs.session_date, 'start', to_char(cs.start_time, 'HH24:MI'), 'end', to_char(cs.end_time, 'HH24:MI'),
    'state', coalesce(v_reg.state, 'new'), 'canChangeFinal', coalesce(public.cms_is_rto_manager(), false),
    'students', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'name', s.full_name,
        'status', (select m.status from public.lms_attendance_marks m where m.register_id = v_reg.id and m.enrolment_id = e.id)) order by s.full_name)
      from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id
      where e.intake_id = cs.intake_id and e.status in ('active', 'deferred') and e.enrolled_on <= cs.session_date), '[]'::jsonb));
end;
$function$;

-- trainer_session_attendance_save(p_session uuid, p_marks jsonb, p_state text)
CREATE OR REPLACE FUNCTION public.trainer_session_attendance_save(p_session uuid, p_marks jsonb, p_state text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cs public.class_sessions; v_iu uuid; v_reg uuid; v_old text; x jsonb; v_enrol uuid; v_status text;
begin
  select * into cs from public.class_sessions where id = p_session;
  if cs.id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  if not (public.lms_session_trainer(p_session) or coalesce(public.cms_is_rto_manager(), false)) then raise exception 'Only the trainer of this class can mark it' using errcode = '42501'; end if;
  if p_state not in ('draft', 'final') then raise exception 'Invalid state' using errcode = '22023'; end if;
  if cs.session_date > public.course_intake_today() then raise exception 'Attendance can be marked on or after the class day' using errcode = '22023'; end if;
  select iu.id into v_iu from public.intake_units iu where iu.intake_id = cs.intake_id and iu.unit_id = cs.unit_id limit 1;
  if v_iu is null then raise exception 'This class has no unit, so attendance cannot be marked' using errcode = '22023'; end if;
  select id, state into v_reg, v_old from public.lms_attendance_register where intake_id = cs.intake_id and intake_unit_id = v_iu and class_date = cs.session_date;
  if v_old = 'final' and not coalesce(public.cms_is_rto_manager(), false) then raise exception 'This register is final. Ask an RTO Manager to change it.' using errcode = '42501'; end if;
  insert into public.lms_attendance_register(intake_id, intake_unit_id, class_date, state, updated_by)
  values (cs.intake_id, v_iu, cs.session_date, p_state, auth.uid())
  on conflict (intake_id, intake_unit_id, class_date) do update set state = excluded.state, updated_at = now(), updated_by = excluded.updated_by
  returning id into v_reg;
  delete from public.lms_attendance_marks where register_id = v_reg;
  for x in select value from jsonb_array_elements(coalesce(p_marks, '[]'::jsonb)) loop
    v_enrol := (x->>'enrolmentId')::uuid; v_status := x->>'status';
    if v_status not in ('present', 'absent', 'late', 'excused') then raise exception 'Invalid attendance status' using errcode = '22023'; end if;
    if not exists (select 1 from public.batch_enrolments where id = v_enrol and intake_id = cs.intake_id and status in ('active', 'deferred')) then
      raise exception 'Student is not enrolled in this intake' using errcode = '22023';
    end if;
    insert into public.lms_attendance_marks(register_id, enrolment_id, status) values (v_reg, v_enrol, v_status);
  end loop;
  if p_state = 'final' and exists (select 1 from public.batch_enrolments e where e.intake_id = cs.intake_id and e.status in ('active', 'deferred') and e.enrolled_on <= cs.session_date
      and not exists (select 1 from public.lms_attendance_marks m where m.register_id = v_reg and m.enrolment_id = e.id)) then
    raise exception 'Mark every student before saving as final' using errcode = '22023';
  end if;
  return jsonb_build_object('saved', true, 'state', p_state);
end;
$function$;

-- course_completion_units(p_enrolment uuid)
CREATE OR REPLACE FUNCTION public.course_completion_units(p_enrolment uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('code', u.code, 'name', u.name, 'outcome', o.outcome, 'date', o.signed_at::date) order by iu.sort, iu.start_date, u.sort), '[]'::jsonb)
  from public.batch_enrolments e
  join public.intake_units iu on iu.intake_id = e.intake_id
  join public.cms_course_units u on u.id = iu.unit_id
  left join lateral (select x.outcome, x.signed_at from public.asm_unit_outcomes x
    where x.student_id = e.student_id and x.unit_id = u.id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = x.id)
    order by x.signed_at desc limit 1) o on true
  where e.id = p_enrolment;
$function$;

-- course_completion_issue(p_enrolment uuid, p_kind text)
CREATE OR REPLACE FUNCTION public.course_completion_issue(p_enrolment uuid, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare e public.batch_enrolments; s public.enrollment_students; c public.cms_courses; v_course text; v_units jsonb; v_total int; v_c int;
  v_name text; r public.course_completions;
begin
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'RTO Manager permission required' using errcode = '42501'; end if;
  if p_kind not in ('certificate', 'statement') then raise exception 'Unknown document' using errcode = '22023'; end if;
  select * into e from public.batch_enrolments where id = p_enrolment for update;
  if not found then raise exception 'Enrolment not found' using errcode = 'P0002'; end if;
  if e.status = 'withdrawn' then raise exception 'This student has withdrawn from the intake' using errcode = '22023'; end if;
  if exists (select 1 from public.course_completions where enrolment_id = e.id and kind = p_kind and revoked_at is null) then
    raise exception 'Already issued. Revoke the current one first to issue again.' using errcode = '23505';
  end if;
  select * into s from public.enrollment_students where id = e.student_id;
  select ci.course_id into v_course from public.course_intakes ci where ci.id = e.intake_id;
  select * into c from public.cms_courses where id = v_course;
  v_units := public.course_completion_units(e.id);
  v_total := jsonb_array_length(v_units);
  select count(*) into v_c from jsonb_array_elements(v_units) u where u->>'outcome' = 'C';
  if v_total = 0 then raise exception 'This intake has no units' using errcode = '22023'; end if;
  if p_kind = 'certificate' and v_c < v_total then
    raise exception 'A certificate needs every unit marked Competent (% of % so far)', v_c, v_total using errcode = '22023';
  end if;
  if p_kind = 'statement' and v_c = 0 then raise exception 'A statement of attainment needs at least one Competent unit' using errcode = '22023'; end if;
  if p_kind = 'statement' then
    select coalesce(jsonb_agg(u), '[]'::jsonb) into v_units from jsonb_array_elements(v_units) u where u->>'outcome' = 'C';
  end if;
  select name into v_name from public.cms_users where auth_user_id = auth.uid() limit 1;
  insert into public.course_completions(enrolment_id, student_id, intake_id, course_id, kind, certificate_no, student_name, course_code, course_name, units, issued_by_name)
  values (e.id, e.student_id, e.intake_id, v_course, p_kind,
    'SLIT-' || case p_kind when 'certificate' then 'C' else 'SOA' end || '-' || to_char(now() at time zone 'Australia/Melbourne', 'YYYY') || '-' || lpad(nextval('public.course_completion_seq')::text, 6, '0'),
    s.full_name, coalesce(c.code, ''), coalesce(c.name, ''), v_units, coalesce(v_name, ''))
  returning * into r;
  if p_kind = 'certificate' then update public.batch_enrolments set status = 'completed' where id = e.id; end if;
  return public.course_completion_json(r);
end;
$function$;

-- course_completion_list(p_batch uuid)
CREATE OR REPLACE FUNCTION public.course_completion_list(p_batch uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not coalesce(public.cms_is_staff(), false) then raise exception 'CMS staff access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x->>'studentName') from (
    select jsonb_build_object('enrolmentId', e.id, 'studentId', s.id, 'studentName', s.full_name, 'enrolmentStatus', e.status,
      'units', public.course_completion_units(e.id),
      'completions', coalesce((select jsonb_agg(public.course_completion_json(cc) order by cc.issued_at desc) from public.course_completions cc
        where cc.enrolment_id = e.id and cc.revoked_at is null), '[]'::jsonb)) as x
    from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id
    where e.intake_id = p_batch) t), '[]'::jsonb);
end;
$function$;

-- course_completion_revoke(p_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.course_completion_revoke(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.course_completions;
begin
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'RTO Manager permission required' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason' using errcode = '22023'; end if;
  update public.course_completions set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = btrim(p_reason)
  where id = p_id and revoked_at is null returning * into r;
  if not found then raise exception 'Not found or already revoked' using errcode = 'P0002'; end if;
  if r.kind = 'certificate' then update public.batch_enrolments set status = 'active' where id = r.enrolment_id and status = 'completed'; end if;
  return public.course_completion_json(r);
end;
$function$;

-- unit_documents(p_action text, p_data jsonb)
CREATE OR REPLACE FUNCTION public.unit_documents(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'hr', 'pg_temp'
AS $function$
declare v_admin uuid := hr.require_admin(); d jsonb := coalesce(p_data, '{}'::jsonb); v_template uuid; v_unit text; v_course text; v_batch uuid;
begin
 if p_action = 'links' then
  -- Every unit link, for the Sign › Templates list.
  return coalesce((select jsonb_agg(jsonb_build_object('templateId', l.template_id, 'courseId', l.course_id, 'unitId', l.unit_id, 'unitCode', u.code, 'unitName', u.name))
   from public.sign_template_units l join public.cms_course_units u on u.id = l.unit_id), '[]'::jsonb);

 elsif p_action = 'link_set' then
  v_template := nullif(d->>'templateId', '')::uuid; v_unit := nullif(d->>'unitId', '');
  if v_template is null or not exists (select 1 from hr.sign_templates t where t.id = v_template and t.deleted_at is null) then raise exception 'Template not found' using errcode = 'P0002'; end if;
  if v_unit is null then
   delete from public.sign_template_units where template_id = v_template;
   return jsonb_build_object('ok', true, 'templateId', v_template, 'unitId', null);
  end if;
  select u.course_id into v_course from public.cms_course_units u where u.id = v_unit;
  if v_course is null then raise exception 'Unit not found' using errcode = 'P0002'; end if;
  if nullif(d->>'courseId', '') is not null and d->>'courseId' <> v_course then raise exception 'The unit does not belong to the course' using errcode = '22023'; end if;
  insert into public.sign_template_units(template_id, course_id, unit_id, created_by) values (v_template, v_course, v_unit, v_admin)
  on conflict (template_id) do update set course_id = excluded.course_id, unit_id = excluded.unit_id, updated_at = now();
  return jsonb_build_object('ok', true, 'templateId', v_template, 'courseId', v_course, 'unitId', v_unit);

 elsif p_action = 'batch_status' then
  -- The active templates of one unit, with who in the intake was sent each and the state of that request.
  v_batch := coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid; v_unit := nullif(d->>'unitId', '');
  if v_batch is null or v_unit is null then raise exception 'batchId and unitId are required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('templateId', t.id, 'name', t.name, 'title', t.title, 'version', t.version, 'roles', t.roles,
    'sends', coalesce((select jsonb_agg(jsonb_build_object('studentId', s.student_id, 'requestId', s.request_id, 'sentAt', s.created_at,
       'state', case when r.id is null then null else hr.sign_status(r) end, 'reference', r.reference))
      from public.sign_batch_sends s left join hr.sign_requests r on r.id = s.request_id where s.template_id = t.id and s.intake_id = v_batch), '[]'::jsonb))
    order by lower(t.name))
   from hr.sign_templates t join public.sign_template_units l on l.template_id = t.id
   where l.unit_id = v_unit and t.deleted_at is null and t.status = 'active'), '[]'::jsonb);

 elsif p_action = 'send_record' then
  v_template := nullif(d->>'templateId', '')::uuid; v_batch := coalesce(nullif(d->>'batchId', ''), nullif(d->>'intakeId', ''))::uuid;
  if v_template is null or v_batch is null or nullif(d->>'studentId', '') is null then raise exception 'templateId, batchId and studentId are required' using errcode = '22023'; end if;
  if not exists (select 1 from public.batch_enrolments e where e.intake_id = v_batch and e.student_id = (d->>'studentId')::uuid) then
   raise exception 'The student is not in this intake' using errcode = '22023'; end if;
  insert into public.sign_batch_sends(template_id, intake_id, student_id, request_id, created_by)
  values (v_template, v_batch, (d->>'studentId')::uuid, nullif(d->>'requestId', '')::uuid, v_admin)
  on conflict (template_id, intake_id, student_id) do update set request_id = excluded.request_id, created_at = now(), created_by = excluded.created_by;
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown unit documents action' using errcode = '22023';
end $function$;

-- ==== g7_views
-- lms_batches_without_classes()
CREATE OR REPLACE FUNCTION public.lms_batches_without_classes()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then raise exception 'Admin access required' using errcode = '42501'; end if;
  return (select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
    select jsonb_build_object('id', ci.id, 'title', coalesce(nullif(c.code, ''), c.name) || ' · ' || public.intake_group_name(ci.id),
      'detail', (select count(*) from public.batch_enrolments e where e.intake_id = ci.id and e.status in ('active', 'deferred')) || ' students · intake '
        || to_char(ci.start_date, 'DD Mon YYYY') || ' · set weekly class times that fit the unit hours',
      'to', '/admin/lms/intakes#' || ci.id) i, row_number() over (order by ci.start_date, public.intake_group_name(ci.id)) n
    from public.course_intakes ci join public.cms_courses c on c.id = ci.course_id
    where public.intake_has_group(ci.id) and coalesce(ci.end_date, ci.start_date) >= public.course_intake_today()
      and exists (select 1 from public.batch_enrolments e where e.intake_id = ci.id and e.status in ('active', 'deferred'))
      and not exists (select 1 from public.class_sessions cs where cs.intake_id = ci.id)) t);
end;
$function$;

-- admin_calendar_people()
CREATE OR REPLACE FUNCTION public.admin_calendar_people()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
begin
  if not public.admin_calendar_can() then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'courses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name) order by c.code)
      from public.cms_courses c where exists (select 1 from public.course_intakes i where i.course_id = c.id)), '[]'::jsonb),
    'intakes', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'courseId', i.course_id, 'startDate', i.start_date, 'endDate', i.end_date,
      'status', i.status) order by i.start_date) from public.course_intakes i where i.is_active), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'intakeId', g.id) order by g.name)
      from (select ci.id, public.intake_group_name(ci.id) as name from public.course_intakes ci where public.intake_has_group(ci.id)) g), '[]'::jsonb),
    'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)) order by p.first_name, p.last_name)
      from hr.staff_profiles p where p.id in (select staff_id from public.intake_trainers union select trainer_id from public.intake_units where trainer_id is not null)), '[]'::jsonb),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'campus', r.campus) order by r.campus, r.sort, r.name)
      from public.classrooms r where r.is_active), '[]'::jsonb),
    'students', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.full_name, 'email', s.email) order by s.full_name)
      from public.enrollment_students s where exists (select 1 from public.batch_enrolments e where e.student_id = s.id and e.status in ('active', 'deferred'))), '[]'::jsonb));
end;
$function$;

-- admin_class_calendar(date,date,jsonb)
CREATE OR REPLACE FUNCTION public.admin_class_calendar(p_from date, p_to date, p_filter jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
declare f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_course text := nullif(f->>'courseId', ''); v_intake uuid := nullif(f->>'intakeId', '')::uuid; v_batch uuid := nullif(f->>'batchId', '')::uuid;
  v_staff uuid := nullif(f->>'staffId', '')::uuid; v_room uuid := nullif(f->>'roomId', '')::uuid; v_student uuid := nullif(f->>'studentId', '')::uuid;
begin
  if not public.admin_calendar_can() then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 93 then raise exception 'Choose up to 93 days' using errcode = '22023'; end if;
  return coalesce((
    with s as (
      select cs.*, public.intake_group_name(ci.id) batch_name, ci.course_id, ci.start_date intake_start, ci.end_date intake_end
      from public.class_sessions cs join public.course_intakes ci on ci.id = cs.intake_id
      where cs.session_date between p_from and p_to
        and (v_course is null or ci.course_id = v_course) and (v_intake is null or cs.intake_id = v_intake)
        and (v_batch is null or cs.intake_id = v_batch) and (v_room is null or cs.room_id = v_room)),
    eu as (
      select e.id enrolment_id, e.intake_id, e.student_id, u.unit_id
      from public.batch_enrolments e cross join lateral public.rto_enrolment_units(e.id) u
      where e.status in ('active', 'deferred') and e.intake_id in (select distinct intake_id from s)),
    t as (
      select s.id session_id, coalesce(
        (select jsonb_agg(distinct jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)))
          from public.intake_units iu join hr.staff_profiles p on p.id = iu.trainer_id
          where iu.intake_id = s.intake_id and iu.unit_id = s.unit_id),
        (select jsonb_agg(distinct jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)))
          from public.intake_trainers it join hr.staff_profiles p on p.id = it.staff_id where it.intake_id = s.intake_id),
        '[]'::jsonb) trainers
      from s)
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'date', s.session_date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
      'type', s.session_type, 'status', s.status, 'batchId', s.intake_id, 'batch', s.batch_name, 'intakeId', s.intake_id,
      'intakeStart', s.intake_start, 'intakeEnd', s.intake_end, 'courseId', s.course_id, 'courseCode', c.code, 'courseName', c.name,
      'unitId', s.unit_id, 'unitCode', u.code, 'unitName', u.name, 'roomId', s.room_id, 'room', r.name, 'campus', r.campus,
      'trainers', t.trainers,
      'students', (select count(distinct eu.student_id) from eu where eu.intake_id = s.intake_id and (s.unit_id is null or eu.unit_id = s.unit_id)),
      'attendance', (select reg.state from public.lms_attendance_register reg join public.intake_units iu on iu.id = reg.intake_unit_id
        where reg.intake_id = s.intake_id and iu.unit_id = s.unit_id and reg.class_date = s.session_date limit 1))
      order by s.session_date, s.start_time, s.batch_name)
    from s join t on t.session_id = s.id join public.cms_courses c on c.id = s.course_id
    left join public.cms_course_units u on u.id = s.unit_id left join public.classrooms r on r.id = s.room_id
    where (v_staff is null or t.trainers @> jsonb_build_array(jsonb_build_object('id', v_staff)))
      and (v_student is null or exists (select 1 from eu where eu.intake_id = s.intake_id and eu.student_id = v_student
        and (s.unit_id is null or eu.unit_id = s.unit_id)))), '[]'::jsonb);
end;
$function$;

-- admin_class_session_students(uuid)
CREATE OR REPLACE FUNCTION public.admin_class_session_students(p_session uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cs public.class_sessions;
begin
  if not public.admin_calendar_can() then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
  select * into cs from public.class_sessions where id = p_session;
  if cs.id is null then raise exception 'Class not found' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.full_name, 'email', st.email, 'joined', e.enrolled_on,
      'carryOver', e.carry_over, 'prereqFirst', e.prereq_first, 'status', e.status,
      'mark', (select m.status from public.lms_attendance_register reg join public.intake_units iu on iu.id = reg.intake_unit_id
        join public.lms_attendance_marks m on m.register_id = reg.id and m.enrolment_id = e.id
        where reg.intake_id = cs.intake_id and iu.unit_id = cs.unit_id and reg.class_date = cs.session_date limit 1))
      order by st.full_name)
    from public.batch_enrolments e join public.enrollment_students st on st.id = e.student_id
    where e.intake_id = cs.intake_id and e.status in ('active', 'deferred')
      and (cs.unit_id is null or exists (select 1 from public.rto_enrolment_units(e.id) u where u.unit_id = cs.unit_id))), '[]'::jsonb);
end;
$function$;

-- admin_intakes_timeline(date,date)
CREATE OR REPLACE FUNCTION public.admin_intakes_timeline(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.admin_calendar_can() then raise exception 'Admins and RTO Managers only' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then raise exception 'Choose up to three years' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'courseId', i.course_id, 'courseCode', c.code, 'courseName', c.name,
      'startDate', i.start_date, 'endDate', coalesce(i.end_date, (select max(end_date) from public.intake_units where intake_id = i.id), i.start_date),
      'status', i.status, 'studyLoad', i.study_load, 'autoCreated', coalesce(i.auto_created, false),
      'batches', case when public.intake_has_group(i.id) then 1 else 0 end,
      'students', (select count(distinct e.student_id) from public.batch_enrolments e
        where e.intake_id = i.id and e.status in ('active', 'deferred')),
      'units', coalesce((select jsonb_agg(jsonb_build_object('code', u.code, 'name', u.name, 'start', iu.start_date, 'end', iu.end_date)
        order by iu.start_date, iu.sort) from public.intake_units iu join public.cms_course_units u on u.id = iu.unit_id where iu.intake_id = i.id), '[]'::jsonb))
      order by c.code, i.start_date)
    from public.course_intakes i join public.cms_courses c on c.id = i.course_id
    where i.is_active and i.start_date <= p_to
      and coalesce(i.end_date, (select max(end_date) from public.intake_units where intake_id = i.id), i.start_date) >= p_from), '[]'::jsonb);
end;
$function$;

-- admin_prereq_sessions(date,date,jsonb)
CREATE OR REPLACE FUNCTION public.admin_prereq_sessions(p_from date, p_to date, p_filter jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
declare f jsonb := coalesce(p_filter, '{}'::jsonb);
begin
  if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
    raise exception 'Admins and RTO Managers only' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 93 then raise exception 'Choose up to 93 days' using errcode = '22023'; end if;
  if nullif(f->>'intakeId', '') is not null or nullif(f->>'batchId', '') is not null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', 'prereq:' || s.class_id || ':' || s.unit_id || ':' || s.session_date || ':' || s.start_time,
      'date', s.session_date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type,
      'status', 'scheduled', 'batchId', null, 'batch', 'Prerequisites', 'intakeId', null, 'intakeStart', null, 'intakeEnd', null,
      'courseId', s.course_id, 'courseCode', c.code, 'courseName', c.name, 'unitId', s.unit_id, 'unitCode', u.code, 'unitName', u.name,
      'roomId', s.room_id, 'room', r.name, 'campus', r.campus, 'prerequisite', true,
      'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name))) from hr.staff_profiles p where p.id = s.trainer_id), '[]'::jsonb),
      'students', cardinality(s.student_ids), 'attendance', null,
      'studentList', (select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.full_name, 'email', st.email) order by st.full_name)
        from public.enrollment_students st where st.id = any(s.student_ids)))
      order by s.session_date, s.start_time)
    from public.prereq_class_sessions(p_from, p_to, nullif(f->>'courseId', '')) s join public.cms_courses c on c.id = s.course_id
    left join public.cms_course_units u on u.id = s.unit_id left join public.classrooms r on r.id = s.room_id
    where (nullif(f->>'staffId', '') is null or s.trainer_id = (f->>'staffId')::uuid)
      and (nullif(f->>'roomId', '') is null or s.room_id = (f->>'roomId')::uuid)
      and (nullif(f->>'studentId', '') is null or (f->>'studentId')::uuid = any(s.student_ids))), '[]'::jsonb);
end;
$function$;

-- admin_student_schedule(uuid,date,date)
CREATE OR REPLACE FUNCTION public.admin_student_schedule(p_student uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'Choose up to a year' using errcode = '22023'; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('date', cs.session_date, 'start', to_char(cs.start_time, 'HH24:MI'), 'end', to_char(cs.end_time, 'HH24:MI'), 'type', cs.session_type,
    'status', cs.status, 'batch', public.intake_group_name(ci.id), 'courseCode', c.code, 'unitCode', u.code, 'unitName', u.name, 'room', r.name) order by cs.session_date, cs.start_time)
  from public.class_sessions cs join public.course_intakes ci on ci.id = cs.intake_id
  join public.cms_courses c on c.id = ci.course_id left join public.cms_course_units u on u.id = cs.unit_id left join public.classrooms r on r.id = cs.room_id
  where cs.session_date between p_from and p_to
   and exists (select 1 from public.batch_enrolments e where e.intake_id = ci.id and e.student_id = p_student and e.status in ('active', 'deferred')
    and (cs.unit_id is null or exists (select 1 from public.rto_enrolment_units(e.id) eu where eu.unit_id = cs.unit_id)))), '[]'::jsonb);
end $function$;

-- admin_student_study(uuid)
CREATE OR REPLACE FUNCTION public.admin_student_study(p_student uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'enrolmentId', e.id, 'status', e.status, 'type', e.enrolment_type, 'enrolledOn', e.enrolled_on, 'carryOver', e.carry_over,
   'courseCode', c.code, 'courseName', c.name, 'intakeId', i.id, 'intake', public.course_intake_name(i), 'intakeStart', i.start_date,
   'batchId', i.id, 'batch', public.intake_group_name(i.id), 'room', (select r.name from public.classrooms r where r.id = i.classroom_id),
   'units', coalesce((select jsonb_agg(jsonb_build_object('code', cu.code, 'name', cu.name, 'start', m.start_date, 'end', m.end_date) order by m.start_date, m.sort)
     from public.rto_enrolment_units(e.id) m join public.cms_course_units cu on cu.id = m.unit_id), '[]'::jsonb),
   'path', public.rto_enrolment_path(e)) order by i.start_date desc, e.enrolled_on desc)
  from public.batch_enrolments e join public.course_intakes i on i.id = e.intake_id
  join public.cms_courses c on c.id = i.course_id
  where e.student_id = p_student and e.status <> 'withdrawn'), '[]'::jsonb);
end $function$;

-- admin_student_timeline(uuid)
CREATE OR REPLACE FUNCTION public.admin_student_timeline(p_student uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.enrollment_students; v_email text;
begin
  perform public.admin_business_require();
  select * into s from public.enrollment_students where id = p_student;
  if not found then return null; end if;
  v_email := lower(nullif(btrim(coalesce(s.email, '')), ''));
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.at desc) from (
    select * from (
      select s.created_at as at, 'student' as kind, 'Student record created' as title, '' as detail, null::uuid as application_id
      union all
      select a.created_at, 'application', 'Application ' || coalesce(nullif(a.reference, ''), 'started'), 'Draft created', a.id
      from public.enrollment_applications a where a.student_id = s.id
      union all
      select a.submitted_at, 'application', 'Application ' || coalesce(nullif(a.reference, ''), '') || ' submitted', '', a.id
      from public.enrollment_applications a where a.student_id = s.id and a.submitted_at is not null
      union all
      select h.created_at, 'status', 'Status: ' || replace(h.new_status, '_', ' '),
        concat_ws(' · ', nullif(h.actor_name, ''), nullif(h.note, '')), h.application_id
      from public.enrollment_application_status_history h join public.enrollment_applications a on a.id = h.application_id
      where a.student_id = s.id
      union all
      select l.issued_at, 'offer', 'Offer letter sent', concat_ws(' · ', 'To ' || nullif(l.recipient_name, ''), nullif(l.issued_by_name, '')), l.application_id
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id where a.student_id = s.id
      union all
      select (to_jsonb(l)->>'signed_at')::timestamptz, 'offer', 'Offer letter signed', '', l.application_id
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      where a.student_id = s.id and to_jsonb(l)->>'signed_at' is not null
      union all
      select l.accepted_at, 'offer', 'Offer accepted', nullif(l.accepted_by_name, ''), l.application_id
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      where a.student_id = s.id and l.accepted_at is not null
      union all
      select (to_jsonb(l)->>'deposit_paid_at')::timestamptz, 'payment', 'Deposit paid', '', l.application_id
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      where a.student_id = s.id and to_jsonb(l)->>'deposit_paid_at' is not null
      union all
      select coalesce(d.issued_at, d.uploaded_at), 'coe', case d.kind when 'voe' then 'VoE' else 'CoE' end || case when d.issued_at is null then ' uploaded' else ' issued' end,
        coalesce(d.document_number, ''), d.application_id
      from public.enrollment_coe_documents d join public.enrollment_applications a on a.id = d.application_id
      where a.student_id = s.id and d.superseded_at is null
      union all
      select e.enrolled_on::timestamptz, 'enrolment', 'Enrolled in intake ' || public.intake_group_name(ci.id), coalesce(nullif(c.name, ''), c.code) || ' · ' || e.enrolment_type || ' · ' || e.status, null
      from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
      join public.cms_courses c on c.id = ci.course_id where e.student_id = s.id
      union all
      select o.at, 'enrolment', 'Staff override: ' || o.action || coalesce(' (intake ' || public.intake_group_name(o.intake_id) || ')', ''), o.reason, null
      from public.rto_placement_overrides o where o.student_id = s.id
      union all
      select g.class_date::timestamptz, 'attendance', initcap(m.status) || ' in class', coalesce(u.code, '') || ' · intake ' || public.intake_group_name(g.intake_id), null
      from public.lms_attendance_marks m join public.lms_attendance_register g on g.id = m.register_id and g.state = 'final'
      join public.batch_enrolments e on e.id = m.enrolment_id
      join public.intake_units iu on iu.id = g.intake_unit_id join public.cms_course_units u on u.id = iu.unit_id
      where e.student_id = s.id and m.status <> 'present'
      union all
      select m.created_at, 'message',
        case m.channel when 'note' then 'Internal note' when 'teams' then 'Shared to team' else initcap(m.channel) || case m.direction when 'in' then ' received' else ' sent' end end,
        left(concat_ws(': ', nullif(m.subject, ''), m.body), 200) || coalesce(' · ' || nullif(m.sent_by_name, ''), ''), null
      from public.comm_messages m join public.comm_conversations cv on cv.id = m.conversation_id
      where cv.person_kind = 'student' and cv.person_ref = s.id
      union all
      select coalesce(n.sent_at, n.created_at), 'email', 'Email: ' || n.subject,
        case when n.sent_at is not null then 'Sent automatically' else 'Not sent (' || n.state || ')' end, n.application_id
      from public.notification_deliveries n
      where v_email is not null and lower(n.recipient_email) = v_email and n.hub_message_id is null
      union all
      select t.submitted_at, 'assessment', 'Submitted ' || x.title || ' (attempt ' || t.attempt_no || ')', coalesce(t.receipt_no, ''), null
      from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id
      where t.student_id = s.id and t.submitted_at is not null
      union all
      select t.finalised_at, 'assessment', 'Result for ' || x.title || ': ' || case t.outcome when 'S' then 'Satisfactory' when 'NYS' then 'Not yet satisfactory' else coalesce(t.outcome, 'final') end, '', null
      from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id
      where t.student_id = s.id and t.finalised_at is not null
      union all
      select cc.issued_at, 'certificate', case cc.kind when 'certificate' then 'Certificate issued' else 'Statement of attainment issued' end,
        cc.certificate_no || ' · ' || cc.course_code || ' ' || cc.course_name, null
      from public.course_completions cc where cc.student_id = s.id
      union all
      select cc.revoked_at, 'certificate', case cc.kind when 'certificate' then 'Certificate revoked' else 'Statement revoked' end,
        cc.certificate_no || coalesce(' · ' || cc.revoke_reason, ''), null
      from public.course_completions cc where cc.student_id = s.id and cc.revoked_at is not null
      union all
      select o.created_at, 'account', 'Student email account created', o.upn, null
      from public.student_office365_accounts o where o.student_id = s.id
    ) u where u.at is not null order by u.at desc limit 500
  ) t), '[]'::jsonb);
end;
$function$;

-- admin_today()
CREATE OR REPLACE FUNCTION public.admin_today()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_today date := (now() at time zone 'Australia/Melbourne')::date; r jsonb := '{}'::jsonb;
begin
  if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  r := r || jsonb_build_object('references', jsonb_build_object('count', (select count(*) from public.agency_onboarding o where o.stage = 'references_received' or (o.kind = 'agent' and o.stage = 'agreement_signed') or (o.kind = 'agent' and o.stage = 'agreement_sent' and exists (select 1 from hr.sign_requests q where q.id = o.agreement_request_id and q.state = 'partial'))), 'items', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', a.name, 'detail', case when o.kind = 'agent' and o.stage = 'agreement_sent' then 'Agent signed their agreement: SLIT to countersign' when o.kind = 'agent' and o.stage = 'agreement_signed' then 'Agent signed their agreement: activate or reject' when o.kind = 'agent' then 'Agent references received: send the individual agent agreement or reject' else 'References received: review and approve or decline' end, 'at', o.references_received_at, 'to', '/admin/businesses/' || a.id::text) order by o.references_received_at) from public.agency_onboarding o join public.agencies a on a.id = o.agency_id where o.stage = 'references_received' or (o.kind = 'agent' and o.stage = 'agreement_signed') or (o.kind = 'agent' and o.stage = 'agreement_sent' and exists (select 1 from hr.sign_requests q where q.id = o.agreement_request_id and q.state = 'partial'))), '[]'::jsonb)));
 r := r || jsonb_build_object('applications', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', a.id, 'title', coalesce(s.full_name, 'Applicant'), 'detail', coalesce(nullif(a.reference, ''), 'Application') || ' · ' || replace(a.status, '_', ' '),
        'at', coalesce(a.submitted_at, a.updated_at), 'to', '/admin/applications/' || a.id) i, row_number() over (order by coalesce(a.submitted_at, a.updated_at)) n
      from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id
      where a.status in ('submitted', 'under_review')) t));

  r := r || jsonb_build_object('documents', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', d.id, 'title', coalesce(s.full_name, 'Applicant'), 'detail', d.category || ' · ' || d.filename,
        'at', d.created_at, 'to', '/admin/applications/' || d.application_id) i, row_number() over (order by d.created_at) n
      from public.enrollment_application_documents d join public.enrollment_applications a on a.id = d.application_id
      left join public.enrollment_students s on s.id = a.student_id
      where d.review_state = 'Pending' and d.is_current and a.status not in ('draft', 'withdrawn', 'rejected')) t));

  r := r || jsonb_build_object('unsignedOffers', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', l.id, 'title', coalesce(s.full_name, l.recipient_name), 'detail', 'Sent ' || to_char(l.issued_at at time zone 'Australia/Melbourne', 'DD Mon'),
        'at', l.issued_at, 'to', '/admin/applications/' || l.application_id) i, row_number() over (order by l.issued_at) n
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      left join public.enrollment_students s on s.id = a.student_id
      where a.status = 'offer_issued' and l.accepted_at is null and to_jsonb(l)->>'signed_at' is null and l.issued_at < now() - interval '3 days'
        and not exists (select 1 from public.enrollment_offer_letters z where z.application_id = l.application_id and z.issued_at > l.issued_at)) t));

  r := r || jsonb_build_object('unpaidDeposits', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', l.id, 'title', coalesce(s.full_name, l.recipient_name),
        'detail', '$' || to_char((to_jsonb(l)->>'payment_amount_cents')::numeric / 100, 'FM999,999,990.00') || ' due',
        'at', coalesce((to_jsonb(l)->>'signed_at')::timestamptz, l.accepted_at), 'to', '/admin/applications/' || l.application_id) i,
        row_number() over (order by coalesce((to_jsonb(l)->>'signed_at')::timestamptz, l.accepted_at)) n
      from public.enrollment_offer_letters l join public.enrollment_applications a on a.id = l.application_id
      left join public.enrollment_students s on s.id = a.student_id
      where coalesce((to_jsonb(l)->>'payment_amount_cents')::int, 0) > 0 and to_jsonb(l)->>'deposit_paid_at' is null
        and (to_jsonb(l)->>'signed_at' is not null or l.accepted_at is not null) and a.status in ('offer_issued', 'offer_accepted')) t));

  r := r || jsonb_build_object('lowAttendance', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', e.id, 'title', s.full_name, 'detail', round(rate) || '% · ' || public.intake_group_name(e.intake_id), 'to', '/admin/students/' || s.id) i,
        row_number() over (order by rate) n
      from (select m.enrolment_id, 100.0 * count(*) filter (where m.status in ('present', 'late')) / nullif(count(*) filter (where m.status <> 'excused'), 0) rate,
              count(*) filter (where m.status <> 'excused') counted
            from public.lms_attendance_marks m join public.lms_attendance_register g on g.id = m.register_id and g.state = 'final'
            group by m.enrolment_id) x
      join public.batch_enrolments e on e.id = x.enrolment_id and e.status = 'active'
      join public.enrollment_students s on s.id = e.student_id join public.course_intakes ei on ei.id = e.intake_id
      where x.counted >= 3 and x.rate < 80) t));

  r := r || jsonb_build_object('marking', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', t.id, 'title', s.full_name, 'detail', x.title || ' · attempt ' || t.attempt_no, 'at', t.submitted_at,
        'to', '/admin/assessments/' || x.id) i, row_number() over (order by t.submitted_at) n
      from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id
      join public.enrollment_students s on s.id = t.student_id
      where t.state in ('submitted', 'marking')) t));

  r := r || jsonb_build_object('tickets', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', k.id, 'title', k.subject, 'detail', concat_ws(' · ', k.ref, nullif(k.requester_name, ''), replace(k.status, '_', ' ')),
        'at', k.created_at, 'to', '/admin/tickets/' || k.id) i,
        row_number() over (order by k.created_at) n
      from public.support_tickets k where k.status in ('open', 'in_progress')) t));

  r := r || jsonb_build_object('classesToday', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', cs.id, 'title', to_char(cs.start_time, 'HH24:MI') || '–' || to_char(cs.end_time, 'HH24:MI') || ' ' || coalesce(u.code, c.code),
        'detail', 'Class ' || public.intake_group_name(ci.id) || coalesce(' · Room ' || rm.name, ''), 'to', '/admin/lms/timetable') i, row_number() over (order by cs.start_time) n
      from public.class_sessions cs join public.course_intakes ci on ci.id = cs.intake_id
      join public.cms_courses c on c.id = ci.course_id left join public.cms_course_units u on u.id = cs.unit_id left join public.classrooms rm on rm.id = cs.room_id
      where cs.session_date = v_today and cs.status = 'scheduled') t));

  r := r || jsonb_build_object('certificatesReady', (
    select jsonb_build_object('count', count(*), 'items', coalesce(jsonb_agg(i) filter (where n <= 5), '[]'::jsonb)) from (
      select jsonb_build_object('id', e.id, 'title', s.full_name, 'detail', 'Class ' || public.intake_group_name(e.intake_id) || ' · all units competent', 'to', '/admin/lms/completion') i,
        row_number() over (order by s.full_name) n
      from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id join public.course_intakes ei on ei.id = e.intake_id
      where e.status in ('active', 'completed')
        and not exists (select 1 from public.course_completions cc where cc.enrolment_id = e.id and cc.kind = 'certificate' and cc.revoked_at is null)
        and exists (select 1 from public.intake_units iu where iu.intake_id = e.intake_id)
        and not exists (select 1 from public.intake_units iu where iu.intake_id = e.intake_id and coalesce((
          select o.outcome from public.asm_unit_outcomes o where o.student_id = e.student_id and o.unit_id = iu.unit_id
            and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by o.signed_at desc limit 1), '') <> 'C')) t));

  return r;
end;
$function$;

-- my_class_schedule(date,date)
CREATE OR REPLACE FUNCTION public.my_class_schedule(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
declare v_student uuid := public.portal_student_id(); v_staff uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 120 then raise exception 'Choose up to 120 days' using errcode = '22023'; end if;
  if v_student is null then v_staff := public.asm_trainer_profile(); end if;
  if v_student is null and v_staff is null then raise exception 'Student or staff access required' using errcode = '42501'; end if;
  return jsonb_build_object('role', case when v_student is not null then 'student' else 'trainer' end, 'sessions', coalesce((
    select jsonb_agg(jsonb_build_object('id', cs.id, 'date', cs.session_date, 'start', to_char(cs.start_time, 'HH24:MI'), 'end', to_char(cs.end_time, 'HH24:MI'),
      'type', cs.session_type, 'status', cs.status, 'batchName', public.intake_group_name(ci.id), 'courseName', coalesce(nullif(c.name, ''), c.code), 'courseCode', c.code,
      'unitCode', u.code, 'unitName', u.name, 'room', r.name, 'campus', r.campus,
      'trainers', coalesce((select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ')
        from hr.staff_profiles p where p.id in (
          select iu.trainer_id from public.intake_units iu
          where iu.intake_id = ci.id and iu.unit_id = cs.unit_id and iu.trainer_id is not null)), (select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ')
        from public.intake_trainers it join hr.staff_profiles p on p.id = it.staff_id where it.intake_id = ci.id), ''))
      order by cs.session_date, cs.start_time)
    from public.class_sessions cs
    join public.course_intakes ci on ci.id = cs.intake_id
    join public.cms_courses c on c.id = ci.course_id
    left join public.cms_course_units u on u.id = cs.unit_id
    left join public.classrooms r on r.id = cs.room_id
    where cs.session_date between p_from and p_to
      and (case when v_student is not null then exists (select 1 from public.batch_enrolments e where e.intake_id = ci.id and e.student_id = v_student and e.status in ('active', 'deferred')
            and (cs.unit_id is null or exists (select 1 from public.rto_enrolment_units(e.id) eu where eu.unit_id = cs.unit_id)))
        else exists (select 1 from public.intake_trainers it where it.intake_id = ci.id and it.staff_id = v_staff)
          or exists (select 1 from public.intake_units iu
            where iu.intake_id = ci.id and iu.trainer_id = v_staff and iu.unit_id = cs.unit_id) end)), '[]'::jsonb));
end;
$function$;

-- my_prereq_classes(date,date)
CREATE OR REPLACE FUNCTION public.my_prereq_classes(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
declare v_student uuid := public.portal_student_id(); v_staff uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 120 then raise exception 'Choose up to 120 days' using errcode = '22023'; end if;
  if v_student is null then v_staff := public.asm_trainer_profile(); end if;
  if v_student is null and v_staff is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', 'prereq:' || s.class_id || ':' || s.unit_id || ':' || s.session_date || ':' || s.start_time,
      'date', s.session_date, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type,
      'status', 'scheduled', 'batchName', 'Prerequisites', 'courseName', coalesce(nullif(c.name, ''), c.code), 'courseCode', c.code,
      'unitCode', u.code, 'unitName', u.name, 'room', r.name, 'campus', r.campus, 'prerequisite', true,
      'trainers', coalesce((select btrim(p.first_name || ' ' || p.last_name) from hr.staff_profiles p where p.id = s.trainer_id), ''))
      order by s.session_date, s.start_time)
    from public.prereq_class_sessions(p_from, p_to) s join public.cms_courses c on c.id = s.course_id
    left join public.cms_course_units u on u.id = s.unit_id left join public.classrooms r on r.id = s.room_id
    where (v_student is not null and v_student = any(s.student_ids)) or (v_staff is not null and s.trainer_id = v_staff)), '[]'::jsonb);
end;
$function$;

-- prereq_class_ensure()
CREATE OR REPLACE FUNCTION public.prereq_class_ensure()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.prereq_classes(course_id)
  select ci.course_id from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
  where e.id = new.enrolment_id
  on conflict (course_id) do nothing;
  return new;
end;
$function$;

-- prereq_class_sessions(date,date,text)
CREATE OR REPLACE FUNCTION public.prereq_class_sessions(p_from date, p_to date, p_course text DEFAULT NULL::text)
 RETURNS TABLE(class_id uuid, course_id text, unit_id text, session_date date, start_time time without time zone, end_time time without time zone, session_type text, room_id uuid, trainer_id uuid, student_ids uuid[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select pc.id, pc.course_id, cu.unit_id, d::date, t.start_time, t.end_time, t.session_type, coalesce(t.room_id, pc.room_id), pc.trainer_id,
    array_agg(distinct e.student_id)
  from public.prereq_classes pc
  join public.prereq_class_times t on t.class_id = pc.id
  join public.course_intakes ci on ci.course_id = pc.course_id
  join public.batch_enrolments e on e.intake_id = ci.id and e.status in ('active', 'deferred')
  join public.student_prereq_catchup cu on cu.enrolment_id = e.id
  cross join lateral generate_series(greatest(cu.start_date, p_from), least(cu.end_date, p_to), interval '1 day') d
  where (p_course is null or pc.course_id = p_course)
    and extract(isodow from d) = t.weekday and public.rto_is_working_day(d::date)
  group by pc.id, pc.course_id, cu.unit_id, d, t.start_time, t.end_time, t.session_type, coalesce(t.room_id, pc.room_id), pc.trainer_id;
$function$;

-- prereq_class_admin(text,jsonb)
CREATE OR REPLACE FUNCTION public.prereq_class_admin(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'hr'
AS $function$
declare v_course text := nullif(p_data->>'courseId', ''); v_class public.prereq_classes; x jsonb;
begin
  if not (coalesce(public.cms_is_admin(), false) or coalesce(public.cms_is_rto_manager(), false)) then
    raise exception 'Admins and RTO Managers only' using errcode = '42501';
  end if;
  if v_course is null then raise exception 'Choose a course' using errcode = '22023'; end if;
  if p_action = 'save' then
    if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'Only an RTO Manager can change the Prerequisite class' using errcode = '42501'; end if;
    insert into public.prereq_classes(course_id) values (v_course) on conflict (course_id) do nothing;
    update public.prereq_classes set trainer_id = nullif(p_data->>'trainerId', '')::uuid, room_id = nullif(p_data->>'roomId', '')::uuid,
      updated_at = now() where course_id = v_course returning * into v_class;
    delete from public.prereq_class_times where class_id = v_class.id;
    for x in select value from jsonb_array_elements(coalesce(p_data->'times', '[]'::jsonb)) loop
      insert into public.prereq_class_times(class_id, weekday, start_time, end_time, session_type, room_id)
      values (v_class.id, (x->>'weekday')::smallint, (x->>'start')::time, (x->>'end')::time, coalesce(nullif(x->>'type', ''), 'theory'),
        nullif(x->>'roomId', '')::uuid);
    end loop;
  elsif p_action <> 'get' then
    raise exception 'Unknown action' using errcode = '22023';
  end if;
  select * into v_class from public.prereq_classes where course_id = v_course;
  return jsonb_build_object(
    'class', case when v_class.id is null then null else jsonb_build_object('id', v_class.id, 'name', v_class.name, 'trainerId', v_class.trainer_id,
      'roomId', v_class.room_id) end,
    'times', coalesce((select jsonb_agg(jsonb_build_object('weekday', t.weekday, 'start', to_char(t.start_time, 'HH24:MI'), 'end', to_char(t.end_time, 'HH24:MI'),
      'type', t.session_type, 'roomId', t.room_id) order by t.weekday, t.start_time) from public.prereq_class_times t where t.class_id = v_class.id), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(m order by m->>'from') from (
      select jsonb_build_object('studentId', st.id, 'name', st.full_name, 'email', st.email, 'intake', ci.name, 'intakeStart', ci.start_date,
        'from', min(cu.start_date), 'to', max(cu.end_date),
        'returnOn', (select min(iu.start_date) from public.intake_units iu where iu.intake_id = ci.id and iu.start_date > max(cu.end_date)),
        'units', jsonb_agg(jsonb_build_object('code', u.code, 'name', u.name, 'start', cu.start_date, 'end', cu.end_date) order by cu.start_date)) m
      from public.student_prereq_catchup cu join public.batch_enrolments e on e.id = cu.enrolment_id and e.status in ('active', 'deferred')
      join public.course_intakes ci on ci.id = e.intake_id and ci.course_id = v_course
      join public.enrollment_students st on st.id = e.student_id join public.cms_course_units u on u.id = cu.unit_id
      group by st.id, st.full_name, st.email, ci.id, ci.name, ci.start_date) q), '[]'::jsonb));
end;
$function$;

-- student_my_learning()
CREATE OR REPLACE FUNCTION public.student_my_learning()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_student uuid := public.portal_student_id();
begin
  if v_student is null then raise exception 'Student access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'enrolmentId', e.id, 'status', e.status, 'batchName', public.intake_group_name(ci.id), 'courseName', coalesce(nullif(c.name, ''), c.code),
        'courseCode', c.code, 'intakeStart', ci.start_date, 'intakeEnd', ci.end_date,
        'attendance', (
          select jsonb_build_object('classes', count(*), 'present', count(*) filter (where m.status = 'present'),
            'late', count(*) filter (where m.status = 'late'), 'absent', count(*) filter (where m.status = 'absent'),
            'excused', count(*) filter (where m.status = 'excused'))
          from public.lms_attendance_marks m join public.lms_attendance_register r on r.id = m.register_id and r.state = 'final'
          where m.enrolment_id = e.id),
        'units', coalesce((
          select jsonb_agg(jsonb_build_object('unitId', u.id, 'code', u.code, 'name', u.name, 'startDate', iu.start_date, 'endDate', iu.end_date,
            'items', coalesce((
              select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'title', x.title, 'body', x.body, 'url', x.url,
                'path', x.storage_path, 'fileName', x.file_name, 'mimeType', x.mime_type, 'sizeBytes', x.size_bytes) order by x.sort, x.created_at)
              from public.unit_contents x where x.unit_id = u.id and x.visible_to_students), '[]'::jsonb))
            order by iu.sort, iu.start_date, u.sort)
          from public.intake_units iu join public.cms_course_units u on u.id = iu.unit_id
          where iu.intake_id = ci.id), '[]'::jsonb))
        order by ci.start_date desc)
      from public.batch_enrolments e
      join public.course_intakes ci on ci.id = e.intake_id
      join public.cms_courses c on c.id = ci.course_id
      where e.student_id = v_student and e.status in ('active', 'deferred', 'completed')), '[]'::jsonb));
end;
$function$;

-- student_progress_core(uuid)
CREATE OR REPLACE FUNCTION public.student_progress_core(p_student uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 with en as (
  select e.id, public.intake_group_name(ci.id) as batch, public.course_intake_name(ci) as intake, ci.course_id, ci.id as intake_id
  from public.batch_enrolments e join public.course_intakes ci on ci.id = e.intake_id
  where e.student_id = p_student and e.status in ('active', 'deferred', 'completed')),
 needed as (select distinct en.course_id, iu.unit_id from en join public.intake_units iu on iu.intake_id = en.intake_id),
 taken as (select en.course_id, u.unit_id, u.start_date, u.end_date, en.batch, en.intake from en cross join lateral public.rto_enrolment_units(en.id) u),
 rows as (
  select n.course_id, cu.id as unit_id, cu.code, cu.name, coalesce(cu.nominal_hours, 0) as hours, o.signed_on, t.start_date, t.end_date, t.batch, t.intake,
   case when o.outcome = 'C' then 'competent'
        when t.unit_id is not null and t.start_date > public.course_intake_today() then 'upcoming'
        when t.unit_id is not null and t.end_date >= public.course_intake_today() then 'in_progress'
        when o.outcome is not null then 'not_yet_competent'
        when t.unit_id is not null then 'awaiting_result'
        else 'owed' end as status
  from needed n join public.cms_course_units cu on cu.id = n.unit_id
  left join lateral public.rto_unit_outcome(p_student, n.unit_id) o on true
  left join lateral (select t2.* from taken t2 where t2.course_id = n.course_id and t2.unit_id = n.unit_id order by t2.start_date desc limit 1) t on true)
 select coalesce(jsonb_agg(jsonb_build_object(
   'courseId', c.id, 'courseCode', c.code, 'courseName', c.name,
   'total', x.total, 'competent', x.competent, 'inProgress', x.in_progress, 'upcoming', x.upcoming, 'owed', x.owed, 'notYet', x.not_yet, 'awaiting', x.awaiting,
   'hoursTotal', x.hours_total, 'hoursDone', x.hours_done, 'percent', case when x.total = 0 then 0 else round(100.0 * x.competent / x.total) end,
   'units', x.units) order by c.code), '[]'::jsonb)
 from public.cms_courses c
 join lateral (select count(*) total, count(*) filter (where status = 'competent') competent, count(*) filter (where status = 'in_progress') in_progress,
   count(*) filter (where status = 'upcoming') upcoming, count(*) filter (where status = 'owed') owed, count(*) filter (where status = 'not_yet_competent') not_yet,
   count(*) filter (where status = 'awaiting_result') awaiting, sum(hours) hours_total, coalesce(sum(hours) filter (where status = 'competent'), 0) hours_done,
   jsonb_agg(jsonb_build_object('code', code, 'name', name, 'status', status, 'start', start_date, 'end', end_date, 'batch', batch, 'intake', intake, 'signedOn', signed_on, 'hours', hours)
    order by (status = 'competent'), start_date nulls last, code) units
   from rows where rows.course_id = c.id) x on x.total > 0;
$function$;

-- ==== g5_asm_admin
-- asm_admin_scope_check(text,jsonb)
CREATE OR REPLACE FUNCTION public.asm_admin_scope_check(p_action text, d jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v uuid; v_text text;
begin
 v := public.asm_json_uuid(d, 'id');
 if v is not null then
  if p_action like 'assessment\_%' and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assessment not found' using errcode = 'P0002';
  elsif p_action like 'assignment\_%' and not exists (select 1 from public.asm_assignments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assignment not found' using errcode = 'P0002';
  elsif p_action like 'attempt\_%' and not exists (select 1 from public.asm_attempts x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Attempt not found' using errcode = 'P0002';
  elsif p_action like 'bank\_%' and not exists (select 1 from public.asm_question_bank x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Bank question not found' using errcode = 'P0002';
  elsif p_action like 'version\_%' and not exists (select 1 from public.asm_versions x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Version not found' using errcode = 'P0002';
  elsif p_action like 'reassessment\_%' and not exists (select 1 from public.asm_reassessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Request not found' using errcode = 'P0002';
  end if;
 end if;
 v := public.asm_json_uuid(d, 'assessmentId');
 if v is not null and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'fromAssessmentId');
 if v is not null and not exists (select 1 from public.asm_assessments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Source assessment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'versionId');
 if v is not null and not exists (select 1 from public.asm_versions x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Version not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'assignmentId');
 if v is not null and not exists (select 1 from public.asm_assignments x where x.id = v and public.tenant_scope(x.tenant_id)) then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
 v := public.asm_json_uuid(d, 'batchId');
 if v is not null and not exists (select 1 from public.course_intakes i join public.cms_courses c on c.id = i.course_id where i.id = v and public.tenant_scope(c.tenant_id)) then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 v_text := public.asm_json_text(d, 'courseId');
 if v_text is not null and not exists (select 1 from public.cms_courses c where c.id = v_text and public.tenant_scope(c.tenant_id)) then raise exception 'Course not found' using errcode = 'P0002'; end if;
 v_text := public.asm_json_text(d, 'unitId');
 if v_text is not null and not exists (select 1 from public.cms_course_units u where u.id = v_text and public.tenant_scope(u.tenant_id)) then raise exception 'Unit not found' using errcode = 'P0002'; end if;
end $function$;

-- asm_admin(text,jsonb)
CREATE OR REPLACE FUNCTION public.asm_admin(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_id uuid; v_ver public.asm_versions; v_as public.asm_assessments; v_set public.asm_settings; v_tenant uuid;
 x jsonb; n integer := 0; v_errs jsonb; v_defn jsonb; v_keys jsonb; v_maps jsonb; v_bid uuid; v_a public.asm_assignments; v_att public.asm_attempts; v_student uuid;
 v_rv integer; v_unit text; v_elem uuid; v_next uuid; v_due timestamptz; v_text text; v_role text := 'admin';
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_action = 'me' then
  return jsonb_build_object('admin', public.cms_is_admin(), 'rtoManager', public.cms_is_rto_manager(), 'assessmentAdmin', public.asm_is_admin(), 'trainerProfileId', public.asm_trainer_profile());
 end if;
 if not public.asm_is_admin() then raise exception 'Only an Admin or an RTO Manager can manage assessments.' using errcode = '42501'; end if;
 perform public.asm_admin_scope_check(p_action, d);

 -- ---------------------------------------------------------------- settings
 if p_action = 'settings_get' then
  v_tenant := public.tenant_current();
  select * into v_set from public.asm_settings where coalesce(tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000');
  if v_set.id is null then insert into public.asm_settings(tenant_id) values (v_tenant) returning * into v_set; end if;
  return to_jsonb(v_set);
 elsif p_action = 'settings_save' then
  v_tenant := public.tenant_current();
  select * into v_set from public.asm_settings where coalesce(tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000');
  if v_set.id is null then insert into public.asm_settings(tenant_id) values (v_tenant) returning * into v_set; end if;
  update public.asm_settings set
   max_attempts = coalesce((d->>'maxAttempts')::integer, max_attempts), reassessment_days = coalesce((d->>'reassessmentDays')::integer, reassessment_days),
   late_submission = coalesce(d->>'lateSubmission', late_submission), rollup_rule = coalesce(d->>'rollupRule', rollup_rule), due_soon_days = coalesce((d->>'dueSoonDays')::integer, due_soon_days),
   require_trainer_role = coalesce((d->>'requireTrainerRole')::boolean, require_trainer_role),
   declaration_text = coalesce(public.asm_json_text(d, 'declarationText'), declaration_text), instructions = coalesce(d->>'instructions', instructions),
   evidence_max_mb = coalesce((d->>'evidenceMaxMb')::integer, evidence_max_mb),
   evidence_allowed_types = case when jsonb_typeof(d->'evidenceAllowedTypes') = 'array' then (select coalesce(array_agg(ta.v), '{}') from jsonb_array_elements_text(d->'evidenceAllowedTypes') as ta(v)) else evidence_allowed_types end,
   updated_by = auth.uid(), updated_at = now()
  where id = v_set.id returning * into v_set;
  perform public.asm_log(v_role, 'settings_save', 'settings', v_set.id::text, d, v_set.tenant_id);
  return to_jsonb(v_set);

 -- ---------------------------------------------------------------- unit elements
 elsif p_action = 'unit_elements_list' then
  v_unit := public.asm_json_text(d, 'unitId'); if v_unit is null then raise exception 'unitId is required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'parentId', e.parent_id, 'code', e.code, 'text', e.text, 'sort', e.sort, 'isActive', e.is_active) order by e.kind, e.sort, e.code)
    from public.asm_unit_elements e where e.unit_id = v_unit and public.tenant_scope(e.tenant_id)), '[]');
 elsif p_action = 'unit_elements_save' then
  v_unit := public.asm_json_text(d, 'unitId'); if v_unit is null then raise exception 'unitId is required' using errcode = '22023'; end if;
  if not exists (select 1 from public.cms_course_units where id = v_unit) then raise exception 'Unit not found' using errcode = 'P0002'; end if;
  -- items: [{id?, kind, parentId?, parentCode?, code, text, sort}]; items left out are deactivated (mappings keep pointing at them)
  create temp table if not exists asm_tmp_keep(id uuid) on commit drop; delete from asm_tmp_keep;
  for x in select * from jsonb_array_elements(coalesce(d->'items', '[]')) loop
   v_elem := public.asm_json_uuid(x, 'id');
   if v_elem is not null and exists (select 1 from public.asm_unit_elements where id = v_elem and unit_id = v_unit) then
    update public.asm_unit_elements set kind = coalesce(x->>'kind', kind), parent_id = public.asm_json_uuid(x, 'parentId'), code = coalesce(x->>'code', code), text = coalesce(public.asm_json_text(x, 'text'), text),
      sort = coalesce((x->>'sort')::integer, sort), is_active = true where id = v_elem;
   else
    insert into public.asm_unit_elements(unit_id, kind, parent_id, code, text, sort)
    values (v_unit, coalesce(x->>'kind', 'element'), public.asm_json_uuid(x, 'parentId'), coalesce(x->>'code', ''), coalesce(public.asm_json_text(x, 'text'), '-'), coalesce((x->>'sort')::integer, 0)) returning id into v_elem;
   end if;
   insert into asm_tmp_keep values (v_elem); n := n + 1;
  end loop;
  update public.asm_unit_elements set is_active = false where unit_id = v_unit and id not in (select id from asm_tmp_keep);
  perform public.asm_log(v_role, 'unit_elements_save', 'unit', v_unit, jsonb_build_object('count', n));
  return public.asm_admin('unit_elements_list', jsonb_build_object('unitId', v_unit));

 -- ---------------------------------------------------------------- question bank
 elsif p_action = 'bank_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'title', b.title, 'tags', b.tags, 'type', b.question_type, 'unitId', b.unit_id, 'courseId', b.course_id,
    'versionNo', b.current_version_no, 'updatedAt', b.updated_at) order by b.updated_at desc)
   from public.asm_question_bank b where public.tenant_scope(b.tenant_id) and b.archived_at is null
    and (public.asm_json_text(d, 'unitId') is null or b.unit_id = d->>'unitId')
    and (public.asm_json_text(d, 'q') is null or b.title ilike '%' || (d->>'q') || '%' or exists (select 1 from unnest(b.tags) t where t ilike '%' || (d->>'q') || '%'))), '[]');
 elsif p_action = 'bank_get' then
  v_id := public.asm_json_uuid(d, 'id');
  return (select jsonb_build_object('id', b.id, 'title', b.title, 'tags', b.tags, 'type', b.question_type, 'unitId', b.unit_id, 'courseId', b.course_id, 'versionNo', b.current_version_no,
    'definition', v.definition, 'keys', v.keys, 'versions', (select jsonb_agg(jsonb_build_object('no', x.version_no, 'createdAt', x.created_at) order by x.version_no) from public.asm_question_bank_versions x where x.bank_id = b.id))
   from public.asm_question_bank b left join public.asm_question_bank_versions v on v.bank_id = b.id and v.version_no = b.current_version_no where b.id = v_id);
 elsif p_action = 'bank_save' then
  v_defn := d->'definition'; if v_defn is null or jsonb_typeof(v_defn) <> 'object' or nullif(v_defn->>'type', '') is null then raise exception 'A bank question needs a definition with a type' using errcode = '22023'; end if;
  if public.asm_jsonb_forbidden_key(v_defn) is not null then raise exception 'Keep assessor data in keys, not in the definition' using errcode = '22023'; end if;
  v_id := public.asm_json_uuid(d, 'id');
  if v_id is null then
   insert into public.asm_question_bank(course_id, unit_id, title, tags, question_type, created_by)
   values (public.asm_json_text(d, 'courseId'), public.asm_json_text(d, 'unitId'), coalesce(public.asm_json_text(d, 'title'), coalesce(v_defn->>'label', 'Question')),
           case when jsonb_typeof(d->'tags') = 'array' then (select coalesce(array_agg(ta.v), '{}') from jsonb_array_elements_text(d->'tags') as ta(v)) else '{}' end, v_defn->>'type', auth.uid()) returning id into v_id;
  else
   update public.asm_question_bank set title = coalesce(public.asm_json_text(d, 'title'), title), unit_id = coalesce(public.asm_json_text(d, 'unitId'), unit_id), question_type = v_defn->>'type',
     tags = case when jsonb_typeof(d->'tags') = 'array' then (select coalesce(array_agg(ta.v), '{}') from jsonb_array_elements_text(d->'tags') as ta(v)) else tags end where id = v_id;
   if not found then raise exception 'Bank question not found' using errcode = 'P0002'; end if;
  end if;
  update public.asm_question_bank set current_version_no = current_version_no + 1 where id = v_id returning current_version_no into n;
  insert into public.asm_question_bank_versions(bank_id, version_no, definition, keys, created_by) values (v_id, n, v_defn, coalesce(d->'keys', '{}'::jsonb), auth.uid());
  perform public.asm_log(v_role, 'bank_save', 'question_bank', v_id::text, jsonb_build_object('versionNo', n));
  return public.asm_admin('bank_get', jsonb_build_object('id', v_id));
 elsif p_action = 'bank_archive' then
  v_id := public.asm_json_uuid(d, 'id');
  update public.asm_question_bank set archived_at = now() where id = v_id and archived_at is null;
  perform public.asm_log(v_role, 'bank_archive', 'question_bank', v_id::text);
  return jsonb_build_object('ok', true);

 -- ---------------------------------------------------------------- assessments
 elsif p_action = 'assessment_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'courseId', a.course_id, 'courseName', public.course_label(c.code, c.name, c.variant_label), 'unitId', a.unit_id, 'unitCode', u.code, 'unitName', u.name,
     'code', a.code, 'title', a.title, 'description', a.description, 'isTemplate', a.is_template, 'archivedAt', a.archived_at, 'updatedAt', a.updated_at,
     'currentVersionNo', v.version_no, 'currentVersionStatus', v.status, 'hasDraft', exists (select 1 from public.asm_versions x where x.assessment_id = a.id and x.status = 'draft'),
     'assignments', (select count(*) from public.asm_assignments g where g.assessment_id = a.id and g.status <> 'cancelled')) order by a.updated_at desc)
   from public.asm_assessments a join public.cms_courses c on c.id = a.course_id left join public.cms_course_units u on u.id = a.unit_id left join public.asm_versions v on v.id = a.current_version_id
   where public.tenant_scope(a.tenant_id) and (coalesce((d->>'includeArchived')::boolean, false) or a.archived_at is null)
     and (public.asm_json_text(d, 'courseId') is null or a.course_id = d->>'courseId') and (public.asm_json_text(d, 'unitId') is null or a.unit_id = d->>'unitId')
     and (d->'isTemplate' is null or a.is_template = (d->>'isTemplate')::boolean)
     and (public.asm_json_text(d, 'q') is null or a.title ilike '%' || (d->>'q') || '%' or coalesce(a.code, '') ilike '%' || (d->>'q') || '%')), '[]');

 elsif p_action = 'assessment_create' then
  -- from scratch, as a clone (fromAssessmentId: current version's definition, keys and mappings), or from an export (import: {definition, keys, mappings, elements})
  if public.asm_json_text(d, 'courseId') is null then raise exception 'courseId is required' using errcode = '22023'; end if;
  if not exists (select 1 from public.cms_courses where id = d->>'courseId') then raise exception 'Course not found' using errcode = 'P0002'; end if;
  v_unit := public.asm_json_text(d, 'unitId');
  if v_unit is not null and not exists (select 1 from public.cms_course_units where id = v_unit and course_id = d->>'courseId') then raise exception 'The unit does not belong to the course' using errcode = '22023'; end if;
  v_defn := '{"tasks": []}'::jsonb; v_keys := '[]'::jsonb; v_maps := '[]'::jsonb;
  if public.asm_json_uuid(d, 'fromAssessmentId') is not null then
   select * into v_as from public.asm_assessments where id = public.asm_json_uuid(d, 'fromAssessmentId');
   if v_as.id is null then raise exception 'Source assessment not found' using errcode = 'P0002'; end if;
   select * into v_ver from public.asm_versions where id = coalesce(v_as.current_version_id, (select id from public.asm_versions where assessment_id = v_as.id order by version_no desc limit 1));
   if v_ver.id is not null then
    v_defn := v_ver.definition;
    v_keys := coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]');
    v_maps := coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id), '[]');
   end if;
  elsif d ? 'import' then
   v_defn := coalesce(d->'import'->'definition', v_defn); v_keys := coalesce(d->'import'->'keys', v_keys);
  end if;
  v_errs := public.asm_validate_definition(v_defn);
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  insert into public.asm_assessments(course_id, unit_id, code, title, description, is_template, created_by)
  values (d->>'courseId', v_unit, public.asm_json_text(d, 'code'), coalesce(public.asm_json_text(d, 'title'), 'Untitled assessment'), coalesce(d->>'description', ''), coalesce((d->>'isTemplate')::boolean, false), auth.uid())
  returning * into v_as;
  insert into public.asm_versions(assessment_id, version_no, definition, created_by) values (v_as.id, 1, v_defn, auth.uid()) returning * into v_ver;
  for x in select * from jsonb_array_elements(v_keys) loop
   insert into public.asm_question_keys(version_id, question_id, model_answer, answer_key, assessor_guidance, rubric_levels, updated_by)
   values (v_ver.id, x->>'questionId', x->>'modelAnswer', x->'answerKey', x->>'assessorGuidance', x->'rubricLevels', auth.uid()) on conflict do nothing;
  end loop;
  -- mappings by element id (clone within the same unit) or by element kind + code (import; missing elements are created on the unit)
  for x in select * from jsonb_array_elements(coalesce(v_maps, '[]') || coalesce(d->'import'->'mappings', '[]')) loop
   v_elem := public.asm_json_uuid(x, 'elementId');
   if v_elem is null and v_unit is not null and public.asm_json_text(x, 'elementCode') is not null then
    select id into v_elem from public.asm_unit_elements where unit_id = v_unit and kind = coalesce(x->>'elementKind', 'element') and code = x->>'elementCode' limit 1;
    if v_elem is null then
     insert into public.asm_unit_elements(unit_id, kind, code, text) values (v_unit, coalesce(x->>'elementKind', 'element'), x->>'elementCode', coalesce(public.asm_json_text(x, 'elementText'), x->>'elementCode')) returning id into v_elem;
    end if;
   end if;
   if v_elem is not null and exists (select 1 from public.asm_unit_elements e where e.id = v_elem and (v_unit is null or e.unit_id = v_unit)) then
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) values (v_ver.id, x->>'questionId', public.asm_json_text(x, 'criterionId'), v_elem) on conflict do nothing;
   end if;
  end loop;
  perform public.asm_log(v_role, 'assessment_create', 'assessment', v_as.id::text, jsonb_build_object('from', d->>'fromAssessmentId', 'import', d ? 'import'), v_as.tenant_id);
  return public.asm_admin('assessment_get', jsonb_build_object('id', v_as.id));

 elsif p_action = 'assessment_get' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then select * into v_ver from public.asm_versions where id = v_as.current_version_id; end if;
  return jsonb_build_object('id', v_as.id, 'courseId', v_as.course_id, 'unitId', v_as.unit_id, 'code', v_as.code, 'title', v_as.title, 'description', v_as.description,
   'isTemplate', v_as.is_template, 'settingsOverride', v_as.settings_override, 'archivedAt', v_as.archived_at, 'currentVersionId', v_as.current_version_id, 'updatedAt', v_as.updated_at,
   'effectiveSettings', public.asm_effective_settings(v_as.id),
   'editing', case when v_ver.id is null then null else jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'definition', v_ver.definition, 'updatedAt', v_ver.updated_at,
     'keys', coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]'),
     'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id), '[]')) end,
   'versions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'versionNo', v.version_no, 'status', v.status, 'publishedAt', v.published_at, 'checksum', v.checksum, 'createdAt', v.created_at,
     'assignments', (select count(*) from public.asm_assignments g where g.version_id = v.id), 'attempts', (select count(*) from public.asm_attempts t where t.version_id = v.id)) order by v.version_no desc) from public.asm_versions v where v.assessment_id = v_as.id), '[]'),
   'elements', case when v_as.unit_id is null then '[]'::jsonb else public.asm_admin('unit_elements_list', jsonb_build_object('unitId', v_as.unit_id)) end,
   'assignments', coalesce((select jsonb_agg(public.asm_assignment_json(g) order by g.due_at desc) from public.asm_assignments g where g.assessment_id = v_as.id), '[]'));

 elsif p_action = 'assessment_update' then
  v_id := public.asm_json_uuid(d, 'id');
  update public.asm_assessments set title = coalesce(public.asm_json_text(d, 'title'), title), description = coalesce(d->>'description', description),
    code = case when d ? 'code' then public.asm_json_text(d, 'code') else code end, is_template = coalesce((d->>'isTemplate')::boolean, is_template),
    settings_override = case when jsonb_typeof(d->'settingsOverride') = 'object' then d->'settingsOverride' else settings_override end,
    unit_id = case when d ? 'unitId' then public.asm_json_text(d, 'unitId') else unit_id end
  where id = v_id;
  if not found then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  perform public.asm_log(v_role, 'assessment_update', 'assessment', v_id::text, d - 'id');
  return public.asm_admin('assessment_get', jsonb_build_object('id', v_id));
 elsif p_action = 'assessment_archive' then
  v_id := public.asm_json_uuid(d, 'id');
  if exists (select 1 from public.asm_assignments where assessment_id = v_id and status = 'open') then raise exception 'Close or cancel its open assignments first' using errcode = '23503'; end if;
  update public.asm_assessments set archived_at = coalesce(archived_at, now()) where id = v_id;
  perform public.asm_log(v_role, 'assessment_archive', 'assessment', v_id::text);
  return jsonb_build_object('ok', true);
 elsif p_action = 'assessment_export' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where id = coalesce(public.asm_json_uuid(d, 'versionId'), (select id from public.asm_versions where assessment_id = v_as.id and status = 'draft'), v_as.current_version_id);
  if v_ver.id is null then raise exception 'Nothing to export' using errcode = 'P0002'; end if;
  return jsonb_build_object('format', 'skyline-assessment/1', 'exportedAt', now(), 'title', v_as.title, 'code', v_as.code, 'description', v_as.description,
   'unitCode', (select code from public.cms_course_units where id = v_as.unit_id), 'versionNo', v_ver.version_no, 'versionStatus', v_ver.status, 'checksum', v_ver.checksum,
   'definition', v_ver.definition,
   'keys', coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]'),
   'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementKind', e.kind, 'elementCode', e.code, 'elementText', e.text)) from public.asm_unit_mappings m join public.asm_unit_elements e on e.id = m.element_id where m.version_id = v_ver.id), '[]'),
   'settingsOverride', v_as.settings_override);

 -- ---------------------------------------------------------------- draft editing and publishing (D-06)
 elsif p_action = 'draft_save' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  if v_as.archived_at is not null then raise exception 'An archived assessment cannot be edited' using errcode = '42501'; end if;
  v_defn := coalesce(d->'definition', '{"tasks": []}'::jsonb);
  v_errs := public.asm_validate_definition(v_defn);
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then
   -- the next draft starts from the published snapshot (its keys and mappings are copied so nothing is lost)
   select * into v_ver from public.asm_versions where id = v_as.current_version_id;
   insert into public.asm_versions(assessment_id, version_no, definition, created_by)
   values (v_as.id, coalesce((select max(version_no) from public.asm_versions where assessment_id = v_as.id), 0) + 1, coalesce(v_ver.definition, '{"tasks": []}'::jsonb), auth.uid()) returning id into v_next;
   if v_ver.id is not null then
    insert into public.asm_question_keys(version_id, question_id, model_answer, answer_key, assessor_guidance, rubric_levels, updated_by)
    select v_next, question_id, model_answer, answer_key, assessor_guidance, rubric_levels, auth.uid() from public.asm_question_keys where version_id = v_ver.id;
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) select v_next, question_id, criterion_id, element_id from public.asm_unit_mappings where version_id = v_ver.id;
   end if;
   select * into v_ver from public.asm_versions where id = v_next;
  elsif d ? 'expectedUpdatedAt' and public.asm_json_ts(d, 'expectedUpdatedAt') is distinct from v_ver.updated_at then
   raise exception 'This draft was changed by someone else; reload before saving.' using errcode = '40001';
  end if;
  update public.asm_versions set definition = v_defn where id = v_ver.id;
  if jsonb_typeof(d->'keys') = 'array' then
   delete from public.asm_question_keys where version_id = v_ver.id;
   for x in select * from jsonb_array_elements(d->'keys') loop
    if public.asm_json_text(x, 'questionId') is null then continue; end if;
    insert into public.asm_question_keys(version_id, question_id, model_answer, answer_key, assessor_guidance, rubric_levels, updated_by)
    values (v_ver.id, x->>'questionId', x->>'modelAnswer', x->'answerKey', x->>'assessorGuidance', x->'rubricLevels', auth.uid()) on conflict (version_id, question_id) do update
     set model_answer = excluded.model_answer, answer_key = excluded.answer_key, assessor_guidance = excluded.assessor_guidance, rubric_levels = excluded.rubric_levels, updated_by = auth.uid(), updated_at = now();
   end loop;
  end if;
  if jsonb_typeof(d->'mappings') = 'array' then
   delete from public.asm_unit_mappings where version_id = v_ver.id;
   for x in select * from jsonb_array_elements(d->'mappings') loop
    v_elem := public.asm_json_uuid(x, 'elementId');
    if v_elem is null or public.asm_json_text(x, 'questionId') is null then continue; end if;
    if v_as.unit_id is not null and not exists (select 1 from public.asm_unit_elements e where e.id = v_elem and e.unit_id = v_as.unit_id) then raise exception 'Mapping to an element of another unit' using errcode = '23503'; end if;
    insert into public.asm_unit_mappings(version_id, question_id, criterion_id, element_id) values (v_ver.id, x->>'questionId', public.asm_json_text(x, 'criterionId'), v_elem) on conflict do nothing;
   end loop;
  end if;
  update public.asm_assessments set updated_at = now() where id = v_as.id;
  perform public.asm_log(v_role, 'draft_save', 'version', v_ver.id::text, jsonb_build_object('questions', (select count(*) from public.asm_definition_questions(v_defn))), v_as.tenant_id);
  return jsonb_build_object('ok', true, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'updatedAt', (select updated_at from public.asm_versions where id = v_ver.id));

 elsif p_action = 'version_publish' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where assessment_id = v_as.id and status = 'draft';
  if v_ver.id is null then raise exception 'There is no draft to publish' using errcode = 'P0002'; end if;
  v_errs := public.asm_validate_definition(v_ver.definition);
  if jsonb_array_length(coalesce(v_ver.definition->'tasks', '[]')) = 0 then v_errs := v_errs || jsonb_build_object('code', 'no_tasks', 'message', 'Add at least one task before publishing.'); end if;
  if not exists (select 1 from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none') then v_errs := v_errs || jsonb_build_object('code', 'no_questions', 'message', 'Add at least one assessable question.'); end if;
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  update public.asm_versions set status = 'published', checksum = encode(sha256(convert_to(definition::text, 'UTF8')), 'hex'), published_at = now(), published_by = auth.uid() where id = v_ver.id returning * into v_ver;
  update public.asm_assessments set current_version_id = v_ver.id, updated_at = now() where id = v_as.id;
  perform public.asm_log(v_role, 'version_publish', 'version', v_ver.id::text, jsonb_build_object('versionNo', v_ver.version_no, 'checksum', v_ver.checksum), v_as.tenant_id);
  return jsonb_build_object('ok', true, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'checksum', v_ver.checksum);
 elsif p_action = 'version_retire' then
  v_id := public.asm_json_uuid(d, 'versionId');
  update public.asm_versions set status = 'retired', retired_at = now() where id = v_id and status = 'published';
  if not found then raise exception 'Only a published version can be retired' using errcode = 'P0002'; end if;
  update public.asm_assignments set status = 'closed' where version_id = v_id and status = 'open';
  perform public.asm_log(v_role, 'version_retire', 'version', v_id::text);
  return jsonb_build_object('ok', true);
 elsif p_action = 'draft_discard' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  delete from public.asm_versions where assessment_id = v_id and status = 'draft' and version_no > 1;
  perform public.asm_log(v_role, 'draft_discard', 'assessment', v_id::text);
  return jsonb_build_object('ok', true);
 elsif p_action = 'version_get' then
  v_id := public.asm_json_uuid(d, 'versionId');
  select * into v_ver from public.asm_versions where id = v_id; if v_ver.id is null then raise exception 'Version not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v_ver.id, 'assessmentId', v_ver.assessment_id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'definition', v_ver.definition, 'checksum', v_ver.checksum, 'publishedAt', v_ver.published_at,
   'keys', coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]'),
   'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id), '[]'));
 elsif p_action = 'coverage' then
  v_id := public.asm_json_uuid(d, 'versionId');
  select * into v_ver from public.asm_versions where id = v_id; if v_ver.id is null then raise exception 'Version not found' using errcode = 'P0002'; end if;
  select unit_id into v_unit from public.asm_assessments where id = v_ver.assessment_id;
  return jsonb_build_object('versionId', v_ver.id, 'unitId', v_unit,
   'elements', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'code', e.code, 'text', e.text, 'parentId', e.parent_id,
     'mapped', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id)) from public.asm_unit_mappings m where m.version_id = v_ver.id and m.element_id = e.id), '[]')) order by e.kind, e.sort, e.code)
     from public.asm_unit_elements e where e.unit_id = v_unit and e.is_active), '[]'),
   'gaps', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'code', e.code, 'text', e.text) order by e.kind, e.sort, e.code) from public.asm_unit_elements e
     where e.unit_id = v_unit and e.is_active and not exists (select 1 from public.asm_unit_mappings m where m.version_id = v_ver.id and m.element_id = e.id)), '[]'),
   'unmappedQuestions', coalesce((select jsonb_agg(q.question_id) from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none' and not exists (select 1 from public.asm_unit_mappings m where m.version_id = v_ver.id and m.question_id = q.question_id)), '[]'));

 -- ---------------------------------------------------------------- assignments (brief section 7)
 elsif p_action = 'assignment_create' then
  v_id := public.asm_json_uuid(d, 'assessmentId');
  select * into v_as from public.asm_assessments where id = v_id; if v_as.id is null then raise exception 'Assessment not found' using errcode = 'P0002'; end if;
  select * into v_ver from public.asm_versions where id = coalesce(public.asm_json_uuid(d, 'versionId'), v_as.current_version_id) and status = 'published';
  if v_ver.id is null or v_ver.assessment_id <> v_as.id then raise exception 'Publish the assessment before assigning it' using errcode = '23503'; end if;
  v_due := public.asm_json_ts(d, 'dueAt'); if v_due is null then raise exception 'dueAt is required' using errcode = '22023'; end if;
  v_errs := '[]';
  for v_bid in select ta.v::uuid from jsonb_array_elements_text(coalesce(d->'batchIds', d->'intakeIds', '[]')) as ta(v) loop
   if not exists (select 1 from public.course_intakes i where i.id = v_bid and i.course_id = v_as.course_id) then
    raise exception 'Intake % is not on this course', v_bid using errcode = '23503';
   end if;
   insert into public.asm_assignments(assessment_id, version_id, intake_id, available_from, due_at, late_until, reassign_rule, notes, created_by)
   values (v_as.id, v_ver.id, v_bid, coalesce(public.asm_json_ts(d, 'availableFrom'), now()), v_due, public.asm_json_ts(d, 'lateUntil'), coalesce(d->>'reassignRule', 'follow_batch'), coalesce(d->>'notes', ''), auth.uid())
   on conflict (version_id, intake_id) do nothing returning * into v_a;
   if v_a.id is null then v_errs := v_errs || jsonb_build_object('batchId', v_bid, 'code', 'exists', 'message', 'This version is already assigned to the intake.'); continue; end if;
   insert into public.asm_assignment_trainers(assignment_id, staff_id) select v_a.id, ta.v::uuid from jsonb_array_elements_text(coalesce(d->'trainerStaffIds', '[]')) as ta(v) on conflict do nothing;
   insert into public.asm_schedule_events(assignment_id, kind, title, starts_at, ends_at, room_id, trainer_staff_id, notes)
   select v_a.id, coalesce(e->>'kind', 'practical'), coalesce(public.asm_json_text(e, 'title'), v_as.title), public.asm_json_ts(e, 'startsAt'), public.asm_json_ts(e, 'endsAt'), public.asm_json_uuid(e, 'roomId'), public.asm_json_uuid(e, 'trainerStaffId'), coalesce(e->>'notes', '')
   from jsonb_array_elements(coalesce(d->'events', '[]')) e where public.asm_json_ts(e, 'startsAt') is not null;
   insert into public.asm_schedule_events(assignment_id, kind, title, starts_at) values (v_a.id, 'due', v_as.title || ': due', v_due);
   for v_student in select * from public.asm_assignment_eligible(v_a.id) loop
    perform public.asm_notify_student(v_student, 'published', 'New assessment: ' || v_as.title, 'Due ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '. Open My Assessments to start.', null, v_a.id, v_as.tenant_id);
   end loop;
   perform public.asm_notify_trainers(v_a.id, 'published', 'Assessment assigned to your intake: ' || v_as.title, 'Due ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.');
   perform public.asm_log(v_role, 'assignment_create', 'assignment', v_a.id::text, jsonb_build_object('batchId', v_bid, 'versionId', v_ver.id, 'dueAt', v_due), v_as.tenant_id);
   n := n + 1;
  end loop;
  return jsonb_build_object('ok', n > 0 or jsonb_array_length(v_errs) = 0, 'created', n, 'errors', v_errs);

 elsif p_action = 'assignment_update' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_a from public.asm_assignments where id = v_id; if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  update public.asm_assignments set available_from = coalesce(public.asm_json_ts(d, 'availableFrom'), available_from), due_at = coalesce(public.asm_json_ts(d, 'dueAt'), due_at),
    late_until = case when d ? 'lateUntil' then public.asm_json_ts(d, 'lateUntil') else late_until end, status = coalesce(d->>'status', status), reassign_rule = coalesce(d->>'reassignRule', reassign_rule),
    notes = coalesce(d->>'notes', notes) where id = v_id returning * into v_a;
  if jsonb_typeof(d->'trainerStaffIds') = 'array' then
   delete from public.asm_assignment_trainers where assignment_id = v_id;
   insert into public.asm_assignment_trainers(assignment_id, staff_id) select v_id, ta.v::uuid from jsonb_array_elements_text(d->'trainerStaffIds') as ta(v) on conflict do nothing;
  end if;
  if public.asm_json_ts(d, 'dueAt') is not null then
   update public.asm_schedule_events set starts_at = v_a.due_at where assignment_id = v_id and kind = 'due';
   update public.asm_attempts set due_at = v_a.due_at where assignment_id = v_id and state = 'draft' and attempt_no = 1
     and not exists (select 1 from public.asm_assignment_students s where s.assignment_id = v_id and s.student_id = asm_attempts.student_id and s.due_at is not null);
   for v_student in select * from public.asm_assignment_eligible(v_id) loop
    perform public.asm_notify_student(v_student, 'extended', 'Due date changed', 'The due date is now ' || to_char(v_a.due_at at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', null, v_id, v_a.tenant_id);
   end loop;
  end if;
  perform public.asm_log(v_role, 'assignment_update', 'assignment', v_id::text, d - 'id', v_a.tenant_id);
  return public.asm_assignment_json(v_a);
 elsif p_action = 'assignment_cancel' then
  v_id := public.asm_json_uuid(d, 'id');
  update public.asm_assignments set status = 'cancelled' where id = v_id returning * into v_a;
  if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  update public.asm_attempts set state = 'void', voided_at = now(), void_reason = 'assignment cancelled' where assignment_id = v_id and state = 'draft';
  perform public.asm_log(v_role, 'assignment_cancel', 'assignment', v_id::text, jsonb_build_object('reason', d->>'reason'), v_a.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'assignment_list' then
  return coalesce((select jsonb_agg(public.asm_assignment_json(a) order by a.due_at desc) from public.asm_assignments a join public.course_intakes i on i.id = a.intake_id
   where public.tenant_scope(a.tenant_id) and (public.asm_json_uuid(d, 'assessmentId') is null or a.assessment_id = public.asm_json_uuid(d, 'assessmentId'))
     and (public.asm_json_uuid(d, 'batchId') is null or a.intake_id = public.asm_json_uuid(d, 'batchId'))
     and (public.asm_json_uuid(d, 'intakeId') is null or a.intake_id = public.asm_json_uuid(d, 'intakeId'))
     and (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId')
     and (public.asm_json_text(d, 'unitId') is null or exists (select 1 from public.asm_assessments s where s.id = a.assessment_id and s.unit_id = d->>'unitId'))
     and (coalesce((d->>'includeCancelled')::boolean, false) or a.status <> 'cancelled')), '[]');
 elsif p_action = 'assignment_get' then
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_a from public.asm_assignments where id = v_id; if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  return public.asm_assignment_json(v_a) || jsonb_build_object('students', public.asm_admin('assignment_students', jsonb_build_object('id', v_id)));
 elsif p_action = 'assignment_students' then
  v_id := public.asm_json_uuid(d, 'id');
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'email', s.email, 'dueAt', public.asm_due_for(v_id, s.id),
    'excluded', coalesce(x.excluded, false), 'addedManually', coalesce(x.added_manually, false), 'note', coalesce(x.note, ''),
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', t.outcome, 'submittedAt', t.submitted_at, 'dueAt', t.due_at, 'receiptNo', t.receipt_no) order by t.attempt_no)
       from public.asm_attempts t where t.assignment_id = v_id and t.student_id = s.id), '[]')) order by s.full_name)
   from (select public.asm_assignment_eligible(v_id) as id union select student_id from public.asm_assignment_students where assignment_id = v_id) e
   join public.enrollment_students s on s.id = e.id left join public.asm_assignment_students x on x.assignment_id = v_id and x.student_id = s.id), '[]');
 elsif p_action = 'assignment_student_set' then
  v_id := public.asm_json_uuid(d, 'id'); v_student := public.asm_json_uuid(d, 'studentId');
  if v_student is null or not exists (select 1 from public.enrollment_students where id = v_student and status = 'Active') then raise exception 'Student not found' using errcode = 'P0002'; end if;
  select * into v_a from public.asm_assignments where id = v_id; if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  insert into public.asm_assignment_students(assignment_id, student_id, excluded, added_manually, due_at, note, updated_by)
  values (v_id, v_student, coalesce((d->>'excluded')::boolean, false), coalesce((d->>'addedManually')::boolean, false), public.asm_json_ts(d, 'dueAt'), coalesce(d->>'note', ''), auth.uid())
  on conflict (assignment_id, student_id) do update set excluded = coalesce((d->>'excluded')::boolean, asm_assignment_students.excluded),
   added_manually = coalesce((d->>'addedManually')::boolean, asm_assignment_students.added_manually),
   due_at = case when d ? 'dueAt' then public.asm_json_ts(d, 'dueAt') else asm_assignment_students.due_at end, note = coalesce(d->>'note', asm_assignment_students.note), updated_by = auth.uid(), updated_at = now();
  if d ? 'dueAt' then
   update public.asm_attempts set due_at = public.asm_due_for(v_id, v_student) where assignment_id = v_id and student_id = v_student and state = 'draft';
   perform public.asm_notify_student(v_student, 'extended', 'Your due date changed', 'The due date is now ' || to_char(public.asm_due_for(v_id, v_student) at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', null, v_id, v_a.tenant_id);
  end if;
  if coalesce((d->>'excluded')::boolean, false) then
   update public.asm_attempts set state = 'void', voided_at = now(), void_reason = 'excluded from the assignment' where assignment_id = v_id and student_id = v_student and state = 'draft';
  end if;
  perform public.asm_log(v_role, 'assignment_student_set', 'assignment', v_id::text, d - 'id', v_a.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'events_save' then
  v_id := public.asm_json_uuid(d, 'assignmentId');
  select * into v_a from public.asm_assignments where id = v_id; if v_a.id is null then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
  delete from public.asm_schedule_events where assignment_id = v_id and kind <> 'due';
  insert into public.asm_schedule_events(assignment_id, kind, title, starts_at, ends_at, room_id, trainer_staff_id, notes)
  select v_id, coalesce(e->>'kind', 'practical'), coalesce(public.asm_json_text(e, 'title'), 'Assessment session'), public.asm_json_ts(e, 'startsAt'), public.asm_json_ts(e, 'endsAt'), public.asm_json_uuid(e, 'roomId'), public.asm_json_uuid(e, 'trainerStaffId'), coalesce(e->>'notes', '')
  from jsonb_array_elements(coalesce(d->'events', '[]')) e where public.asm_json_ts(e, 'startsAt') is not null and coalesce(e->>'kind', 'practical') <> 'due';
  perform public.asm_log(v_role, 'events_save', 'assignment', v_id::text, jsonb_build_object('count', jsonb_array_length(coalesce(d->'events', '[]'))), v_a.tenant_id);
  return public.asm_assignment_json(v_a);

 -- ---------------------------------------------------------------- monitoring, overrides, outcomes
 elsif p_action = 'overview' then
  create temp table if not exists asm_tmp_scope(id uuid) on commit drop; delete from asm_tmp_scope;
  insert into asm_tmp_scope select a.id from public.asm_assignments a join public.course_intakes i on i.id = a.intake_id
   where public.tenant_scope(a.tenant_id) and a.status <> 'cancelled' and (public.asm_json_uuid(d, 'batchId') is null or a.intake_id = public.asm_json_uuid(d, 'batchId'))
     and (public.asm_json_uuid(d, 'assessmentId') is null or a.assessment_id = public.asm_json_uuid(d, 'assessmentId'))
     and (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId');
  return jsonb_build_object(
   'assignments', (select count(*) from asm_tmp_scope),
   'eligible', (select count(*) from asm_tmp_scope f cross join lateral public.asm_assignment_eligible(f.id) e),
   'notStarted', (select count(*) from asm_tmp_scope f cross join lateral public.asm_assignment_eligible(f.id) e where not exists (select 1 from public.asm_attempts t where t.assignment_id = f.id and t.student_id = e)),
   'draft', (select count(*) from public.asm_attempts t where t.assignment_id in (select id from asm_tmp_scope) and t.state = 'draft'),
   'submitted', (select count(*) from public.asm_attempts t where t.assignment_id in (select id from asm_tmp_scope) and t.state in ('submitted', 'marking')),
   'returned', (select count(*) from public.asm_attempts t where t.assignment_id in (select id from asm_tmp_scope) and t.state = 'returned'),
   'final', (select count(*) from public.asm_attempts t where t.assignment_id in (select id from asm_tmp_scope) and t.state = 'final'),
   'overdue', (select count(*) from asm_tmp_scope f cross join lateral public.asm_assignment_eligible(f.id) e where public.asm_due_for(f.id, e) < now()
      and not exists (select 1 from public.asm_attempts t where t.assignment_id = f.id and t.student_id = e and t.state <> 'draft')),
   'reassessmentsOpen', (select count(*) from public.asm_reassessments r join public.asm_attempts t on t.id = r.attempt_id where t.assignment_id in (select id from asm_tmp_scope) and r.state = 'requested'),
   'pendingMarking', coalesce((select jsonb_agg(jsonb_build_object('attemptId', t.id, 'assignmentId', t.assignment_id, 'studentId', t.student_id, 'studentName', s.full_name, 'attemptNo', t.attempt_no,
      'state', t.state, 'submittedAt', t.submitted_at, 'assessmentTitle', x.title, 'batchName', public.intake_group_name(g.intake_id)) order by t.submitted_at)
     from public.asm_attempts t join public.asm_assignments g on g.id = t.assignment_id join public.asm_assessments x on x.id = g.assessment_id
     join public.enrollment_students s on s.id = t.student_id where t.assignment_id in (select id from asm_tmp_scope) and t.state in ('submitted', 'marking')), '[]'));
 elsif p_action = 'attempt_get' then
  v_id := public.asm_json_uuid(d, 'id');
  return public.asm_attempt_json(v_id, 'admin');
 elsif p_action = 'attempt_void' then
  v_id := public.asm_json_uuid(d, 'id');
  update public.asm_attempts set state = 'void', voided_at = now(), void_reason = coalesce(public.asm_json_text(d, 'reason'), 'voided by administrator') where id = v_id and state <> 'void' returning * into v_att;
  if v_att.id is null then raise exception 'Attempt not found or already void' using errcode = 'P0002'; end if;
  perform public.asm_log(v_role, 'attempt_void', 'attempt', v_id::text, jsonb_build_object('reason', v_att.void_reason), v_att.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'attempt_reopen' then
  -- an authorised override: a further attempt for the student, carrying the previous responses, with a new due date
  v_id := public.asm_json_uuid(d, 'id');
  select * into v_att from public.asm_attempts where id = v_id; if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state not in ('returned', 'final', 'submitted', 'marking') then raise exception 'Only a submitted attempt can be reopened' using errcode = '42501'; end if;
  if exists (select 1 from public.asm_attempts where assignment_id = v_att.assignment_id and student_id = v_att.student_id and state = 'draft') then raise exception 'The student already has an open attempt' using errcode = '23505'; end if;
  v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + interval '7 days');
  v_next := public.asm_next_attempt(v_att.assignment_id, v_att.student_id, v_due, v_att.id, coalesce((d->>'overrideLimit')::boolean, false));
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
  values (v_att.id, v_att.student_id, 'admin', coalesce(d->>'reason', 'reopened by administrator'), 'opened', v_due, v_next, auth.uid(), now());
  perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Your assessment has been reopened', 'A further attempt is open until ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', v_next, v_att.assignment_id, v_att.tenant_id);
  perform public.asm_log(v_role, 'attempt_reopen', 'attempt', v_id::text, jsonb_build_object('nextAttemptId', v_next, 'dueAt', v_due, 'reason', d->>'reason'), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'attemptId', v_next);
 elsif p_action = 'reassessment_decide' then
  v_id := public.asm_json_uuid(d, 'id');
  select t.* into v_att from public.asm_reassessments r join public.asm_attempts t on t.id = r.attempt_id where r.id = v_id and r.state = 'requested';
  if v_att.id is null then raise exception 'Request not found or already decided' using errcode = 'P0002'; end if;
  if coalesce((d->>'approve')::boolean, false) then
   if exists (select 1 from public.asm_attempts where assignment_id = v_att.assignment_id and student_id = v_att.student_id and state = 'draft') then raise exception 'The student already has an open attempt' using errcode = '23505'; end if;
   v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((public.asm_effective_settings((select assessment_id from public.asm_assignments where id = v_att.assignment_id))->>'reassessment_days')::integer, 5)));
   v_next := public.asm_next_attempt(v_att.assignment_id, v_att.student_id, v_due, v_att.id, coalesce((d->>'overrideLimit')::boolean, false));
   update public.asm_reassessments set state = 'opened', new_due_at = v_due, next_attempt_id = v_next, decided_by = auth.uid(), decided_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Reassessment approved', 'A further attempt is open until ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', v_next, v_att.assignment_id, v_att.tenant_id);
  else
   update public.asm_reassessments set state = 'declined', decided_by = auth.uid(), decided_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Reassessment request declined', coalesce(d->>'reason', ''), v_att.id, v_att.assignment_id, v_att.tenant_id);
  end if;
  perform public.asm_log(v_role, 'reassessment_decide', 'reassessment', v_id::text, d - 'id', v_att.tenant_id);
  return jsonb_build_object('ok', true, 'attemptId', v_next);
 elsif p_action = 'unit_outcome_record' then
  return public.asm_record_unit_outcome(d, 'admin');
 elsif p_action = 'outcomes_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'studentId', o.student_id, 'studentName', s.full_name, 'unitId', o.unit_id, 'unitCode', u.code, 'unitName', u.name, 'assessmentId', o.assessment_id,
    'batchId', o.intake_id, 'outcome', o.outcome, 'signedName', o.signed_name, 'signedRole', o.signed_role, 'signedAt', o.signed_at, 'notes', o.notes, 'supersedesId', o.supersedes_id,
    'current', not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id)) order by o.signed_at desc)
   from public.asm_unit_outcomes o join public.enrollment_students s on s.id = o.student_id join public.cms_course_units u on u.id = o.unit_id
   where public.tenant_scope(o.tenant_id) and (public.asm_json_uuid(d, 'studentId') is null or o.student_id = public.asm_json_uuid(d, 'studentId')) and (public.asm_json_text(d, 'unitId') is null or o.unit_id = d->>'unitId')
     and (public.asm_json_uuid(d, 'batchId') is null or o.intake_id = public.asm_json_uuid(d, 'batchId'))), '[]');
 elsif p_action = 'student_progress' then
  return public.asm_student_progress(public.asm_json_uuid(d, 'studentId'));
 elsif p_action = 'staff_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name), 'email', s.email,
    'isTrainer', exists (select 1 from hr.staff_roles r where r.profile_id = s.id and r.role = 'trainer' and r.revoked_at is null)) order by s.first_name, s.last_name)
   from hr.staff_profiles s where s.status = 'active'), '[]');
 elsif p_action = 'batch_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', public.intake_group_name(i.id), 'intakeId', i.id, 'intake', public.course_intake_display(i), 'courseId', i.course_id, 'courseName', public.course_label(c.code, c.name, c.variant_label),
    'students', (select count(*) from public.batch_enrolments e where e.intake_id = i.id and e.status = 'active'), 'isActive', public.intake_has_group(i.id)) order by i.start_date desc, public.intake_group_name(i.id))
   from public.course_intakes i join public.cms_courses c on c.id = i.course_id
   where public.tenant_scope(c.tenant_id) and (public.asm_json_text(d, 'courseId') is null or i.course_id = d->>'courseId') and (coalesce((d->>'includeInactive')::boolean, false) or public.intake_has_group(i.id))), '[]');
 elsif p_action = 'audit_list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'actor', l.actor, 'role', l.actor_role, 'action', l.action, 'targetType', l.target_type, 'targetId', l.target_id, 'detail', l.detail, 'at', l.created_at) order by l.id desc)
   from (select * from public.asm_audit_log l where public.tenant_scope(l.tenant_id) and (public.asm_json_text(d, 'targetType') is null or l.target_type = d->>'targetType') and (public.asm_json_text(d, 'targetId') is null or l.target_id = d->>'targetId')
         order by l.id desc limit least(coalesce((d->>'limit')::integer, 100), 500)) l), '[]');
 elsif p_action = 'report' then
  return public.asm_report(d);
 elsif p_action = 'notifications' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'title', x.title, 'body', x.body, 'attemptId', x.attempt_id, 'assignmentId', x.assignment_id, 'readAt', x.read_at, 'createdAt', x.created_at) order by x.created_at desc)
   from (select * from public.asm_notifications where recipient_auth_user = auth.uid() order by created_at desc limit 50) x), '[]');
 elsif p_action = 'notification_read' then
  update public.asm_notifications set read_at = coalesce(read_at, now()) where recipient_auth_user = auth.uid() and (public.asm_json_uuid(d, 'id') is null or id = public.asm_json_uuid(d, 'id'));
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown action %', p_action using errcode = '22023';
end $function$;

-- ==== g6_asm
-- asm_trainer_of_student(uuid)
CREATE OR REPLACE FUNCTION public.asm_trainer_of_student(p_student uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select public.asm_trainer_profile() is not null and exists (
  select 1 from public.batch_enrolments e join public.intake_trainers bt on bt.intake_id = e.intake_id
  where e.student_id = p_student and bt.staff_id = public.asm_trainer_profile());
$function$;
;

-- asm_trainer_on_assignment(uuid,uuid)
CREATE OR REPLACE FUNCTION public.asm_trainer_on_assignment(p_assignment uuid, p_profile uuid DEFAULT asm_trainer_profile())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select p_profile is not null
  and (auth.uid() is null or p_profile = public.asm_trainer_profile() or public.asm_is_admin())
  and exists (
   select 1 from public.asm_assignments a
   left join public.intake_trainers bt on bt.intake_id = a.intake_id and bt.staff_id = p_profile
   left join public.asm_assignment_trainers at on at.assignment_id = a.id and at.staff_id = p_profile
   where a.id = p_assignment and (bt.staff_id is not null or at.staff_id is not null)
     and (auth.uid() is null or public.tenant_scope(a.tenant_id)));
$function$;
;

-- asm_assignment_eligible(uuid)
CREATE OR REPLACE FUNCTION public.asm_assignment_eligible(p_assignment uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select e.student_id from public.asm_assignments a join public.batch_enrolments e on e.intake_id = a.intake_id and e.status = 'active'
 where a.id = p_assignment and a.status <> 'cancelled'
   and not exists (select 1 from public.asm_assignment_students s where s.assignment_id = a.id and s.student_id = e.student_id and s.excluded)
 union
 select s.student_id from public.asm_assignments a join public.asm_assignment_students s on s.assignment_id = a.id and s.added_manually and not s.excluded
 where a.id = p_assignment and a.status <> 'cancelled';
$function$;
;

-- asm_assignment_json(asm_assignments)
CREATE OR REPLACE FUNCTION public.asm_assignment_json(a asm_assignments)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select jsonb_build_object('id', a.id, 'assessmentId', a.assessment_id, 'versionId', a.version_id, 'batchId', a.intake_id, 'batchName', public.intake_group_name(i.id),
  'intakeId', i.id, 'intake', public.course_intake_display(i), 'courseId', i.course_id, 'courseName', public.course_label(c.code, c.name, c.variant_label),
  'assessmentTitle', s.title, 'assessmentCode', s.code, 'unitId', s.unit_id, 'unitCode', u.code, 'unitName', u.name, 'versionNo', v.version_no,
  'availableFrom', a.available_from, 'dueAt', a.due_at, 'lateUntil', a.late_until, 'status', a.status, 'reassignRule', a.reassign_rule, 'notes', a.notes,
  'trainers', coalesce((select jsonb_agg(jsonb_build_object('staffId', p.id, 'name', btrim(p.first_name || ' ' || p.last_name), 'source', x.source) order by p.first_name)
    from (select bt.staff_id, 'batch' as source from public.intake_trainers bt where bt.intake_id = a.intake_id
          union select at.staff_id, 'assignment' from public.asm_assignment_trainers at where at.assignment_id = a.id) x join hr.staff_profiles p on p.id = x.staff_id), '[]'),
  'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'startsAt', e.starts_at, 'endsAt', e.ends_at, 'roomId', e.room_id, 'trainerStaffId', e.trainer_staff_id, 'notes', e.notes) order by e.starts_at)
    from public.asm_schedule_events e where e.assignment_id = a.id), '[]'),
  'eligibleCount', (select count(*) from public.asm_assignment_eligible(a.id)))
 from public.course_intakes i join public.cms_courses c on c.id = i.course_id
 join public.asm_assessments s on s.id = a.assessment_id left join public.cms_course_units u on u.id = s.unit_id join public.asm_versions v on v.id = a.version_id
 where i.id = a.intake_id;
$function$;
;

-- asm_notify_trainers(uuid,text,text,text,uuid)
CREATE OR REPLACE FUNCTION public.asm_notify_trainers(p_assignment uuid, p_event text, p_title text, p_body text, p_attempt uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare x record; n integer := 0; a public.asm_assignments;
begin
 select * into a from public.asm_assignments where id = p_assignment;
 for x in select distinct s.staff_id from (select bt.staff_id from public.intake_trainers bt where bt.intake_id = a.intake_id
                                            union select at.staff_id from public.asm_assignment_trainers at where at.assignment_id = a.id) s loop
  perform public.asm_notify(c.auth_user, 'trainer', p_event, p_title, p_body, c.email, p_attempt, p_assignment, a.tenant_id) from public.asm_trainer_contact(x.staff_id) c;
  n := n + 1;
 end loop;
 return n;
end $function$;
;

-- asm_batch_enrolment_change()
CREATE OR REPLACE FUNCTION public.asm_batch_enrolment_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a record; v_student uuid := coalesce(new.student_id, old.student_id);
begin
 if tg_op in ('UPDATE', 'DELETE') and (tg_op = 'DELETE' or old.status = 'active' and (new.status <> 'active' or new.intake_id <> old.intake_id)) then
  for a in select x.* , s.title from public.asm_assignments x join public.asm_assessments s on s.id = x.assessment_id where x.intake_id = old.intake_id and x.status = 'open' and x.reassign_rule = 'follow_batch' loop
   update public.asm_attempts set state = 'void', voided_at = now(), void_reason = 'left the intake' where assignment_id = a.id and student_id = v_student and state = 'draft';
   perform public.asm_log('system', 'reassign_leave', 'assignment', a.id::text, jsonb_build_object('studentId', v_student, 'batchId', old.intake_id), a.tenant_id);
  end loop;
 end if;
 if tg_op in ('INSERT', 'UPDATE') and new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active' or new.intake_id <> old.intake_id) then
  for a in select x.*, s.title from public.asm_assignments x join public.asm_assessments s on s.id = x.assessment_id where x.intake_id = new.intake_id and x.status = 'open' loop
   perform public.asm_notify_student(v_student, 'reassigned', 'Assessment available: ' || a.title, 'You joined ' || public.intake_group_name(new.intake_id) || '. ' || a.title || ' is due ' || to_char(public.asm_due_for(a.id, v_student) at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', null, a.id, a.tenant_id);
   perform public.asm_log('system', 'reassign_join', 'assignment', a.id::text, jsonb_build_object('studentId', v_student, 'batchId', new.intake_id), a.tenant_id);
  end loop;
 end if;
 return coalesce(new, old);
end $function$;
;

-- asm_record_unit_outcome(jsonb,text)
CREATE OR REPLACE FUNCTION public.asm_record_unit_outcome(d jsonb, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_student uuid := public.asm_json_uuid(d, 'studentId'); v_unit text := public.asm_json_text(d, 'unitId'); v_out text := upper(coalesce(d->>'outcome', ''));
 v_prev uuid; v_id uuid; v_staff uuid := public.asm_trainer_profile(); v_name text; v_ids uuid[]; v_batch uuid := coalesce(public.asm_json_uuid(d, 'batchId'), public.asm_json_uuid(d, 'intakeId'));
 v_assessment uuid := public.asm_json_uuid(d, 'assessmentId'); v_tenant uuid; v_allowed boolean := false;
begin
 if v_student is null or v_unit is null then raise exception 'studentId and unitId are required' using errcode = '22023'; end if;
 if v_out not in ('C', 'NYC') then raise exception 'outcome must be C or NYC' using errcode = '22023'; end if;
 select tenant_id into v_tenant from public.cms_course_units where id = v_unit;
 if not found or not public.tenant_scope(v_tenant) then raise exception 'Unit not found' using errcode = 'P0002'; end if;
 if not exists (select 1 from public.enrollment_students s where s.id = v_student) then raise exception 'Student not found' using errcode = 'P0002'; end if;
 if v_batch is not null and not exists (select 1 from public.batch_enrolments e where e.intake_id = v_batch and e.student_id = v_student) then
  raise exception 'The student is not enrolled in that intake' using errcode = '22023'; end if;
 if v_assessment is not null and not exists (select 1 from public.asm_assessments a where a.id = v_assessment and a.unit_id = v_unit and public.tenant_scope(a.tenant_id)) then
  raise exception 'The assessment does not belong to this unit' using errcode = '22023'; end if;
 if p_role = 'trainer' then
  if v_staff is null then raise exception 'Only an active trainer can sign off' using errcode = '42501'; end if;
  -- (a) an intake of the unit's course the student is in, where the caller is an intake trainer with the role (or the role is not required)
  v_allowed := exists (
   select 1 from public.batch_enrolments e join public.course_intakes i on i.id = e.intake_id
   join public.cms_course_units u on u.id = v_unit and u.course_id = i.course_id
   join public.intake_trainers bt on bt.intake_id = i.id and bt.staff_id = v_staff
   where e.student_id = v_student and e.status in ('active', 'completed') and (v_batch is null or i.id = v_batch)
     and (public.asm_has_trainer_role(v_staff) or not coalesce((select s.require_trainer_role from public.asm_settings s
           where coalesce(s.tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(v_tenant, '00000000-0000-0000-0000-000000000000')), true)));
  -- (b) a named assessor on an assignment of this unit the student attempted
  if not v_allowed then
   v_allowed := exists (
    select 1 from public.asm_assignments a join public.asm_assessments x on x.id = a.assessment_id and x.unit_id = v_unit
    join public.asm_assignment_trainers at on at.assignment_id = a.id and at.staff_id = v_staff
    join public.asm_attempts t on t.assignment_id = a.id and t.student_id = v_student
    where public.tenant_scope(a.tenant_id));
  end if;
  if not v_allowed then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can sign off this student' using errcode = '42501'; end if;
  select btrim(first_name || ' ' || last_name) into v_name from hr.staff_profiles where id = v_staff;
 else
  if not public.asm_is_admin() then raise exception 'Not authorised' using errcode = '42501'; end if;
  select name into v_name from public.cms_users where auth_user_id = auth.uid();
 end if;
 if not coalesce((d->>'signOff')::boolean, false) then raise exception 'Tick the sign-off declaration to record the outcome' using errcode = '22023'; end if;
 select coalesce(array_agg(ta.v::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(d->'attemptIds', '[]')) as ta(v);
 if exists (select 1 from unnest(v_ids) i where not exists (select 1 from public.asm_attempts t where t.id = i and t.student_id = v_student)) then raise exception 'An attempt does not belong to the student' using errcode = '23503'; end if;
 select id into v_prev from public.asm_unit_outcomes o where o.student_id = v_student and o.unit_id = v_unit and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by signed_at desc limit 1;
 insert into public.asm_unit_outcomes(student_id, unit_id, assessment_id, intake_id, outcome, evidence_attempt_ids, signed_by, signed_staff_id, signed_role, signed_name, notes, supersedes_id)
 values (v_student, v_unit, v_assessment, v_batch, v_out, v_ids, auth.uid(), v_staff, p_role, coalesce(nullif(v_name, ''), 'Assessor'), coalesce(d->>'notes', ''), v_prev) returning id into v_id;
 perform public.asm_notify_student(v_student, 'outcome', 'Unit outcome recorded', 'The outcome for ' || (select code || ' ' || name from public.cms_course_units where id = v_unit) || ' is ' || case v_out when 'C' then 'Competent' else 'Not Yet Competent' end || '.', null, null, v_tenant);
 perform public.asm_log(p_role, 'unit_outcome_record', 'unit_outcome', v_id::text, jsonb_build_object('studentId', v_student, 'unitId', v_unit, 'outcome', v_out, 'supersedes', v_prev), v_tenant);
 return jsonb_build_object('ok', true, 'id', v_id);
end $function$;
;

-- asm_student_progress(uuid)
CREATE OR REPLACE FUNCTION public.asm_student_progress(p_student uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
 select jsonb_build_object('studentId', p_student,
  'units', coalesce((select jsonb_agg(jsonb_build_object('unitId', u.id, 'unitCode', u.code, 'unitName', u.name, 'courseId', u.course_id,
    'outcome', (select o.outcome from public.asm_unit_outcomes o where o.student_id = p_student and o.unit_id = u.id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by o.signed_at desc limit 1),
    'outcomeAt', (select o.signed_at from public.asm_unit_outcomes o where o.student_id = p_student and o.unit_id = u.id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by o.signed_at desc limit 1),
    'assessments', coalesce((select jsonb_agg(jsonb_build_object('assessmentId', s.id, 'title', s.title, 'assignmentId', a.id, 'dueAt', public.asm_due_for(a.id, p_student),
       'latest', (select jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', t.outcome, 'submittedAt', t.submitted_at) from public.asm_attempts t
                  where t.assignment_id = a.id and t.student_id = p_student and t.state <> 'void' order by t.attempt_no desc limit 1)) order by a.due_at)
      from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id where s.unit_id = u.id and a.status <> 'cancelled' and p_student in (select public.asm_assignment_eligible(a.id))), '[]')) order by u.course_id, u.sort)
   from (select distinct u.* from public.cms_course_units u join public.course_intakes i on i.course_id = u.course_id
         join public.batch_enrolments e on e.intake_id = i.id and e.student_id = p_student and e.status in ('active', 'completed') where u.is_active) u), '[]'));
$function$;
;

-- asm_report(jsonb)
CREATE OR REPLACE FUNCTION public.asm_report(d jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare kind text := coalesce(d->>'kind', 'cohort'); v_batch uuid := coalesce(public.asm_json_uuid(d, 'batchId'), public.asm_json_uuid(d, 'intakeId')); v_as uuid := public.asm_json_uuid(d, 'assessmentId');
begin
 if kind = 'cohort' then
  if v_batch is null then raise exception 'batchId is required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'student', s.full_name, 'email', s.email, 'assessmentId', x.id, 'assessment', x.title, 'unitCode', u.code,
    'dueAt', public.asm_due_for(a.id, s.id), 'attempts', (select count(*) from public.asm_attempts t where t.assignment_id = a.id and t.student_id = s.id and t.state <> 'void'),
    'state', (select t.state from public.asm_attempts t where t.assignment_id = a.id and t.student_id = s.id and t.state <> 'void' order by t.attempt_no desc limit 1),
    'outcome', (select t.outcome from public.asm_attempts t where t.assignment_id = a.id and t.student_id = s.id and t.state <> 'void' order by t.attempt_no desc limit 1),
    'submittedAt', (select t.submitted_at from public.asm_attempts t where t.assignment_id = a.id and t.student_id = s.id and t.state <> 'void' order by t.attempt_no desc limit 1),
    'unitOutcome', (select o.outcome from public.asm_unit_outcomes o where o.student_id = s.id and o.unit_id = x.unit_id and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = o.id) order by o.signed_at desc limit 1)) order by s.full_name, x.title)
   from public.asm_assignments a join public.asm_assessments x on x.id = a.assessment_id left join public.cms_course_units u on u.id = x.unit_id
   cross join lateral public.asm_assignment_eligible(a.id) e join public.enrollment_students s on s.id = e
   where a.intake_id = v_batch and a.status <> 'cancelled' and (v_as is null or a.assessment_id = v_as)), '[]');
 elsif kind = 'assessment' then
  if v_as is null then raise exception 'assessmentId is required' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('assignmentId', a.id, 'batch', public.intake_group_name(i.id), 'intake', public.course_intake_display(i), 'versionNo', v.version_no, 'dueAt', a.due_at, 'status', a.status,
    'eligible', (select count(*) from public.asm_assignment_eligible(a.id)),
    'submitted', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state in ('submitted', 'marking', 'returned', 'final')),
    'satisfactory', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state = 'final' and t.outcome = 'S'),
    'notYetSatisfactory', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state = 'final' and t.outcome = 'NYS'),
    'reassessments', (select count(*) from public.asm_reassessments r join public.asm_attempts t on t.id = r.attempt_id where t.assignment_id = a.id and r.state = 'opened')) order by a.due_at desc)
   from public.asm_assignments a join public.course_intakes i on i.id = a.intake_id join public.asm_versions v on v.id = a.version_id where a.assessment_id = v_as), '[]');
 elsif kind = 'student' then
  return public.asm_student_progress(public.asm_json_uuid(d, 'studentId'));
 end if;
 raise exception 'Unknown report %', kind using errcode = '22023';
end $function$;
;

-- asm_calendar(date,date,uuid)
CREATE OR REPLACE FUNCTION public.asm_calendar(p_from date, p_to date, p_batch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_student uuid := public.asm_student_id(); v_staff uuid := public.asm_trainer_profile(); v_admin boolean := public.asm_is_admin(); v_batches uuid[]; v_assignments uuid[];
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 370 then raise exception 'Choose a range of up to a year' using errcode = '22023'; end if;
 if v_admin and p_batch is not null then
  v_batches := array[p_batch];
  select coalesce(array_agg(id), '{}') into v_assignments from public.asm_assignments where intake_id = p_batch and status <> 'cancelled' and public.tenant_scope(tenant_id);
 elsif v_admin then
  v_batches := '{}';
  select coalesce(array_agg(id), '{}') into v_assignments from public.asm_assignments where status <> 'cancelled' and public.tenant_scope(tenant_id);
 elsif v_staff is not null and (v_student is null or coalesce(p_batch::text, '') <> 'student') then
  select coalesce(array_agg(intake_id), '{}') into v_batches from public.intake_trainers where staff_id = v_staff;
  select coalesce(array_agg(id), '{}') into v_assignments from public.asm_assignments a where status <> 'cancelled' and public.asm_trainer_on_assignment(a.id, v_staff);
 elsif v_student is not null then
  select coalesce(array_agg(intake_id), '{}') into v_batches from public.batch_enrolments where student_id = v_student and status = 'active';
  select coalesce(array_agg(a.id), '{}') into v_assignments from public.asm_assignments a where a.status <> 'cancelled' and a.intake_id = any(v_batches) and v_student in (select public.asm_assignment_eligible(a.id));
 else
  return '[]'::jsonb;
 end if;
 return coalesce((select jsonb_agg(e order by e->>'startsAt') from (
  -- assessment events (the student's own due date where overridden)
  select jsonb_build_object('kind', case when e.kind = 'due' then 'assessment_due' else 'assessment_' || e.kind end, 'title', e.title, 'assignmentId', e.assignment_id, 'assessmentTitle', s.title, 'batchName', public.intake_group_name(b.id),
    'startsAt', case when e.kind = 'due' and v_student is not null and not v_admin and v_staff is null then public.asm_due_for(e.assignment_id, v_student) else e.starts_at end, 'endsAt', e.ends_at,
    'room', r.name, 'trainer', case when p.id is null then null else btrim(p.first_name || ' ' || p.last_name) end, 'notes', e.notes) as e
  from public.asm_schedule_events e join public.asm_assignments a on a.id = e.assignment_id join public.asm_assessments s on s.id = a.assessment_id join public.course_intakes b on b.id = a.intake_id
  left join public.classrooms r on r.id = e.room_id left join hr.staff_profiles p on p.id = e.trainer_staff_id
  where e.assignment_id = any(v_assignments) and (e.starts_at at time zone 'Australia/Melbourne')::date between p_from and p_to
  union all
  -- weekly classes of the intakes in scope, on the days the intake runs
  select jsonb_build_object('kind', 'class', 'title', public.intake_group_name(b.id) || ' · ' || initcap(bs.session_type), 'batchId', b.id, 'batchName', public.intake_group_name(b.id), 'sessionType', bs.session_type,
    'startsAt', (day.d + bs.start_time) at time zone 'Australia/Melbourne', 'endsAt', (day.d + bs.end_time) at time zone 'Australia/Melbourne', 'room', r.name)
  from public.course_intakes b join public.intake_class_times bs on bs.intake_id = b.id left join public.classrooms r on r.id = bs.room_id
  cross join lateral (select d::date from generate_series(greatest(p_from, lower(public.rto_batch_span(b.id))), least(p_to, upper(public.rto_batch_span(b.id)) - 1), interval '1 day') d) day
  where b.id = any(v_batches) and public.intake_has_group(b.id) and extract(isodow from day.d) = bs.weekday and public.rto_is_working_day(day.d)
 ) x), '[]'::jsonb);
end $function$;
;

-- asm_student(text,jsonb)
CREATE OR REPLACE FUNCTION public.asm_student(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_student uuid := public.asm_student_id(); v_id uuid; v_att public.asm_attempts; v_a public.asm_assignments; v_as public.asm_assessments; v_ver public.asm_versions;
 v_set jsonb; v_errs jsonb; v_resp jsonb; v_hash text; v_receipt text; v_decl jsonb; v_path text; v_due timestamptz; v_now timestamptz := now(); v_sig text;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_action = 'me' then return jsonb_build_object('studentId', v_student); end if;
 if v_student is null then raise exception 'Only a signed-in student can do this' using errcode = '42501'; end if;

 if p_action = 'my_assessments' then
  return coalesce((select jsonb_agg(jsonb_build_object('assignmentId', a.id, 'assessmentId', s.id, 'title', s.title, 'code', s.code, 'description', s.description, 'unitCode', u.code, 'unitName', u.name,
    'courseName', public.course_label(c.code, c.name, c.variant_label), 'batchName', public.intake_group_name(i.id), 'availableFrom', a.available_from, 'dueAt', public.asm_due_for(a.id, v_student), 'lateUntil', a.late_until, 'status', a.status,
    'maxAttempts', (public.asm_effective_settings(s.id)->>'max_attempts')::integer,
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', case when t.state in ('returned', 'final') then t.outcome end, 'submittedAt', t.submitted_at, 'dueAt', t.due_at, 'receiptNo', t.receipt_no, 'acknowledgedAt', t.acknowledged_at) order by t.attempt_no)
       from public.asm_attempts t where t.assignment_id = a.id and t.student_id = v_student and t.state <> 'void'), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'title', e.title, 'startsAt', e.starts_at, 'endsAt', e.ends_at, 'room', r.name) order by e.starts_at) from public.asm_schedule_events e left join public.classrooms r on r.id = e.room_id where e.assignment_id = a.id and e.kind <> 'due'), '[]')) order by a.due_at)
   from public.asm_assignments a join public.asm_assessments s on s.id = a.assessment_id left join public.cms_course_units u on u.id = s.unit_id 
   join public.course_intakes i on i.id = a.intake_id join public.cms_courses c on c.id = i.course_id
   where a.status <> 'cancelled' and public.tenant_scope(a.tenant_id) and v_student in (select public.asm_assignment_eligible(a.id))), '[]');
 elsif p_action = 'assessment_open' then
  -- the student's current attempt (attempt 1 is created on first open); the view never contains assessor keys (D-05)
  v_id := public.asm_json_uuid(d, 'assignmentId');
  select * into v_a from public.asm_assignments where id = v_id;
  if v_a.id is null or v_a.status = 'cancelled' or not public.tenant_scope(v_a.tenant_id) or v_student not in (select public.asm_assignment_eligible(v_id)) then raise exception 'This assessment is not assigned to you' using errcode = '42501'; end if;
  if v_now < v_a.available_from then raise exception 'This assessment opens on %', to_char(v_a.available_from at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') using errcode = '42501'; end if;
  select * into v_as from public.asm_assessments where id = v_a.assessment_id; select * into v_ver from public.asm_versions where id = v_a.version_id;
  select * into v_att from public.asm_attempts where assignment_id = v_id and student_id = v_student and state <> 'void' order by attempt_no desc limit 1;
  if v_att.id is null then
   if v_a.status <> 'open' then raise exception 'This assessment is closed' using errcode = '42501'; end if;
   v_att.id := public.asm_next_attempt(v_id, v_student, public.asm_due_for(v_id, v_student), null, false);
   perform public.asm_log('student', 'attempt_open', 'attempt', v_att.id::text, jsonb_build_object('assignmentId', v_id), v_a.tenant_id);
  end if;
  v_set := public.asm_effective_settings(v_as.id);
  return jsonb_build_object('assignment', jsonb_build_object('id', v_a.id, 'title', v_as.title, 'description', v_as.description, 'dueAt', public.asm_due_for(v_id, v_student), 'lateUntil', v_a.late_until, 'status', v_a.status,
    'unitCode', (select code from public.cms_course_units where id = v_as.unit_id), 'unitName', (select name from public.cms_course_units where id = v_as.unit_id)),
   'version', jsonb_build_object('id', v_ver.id, 'versionNo', v_ver.version_no, 'definition', v_ver.definition),
   'settings', jsonb_build_object('declarationText', v_set->>'declaration_text', 'instructions', v_set->>'instructions', 'maxAttempts', (v_set->>'max_attempts')::integer,
     'lateSubmission', v_set->>'late_submission', 'evidenceMaxMb', (v_set->>'evidence_max_mb')::integer, 'evidenceAllowedTypes', v_set->'evidence_allowed_types'),
   'attempt', public.asm_attempt_json(v_att.id, 'student'),
   'history', coalesce((select jsonb_agg(public.asm_attempt_json(t.id, 'student') order by t.attempt_no) from public.asm_attempts t where t.assignment_id = v_id and t.student_id = v_student and t.state <> 'void' and t.id <> v_att.id), '[]'));
 elsif p_action = 'draft_save' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id) for update;
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state <> 'draft' then raise exception 'This attempt has been submitted and is locked' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This draft was saved from another window; reload before saving.' using errcode = '40001'; end if;
  v_resp := d->'responses';
  if v_resp is null or jsonb_typeof(v_resp) <> 'object' then raise exception 'responses must be an object' using errcode = '22023'; end if;
  update public.asm_attempts set responses = v_resp where id = v_id returning row_version into v_att.row_version;
  return jsonb_build_object('ok', true, 'rowVersion', v_att.row_version, 'savedAt', now());
 elsif p_action = 'evidence_register' then
  v_id := public.asm_json_uuid(d, 'attemptId'); v_path := public.asm_json_text(d, 'path');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id);
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state <> 'draft' then raise exception 'This attempt is locked' using errcode = '42501'; end if;
  if v_path is null or split_part(v_path, '/', 1) <> v_id::text or split_part(v_path, '/', 2) = 'assessor' then raise exception 'The file must be under your attempt folder' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'assessment-evidence' and o.name = v_path) then raise exception 'Upload the file first' using errcode = 'P0002'; end if;
  insert into public.asm_evidence_files(attempt_id, question_id, group_index, object_path, file_name, mime, bytes, sha256)
  values (v_id, coalesce(public.asm_json_text(d, 'questionId'), split_part(v_path, '/', 2)), (d->>'groupIndex')::integer, v_path, coalesce(public.asm_json_text(d, 'fileName'), split_part(v_path, '/', 3)), coalesce(d->>'mime', 'application/octet-stream'), coalesce((d->>'bytes')::integer, 0), public.asm_json_text(d, 'sha256'))
  on conflict (attempt_id, object_path) do update set file_name = excluded.file_name, mime = excluded.mime, bytes = excluded.bytes, sha256 = excluded.sha256
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
 elsif p_action = 'evidence_remove' then
  v_id := public.asm_json_uuid(d, 'id');
  delete from public.asm_evidence_files f using public.asm_attempts t where f.id = v_id and t.id = f.attempt_id and t.student_id = v_student and t.state = 'draft' and not f.by_assessor;
  return jsonb_build_object('ok', found);
 elsif p_action = 'submit' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id) for update;
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  if v_att.state <> 'draft' and v_att.submit_request_id is not null and v_att.submit_request_id = public.asm_json_text(d, 'requestId') then
   return jsonb_build_object('ok', true, 'receiptNo', v_att.receipt_no, 'submittedAt', v_att.submitted_at, 'responsesSha256', v_att.responses_hash, 'idempotent', true);
  end if;
  if v_att.state <> 'draft' then raise exception 'This attempt has already been submitted' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This draft was saved from another window; reload before submitting.' using errcode = '40001'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id; select * into v_ver from public.asm_versions where id = v_att.version_id;
  if v_a.status <> 'open' then raise exception 'This assessment is closed' using errcode = '42501'; end if;
  v_set := public.asm_effective_settings(v_as.id);
  v_due := coalesce(v_att.due_at, public.asm_due_for(v_a.id, v_student));
  if v_now > v_due and (((v_set->>'late_submission') = 'block' and (v_a.late_until is null or v_now > v_a.late_until)) or (v_a.late_until is not null and v_now > v_a.late_until)) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'late', 'message', 'The due date has passed and late submissions are not accepted. Ask your trainer for an extension.')));
  end if;
  if jsonb_typeof(d->'responses') = 'object' then update public.asm_attempts set responses = d->'responses' where id = v_id; v_att.responses := d->'responses'; end if;
  v_errs := public.asm_validate_responses(v_ver.definition, v_att.responses, 'student');
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  v_sig := public.asm_json_text(d->'declaration', 'signature');
  if v_sig is null or char_length(v_sig) < 2 or not coalesce((d->'declaration'->>'agreed')::boolean, false) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'declaration', 'message', 'Type your full name and tick the declaration to submit.')));
  end if;
  v_hash := encode(sha256(convert_to(v_att.responses::text, 'UTF8')), 'hex');
  v_receipt := 'ASM-' || to_char(v_now at time zone 'Australia/Melbourne', 'YYYY') || '-' || lpad(nextval('public.asm_receipt_seq')::text, 6, '0');
  v_decl := jsonb_build_object('signature', left(v_sig, 200), 'agreed', true, 'text', v_set->>'declaration_text', 'textSha256', encode(sha256(convert_to(coalesce(v_set->>'declaration_text', ''), 'UTF8')), 'hex'),
    'responsesSha256', v_hash, 'signedAt', v_now, 'late', v_now > v_due);
  update public.asm_attempts set state = 'submitted', submitted_at = v_now, responses_hash = v_hash, declaration = v_decl, receipt_no = v_receipt, submit_request_id = public.asm_json_text(d, 'requestId') where id = v_id;
  perform public.asm_autocheck(v_id); perform public.asm_rollup(v_id);
  perform public.asm_notify_trainers(v_a.id, 'submitted', 'Submission received: ' || v_as.title, (select full_name from public.enrollment_students where id = v_student) || ' submitted attempt ' || v_att.attempt_no || ' (receipt ' || v_receipt || ').', v_id);
  perform public.asm_notify_student(v_student, 'submitted', 'Submission receipt ' || v_receipt, v_as.title || ' was submitted on ' || to_char(v_now at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '. Keep this receipt number.', v_id, v_a.id, v_att.tenant_id);
  perform public.asm_log('student', 'submit', 'attempt', v_id::text, jsonb_build_object('receiptNo', v_receipt, 'responsesSha256', v_hash, 'late', v_now > v_due), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'receiptNo', v_receipt, 'submittedAt', v_now, 'responsesSha256', v_hash);
 elsif p_action = 'result_acknowledge' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id) and state in ('returned', 'final');
  if v_att.id is null then raise exception 'There is no returned result to acknowledge' using errcode = 'P0002'; end if;
  if v_att.acknowledged_at is null then
   update public.asm_attempts set acknowledged_at = now() where id = v_id returning * into v_att;
   perform public.asm_log('student', 'result_acknowledge', 'attempt', v_id::text, jsonb_build_object('outcome', v_att.outcome, 'acknowledgedAt', v_att.acknowledged_at), v_att.tenant_id);
  end if;
  return jsonb_build_object('ok', true, 'acknowledgedAt', v_att.acknowledged_at);
 elsif p_action = 'results' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  if not exists (select 1 from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id)) then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  return public.asm_attempt_json(v_id, 'student');
 elsif p_action = 'reassessment_request' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id);
  if v_att.id is null or v_att.state <> 'final' or v_att.outcome <> 'NYS' then raise exception 'A reassessment can be requested for a finalised Not Yet Satisfactory attempt' using errcode = '42501'; end if;
  if exists (select 1 from public.asm_reassessments where attempt_id = v_id and state = 'requested') then raise exception 'A request is already waiting' using errcode = '23505'; end if;
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason) values (v_id, v_student, 'student', coalesce(public.asm_json_text(d, 'reason'), '')) returning id into v_id;
  perform public.asm_notify_trainers(v_att.assignment_id, 'reassessment', 'Reassessment requested', (select full_name from public.enrollment_students where id = v_student) || ' asked for a reassessment.', v_att.id);
  perform public.asm_log('student', 'reassessment_request', 'reassessment', v_id::text, jsonb_build_object('attemptId', v_att.id), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'id', v_id);
 elsif p_action = 'feedback_post' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  select * into v_att from public.asm_attempts where id = v_id and student_id = v_student and public.tenant_scope(tenant_id);
  if v_att.id is null then raise exception 'Attempt not found' using errcode = 'P0002'; end if;
  insert into public.asm_feedback(attempt_id, question_id, author_role, body) values (v_id, public.asm_json_text(d, 'questionId'), 'student', coalesce(public.asm_json_text(d, 'body'), '-'));
  perform public.asm_notify_trainers(v_att.assignment_id, 'marked', 'Student reply on an assessment', left(d->>'body', 400), v_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'progress' then
  return public.asm_student_progress(v_student);
 elsif p_action = 'notifications' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'title', x.title, 'body', x.body, 'attemptId', x.attempt_id, 'assignmentId', x.assignment_id, 'readAt', x.read_at, 'createdAt', x.created_at) order by x.created_at desc)
   from (select * from public.asm_notifications where recipient_auth_user = auth.uid() order by created_at desc limit 50) x), '[]');
 elsif p_action = 'notification_read' then
  update public.asm_notifications set read_at = coalesce(read_at, now()) where recipient_auth_user = auth.uid() and (public.asm_json_uuid(d, 'id') is null or id = public.asm_json_uuid(d, 'id'));
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown action %', p_action using errcode = '22023';
end $function$;
;

-- asm_trainer(text,jsonb)
CREATE OR REPLACE FUNCTION public.asm_trainer(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d jsonb := coalesce(p_data, '{}'::jsonb); v_staff uuid := public.asm_trainer_profile(); v_id uuid; v_att public.asm_attempts; v_a public.asm_assignments; v_as public.asm_assessments; v_ver public.asm_versions;
 x jsonb; n integer := 0; v_set jsonb; v_out text; v_due timestamptz; v_next uuid; v_rv integer; v_errs jsonb; v_path text; v_max integer;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if p_action = 'me' then
  return jsonb_build_object('staffId', v_staff, 'name', (select btrim(first_name || ' ' || last_name) from hr.staff_profiles where id = v_staff),
   'isTrainer', public.asm_has_trainer_role(v_staff), 'requireTrainerRole', coalesce((select s.require_trainer_role from public.asm_settings s where coalesce(s.tenant_id, '00000000-0000-0000-0000-000000000000') = coalesce(public.tenant_current(), '00000000-0000-0000-0000-000000000000')), true),
   'batches', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', public.intake_group_name(i.id), 'intake', public.course_intake_display(i), 'courseName', public.course_label(c.code, c.name, c.variant_label)) order by i.start_date desc, public.intake_group_name(i.id))
     from public.intake_trainers bt join public.course_intakes i on i.id = bt.intake_id join public.cms_courses c on c.id = i.course_id where bt.staff_id = v_staff), '[]'));
 end if;
 if v_staff is null then raise exception 'Only active staff can assess' using errcode = '42501'; end if;

 if p_action = 'my_assignments' then
  return coalesce((select jsonb_agg(public.asm_assignment_json(a) || jsonb_build_object(
    'canAssess', public.asm_can_assess(a.id, v_staff), 'toMark', (select count(*) from public.asm_attempts t where t.assignment_id = a.id and t.state in ('submitted', 'marking')),
    'submitted', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state <> 'draft' and t.state <> 'void'),
    'final', (select count(distinct t.student_id) from public.asm_attempts t where t.assignment_id = a.id and t.state = 'final')) order by a.due_at desc)
   from public.asm_assignments a where a.status <> 'cancelled' and public.asm_trainer_on_assignment(a.id, v_staff)
     and (coalesce(public.asm_json_uuid(d, 'batchId'), public.asm_json_uuid(d, 'intakeId')) is null or a.intake_id = coalesce(public.asm_json_uuid(d, 'batchId'), public.asm_json_uuid(d, 'intakeId')))), '[]');
 elsif p_action = 'pending_marking' then
  return coalesce((select jsonb_agg(jsonb_build_object('attemptId', t.id, 'assignmentId', t.assignment_id, 'studentId', t.student_id, 'studentName', s.full_name, 'attemptNo', t.attempt_no, 'state', t.state,
    'submittedAt', t.submitted_at, 'receiptNo', t.receipt_no, 'assessmentTitle', x.title, 'unitCode', u.code, 'batchName', public.intake_group_name(a.intake_id), 'dueAt', t.due_at) order by t.submitted_at)
   from public.asm_attempts t join public.asm_assignments a on a.id = t.assignment_id join public.asm_assessments x on x.id = a.assessment_id left join public.cms_course_units u on u.id = x.unit_id
   join public.enrollment_students s on s.id = t.student_id
   where t.state in ('submitted', 'marking') and public.asm_trainer_on_assignment(a.id, v_staff)), '[]');
 elsif p_action = 'assignment_students' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_trainer_on_assignment(v_id, v_staff) then raise exception 'Not your assignment' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'email', s.email, 'dueAt', public.asm_due_for(v_id, s.id),
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'attemptNo', t.attempt_no, 'state', t.state, 'outcome', t.outcome, 'submittedAt', t.submitted_at, 'dueAt', t.due_at) order by t.attempt_no)
       from public.asm_attempts t where t.assignment_id = v_id and t.student_id = s.id), '[]')) order by s.full_name)
   from public.asm_assignment_eligible(v_id) e join public.enrollment_students s on s.id = e), '[]');
 elsif p_action = 'attempt_get' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id;
  select * into v_ver from public.asm_versions where id = v_att.version_id;
  select * into v_as from public.asm_assessments where id = v_ver.assessment_id;
  return public.asm_attempt_json(v_id, 'trainer') || jsonb_build_object('canAssess', public.asm_can_assess(v_att.assignment_id, v_staff), 'definition', v_ver.definition, 'assessmentTitle', v_as.title, 'unitId', v_as.unit_id,
   'studentName', (select full_name from public.enrollment_students where id = v_att.student_id),
   'settings', public.asm_effective_settings(v_as.id),
   'keys', coalesce((select jsonb_agg(jsonb_build_object('questionId', k.question_id, 'modelAnswer', k.model_answer, 'answerKey', k.answer_key, 'assessorGuidance', k.assessor_guidance, 'rubricLevels', k.rubric_levels)) from public.asm_question_keys k where k.version_id = v_ver.id), '[]'),
   'mappings', coalesce((select jsonb_agg(jsonb_build_object('questionId', m.question_id, 'criterionId', m.criterion_id, 'elementId', m.element_id, 'elementKind', e.kind, 'elementCode', e.code, 'elementText', e.text)) from public.asm_unit_mappings m join public.asm_unit_elements e on e.id = m.element_id where m.version_id = v_ver.id), '[]'));
 elsif p_action = 'mark_save' then
  -- results per question / criterion, task outcomes, assessor-filled responses (observation checklist, third-party report), overall feedback
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can mark this attempt' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id for update;
  if v_att.state not in ('submitted', 'marking') then raise exception 'This attempt is not open for marking' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This attempt was changed by someone else; reload before saving.' using errcode = '40001'; end if;
  for x in select * from jsonb_array_elements(coalesce(d->'results', '[]')) loop
   if public.asm_json_text(x, 'questionId') is null then continue; end if;
   insert into public.asm_results(attempt_id, question_id, criterion_id, outcome, score, rubric_level_id, feedback, marked_by, marked_at)
   values (v_id, x->>'questionId', public.asm_json_text(x, 'criterionId'), nullif(upper(x->>'outcome'), ''), (x->>'score')::numeric, public.asm_json_text(x, 'rubricLevelId'), coalesce(x->>'feedback', ''), auth.uid(), now())
   on conflict (attempt_id, question_id, coalesce(criterion_id, '')) do update set outcome = excluded.outcome, score = excluded.score, rubric_level_id = excluded.rubric_level_id, feedback = excluded.feedback, marked_by = auth.uid(), marked_at = now();
   n := n + 1;
  end loop;
  perform public.asm_rollup(v_id);
  for x in select * from jsonb_array_elements(coalesce(d->'taskResults', '[]')) loop
   if public.asm_json_text(x, 'taskId') is null then continue; end if;
   insert into public.asm_task_results(attempt_id, task_id, outcome, feedback, signed_by, signed_at)
   values (v_id, x->>'taskId', nullif(upper(x->>'outcome'), ''), coalesce(x->>'feedback', ''), auth.uid(), now())
   on conflict (attempt_id, task_id) do update set outcome = excluded.outcome, feedback = excluded.feedback, signed_by = auth.uid(), signed_at = now();
  end loop;
  update public.asm_attempts set state = 'marking', marking_started_at = coalesce(marking_started_at, now()), marked_by = auth.uid(),
    assessor_responses = case when jsonb_typeof(d->'assessorResponses') = 'object' then assessor_responses || (d->'assessorResponses') else assessor_responses end,
    overall_feedback = coalesce(d->>'overallFeedback', overall_feedback) where id = v_id;
  perform public.asm_log('trainer', 'mark_save', 'attempt', v_id::text, jsonb_build_object('results', n), v_att.tenant_id);
  return public.asm_trainer('attempt_get', jsonb_build_object('id', v_id));
 elsif p_action = 'mark_return' then
  -- the decision: S finalises the attempt; NYS opens a reassessment attempt while attempts remain, else finalises as NYS
  v_id := public.asm_json_uuid(d, 'id'); v_out := upper(coalesce(d->>'outcome', ''));
  if v_out not in ('S', 'NYS') then raise exception 'outcome must be S or NYS' using errcode = '22023'; end if;
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can mark this attempt' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id for update;
  if v_att.state not in ('submitted', 'marking') then raise exception 'This attempt is not open for marking' using errcode = '42501'; end if;
  if d ? 'rowVersion' and (d->>'rowVersion')::integer <> v_att.row_version then raise exception 'This attempt was changed by someone else; reload before saving.' using errcode = '40001'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id;
  select * into v_ver from public.asm_versions where id = v_att.version_id;
  v_errs := public.asm_validate_responses(v_ver.definition, v_att.assessor_responses, 'assessor');
  if jsonb_array_length(v_errs) > 0 then return jsonb_build_object('ok', false, 'errors', v_errs); end if;
  -- every assessable task needs a recorded outcome before the decision
  if exists (select 1 from (select distinct q.task_id from public.asm_definition_questions(v_ver.definition) q where q.marking_mode <> 'none') tk
             where not exists (select 1 from public.asm_task_results r where r.attempt_id = v_id and r.task_id = tk.task_id and r.outcome is not null)) then
   return jsonb_build_object('ok', false, 'errors', jsonb_build_array(jsonb_build_object('code', 'task_outcomes', 'message', 'Record Satisfactory / Not Yet Satisfactory for every task first.')));
  end if;
  v_set := public.asm_effective_settings(v_as.id); v_max := coalesce((v_set->>'max_attempts')::integer, 3);
  if v_out = 'S' then
   update public.asm_attempts set state = 'final', outcome = 'S', overall_feedback = coalesce(d->>'overallFeedback', overall_feedback), marked_by = auth.uid(), returned_at = now(), finalised_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'marked', 'Assessment marked: Satisfactory', v_as.title || ' has been marked Satisfactory. Open My Assessments to read the feedback.', v_id, v_a.id, v_att.tenant_id);
  elsif public.asm_attempt_count(v_a.id, v_att.student_id) < v_max and v_a.status = 'open' then
   v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((v_set->>'reassessment_days')::integer, 5)));
   update public.asm_attempts set state = 'returned', outcome = 'NYS', overall_feedback = coalesce(d->>'overallFeedback', overall_feedback), marked_by = auth.uid(), returned_at = now() where id = v_id;
   v_next := public.asm_next_attempt(v_a.id, v_att.student_id, v_due, v_id, false);
   insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
   values (v_id, v_att.student_id, 'trainer', coalesce(d->>'overallFeedback', 'Not yet satisfactory'), 'opened', v_due, v_next, auth.uid(), now());
   perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Reassessment required: ' || v_as.title, 'Attempt ' || v_att.attempt_no || ' was Not Yet Satisfactory. Attempt ' || (v_att.attempt_no + 1) || ' is open until ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', v_next, v_a.id, v_att.tenant_id);
  else
   update public.asm_attempts set state = 'final', outcome = 'NYS', overall_feedback = coalesce(d->>'overallFeedback', overall_feedback), marked_by = auth.uid(), returned_at = now(), finalised_at = now() where id = v_id;
   perform public.asm_notify_student(v_att.student_id, 'marked', 'Assessment marked: Not Yet Satisfactory', v_as.title || ' was marked Not Yet Satisfactory and no further attempt is available. Contact your trainer.', v_id, v_a.id, v_att.tenant_id);
  end if;
  perform public.asm_log('trainer', 'mark_return', 'attempt', v_id::text, jsonb_build_object('outcome', v_out, 'nextAttemptId', v_next), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'outcome', v_out, 'nextAttemptId', v_next);
 elsif p_action = 'feedback_post' then
  v_id := public.asm_json_uuid(d, 'attemptId');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  insert into public.asm_feedback(attempt_id, question_id, author_role, body) values (v_id, public.asm_json_text(d, 'questionId'), 'trainer', coalesce(public.asm_json_text(d, 'body'), '-'));
  select * into v_att from public.asm_attempts where id = v_id;
  perform public.asm_notify_student(v_att.student_id, 'marked', 'New feedback from your assessor', left(d->>'body', 400), v_id, v_att.assignment_id, v_att.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'evidence_register' then
  v_id := public.asm_json_uuid(d, 'attemptId'); v_path := public.asm_json_text(d, 'path');
  if not public.asm_trainer_on_attempt(v_id) then raise exception 'Not your student' using errcode = '42501'; end if;
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only a trainer with the trainer role, a named assessor or an administrator can attach assessor files' using errcode = '42501'; end if;
  if v_path is null or split_part(v_path, '/', 1) <> v_id::text or split_part(v_path, '/', 2) <> 'assessor' then raise exception 'The file must be under <attempt>/assessor/' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'assessment-evidence' and o.name = v_path) then raise exception 'Upload the file first' using errcode = 'P0002'; end if;
  insert into public.asm_evidence_files(attempt_id, question_id, by_assessor, object_path, file_name, mime, bytes, sha256)
  values (v_id, coalesce(public.asm_json_text(d, 'questionId'), 'assessor'), true, v_path, coalesce(public.asm_json_text(d, 'fileName'), split_part(v_path, '/', 3)), coalesce(d->>'mime', 'application/octet-stream'), coalesce((d->>'bytes')::integer, 0), public.asm_json_text(d, 'sha256'))
  on conflict (attempt_id, object_path) do nothing;
  return jsonb_build_object('ok', true);
 elsif p_action = 'attempt_void' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only an assessor of this assignment or an administrator can void an attempt' using errcode = '42501'; end if;
  update public.asm_attempts set state = 'void', voided_at = now(), void_reason = coalesce(public.asm_json_text(d, 'reason'), 'voided by assessor') where id = v_id and state <> 'void' returning * into v_att;
  if v_att.id is null then raise exception 'Attempt not found or already void' using errcode = 'P0002'; end if;
  perform public.asm_log('trainer', 'attempt_void', 'attempt', v_id::text, jsonb_build_object('reason', v_att.void_reason), v_att.tenant_id);
  return jsonb_build_object('ok', true);
 elsif p_action = 'attempt_reopen' then
  v_id := public.asm_json_uuid(d, 'id');
  if not public.asm_can_assess_attempt(v_id) then raise exception 'Only an assessor of this assignment or an administrator can reopen an attempt' using errcode = '42501'; end if;
  select * into v_att from public.asm_attempts where id = v_id;
  if v_att.state not in ('returned', 'final') then raise exception 'Only a returned or finalised attempt can be reopened' using errcode = '42501'; end if;
  select * into v_a from public.asm_assignments where id = v_att.assignment_id; select * into v_as from public.asm_assessments where id = v_a.assessment_id;
  v_set := public.asm_effective_settings(v_as.id);
  v_due := coalesce(public.asm_json_ts(d, 'dueAt'), now() + make_interval(days => coalesce((v_set->>'reassessment_days')::integer, 5)));
  v_next := public.asm_next_attempt(v_a.id, v_att.student_id, v_due, v_att.id, false);
  insert into public.asm_reassessments(attempt_id, student_id, requested_role, reason, state, new_due_at, next_attempt_id, decided_by, decided_at)
  values (v_att.id, v_att.student_id, 'trainer', coalesce(d->>'reason', 'reopened by assessor'), 'opened', v_due, v_next, auth.uid(), now());
  perform public.asm_notify_student(v_att.student_id, 'reassessment', 'Your assessment has been reopened', 'A further attempt is open until ' || to_char(v_due at time zone 'Australia/Melbourne', 'DD Mon YYYY HH24:MI') || '.', v_next, v_a.id, v_att.tenant_id);
  perform public.asm_log('trainer', 'attempt_reopen', 'attempt', v_id::text, jsonb_build_object('nextAttemptId', v_next, 'dueAt', v_due, 'reason', d->>'reason'), v_att.tenant_id);
  return jsonb_build_object('ok', true, 'attemptId', v_next);
 elsif p_action = 'unit_outcome_record' then
  return public.asm_record_unit_outcome(d, 'trainer');
 elsif p_action = 'student_progress' then
  v_id := public.asm_json_uuid(d, 'studentId');
  if not exists (select 1 from public.batch_enrolments e join public.intake_trainers bt on bt.intake_id = e.intake_id where e.student_id = v_id and bt.staff_id = v_staff) then raise exception 'Not your student' using errcode = '42501'; end if;
  return public.asm_student_progress(v_id);
 elsif p_action = 'my_students' then
  return coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.full_name, 'email', s.email, 'batchId', i.id, 'batchName', public.intake_group_name(i.id), 'courseName', public.course_label(c.code, c.name, c.variant_label)) order by public.intake_group_name(i.id), s.full_name)
   from public.intake_trainers bt join public.course_intakes i on i.id = bt.intake_id join public.cms_courses c on c.id = i.course_id
   join public.batch_enrolments e on e.intake_id = i.id and e.status = 'active' join public.enrollment_students s on s.id = e.student_id where bt.staff_id = v_staff), '[]');
 elsif p_action = 'unit_elements' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'parentId', e.parent_id, 'code', e.code, 'text', e.text, 'sort', e.sort) order by e.kind, e.sort, e.code)
    from public.asm_unit_elements e where e.unit_id = d->>'unitId' and e.is_active and public.tenant_scope(e.tenant_id)), '[]');
 elsif p_action = 'notifications' then
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'event', x.event, 'title', x.title, 'body', x.body, 'attemptId', x.attempt_id, 'assignmentId', x.assignment_id, 'readAt', x.read_at, 'createdAt', x.created_at) order by x.created_at desc)
   from (select * from public.asm_notifications where recipient_auth_user = auth.uid() order by created_at desc limit 50) x), '[]');
 elsif p_action = 'notification_read' then
  update public.asm_notifications set read_at = coalesce(read_at, now()) where recipient_auth_user = auth.uid() and (public.asm_json_uuid(d, 'id') is null or id = public.asm_json_uuid(d, 'id'));
  return jsonb_build_object('ok', true);
 end if;
 raise exception 'Unknown action %', p_action using errcode = '22023';
end $function$;
;


-- Triggers that watched batch_id watch intake_id.
drop trigger if exists batch_enrolments_seat_guard on public.batch_enrolments;
create trigger batch_enrolments_seat_guard before insert or update of status, intake_id, enrolled_on on public.batch_enrolments
  for each row execute function public.rto_batch_seat_guard();
drop trigger if exists asm_batch_enrolment_change on public.batch_enrolments;
create trigger asm_batch_enrolment_change after insert or delete or update of status, intake_id on public.batch_enrolments
  for each row execute function public.asm_batch_enrolment_change();
drop trigger if exists rto_carry_over_enrolment on public.batch_enrolments;
create trigger rto_carry_over_enrolment after insert or delete or update of status, intake_id, enrolled_on on public.batch_enrolments
  for each row execute function public.rto_carry_over_on_enrolment();

-- Master weekly hours: checked on the intake's class times.
drop trigger if exists course_master_group_hours on public.batch_sessions;
drop trigger if exists course_master_group_hours on public.intake_class_times;
create constraint trigger course_master_group_hours after insert or delete or update on public.intake_class_times
  deferrable initially deferred for each row execute function public.course_master_group_hours();

-- Carry-over replanning when an intake's group or class times change (was on batches).
drop trigger if exists rto_carry_over_batch_ins on public.batches;
drop trigger if exists rto_carry_over_batch_upd on public.batches;
drop trigger if exists rto_carry_over_intake_upd on public.course_intakes;
create trigger rto_carry_over_intake_upd after update on public.course_intakes
  referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_times_ins on public.intake_class_times;
create trigger rto_carry_over_times_ins after insert on public.intake_class_times
  referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_times_upd on public.intake_class_times;
create trigger rto_carry_over_times_upd after update on public.intake_class_times
  referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_times_del on public.intake_class_times;
create trigger rto_carry_over_times_del after delete on public.intake_class_times
  referencing old table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();

-- The intake's own class times are written directly now: the batch -> intake copy of class times stops.
drop trigger if exists intake_bridge_class_times on public.batch_sessions;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261119223000', 'intake_replaces_batch_stage2b_functions', array['see repo file']) on conflict do nothing;
commit;
