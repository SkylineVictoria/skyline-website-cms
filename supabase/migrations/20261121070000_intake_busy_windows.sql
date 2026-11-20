-- INTAKE-BUSY-WINDOWS (2026-11-21): when an intake's weekly classes are booked, the dated classes are made and each one is checked against every other
-- class on that date (class_session_clash_ex): the same room, or a trainer teaching anywhere (including the prerequisite class and unit trainers).
-- The weekly screen only knew other intakes' weekly times, so it could offer a trainer or room that a dated class elsewhere (for example the
-- prerequisite class) already uses, and booking then failed after the week was saved. This lists, for the intake's own period, the days and times
-- each trainer and each room is already used by another intake's dated classes, so the screen offers only really free times.
-- Read only; staff only. Additive.
create function public.rto_intake_busy_windows(p_intake uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i public.course_intakes; v_from date; v_to date; r jsonb;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 v_from := i.start_date; v_to := coalesce(i.end_date, i.start_date + 1461);
 with x as (
  select s.id, s.session_date, s.start_time, s.end_time, coalesce(s.room_id, ci.classroom_id) as room, public.session_trainer_ids(s.trainer_id, s.intake_id, s.unit_id) as trainers,
   public.intake_group_name(ci.id) as intake, (select code from public.cms_courses where id = ci.course_id) as course
  from public.class_sessions s join public.course_intakes ci on ci.id = s.intake_id
  where s.intake_id <> p_intake and s.status <> 'cancelled' and s.session_date between v_from and v_to),
 t as (select tr as id, extract(isodow from session_date)::int as weekday, start_time, end_time, min(session_date) as day, min(intake) as intake, min(course) as course
  from x cross join lateral unnest(x.trainers) as tr group by tr, extract(isodow from session_date), start_time, end_time),
 rm as (select room as id, extract(isodow from session_date)::int as weekday, start_time, end_time, min(session_date) as day, min(intake) as intake, min(course) as course
  from x where room is not null group by room, extract(isodow from session_date), start_time, end_time)
 select jsonb_build_object(
  'trainers', coalesce((select jsonb_object_agg(g.id::text, g.w) from (select id, jsonb_agg(jsonb_build_object('weekday', weekday, 'start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI'), 'day', day, 'intake', intake, 'course', course)) as w from t group by id) g), '{}'::jsonb),
  'rooms', coalesce((select jsonb_object_agg(g.id::text, g.w) from (select id, jsonb_agg(jsonb_build_object('weekday', weekday, 'start', to_char(start_time, 'HH24:MI'), 'end', to_char(end_time, 'HH24:MI'), 'day', day, 'intake', intake, 'course', course)) as w from rm group by id) g), '{}'::jsonb))
 into r;
 return r;
end $$;
revoke all on function public.rto_intake_busy_windows(uuid) from public, anon;
grant execute on function public.rto_intake_busy_windows(uuid) to authenticated;
