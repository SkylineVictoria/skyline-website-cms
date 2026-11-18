-- MASTER-TIMETABLE stage 2, part 1 (owner, 2026-11-18): the intakes of a course follow its master timetable.
-- For a course with a saved master (course_master_timetables):
--  * every intake that is not closed has the master's unit dates (intake_units updated in place by unit, so attendance registers,
--    unit trainers and a batch's own dates keep their rows; units missing are added, units no longer in the master removed) and the
--    master's first and last day. Saving the master applies it to every such intake and plans the batches' dated classes again.
--  * the unit timeline generator (intake_generate_schedule: a new intake, a changed start date, CoE / VoE) uses the master instead
--    of laying the units out itself, so an intake cannot drift from the master.
--  * several intakes can start on the same day (they are groups on one calendar): the rule "one intake per course and start
--    date" (course_intakes_unique) is removed.
--  * no "next intake" is made automatically (rto_intake_auto_next returns nothing): the following cycle comes from the master (stage 3).
--  * the enrolment form offers every open intake that has not ended (course_intake_offered), not only "running + next".
-- A course without a master works exactly as before.
-- Until stage 3: a student who joins a master course after a prerequisite unit has started is placed in the running intake and the
-- units that need that prerequisite stay owed (there is no later intake to take them from).
-- Patched in place on the hosted definitions (intake_generate_schedule, rto_intake_auto_next, rto_master_timetable); new functions
-- course_master_apply_intake, course_master_apply; course_intake_offered replaced.
-- Rollback (manual): remove the three patched lines (each carries the comment marker MASTER-STAGE2); restore course_intake_offered
-- from 20261118214419; drop the two new functions; alter table public.course_intakes add constraint course_intakes_unique
-- unique (course_id, start_date) (only possible while no two intakes of a course share a start date).

begin;

alter table public.course_intakes drop constraint if exists course_intakes_unique;
create index if not exists course_intakes_course_start_idx on public.course_intakes(course_id, start_date);

-- One intake takes the master's unit dates. Returns the master's last day (null when the course has no master).
create or replace function public.course_master_apply_intake(p_intake uuid) returns date
language plpgsql security definer set search_path = public as $$
declare i public.course_intakes; v_first date; v_last date;
begin
 select * into i from public.course_intakes where id = p_intake;
 if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;
 select min(m.start_date), max(m.end_date) into v_first, v_last from public.course_master_units m where m.course_id = i.course_id and m.cycle = 1;
 if v_first is null then return null; end if;
 -- a batch's own unit dates give way to the master
 delete from public.batch_unit_overrides o using public.batches b where b.id = o.batch_id and b.intake_id = p_intake;
 delete from public.intake_units iu where iu.intake_id = p_intake
  and not exists (select 1 from public.course_master_units m where m.course_id = i.course_id and m.cycle = 1 and m.unit_id = iu.unit_id);
 update public.intake_units iu set start_date = m.start_date, end_date = m.end_date, sort = m.sort
 from public.course_master_units m
 where m.course_id = i.course_id and m.cycle = 1 and m.unit_id = iu.unit_id and iu.intake_id = p_intake
  and (iu.start_date <> m.start_date or iu.end_date <> m.end_date or iu.sort <> m.sort);
 insert into public.intake_units(intake_id, unit_id, start_date, end_date, hours, sort)
 select p_intake, m.unit_id, m.start_date, m.end_date, u.nominal_hours, m.sort
 from public.course_master_units m join public.cms_course_units u on u.id = m.unit_id
 where m.course_id = i.course_id and m.cycle = 1
  and not exists (select 1 from public.intake_units iu where iu.intake_id = p_intake and iu.unit_id = m.unit_id);
 update public.course_intakes set start_date = v_first, end_date = v_last, updated_at = now()
 where id = p_intake and (start_date <> v_first or end_date is distinct from v_last);
 return v_last;
end $$;

-- Every intake of the course that is not closed takes the master's dates; the batches' dated classes are planned again when an
-- RTO Manager made the change (the class generator is theirs). Returns how many intakes were updated.
create or replace function public.course_master_apply(p_course text) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; b record; v_n integer := 0;
begin
 if not exists (select 1 from public.course_master_timetables where course_id = p_course) then return 0; end if;
 for r in select id from public.course_intakes where course_id = p_course and coalesce(status, 'open') <> 'closed' order by start_date, id loop
  perform public.course_master_apply_intake(r.id);
  v_n := v_n + 1;
  if coalesce(public.cms_is_rto_manager(), false) then
   for b in select bb.id, bb.name from public.batches bb where bb.intake_id = r.id and bb.is_active
     and exists (select 1 from public.batch_sessions s where s.batch_id = bb.id) loop
    begin
     perform public.rto_class_sessions_generate(b.id);
    exception when others then
     raise warning 'course_master_apply: classes for batch % not planned again: %', b.name, sqlerrm;
    end;
   end loop;
  end if;
 end loop;
 return v_n;
end $$;

