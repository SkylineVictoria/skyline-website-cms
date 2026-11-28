-- AXCELERATE-CALENDARS-10 (owner 2026-11-28: "when you bring data create CoE and VoE monthly calendars, start date 6 months back and add
-- 10 cycles so all units get start and end dates, and try to match aXcelerate dates").
--   * axcelerate_course_calendars (replaces axcelerate_class_calendar for imports): both the CoE master and the VoE calendar of the course,
--     10 cycles, the aXcelerate class's cycle on aXcelerate's exact unit dates, the others repeating its unit order and lengths (break days
--     not counted), starting at least 6 months back. Open classes follow the current cycle.
--   * axcelerate_import_class: a class whose units have all ended in aXcelerate is closed (finished): it keeps aXcelerate's dates while the
--     calendars move to the next cycle; the calendars are built for the course (both kinds).
--   * axcelerate_class_timetable: finished classes get their class times and classes too (their history).
--   * axcelerate_import_unit_results: the study plan by Skyline's own rule (lms_allocation_private.plan_student): the units that ran before
--     the student joined go into the next repetition (a later class, created on the calendar's next cycle when none is open, which gets its
--     timetable); aXcelerate's results are written on the student's allocation of each unit, whichever class it is in (with the student's
--     funding source from the Qualification when that class has none).
--   * course_go_live_after_classes: a course whose classes get their first classes is still published automatically when its set-up is
--     complete, but a course the publish check refuses (e.g. an imported Draft without its training.gov.au details) now stays a Draft
--     instead of blocking the classes (the refusal blocked every new class of such a course).
begin;

create or replace function public.course_go_live_after_classes() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  begin
    update public.cms_courses c set status = 'Published', is_active = true
     where c.id in (select distinct i.course_id from new_rows n join public.course_intakes i on i.id = n.intake_id)
       and (c.status is distinct from 'Published' or not c.is_active)
       and public.course_setup_complete(c.id)
       and public.rule_bool('lms.course_auto_go_live', true);
  exception when check_violation then
    null; -- the course stays as it is (its publish check lists what is missing on the course page)
  end;
  return null;
end $$;

/**
 * The course's CoE master and VoE calendar from an aXcelerate class's unit dates (owner 2026-11-28: "create CoE and VoE monthly calendars,
 * start date 6 months back, add 10 cycles so all units get start and end dates, match aXcelerate's dates"):
 *   - the cycle the aXcelerate class runs in has aXcelerate's exact unit dates;
 *   - the other cycles repeat its unit order and lengths (each unit from its start to the next unit's start, term-break days not counted),
 *     laid out by course_master_layout (breaks skipped): earlier cycles so the calendar starts at least 6 months back, then later ones,
 *     10 cycles in all;
 *   - VoE units at 20 hours a week (the Mon-Fri 9:00-13:00 class times);
 *   - the class running today defines it (else the latest-starting one); a calendar changed in Skyline after the last import is kept.
 * Every open class of the course then follows its calendar's current cycle (course_master_apply_intake). Returns a warning, or null.
 */
create or replace function public.axcelerate_course_calendars(p_connection uuid, p_run uuid, p_actor uuid, p_course text, p_class text, p_units jsonb)
returns text language plpgsql security definer set search_path = public, hr as $$
declare v_rows jsonb; v_pattern jsonb; v_first date; v_last date; v_span integer; v_c1 date; k integer := 0; c integer; v_start date;
  l public.axcelerate_links; v_today date := public.course_intake_today(); v_cur_first date; v_cur_last date; v_key text := 'all:' || p_course;
  v_keep_coe boolean := false; v_keep_voe boolean := false; v_warn text[] := '{}'; r record; t record;
  v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  select coalesce(jsonb_agg(z.x order by z.x->>'start', z.x->>'unitId'), '[]'::jsonb) into v_rows from (
    select distinct on (u->>'unitId') jsonb_build_object('unitId', u->>'unitId', 'start', public.axcelerate_date(u->>'start'),
             'end', greatest(public.axcelerate_date(u->>'end'), public.axcelerate_date(u->>'start'))) as x
      from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) u
     where nullif(u->>'unitId', '') is not null and public.axcelerate_date(u->>'start') is not null and public.axcelerate_date(u->>'end') is not null
       and exists (select 1 from public.cms_course_units cu where cu.id = u->>'unitId' and cu.course_id = p_course and cu.is_active)
     order by u->>'unitId', u->>'start') z;
  if jsonb_array_length(v_rows) = 0 then return null; end if;
  select min((x->>'start')::date), max((x->>'end')::date) into v_first, v_last from jsonb_array_elements(v_rows) x;
  l := public.axcelerate_link_find(p_connection, 'master', v_key);
  -- Several aXcelerate classes of one course: the one running today defines the calendars, else the latest-starting one.
  if l.id is not null and coalesce(l.raw->>'class', '') <> p_class then
    v_cur_first := (l.raw->>'start')::date; v_cur_last := (l.raw->>'end')::date;
    if not ((v_first <= v_today and v_last >= v_today and not (v_cur_first <= v_today and v_cur_last >= v_today))
            or (not (v_cur_first <= v_today and v_cur_last >= v_today) and not (v_first <= v_today and v_last >= v_today) and v_first > v_cur_first)) then
      return null;
    end if;
  end if;
  if l.id is not null then
    select updated_at, updated_by into t from public.course_coe_timetables where course_id = p_course;
    v_keep_coe := t.updated_at is not null and t.updated_at > l.last_imported_at + interval '5 seconds' and t.updated_by is distinct from p_actor;
    select updated_at, updated_by into t from public.course_voe_calendars where course_id = p_course;
    v_keep_voe := t.updated_at is not null and t.updated_at > l.last_imported_at + interval '5 seconds' and t.updated_by is distinct from p_actor;
  end if;
  if v_keep_coe then v_warn := array_append(v_warn, 'The CoE master timetable was changed in Skyline after the last import: kept.'); end if;
  if v_keep_voe then v_warn := array_append(v_warn, 'The VoE calendar was changed in Skyline after the last import: kept.'); end if;
  if v_keep_coe and v_keep_voe then return array_to_string(v_warn, ' '); end if;

  -- The pattern: aXcelerate's unit order; each unit's length = from its start to the next unit's start (or its own end), break days not counted.
  select jsonb_agg(jsonb_build_object('unitId', y.unit_id, 'weeks', greatest(round(y.days / 7.0, 1), 0.5)) order by y.s) into v_pattern from (
    select q.unit_id, q.s,
           (select count(*) from generate_series(q.s, coalesce(q.next_s - 1, q.e), interval '1 day') g
             where not exists (select 1 from public.academic_breaks b where g::date between b.start_date and b.end_date and (b.course_id is null or b.course_id = p_course))) as days
      from (select x->>'unitId' as unit_id, (x->>'start')::date as s, (x->>'end')::date as e,
                   lead((x->>'start')::date) over (order by x->>'start', x->>'unitId') as next_s
              from jsonb_array_elements(v_rows) x) q) y;
  -- Cycles before aXcelerate's so the calendars start at least 6 months back.
  v_span := v_last - v_first + 1;
  v_c1 := v_first;
  while v_c1 > (v_today - interval '6 months')::date and k < 9 loop v_c1 := v_c1 - v_span; k := k + 1; end loop;
  create temp table if not exists axcelerate_calendar_rows (cycle integer, unit_id text, weeks numeric, sort integer, start_date date, end_date date) on commit drop;
  truncate axcelerate_calendar_rows;
  for c in 1..10 loop
    if c = k + 1 then
      insert into axcelerate_calendar_rows
      select c, x->>'unitId', (select (p->>'weeks')::numeric from jsonb_array_elements(v_pattern) p where p->>'unitId' = x->>'unitId'),
             row_number() over (order by x->>'start', x->>'unitId'), (x->>'start')::date, (x->>'end')::date
        from jsonb_array_elements(v_rows) x;
    else
      v_start := case when c <= k then v_first - (k - c + 1) * v_span else (select max(end_date) from axcelerate_calendar_rows where cycle = c - 1) + 1 end;
      insert into axcelerate_calendar_rows select c, m.unit_id, m.weeks, m.sort, m.start_date, m.end_date from public.course_master_layout(p_course, v_start, v_pattern) m;
    end if;
  end loop;

  perform set_config('rto.auto_place', 'on', true);
  if not v_keep_coe then
    delete from public.course_coe_units where course_id = p_course;
    insert into public.course_coe_timetables(course_id, start_date, updated_at, updated_by, cycles_planned)
    values (p_course, (select min(start_date) from axcelerate_calendar_rows), now(), p_actor, 10)
    on conflict (course_id) do update set start_date = excluded.start_date, cycles_planned = 10, updated_at = now(), updated_by = p_actor;
    insert into public.course_coe_units(course_id, cycle, unit_id, weeks, sort, start_date, end_date)
    select p_course, cycle, unit_id, least(greatest(weeks, 0.5), 104), sort, start_date, end_date from axcelerate_calendar_rows;
  end if;
  if not v_keep_voe then
    insert into public.course_voe_calendars(course_id, method, start_date, updated_at, updated_by, cycles_planned)
    values (p_course, 'manual', (select min(start_date) from axcelerate_calendar_rows), now(), p_actor, 10)
    on conflict (course_id) do update set method = 'manual', start_date = excluded.start_date, cycles_planned = 10, updated_at = now(), updated_by = p_actor;
    delete from public.course_voe_units where course_id = p_course;
    insert into public.course_voe_units(course_id, cycle, unit_id, sort, rates, start_date, end_date)
    select p_course, cycle, unit_id, sort, array[20]::numeric[], start_date, end_date from axcelerate_calendar_rows;
  end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'master', v_key, 'public.course_coe_timetables', p_course,
    jsonb_build_object('class', p_class, 'start', v_first, 'end', v_last, 'axcelerateCycle', k + 1, 'cycles', 10, 'units', v_rows));
  -- Every open class of the course follows its calendar's current cycle; its planned classes from today on are laid out again.
  for r in select ci.id from public.course_intakes ci where ci.course_id = p_course and coalesce(ci.status, 'open') <> 'closed' loop
    perform public.course_master_apply_intake(r.id);
    if exists (select 1 from public.intake_class_times s where s.intake_id = r.id) then
      begin
        perform public.course_master_classes(r.id);
      exception when others then
        v_warn := array_append(v_warn, 'Classes of a class of the course were not planned again: ' || sqlerrm);
      end;
    end if;
  end loop;
  perform set_config('rto.auto_place', v_was, true);
  return nullif(array_to_string(v_warn, ' '), '');
