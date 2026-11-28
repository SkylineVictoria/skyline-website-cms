-- AXCELERATE-TIMETABLE-RESULTS (owner 2026-11-28: "units need to be imported; create the weekly and monthly timetable she is following;
-- the refresh button populates all"). Decisions (owner, 2026-11-28): aXcelerate's unit dates win (the course's CoE master is rebuilt from
-- them); imported CoE classes get Mon-Fri 9:00-13:00 (Mon / Wed theory, Tue / Thu practical, Fri assessment: 20 hours a week, as Skyline's
-- CoE classes); unit results are imported as aXcelerate has them (a later sign-off or staff change in Skyline wins); the room stays the
-- placeholder "aXcelerate import (set room)" until staff choose one. One way only, aXcelerate -> Skyline.
--   * axcelerate_class_master: a CoE class's units with aXcelerate's dates become the course's CoE master (cycle 1, one row per unit,
--     weeks = whole weeks of its dates), then course_master_apply moves every open class of the course onto it (Skyline's own path).
--     The master follows the aXcelerate class running today (else the latest-starting one); a master changed in Skyline after the last
--     import is kept, with a warning. The cycles planned stay as they were (an RTO Manager plans more cycles on the Weekly Calendar).
--   * axcelerate_class_timetable: an imported CoE class without class times gets Mon-Fri 9:00-13:00 in its room with its trainer, and its
--     classes (the daily timetable) are laid out on the master's unit dates by course_master_classes. A class that already has class times
--     is left alone (the master apply re-plans its classes). Anything Skyline refuses (room, trainer, clash, hours) leaves the class
--     imported, with the reason as a warning.
--   * axcelerate_import_class: imports as before (an imported class is CoE when the course has a CRICOS code or a CoE master), then the
--     master and the timetable (with the RTO auto-placing marker, as course_master_roll does, so a course whose master needs more cycles
--     still takes the import). Its warnings are returned.
--   * axcelerate_import_unit_results: the student joins the class's LMS roster; aXcelerate's unit enrolments of one Qualification
--     (TYPE s, OUTCOMECODE, commenced / completion dates) -> the student's unit results (lms_unit_students): outcome, activity start / end, "Imported from aXcelerate" note; the AVETMISS
--     result trigger runs unchanged (location, funding, delivery mode). A result recorded in Skyline after the last import is kept.
begin;

alter table public.axcelerate_links drop constraint if exists axcelerate_links_entity_check;
alter table public.axcelerate_links add constraint axcelerate_links_entity_check
  check (entity in ('location', 'course', 'unit', 'trainer', 'class', 'class_unit', 'break', 'student', 'agent', 'agency', 'qualification',
                    'master', 'unit_result'));

/** aXcelerate's unit dates of a CoE class -> the course's CoE master. Returns a warning, or null. */
create or replace function public.axcelerate_class_master(p_connection uuid, p_run uuid, p_actor uuid, p_course text, p_class text, p_units jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_rows jsonb; v_first date; v_last date; l public.axcelerate_links; t public.course_coe_timetables; v_today date := public.course_intake_today();
  v_cur_first date; v_cur_last date; v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  select coalesce(jsonb_agg(z.x order by z.x->>'start', z.x->>'unitId'), '[]'::jsonb) into v_rows from (
    select distinct on (u->>'unitId') jsonb_build_object('unitId', u->>'unitId', 'start', public.axcelerate_date(u->>'start'),
             'end', greatest(public.axcelerate_date(u->>'end'), public.axcelerate_date(u->>'start'))) as x
      from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) u
     where nullif(u->>'unitId', '') is not null and public.axcelerate_date(u->>'start') is not null and public.axcelerate_date(u->>'end') is not null
       and exists (select 1 from public.cms_course_units cu where cu.id = u->>'unitId' and cu.course_id = p_course)
     order by u->>'unitId', u->>'start') z;
  if jsonb_array_length(v_rows) = 0 then return null; end if;
  select min((x->>'start')::date), max((x->>'end')::date) into v_first, v_last from jsonb_array_elements(v_rows) x;
  l := public.axcelerate_link_find(p_connection, 'master', p_course);
  select * into t from public.course_coe_timetables where course_id = p_course;
  -- Several aXcelerate classes of one course: the one running today defines the master, else the latest-starting one.
  if l.id is not null and coalesce(l.raw->>'class', '') <> p_class then
    v_cur_first := (l.raw->>'start')::date; v_cur_last := (l.raw->>'end')::date;
    if not ((v_first <= v_today and v_last >= v_today and not (v_cur_first <= v_today and v_cur_last >= v_today))
            or (not (v_cur_first <= v_today and v_cur_last >= v_today) and not (v_first <= v_today and v_last >= v_today) and v_first > v_cur_first)) then
      return null;
    end if;
  end if;
  if l.id is not null and t.course_id is not null and t.updated_at > l.last_imported_at + interval '5 seconds' and t.updated_by is distinct from p_actor then
    return 'The CoE master timetable of this course was changed in Skyline after the last import: kept (aXcelerate''s unit dates were not applied).';
  end if;
  perform set_config('rto.auto_place', 'on', true);
  delete from public.course_coe_units where course_id = p_course;
  insert into public.course_coe_units(course_id, cycle, unit_id, weeks, sort, start_date, end_date)
  select p_course, 1, x->>'unitId', least(greatest(ceil(((x->>'end')::date - (x->>'start')::date + 1) / 7.0), 1), 104),
         row_number() over (order by x->>'start', x->>'unitId'), (x->>'start')::date, (x->>'end')::date
    from jsonb_array_elements(v_rows) x;
  insert into public.course_coe_timetables(course_id, start_date, updated_at, updated_by, cycles_planned)
  values (p_course, v_first, now(), p_actor, 1)
  on conflict (course_id) do update set start_date = excluded.start_date, updated_at = now(), updated_by = p_actor;
  if coalesce(t.cycles_planned, 1) > 1 then perform public.course_master_build_cycles(p_course); end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'master', p_course, 'public.course_coe_timetables', p_course,
    jsonb_build_object('class', p_class, 'start', v_first, 'end', v_last, 'units', v_rows));
  perform public.course_master_apply(p_course);
  perform set_config('rto.auto_place', v_was, true);
  return null;
