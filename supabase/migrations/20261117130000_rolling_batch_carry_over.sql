-- ROLLING-BATCH: students join a running batch at any unit and finish in a later intake, automatically.
-- A course's units have no fixed order, so a batch keeps cycling through them, one intake after another. A student who joins late
-- (batch_enrolments.enrolled_on after a unit has ended) still owes the units that ended before they joined; a student with a current
-- Not Yet Competent outcome owes that unit again. The planner (rto_carry_over_plan) places every owed unit in the next intakes of the
-- same course and study load, one after another, as "carry-over" enrolments:
--   * joins intake 1 at unit 10 of 30          -> units 10-30 in intake 1, a carry-over enrolment in intake 2 for units 1-9;
--   * joins at the last unit while intake 2 is already half way -> the rest of intake 2, then intake 3 for what intake 2 had passed;
--   * no later intake yet                      -> the units stay owed and are placed when staff add the next intake and its batch.
-- A carry-over enrolment lists its units (batch_enrolment_units, by unit, so regenerating an intake's timeline keeps them). It starts
-- on the first of them and never overlaps the student's earlier classes. Until it starts it is recalculated on every change; once it
-- has started it is kept. The batch is the one with the same name in the next intake, else the first active batch by name.
-- Runs by trigger: an enrolment added, moved, removed or its status changed; a unit outcome signed; a batch added or (de)activated;
-- an intake's unit timeline or a batch's own unit dates changed. No cron job. A planner error never blocks the change that caused
-- it (it is raised as a warning). Nothing is planned for existing enrolments by this migration itself.
-- A current certificate ends the path: the student's other enrolments in the course become completed.
-- Additive: two columns, one table, new functions and triggers; rto_batch_json (each student gains `path`) and my_class_schedule
-- (a student sees only the classes of units they take in that batch) are redefined, otherwise as in 20261113410000 / 20261117093847.
-- Rollback (manual): drop the triggers rto_carry_over_* and the functions rto_carry_over_*, rto_enrolment_*, rto_batch_units,
-- rto_unit_outcome; restore the two redefined functions from the migrations named above; delete from batch_enrolments where carry_over;
-- drop table batch_enrolment_units; drop the two columns.

begin;

alter table public.batch_enrolments add column if not exists carry_over boolean not null default false;
alter table public.batch_enrolments add column if not exists continues_enrolment_id uuid references public.batch_enrolments(id) on delete set null;
create index if not exists batch_enrolments_continues_idx on public.batch_enrolments(continues_enrolment_id) where continues_enrolment_id is not null;

create table if not exists public.batch_enrolment_units (
 enrolment_id uuid not null references public.batch_enrolments(id) on delete cascade,
 unit_id text not null references public.cms_course_units(id) on delete cascade,
 primary key (enrolment_id, unit_id)
);
alter table public.batch_enrolment_units enable row level security;
revoke all on public.batch_enrolment_units from anon;
drop policy if exists batch_enrolment_units_staff_read on public.batch_enrolment_units;
create policy batch_enrolment_units_staff_read on public.batch_enrolment_units for select to authenticated using (public.cms_is_staff());

-- ------------------------------------------------------------------ 1. reading helpers
-- A batch's units with their dates (the batch's own where staff changed them, else the intake's).
create or replace function public.rto_batch_units(p_batch uuid) returns table(intake_unit_id uuid, unit_id text, start_date date, end_date date, sort integer)
language sql stable security definer set search_path = public as $$
 select x.id, x.unit_id, coalesce(o.start_date, x.start_date), coalesce(o.end_date, x.end_date), x.sort
 from public.batches b join public.intake_units x on x.intake_id = b.intake_id
 left join public.batch_unit_overrides o on o.batch_id = b.id and o.intake_unit_id = x.id
 where b.id = p_batch;
$$;

-- The units a student takes in an enrolment: a carry-over's listed units; otherwise every unit that had not ended when they joined.
create or replace function public.rto_enrolment_units(p_enrolment uuid) returns table(intake_unit_id uuid, unit_id text, start_date date, end_date date, sort integer)
language sql stable security definer set search_path = public as $$
 select u.intake_unit_id, u.unit_id, u.start_date, u.end_date, u.sort
 from public.batch_enrolments e cross join lateral public.rto_batch_units(e.batch_id) u
 where e.id = p_enrolment
  and case when e.carry_over then exists(select 1 from public.batch_enrolment_units eu where eu.enrolment_id = e.id and eu.unit_id = u.unit_id)
      else u.end_date >= e.enrolled_on end;
$$;

-- A student's current outcome in a unit (the latest one not superseded) and the Melbourne day it was signed.
create or replace function public.rto_unit_outcome(p_student uuid, p_unit text) returns table(outcome text, signed_on date)
language sql stable security definer set search_path = public as $$
 select x.outcome, (x.signed_at at time zone 'Australia/Melbourne')::date from public.asm_unit_outcomes x
 where x.student_id = p_student and x.unit_id = p_unit and not exists (select 1 from public.asm_unit_outcomes z where z.supersedes_id = x.id)
 order by x.signed_at desc limit 1;
$$;

-- A carry-over that has not started and has no attendance yet: the planner may still move or remove it.
create or replace function public.rto_enrolment_pending(e public.batch_enrolments) returns boolean
language sql stable security definer set search_path = public as $$
 select e.carry_over and e.status in ('active', 'deferred') and e.enrolled_on > public.course_intake_today()
  and not exists (select 1 from public.lms_attendance_marks m where m.enrolment_id = e.id);
$$;

-- The units a student still owes in a course: scheduled in an intake they are enrolled in, not Competent, and not taken in any of
-- their enrolments (p_fixed_only: leaving out carry-overs that have not started). A unit counts as taken unless a Not Yet Competent
-- outcome was signed on or after the day that unit began there.
create or replace function public.rto_carry_over_open_units(p_student uuid, p_course text, p_fixed_only boolean) returns text[]
language sql stable security definer set search_path = public as $$
 with en as (
  select e.id, b.intake_id from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
  where e.student_id = p_student and ci.course_id = p_course and e.status in ('active', 'deferred', 'completed')
   and not (p_fixed_only and public.rto_enrolment_pending(e))),
 needed as (select distinct iu.unit_id from en join public.intake_units iu on iu.intake_id = en.intake_id),
 taken as (select u.unit_id, u.start_date from en cross join lateral public.rto_enrolment_units(en.id) u)
 select coalesce(array_agg(n.unit_id order by n.unit_id), '{}')
 from needed n left join lateral public.rto_unit_outcome(p_student, n.unit_id) o on true
 where o.outcome is distinct from 'C'
  and not exists (select 1 from taken t where t.unit_id = n.unit_id and (o.outcome is null or o.signed_on < t.start_date));
$$;

-- ------------------------------------------------------------------ 2. the planner
create or replace function public.rto_carry_over_plan(p_student uuid, p_course text) returns void
language plpgsql security definer set search_path = public as $$
declare v_today date := public.course_intake_today(); v_was text := coalesce(current_setting('rto.carry_over_planning', true), '');
 l record; n record; v_out text[]; v_free date; v_prev uuid; v_enrol uuid; v_batch uuid; v_units text[]; v_from date; v_to date; v_keep uuid[] := '{}'; v_go boolean := true;
begin
 if p_student is null or p_course is null then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_carry_over:' || p_student::text || ':' || p_course, 0));
 perform set_config('rto.carry_over_planning', 'on', true);

 -- The student's latest enrolment that is not a carry-over still waiting to start: the path continues from it.
 select e.id, e.status, e.carry_over, e.enrolment_type, e.batch_id, b.name as batch_name, ci.start_date, ci.study_load into l
 from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
 where e.student_id = p_student and ci.course_id = p_course and e.status in ('active', 'deferred', 'completed') and not public.rto_enrolment_pending(e)
 order by ci.start_date desc, e.enrolled_on desc, e.id limit 1;

 if exists (select 1 from public.course_completions cc where cc.student_id = p_student and cc.course_id = p_course and cc.kind = 'certificate' and cc.revoked_at is null) then
  -- Certificate issued: the path is finished.
  update public.batch_enrolments e set status = 'completed' from public.batches b, public.course_intakes ci
  where b.id = e.batch_id and ci.id = b.intake_id and ci.course_id = p_course and e.student_id = p_student
   and e.status in ('active', 'deferred') and not public.rto_enrolment_pending(e);
  v_go := false;
 end if;

 if v_go and l.id is not null and exists (
  select 1 from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
  where e.student_id = p_student and ci.course_id = p_course and e.status in ('active', 'deferred') and not public.rto_enrolment_pending(e)) then
  v_out := public.rto_carry_over_open_units(p_student, p_course, true);
  select greatest(coalesce(max(u.end_date), v_today - 1), v_today - 1) into v_free
  from public.batch_enrolments e join public.batches b on b.id = e.batch_id join public.course_intakes ci on ci.id = b.intake_id
  cross join lateral public.rto_enrolment_units(e.id) u
  where e.student_id = p_student and ci.course_id = p_course and e.status in ('active', 'deferred', 'completed') and not public.rto_enrolment_pending(e);
  v_prev := l.id;

  -- A carry-over already under way also takes owed units still ahead in its own batch.
  if l.carry_over and l.status in ('active', 'deferred') and cardinality(v_out) > 0 then
   select array_agg(distinct u.unit_id), max(u.end_date) into v_units, v_to from public.rto_batch_units(l.batch_id) u
   where u.unit_id = any(v_out) and u.start_date > v_free;
   if v_units is not null then
    insert into public.batch_enrolment_units(enrolment_id, unit_id) select l.id, unnest(v_units) on conflict do nothing;
    v_out := array(select unnest(v_out) except select unnest(v_units));
    v_free := greatest(v_free, v_to);
   end if;
  end if;

  for n in select ci.id from public.course_intakes ci
   where ci.course_id = p_course and ci.is_active and ci.study_load = l.study_load and ci.start_date > l.start_date order by ci.start_date, ci.id loop
   exit when cardinality(v_out) = 0;
   v_enrol := null; v_batch := null;
   select e.id, e.batch_id into v_enrol, v_batch from public.batch_enrolments e join public.batches b on b.id = e.batch_id
   where b.intake_id = n.id and e.student_id = p_student and public.rto_enrolment_pending(e) order by e.id limit 1;
   -- An enrolment staff removed (or made by hand) in this intake: leave the intake alone.
   continue when v_enrol is null and exists (select 1 from public.batch_enrolments e join public.batches b on b.id = e.batch_id where b.intake_id = n.id and e.student_id = p_student);
   if v_batch is null then
    select b.id into v_batch from public.batches b where b.intake_id = n.id and b.is_active order by (b.name = l.batch_name) desc, b.name, b.id limit 1;
   end if;
   continue when v_batch is null;
   select array_agg(distinct u.unit_id), min(u.start_date), max(u.end_date) into v_units, v_from, v_to from public.rto_batch_units(v_batch) u
   where u.unit_id = any(v_out) and u.start_date > v_free;
   continue when v_units is null;
   if v_enrol is null then
    insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on, carry_over, continues_enrolment_id)
    values (v_batch, p_student, l.enrolment_type, 'active', v_from, true, v_prev) returning id into v_enrol;
   else
    update public.batch_enrolments set enrolled_on = v_from, continues_enrolment_id = v_prev
    where id = v_enrol and (enrolled_on <> v_from or continues_enrolment_id is distinct from v_prev);
   end if;
   delete from public.batch_enrolment_units where enrolment_id = v_enrol and unit_id <> all(v_units);
   insert into public.batch_enrolment_units(enrolment_id, unit_id) select v_enrol, unnest(v_units) on conflict do nothing;
   v_keep := v_keep || v_enrol; v_prev := v_enrol; v_free := v_to;
   v_out := array(select unnest(v_out) except select unnest(v_units));
  end loop;
 end if;

 -- Carry-overs that have not started and are no longer needed.
 delete from public.batch_enrolments e using public.batches b, public.course_intakes ci
 where b.id = e.batch_id and ci.id = b.intake_id and ci.course_id = p_course and e.student_id = p_student
  and public.rto_enrolment_pending(e) and e.id <> all(v_keep);
 perform set_config('rto.carry_over_planning', v_was, true);
