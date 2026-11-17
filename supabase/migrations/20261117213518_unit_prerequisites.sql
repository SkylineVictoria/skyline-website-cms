-- UNIT-PREREQUISITES: prerequisite units are taught first, and a student never takes a unit before its prerequisite.
-- A unit's prerequisites are read from its Training.gov.au text (cms_course_units.tga_prerequisites, filled by the course
-- sync): every active unit of the same course whose code appears in that text. Nothing is typed in by hand.
--  * A new or re-laid intake timeline puts prerequisite units first, then the other units in the course's own order.
--  * A student who joins after a prerequisite unit has ended does not take the units that need it in that intake (unless they
--    are already Competent in it). Those units are owed, so the rolling carry-over places them in the next intake.
--  * The carry-over planner places a unit only when its owed prerequisites come before it in the same intake; otherwise the
--    unit waits for a later intake.
-- Existing timelines keep their order until an intake is laid out again. A prerequisite scheduled after the unit that needs
-- it (an old timeline) does not remove that unit from students who were in the intake before the prerequisite ended.
-- Additive: four new functions; intake_generate_schedule (as in 20261116140000), rto_enrolment_units (as in 20261117130000)
-- and rto_carry_over_plan (as in 20261117170000) redefined with the prerequisite rules.
-- Rollback (manual): restore those three functions from the migrations named above; drop the four rto_unit_requires*,
-- rto_prereq_ready and rto_course_prereqs functions.

-- The units of the same course that a unit names as prerequisites.
create or replace function public.rto_unit_requires(p_unit text) returns setof text
language sql stable security definer set search_path = public as $$
 select c.id from public.cms_course_units u
 join public.cms_course_units c on c.course_id = u.course_id and c.id <> u.id and c.is_active
 where u.id = p_unit and coalesce(btrim(u.tga_prerequisites), '') <> ''
  and regexp_replace(upper(coalesce(c.code, '')), '[^A-Z0-9]', '', 'g') ~ '^[A-Z]{3,}[A-Z0-9]*[0-9]'
  and upper(u.tga_prerequisites) ~ ('\m' || regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g') || '\M');
$$;

-- Every prerequisite of a unit, through its prerequisites' prerequisites.
create or replace function public.rto_unit_requires_all(p_unit text) returns setof text
language sql stable security definer set search_path = public as $$
 with recursive r(id) as (
  select public.rto_unit_requires(p_unit)
  union
  select q from r cross join lateral public.rto_unit_requires(r.id) q)
 select id from r where id <> p_unit;
$$;

-- Of the units to place in a batch, those whose owed prerequisites come before them in the same placement (null when none).
create or replace function public.rto_prereq_ready(p_batch uuid, p_units text[], p_owed text[]) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare v_set text[] := p_units; v_next text[];
begin
 if v_set is null or cardinality(v_set) = 0 then return null; end if;
 loop
  select array_agg(distinct c.unit_id) into v_next from public.rto_batch_units(p_batch) c
  where c.unit_id = any(v_set) and not exists (
   select 1 from public.rto_unit_requires(c.unit_id) r where r = any(p_owed)
    and not exists (select 1 from public.rto_batch_units(p_batch) p where p.unit_id = r and p.unit_id = any(v_set) and p.end_date < c.start_date));
  if v_next is null then return null; end if;
  exit when cardinality(v_next) = cardinality(v_set);
  v_set := v_next;
 end loop;
 return v_set;
end $$;

-- The units a student takes in an enrolment: a carry-over's listed units; otherwise every unit that had not ended when they
-- joined, except a unit whose prerequisite had already ended in this batch before they joined (unless they were Competent in
-- that prerequisite by the time the unit starts).
create or replace function public.rto_enrolment_units(p_enrolment uuid) returns table(intake_unit_id uuid, unit_id text, start_date date, end_date date, sort integer)
language sql stable security definer set search_path = public as $$
 select u.intake_unit_id, u.unit_id, u.start_date, u.end_date, u.sort
 from public.batch_enrolments e cross join lateral public.rto_batch_units(e.batch_id) u
 where e.id = p_enrolment
  and case when e.carry_over then exists(select 1 from public.batch_enrolment_units eu where eu.enrolment_id = e.id and eu.unit_id = u.unit_id)
      else u.end_date >= e.enrolled_on and not exists (
       select 1 from public.rto_unit_requires_all(u.unit_id) r
       join public.rto_batch_units(e.batch_id) p on p.unit_id = r
       where p.end_date < e.enrolled_on
        and not exists (select 1 from public.rto_unit_outcome(e.student_id, r) o where o.outcome = 'C' and o.signed_on <= u.start_date)) end;
$$;

-- A course's units and the units each needs first ({unitId: [{id, code}]}), for the CMS. Staff only.
create or replace function public.rto_course_prereqs(p_course text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 return coalesce((select jsonb_object_agg(u.id, x.needs) from public.cms_course_units u
  cross join lateral (select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code) order by c.code) as needs
   from public.cms_course_units c where c.id in (select public.rto_unit_requires(u.id))) x
  where u.course_id = p_course and x.needs is not null), '{}'::jsonb);
