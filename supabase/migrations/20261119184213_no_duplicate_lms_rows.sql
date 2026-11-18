-- NO-DUPLICATES (owner, 2026-11-19): the database refuses duplicate LMS / timetable rows, whatever screen or job saves them.
-- Checked on hosted first: none of these duplicates exist, so every rule applies cleanly.
--   * a unit once per intake                              intake_units (intake_id, unit_id)
--   * one class per batch per weekday and start time      batch_sessions (batch_id, weekday, start_time)
--   * one Prerequisite class time per weekday and start   prereq_class_times (class_id, weekday, start_time)
--   * course code once (any case / spaces)                cms_courses (tenant_id, upper(trim(code)))
--   * unit code once per course (any case / spaces)       cms_course_units (course_id, upper(trim(code)))
--   * intake name once per course (blank names allowed)   course_intakes (course_id, lower(trim(name)))
--   * batch name once per intake (any case)               batches (intake_id, lower(trim(name)))
--   * location name once, room name once per location     locations / classrooms
--   * fee line label once per course / intake             course_fee_items (course_id, intake_id, lower(trim(label)))
-- Plain-column rules are deferrable (checked at commit) so a save that reorders rows inside one transaction still works.
-- Additive. Rollback (manual): drop the constraints / indexes named below.
begin;

alter table public.intake_units add constraint intake_units_no_duplicate_unit
  unique (intake_id, unit_id) deferrable initially deferred;
alter table public.batch_sessions add constraint batch_sessions_no_duplicate_time
  unique (batch_id, weekday, start_time) deferrable initially deferred;
alter table public.prereq_class_times add constraint prereq_class_times_no_duplicate_time
  unique (class_id, weekday, start_time) deferrable initially deferred;

create unique index if not exists cms_courses_code_no_duplicate on public.cms_courses
  (tenant_id, upper(btrim(code))) nulls not distinct where coalesce(btrim(code), '') <> '';
create unique index if not exists cms_course_units_code_no_duplicate on public.cms_course_units
  (course_id, upper(btrim(code))) where btrim(code) <> '';
create unique index if not exists course_intakes_name_no_duplicate on public.course_intakes
  (course_id, lower(btrim(name))) where coalesce(btrim(name), '') <> '';
create unique index if not exists batches_name_no_duplicate on public.batches (intake_id, lower(btrim(name)));
create unique index if not exists locations_name_no_duplicate on public.locations (lower(btrim(name)));
create unique index if not exists classrooms_name_no_duplicate on public.classrooms
  (location_id, lower(btrim(name))) nulls not distinct;
create unique index if not exists course_fee_items_label_no_duplicate on public.course_fee_items
  (course_id, intake_id, lower(btrim(label))) nulls not distinct;

commit;
