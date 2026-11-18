-- MASTER-TIMETABLE stage 2, part 2 (owner, 2026-11-18): for a course with a master timetable an intake IS the class group.
-- Each intake of such a course has exactly one batch behind it, which holds what the group needs (seats, room, trainers, class
-- days and times); staff see and name only the intake ("Intake 1", "Intake 2", ...). All of a course's intakes share the master's
-- unit dates (stage 2 part 1), so they differ only by days, room, trainer and seats.
--  * One group per intake: a second batch in an open intake of a master course is refused.
--  * Placement (rto_batch_pick): the intake's own group when it has a free seat, else another open intake of the course (same
--    CoE / VoE) with a free seat; an intake without a group gets it from the course's usual class times. When every group is
--    full no extra batch is opened: the student waits until staff add an intake.
--  * Dated classes (rto_class_sessions_generate): each unit's classes are placed inside that unit's master dates, on the group's
--    weekly class times, until the unit's hours are reached; public holidays and term breaks are skipped; past and hand-changed
--    classes are kept, as before.
--  * Weekly hours must match the master: a group's class times that give fewer hours a week than a unit of the master needs
--    (unit hours / unit weeks) cannot be saved (checked when the change is committed, whichever screen or function made it).
--    A group with no class times yet is allowed.
-- A course without a master is unchanged.
-- New: course_master_classes, course_master_group_problem, course_master_weekly_need, two triggers. Patched in place with one marked line each
-- (MASTER-STAGE2): rto_class_sessions_generate, rto_batch_pick.
-- Rollback (manual): remove the two patched blocks; drop triggers course_master_one_group (batches) and course_master_group_hours
-- (batch_sessions) and the functions course_master_one_group, course_master_group_hours, course_master_group_problem,
-- course_master_classes.

begin;

-- ------------------------------------------------------------------ one group per intake
create or replace function public.course_master_one_group() returns trigger
language plpgsql security definer set search_path = public as $$
begin
 if exists (select 1 from public.course_intakes ci join public.course_master_timetables t on t.course_id = ci.course_id
   where ci.id = new.intake_id and coalesce(ci.status, 'open') <> 'closed')
  and exists (select 1 from public.batches b where b.intake_id = new.intake_id and b.id <> new.id) then
  raise exception 'This intake already has its class group. Add another intake for another group.' using errcode = '23505';
 end if;
 return new;
end $$;
drop trigger if exists course_master_one_group on public.batches;
create trigger course_master_one_group before insert or update of intake_id on public.batches
 for each row execute function public.course_master_one_group();

-- ------------------------------------------------------------------ weekly hours must match the master
-- The most class hours a week any unit of the course's master needs (unit hours / unit weeks); null without a master.
create or replace function public.course_master_weekly_need(p_course text) returns numeric
language sql stable security definer set search_path = public as $$
 select max(coalesce(u.slit_hours, u.nominal_hours) / m.weeks) from public.course_master_units m join public.cms_course_units u on u.id = m.unit_id
 where m.course_id = p_course and m.cycle = 1 and coalesce(u.slit_hours, u.nominal_hours) > 0;
$$;

-- Null when the group's class times are enough (or it has none yet, or the course has no master); else what is wrong.
create or replace function public.course_master_group_problem(p_batch uuid) returns text
language sql stable security definer set search_path = public as $$
 with g as (
  select ci.course_id, coalesce((select sum(extract(epoch from (s.end_time - s.start_time))) / 3600.0 from public.batch_sessions s where s.batch_id = b.id), 0) as weekly
  from public.batches b join public.course_intakes ci on ci.id = b.intake_id where b.id = p_batch and coalesce(ci.status, 'open') <> 'closed'),
 worst as (
  select u.code, coalesce(u.slit_hours, u.nominal_hours) as hours, m.weeks, coalesce(u.slit_hours, u.nominal_hours) / m.weeks as need
  from g join public.course_master_units m on m.course_id = g.course_id and m.cycle = 1 join public.cms_course_units u on u.id = m.unit_id
  where coalesce(u.slit_hours, u.nominal_hours) > 0 order by 4 desc, 1 limit 1)
 select 'These class times give ' || trim(to_char(g.weekly, 'FM990.0')) || ' hours a week. The master timetable needs '
  || trim(to_char(w.need, 'FM990.0')) || ' hours a week (' || w.code || ': ' || w.hours || ' hours in ' || trim(to_char(w.weeks, 'FM990.0')) || ' week'
  || case when w.weeks = 1 then '' else 's' end || '). Add class time, or change the master timetable.'
 from g, worst w where g.weekly > 0 and g.weekly < w.need - 0.01;
$$;

create or replace function public.course_master_group_hours() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_problem text;
begin
 v_problem := public.course_master_group_problem(case when tg_op = 'DELETE' then old.batch_id else new.batch_id end);
 if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
 return null;
end $$;
drop trigger if exists course_master_group_hours on public.batch_sessions;
create constraint trigger course_master_group_hours after insert or update or delete on public.batch_sessions
 deferrable initially deferred for each row execute function public.course_master_group_hours();

