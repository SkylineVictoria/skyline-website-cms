-- LMS-BATCHES step 5 (2026-11-25, owner: rename now, test phase): the CoE Master tables are named like the VoE ones —
-- course_master_timetables -> course_coe_timetables, course_master_units -> course_coe_units (their indexes and constraints follow);
-- every function that named the old tables is rewritten to the new names (functions keep their own names, e.g. rto_master_timetable).
-- The VoE Master gets the same shape as CoE: course_voe_units.cycle (default 1), an id key and unique (course_id, cycle, unit_id);
-- course_voe_calendars.cycles_planned (default 1). The VoE calendar editor keeps writing cycle 1.
-- Down: rename the two tables / their indexes back and re-run the same rewrite with the names swapped; drop course_voe_units.id / cycle
--       (restore primary key (course_id, unit_id)) and course_voe_calendars.cycles_planned.
begin;

alter table public.course_master_timetables rename to course_coe_timetables;
alter table public.course_master_units rename to course_coe_units;
alter index public.course_master_timetables_pkey rename to course_coe_timetables_pkey;
alter index public.course_master_units_pkey rename to course_coe_units_pkey;
alter index public.course_master_units_course_id_cycle_unit_id_key rename to course_coe_units_course_id_cycle_unit_id_key;
alter index public.course_master_units_order_idx rename to course_coe_units_order_idx;
alter table public.course_coe_timetables rename constraint course_master_timetables_cycles_planned_range to course_coe_timetables_cycles_planned_range;
alter table public.course_coe_timetables rename constraint course_master_timetables_course_id_fkey to course_coe_timetables_course_id_fkey;
alter table public.course_coe_units rename constraint course_master_units_course_id_fkey to course_coe_units_course_id_fkey;
alter table public.course_coe_units rename constraint course_master_units_unit_id_fkey to course_coe_units_unit_id_fkey;
alter table public.course_coe_units rename constraint course_master_units_cycle_check to course_coe_units_cycle_check;
alter table public.course_coe_units rename constraint course_master_units_weeks_check to course_coe_units_weeks_check;
alter table public.course_coe_units rename constraint course_master_units_check to course_coe_units_check;

do $$
declare f record; n int := 0;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
             and pg_get_functiondef(p.oid) ~ '\mcourse_master_(timetables|units)\M' loop
    execute regexp_replace(pg_get_functiondef(f.oid), '\mcourse_master_(timetables|units)\M', 'course_coe_\1', 'g');
    n := n + 1;
  end loop;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and pg_get_functiondef(p.oid) ~ '\mcourse_master_(timetables|units)\M') then
    raise exception 'A function still names course_master_*';
  end if;
  raise notice 'rewrote % functions', n;
end $$;

-- VoE Master shaped like CoE.
alter table public.course_voe_units add column id uuid not null default gen_random_uuid(), add column cycle integer not null default 1;
alter table public.course_voe_units add constraint course_voe_units_cycle_check check (cycle >= 1);
alter table public.course_voe_units drop constraint course_voe_units_pkey;
alter table public.course_voe_units add primary key (id);
alter table public.course_voe_units add constraint course_voe_units_course_id_cycle_unit_id_key unique (course_id, cycle, unit_id);
create index course_voe_units_order_idx on public.course_voe_units (course_id, cycle, sort);
alter table public.course_voe_calendars add column cycles_planned integer not null default 1;
alter table public.course_voe_calendars add constraint course_voe_calendars_cycles_planned_range check (cycles_planned between 1 and 60);

-- The VoE calendar editor rewrites cycle 1 only (later cycles are kept).
do $$
declare d text;
begin
  d := pg_get_functiondef('public.rto_voe_calendar'::regproc);
  if d !~ 'course_voe_units where course_id = v_course' then raise exception 'rto_voe_calendar: delete not found'; end if;
  execute replace(d, 'course_voe_units where course_id = v_course', 'course_voe_units where course_id = v_course and cycle = 1');
end $$;

commit;
