-- ROLLING-INTAKES: once a course has an intake, the next one is created automatically, so batches keep running intake after intake.
-- When a student is studying in the latest intake of a course (same study load), the intake after it is made at once: it starts on
-- the next working day after the last unit ends, with the same units (dates moved by the same number of days, as "Duplicate
-- intake" does), the same batches (names, rooms, capacity, trainers, unit trainers, weekly class timing, own unit dates), status
-- open. Its dated classes are generated when an RTO Manager made the change; otherwise staff generate them from the batch.
-- A student who still owes units after that intake (joined near the end while the next intake had already started, or failed a
-- unit) gets the following intake made the same way, up to four ahead. Nothing is made when a later intake of the course and
-- study load already exists in any status (staff planned it, or closed it on purpose), or when the intake has no units or no
-- active batch. Fees per intake are not copied (the course's fees apply), as with Duplicate intake.
-- Additive: one column (course_intakes.auto_created), one function (rto_intake_auto_next); rto_carry_over_plan redefined (as in
-- 20261117130000, plus the intake id in the student's path and the two calls above).
-- Rollback (manual): restore rto_carry_over_plan from 20261117130000; drop function rto_intake_auto_next; intakes made by it have
-- auto_created = true; drop the column.

begin;

alter table public.course_intakes add column if not exists auto_created boolean not null default false;

-- Make the intake after p_intake (same course and study load) when there is none yet. Returns the new intake's id, else null.
create or replace function public.rto_intake_auto_next(p_intake uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare src public.course_intakes; v_last date; v_start date; v_delta integer; v_new uuid; b record; x record; nb uuid; v_was text;
begin
 select * into src from public.course_intakes where id = p_intake;
 if src.id is null then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_intake_next:' || src.course_id || ':' || src.study_load, 0));
 if exists (select 1 from public.course_intakes ci where ci.course_id = src.course_id and ci.study_load = src.study_load and ci.start_date > src.start_date) then
  return null;
 end if;
 if not exists (select 1 from public.batches where intake_id = src.id and is_active) then return null; end if;
 select max(end_date) into v_last from public.intake_units where intake_id = src.id;
 if v_last is null then return null; end if;
 v_was := coalesce(current_setting('rto.course', true), '');
 perform set_config('rto.course', src.course_id, true);
 v_start := public.rto_next_working_day(greatest(v_last, coalesce(src.end_date, v_last)) + 1);
 perform set_config('rto.course', v_was, true);
 v_delta := v_start - src.start_date;
 if exists (select 1 from public.course_intakes where course_id = src.course_id and start_date = v_start) then return null; end if;

 insert into public.course_intakes(course_id, start_date, end_date, name, campus, capacity, status, study_load, auto_created)
 values (src.course_id, v_start, coalesce(src.end_date, v_last) + v_delta, null, src.campus, src.capacity, 'open', src.study_load, true)
 returning id into v_new;

 create temp table if not exists rto_auto_unit_map(old_id uuid primary key, new_id uuid) on commit drop;
 delete from rto_auto_unit_map;
 for x in select * from public.intake_units where intake_id = src.id order by sort, start_date loop
  insert into rto_auto_unit_map(old_id, new_id) values (x.id, gen_random_uuid());
  insert into public.intake_units(id, intake_id, unit_id, start_date, end_date, hours, sort)
  select m.new_id, v_new, x.unit_id, x.start_date + v_delta, x.end_date + v_delta, x.hours, x.sort from rto_auto_unit_map m where m.old_id = x.id;
 end loop;

 for b in select * from public.batches where intake_id = src.id order by name loop
  insert into public.batches(intake_id, name, classroom_id, class_days, start_time, end_time, capacity, is_active)
  values (v_new, b.name, b.classroom_id, b.class_days, b.start_time, b.end_time, b.capacity, b.is_active) returning id into nb;
  insert into public.batch_trainers(batch_id, staff_id) select nb, t.staff_id from public.batch_trainers t where t.batch_id = b.id on conflict do nothing;
  insert into public.batch_unit_trainers(batch_id, intake_unit_id, staff_id)
  select nb, m.new_id, t.staff_id from public.batch_unit_trainers t join rto_auto_unit_map m on m.old_id = t.intake_unit_id where t.batch_id = b.id on conflict do nothing;
  insert into public.batch_sessions(batch_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
  select nb, s.weekday, s.slot, s.start_time, s.end_time, s.session_type, s.room_id, s.sort from public.batch_sessions s where s.batch_id = b.id;
  insert into public.batch_unit_overrides(batch_id, intake_unit_id, start_date, end_date)
  select nb, m.new_id, o.start_date + v_delta, o.end_date + v_delta from public.batch_unit_overrides o join rto_auto_unit_map m on m.old_id = o.intake_unit_id where o.batch_id = b.id;
  -- Dated classes: the generator is for RTO Managers; for anyone else staff generate them from the batch later.
  if b.is_active and exists (select 1 from public.batch_sessions where batch_id = nb) and coalesce(public.cms_is_rto_manager(), false) then
   begin
    perform public.rto_class_sessions_generate(nb);
   exception when others then
    raise warning 'rto_intake_auto_next: classes for batch % not generated: %', b.name, sqlerrm;
   end;
  end if;
 end loop;
 perform set_config('rto.course', v_was, true);
 return v_new;
end $$;

-- As in 20261117130000, plus: the intake after the student's latest one is made when missing, and further intakes while units
-- are still owed (at most four).
create or replace function public.rto_carry_over_plan(p_student uuid, p_course text) returns void
language plpgsql security definer set search_path = public as $$
declare v_today date := public.course_intake_today(); v_was text := coalesce(current_setting('rto.carry_over_planning', true), '');
 l record; n record; v_out text[]; v_free date; v_prev uuid; v_enrol uuid; v_batch uuid; v_units text[]; v_from date; v_to date; v_keep uuid[] := '{}'; v_go boolean := true;
 v_seen uuid[] := '{}'; v_round integer; v_latest uuid;
begin
 if p_student is null or p_course is null then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('rto_carry_over:' || p_student::text || ':' || p_course, 0));
 perform set_config('rto.carry_over_planning', 'on', true);

 -- The student's latest enrolment that is not a carry-over still waiting to start: the path continues from it.
 select e.id, e.status, e.carry_over, e.enrolment_type, e.batch_id, b.name as batch_name, ci.id as intake_id, ci.start_date, ci.study_load into l
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
  -- The batch keeps going: the intake after the one the student is in exists from now on.
  perform public.rto_intake_auto_next(l.intake_id);
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

  for v_round in 1..5 loop
   for n in select ci.id from public.course_intakes ci
    where ci.course_id = p_course and ci.is_active and ci.study_load = l.study_load and ci.start_date > l.start_date and ci.id <> all(v_seen)
    order by ci.start_date, ci.id loop
    exit when cardinality(v_out) = 0;
    v_seen := v_seen || n.id;
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
   exit when cardinality(v_out) = 0 or v_round = 5;
   -- Units still owed after every intake there is: make the next one after the latest.
   select ci.id into v_latest from public.course_intakes ci where ci.course_id = p_course and ci.study_load = l.study_load
   order by ci.start_date desc, ci.id limit 1;
   exit when public.rto_intake_auto_next(v_latest) is null;
  end loop;
 end if;

 -- Carry-overs that have not started and are no longer needed.
 delete from public.batch_enrolments e using public.batches b, public.course_intakes ci
 where b.id = e.batch_id and ci.id = b.intake_id and ci.course_id = p_course and e.student_id = p_student
  and public.rto_enrolment_pending(e) and e.id <> all(v_keep);
 perform set_config('rto.carry_over_planning', v_was, true);
end $$;

revoke all on function public.rto_intake_auto_next(uuid), public.rto_carry_over_plan(uuid, text) from public, anon, authenticated;

commit;