-- ------------------------------------------------------------------ dated classes inside each unit's master dates
create or replace function public.course_master_classes(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare v_intake public.course_intakes; v_from date; v_day date; v_left numeric; v_len numeric; v_created integer := 0; v_kept integer; v_end date;
 v_short jsonb := '[]'::jsonb; u record; s record; v_was text := coalesce(current_setting('rto.course', true), '');
begin
 if not (coalesce(public.cms_is_rto_manager(), false) or public.rto_auto_placing()) then
  raise exception 'Only an RTO Manager can generate class sessions.' using errcode = '42501';
 end if;
 select i.* into v_intake from public.batches b join public.course_intakes i on i.id = b.intake_id where b.id = p_batch;
 if not found then raise exception 'Batch not found.' using errcode = 'P0002'; end if;
 if not exists (select 1 from public.batch_sessions where batch_id = p_batch) then
  raise exception 'Set the intake''s weekly class times first.' using errcode = '22023';
 end if;
 perform set_config('rto.course', v_intake.course_id, true);
 v_from := case when exists (select 1 from public.class_sessions where batch_id = p_batch) then greatest(v_intake.start_date, current_date) else v_intake.start_date end;
 -- every planned class from today on is laid out again (the master may have moved earlier or later); past and hand-changed ones stay
 delete from public.class_sessions where batch_id = p_batch and not is_manual and session_date >= least(v_from, current_date);
 select count(*) into v_kept from public.class_sessions where batch_id = p_batch;

 for u in select iu.unit_id, cu.code, iu.start_date, iu.end_date, coalesce(cu.slit_hours, cu.nominal_hours, iu.hours, 0)::numeric as hours
  from public.intake_units iu join public.cms_course_units cu on cu.id = iu.unit_id where iu.intake_id = v_intake.id order by iu.sort, iu.start_date loop
  -- hours already taught or fixed by hand come off the unit
  select u.hours - coalesce(sum(extract(epoch from (c.end_time - c.start_time)) / 3600.0), 0) into v_left
  from public.class_sessions c where c.batch_id = p_batch and c.unit_id = u.unit_id and c.status = 'scheduled';
  v_day := greatest(u.start_date, v_from);
  while v_left > 0 and v_day <= u.end_date loop
   if public.rto_is_teaching_day(v_day) then
    for s in select * from public.batch_sessions where batch_id = p_batch and weekday = extract(isodow from v_day)::integer order by start_time loop
     exit when v_left <= 0;
     continue when exists (select 1 from public.class_sessions c where c.batch_id = p_batch and c.session_date = v_day and c.start_time = s.start_time);
     v_len := extract(epoch from (s.end_time - s.start_time)) / 3600.0;
     insert into public.class_sessions(batch_id, session_date, start_time, end_time, session_type, room_id, unit_id)
     values (p_batch, v_day, s.start_time, s.end_time, s.session_type, s.room_id, u.unit_id);
     v_left := v_left - v_len; v_created := v_created + 1;
    end loop;
   end if;
   v_day := v_day + 1;
  end loop;
  -- a unit whose hours did not fit in what is left of its dates (holidays, or it has already begun)
  if v_left > 0.01 and u.end_date >= v_from then
   v_short := v_short || jsonb_build_object('code', u.code, 'hoursShort', round(v_left, 1));
  end if;
 end loop;
 perform set_config('rto.course', v_was, true);
 select max(session_date) into v_end from public.class_sessions where batch_id = p_batch;
 return jsonb_build_object('created', v_created, 'kept', v_kept, 'from', v_from, 'endDate', v_end, 'short', v_short,
  'clashes', public.rto_class_session_clashes(p_batch));
end $$;

-- ------------------------------------------------------------------ the two patches
do $patch$
declare p record; d text;
begin
 for p in select * from (values
  ('public.rto_class_sessions_generate(uuid)',
   $a$ if not found then raise exception 'Batch not found.' using errcode = 'P0002'; end if;$a$,
   $b$ if exists (select 1 from public.course_master_timetables t where t.course_id = v_intake.course_id) then return public.course_master_classes(p_batch); end if; -- MASTER-STAGE2$b$),
  ('public.rto_batch_pick(uuid,text,date,boolean)',
   $a$ perform pg_advisory_xact_lock(hashtextextended('rto_batch_pick:' || ti.course_id, 0));$a$,
   $b$ if exists (select 1 from public.course_master_timetables t where t.course_id = ti.course_id) then -- MASTER-STAGE2: an intake is one group
  for b in select bb.id from public.batches bb join public.course_intakes ci on ci.id = bb.intake_id
    where bb.is_active and ci.course_id = ti.course_id and ci.study_load = ti.study_load
     and (ci.id = ti.id or (not p_same and ci.is_active and ci.status = 'open' and coalesce(ci.end_date, 'infinity'::date) >= p_on))
    order by (ci.id = ti.id) desc, ci.name nulls last, ci.created_at, bb.name loop
   if public.rto_batch_occupancy(b.id, p_on) < public.rto_batch_seats(b.id) then return b.id; end if;
  end loop;
  -- an intake without a group gets it from the course's usual class times, when those give the hours the master needs
  if not exists (select 1 from public.batches bb where bb.intake_id = ti.id)
   and coalesce((select sum(extract(epoch from ((x->>'endTime')::time - (x->>'startTime')::time))) / 3600.0
     from public.course_class_defaults cd, jsonb_array_elements(cd.sessions) x where cd.course_id = ti.course_id), 0)
    >= coalesce(public.course_master_weekly_need(ti.course_id), 0) - 0.01 then
   return public.rto_intake_default_batch(ti.id);
  end if;
  return null;
 end if;$b$)) as t(fn, anchor, added) loop
  d := pg_get_functiondef(p.fn::regprocedure);
  continue when position('MASTER-STAGE2' in d) > 0;
  if position(p.anchor in d) = 0 then raise exception 'MASTER-STAGE2: anchor not found in %', p.fn; end if;
  execute replace(d, p.anchor, p.anchor || E'\n' || p.added);
 end loop;
end $patch$;

revoke all on function public.course_master_one_group(), public.course_master_group_hours(), public.course_master_group_problem(uuid),
 public.course_master_weekly_need(text), public.course_master_classes(uuid) from public, anon, authenticated;

commit;
