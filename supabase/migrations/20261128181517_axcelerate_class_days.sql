-- AXCELERATE-CLASS-DAYS (owner 2026-11-28: "CoE weekly and VoE weekly calendar start date came wrong so data is off; daily calendars
-- didn't get populated with teacher and room"; decisions: aXcelerate's actual class days; aXcelerate's rooms are created as new
-- Skyline rooms, never matched to current ones; the intake is rolling, no end date).
--   * axcelerate_course_calendars: the calendars start at aXcelerate's class cycle and only go further back by whole cycles that still
--     start within the last 12 months (the 12-month rule added an invented cycle before aXcelerate's: Dec 2024). Batches made for a
--     calendar cycle (C<n>) keep the number of the cycle they run in when the calendars are rebuilt.
--   * Every aXcelerate class day of a unit (its workshop's dates: date, start and end time, room, trainer) is a class of the batch
--     (axcelerate_unit_days; linked as 'class_day', kept as hand-set classes so Skyline's generator leaves them), replacing the
--     classes Skyline generated on those dates. aXcelerate rooms become Skyline rooms "aXcelerate room <id>" at the aXcelerate
--     location (axcelerate_room_for, linked as 'room'); the trainer is the imported trainer.
--   * The batch's weekly class times follow aXcelerate's usual days and times (axcelerate_batch_pattern), when they are still the
--     import's Mon-Fri 9:00-13:00; a batch without aXcelerate class days (a calendar-cycle batch) copies them and its classes are
--     laid out again on them (axcelerate_batch_timetable).
begin;

alter table public.axcelerate_links drop constraint axcelerate_links_entity_check;
alter table public.axcelerate_links add constraint axcelerate_links_entity_check check (entity = any (array['location', 'course', 'unit', 'trainer',
  'class', 'class_unit', 'break', 'student', 'agent', 'agency', 'qualification', 'master', 'unit_result', 'batch', 'invoice', 'course_fee',
  'attendance', 'room', 'class_day']));

-- 1. Calendars: from aXcelerate's cycle, earlier cycles only when they start within the last 12 months; cycle batches renumbered.
do $$
declare d text := pg_get_functiondef('public.axcelerate_course_calendars(uuid, uuid, uuid, text, text, jsonb)'::regprocedure); a text;
begin
  a := 'while v_c1 > (v_today - interval ''12 months'')::date and k < 9 loop';
  if position(a in d) = 0 then raise exception 'axcelerate_course_calendars: loop anchor not found'; end if;
  d := replace(d, a, 'while (v_c1 - v_span) >= (v_today - interval ''12 months'')::date and k < 9 loop');
  a := '  perform public.axcelerate_link_save(p_connection, p_run, ''master'', v_key,';
  if position(a in d) = 0 then raise exception 'axcelerate_course_calendars: link anchor not found'; end if;
  d := replace(d, a, '  -- Calendar-cycle batches (C<n>) keep the number of the cycle they run in.
  for r in select x.id as link_id, x.axcelerate_id as ax, b.id as batch_id, b.intake_id, b.code, b.start_date from public.axcelerate_links x
             join public.intake_batches b on b.id::text = x.target_id
            where x.connection_id = p_connection and x.entity = ''batch'' and x.axcelerate_id like ''cycle:'' || p_course || '':%'' and b.start_date is not null loop
    c := (select z.cycle from (select cycle, min(start_date) as f, max(end_date) as l from axcelerate_calendar_rows group by cycle) z
           where r.start_date between z.f and z.l order by z.cycle limit 1);
    if c is not null and r.ax <> regexp_replace(r.ax, ''[0-9]+$'', '''') || c
       and not exists (select 1 from public.axcelerate_links y where y.connection_id = p_connection and y.entity = ''batch''
                        and y.axcelerate_id = regexp_replace(r.ax, ''[0-9]+$'', '''') || c) then
      update public.axcelerate_links set axcelerate_id = regexp_replace(r.ax, ''[0-9]+$'', '''') || c where id = r.link_id;
      if r.code ~ ''^C[0-9]+$'' and not exists (select 1 from public.intake_batches z where z.intake_id = r.intake_id and lower(z.code) = lower(''C'' || c)) then
        update public.intake_batches set code = ''C'' || c, name = regexp_replace(coalesce(name, ''''), ''C[0-9]+$'', ''C'' || c), updated_at = now() where id = r.batch_id;
      end if;
    end if;
  end loop;
' || a);
  execute d;
end $$;

-- 2. Rooms: an aXcelerate room is a Skyline room "aXcelerate room <id>" at the aXcelerate location (created once, then linked).
create or replace function public.axcelerate_room_for(p_connection uuid, p_run uuid, p_actor uuid, p_room text, p_location text)
returns uuid language plpgsql security definer set search_path = public as $$
declare l public.axcelerate_links; v_id uuid; v_loc uuid; v_name text;
begin
  if nullif(btrim(coalesce(p_room, '')), '') is null then return null; end if;
  l := public.axcelerate_link_find(p_connection, 'room', p_room);
  if l.id is not null then
    select id into v_id from public.classrooms where id::text = l.target_id;
    if v_id is not null then return v_id; end if;
  end if;
  select id into v_loc from public.locations where name = p_location order by created_at limit 1;
  v_name := left('aXcelerate room ' || p_room, 120);
  select id into v_id from public.classrooms where name = v_name and location_id is not distinct from v_loc order by created_at limit 1;
  if v_id is null then
    insert into public.classrooms(name, campus, location_id, is_active) values (v_name, p_location, v_loc, true) returning id into v_id;
  end if;
  perform public.axcelerate_link_save(p_connection, p_run, 'room', p_room, 'public.classrooms', v_id::text,
    jsonb_build_object('ROOMID', p_room, 'LOCATION', p_location));
  return v_id;
end $$;

-- 3. A unit's aXcelerate class days as classes of the batch (replacing Skyline's generated classes on those dates). Returns how many.
create or replace function public.axcelerate_unit_days(p_connection uuid, p_run uuid, p_actor uuid, p_batch uuid, p_unit text, p_workshop jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare b public.intake_batches; d jsonb; v_date date; v_st time; v_en time; v_room uuid; v_tr uuid; v_key text; l public.axcelerate_links; v_id uuid;
  n integer := 0; v_first date; v_last date; v_campus text; v_last_room uuid; v_last_tr uuid; v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  select * into b from public.intake_batches where id = p_batch;
  if b.id is null or p_unit is null or jsonb_typeof(p_workshop->'COMPLEXDATES') is distinct from 'array' then return 0; end if;
  select min(public.axcelerate_date(x->>'DATE')), max(public.axcelerate_date(x->>'DATE')) into v_first, v_last
    from jsonb_array_elements(p_workshop->'COMPLEXDATES') x;
  if v_first is null then return 0; end if;
  select campus into v_campus from public.course_intakes where id = b.intake_id;
  perform set_config('rto.auto_place', 'on', true);
  -- Skyline's generated classes of the batch on those dates make way for aXcelerate's.
  delete from public.class_sessions s where s.batch_id = p_batch and not coalesce(s.is_manual, false) and s.session_date between v_first and v_last;
  for d in select value from jsonb_array_elements(p_workshop->'COMPLEXDATES') loop
    begin
      v_date := public.axcelerate_date(d->>'DATE');
      v_st := nullif(btrim(coalesce(d->>'STARTTIME', '')), '')::time;
      v_en := nullif(btrim(coalesce(d->>'ENDTIME', '')), '')::time;
      if v_date is null or v_st is null or v_en is null or v_en <= v_st then continue; end if;
      v_room := public.axcelerate_room_for(p_connection, p_run, p_actor, d->>'ROOMID', coalesce(nullif(btrim(coalesce(d->>'LOCATION', '')), ''), v_campus));
      v_tr := null;
      select target_id::uuid into v_tr from public.axcelerate_links
       where connection_id = p_connection and entity = 'trainer' and axcelerate_id = coalesce(d->>'TRAINERCONTACTID', d#>>'{TRAINERS,0,TRAINERCONTACTID}') limit 1;
      v_key := coalesce(nullif(d->>'COMPLEXID', ''), p_batch::text || ':' || p_unit || ':' || v_date || ':' || v_st);
      l := public.axcelerate_link_find(p_connection, 'class_day', v_key);
      v_id := null;
      if l.id is not null then select id into v_id from public.class_sessions where id::text = l.target_id; end if;
      if v_id is not null then
        update public.class_sessions
           set session_date = v_date, start_time = v_st, end_time = v_en, room_id = coalesce(v_room, room_id), trainer_id = coalesce(v_tr, trainer_id),
               unit_id = p_unit, batch_id = p_batch, intake_id = b.intake_id, is_manual = true, updated_at = now()
         where id = v_id;
      else
        insert into public.class_sessions(batch_id, intake_id, session_date, start_time, end_time, session_type, room_id, unit_id, trainer_id, is_manual)
        values (p_batch, b.intake_id, v_date, v_st, v_en, 'theory', v_room, p_unit, v_tr, true) returning id into v_id;
      end if;
      perform public.axcelerate_link_save(p_connection, p_run, 'class_day', v_key, 'public.class_sessions', v_id::text, d);
      v_last_room := coalesce(v_room, v_last_room); v_last_tr := coalesce(v_tr, v_last_tr);
      n := n + 1;
    exception when others then
      null; -- a day that clashes or cannot be read is left out (the import reports the count)
    end;
  end loop;
  -- The batch's room and trainer are aXcelerate's (instead of the import's placeholder room).
  update public.intake_batches
     set room_id = case when room_id is null or room_id in (select id from public.classrooms where name = 'aXcelerate import (set room)') then coalesce(v_last_room, room_id) else room_id end,
         default_trainer_id = coalesce(default_trainer_id, v_last_tr), updated_at = now()
   where id = p_batch;
  update public.course_intakes set classroom_id = v_last_room
   where id = b.intake_id and v_last_room is not null and classroom_id in (select id from public.classrooms where name = 'aXcelerate import (set room)');
  perform set_config('rto.auto_place', v_was, true);
  return n;
end $$;

-- 4. The batch's weekly class times from its aXcelerate class days (the days and times used at least 3 times; overlapping times on a
--    day keep the most used), when they are still the import's Mon-Fri 9:00-13:00. Its other (generated) classes are laid out on them.
create or replace function public.axcelerate_batch_pattern(p_batch uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public, hr as $$
declare b public.intake_batches; v_p text; v_was text := coalesce(current_setting('rto.auto_place', true), '');
  v_gen text := coalesce(current_setting('lms.gen_batch', true), ''); u record; ct record; v_left numeric; v_day date;
begin
  select * into b from public.intake_batches where id = p_batch;
  if b.id is null then return null; end if;
  if exists (select 1 from public.intake_class_times t where t.batch_id = p_batch and not (t.start_time = time '09:00' and t.end_time = time '13:00')) then return null; end if;
  create temp table if not exists axcelerate_pattern (weekday integer, start_time time, end_time time, n integer, room uuid, trainer uuid) on commit drop;
  truncate axcelerate_pattern;
  insert into axcelerate_pattern
  select extract(isodow from s.session_date)::integer, s.start_time, s.end_time, count(*)::integer,
         mode() within group (order by s.room_id), mode() within group (order by s.trainer_id)
    from public.class_sessions s join public.axcelerate_links x on x.entity = 'class_day' and x.target_id = s.id::text
   where s.batch_id = p_batch and s.status <> 'cancelled'
   group by 1, 2, 3 having count(*) >= 3;
  delete from axcelerate_pattern a where exists (select 1 from axcelerate_pattern o where o.weekday = a.weekday
     and (o.n > a.n or (o.n = a.n and o.start_time < a.start_time)) and o.start_time < a.end_time and a.start_time < o.end_time);
  if not exists (select 1 from axcelerate_pattern) then return null; end if;
  begin
    perform set_config('rto.auto_place', 'on', true);
    delete from public.intake_class_times where batch_id = p_batch;
    insert into public.intake_class_times(intake_id, batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort, trainer_id)
    select b.intake_id, p_batch, a.weekday,
           case when a.start_time < time '12:00' then 'morning' when a.start_time < time '16:00' then 'afternoon' else 'evening' end,
           a.start_time, a.end_time, 'theory', coalesce(a.room, b.room_id), (row_number() over (order by a.weekday, a.start_time))::integer,
           coalesce(a.trainer, b.default_trainer_id)
      from axcelerate_pattern a;
    v_p := public.course_master_group_problem(b.intake_id);
    if v_p is not null then raise exception '%', v_p using errcode = '23514'; end if;
    -- Skyline's generated classes of the batch are laid out again on these days and times: each unit without aXcelerate class days
    -- from its start until its hours are used (term breaks and holidays skipped).
    perform set_config('rto.course', (select course_id from public.course_intakes where id = b.intake_id), true);
    delete from public.class_sessions where batch_id = p_batch and not coalesce(is_manual, false);
    for u in select bu.unit_id, bu.start_date, bu.end_date, coalesce(cu.slit_hours, cu.nominal_hours, 0)::numeric as hours
               from public.intake_batch_units bu join public.cms_course_units cu on cu.id = bu.unit_id
              where bu.batch_id = p_batch and not exists (select 1 from public.class_sessions s where s.batch_id = p_batch and s.unit_id = bu.unit_id)
              order by bu.start_date loop
      v_left := u.hours; v_day := u.start_date;
      while v_left > 0 and v_day <= u.end_date loop
        if public.rto_is_teaching_day(v_day) then
          for ct in select * from public.intake_class_times where batch_id = p_batch and weekday = extract(isodow from v_day)::integer order by start_time loop
            exit when v_left <= 0;
            begin
              insert into public.class_sessions(batch_id, intake_id, session_date, start_time, end_time, session_type, room_id, unit_id, trainer_id)
              values (p_batch, b.intake_id, v_day, ct.start_time, ct.end_time, ct.session_type, ct.room_id, u.unit_id, ct.trainer_id);
              v_left := v_left - extract(epoch from (ct.end_time - ct.start_time)) / 3600.0;
            exception when others then
              null; -- a clash is left out
            end;
          end loop;
        end if;
        v_day := v_day + 1;
      end loop;
    end loop;
    perform set_config('rto.course', '', true);
    perform set_config('rto.auto_place', v_was, true);
    return null;
  exception when others then
    perform set_config('lms.gen_batch', v_gen, true);
    perform set_config('rto.auto_place', v_was, true);
    return format('Batch %s: aXcelerate''s weekly days and times were not set: %s', b.code, sqlerrm);
  end;
end $$;

-- 5. A batch's weekly class times and classes: a batch without aXcelerate class days copies the weekly times of the batch of the
--    intake that has them (aXcelerate's pattern) while its own are none or the import's Mon-Fri 9:00-13:00 (its generated classes are
--    laid out again on them); else Mon-Fri 9:00-13:00 when it has none. Then its classes on its own unit dates.
create or replace function public.axcelerate_batch_timetable(p_batch uuid, p_trainer uuid, p_actor uuid)
returns text language plpgsql security definer set search_path = public, hr as $$
declare b public.intake_batches; v_room uuid; v_src uuid; v_default boolean; v_days boolean;
  v_was text := coalesce(current_setting('rto.auto_place', true), ''); v_gen text := coalesce(current_setting('lms.gen_batch', true), '');
begin
  select * into b from public.intake_batches where id = p_batch;
  if b.id is null then return null; end if;
  v_days := exists (select 1 from public.class_sessions s join public.axcelerate_links x on x.entity = 'class_day' and x.target_id = s.id::text where s.batch_id = p_batch);
  v_default := not exists (select 1 from public.intake_class_times t where t.batch_id = p_batch and not (t.start_time = time '09:00' and t.end_time = time '13:00'));
  select x.id into v_src from public.intake_batches x
   where x.intake_id = b.intake_id and x.id <> p_batch and x.archived_at is null
     and exists (select 1 from public.class_sessions s join public.axcelerate_links l on l.entity = 'class_day' and l.target_id = s.id::text where s.batch_id = x.id)
     and exists (select 1 from public.intake_class_times t where t.batch_id = x.id and not (t.start_time = time '09:00' and t.end_time = time '13:00'))
   order by x.start_date desc nulls last limit 1;
  begin
    perform set_config('rto.auto_place', 'on', true);
    if not v_days and v_default and v_src is not null then
      delete from public.intake_class_times where batch_id = p_batch;
      delete from public.class_sessions where batch_id = p_batch and not coalesce(is_manual, false);
      insert into public.intake_class_times(intake_id, batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort, trainer_id)
      select b.intake_id, p_batch, t.weekday, t.slot, t.start_time, t.end_time, t.session_type, t.room_id, t.sort, coalesce(t.trainer_id, p_trainer)
        from public.intake_class_times t where t.batch_id = v_src;
      update public.intake_batches
         set room_id = case when room_id is null or room_id in (select id from public.classrooms where name = 'aXcelerate import (set room)')
                            then (select room_id from public.intake_batches where id = v_src) else room_id end,
             default_trainer_id = coalesce(default_trainer_id, (select default_trainer_id from public.intake_batches where id = v_src))
       where id = p_batch;
    elsif not exists (select 1 from public.intake_class_times where batch_id = p_batch) then
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

-- 6. The unit results import brings each unit's aXcelerate class days, then sets the weekly pattern and the other batches' timetables.
do $$
declare d text := pg_get_functiondef('public.axcelerate_import_unit_results(uuid, uuid, uuid, uuid, jsonb)'::regprocedure); a text;
begin
  a := 'v_touched uuid[] := ''{}''; v_b uuid;';
  if position(a in d) = 0 then raise exception 'axcelerate_import_unit_results: declare anchor not found'; end if;
  d := replace(d, a, 'v_touched uuid[] := ''{}''; v_days uuid[] := ''{}''; v_nd integer; v_b uuid;');
  a := '    if v_out is null then
      v_res := v_res || jsonb_build_object(''code'', v_code, ''action'', ''open''';
  if position(a in d) = 0 then raise exception 'axcelerate_import_unit_results: days anchor not found'; end if;
  d := replace(d, a, '    -- The unit''s aXcelerate class days (date, times, room, trainer) are its classes in the batch.
    if jsonb_typeof(w->''COMPLEXDATES'') = ''array'' then
      v_nd := public.axcelerate_unit_days(p_connection, p_run, p_actor, v_batch, v_unit, w);
      if v_nd > 0 and not v_batch = any(v_days) then v_days := v_days || v_batch; end if;
    end if;
' || a);
  a := '  -- Batches that got unit dates from the workshops get their weekly class times and classes.';
  if position(a in d) = 0 then raise exception 'axcelerate_import_unit_results: pattern anchor not found'; end if;
  d := replace(d, a, '  -- Batches with aXcelerate class days take aXcelerate''s weekly days and times; the intake''s other batches copy them.
  foreach v_b in array v_days loop
    v_w := public.axcelerate_batch_pattern(v_b, p_actor);
    if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  end loop;
  for v_b in select x.id from public.intake_batches x where x.intake_id = i.id and x.archived_at is null and not (x.id = any(v_days)) and not (x.id = any(v_touched)) loop
    v_w := public.axcelerate_batch_timetable(v_b, v_trainer, p_actor);
    if v_w is not null then v_warn := v_warn || to_jsonb(v_w); end if;
  end loop;
' || a);
  execute d;
end $$;

revoke all on function public.axcelerate_room_for(uuid, uuid, uuid, text, text), public.axcelerate_unit_days(uuid, uuid, uuid, uuid, text, jsonb),
  public.axcelerate_batch_pattern(uuid, uuid) from public, anon, authenticated;
grant execute on function public.axcelerate_room_for(uuid, uuid, uuid, text, text), public.axcelerate_unit_days(uuid, uuid, uuid, uuid, text, jsonb),
  public.axcelerate_batch_pattern(uuid, uuid) to service_role;

commit;