end $$;

-- Every student with a running enrolment in the course (or in every course): plan again. Returns how many were planned.
create or replace function public.rto_carry_over_run(p_course text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; v_n integer := 0;
begin
 for r in select distinct e.student_id, ci.course_id from public.batch_enrolments e join public.batches b on b.id = e.batch_id
  join public.course_intakes ci on ci.id = b.intake_id
  where e.status in ('active', 'deferred') and (p_course is null or ci.course_id = p_course) loop
  perform public.rto_carry_over_plan(r.student_id, r.course_id);
  v_n := v_n + 1;
 end loop;
 return v_n;
end $$;

-- ------------------------------------------------------------------ 3. triggers (a planner error is a warning, never a failed save)
create or replace function public.rto_carry_over_on_enrolment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_course text;
begin
 if coalesce(current_setting('rto.carry_over_planning', true), '') = 'on' then return null; end if;
 begin
  for v_course in select distinct ci.course_id from public.batches b join public.course_intakes ci on ci.id = b.intake_id
   where b.id in (case when tg_op <> 'INSERT' then old.batch_id end, case when tg_op <> 'DELETE' then new.batch_id end) loop
   perform public.rto_carry_over_plan(case when tg_op = 'DELETE' then old.student_id else new.student_id end, v_course);
  end loop;
 exception when others then
  raise warning 'rto_carry_over (enrolment): %', sqlerrm;
 end;
 return null;
end $$;
drop trigger if exists rto_carry_over_enrolment on public.batch_enrolments;
create trigger rto_carry_over_enrolment after insert or update of status, batch_id, enrolled_on or delete on public.batch_enrolments
 for each row execute function public.rto_carry_over_on_enrolment();

create or replace function public.rto_carry_over_on_outcome() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_course text;
begin
 begin
  for v_course in select distinct ci.course_id from public.batch_enrolments e join public.batches b on b.id = e.batch_id
   join public.course_intakes ci on ci.id = b.intake_id
   where e.student_id = new.student_id and e.status in ('active', 'deferred')
    and exists (select 1 from public.intake_units iu where iu.intake_id = ci.id and iu.unit_id = new.unit_id) loop
   perform public.rto_carry_over_plan(new.student_id, v_course);
  end loop;
 exception when others then
  raise warning 'rto_carry_over (outcome): %', sqlerrm;
 end;
 return null;
end $$;
drop trigger if exists rto_carry_over_outcome on public.asm_unit_outcomes;
create trigger rto_carry_over_outcome after insert on public.asm_unit_outcomes for each row execute function public.rto_carry_over_on_outcome();

create or replace function public.rto_carry_over_on_certificate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
 begin
  if new.kind = 'certificate' then perform public.rto_carry_over_plan(new.student_id, new.course_id); end if;
 exception when others then
  raise warning 'rto_carry_over (certificate): %', sqlerrm;
 end;
 return null;
end $$;
drop trigger if exists rto_carry_over_certificate on public.course_completions;
create trigger rto_carry_over_certificate after insert or update of revoked_at on public.course_completions
 for each row execute function public.rto_carry_over_on_certificate();

-- The schedule changed (batches, an intake's units, a batch's own unit dates): plan the courses concerned again.
create or replace function public.rto_carry_over_on_schedule() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_course text;
begin
 if coalesce(current_setting('rto.carry_over_planning', true), '') = 'on' then return null; end if;
 begin
  if tg_table_name = 'batches' then
   for v_course in select distinct ci.course_id from rto_changed x join public.course_intakes ci on ci.id = x.intake_id loop
    perform public.rto_carry_over_run(v_course);
   end loop;
  elsif tg_table_name = 'intake_units' then
   for v_course in select distinct ci.course_id from rto_changed x join public.course_intakes ci on ci.id = x.intake_id loop
    perform public.rto_carry_over_run(v_course);
   end loop;
  else
   for v_course in select distinct ci.course_id from rto_changed x join public.batches b on b.id = x.batch_id join public.course_intakes ci on ci.id = b.intake_id loop
    perform public.rto_carry_over_run(v_course);
   end loop;
  end if;
 exception when others then
  raise warning 'rto_carry_over (schedule): %', sqlerrm;
 end;
 return null;
end $$;
drop trigger if exists rto_carry_over_batch_ins on public.batches;
create trigger rto_carry_over_batch_ins after insert on public.batches referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_batch_upd on public.batches;
create trigger rto_carry_over_batch_upd after update on public.batches referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_units_ins on public.intake_units;
create trigger rto_carry_over_units_ins after insert on public.intake_units referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_units_upd on public.intake_units;
create trigger rto_carry_over_units_upd after update on public.intake_units referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_units_del on public.intake_units;
create trigger rto_carry_over_units_del after delete on public.intake_units referencing old table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_override_ins on public.batch_unit_overrides;
create trigger rto_carry_over_override_ins after insert on public.batch_unit_overrides referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_override_upd on public.batch_unit_overrides;
create trigger rto_carry_over_override_upd after update on public.batch_unit_overrides referencing new table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();
drop trigger if exists rto_carry_over_override_del on public.batch_unit_overrides;
create trigger rto_carry_over_override_del after delete on public.batch_unit_overrides referencing old table as rto_changed for each statement execute function public.rto_carry_over_on_schedule();

-- ------------------------------------------------------------------ 4. what staff see for each student of a batch
-- unitIds: the batch's units (intake unit ids) this student takes here; joinedAt: the first of them when the student skips earlier
-- ones; from / next: the enrolment this one continues and the one that continues it; owed: units not yet placed in any intake;
-- finishDate: the last day of the student's last unit, once every unit is placed.
create or replace function public.rto_enrolment_path(e public.batch_enrolments) returns jsonb
language sql stable security definer set search_path = public as $$
 with c as (select ci.course_id from public.batches b join public.course_intakes ci on ci.id = b.intake_id where b.id = e.batch_id),
 mine as (select * from public.rto_enrolment_units(e.id)),
 owed as (select public.rto_carry_over_open_units(e.student_id, (select course_id from c), false) as units)
 select jsonb_build_object(
  'carryOver', e.carry_over,
  'unitIds', coalesce((select jsonb_agg(m.intake_unit_id order by m.sort, m.start_date) from mine m), '[]'::jsonb),
  'skipped', (select count(*) from public.rto_batch_units(e.batch_id)) - (select count(*) from mine),
  'joinedAt', (select u.code from mine m join public.cms_course_units u on u.id = m.unit_id order by m.start_date, m.sort limit 1),
  'from', (select jsonb_build_object('enrolmentId', p.id, 'batchId', pb.id, 'batch', pb.name, 'intake', public.course_intake_name(pi))
    from public.batch_enrolments p join public.batches pb on pb.id = p.batch_id join public.course_intakes pi on pi.id = pb.intake_id
    where p.id = e.continues_enrolment_id),
  'next', (select jsonb_build_object('enrolmentId', x.id, 'batchId', xb.id, 'batch', xb.name, 'intake', public.course_intake_name(xi), 'startDate', x.enrolled_on,
     'units', (select count(*) from public.batch_enrolment_units eu where eu.enrolment_id = x.id))
    from public.batch_enrolments x join public.batches xb on xb.id = x.batch_id join public.course_intakes xi on xi.id = xb.intake_id
    where x.continues_enrolment_id = e.id and x.carry_over and x.status <> 'withdrawn' order by x.enrolled_on limit 1),
  'owed', cardinality((select units from owed)),
  'finishDate', case when cardinality((select units from owed)) = 0 then (
    select max(u.end_date) from public.batch_enrolments a join public.batches ab on ab.id = a.batch_id join public.course_intakes ai on ai.id = ab.intake_id
    cross join lateral public.rto_enrolment_units(a.id) u
    where a.student_id = e.student_id and ai.course_id = (select course_id from c) and a.status in ('active', 'deferred', 'completed')) end);
$$;

-- As in 20261113410000, each student with `path`.
create or replace function public.rto_batch_json(b public.batches) returns jsonb
language sql stable security definer set search_path = public as $$
 select jsonb_build_object('id', b.id, 'intakeId', b.intake_id, 'name', b.name, 'classroomId', b.classroom_id,
  'classroom', (select r.name from public.classrooms r where r.id = b.classroom_id), 'classDays', to_jsonb(b.class_days),
  'startTime', to_char(b.start_time, 'HH24:MI'), 'endTime', to_char(b.end_time, 'HH24:MI'), 'capacity', b.capacity, 'isActive', b.is_active,
  'trainers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name)) order by s.first_name, s.last_name)
     from public.batch_trainers t join hr.staff_profiles s on s.id = t.staff_id where t.batch_id = b.id), '[]'::jsonb),
  'students', coalesce((select jsonb_agg(jsonb_build_object('enrolmentId', e.id, 'id', s.id, 'name', s.full_name, 'email', s.email, 'type', e.enrolment_type,
     'status', e.status, 'enrolledOn', e.enrolled_on, 'path', public.rto_enrolment_path(e)) order by s.full_name) from public.batch_enrolments e join public.enrollment_students s on s.id = e.student_id
     where e.batch_id = b.id), '[]'::jsonb),
  'schedule', coalesce((select jsonb_agg(jsonb_build_object('intakeUnitId', x.id, 'code', u.code, 'name', u.name,
      'startDate', coalesce(o.start_date, x.start_date), 'endDate', coalesce(o.end_date, x.end_date),
      'intakeStartDate', x.start_date, 'intakeEndDate', x.end_date, 'overridden', o.batch_id is not null) order by x.sort, x.start_date)
     from public.intake_units x join public.cms_course_units u on u.id = x.unit_id
     left join public.batch_unit_overrides o on o.batch_id = b.id and o.intake_unit_id = x.id
     where x.intake_id = b.intake_id), '[]'::jsonb),
  'sessions', public.rto_batch_sessions_json(b.id),
  'startDate', lower(public.rto_batch_span(b.id)), 'endDate', upper(public.rto_batch_span(b.id)) - 1);