end $$;

/** Mon-Fri 9:00-13:00 for an imported CoE class without class times, and its classes. Returns a warning, or null. */
create or replace function public.axcelerate_class_timetable(p_intake uuid, p_trainer uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public, hr as $$
declare i public.course_intakes; v_room uuid; v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null or public.course_master_kind_for(i.course_id, i.study_load) <> 'coe' or coalesce(i.status, 'open') = 'closed' then return null; end if;
  if exists (select 1 from public.intake_class_times where intake_id = p_intake) then return null; end if;
  begin
    v_room := public.axcelerate_class_room(p_intake, p_actor);
    perform set_config('rto.auto_place', 'on', true);
    insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort, trainer_id)
    select p_intake, d.wd, 'morning', time '09:00', time '13:00', d.kind, v_room, d.wd, p_trainer
      from (values (1, 'theory'), (2, 'practical'), (3, 'theory'), (4, 'practical'), (5, 'assessment')) d(wd, kind);
    if exists (select 1 from public.course_coe_timetables where course_id = i.course_id) then perform public.course_master_classes(p_intake);
    else perform public.rto_class_sessions_generate(p_intake); end if;
    perform set_config('rto.auto_place', v_was, true);
    return null;
  exception when others then
    perform set_config('rto.auto_place', v_was, true);
    return 'Weekly class times and classes were not set: ' || sqlerrm || ' Set them on the Intakes page.';
  end;
end $$;