end $$;

/** Mon-Fri 9:00-13:00 for an imported class (CoE or VoE, running or finished) without class times, and its classes on its unit dates. */
create or replace function public.axcelerate_class_timetable(p_intake uuid, p_trainer uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public, hr as $$
declare i public.course_intakes; v_room uuid; v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null then return null; end if;
  if exists (select 1 from public.intake_class_times where intake_id = p_intake) then return null; end if;
  begin
    v_room := public.axcelerate_class_room(p_intake, p_actor);
    perform set_config('rto.auto_place', 'on', true);
    insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort, trainer_id)
    select p_intake, d.wd, 'morning', time '09:00', time '13:00', d.kind, v_room, d.wd, p_trainer
      from (values (1, 'theory'), (2, 'practical'), (3, 'theory'), (4, 'practical'), (5, 'assessment')) d(wd, kind);
    -- The classes on the class's unit dates (the calendar of its kind); a class without unit dates: Skyline's generator.
    if exists (select 1 from public.intake_units where intake_id = p_intake) then perform public.course_master_classes(p_intake);
    else perform public.rto_class_sessions_generate(p_intake); end if;
    perform set_config('rto.auto_place', v_was, true);
    return null;
  exception when others then
    perform set_config('rto.auto_place', v_was, true);
    return 'Weekly class times and classes were not set: ' || sqlerrm || ' Set them on the Intakes page.';
  end;
