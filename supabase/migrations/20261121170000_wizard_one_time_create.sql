-- ONE-TIME CREATE AT FINISH (owner, 2026-11-21): the course wizard keeps the CoE and VoE daily timetables in the browser and creates both intakes
-- only when the wizard is finished. This adds what that needs: the dated classes already booked from a start date (no intake to leave out),
-- and a discard of any leftover hidden intake if a Finish is repeated.
create or replace function public.rto_busy_windows_from(p_start date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_from date; v_to date; r jsonb;
begin
 if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 v_from := p_start; v_to := p_start + 1461;
 with x as (
  select s.id, s.session_date, s.start_time, s.end_time, coalesce(s.room_id, ci.classroom_id) as room, public.session_trainer_ids(s.trainer_id, s.intake_id, s.unit_id) as trainers,
   public.intake_group_name(ci.id) as intake, (select code from public.cms_courses where id = ci.course_id) as course
  from public.class_sessions s join public.course_intakes ci on ci.id = s.intake_id
  where s.status <> 'cancelled' and s.session_date between v_from and v_to),
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
revoke all on function public.rto_busy_windows_from(date) from public, anon;
grant execute on function public.rto_busy_windows_from(date) to authenticated;
grant execute on function public.rto_intake_busy_windows(uuid) to authenticated;

do $$
declare d text; a constant text := 'elsif p_action = ''finish'' then';
begin
 d := pg_get_functiondef('public.rto_intake_wizard(text,jsonb)'::regprocedure);
 if position(a in d) = 0 then raise exception 'anchor not found in rto_intake_wizard'; end if;
 execute replace(d, a, 'elsif p_action = ''discard'' then
  delete from public.course_intakes ci where ci.course_id = v_course and ci.wizard_pending
   and not exists (select 1 from public.intake_enrolments e where e.intake_id = ci.id);
  return jsonb_build_object(''ok'', true);
 ' || a);
end $$;
