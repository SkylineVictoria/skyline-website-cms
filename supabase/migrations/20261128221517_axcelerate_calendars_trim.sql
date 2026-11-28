-- TIMETABLE-TIDY (owner 2026-11-28: "under timetable I see tons of garbage calendars, remove all garbage"; chosen: future master cycles and
-- the placeholder room). Replaces the 10-cycle rule of AXCELERATE-CALENDARS-10:
--   * axcelerate_course_calendars builds the cycles from the earliest one within the last 12 months to the one after aXcelerate's class
--     (current and next), not 10 cycles to 2035; the CoE master only for a course on the CRICOS register (cms_courses.cricos /
--     cricos_course_code), a VoE-only course loses the CoE master the import made (unless it was changed in Skyline).
--   * axcelerate_placeholder_rooms_cleanup(): the import's "aXcelerate import (set room)" placeholder rooms that nothing uses any more are
--     removed; axcelerate_import_unit_results runs it after the class days have put aXcelerate's own rooms in place.
--   * Existing data: the cycles after the next one and the CoE master of a non-CRICOS imported course go; unused placeholder rooms go.
begin;

do $$
declare d text := pg_get_functiondef('public.axcelerate_course_calendars(uuid, uuid, uuid, text, text, jsonb)'::regprocedure);
  a text; b text; n integer;
begin
  for a, b, n in select * from (values
    ('  v_was text := coalesce(current_setting(''rto.auto_place'', true), '''');
begin',
     '  v_was text := coalesce(current_setting(''rto.auto_place'', true), '''');
  v_cricos boolean := exists (select 1 from public.cms_courses cc where cc.id = p_course
                                and coalesce(nullif(btrim(cc.cricos), ''''), nullif(btrim(cc.cricos_course_code), '''')) is not null);
begin', 1),
    -- rule-policy: technical timetable-tidy 2026-11-28 owner (TIMETABLE-TIDY): the import's calendars run to the cycle after aXcelerate's class; fixed, no configurable value.
    ('for c in 1..10 loop', 'for c in 1..(k + 2) loop', 1),
    ('p_actor, 10)', 'p_actor, k + 2)', 2),
    ('cycles_planned = 10', 'cycles_planned = k + 2', 2),
    ('''cycles'', 10', '''cycles'', k + 2', 1),
    ('  if not v_keep_coe then
    delete from public.course_coe_units where course_id = p_course;',
     '  if not v_keep_coe and not v_cricos then
    -- A course that is not on the CRICOS register has no CoE master (TIMETABLE-TIDY).
    delete from public.course_coe_units where course_id = p_course;
    delete from public.course_coe_timetables where course_id = p_course;
  elsif not v_keep_coe then
    delete from public.course_coe_units where course_id = p_course;', 1)) v(a, b, n)
  loop
    if (length(d) - length(replace(d, a, ''))) / length(a) <> n then raise exception 'axcelerate_course_calendars: anchor "%" not found % time(s)', left(a, 40), n; end if;
    d := replace(d, a, b);
  end loop;
  execute d;
end $$;

create or replace function public.axcelerate_placeholder_rooms_cleanup()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.classrooms c
   where c.name = 'aXcelerate import (set room)'
     and not exists (select 1 from public.class_sessions x where x.room_id = c.id)
     and not exists (select 1 from public.intake_class_times x where x.room_id = c.id)
     and not exists (select 1 from public.intake_batches x where x.room_id = c.id)
     and not exists (select 1 from public.course_intakes x where x.classroom_id = c.id)
     -- rule-policy: technical timetable-tidy 2026-11-28 owner (TIMETABLE-TIDY): a placeholder room is removed only when nothing references it; fixed, no configurable value.
     and not exists (select 1 from public.course_class_defaults x where x.classroom_id = c.id)
     and not exists (select 1 from public.asm_schedule_events x where x.room_id = c.id)
     and not exists (select 1 from public.prereq_classes x where x.room_id = c.id)
     and not exists (select 1 from public.prereq_class_times x where x.room_id = c.id)
     and not exists (select 1 from public.booking_availability x where x.room_id = c.id)
     and not exists (select 1 from public.booking_time_off x where x.room_id = c.id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.axcelerate_placeholder_rooms_cleanup() from public, anon, authenticated;

do $$
declare d text := pg_get_functiondef('public.axcelerate_import_unit_results(uuid, uuid, uuid, uuid, jsonb)'::regprocedure); a text;
begin
  a := '  -- Batches that got unit dates from the workshops get their weekly class times and classes.';
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'axcelerate_import_unit_results: rooms anchor not found once'; end if;
  d := replace(d, a, '  -- The import''s placeholder rooms nothing uses any more go (TIMETABLE-TIDY).
  perform public.axcelerate_placeholder_rooms_cleanup();
' || a);
  execute d;
end $$;

-- Existing data: imported courses keep their cycles up to the one after aXcelerate's class; a non-CRICOS course loses the import's CoE master.
do $$
declare r record; v_was text := coalesce(current_setting('rto.auto_place', true), '');
begin
  perform set_config('rto.auto_place', 'on', true);
  for r in select distinct on (l.target_id) l.target_id as course_id, coalesce((l.raw->>'axcelerateCycle')::integer, 1) + 1 as keep_to,
                  exists (select 1 from public.cms_courses cc where cc.id = l.target_id
                            and coalesce(nullif(btrim(cc.cricos), ''), nullif(btrim(cc.cricos_course_code), '')) is not null) as cricos
             from public.axcelerate_links l
            where l.entity = 'master' and l.axcelerate_id like 'all:%'
            order by l.target_id, l.last_imported_at desc loop
    delete from public.course_voe_units where course_id = r.course_id and cycle > r.keep_to;
    update public.course_voe_calendars set cycles_planned = least(cycles_planned, r.keep_to) where course_id = r.course_id;
    if r.cricos then
      delete from public.course_coe_units where course_id = r.course_id and cycle > r.keep_to;
      update public.course_coe_timetables set cycles_planned = least(cycles_planned, r.keep_to) where course_id = r.course_id;
    else
      delete from public.course_coe_units where course_id = r.course_id;
      delete from public.course_coe_timetables where course_id = r.course_id;
    end if;
  end loop;
  perform set_config('rto.auto_place', v_was, true);
  perform public.axcelerate_placeholder_rooms_cleanup();
end $$;

commit;
