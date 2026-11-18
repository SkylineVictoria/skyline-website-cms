-- NO-CLASH (owner, 2026-11-19: "make sure no duplicates for all so no conflicts in classes"). The database refuses:
--   1. two classes of one intake overlapping on the same day;
--   2. a room used by two intakes at the same time (a class's room, else its intake's room);
--   3. a trainer teaching two intakes at the same time (the unit's trainer, else the intake's trainers);
--   4. the Prerequisite class's weekly times clashing (room or trainer) with an intake's weekly class times, or with another
--      course's Prerequisite class;
--   5. a student placed in an intake whose classes overlap classes of another intake they study in.
-- Hosted had none of these when added (checked 2026-11-19). Cancelled classes never clash. Checks 4 and 5 run at the end of the
-- transaction (deferred), so a save that deletes and re-inserts times is judged on its final state.
begin;

create or replace function public.class_session_trainer_ids(p_intake uuid, p_unit text) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select array[iu.trainer_id] from public.intake_units iu where iu.intake_id = p_intake and iu.unit_id = p_unit and iu.trainer_id is not null limit 1),
    (select array_agg(t.staff_id) from public.intake_trainers t where t.intake_id = p_intake),
    '{}'::uuid[]);
$$;

create or replace function public.class_session_clash(p_id uuid, p_intake uuid, p_unit text, p_room uuid, p_date date, p_start time, p_end time)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_room uuid; v_tr uuid[]; c record;
begin
  v_room := coalesce(p_room, (select classroom_id from public.course_intakes where id = p_intake));
  v_tr := public.class_session_trainer_ids(p_intake, p_unit);
  for c in select x.*, coalesce(x.room_id, ci.classroom_id) as room, ci.course_id, public.intake_group_name(ci.id) as group_name
             from public.class_sessions x join public.course_intakes ci on ci.id = x.intake_id
            where x.session_date = p_date and x.id is distinct from p_id and x.status <> 'cancelled'
              and x.start_time < p_end and p_start < x.end_time loop
    if c.intake_id = p_intake then
      return format('This intake already has a class on %s from %s to %s.', to_char(p_date, 'DD Mon YYYY'), to_char(c.start_time, 'HH24:MI'), to_char(c.end_time, 'HH24:MI'));
    elsif v_room is not null and c.room = v_room then
      return format('The room is already used on %s from %s to %s by %s (%s).', to_char(p_date, 'DD Mon YYYY'), to_char(c.start_time, 'HH24:MI'), to_char(c.end_time, 'HH24:MI'),
        c.group_name, (select code from public.cms_courses where id = c.course_id));
    elsif cardinality(v_tr) > 0 and public.class_session_trainer_ids(c.intake_id, c.unit_id) && v_tr then
      return format('The trainer already teaches on %s from %s to %s: %s (%s).', to_char(p_date, 'DD Mon YYYY'), to_char(c.start_time, 'HH24:MI'), to_char(c.end_time, 'HH24:MI'),
        c.group_name, (select code from public.cms_courses where id = c.course_id));
    end if;
  end loop;
  return null;
end $$;

-- 1-3 on every class saved.
create or replace function public.class_sessions_no_clash() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_problem text;
begin
  if new.status = 'cancelled' then return new; end if;
  v_problem := public.class_session_clash(new.id, new.intake_id, new.unit_id, new.room_id, new.session_date, new.start_time, new.end_time);
  if v_problem is not null then raise exception '%', v_problem using errcode = '23P01'; end if;
  return new;
end $$;
drop trigger if exists class_sessions_no_clash on public.class_sessions;
create trigger class_sessions_no_clash before insert or update of session_date, start_time, end_time, room_id, intake_id, unit_id, status
  on public.class_sessions for each row execute function public.class_sessions_no_clash();

-- 2-3 when an intake's room or trainers change (classes without their own room use the intake's room).
create or replace function public.intake_group_no_clash() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_intake uuid := case when tg_table_name = 'course_intakes' then new.id else new.intake_id end; c record; v_problem text;
begin
  for c in select * from public.class_sessions where intake_id = v_intake and status <> 'cancelled' and session_date >= current_date loop
    v_problem := public.class_session_clash(c.id, c.intake_id, c.unit_id, c.room_id, c.session_date, c.start_time, c.end_time);
    if v_problem is not null then raise exception '%', v_problem using errcode = '23P01'; end if;
  end loop;
  return null;
end $$;
drop trigger if exists course_intakes_no_clash on public.course_intakes;
create constraint trigger course_intakes_no_clash after update of classroom_id on public.course_intakes
  deferrable initially deferred for each row when (new.classroom_id is distinct from old.classroom_id) execute function public.intake_group_no_clash();
drop trigger if exists intake_trainers_no_clash on public.intake_trainers;
create constraint trigger intake_trainers_no_clash after insert on public.intake_trainers
  deferrable initially deferred for each row execute function public.intake_group_no_clash();

