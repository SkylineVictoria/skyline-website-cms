-- AXCELERATE-CALENDAR-FIT (owner 2026-11-28: "create CoE and VoE master calendars in such a way that the imported schedule fits";
-- "find the CRICOS code with the CRICOS API while bringing in data"). Replaces the CoE-only master of 20261128101517 (not run yet):
-- BSB80120 is not on SLIT's CRICOS registration (04114B, data.gov.au register checked 2026-11-28), so its classes are VoE.
--   * An imported class is CoE only when its course has a CRICOS code (the import now looks the code up on the CRICOS register by the
--     course's national code, axcelerate_course_cricos); else VoE.
--   * axcelerate_class_calendar (replaces axcelerate_class_master): the calendar of the class's kind is built from aXcelerate's unit dates,
--     CoE -> course_coe_timetables / course_coe_units (cycle 1), VoE -> course_voe_calendars (manual) / course_voe_units (cycle 1, 20 hours
--     a week each: the Mon-Fri 9:00-13:00 class times), then every open class of that kind moves onto it (course_master_apply_intake) and
--     its planned classes follow. The class running today defines it (else the latest-starting one); a calendar changed in Skyline after
--     the last import is kept, with a warning. Cycles planned stay as they were.
--   * axcelerate_class_timetable: CoE and VoE classes without class times get Mon-Fri 9:00-13:00 and their classes on their unit dates
--     (term breaks and public holidays skipped by rto_is_teaching_day, as for every Skyline class).
begin;

drop function if exists public.axcelerate_class_master(uuid, uuid, uuid, text, text, jsonb);

/** aXcelerate's unit dates of a class -> the course's calendar of that kind (p_kind coe | voe). Returns a warning, or null. */
create or replace function public.axcelerate_class_calendar(p_connection uuid, p_run uuid, p_actor uuid, p_course text, p_class text, p_units jsonb, p_kind text)
returns text language plpgsql security definer set search_path = public, hr as $$
declare v_rows jsonb; v_first date; v_last date; l public.axcelerate_links; v_updated timestamptz; v_by uuid; v_cycles integer;
  v_today date := public.course_intake_today(); v_cur_first date; v_cur_last date; v_key text := p_kind || ':' || p_course; r record;
  v_was text := coalesce(current_setting('rto.auto_place', true), ''); v_label text := case when p_kind = 'coe' then 'CoE master timetable' else 'VoE calendar' end;
begin
  if p_kind not in ('coe', 'voe') then raise exception 'Unknown calendar kind %', p_kind using errcode = '22023'; end if;
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
  if p_kind = 'coe' then select updated_at, updated_by, cycles_planned into v_updated, v_by, v_cycles from public.course_coe_timetables where course_id = p_course;
  else select updated_at, updated_by, cycles_planned into v_updated, v_by, v_cycles from public.course_voe_calendars where course_id = p_course; end if;
  -- Several aXcelerate classes of one course: the one running today defines the calendar, else the latest-starting one.
  if l.id is not null and coalesce(l.raw->>'class', '') <> p_class then
    v_cur_first := (l.raw->>'start')::date; v_cur_last := (l.raw->>'end')::date;
    if not ((v_first <= v_today and v_last >= v_today and not (v_cur_first <= v_today and v_cur_last >= v_today))
            or (not (v_cur_first <= v_today and v_cur_last >= v_today) and not (v_first <= v_today and v_last >= v_today) and v_first > v_cur_first)) then
      return null;
    end if;
  end if;
  if l.id is not null and v_updated is not null and v_updated > l.last_imported_at + interval '5 seconds' and v_by is distinct from p_actor then
    return format('The %s of this course was changed in Skyline after the last import: kept (aXcelerate''s unit dates were not applied).', v_label);
  end if;
  perform set_config('rto.auto_place', 'on', true);
  if p_kind = 'coe' then
    delete from public.course_coe_units where course_id = p_course;
    insert into public.course_coe_timetables(course_id, start_date, updated_at, updated_by, cycles_planned)
    values (p_course, v_first, now(), p_actor, 1)
    on conflict (course_id) do update set start_date = excluded.start_date, updated_at = now(), updated_by = p_actor;
    insert into public.course_coe_units(course_id, cycle, unit_id, weeks, sort, start_date, end_date)
    select p_course, 1, x->>'unitId', least(greatest(ceil(((x->>'end')::date - (x->>'start')::date + 1) / 7.0), 1), 104),
           row_number() over (order by x->>'start', x->>'unitId'), (x->>'start')::date, (x->>'end')::date
      from jsonb_array_elements(v_rows) x;
    if coalesce(v_cycles, 1) > 1 then perform public.course_master_build_cycles(p_course); end if;
  else
    insert into public.course_voe_calendars(course_id, method, start_date, updated_at, updated_by)
    values (p_course, 'manual', v_first, now(), p_actor)
    on conflict (course_id) do update set method = 'manual', start_date = excluded.start_date, updated_at = now(), updated_by = p_actor;
    delete from public.course_voe_units where course_id = p_course;
    insert into public.course_voe_units(course_id, cycle, unit_id, sort, rates, start_date, end_date)
    select p_course, 1, x->>'unitId', row_number() over (order by x->>'start', x->>'unitId'), array[20]::numeric[],
           (x->>'start')::date, (x->>'end')::date
      from jsonb_array_elements(v_rows) x;
  end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'master', v_key, case when p_kind = 'coe' then 'public.course_coe_timetables' else 'public.course_voe_calendars' end,
    p_course, jsonb_build_object('class', p_class, 'kind', p_kind, 'start', v_first, 'end', v_last, 'units', v_rows));
  -- Every open class of this kind follows the calendar (Skyline's own path); its planned classes from today on are laid out again.
  for r in select ci.id from public.course_intakes ci where ci.course_id = p_course and coalesce(ci.status, 'open') <> 'closed'
             and (case when lower(coalesce(ci.study_load, 'coe')) = 'voe' then 'voe' else 'coe' end) = p_kind loop
    perform public.course_master_apply_intake(r.id);
    if exists (select 1 from public.intake_class_times s where s.intake_id = r.id) then
      begin
        perform public.course_master_classes(r.id);
      exception when others then
        raise warning 'axcelerate_class_calendar: classes of intake % not planned again: %', r.id, sqlerrm;
      end;
    end if;
  end loop;
  perform set_config('rto.auto_place', v_was, true);
  return null;
end $$;

/** Mon-Fri 9:00-13:00 for an imported class (CoE or VoE) without class times, and its classes on its unit dates. Returns a warning, or null. */
create or replace function public.axcelerate_class_timetable(p_intake uuid, p_trainer uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public, hr as $$
declare i public.course_intakes; v_room uuid; v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  select * into i from public.course_intakes where id = p_intake;
  if i.id is null or coalesce(i.status, 'open') = 'closed' then return null; end if;
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

/** One aXcelerate class: as 20261128101517, but CoE only for a course with a CRICOS code, and the calendar of its kind (CoE master or VoE
 * calendar) is built from aXcelerate's unit dates. */
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
  -- The calendar of the class's kind (CoE master or VoE calendar) from aXcelerate's unit dates, then its weekly timetable and classes.
  v_w := public.axcelerate_class_calendar(p_connection, p_run, p_actor, p_course, v_ax, p_units,
           case when lower(coalesce((select study_load from public.course_intakes where id = v_id), 'voe')) = 'coe' then 'coe' else 'voe' end);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  v_w := public.axcelerate_class_timetable(v_id, p_trainer, p_actor);
  if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  perform set_config('rto.auto_place', v_was, true);
  return public.axcelerate_outcome(case when l.id is null then 'created' else 'updated' end, v_id::text,
    jsonb_build_object('units', n_units, 'warnings', v_warn));
end $$;

/** The course's CRICOS code from the CRICOS register (looked up by the import on data.gov.au for the provider's code): set when the course
 * has none. Returns set | unchanged | kept (Skyline has another code) | invalid. */
create or replace function public.axcelerate_course_cricos(p_course text, p_cricos text, p_actor uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text := upper(btrim(coalesce(p_cricos, ''))); c record;
begin
  perform public.axcelerate_importing(p_actor);
  if v_code !~ '^[0-9]{6}[A-Z]$' then return 'invalid'; end if;
  select id, cricos_course_code, nullif(btrim(coalesce(cricos, '')), '') as cricos into c from public.cms_courses where id = p_course;
  if c.id is null then raise exception 'Course not found' using errcode = 'P0002'; end if;
  if c.cricos_course_code = v_code or upper(c.cricos) = v_code then return 'unchanged'; end if;
  if c.cricos_course_code is not null or c.cricos is not null then return 'kept'; end if;
  update public.cms_courses set cricos_course_code = v_code, updated_at = now() where id = p_course;
  return 'set';
end $$;

revoke all on function public.axcelerate_class_calendar(uuid, uuid, uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.axcelerate_course_cricos(text, text, uuid) from public, anon, authenticated;
grant execute on function public.axcelerate_class_calendar(uuid, uuid, uuid, text, text, jsonb, text), public.axcelerate_course_cricos(text, text, uuid) to service_role;

commit;
