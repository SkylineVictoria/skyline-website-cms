-- AXCELERATE-CALENDARS-10-AGAIN (owner 2026-11-28: "I don't see start date in CoE master calendar; as discussed we have start date in
-- the past with auto 10 cycles for CoE and VoE to generate both master calendars"). Undoes the cycle trim of TIMETABLE-TIDY
-- (20261128221517): axcelerate_course_calendars again builds both the CoE master and the VoE calendar of every imported course, 10 cycles,
-- starting in the past (aXcelerate's class cycle and the earlier cycles that start within the last 12 months). The placeholder-room
-- clean-up of TIMETABLE-TIDY stays. Existing data: each imported course's calendars are built again from the last import's unit dates.
begin;

do $$
declare d text := pg_get_functiondef('public.axcelerate_course_calendars(uuid, uuid, uuid, text, text, jsonb)'::regprocedure);
  a text; b text; n integer;
begin
  for a, b, n in select * from (values
    -- rule-policy: technical axcelerate-calendars-10 2026-11-28 owner (AXCELERATE-CALENDARS-10-AGAIN): the import builds 10 cycles of both calendars; fixed, no configurable value.
    ('for c in 1..(k + 2) loop', 'for c in 1..10 loop', 1),
    ('p_actor, k + 2)', 'p_actor, 10)', 2),
    ('cycles_planned = k + 2', 'cycles_planned = 10', 2),
    ('''cycles'', k + 2', '''cycles'', 10', 1),
    ('  if not v_keep_coe and not v_cricos then
    -- A course that is not on the CRICOS register has no CoE master (TIMETABLE-TIDY).
    delete from public.course_coe_units where course_id = p_course;
    delete from public.course_coe_timetables where course_id = p_course;
  elsif not v_keep_coe then', '  if not v_keep_coe then', 1)) v(a, b, n)
  loop
    if (length(d) - length(replace(d, a, ''))) / length(a) <> n then raise exception 'axcelerate_course_calendars: anchor "%" not found % time(s)', left(a, 40), n; end if;
    d := replace(d, a, b);
  end loop;
  execute d;
end $$;

-- Existing data: both calendars of each imported course again, from the last import's unit dates.
do $$
declare r record;
begin
  for r in select distinct on (l.target_id) l.connection_id, l.target_id as course_id, l.raw->>'class' as class, l.raw->'units' as units
             from public.axcelerate_links l
            where l.entity = 'master' and l.axcelerate_id like 'all:%' and jsonb_typeof(l.raw->'units') = 'array'
            order by l.target_id, l.last_imported_at desc loop
    perform public.axcelerate_course_calendars(r.connection_id, null, null, r.course_id, r.class, r.units);
  end loop;
end $$;

commit;
