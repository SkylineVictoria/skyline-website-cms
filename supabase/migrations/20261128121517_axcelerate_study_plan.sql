-- AXCELERATE-STUDY-PLAN (owner 2026-11-28: "bring the course and all units so you can't miss; make sure the units match the master
-- calendar which is current, so allocate the timetable"; "take nominal hours as fixed and create the master calendar and daily (classes);
-- make sure the batch is also imported"; no new intake).
--   * axcelerate_unit_hours: a course unit without hours gets the NCVER nationally agreed nominal hours (tga_nominal_hours, as the Training.gov.au
--     import fills nominal_hours) as its hours: nominal_hours and Your RTO hours (slit_hours, NAT00060) = those hours, split by Skyline's
--     default share (lms.unit_hours_split, 40 / 40 / 20), left unconfirmed (an RTO Manager confirms them on the Units page). Hours Skyline
--     already has are never changed. A unit not on the NCVER list is warned about.
--   * axcelerate_class_batch: the class's batch is aXcelerate's group (the "-G1" of the class name): the class's single batch takes its code,
--     the class name, room and trainer.
--   * axcelerate_import_class: as 20261128111517, with the unit hours before the calendar and classes (so the daily classes are laid out)
--     and the batch after.
--   * axcelerate_import_unit_results: the student's study plan in the class by Skyline's rule (students.study_plan_late_join: units ending on
--     or after the join day, on the class's unit dates), then aXcelerate's unit results; a unit that ran before the join day is not allocated
--     in this class (aXcelerate plans it later; no invented repetition, no new intake); 85 (not yet started) has no activity dates.
begin;

alter table public.axcelerate_links drop constraint if exists axcelerate_links_entity_check;
alter table public.axcelerate_links add constraint axcelerate_links_entity_check
  check (entity in ('location', 'course', 'unit', 'trainer', 'class', 'class_unit', 'break', 'student', 'agent', 'agency', 'qualification',
                    'master', 'unit_result', 'batch'));

/** Hours for the course's units that have none: the NCVER nominal hours, split 40 / 40 / 20. Returns a warning, or null. */
create or replace function public.axcelerate_unit_hours(p_course text)
returns text language plpgsql security definer set search_path = public as $$
declare u record; v_h integer; v_th integer; v_pr integer; v_none text[] := '{}';
begin
  for u in select c.id, c.code, c.nominal_hours from public.cms_course_units c
            where c.course_id = p_course and c.is_active and coalesce(c.slit_hours, 0) = 0 order by c.sort, c.code loop
    v_h := coalesce(nullif(u.nominal_hours, 0), (select h.hours from public.tga_nominal_hours h where h.unit_code = upper(btrim(u.code))));
    if coalesce(v_h, 0) <= 0 then v_none := v_none || u.code; continue; end if;
    v_th := round(v_h * public.lms_hours_share('theoryPercent'));
    v_pr := round(v_h * public.lms_hours_share('practicalPercent'));
    update public.cms_course_units
       set nominal_hours = coalesce(nominal_hours, v_h),
           nominal_hours_source = coalesce(nominal_hours_source, 'NCVER nationally agreed nominal hours (2026)'),
           slit_hours = v_h, theory_hours = v_th, practical_hours = v_pr, assessment_hours = v_h - v_th - v_pr,
           hours_confirmed_at = null, hours_confirmed_by = null
     where id = u.id;
  end loop;
  if cardinality(v_none) > 0 then
    return format('No NCVER nominal hours for %s: set their hours on the Units page, then import again.', array_to_string(v_none, ', '));
  end if;
  return null;
end $$;

/** The class's batch = aXcelerate's group (the "-G1" at the end of the class name). Returns a warning, or null. */
create or replace function public.axcelerate_class_batch(p_connection uuid, p_run uuid, p_actor uuid, p_intake uuid, p_class text, p_name text, p_trainer uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text := upper((regexp_match(coalesce(p_name, ''), '(?:^|[^A-Za-z0-9])(G[0-9]{1,3})\s*$', 'i'))[1]); b public.intake_batches; v_room uuid;
begin
  select * into b from public.intake_batches where intake_id = p_intake and archived_at is null order by sort, code limit 1;
  if b.id is null then b.id := public.intake_default_batch(p_intake); select * into b from public.intake_batches where id = b.id; end if;
  if (select count(*) from public.intake_batches where intake_id = p_intake and archived_at is null) > 1 then
    perform public.axcelerate_link_save(p_connection, p_run, 'batch', p_class, 'public.intake_batches', b.id::text, jsonb_build_object('name', p_name, 'group', v_code));
    return null;
  end if;
  select classroom_id into v_room from public.course_intakes where id = p_intake;
  update public.intake_batches
     set code = coalesce(v_code, code), name = left(coalesce(p_name, name), 120), room_id = coalesce(room_id, v_room),
         default_trainer_id = coalesce(default_trainer_id, p_trainer), updated_at = now(), updated_by = p_actor
   where id = b.id;
  perform public.axcelerate_link_save(p_connection, p_run, 'batch', p_class, 'public.intake_batches', b.id::text, jsonb_build_object('name', p_name, 'group', v_code));
  return null;
exception when others then
  return 'The class''s batch was not updated: ' || sqlerrm;
end $$;

/** One aXcelerate class: as 20261128111517, plus the course's unit hours (NCVER nominal hours where Skyline has none) before its calendar and
 * classes, and the class's batch (aXcelerate's group, e.g. G1). */
create or replace function public.axcelerate_import_class(p_connection uuid, p_run uuid, p_actor uuid, p_rec jsonb, p_course text, p_units jsonb, p_trainer uuid, p_location uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ax text := public.axcelerate_text(p_rec, 'INSTANCEID', 'ID');
  v_name text := left(coalesce(public.axcelerate_text(p_rec, 'NAME'), 'aXcelerate class ' || v_ax), 160);
  v_start date := public.axcelerate_date(p_rec->>'STARTDATE'); v_end date := public.axcelerate_date(p_rec->>'FINISHDATE');
  v_cap int := nullif(regexp_replace(coalesce(p_rec->>'MAXPARTICIPANTS', ''), '[^0-9]', '', 'g'), '')::int;
  v_active boolean := lower(coalesce(p_rec->>'ISACTIVE', 'true')) not in ('false', '0', 'no');
  v_open boolean := lower(coalesce(p_rec->>'ENROLMENTOPEN', 'true')) not in ('false', '0', 'no');
  v_status text; v_load text; v_campus text; l public.axcelerate_links; v_id uuid; v_old jsonb; v_new jsonb; u jsonb; v_iu uuid;
  v_ustart date; v_uend date; v_batch uuid; n_units int := 0; v_warn jsonb := '[]'::jsonb; v_w text;
  v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  if v_ax is null then raise exception 'The class has no aXcelerate instance ID' using errcode = '22023'; end if;
  if p_course is null then raise exception 'The class % has no course', v_name using errcode = '22023'; end if;
  perform public.axcelerate_importing(p_actor);
  if public.axcelerate_is_skipped(p_connection, 'class', v_ax) then return public.axcelerate_outcome('skipped', null); end if;
  if v_start is null then
    select min(public.axcelerate_date(x->>'start')) into v_start from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x;
  end if;
  if v_start is null then raise exception 'The class % has no start date', v_name using errcode = '22023'; end if;
  if v_end is not null and v_end < v_start then v_end := v_start; end if;
  if v_cap is not null and (v_cap < 1 or v_cap > 10000) then v_cap := null; end if;
  v_status := case when v_active and v_open and coalesce(v_end, v_start) >= current_date then 'open' else 'closed' end;
  -- CoE only for a course on the CRICOS register (a CRICOS code; the import looks it up), else VoE.
  select case when coalesce(nullif(btrim(cricos), ''), cricos_course_code) is not null then 'coe' else 'voe' end
    into v_load from public.cms_courses where id = p_course;
  select left(name, 200) into v_campus from public.locations where id = p_location;
  v_new := jsonb_build_object('name', v_name, 'start_date', v_start, 'end_date', v_end, 'capacity', v_cap, 'status', v_status);
  -- The import may write a course whose master needs more cycles planned (as course_master_roll does).
  perform set_config('rto.auto_place', 'on', true);
  l := public.axcelerate_link_find(p_connection, 'class', v_ax);
  if l.id is not null then
    select jsonb_build_object('name', name, 'start_date', start_date, 'end_date', end_date, 'capacity', capacity, 'status', status)
      into v_old from public.course_intakes where id = l.target_id::uuid;
    if v_old is null then delete from public.axcelerate_links where id = l.id; l := null;
    elsif l.edited_in_skyline_at is not null and l.edited_in_skyline_at > l.last_imported_at then
      perform public.axcelerate_conflicts_record(l.id, p_run, v_old, v_new);
      perform public.axcelerate_link_save(p_connection, p_run, 'class', v_ax, 'public.course_intakes', l.target_id, p_rec);
      perform set_config('rto.auto_place', v_was, true);
      return public.axcelerate_outcome('conflict', l.target_id);
    else
      v_id := l.target_id::uuid;
      update public.course_intakes set name = v_name, label = left(v_name, 80), start_date = v_start, end_date = v_end, capacity = v_cap, status = v_status,
             campus = coalesce(v_campus, campus), study_load = coalesce(v_load, study_load), updated_at = now(), updated_by = p_actor where id = v_id;
    end if;
  end if;
  if v_id is null then
    insert into public.course_intakes(course_id, start_date, end_date, label, name, campus, capacity, status, study_load, updated_by)
    values (p_course, v_start, v_end, left(v_name, 80), v_name, v_campus, v_cap, v_status, coalesce(v_load, 'voe'), p_actor)
    returning id into v_id;
  end if;
  -- Units of the class on aXcelerate's dates (a course on a Skyline master timetable keeps the master's dates while the class is open).
  for u in select * from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) loop
    v_ustart := coalesce(public.axcelerate_date(u->>'start'), v_start);
    v_uend := greatest(coalesce(public.axcelerate_date(u->>'end'), v_end, v_ustart), v_ustart);
    select id into v_iu from public.intake_units where intake_id = v_id and unit_id = u->>'unitId';
    if v_iu is null then
      insert into public.intake_units(intake_id, unit_id, start_date, end_date, sort, trainer_id)
      values (v_id, u->>'unitId', v_ustart, v_uend, coalesce(nullif(u->>'order', '')::int, n_units + 1), p_trainer) returning id into v_iu;
    elsif not exists (select 1 from public.axcelerate_links x where x.target_table = 'public.intake_units' and x.target_id = v_iu::text
                        and x.edited_in_skyline_at is not null and x.edited_in_skyline_at > x.last_imported_at) then
      update public.intake_units set start_date = v_ustart, end_date = v_uend, trainer_id = coalesce(p_trainer, trainer_id) where id = v_iu;
    end if;
    perform public.axcelerate_link_save(p_connection, p_run, 'class_unit', v_ax || ':' || (u->>'unitId'), 'public.intake_units', v_iu::text, u);
    n_units := n_units + 1;
  end loop;
  if p_trainer is not null then
    v_batch := public.intake_default_batch(v_id);
    insert into public.intake_trainers(intake_id, staff_id, batch_id) select v_id, p_trainer, v_batch
     where not exists (select 1 from public.intake_trainers t where t.intake_id = v_id and t.staff_id = p_trainer);
  end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'class', v_ax, 'public.course_intakes', v_id::text, p_rec);
  -- Unit hours first (the daily classes are laid out until each unit's hours are used).
  v_w := public.axcelerate_unit_hours(p_course);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  -- The calendar of the class's kind (CoE master or VoE calendar) from aXcelerate's unit dates, then its weekly timetable and classes.
  v_w := public.axcelerate_class_calendar(p_connection, p_run, p_actor, p_course, v_ax, p_units,
           case when lower(coalesce((select study_load from public.course_intakes where id = v_id), 'voe')) = 'coe' then 'coe' else 'voe' end);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  v_w := public.axcelerate_class_timetable(v_id, p_trainer, p_actor);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  v_w := public.axcelerate_class_batch(p_connection, p_run, p_actor, v_id, v_ax, v_name, p_trainer);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  perform set_config('rto.auto_place', v_was, true);
  return public.axcelerate_outcome(case when l.id is null then 'created' else 'updated' end, v_id::text,
    jsonb_build_object('units', n_units, 'warnings', v_warn));
end $$;

/**
 * The student's study plan in the class, then aXcelerate's unit results (TYPE s, from the qualification enrolment's activities) of one
 * Qualification. Returns {units: [{code, outcome, action, message}], allocated: [codes], missed: [codes], warnings: [text]}.
 */
create or replace function public.axcelerate_import_unit_results(p_connection uuid, p_run uuid, p_actor uuid, p_enrolment uuid, p_units jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.intake_enrolments; i public.course_intakes; u jsonb; v_unit text; v_code text; v_out text; r public.lms_unit_students;
  l public.axcelerate_links; v_start date; v_end date; v_res jsonb := '[]'::jsonb; v_key text; v_loc uuid; v_act text;
  v_joined date; v_starting boolean; v_alloc jsonb; v_missed jsonb; v_absent jsonb; v_warn jsonb := '[]'::jsonb;
begin
  perform public.axcelerate_importing(p_actor);
  select * into e from public.intake_enrolments where id = p_enrolment;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  select * into i from public.course_intakes where id = e.intake_id;
  select id into v_loc from public.locations where name = i.campus order by created_at limit 1;
  -- The student in the class's LMS roster from the day they joined (aXcelerate's start), and their study plan by Skyline's rule
  -- (students.study_plan_late_join): the class's units ending (or starting) on or after that day, on the class's unit dates, which
  -- follow the course's calendar. Allocations are permanent, so units before the join day are NOT put in an invented repetition:
  -- they are listed as missed (aXcelerate plans them later; a later class takes them).
  v_joined := coalesce(e.enrolled_on, i.start_date);
  insert into public.lms_intake_students(intake_id, student_id, enrolled_at)
  values (i.id, e.student_id, v_joined::timestamptz) on conflict do nothing;
  v_starting := public.rule_text('students.study_plan_late_join', 'Current units ending on or after the join date, then missed units in a future repetition')
    = 'Current units starting on or after the join date, then missed units in a future repetition';
  with ins as (
    insert into public.lms_unit_students(intake_id, unit_id, student_id, course_id, assigned_start_date, assigned_end_date, location_id)
    select i.id, t.unit_id, e.student_id, i.course_id, min(t.start_date), max(t.end_date), v_loc
      from public.intake_units t join public.cms_course_units u on u.id = t.unit_id and u.course_id = i.course_id and u.is_active
     where t.intake_id = i.id
       and not lms_allocation_private.unit_completed(e.student_id, t.unit_id)
       and not exists (select 1 from public.lms_unit_students a where a.student_id = e.student_id and a.course_id = i.course_id and a.unit_id = t.unit_id)
     group by t.unit_id
    having case when v_starting then min(t.start_date) >= v_joined else max(t.end_date) >= v_joined end
    on conflict do nothing returning unit_id)
  select coalesce(jsonb_agg(u.code order by u.code), '[]'::jsonb) into v_alloc from ins join public.cms_course_units u on u.id = ins.unit_id;
  -- Units of the course in Skyline that aXcelerate's class does not have (no dates in the class): they cannot be timetabled.
  select coalesce(jsonb_agg(u.code order by u.sort, u.code), '[]'::jsonb) into v_absent from public.cms_course_units u
   where u.course_id = i.course_id and u.is_active and not exists (select 1 from public.intake_units t where t.intake_id = i.id and t.unit_id = u.id);
  if jsonb_array_length(v_absent) > 0 then
    v_warn := v_warn || to_jsonb(format('Units of the course not in aXcelerate''s class (no dates, not timetabled): %s.', (select string_agg(x, ', ') from jsonb_array_elements_text(v_absent) x)));
  end if;
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
    if v_out is null then
      v_res := v_res || jsonb_build_object('code', v_code, 'action', 'open');
      continue;
    end if;
    if not public.avetmiss_is_code('outcome', v_out) then
      v_res := v_res || jsonb_build_object('code', v_code, 'action', 'error', 'message', format('"%s" is not an AVETMISS outcome code.', v_out));
      continue;
    end if;
    v_key := p_enrolment::text || ':' || v_unit;
    l := public.axcelerate_link_find(p_connection, 'unit_result', v_key);
    begin
      select * into r from public.lms_unit_students where intake_id = i.id and student_id = e.student_id and unit_id = v_unit;
      if r.unit_id is null then
        -- Not in her study plan of this class (it ran before she joined): aXcelerate plans it later; a later class takes it.
        v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'later',
          'message', format('aXcelerate plans it from %s; it ran in this class before she joined, so it is not allocated here (a later class takes it).',
            coalesce(to_char(v_start, 'DD Mon YYYY'), 'a later date')));
        continue;
      elsif r.outcome_code is not null and r.outcome_code is distinct from v_out
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
             location_id = coalesce(location_id, v_loc)
       where intake_id = i.id and student_id = e.student_id and unit_id = v_unit;
      perform public.axcelerate_link_save(p_connection, p_run, 'unit_result', v_key, 'public.lms_unit_students', v_key, u);
      v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', v_act);
    exception when others then
      v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'error', 'message', sqlerrm);
    end;
  end loop;
  -- Units before the join day with no result: not allocated (a later cycle of the course's calendar takes them).
  select coalesce(jsonb_agg(u.code order by t.start_date, u.code), '[]'::jsonb) into v_missed
    from public.intake_units t join public.cms_course_units u on u.id = t.unit_id and u.is_active
   where t.intake_id = i.id and not lms_allocation_private.unit_completed(e.student_id, t.unit_id)
     and not exists (select 1 from public.lms_unit_students a where a.student_id = e.student_id and a.course_id = i.course_id and a.unit_id = t.unit_id);
  if jsonb_array_length(v_missed) > 0 then
    v_warn := v_warn || to_jsonb(format('Joined on %s: %s ran in this class before that; not allocated here (aXcelerate plans them later; a later class takes them).',
      to_char(v_joined, 'DD Mon YYYY'), (select string_agg(x, ', ') from jsonb_array_elements_text(v_missed) x)));
  end if;
  return jsonb_build_object('units', v_res, 'allocated', v_alloc, 'missed', v_missed, 'warnings', v_warn);
end $$;

revoke all on function public.axcelerate_unit_hours(text) from public, anon, authenticated;
revoke all on function public.axcelerate_class_batch(uuid, uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.axcelerate_unit_hours(text), public.axcelerate_class_batch(uuid, uuid, uuid, uuid, text, text, uuid) to service_role;

commit;