end $$;

/** One aXcelerate class: as 20261128121517; a class whose units have all ended in aXcelerate is closed (finished: it keeps aXcelerate's
 * dates while the course's calendar moves on), and the course's CoE and VoE calendars are both built (10 cycles). */
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
  -- Finished in aXcelerate: every unit of the class has ended (the class keeps its own dates, not the calendar's current cycle).
  if (select max(public.axcelerate_date(x->>'end')) from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) x) < current_date then v_status := 'closed'; end if;
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
  -- The course's CoE and VoE calendars from aXcelerate's unit dates (10 cycles), then the class's weekly timetable and classes.
  v_w := public.axcelerate_course_calendars(p_connection, p_run, p_actor, p_course, v_ax, p_units);
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
 * The student's study plan by Skyline's own rule (lms_allocation_private.plan_student: the class's units ending on or after the join day,
 * then the units that ran before it in the next repetition of the course's calendar, a later class created when none is open, which gets
 * its timetable too), then aXcelerate's unit results (TYPE s) on the student's allocation of each unit, whichever class it is in.
 * Returns {units, allocated, missed, warnings}.
 */
create or replace function public.axcelerate_import_unit_results(p_connection uuid, p_run uuid, p_actor uuid, p_enrolment uuid, p_units jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.intake_enrolments; i public.course_intakes; u jsonb; v_unit text; v_code text; v_out text; r public.lms_unit_students;
  l public.axcelerate_links; v_start date; v_end date; v_res jsonb := '[]'::jsonb; v_key text; v_loc uuid; v_act text;
  v_joined date; v_alloc jsonb; v_missed jsonb; v_absent jsonb; v_warn jsonb := '[]'::jsonb; v_other uuid; v_w text;
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
  begin
    perform lms_allocation_private.plan_student(i.id, e.student_id);
  exception when others then
    v_warn := v_warn || to_jsonb('Study plan not made: ' || sqlerrm);
  end;
  select coalesce(jsonb_agg(u.code order by a.assigned_start_date, u.code), '[]'::jsonb) into v_alloc
    from public.lms_unit_students a join public.cms_course_units u on u.id = a.unit_id where a.student_id = e.student_id and a.course_id = i.course_id;
  -- A later class the plan put units in gets the weekly timetable and classes too (with the class's trainer).
  for v_other in select distinct a.intake_id from public.lms_unit_students a where a.student_id = e.student_id and a.course_id = i.course_id and a.intake_id <> i.id
                   and not exists (select 1 from public.intake_class_times t where t.intake_id = a.intake_id) loop
    v_w := public.axcelerate_class_timetable(v_other, (select staff_id from public.intake_trainers where intake_id = i.id limit 1), p_actor);
    if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  end loop;
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
      select * into r from public.lms_unit_students where student_id = e.student_id and course_id = i.course_id and unit_id = v_unit
       order by (intake_id = i.id) desc, assigned_start_date desc limit 1;
      if r.unit_id is null then
        v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'error',
          'message', 'Not in the student''s study plan in Skyline (see the study plan warning).');
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
             location_id = coalesce(location_id, v_loc),
             funding_source_code = coalesce(funding_source_code, e.funding_source_code)
       where intake_id = r.intake_id and student_id = e.student_id and unit_id = v_unit;
      perform public.axcelerate_link_save(p_connection, p_run, 'unit_result', v_key, 'public.lms_unit_students', v_key, u);
      v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', v_act);
    exception when others then
      v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'error', 'message', sqlerrm);
    end;
  end loop;
  -- Units of the course not in the student's study plan.
  select coalesce(jsonb_agg(u.code order by u.sort, u.code), '[]'::jsonb) into v_missed from public.cms_course_units u
   where u.course_id = i.course_id and u.is_active and not lms_allocation_private.unit_completed(e.student_id, u.id)
     and not exists (select 1 from public.lms_unit_students a where a.student_id = e.student_id and a.course_id = i.course_id and a.unit_id = u.id);
  return jsonb_build_object('units', v_res, 'allocated', v_alloc, 'missed', v_missed, 'warnings', v_warn);
end $$;

revoke all on function public.axcelerate_course_calendars(uuid, uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.axcelerate_course_calendars(uuid, uuid, uuid, text, text, jsonb) to service_role;

commit;