$$;

-- As in 20261117093847; a student sees a class only when its unit is one they take in that batch (a class without a unit is shown).
create or replace function public.my_class_schedule(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
declare v_student uuid := public.portal_student_id(); v_staff uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 120 then raise exception 'Choose up to 120 days' using errcode = '22023'; end if;
  if v_student is null then v_staff := public.asm_trainer_profile(); end if;
  if v_student is null and v_staff is null then raise exception 'Student or staff access required' using errcode = '42501'; end if;
  return jsonb_build_object('role', case when v_student is not null then 'student' else 'trainer' end, 'sessions', coalesce((
    select jsonb_agg(jsonb_build_object('id', cs.id, 'date', cs.session_date, 'start', to_char(cs.start_time, 'HH24:MI'), 'end', to_char(cs.end_time, 'HH24:MI'),
      'type', cs.session_type, 'status', cs.status, 'batchName', b.name, 'courseName', coalesce(nullif(c.name, ''), c.code), 'courseCode', c.code,
      'unitCode', u.code, 'unitName', u.name, 'room', r.name, 'campus', r.campus,
      'trainers', coalesce((select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ')
        from hr.staff_profiles p where p.id in (
          select ut.staff_id from public.batch_unit_trainers ut join public.intake_units iu on iu.id = ut.intake_unit_id
          where ut.batch_id = b.id and iu.unit_id = cs.unit_id)), (select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ')
        from public.batch_trainers bt join hr.staff_profiles p on p.id = bt.staff_id where bt.batch_id = b.id), ''))
      order by cs.session_date, cs.start_time)
    from public.class_sessions cs
    join public.batches b on b.id = cs.batch_id
    join public.course_intakes ci on ci.id = b.intake_id
    join public.cms_courses c on c.id = ci.course_id
    left join public.cms_course_units u on u.id = cs.unit_id
    left join public.classrooms r on r.id = cs.room_id
    where cs.session_date between p_from and p_to
      and (case when v_student is not null then exists (select 1 from public.batch_enrolments e where e.batch_id = b.id and e.student_id = v_student and e.status in ('active', 'deferred')
            and (cs.unit_id is null or exists (select 1 from public.rto_enrolment_units(e.id) eu where eu.unit_id = cs.unit_id)))
        else exists (select 1 from public.batch_trainers bt where bt.batch_id = b.id and bt.staff_id = v_staff)
          or exists (select 1 from public.batch_unit_trainers ut join public.intake_units iu on iu.id = ut.intake_unit_id
            where ut.batch_id = b.id and ut.staff_id = v_staff and iu.unit_id = cs.unit_id) end)), '[]'::jsonb));
end;
$$;

revoke all on function public.rto_batch_units(uuid), public.rto_enrolment_units(uuid), public.rto_unit_outcome(uuid, text),
 public.rto_enrolment_pending(public.batch_enrolments), public.rto_carry_over_open_units(uuid, text, boolean),
 public.rto_carry_over_plan(uuid, text), public.rto_carry_over_run(text), public.rto_enrolment_path(public.batch_enrolments),
 public.rto_carry_over_on_enrolment(), public.rto_carry_over_on_outcome(), public.rto_carry_over_on_certificate(),
 public.rto_carry_over_on_schedule() from public, anon, authenticated;

commit;
