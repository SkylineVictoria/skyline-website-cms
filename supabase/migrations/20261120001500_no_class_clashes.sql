-- SESSION-ROOM-TRAINER + NO-CLASH (owner, 2026-11-19).
-- 1. Each weekly class time (morning / afternoon / evening of a day) has its own room and trainer: intake_class_times.trainer_id,
--    copied onto the dated classes (class_sessions.trainer_id, room_id) when they are created and when the week changes. A room or
--    trainer is busy only during that class: free for the intake's other parts of the day and for other intakes.
--    Who teaches a class: its own trainer, else the unit's trainer, else the intake's trainers (older classes).
-- 2. The database refuses: two classes of one intake overlapping; a room used by two classes at the same time; a trainer
--    teaching two classes at the same time; the Prerequisite class clashing (room / trainer) with weekly class times; a student
--    placed in an intake whose classes overlap classes of another intake they study in. Hosted had none of these (2026-11-19).
-- Additive; one transaction.
begin;

alter table public.intake_class_times add column if not exists trainer_id uuid;
alter table public.class_sessions add column if not exists trainer_id uuid;

-- Who teaches: the class's own trainer, else the unit's trainer, else the intake's trainers.
create or replace function public.class_session_trainer_ids(p_intake uuid, p_unit text) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select array[iu.trainer_id] from public.intake_units iu where iu.intake_id = p_intake and iu.unit_id = p_unit and iu.trainer_id is not null limit 1),
    (select array_agg(t.staff_id) from public.intake_trainers t where t.intake_id = p_intake),
    '{}'::uuid[]);
$$;
create or replace function public.session_trainer_ids(p_trainer uuid, p_intake uuid, p_unit text) returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when p_trainer is not null then array[p_trainer] else public.class_session_trainer_ids(p_intake, p_unit) end;
$$;
create or replace function public.session_trainers_json(p_trainer uuid, p_intake uuid, p_unit text) returns jsonb
language sql stable security definer set search_path = public, hr as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)) order by p.first_name), '[]'::jsonb)
    from hr.staff_profiles p where p.id = any(public.session_trainer_ids(p_trainer, p_intake, p_unit));
$$;

-- A dated class takes the room and trainer of its weekly class time (same weekday and start) when it has none.
create or replace function public.class_sessions_from_week() returns trigger
language plpgsql security definer set search_path = public as $$
declare w record;
begin
  if new.trainer_id is null or new.room_id is null then
    select t.trainer_id, t.room_id into w from public.intake_class_times t
     where t.intake_id = new.intake_id and t.weekday = extract(isodow from new.session_date) and t.start_time = new.start_time limit 1;
    if found then
      new.trainer_id := coalesce(new.trainer_id, w.trainer_id);
      new.room_id := coalesce(new.room_id, w.room_id);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists class_sessions_a_from_week on public.class_sessions;
create trigger class_sessions_a_from_week before insert on public.class_sessions for each row execute function public.class_sessions_from_week();

-- Changing a weekly class time's room or trainer moves the coming classes (not hand-made ones) with it.
create or replace function public.intake_class_times_to_classes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.class_sessions cs set trainer_id = new.trainer_id, room_id = coalesce(new.room_id, cs.room_id), updated_at = now()
   where cs.intake_id = new.intake_id and extract(isodow from cs.session_date) = new.weekday and cs.start_time = new.start_time
     and cs.session_date >= current_date and not coalesce(cs.is_manual, false) and cs.status <> 'cancelled'
     and (cs.trainer_id is distinct from new.trainer_id or (new.room_id is not null and cs.room_id is distinct from new.room_id));
  return null;
end $$;
drop trigger if exists intake_class_times_to_classes on public.intake_class_times;
create trigger intake_class_times_to_classes after insert or update of trainer_id, room_id, start_time, weekday on public.intake_class_times
  for each row execute function public.intake_class_times_to_classes();

