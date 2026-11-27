-- APPLICATION-COURSE-EMPTY (owner 2026-11-27: "a new application is for changing course and intake"; chosen: always start empty).
-- A student's second application showed the course and intake of the first: application_values / application_data merge the
-- student's saved answers (enrollment_students.details) over the application's, and details still held course / intake keys
-- written before STUDENT-OWNS-ANSWERS (20261127140517) made them application answers.
--   * application_values / application_data: course and intake answers never come from the student record (courses_of_interest,
--     preferred_intake, intake_note, course_*, intake_*); every other student answer merges as before;
--   * enrollment_students.details: those keys are removed (they belong to each application; applications keep their own).
-- Down: re-run the two functions from 20261104120000_student_details_on_student.sql (the removed keys are not restored).
begin;

create or replace function public.application_course_key(p_key text) returns boolean
language sql immutable parallel safe set search_path = '' as $fn$
  select p_key in ('courses_of_interest', 'preferred_intake', 'intake_note') or p_key like any (array['course\_%', 'intake\_%']);
$fn$;
comment on function public.application_course_key(text) is
  'APPLICATION-COURSE-EMPTY: course and intake answers, which belong to one application and never come from the student record.';

create or replace function public.application_values(p_application uuid) returns jsonb
language sql stable security definer set search_path = '' as $fn$
 select coalesce(a.data -> 'values', '{}'::jsonb)
   || coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(coalesce(s.details, '{}'::jsonb)) e
                 where not public.application_course_key(e.key)), '{}'::jsonb)
 from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id where a.id = p_application;
$fn$;

create or replace function public.application_data(p_application uuid) returns jsonb
language sql stable security definer set search_path = '' as $fn$
 select jsonb_set(coalesce(a.data, '{}'::jsonb) || jsonb_build_object('academicQualifications', coalesce(a.data -> 'academicQualifications', s.qualifications, '[]'::jsonb)),
  '{values}', coalesce(a.data -> 'values', '{}'::jsonb)
    || coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(coalesce(s.details, '{}'::jsonb)) e
                  where not public.application_course_key(e.key)), '{}'::jsonb), true)
 from public.enrollment_applications a left join public.enrollment_students s on s.id = a.student_id where a.id = p_application;
$fn$;
revoke all on function public.application_values(uuid), public.application_data(uuid) from public, anon, authenticated;

-- The course / intake keys left on student records (applications keep their own copies).
update public.enrollment_students s
   set details = (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(s.details) e
                   where not public.application_course_key(e.key))
 where jsonb_typeof(s.details) = 'object'
   and exists (select 1 from jsonb_object_keys(s.details) k where public.application_course_key(k));

commit;