/** One aXcelerate class: as 20261128041517, then (CoE) the course's master from its unit dates and the class's weekly timetable. */
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
  -- CoE (international) when the course has a CRICOS code or a CoE master timetable in Skyline (owner 2026-11-28: imported classes follow
  -- the CoE master), else VoE.
  select case when coalesce(nullif(btrim(cricos), ''), cricos_course_code) is not null
               or exists (select 1 from public.course_coe_timetables t where t.course_id = p_course) then 'coe' else 'voe' end
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
  -- CoE: the course's master from aXcelerate's unit dates, then the class's weekly timetable and its classes.
  -- The class follows the course's CoE master unless the course has a VoE calendar for a VoE class (course_master_kind_for).
  if (select public.course_master_kind_for(ci.course_id, ci.study_load) from public.course_intakes ci where ci.id = v_id) = 'coe' then
    v_w := public.axcelerate_class_master(p_connection, p_run, p_actor, p_course, v_ax, p_units);
    if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
    v_w := public.axcelerate_class_timetable(v_id, p_trainer, p_actor);
    if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  end if;
  perform set_config('rto.auto_place', v_was, true);
  return public.axcelerate_outcome(case when l.id is null then 'created' else 'updated' end, v_id::text,
    jsonb_build_object('units', n_units, 'warnings', v_warn));
end $$;

/** aXcelerate's unit enrolments (TYPE s) of one Qualification -> the student's unit results. Returns {units: [{code, outcome, action, message}]}. */
create or replace function public.axcelerate_import_unit_results(p_connection uuid, p_run uuid, p_actor uuid, p_enrolment uuid, p_units jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.intake_enrolments; i public.course_intakes; u jsonb; v_unit text; v_code text; v_out text; r public.lms_unit_students;
  l public.axcelerate_links; v_start date; v_end date; v_res jsonb := '[]'::jsonb; v_key text; v_loc uuid; v_act text;
begin
  perform public.axcelerate_importing(p_actor);
  select * into e from public.intake_enrolments where id = p_enrolment;
  if e.id is null then raise exception 'Qualification not found' using errcode = 'P0002'; end if;
  select * into i from public.course_intakes where id = e.intake_id;
  select id into v_loc from public.locations where name = i.campus order by created_at limit 1;
  -- The student in the class's LMS roster (allocations are permanent: only the units aXcelerate has her enrolled in are added, on the
  -- class's unit dates; Skyline's own study plan adds the rest when staff plan it).
  insert into public.lms_intake_students(intake_id, student_id, enrolled_at)
  values (i.id, e.student_id, coalesce(e.enrolled_on::timestamptz, now())) on conflict do nothing;
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
        insert into public.lms_unit_students(intake_id, unit_id, student_id, course_id, allocated_at, assigned_start_date, assigned_end_date, location_id)
        select i.id, v_unit, e.student_id, i.course_id, now(), iu.start_date, iu.end_date, v_loc
          from (select 1) d left join public.intake_units iu on iu.intake_id = i.id and iu.unit_id = v_unit;
        v_act := 'created';
      elsif r.outcome_code is not null and r.outcome_code is distinct from v_out
            and (l.id is null or r.outcome_recorded_at > l.last_imported_at + interval '5 seconds') then
        v_res := v_res || jsonb_build_object('code', v_code, 'outcome', r.outcome_code, 'action', 'kept',
          'message', format('Skyline has result %s (kept); aXcelerate has %s.', r.outcome_code, v_out));
        continue;
      elsif r.outcome_code is not distinct from v_out and r.actual_start_date is not distinct from coalesce(v_start, r.actual_start_date)
            and r.actual_end_date is not distinct from (case when v_out = '70' then null else coalesce(v_end, r.actual_end_date) end) then
        perform public.axcelerate_link_save(p_connection, p_run, 'unit_result', v_key, 'public.lms_unit_students', v_key, u);
        v_res := v_res || jsonb_build_object('code', v_code, 'outcome', v_out, 'action', 'unchanged');
        continue;
      else
        v_act := 'updated';
      end if;
      update public.lms_unit_students
         set outcome_code = v_out,
             actual_start_date = coalesce(v_start, actual_start_date, assigned_start_date),
             actual_end_date = case when v_out = '70' then null else coalesce(v_end, actual_end_date) end,
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
  return jsonb_build_object('units', v_res);
end $$;

revoke all on function public.axcelerate_class_master(uuid, uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.axcelerate_class_timetable(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.axcelerate_import_unit_results(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.axcelerate_class_master(uuid, uuid, uuid, text, text, jsonb), public.axcelerate_class_timetable(uuid, uuid, uuid),
  public.axcelerate_import_unit_results(uuid, uuid, uuid, uuid, jsonb) to service_role;

commit;