-- The clash check of one class (its own room / trainer, else the intake's).
drop function if exists public.class_session_clash(uuid, uuid, text, uuid, date, time, time);
create or replace function public.class_session_clash(p_id uuid, p_intake uuid, p_unit text, p_room uuid, p_trainer uuid, p_date date, p_start time, p_end time)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_room uuid; v_tr uuid[]; c record;
begin
  v_room := coalesce(p_room, (select classroom_id from public.course_intakes where id = p_intake));
  v_tr := public.session_trainer_ids(p_trainer, p_intake, p_unit);
  for c in select x.*, coalesce(x.room_id, ci.classroom_id) as room, ci.course_id, public.intake_group_name(ci.id) as group_name
             from public.class_sessions x join public.course_intakes ci on ci.id = x.intake_id
            where x.session_date = p_date and x.id is distinct from p_id and x.status <> 'cancelled'
              and x.start_time < p_end and p_start < x.end_time loop
    if c.intake_id = p_intake then
      return format('This intake already has a class on %s from %s to %s.', to_char(p_date, 'DD Mon YYYY'), to_char(c.start_time, 'HH24:MI'), to_char(c.end_time, 'HH24:MI'));
    elsif v_room is not null and c.room = v_room then
      return format('The room is already used on %s from %s to %s by %s (%s).', to_char(p_date, 'DD Mon YYYY'), to_char(c.start_time, 'HH24:MI'), to_char(c.end_time, 'HH24:MI'),
        c.group_name, (select code from public.cms_courses where id = c.course_id));
    elsif cardinality(v_tr) > 0 and public.session_trainer_ids(c.trainer_id, c.intake_id, c.unit_id) && v_tr then
      return format('The trainer already teaches on %s from %s to %s: %s (%s).', to_char(p_date, 'DD Mon YYYY'), to_char(c.start_time, 'HH24:MI'), to_char(c.end_time, 'HH24:MI'),
        c.group_name, (select code from public.cms_courses where id = c.course_id));
    end if;
  end loop;
  return null;
end $$;

create or replace function public.class_sessions_no_clash() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_problem text;
begin
  if new.status = 'cancelled' then return new; end if;
  v_problem := public.class_session_clash(new.id, new.intake_id, new.unit_id, new.room_id, new.trainer_id, new.session_date, new.start_time, new.end_time);
  if v_problem is not null then raise exception '%', v_problem using errcode = '23P01'; end if;
  return new;
end $$;
drop trigger if exists class_sessions_no_clash on public.class_sessions;
create trigger class_sessions_no_clash before insert or update of session_date, start_time, end_time, room_id, trainer_id, intake_id, unit_id, status
  on public.class_sessions for each row execute function public.class_sessions_no_clash();

-- An intake's room or trainers changing: its coming classes without their own room / trainer are checked again.
create or replace function public.intake_group_no_clash() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_intake uuid := case when tg_table_name = 'course_intakes' then new.id else new.intake_id end; c record; v_problem text;
begin
  for c in select * from public.class_sessions where intake_id = v_intake and status <> 'cancelled' and session_date >= current_date loop
    v_problem := public.class_session_clash(c.id, c.intake_id, c.unit_id, c.room_id, c.trainer_id, c.session_date, c.start_time, c.end_time);
    if v_problem is not null then raise exception '%', v_problem using errcode = '23P01'; end if;
  end loop;
  return null;
end $$;
drop trigger if exists course_intakes_no_clash on public.course_intakes;
create constraint trigger course_intakes_no_clash after update of classroom_id on public.course_intakes
  deferrable initially deferred for each row execute function public.intake_group_no_clash();
drop trigger if exists intake_trainers_no_clash on public.intake_trainers;
create constraint trigger intake_trainers_no_clash after insert on public.intake_trainers
  deferrable initially deferred for each row execute function public.intake_group_no_clash();

-- The Prerequisite class's weekly times against intakes' weekly times (room or trainer, intakes not ended) and other courses'
-- Prerequisite classes.
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
      if pc.trainer_id is not null and (g.trainer_id = pc.trainer_id or (g.trainer_id is null and (
            pc.trainer_id in (select staff_id from public.intake_trainers where intake_id = g.gid)
            or pc.trainer_id in (select trainer_id from public.intake_units where intake_id = g.gid and trainer_id is not null)))) then
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
  if tg_table_name = 'prereq_classes' then v_problem := public.prereq_class_clash(new.id);
  elsif tg_table_name = 'prereq_class_times' then v_problem := public.prereq_class_clash(new.class_id);
  else
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

-- A student is never in two classes at once across the intakes they study in.
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

-- Readers: the week's class times carry their trainer; the class's own trainer is shown and counts for the trainer's classes.
create or replace function public.rto_batch_sessions_json(p_batch uuid)
 returns jsonb language sql stable security definer set search_path to 'public' as $function$
 select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'weekday', s.weekday, 'slot', s.slot, 'startTime', to_char(s.start_time, 'HH24:MI'),
   'endTime', to_char(s.end_time, 'HH24:MI'), 'type', s.session_type, 'roomId', s.room_id, 'room', r.name, 'locationId', l.id, 'location', l.name,
   'trainerId', s.trainer_id)
   order by s.weekday, s.start_time, s.sort), '[]'::jsonb)
 from public.intake_class_times s left join public.classrooms r on r.id = s.room_id left join public.locations l on l.id = r.location_id
 where s.intake_id = p_batch;