-- 4. Prerequisite class weekly times against intakes' weekly times (intakes not ended) and other Prerequisite classes.
create or replace function public.prereq_class_clash(p_class uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare pc public.prereq_classes; t record; g record;
begin
  select * into pc from public.prereq_classes where id = p_class;
  if pc.id is null then return null; end if;
  for t in select x.*, coalesce(x.room_id, pc.room_id) as room from public.prereq_class_times x where x.class_id = pc.id loop
    for g in select ct.*, coalesce(ct.room_id, ci.classroom_id) as room, ci.id as gid, ci.course_id
               from public.intake_class_times ct join public.course_intakes ci on ci.id = ct.intake_id
              where ct.weekday = t.weekday and ct.start_time < t.end_time and t.start_time < ct.end_time
                and coalesce(ci.end_date, ci.start_date) >= current_date and coalesce(ci.status, 'open') <> 'closed' loop
      if t.room is not null and g.room = t.room then
        return format('The Prerequisite class room is already used on %s %s-%s by %s (%s).', to_char(date '2024-01-01' + (t.weekday - 1), 'FMDay'),
          to_char(g.start_time, 'HH24:MI'), to_char(g.end_time, 'HH24:MI'), public.intake_group_name(g.gid), (select code from public.cms_courses where id = g.course_id));
      end if;
      if pc.trainer_id is not null and (pc.trainer_id in (select staff_id from public.intake_trainers where intake_id = g.gid)
          or pc.trainer_id in (select trainer_id from public.intake_units where intake_id = g.gid and trainer_id is not null)) then
        return format('The Prerequisite class trainer already teaches on %s %s-%s: %s (%s).', to_char(date '2024-01-01' + (t.weekday - 1), 'FMDay'),
          to_char(g.start_time, 'HH24:MI'), to_char(g.end_time, 'HH24:MI'), public.intake_group_name(g.gid), (select code from public.cms_courses where id = g.course_id));
      end if;
    end loop;
    if exists (select 1 from public.prereq_class_times o join public.prereq_classes op on op.id = o.class_id
                where op.id <> pc.id and o.weekday = t.weekday and o.start_time < t.end_time and t.start_time < o.end_time
                  and ((t.room is not null and coalesce(o.room_id, op.room_id) = t.room) or (pc.trainer_id is not null and op.trainer_id = pc.trainer_id))) then
      return 'Another course''s Prerequisite class uses the same room or trainer at that time.';
    end if;
  end loop;
  return null;
end $$;

create or replace function public.prereq_class_no_clash() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_problem text; v_class uuid;
begin
  if tg_table_name = 'prereq_classes' then
    v_problem := public.prereq_class_clash(new.id);
  elsif tg_table_name = 'prereq_class_times' then
    v_problem := public.prereq_class_clash(new.class_id);
  else
    -- an intake's weekly times or trainers changed: check every Prerequisite class
    for v_class in select id from public.prereq_classes loop
      v_problem := public.prereq_class_clash(v_class);
      exit when v_problem is not null;
    end loop;
  end if;
  if v_problem is not null then raise exception '%', v_problem using errcode = '23P01'; end if;
  return null;
end $$;
drop trigger if exists prereq_classes_no_clash on public.prereq_classes;
create constraint trigger prereq_classes_no_clash after insert or update of room_id, trainer_id on public.prereq_classes
  deferrable initially deferred for each row execute function public.prereq_class_no_clash();
drop trigger if exists prereq_class_times_no_clash on public.prereq_class_times;
create constraint trigger prereq_class_times_no_clash after insert or update on public.prereq_class_times
  deferrable initially deferred for each row execute function public.prereq_class_no_clash();
drop trigger if exists intake_class_times_prereq_no_clash on public.intake_class_times;
create constraint trigger intake_class_times_prereq_no_clash after insert or update on public.intake_class_times
  deferrable initially deferred for each row execute function public.prereq_class_no_clash();

-- 5. A student is never in two classes at once across the intakes they study in.
create or replace function public.enrolment_class_slots(p_enrolment uuid)
returns table(session_date date, start_time time, end_time time, intake_id uuid)
language sql stable security definer set search_path = public as $$
  select cs.session_date, cs.start_time, cs.end_time, cs.intake_id
    from public.intake_enrolments e
    join public.rto_enrolment_units(e.id) u on true
    join public.class_sessions cs on cs.intake_id = e.intake_id and cs.unit_id = u.unit_id and cs.status <> 'cancelled'
     and cs.session_date between u.start_date and u.end_date
   where e.id = p_enrolment;
$$;

create or replace function public.intake_enrolments_no_clash() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record; c record;
begin
  if new.status <> 'active' then return null; end if;
  for o in select e.id from public.intake_enrolments e where e.student_id = new.student_id and e.id <> new.id and e.status = 'active' loop
    select a.session_date, a.start_time, a.end_time, b.intake_id into c
      from public.enrolment_class_slots(new.id) a join public.enrolment_class_slots(o.id) b
        on b.session_date = a.session_date and b.start_time < a.end_time and a.start_time < b.end_time
     limit 1;
    if found then
      raise exception 'This student already has a class on % from % to % (%): two intakes cannot overlap for one student.',
        to_char(c.session_date, 'DD Mon YYYY'), to_char(c.start_time, 'HH24:MI'), to_char(c.end_time, 'HH24:MI'), public.intake_group_name(c.intake_id)
        using errcode = '23P01';
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists intake_enrolments_no_clash on public.intake_enrolments;
create constraint trigger intake_enrolments_no_clash after insert or update of status, intake_id, enrolled_on on public.intake_enrolments
  deferrable initially deferred for each row execute function public.intake_enrolments_no_clash();

revoke all on function public.class_session_clash(uuid, uuid, text, uuid, date, time, time), public.class_sessions_no_clash(),
  public.intake_group_no_clash(), public.prereq_class_clash(uuid), public.prereq_class_no_clash(),
  public.enrolment_class_slots(uuid), public.intake_enrolments_no_clash(), public.class_session_trainer_ids(uuid, text) from public, anon;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261120001500', 'no_class_clashes', array['see repo file']) on conflict do nothing;
commit;
