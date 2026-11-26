-- COURSE-BREAKS-PER-COURSE (owner, 2026-11-26): term breaks and public holidays belong to one course, never to every course.
-- 1. The 35 Victorian school breaks saved on 2026-11-20 as "all courses" (course_id null) become a separate copy for every course
--    (owner chose "a separate copy for each": today's dates do not change, and editing / removing one later changes that course only).
-- 2. A term break must name its course (course_id NOT NULL).
-- 3. Public holidays (hr.public_holidays) still close every course by default; a course can switch a holiday off (taught on that day)
--    in public.course_holiday_teaching. rto_is_teaching_day / rto_is_working_day honour it for the course in context (rto.course),
--    as rto_break_on does for breaks. No trigger on academic_breaks, so no classes are re-planned by this migration.

begin;

insert into public.academic_breaks (label, start_date, end_date, course_id, source)
select b.label, b.start_date, b.end_date, c.id, b.source
from public.academic_breaks b cross join public.cms_courses c
where b.course_id is null
  and not exists (select 1 from public.academic_breaks x
                  where x.course_id = c.id and x.start_date <= b.end_date and b.start_date <= x.end_date);

delete from public.academic_breaks where course_id is null;

alter table public.academic_breaks alter column course_id set not null;

create table if not exists public.course_holiday_teaching (
  course_id text not null references public.cms_courses(id) on delete cascade,
  holiday_date date not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (course_id, holiday_date)
);
comment on table public.course_holiday_teaching is
  'A public holiday this course teaches on (switched off for the course). Absent = the holiday closes the course (default).';
alter table public.course_holiday_teaching enable row level security;
drop policy if exists course_holiday_teaching_staff_read on public.course_holiday_teaching;
create policy course_holiday_teaching_staff_read on public.course_holiday_teaching for select using (public.cms_is_staff());
drop policy if exists course_holiday_teaching_rto_write on public.course_holiday_teaching;
create policy course_holiday_teaching_rto_write on public.course_holiday_teaching for all
  using (public.cms_is_rto_manager()) with check (public.cms_is_rto_manager());
grant select, insert, delete on public.course_holiday_teaching to authenticated;

-- A confirmed public holiday that closes classes on p_day for the course in context (rto.course); without a course, as before.
create or replace function public.rto_holiday_on(p_day date)
returns boolean language sql stable security definer set search_path to 'public', 'hr' as $function$
  select exists(select 1 from hr.public_holidays h where h.holiday_date = p_day and h.status = 'confirmed'
      and (not h.is_optional or public.rule_bool('lms.optional_holidays_stop_classes', false)))
    and not exists(select 1 from public.course_holiday_teaching t
      where t.holiday_date = p_day and t.course_id = nullif(current_setting('rto.course', true), ''));
$function$;
revoke all on function public.rto_holiday_on(date) from public, anon;
grant execute on function public.rto_holiday_on(date) to authenticated, service_role;

create or replace function public.rto_is_teaching_day(p_day date)
returns boolean language sql stable security definer set search_path to 'public', 'hr' as $function$
  select not public.rto_holiday_on(p_day) and not public.rto_break_on(p_day);
$function$;

create or replace function public.rto_is_working_day(p_day date)
returns boolean language sql stable security definer set search_path to 'public', 'hr' as $function$
  select extract(isodow from p_day)::integer = any(public.lms_working_isodows())
    and not public.rto_holiday_on(p_day)
    and not public.rto_break_on(p_day);
$function$;

commit;
