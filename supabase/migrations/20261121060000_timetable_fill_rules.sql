-- TIMETABLE-FILL-RULES (2026-11-21): the two numbers the daily timetable's automatic fill still had typed into the screen become Business Rules,
-- added live at the value the screen used (Administration › Business Rules): how long one class is, and the usual start times.
-- Everything else the fill reads is already a rule (CoE / VoE weekly hours, days a week, hours a day cap, earliest and latest times, trainer
-- availability fallback, unit hours split). Additive.
select public.business_rule_add_setting('lms.class_block_hours', 'Class length when the weekly classes fill themselves', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'number', '4'::jsonb, '{"min":1,"max":8}'::jsonb,
  'The daily timetable fills the week in classes of this many hours (shorter ones only to fill the last hours or when this does not fit).');
select public.business_rule_add_setting('lms.class_preferred_start_times', 'Usual class start times', 'Intakes & Scheduling',
  'lms/intakes', 'intake', 'json', '{"first":"09:00","second":"14:00"}'::jsonb, '{"keys":["first","second"]}'::jsonb,
  'The daily timetable tries these start times first (HH:MM, on the hour or half hour), then every half hour between the earliest and latest class times.');