end $$;

-- As in 20261116140000, with prerequisite units first.
create or replace function public.intake_generate_schedule(p_intake uuid, p_start date, p_units text[], p_end date) returns date
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; u record; d date; days integer; n integer := 0; total integer := 0; per integer; extra integer; last_end date; k integer := 0; cnt integer;
 v_rate numeric;
begin
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 v_rate := case when i.study_load = 'voe' then 2 else 1 end;
 -- Term breaks of this course (and breaks for all courses) apply: rto_is_working_day reads rto.course.
 perform set_config('rto.course', i.course_id, true);
 select count(*) into cnt from public.cms_course_units where course_id = i.course_id and is_active and (p_units is null or unit_type = 'core' or id = any(p_units));
 if p_end is not null then
  if p_end < p_start then raise exception 'The end date is before the start date.' using errcode = '22023'; end if;
  d := public.rto_next_working_day(p_start);
  while d <= p_end loop total := total + 1; d := public.rto_next_working_day(d + 1); end loop;
  if cnt > 0 and total < cnt then raise exception 'There are % working days for % units; choose a later end date or fewer units.', total, cnt using errcode = '22023'; end if;
  per := case when cnt > 0 then total / cnt else 0 end; extra := case when cnt > 0 then total % cnt else 0 end;
 end if;
 delete from public.intake_units where intake_id = p_intake;
 d := public.rto_next_working_day(p_start); last_end := p_start;
 -- Prerequisite units first (a unit other units need, deepest chain last), then the rest in the course's own order.
 for u in select cu.* from public.cms_course_units cu
  where cu.course_id = i.course_id and cu.is_active and (p_units is null or cu.unit_type = 'core' or cu.id = any(p_units))
  order by (exists(select 1 from public.cms_course_units d where d.course_id = cu.course_id and d.is_active and d.id <> cu.id
    and (p_units is null or d.unit_type = 'core' or d.id = any(p_units))
    and cu.id in (select public.rto_unit_requires(d.id)))) desc,
   (select count(*) from public.rto_unit_requires_all(cu.id)), cu.sort, cu.code loop
  n := n + 1;
  days := case when p_end is null then greatest(1, round(coalesce(u.duration_weeks, u.default_weeks) * 5 / v_rate)::integer) else per + case when n <= extra then 1 else 0 end end;
  last_end := d; k := days;
  while k > 1 loop last_end := public.rto_next_working_day(last_end + 1); k := k - 1; end loop;
  insert into public.intake_units(intake_id, unit_id, start_date, end_date, hours, sort) values (p_intake, u.id, d, last_end, u.nominal_hours, n);
  d := public.rto_next_working_day(last_end + 1);
 end loop;
 update public.course_intakes set start_date = p_start,
  end_date = case when p_end is not null then p_end when n > 0 then last_end else coalesce(end_date, p_start) end, updated_at = now()
 where id = p_intake;
 return coalesce(p_end, last_end);
end $$;

-- As in 20261117170000, placing a unit only after its owed prerequisites.
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
   -- A unit waits until its owed prerequisites come first.
   v_units := public.rto_prereq_ready(l.batch_id, v_units, v_out);
   select max(u.end_date) into v_to from public.rto_batch_units(l.batch_id) u where u.unit_id = any(v_units);
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
    -- A unit waits until its owed prerequisites come first (in this intake before it, else in a later intake).
    v_units := public.rto_prereq_ready(v_batch, v_units, v_out);
    select min(u.start_date), max(u.end_date) into v_from, v_to from public.rto_batch_units(v_batch) u where u.unit_id = any(v_units);
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

do $$ declare f text; begin
 foreach f in array array['rto_unit_requires(text)', 'rto_unit_requires_all(text)', 'rto_prereq_ready(uuid, text[], text[])', 'rto_course_prereqs(text)'] loop
  execute format('revoke all on function public.%s from public, anon', f);
 end loop;
 grant execute on function public.rto_course_prereqs(text) to authenticated;
end $$;