-- The master cannot be bypassed: whatever writes an open intake's dates, a unit's dates or its order (a typed start date, the
-- timeline editor, "Duplicate intake", a class timing that extends the intake) gets the master's values for a master course, and a
-- batch of a master course cannot have unit dates of its own.
create or replace function public.course_master_lock_intake() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_first date; v_last date;
begin
 if coalesce(new.status, 'open') = 'closed' then return new; end if;
 select min(m.start_date), max(m.end_date) into v_first, v_last from public.course_master_units m where m.course_id = new.course_id and m.cycle = 1;
 if v_first is not null then new.start_date := v_first; new.end_date := v_last; end if;
 return new;
end $$;
drop trigger if exists course_master_lock_intake on public.course_intakes;
create trigger course_master_lock_intake before insert or update of start_date, end_date, status, course_id on public.course_intakes
 for each row execute function public.course_master_lock_intake();

create or replace function public.course_master_lock_unit() returns trigger
language plpgsql security definer set search_path = public as $$
declare m record;
begin
 select x.start_date, x.end_date, x.sort into m from public.course_master_units x join public.course_intakes ci on ci.course_id = x.course_id
 where ci.id = new.intake_id and coalesce(ci.status, 'open') <> 'closed' and x.cycle = 1 and x.unit_id = new.unit_id;
 if found then new.start_date := m.start_date; new.end_date := m.end_date; new.sort := m.sort; end if;
 return new;
end $$;
drop trigger if exists course_master_lock_unit on public.intake_units;
create trigger course_master_lock_unit before insert or update of start_date, end_date, sort, unit_id on public.intake_units
 for each row execute function public.course_master_lock_unit();

create or replace function public.course_master_lock_override() returns trigger
language plpgsql security definer set search_path = public as $$
begin
 if exists (select 1 from public.batches b join public.course_intakes ci on ci.id = b.intake_id
   join public.course_master_timetables t on t.course_id = ci.course_id where b.id = new.batch_id and coalesce(ci.status, 'open') <> 'closed') then
  raise exception 'This course follows its master timetable: change the unit dates on the course''s Master timetable.' using errcode = '22023';
 end if;
 return new;
end $$;
drop trigger if exists course_master_lock_override on public.batch_unit_overrides;
create trigger course_master_lock_override before insert or update on public.batch_unit_overrides
 for each row execute function public.course_master_lock_override();
revoke all on function public.course_master_lock_intake(), public.course_master_lock_unit(), public.course_master_lock_override() from public, anon, authenticated;

-- The three patches: one line added after a fixed line of each hosted definition.
do $patch$
declare p record; d text;
begin
 for p in select * from (values
  ('public.intake_generate_schedule(uuid,date,text[],date)',
   $a$ if i.id is null then raise exception 'Intake not found' using errcode = 'P0002'; end if;$a$,
   $b$ if exists (select 1 from public.course_master_timetables t where t.course_id = i.course_id) then return public.course_master_apply_intake(p_intake); end if; -- MASTER-STAGE2$b$),
  ('public.rto_intake_auto_next(uuid)',
   $a$ if src.id is null then return null; end if;$a$,
   $b$ if exists (select 1 from public.course_master_timetables t where t.course_id = src.course_id) then return null; end if; -- MASTER-STAGE2$b$),
  ('public.rto_master_timetable(text,jsonb)',
   $a$  select v_course, 1, l.unit_id, l.weeks, l.sort, l.start_date, l.end_date from public.course_master_layout(v_course, v_start, v_rows) l;$a$,
   $b$  perform public.course_master_apply(v_course); -- MASTER-STAGE2$b$)) as t(fn, anchor, added) loop
  d := pg_get_functiondef(p.fn::regprocedure);
  continue when position(p.added in d) > 0;
  if position(p.anchor in d) = 0 then raise exception 'MASTER-STAGE2: anchor not found in %', p.fn; end if;
  execute replace(d, p.anchor, p.anchor || E'\n' || p.added);
 end loop;
end $patch$;

-- As in 20261118214419 for a course without a master; with one, every open intake that has not ended is offered.
create or replace function public.course_intake_offered(p_course text) returns setof uuid
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $function$
  with c as (select public.course_resolve_id(p_course) cid), t as (select public.course_intake_today() d),
  m as (select exists (select 1 from public.course_master_timetables x, c where x.course_id = c.cid) on_master),
  live as (
    select i.* from public.course_intakes i, c where i.course_id = c.cid and i.is_active and coalesce(i.status, 'open') not in ('closed', 'draft'))
  select l.id from live l, t, m where m.on_master and coalesce(l.end_date, l.start_date) >= t.d
  union
  select l.id from live l, t, m where not m.on_master and l.start_date <= t.d and coalesce(l.end_date, l.start_date) >= t.d
  union
  select n.id from (
    select distinct on (l.study_load) l.id from live l, t, m where not m.on_master and l.start_date > t.d order by l.study_load, l.start_date, l.id) n;
$function$;

revoke all on function public.course_master_apply_intake(uuid), public.course_master_apply(text) from public, anon, authenticated;

-- Courses whose master was saved before this migration: their intakes take its dates now (classes are planned again by the next
-- master save or from the batch, since this runs without a signed-in RTO Manager).
do $$
declare r record;
begin
 for r in select course_id from public.course_master_timetables loop
  perform public.course_master_apply(r.course_id);
 end loop;
end $$;

commit;
