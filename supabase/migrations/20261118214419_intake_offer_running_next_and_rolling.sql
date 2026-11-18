-- INTAKE-OFFER + ROLLING (owner, 2026-11-18). Additive (functions replaced in place).
-- 1. The enrolment form's intake dropdown offers only: the intakes running today and, per study load, the next one that has not
--    started. Far-ahead intakes (made automatically) are not listed. A student who picks a running intake joins it from today, and the
--    prerequisite rule decides (a prerequisite unit already ended and not Competent -> next intake). The same set is what the server
--    accepts on save / submit (course_intake_open_for, course_has_open_intake). A course with no intakes keeps the twelve fallback months.
-- 2. Rolling intakes: every 15 minutes, per course and study load, the latest intake that has not ended gets its successor
--    (rto_intake_auto_next: units, batches, trainers and class times copied) when
--      - it was created by staff (so creating one intake gives two), or
--      - it is at least halfway through (start to end).
--    The new intake's batches get their dated classes. Intakes made for a carried-over or late student are unchanged.
-- Rollback (manual): restore course_intakes_open / course_intake_open_for / course_has_open_intake from their previous definitions;
-- select cron.unschedule('rto-intake-rolling'); drop function public.rto_intake_rolling_sweep(), public.course_intake_offered(text).
begin;

create function public.course_intake_offered(p_course text) returns setof uuid
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with c as (select public.course_resolve_id(p_course) cid), t as (select public.course_intake_today() d),
  live as (
    select i.* from public.course_intakes i, c where i.course_id = c.cid and i.is_active and coalesce(i.status, 'open') not in ('closed', 'draft'))
  select l.id from live l, t where l.start_date <= t.d and coalesce(l.end_date, l.start_date) >= t.d
  union
  select n.id from (
    select distinct on (l.study_load) l.id from live l, t where l.start_date > t.d order by l.study_load, l.start_date, l.id) n;
$$;

create or replace function public.course_intake_open_for(p_intake uuid, p_course text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $function$
  select p_intake in (select public.course_intake_offered(p_course));
$function$;

create or replace function public.course_has_open_intake(p_course text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $function$
  select exists (select 1 from public.course_intake_offered(p_course));
$function$;

create or replace function public.course_intakes_open(p_course text) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $function$
 with r as (select public.course_resolve_id(p_course) cid),
 real as (
  select coalesce(jsonb_agg(public.course_intake_json(i) || jsonb_build_object('fallback', false,
      'running', i.start_date <= public.course_intake_today()) order by i.start_date), '[]'::jsonb) list
  from public.course_intakes i where i.id in (select public.course_intake_offered(p_course)))
 select case when jsonb_array_length(real.list) > 0 then real.list
  when r.cid is not null and not exists (select 1 from public.course_intakes i where i.course_id = r.cid)
   then public.course_intake_fallback(r.cid)
  else '[]'::jsonb end
 from real, r;
$function$;

create function public.rto_intake_rolling_sweep() returns integer
language plpgsql security definer set search_path = public as $$
declare l record; v_new uuid; b record; n integer := 0; v_today date := public.course_intake_today(); v_end date;
begin
  for l in
    select distinct on (ci.course_id, ci.study_load) ci.*
    from public.course_intakes ci where ci.is_active and coalesce(ci.status, 'open') not in ('closed', 'draft')
    order by ci.course_id, ci.study_load, ci.start_date desc, ci.id
  loop
    v_end := coalesce(l.end_date, (select max(end_date) from public.intake_units where intake_id = l.id), l.start_date);
    continue when v_end < v_today;  -- an intake that already ended: staff start the course again by hand
    continue when coalesce((to_jsonb(l)->>'auto_created')::boolean, false)
      and v_today < l.start_date + ((v_end - l.start_date) / 2);  -- automatic and not yet halfway
    begin
      v_new := public.rto_intake_auto_next(l.id);
      if v_new is not null then
        n := n + 1;
        perform set_config('rto.auto_place', 'on', true);
        for b in select id from public.batches where intake_id = v_new and is_active
            and exists (select 1 from public.batch_sessions s where s.batch_id = batches.id) loop
          begin
            perform set_config('rto.course', l.course_id, true);
            perform public.rto_class_sessions_generate(b.id);
          exception when others then raise warning 'rto_intake_rolling_sweep: classes for batch % not generated: %', b.id, sqlerrm;
          end;
        end loop;
        perform set_config('rto.auto_place', 'off', true);
      end if;
    exception when others then
      perform set_config('rto.auto_place', 'off', true);
      raise warning 'rto_intake_rolling_sweep: intake % not rolled: %', l.id, sqlerrm;
    end;
  end loop;
  return n;
end;
$$;

revoke all on function public.course_intake_offered(text), public.rto_intake_rolling_sweep() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'rto-intake-rolling';
    perform cron.schedule('rto-intake-rolling', '*/15 * * * *', 'select public.rto_intake_rolling_sweep()');
  end if;
end $$;

commit;