$function$;

create or replace function public.lms_session_trainer(p_session uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $function$
  select exists (select 1 from public.class_sessions cs
    where cs.id = p_session and public.asm_trainer_profile() is not null
      and public.asm_trainer_profile() = any(public.session_trainer_ids(cs.trainer_id, cs.intake_id, cs.unit_id)));
$function$;

create or replace function public.my_class_schedule(p_from date, p_to date)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'hr' as $function$
declare v_student uuid := public.portal_student_id(); v_staff uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 120 then raise exception 'Choose up to 120 days' using errcode = '22023'; end if;
  if v_student is null then v_staff := public.asm_trainer_profile(); end if;
  if v_student is null and v_staff is null then raise exception 'Student or staff access required' using errcode = '42501'; end if;
  return jsonb_build_object('role', case when v_student is not null then 'student' else 'trainer' end, 'sessions', coalesce((
    select jsonb_agg(jsonb_build_object('id', cs.id, 'date', cs.session_date, 'start', to_char(cs.start_time, 'HH24:MI'), 'end', to_char(cs.end_time, 'HH24:MI'),
      'type', cs.session_type, 'status', cs.status, 'batchName', public.intake_group_name(ci.id), 'courseName', coalesce(nullif(c.name, ''), c.code), 'courseCode', c.code,
      'unitCode', u.code, 'unitName', u.name, 'room', r.name, 'campus', r.campus,
      'trainers', coalesce((select string_agg(x->>'name', ', ') from jsonb_array_elements(public.session_trainers_json(cs.trainer_id, ci.id, cs.unit_id)) x), ''))
      order by cs.session_date, cs.start_time)
    from public.class_sessions cs
    join public.course_intakes ci on ci.id = cs.intake_id
    join public.cms_courses c on c.id = ci.course_id
    left join public.cms_course_units u on u.id = cs.unit_id
    left join public.classrooms r on r.id = coalesce(cs.room_id, ci.classroom_id)
    where cs.session_date between p_from and p_to
      and (case when v_student is not null then exists (select 1 from public.intake_enrolments e where e.intake_id = ci.id and e.student_id = v_student and e.status in ('active', 'deferred')
            and (cs.unit_id is null or exists (select 1 from public.rto_enrolment_units(e.id) eu where eu.unit_id = cs.unit_id)))
        else v_staff = any(public.session_trainer_ids(cs.trainer_id, ci.id, cs.unit_id)) end)), '[]'::jsonb));
end;
$function$;

create or replace function public.rto_class_sessions_list(p_batch uuid, p_from date, p_to date)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'hr' as $function$
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
  raise exception 'Choose a date range of up to 400 days.' using errcode = '22023'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id', c.id, 'batchId', c.intake_id, 'batch', g.name, 'courseCode', co.code, 'date', c.session_date,
   'startTime', c.start_time, 'endTime', c.end_time, 'type', c.session_type, 'roomId', c.room_id, 'room', r.name,
   'unitId', c.unit_id, 'unitCode', u.code, 'unitName', u.name, 'status', c.status, 'manual', c.is_manual, 'trainerId', c.trainer_id,
   'trainers', coalesce((select string_agg(x->>'name', ', ') from jsonb_array_elements(public.session_trainers_json(c.trainer_id, c.intake_id, c.unit_id)) x), ''))
   order by c.session_date, c.start_time, g.name)
  from public.class_sessions c
  join public.course_intakes i on i.id = c.intake_id
  cross join lateral (select public.intake_group_name(c.intake_id) as name) g
  join public.cms_courses co on co.id = i.course_id
  left join public.classrooms r on r.id = c.room_id
  left join public.cms_course_units u on u.id = c.unit_id
  where (p_batch is null or c.intake_id = p_batch) and c.session_date between p_from and p_to), '[]'::jsonb);
