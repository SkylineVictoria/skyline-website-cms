-- LMS-BATCHES step 4 (2026-11-25): every intake enrolment has the student's own course start and end dates. When not given they come
-- from the student's units in the intake (first start, last end), else the intake's own dates; end never before start.
-- Down: drop trigger a0_course_dates on public.intake_enrolments; drop function public.intake_enrolments_course_dates();
--       alter table public.intake_enrolments drop constraint intake_enrolments_course_dates_check, drop column course_start_date, drop column course_end_date;
begin;

alter table public.intake_enrolments add column course_start_date date, add column course_end_date date;
alter table public.intake_enrolments add constraint intake_enrolments_course_dates_check
  check (course_end_date is null or course_start_date is null or course_end_date >= course_start_date);

create function public.intake_enrolments_course_dates() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_start date; v_end date;
begin
  if new.intake_id is not null and (new.course_start_date is null or new.course_end_date is null
     or (tg_op = 'UPDATE' and old.intake_id is distinct from new.intake_id)) then
    select min(iu.start_date), max(iu.end_date) into v_start, v_end from public.intake_units iu where iu.intake_id = new.intake_id;
    select coalesce(v_start, ci.start_date), coalesce(v_end, ci.end_date) into v_start, v_end from public.course_intakes ci where ci.id = new.intake_id;
    if tg_op = 'UPDATE' and old.intake_id is distinct from new.intake_id then
      new.course_start_date := greatest(coalesce(new.enrolled_on, v_start), v_start);
      new.course_end_date := v_end;
    else
      new.course_start_date := coalesce(new.course_start_date, greatest(coalesce(new.enrolled_on, v_start), v_start));
      new.course_end_date := coalesce(new.course_end_date, v_end);
    end if;
    if new.course_end_date < new.course_start_date then new.course_end_date := new.course_start_date; end if;
  end if;
  return new;
end $$;
create trigger a0_course_dates before insert or update of intake_id, course_start_date, course_end_date on public.intake_enrolments
  for each row execute function public.intake_enrolments_course_dates();
revoke all on function public.intake_enrolments_course_dates() from public, anon, authenticated;

update public.intake_enrolments set course_start_date = null where course_start_date is null;

commit;