end $function$;

-- admin_class_calendar and admin_calendar_people: the class's own trainer first; rto_course_flow batch_setup saves each class
-- time's trainer. Patched in place (exact text, checked).
do $do$
declare d text; n text;
begin
  d := pg_get_functiondef('public.admin_class_calendar(date,date,jsonb)'::regprocedure);
  n := replace(d, $a$select s.id session_id, coalesce(
        (select jsonb_agg(distinct jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)))
          from public.intake_units iu join hr.staff_profiles p on p.id = iu.trainer_id
          where iu.intake_id = s.intake_id and iu.unit_id = s.unit_id),
        (select jsonb_agg(distinct jsonb_build_object('id', p.id, 'name', btrim(p.first_name || ' ' || p.last_name)))
          from public.intake_trainers it join hr.staff_profiles p on p.id = it.staff_id where it.intake_id = s.intake_id),
        '[]'::jsonb) trainers$a$, $b$select s.id session_id, public.session_trainers_json(s.trainer_id, s.intake_id, s.unit_id) trainers$b$);
  if n = d then raise exception 'admin_class_calendar: trainer text not found'; end if;
  execute n;

  d := pg_get_functiondef('public.admin_calendar_people()'::regprocedure);
  n := replace(d, $a$(select staff_id from public.intake_trainers union select trainer_id from public.intake_units where trainer_id is not null)$a$,
    $b$(select staff_id from public.intake_trainers union select trainer_id from public.intake_units where trainer_id is not null
        union select trainer_id from public.intake_class_times where trainer_id is not null)$b$);
  if n = d then raise exception 'admin_calendar_people: trainer text not found'; end if;
  execute n;

  d := pg_get_functiondef('public.rto_course_flow(text,jsonb)'::regprocedure);
  n := replace(d, $a$insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort)
     values (b.id, v_wd, public.rto_slot(v_st), v_st, v_et, coalesce(nullif(v_s->>'type', ''), 'theory'), nullif(v_s->>'roomId', '')::uuid, v_count);$a$,
    $b$insert into public.intake_class_times(intake_id, weekday, slot, start_time, end_time, session_type, room_id, sort, trainer_id)
     values (b.id, v_wd, public.rto_slot(v_st), v_st, v_et, coalesce(nullif(v_s->>'type', ''), 'theory'), nullif(v_s->>'roomId', '')::uuid, v_count, nullif(v_s->>'trainerId', '')::uuid);$b$);
  if n = d then raise exception 'rto_course_flow: batch_setup insert not found'; end if;
  execute n;
end $do$;

revoke all on function public.class_session_clash(uuid, uuid, text, uuid, uuid, date, time, time), public.class_sessions_no_clash(),
  public.intake_group_no_clash(), public.prereq_class_clash(uuid), public.prereq_class_no_clash(), public.class_sessions_from_week(),
  public.intake_class_times_to_classes(), public.enrolment_class_slots(uuid), public.intake_enrolments_no_clash(),
  public.class_session_trainer_ids(uuid, text), public.session_trainer_ids(uuid, uuid, text) from public, anon;
grant execute on function public.session_trainers_json(uuid, uuid, text) to authenticated;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261120001500', 'no_class_clashes', array['see repo file']) on conflict do nothing;
commit;
