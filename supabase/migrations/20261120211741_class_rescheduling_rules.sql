-- CLASS-RESCHEDULE (owner, 2026-11-20): no class is dropped. When a class can't run, staff pick a reason and the
-- system tries the steps an admin set for that reason (Settings: LMS › Timetable settings › Rescheduling rules),
-- in order, and suggests (or applies) the first new time that works. Nothing found: the class waits on
-- "Classes to reschedule" until a person picks a time. Every move is kept in class_session_changes and the
-- intake group is told (email, and text when connected).
--
-- Every candidate passes the same checks: inside the unit's dates (never past the intake's end), a teaching day
-- (no public holiday / term break), room and trainer hours and time off, room seats, and class_session_clash
-- (this intake, the room and the trainer free).

-- 1. Rules: one default set (course_id null) and optional per-course sets.
create table if not exists public.class_reschedule_rules (
  id uuid primary key default gen_random_uuid(),
  course_id text references public.cms_courses(id) on delete cascade,
  rules jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index if not exists class_reschedule_rules_course_idx on public.class_reschedule_rules (coalesce(course_id, ''));
alter table public.class_reschedule_rules enable row level security;
revoke all on public.class_reschedule_rules from anon, authenticated;

create or replace function public.class_reschedule_default_rules() returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'general', jsonb_build_object('allowCancel', false, 'who', 'rto_manager', 'mode', 'suggest', 'unitFinishWithWaiting', false),
    'notify', jsonb_build_object('students', true, 'trainers', true, 'email', true, 'sms', true,
      'subject', 'Class moved: {{unit}}',
      'body', E'Hi,\n\nThe {{unit}} class on {{old}} has moved to {{new}}{{room}}.\n{{note}}\nSkyline Institute of Technology',
      'waitingSubject', 'Class not running: {{unit}}',
      'waitingBody', E'Hi,\n\nThe {{unit}} class on {{old}} will not run at that time. We will send you the new time soon.\n{{note}}\nSkyline Institute of Technology'),
    'reasons', jsonb_build_array(
      jsonb_build_object('key', 'trainer_sick', 'label', 'Trainer sick', 'steps', jsonb_build_array(
        jsonb_build_object('type', 'other_trainer', 'on', true, 'onlyCourseTrainers', true),
        jsonb_build_object('type', 'same_day_other_time', 'on', true, 'earliest', '08:00', 'latest', '21:00'),
        jsonb_build_object('type', 'another_day', 'on', true, 'days', jsonb_build_array(1, 2, 3, 4, 5), 'withinDays', 14, 'earliest', '08:00', 'latest', '21:00'),
        jsonb_build_object('type', 'join_other_intake', 'on', true, 'maxExtraSeats', 6),
        jsonb_build_object('type', 'spread', 'on', true, 'maxExtraMinutes', 60, 'maxClasses', 4, 'addAt', 'end'),
        jsonb_build_object('type', 'online', 'on', false, 'international', false))),
      jsonb_build_object('key', 'room_unavailable', 'label', 'Room unavailable', 'steps', jsonb_build_array(
        jsonb_build_object('type', 'other_room', 'on', true, 'minSeats', 'group'),
        jsonb_build_object('type', 'another_day', 'on', true, 'days', jsonb_build_array(1, 2, 3, 4, 5), 'withinDays', 14, 'earliest', '08:00', 'latest', '21:00'),
        jsonb_build_object('type', 'same_day_other_time', 'on', true, 'earliest', '08:00', 'latest', '21:00'))),
      jsonb_build_object('key', 'public_holiday', 'label', 'Public holiday', 'steps', jsonb_build_array(
        jsonb_build_object('type', 'another_day', 'on', true, 'days', jsonb_build_array(1, 2, 3, 4, 5), 'withinDays', 14, 'earliest', '08:00', 'latest', '21:00'),
        jsonb_build_object('type', 'join_other_intake', 'on', true, 'maxExtraSeats', 6),
        jsonb_build_object('type', 'spread', 'on', true, 'maxExtraMinutes', 60, 'maxClasses', 4, 'addAt', 'end'))),
      jsonb_build_object('key', 'campus_closure', 'label', 'Campus closure', 'steps', jsonb_build_array(
        jsonb_build_object('type', 'another_day', 'on', true, 'days', jsonb_build_array(1, 2, 3, 4, 5, 6), 'withinDays', 21, 'earliest', '08:00', 'latest', '21:00'),
        jsonb_build_object('type', 'online', 'on', false, 'international', false))),
      jsonb_build_object('key', 'other', 'label', 'Other', 'steps', jsonb_build_array(
        jsonb_build_object('type', 'another_day', 'on', true, 'days', jsonb_build_array(1, 2, 3, 4, 5), 'withinDays', 14, 'earliest', '08:00', 'latest', '21:00'),
        jsonb_build_object('type', 'same_day_other_time', 'on', true, 'earliest', '08:00', 'latest', '21:00')))));
$$;

insert into public.class_reschedule_rules(course_id, rules)
  select null, public.class_reschedule_default_rules()
  where not exists (select 1 from public.class_reschedule_rules where course_id is null);

-- The rules in force for a course: its own set, else the default.
create or replace function public.class_reschedule_rules_for(p_course text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select rules from public.class_reschedule_rules where course_id = p_course),
    (select rules from public.class_reschedule_rules where course_id is null),
    public.class_reschedule_default_rules());
$$;

-- 2. Class columns and history.
alter table public.class_sessions add column if not exists needs_reschedule boolean not null default false;
alter table public.class_sessions add column if not exists reschedule_reason text;
alter table public.class_sessions add column if not exists reschedule_note text;
alter table public.class_sessions add column if not exists made_up_by text check (made_up_by in ('spread'));
alter table public.class_sessions add column if not exists joined_session_id uuid references public.class_sessions(id) on delete set null;
alter table public.class_sessions add column if not exists delivery text not null default 'face_to_face' check (delivery in ('face_to_face', 'online'));
create index if not exists class_sessions_needs_reschedule_idx on public.class_sessions (intake_id) where needs_reschedule;
create index if not exists class_sessions_joined_idx on public.class_sessions (joined_session_id) where joined_session_id is not null;

create table if not exists public.class_session_changes (
  id bigserial primary key,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  intake_id uuid not null,
  kind text not null check (kind in ('moved', 'waiting', 'trainer', 'room', 'joined', 'spread', 'online', 'extended')),
  reason_key text, reason_label text, note text, step text,
  old jsonb, new jsonb,
  notified integer not null default 0,
  by_user uuid, by_name text,
  at timestamptz not null default now()
);
create index if not exists class_session_changes_session_idx on public.class_session_changes (session_id, at desc);
create index if not exists class_session_changes_intake_idx on public.class_session_changes (intake_id, at desc);
alter table public.class_session_changes enable row level security;
revoke all on public.class_session_changes from anon, authenticated;

alter table public.intake_group_messages drop constraint if exists intake_group_messages_kind_check;
alter table public.intake_group_messages add constraint intake_group_messages_kind_check
  check (kind in ('message', 'welcome', 'invite', 'class_change'));

-- Classes cancelled before these rules wait for a new time.
update public.class_sessions set needs_reschedule = true,
  reschedule_reason = coalesce(reschedule_reason, 'Cancelled before the rescheduling rules')
 where status = 'cancelled' and made_up_by is null and not needs_reschedule;

-- 3. A class is never just cancelled (unless an admin allows it in the rules).
create or replace function public.class_sessions_no_drop() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and not new.needs_reschedule and new.made_up_by is null
     and not coalesce((public.class_reschedule_rules_for((select course_id from public.course_intakes where id = new.intake_id))
                       #>> '{general,allowCancel}')::boolean, false) then
    raise exception 'Classes are never cancelled: use Can''t run to give it a new time.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists class_sessions_no_drop on public.class_sessions;
create trigger class_sessions_no_drop before update of status on public.class_sessions
  for each row execute function public.class_sessions_no_drop();

-- 4. Joining another intake's class: the two classes share room and trainer on purpose.
create or replace function public.class_session_clash_ex(p_id uuid, p_intake uuid, p_unit text, p_room uuid, p_trainer uuid,
  p_date date, p_start time, p_end time, p_join uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_room uuid; v_tr uuid[]; c record;
begin
  v_room := coalesce(p_room, (select classroom_id from public.course_intakes where id = p_intake));
  v_tr := public.session_trainer_ids(p_trainer, p_intake, p_unit);
  for c in select x.*, coalesce(x.room_id, ci.classroom_id) as room, ci.course_id, public.intake_group_name(ci.id) as group_name
             from public.class_sessions x join public.course_intakes ci on ci.id = x.intake_id
            where x.session_date = p_date and x.id is distinct from p_id and x.status <> 'cancelled'
              and x.start_time < p_end and p_start < x.end_time
              and x.id is distinct from p_join
              and x.joined_session_id is distinct from p_id
              and (p_join is null or x.joined_session_id is distinct from p_join) loop
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

create or replace function public.class_session_clash(p_id uuid, p_intake uuid, p_unit text, p_room uuid, p_trainer uuid,
  p_date date, p_start time, p_end time) returns text
language sql stable security definer set search_path = public as $$
  select public.class_session_clash_ex(p_id, p_intake, p_unit, p_room, p_trainer, p_date, p_start, p_end, null);
$$;

create or replace function public.class_sessions_no_clash() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_problem text;
begin
  if new.status = 'cancelled' then return new; end if;
  v_problem := public.class_session_clash_ex(new.id, new.intake_id, new.unit_id, new.room_id, new.trainer_id,
    new.session_date, new.start_time, new.end_time, new.joined_session_id);
  if v_problem is not null then raise exception '%', v_problem using errcode = '23P01'; end if;
  return new;
end $$;

-- A joined class follows the class it joined when that one moves.
create or replace function public.class_sessions_follow_joined() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.session_date, new.start_time, new.end_time, new.room_id, new.trainer_id)
     is distinct from (old.session_date, old.start_time, old.end_time, old.room_id, old.trainer_id) then
    update public.class_sessions j set session_date = new.session_date, start_time = new.start_time, end_time = new.end_time,
      room_id = new.room_id, trainer_id = new.trainer_id, updated_at = now()
     where j.joined_session_id = new.id and j.status = 'scheduled';
  end if;
  return null;
end $$;
drop trigger if exists class_sessions_follow_joined on public.class_sessions;
create trigger class_sessions_follow_joined after update of session_date, start_time, end_time, room_id, trainer_id on public.class_sessions
  for each row execute function public.class_sessions_follow_joined();

-- 5. Checks every new time must pass. Returns the problem in plain words, or null.
create or replace function public.class_reschedule_group_size(p_intake uuid) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.intake_group_members where intake_id = p_intake and person_kind = 'student' and active;
$$;

create or replace function public.class_reschedule_window(p_session uuid, out from_date date, out to_date date)
language sql stable security definer set search_path = public as $$
  select greatest(current_date + 1, coalesce(iu.start_date, ci.start_date, current_date + 1)),
         least(coalesce(iu.end_date, ci.end_date, s.session_date + 90), coalesce(ci.end_date, iu.end_date, s.session_date + 90))
    from public.class_sessions s join public.course_intakes ci on ci.id = s.intake_id
    left join public.intake_units iu on iu.intake_id = s.intake_id and iu.unit_id = s.unit_id
   where s.id = p_session limit 1;
$$;

create or replace function public.class_reschedule_problem(p_session uuid, p_date date, p_start time, p_end time,
  p_room uuid, p_trainer uuid, p_join uuid default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare s public.class_sessions; w record; v_room uuid; v_tr uuid; v_cap int; v_note text;
begin
  select * into s from public.class_sessions where id = p_session;
  if s.id is null then return 'Class not found.'; end if;
  if p_date is null or p_start is null or p_end is null or p_end <= p_start then return 'The class must end after it starts.'; end if;
  select * into w from public.class_reschedule_window(p_session);
  if p_date < w.from_date then return 'The new date must be from tomorrow.'; end if;
  if p_date > w.to_date then return format('The new date must be on or before %s, when the unit ends.', to_char(w.to_date, 'DD Mon YYYY')); end if;
  if not public.rto_is_teaching_day(p_date) then return format('%s is a public holiday or in a term break.', to_char(p_date, 'Dy DD Mon')); end if;
  v_room := coalesce(p_room, (select classroom_id from public.course_intakes where id = s.intake_id));
  if v_room is not null then
    if not public.room_open_for(v_room, extract(dow from p_date)::int, p_start, p_end) then return 'The room is not open at that time.'; end if;
    select coalesce(nullif(t.note, ''), 'time off') into v_note from public.booking_time_off t
     where t.room_id = v_room and p_date between t.start_date and t.end_date limit 1;
    if v_note is not null then return format('The room is closed that day (%s).', v_note); end if;
    if p_join is null then
      select capacity into v_cap from public.classrooms where id = v_room;
      if v_cap is not null and v_cap < public.class_reschedule_group_size(s.intake_id) then return 'The room has too few seats for this group.'; end if;
    end if;
  end if;
  foreach v_tr in array public.session_trainer_ids(p_trainer, s.intake_id, s.unit_id) loop
    if not public.trainer_open_for(v_tr, extract(dow from p_date)::int, p_start, p_end) then return 'The trainer is not available at that time.'; end if;
    if exists (select 1 from public.booking_time_off t where p_date between t.start_date and t.end_date
                 and (t.staff_id = v_tr or (t.user_id is not null and t.user_id = public.trainer_booking_user(v_tr)))) then
      return 'The trainer has time off that day.'; end if;
  end loop;
  return public.class_session_clash_ex(s.id, s.intake_id, s.unit_id, p_room, p_trainer, p_date, p_start, p_end, p_join);
end $$;

-- 6. The engine: candidates for a class and a reason, in the order of the rules' steps.
create or replace function public.class_reschedule_candidates(p_session uuid, p_reason text, p_limit int default 5)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s public.class_sessions; ci public.course_intakes; v_rules jsonb; v_reason jsonb; st jsonb; w record;
  v_out jsonb := '[]'::jsonb; v_tried jsonb := '[]'::jsonb; v_found int; v_why text; v_p text;
  v_len interval; v_room uuid; v_t time; v_d date; v_size int; v_days int[]; v_earliest time; v_latest time;
  r record; v_n int; v_per int; v_list jsonb; v_ok boolean;
begin
  select * into s from public.class_sessions where id = p_session;
  if s.id is null then raise exception 'Class not found.' using errcode = 'P0002'; end if;
  select * into ci from public.course_intakes where id = s.intake_id;
  v_rules := public.class_reschedule_rules_for(ci.course_id);
  select x into v_reason from jsonb_array_elements(v_rules->'reasons') x where x->>'key' = p_reason limit 1;
  if v_reason is null then raise exception 'Choose a reason.' using errcode = '22023'; end if;
  v_len := s.end_time - s.start_time;
  v_room := coalesce(s.room_id, ci.classroom_id);
  v_size := public.class_reschedule_group_size(s.intake_id);
  select * into w from public.class_reschedule_window(p_session);

  for st in select x from jsonb_array_elements(v_reason->'steps') x loop
    continue when not coalesce((st->>'on')::boolean, true);
    v_found := 0; v_why := null;
    v_earliest := coalesce(nullif(st->>'earliest', '')::time, '08:00');
    v_latest := coalesce(nullif(st->>'latest', '')::time, '21:00');

    if st->>'type' = 'other_trainer' then
      if s.session_date < current_date + 1 then v_why := 'The class time has passed.';
      else
        for r in select p.id, btrim(p.first_name || ' ' || p.last_name) as name from hr.staff_profiles p
                  where p.status = 'active' and not (p.id = any(public.session_trainer_ids(s.trainer_id, s.intake_id, s.unit_id)))
                    and (not coalesce((st->>'onlyCourseTrainers')::boolean, true) or p.id in (
                      select t.staff_id from public.intake_trainers t join public.course_intakes c2 on c2.id = t.intake_id where c2.course_id = ci.course_id
                      union select u.trainer_id from public.intake_units u where u.unit_id = s.unit_id and u.trainer_id is not null))
                  order by 2 loop
          exit when v_found >= p_limit;
          v_p := public.class_reschedule_problem(s.id, s.session_date, s.start_time, s.end_time, s.room_id, r.id);
          if v_p is null then
            v_found := v_found + 1;
            v_out := v_out || jsonb_build_object('step', 'other_trainer', 'date', s.session_date, 'start', s.start_time, 'end', s.end_time,
              'roomId', s.room_id, 'trainerId', r.id, 'trainerName', r.name);
          else v_why := coalesce(v_why, v_p); end if;
        end loop;
        if v_found = 0 then v_why := coalesce('No other trainer free: ' || v_why, 'No other trainer for this course.'); end if;
      end if;

    elsif st->>'type' = 'other_room' then
      if s.session_date < current_date + 1 then v_why := 'The class time has passed.';
      else
        for r in select c.id, c.name, c.capacity from public.classrooms c
                  where c.is_active and c.id is distinct from v_room
                    and (coalesce(st->>'minSeats', 'group') <> 'group' or c.capacity is null or c.capacity >= v_size)
                  order by c.capacity nulls last, c.name loop
          exit when v_found >= p_limit;
          v_p := public.class_reschedule_problem(s.id, s.session_date, s.start_time, s.end_time, r.id, s.trainer_id);
          if v_p is null then
            v_found := v_found + 1;
            v_out := v_out || jsonb_build_object('step', 'other_room', 'date', s.session_date, 'start', s.start_time, 'end', s.end_time,
              'roomId', r.id, 'trainerId', s.trainer_id);
          else v_why := coalesce(v_why, v_p); end if;
        end loop;
        if v_found = 0 then v_why := coalesce('No other room free: ' || v_why, 'No other room with enough seats.'); end if;
      end if;

    elsif st->>'type' = 'same_day_other_time' then
      if s.session_date < current_date + 1 then v_why := 'The class day has passed.';
      else
        for v_t in select g::time from generate_series(s.session_date + v_earliest, s.session_date + (v_latest - v_len), interval '30 minutes') g
                    where not (g::time < s.end_time and s.start_time < g::time + v_len)
                    order by abs(extract(epoch from (g::time - s.start_time))) loop
          exit when v_found >= p_limit;
          v_p := public.class_reschedule_problem(s.id, s.session_date, v_t, v_t + v_len, s.room_id, s.trainer_id);
          if v_p is null then
            v_found := v_found + 1;
            v_out := v_out || jsonb_build_object('step', 'same_day_other_time', 'date', s.session_date, 'start', v_t, 'end', v_t + v_len,
              'roomId', s.room_id, 'trainerId', s.trainer_id);
          else v_why := coalesce(v_why, v_p); end if;
        end loop;
        if v_found = 0 then v_why := coalesce('No free time that day: ' || v_why, 'No free time that day.'); end if;
      end if;

    elsif st->>'type' = 'another_day' then
      v_days := coalesce((select array_agg(d::int) from jsonb_array_elements_text(st->'days') d), array[1, 2, 3, 4, 5]);
      for v_d in select g::date from generate_series(w.from_date,
                    least(w.to_date, s.session_date + coalesce((st->>'withinDays')::int, 14)), interval '1 day') g
                  where g::date <> s.session_date and extract(dow from g)::int = any(v_days)
                  order by (g::date < s.session_date), abs(g::date - s.session_date) loop
        exit when v_found >= p_limit;
        v_ok := false;
        for v_t in select s.start_time union all
                   select g::time from generate_series(v_d + v_earliest, v_d + (v_latest - v_len), interval '30 minutes') g where g::time <> s.start_time loop
          v_p := public.class_reschedule_problem(s.id, v_d, v_t, v_t + v_len, s.room_id, s.trainer_id);
          if v_p is null then
            v_found := v_found + 1; v_ok := true;
            v_out := v_out || jsonb_build_object('step', 'another_day', 'date', v_d, 'start', v_t, 'end', v_t + v_len,
              'roomId', s.room_id, 'trainerId', s.trainer_id);
            exit;
          else v_why := coalesce(v_why, v_p); end if;
        end loop;
      end loop;
      if v_found = 0 then v_why := coalesce('No free day: ' || v_why, 'No allowed day before the unit ends.'); end if;

    elsif st->>'type' = 'join_other_intake' then
      if v_size > coalesce((st->>'maxExtraSeats')::int, 6) then v_why := format('This group has %s students, more than the %s extra seats allowed.', v_size, coalesce((st->>'maxExtraSeats')::int, 6));
      else
        for r in select x.*, public.intake_group_name(x.intake_id) as group_name,
                        coalesce(x.room_id, c2.classroom_id) as join_room,
                        coalesce(x.trainer_id, (public.session_trainer_ids(null, x.intake_id, x.unit_id))[1]) as join_trainer,
                        coalesce((select capacity from public.classrooms where id = coalesce(x.room_id, c2.classroom_id)), c2.capacity) as seats,
                        public.class_reschedule_group_size(x.intake_id)
                          + coalesce((select sum(public.class_reschedule_group_size(j.intake_id)) from public.class_sessions j where j.joined_session_id = x.id), 0) as taken
                   from public.class_sessions x join public.course_intakes c2 on c2.id = x.intake_id
                  where x.unit_id = s.unit_id and x.intake_id <> s.intake_id and x.status = 'scheduled' and x.joined_session_id is null
                    and x.session_date between w.from_date and w.to_date
                  order by x.session_date, x.start_time loop
          exit when v_found >= p_limit;
          if r.seats is not null and r.seats - r.taken < v_size then v_why := coalesce(v_why, 'Not enough free seats in the other classes.'); continue; end if;
          v_p := public.class_reschedule_problem(s.id, r.session_date, r.start_time, r.end_time, r.join_room, r.join_trainer, r.id);
          if v_p is null then
            v_found := v_found + 1;
            v_out := v_out || jsonb_build_object('step', 'join_other_intake', 'date', r.session_date, 'start', r.start_time, 'end', r.end_time,
              'roomId', r.join_room, 'trainerId', r.join_trainer, 'joinSessionId', r.id, 'joinGroup', r.group_name,
              'freeSeats', case when r.seats is null then null else r.seats - r.taken end);
          else v_why := coalesce(v_why, v_p); end if;
        end loop;
        if v_found = 0 then v_why := coalesce('No other intake class fits: ' || v_why, 'No other intake has a class of this unit before it ends.'); end if;
      end if;

    elsif st->>'type' = 'spread' then
      v_list := '[]'::jsonb; v_n := 0;
      for r in select x.* from public.class_sessions x
                where x.intake_id = s.intake_id and x.unit_id = s.unit_id and x.id <> s.id and x.status = 'scheduled'
                  and x.joined_session_id is null and x.session_date between w.from_date and w.to_date
                order by x.session_date, x.start_time limit coalesce((st->>'maxClasses')::int, 4) loop
        v_n := v_n + 1;
        v_list := v_list || jsonb_build_object('id', r.id, 'date', r.session_date, 'start', r.start_time, 'end', r.end_time,
          'roomId', r.room_id, 'trainerId', r.trainer_id);
      end loop;
      if v_n = 0 then v_why := 'No later classes of this unit to add time to.';
      else
        v_per := (ceil(extract(epoch from v_len) / 60 / v_n / 15) * 15)::int;
        if v_per > coalesce((st->>'maxExtraMinutes')::int, 60) then
          v_why := format('It would add %s minutes to each of %s classes, more than the %s allowed.', v_per, v_n, coalesce((st->>'maxExtraMinutes')::int, 60));
        else
          v_ok := true; v_why := null;
          v_list := (select jsonb_agg(e || case when coalesce(st->>'addAt', 'end') = 'start'
                       then jsonb_build_object('newStart', ((e->>'start')::time - make_interval(mins => v_per)), 'newEnd', e->>'end')
                       else jsonb_build_object('newStart', e->>'start', 'newEnd', ((e->>'end')::time + make_interval(mins => v_per))) end)
                     from jsonb_array_elements(v_list) e);
          for r in select e from jsonb_array_elements(v_list) e loop
            v_p := public.class_reschedule_problem((r.e->>'id')::uuid, (r.e->>'date')::date, (r.e->>'newStart')::time, (r.e->>'newEnd')::time,
              nullif(r.e->>'roomId', '')::uuid, nullif(r.e->>'trainerId', '')::uuid);
            -- the later classes are inside the window already; only time clashes matter for them
            if v_p is not null and v_p not like 'The new date must%' then v_ok := false; v_why := v_p; exit; end if;
          end loop;
          if v_ok then
            v_found := 1;
            v_out := v_out || jsonb_build_object('step', 'spread', 'minutesEach', v_per, 'classes', v_list,
              'date', v_list->0->>'date', 'start', v_list->0->>'newStart', 'end', v_list->0->>'newEnd');
          end if;
        end if;
      end if;

    elsif st->>'type' = 'online' then
      if s.session_date < current_date + 1 then v_why := 'The class time has passed.';
      elsif not coalesce((st->>'international')::boolean, false) and exists (
          select 1 from public.intake_group_members m join public.enrollment_students es on es.id = m.person_id
           where m.intake_id = s.intake_id and m.person_kind = 'student' and m.active
             and nullif(btrim(es.nationality), '') is not null and es.nationality !~* '^austral') then
        v_why := 'The group has international students, who must be taught face to face.';
      else
        v_p := public.class_reschedule_problem(s.id, s.session_date, s.start_time, s.end_time, null, s.trainer_id);
        if v_p is null or v_p like 'The room%' then
          v_found := 1;
          v_out := v_out || jsonb_build_object('step', 'online', 'date', s.session_date, 'start', s.start_time, 'end', s.end_time,
            'roomId', null, 'trainerId', s.trainer_id);
        else v_why := v_p; end if;
      end if;
    end if;

    v_tried := v_tried || jsonb_build_object('step', st->>'type', 'found', v_found, 'why', case when v_found = 0 then v_why end);
  end loop;

  -- names for the screen
  v_out := coalesce((select jsonb_agg(c || jsonb_build_object(
      'roomName', (select name from public.classrooms where id = coalesce(nullif(c->>'roomId', '')::uuid, case when c->>'step' = 'online' then null else v_room end)),
      'trainerName', coalesce(c->>'trainerName', (select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ')
          from hr.staff_profiles p where p.id = any(public.session_trainer_ids(nullif(c->>'trainerId', '')::uuid, s.intake_id, s.unit_id))))))
    from jsonb_array_elements(v_out) c), '[]'::jsonb);
  return jsonb_build_object('candidates', v_out, 'tried', v_tried, 'mode', v_rules #>> '{general,mode}', 'groupSize', v_size);
end $$;

-- 7. Who may reschedule.
create or replace function public.class_reschedule_can(p_session uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.cms_is_rto_manager(), false)
      or (public.class_reschedule_rules_for(ci.course_id) #>> '{general,who}' = 'rto_manager_and_trainers'
          and public.asm_trainer_profile() = any(public.session_trainer_ids(s.trainer_id, s.intake_id, s.unit_id)))
    from public.class_sessions s join public.course_intakes ci on ci.id = s.intake_id where s.id = p_session;
$$;

create or replace function public.class_reschedule_session_json(s public.class_sessions) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', s.id, 'intakeId', s.intake_id, 'date', s.session_date, 'start', s.start_time, 'end', s.end_time,
    'roomId', coalesce(s.room_id, ci.classroom_id), 'roomName', (select name from public.classrooms where id = coalesce(s.room_id, ci.classroom_id)),
    'trainerId', s.trainer_id,
    'trainerName', (select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ') from hr.staff_profiles p
                    where p.id = any(public.session_trainer_ids(s.trainer_id, s.intake_id, s.unit_id))),
    'unitCode', (select u.code from public.cms_course_units u where u.id = s.unit_id), 'unitName', (select u.name from public.cms_course_units u where u.id = s.unit_id),
    'status', s.status, 'delivery', s.delivery, 'needsReschedule', s.needs_reschedule, 'reason', s.reschedule_reason, 'note', s.reschedule_note,
    'courseId', ci.course_id, 'courseCode', (select code from public.cms_courses where id = ci.course_id),
    'intakeName', public.intake_group_name(ci.id),
    'unitEnds', (select to_date from public.class_reschedule_window(s.id)))
  from public.course_intakes ci where ci.id = s.intake_id;
$$;

-- 8. Tell the group.
create or replace function public.class_reschedule_notify(p_intake uuid, p_course text, p_waiting boolean,
  p_unit text, p_old text, p_new text, p_room text, p_note text) returns integer
language plpgsql security definer set search_path = public as $$
declare n jsonb; v_people jsonb; v_ch text[] := '{}'; v_subject text; v_body text; v_msg uuid;
begin
  n := public.class_reschedule_rules_for(p_course)->'notify';
  if not exists (select 1 from public.intake_groups where intake_id = p_intake) then return 0; end if;
  select jsonb_agg(jsonb_build_object('kind', m.person_kind, 'id', m.person_id)) into v_people
    from public.intake_group_members m where m.intake_id = p_intake and m.active
     and ((m.person_kind = 'student' and coalesce((n->>'students')::boolean, true))
       or (m.person_kind = 'staff' and coalesce((n->>'trainers')::boolean, true)));
  if v_people is null then return 0; end if;
  if coalesce((n->>'email')::boolean, true) then v_ch := array_append(v_ch, 'email'); end if;
  if coalesce((n->>'sms')::boolean, true) then v_ch := array_append(v_ch, 'sms'); end if;
  if cardinality(v_ch) = 0 then return 0; end if;
  v_subject := case when p_waiting then n->>'waitingSubject' else n->>'subject' end;
  v_body := case when p_waiting then n->>'waitingBody' else n->>'body' end;
  v_subject := replace(replace(replace(coalesce(v_subject, 'Class change: {{unit}}'), '{{unit}}', coalesce(p_unit, 'class')), '{{old}}', coalesce(p_old, '')), '{{new}}', coalesce(p_new, ''));
  v_body := replace(replace(replace(replace(replace(coalesce(v_body, '{{unit}}: {{old}} -> {{new}}'),
    '{{unit}}', coalesce(p_unit, 'class')), '{{old}}', coalesce(p_old, '')), '{{new}}', coalesce(p_new, '')),
    '{{room}}', coalesce(', ' || p_room, '')), '{{note}}', coalesce(nullif(btrim(p_note), '') || E'\n', ''));
  v_msg := public.intake_group_queue(p_intake, 'class_change', v_ch, v_subject, v_body, v_people);
  return jsonb_array_length(v_people);
end $$;

create or replace function public.class_reschedule_when(p_date date, p_start time, p_end time) returns text
language sql immutable as $$
  select to_char(p_date, 'Dy DD Mon YYYY') || ' ' || to_char(p_start, 'HH24:MI') || '–' || to_char(p_end, 'HH24:MI');
$$;

-- 9. A unit (completion) cannot be finished while one of its classes waits for a new time.
create or replace function public.course_completions_no_waiting_classes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.intake_id is not null
     and not coalesce((public.class_reschedule_rules_for(new.course_id) #>> '{general,unitFinishWithWaiting}')::boolean, false)
     and exists (select 1 from public.class_sessions where intake_id = new.intake_id and needs_reschedule) then
    raise exception 'This intake has classes waiting for a new time (Classes to reschedule). Reschedule them first.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists course_completions_no_waiting_classes on public.course_completions;
create trigger course_completions_no_waiting_classes before insert on public.course_completions
  for each row execute function public.course_completions_no_waiting_classes();

-- 10. One RPC for the screens.
create or replace function public.class_reschedule(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := nullif(p_data->>'sessionId', '')::uuid;
  s public.class_sessions; v_old jsonb; v_new jsonb; c jsonb; v_rules jsonb; v_reason jsonb; v_p text; v_course text;
  v_kind text; v_n int := 0; v_by text; e jsonb; v_label text; v_old_when text; v_new_when text; v_room text; v_unit text;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  v_by := coalesce((select name from public.cms_users where auth_user_id = auth.uid()), 'Staff');

  if p_action = 'rules_get' then
    if not public.intake_group_can_manage() then raise exception 'Only Admins and RTO Managers can see the rules.' using errcode = '42501'; end if;
    return jsonb_build_object('canEdit', public.intake_group_can_manage(),
      'default', public.class_reschedule_rules_for(null),
      'courses', coalesce((select jsonb_agg(jsonb_build_object('courseId', c.id, 'code', c.code, 'name', c.name,
          'rules', r.rules, 'own', r.id is not null) order by c.code)
        from public.cms_courses c left join public.class_reschedule_rules r on r.course_id = c.id), '[]'::jsonb),
      'factory', public.class_reschedule_default_rules());
  end if;

  if p_action = 'rules_save' then
    if not public.intake_group_can_manage() then raise exception 'Only Admins and RTO Managers can change the rules.' using errcode = '42501'; end if;
    v_rules := p_data->'rules';
    v_course := nullif(p_data->>'courseId', '');
    if v_course is not null and coalesce((p_data->>'remove')::boolean, false) then
      delete from public.class_reschedule_rules where course_id = v_course;
      return jsonb_build_object('ok', true);
    end if;
    if jsonb_typeof(v_rules->'reasons') <> 'array' or jsonb_array_length(v_rules->'reasons') = 0 then
      raise exception 'Add at least one reason.' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_array_elements(v_rules->'reasons') x
                where nullif(btrim(x->>'key'), '') is null or nullif(btrim(x->>'label'), '') is null) then
      raise exception 'Every reason needs a name.' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_array_elements(v_rules->'reasons') x, jsonb_array_elements(coalesce(x->'steps', '[]')) st
                where st->>'type' not in ('other_trainer', 'other_room', 'same_day_other_time', 'another_day', 'join_other_intake', 'spread', 'online')) then
      raise exception 'Unknown step.' using errcode = '22023'; end if;
    if v_rules #>> '{general,who}' not in ('rto_manager', 'rto_manager_and_trainers')
       or v_rules #>> '{general,mode}' not in ('suggest', 'apply') then
      raise exception 'Check the general rules.' using errcode = '22023'; end if;
    if v_course is null then
      update public.class_reschedule_rules set rules = v_rules, updated_at = now(), updated_by = auth.uid() where course_id is null;
    else
      insert into public.class_reschedule_rules(course_id, rules, updated_by) values (v_course, v_rules, auth.uid())
        on conflict (coalesce(course_id, '')) do update set rules = excluded.rules, updated_at = now(), updated_by = auth.uid();
    end if;
    return jsonb_build_object('ok', true);
  end if;

  if p_action = 'waiting' then
    if not public.intake_group_can_manage() and not exists (select 1 from public.class_sessions x where x.needs_reschedule and public.class_reschedule_can(x.id)) then
      return '[]'::jsonb; end if;
    return coalesce((select jsonb_agg(public.class_reschedule_session_json(x) order by x.session_date, x.start_time)
      from public.class_sessions x where x.needs_reschedule
       and (nullif(p_data->>'intakeId', '') is null or x.intake_id = (p_data->>'intakeId')::uuid)
       and (public.intake_group_can_manage() or public.class_reschedule_can(x.id))), '[]'::jsonb);
  end if;

  select * into s from public.class_sessions where id = v_id;
  if s.id is null then raise exception 'Class not found.' using errcode = 'P0002'; end if;
  v_course := (select course_id from public.course_intakes where id = s.intake_id);
  v_rules := public.class_reschedule_rules_for(v_course);

  if p_action = 'history' then
    if not (public.intake_group_can_manage() or public.class_reschedule_can(s.id)) then raise exception 'Not allowed.' using errcode = '42501'; end if;
    return jsonb_build_object('session', public.class_reschedule_session_json(s),
      'reasons', (select jsonb_agg(jsonb_build_object('key', x->>'key', 'label', x->>'label')) from jsonb_array_elements(v_rules->'reasons') x),
      'canReschedule', public.class_reschedule_can(s.id),
      'history', coalesce((select jsonb_agg(jsonb_build_object('kind', h.kind, 'reason', h.reason_label, 'note', h.note, 'step', h.step,
          'old', h.old, 'new', h.new, 'notified', h.notified, 'by', h.by_name, 'at', h.at) order by h.at desc)
        from public.class_session_changes h where h.session_id = s.id), '[]'::jsonb));
  end if;

  if p_action = 'suggest' then
    -- "Try on a class" from Settings is read-only and open to rule editors.
    if not (public.class_reschedule_can(s.id) or public.intake_group_can_manage()) then raise exception 'Only an RTO Manager can reschedule classes.' using errcode = '42501'; end if;
    return public.class_reschedule_candidates(s.id, p_data->>'reason', 5) || jsonb_build_object('session', public.class_reschedule_session_json(s));
  end if;

  if not public.class_reschedule_can(s.id) then raise exception 'Only an RTO Manager can reschedule classes.' using errcode = '42501'; end if;
  select x into v_reason from jsonb_array_elements(v_rules->'reasons') x where x->>'key' = p_data->>'reason' limit 1;
  v_label := coalesce(v_reason->>'label', s.reschedule_reason, 'Other');
  v_old := jsonb_build_object('date', s.session_date, 'start', s.start_time, 'end', s.end_time, 'roomId', s.room_id, 'trainerId', s.trainer_id, 'status', s.status);
  v_old_when := public.class_reschedule_when(s.session_date, s.start_time, s.end_time);
  v_unit := coalesce((select u.code || ' ' || u.name from public.cms_course_units u where u.id = s.unit_id), 'class');
  perform 1 from public.class_sessions where id = s.id for update;

  if p_action = 'later' then
    if v_reason is null then raise exception 'Choose a reason.' using errcode = '22023'; end if;
    update public.class_sessions set status = 'cancelled', needs_reschedule = true, reschedule_reason = v_label,
      reschedule_note = nullif(btrim(p_data->>'note'), ''), is_manual = true, updated_at = now(), updated_by = auth.uid()
     where id = s.id;
    if coalesce((p_data->>'notify')::boolean, true) then
      v_n := public.class_reschedule_notify(s.intake_id, v_course, true, v_unit, v_old_when, null, null, p_data->>'note');
    end if;
    insert into public.class_session_changes(session_id, intake_id, kind, reason_key, reason_label, note, old, notified, by_user, by_name)
      values (s.id, s.intake_id, 'waiting', p_data->>'reason', v_label, nullif(btrim(p_data->>'note'), ''), v_old, v_n, auth.uid(), v_by);
    return jsonb_build_object('ok', true, 'notified', v_n);
  end if;

  if p_action = 'apply' then
    c := p_data->'choice';
    if c is null then raise exception 'Choose a new time.' using errcode = '22023'; end if;
    if v_reason is null and not s.needs_reschedule then raise exception 'Choose a reason.' using errcode = '22023'; end if;

    if c->>'step' = 'spread' then
      for e in select x from jsonb_array_elements(c->'classes') x loop
        if not exists (select 1 from public.class_sessions x where x.id = (e->>'id')::uuid and x.intake_id = s.intake_id and x.unit_id is not distinct from s.unit_id and x.status = 'scheduled') then
          raise exception 'The classes changed. Ask for a new suggestion.' using errcode = '40001'; end if;
        v_p := public.class_session_clash_ex((e->>'id')::uuid, s.intake_id, s.unit_id, nullif(e->>'roomId', '')::uuid, nullif(e->>'trainerId', '')::uuid,
          (e->>'date')::date, (e->>'newStart')::time, (e->>'newEnd')::time, null);
        if v_p is not null then raise exception '%', v_p using errcode = '23P01'; end if;
        update public.class_sessions set start_time = (e->>'newStart')::time, end_time = (e->>'newEnd')::time, is_manual = true,
          updated_at = now(), updated_by = auth.uid() where id = (e->>'id')::uuid;
        insert into public.class_session_changes(session_id, intake_id, kind, reason_key, reason_label, step, old, new, by_user, by_name)
          values ((e->>'id')::uuid, s.intake_id, 'extended', p_data->>'reason', v_label, 'spread',
            jsonb_build_object('date', e->>'date', 'start', e->>'start', 'end', e->>'end'),
            jsonb_build_object('date', e->>'date', 'start', e->>'newStart', 'end', e->>'newEnd', 'madeUpFor', s.id), auth.uid(), v_by);
      end loop;
      update public.class_sessions set status = 'cancelled', needs_reschedule = false, made_up_by = 'spread', reschedule_reason = v_label,
        reschedule_note = nullif(btrim(p_data->>'note'), ''), is_manual = true, updated_at = now(), updated_by = auth.uid() where id = s.id;
      v_kind := 'spread';
      v_new_when := 'longer classes (' || (c->>'minutesEach') || ' extra minutes each): '
        || (select string_agg(public.class_reschedule_when((x->>'date')::date, (x->>'newStart')::time, (x->>'newEnd')::time), ', ')
              from jsonb_array_elements(c->'classes') x);
      v_new := jsonb_build_object('minutesEach', c->'minutesEach', 'classes', c->'classes');
    else
      v_p := public.class_reschedule_problem(s.id, (c->>'date')::date, (c->>'start')::time, (c->>'end')::time,
        nullif(c->>'roomId', '')::uuid, nullif(c->>'trainerId', '')::uuid, nullif(c->>'joinSessionId', '')::uuid);
      if v_p is not null and not (c->>'step' = 'online' and v_p like 'The room%') then raise exception '%', v_p using errcode = '23514'; end if;
      update public.class_sessions set session_date = (c->>'date')::date, start_time = (c->>'start')::time, end_time = (c->>'end')::time,
        room_id = case when c->>'step' = 'online' then null else nullif(c->>'roomId', '')::uuid end,
        trainer_id = nullif(c->>'trainerId', '')::uuid,
        joined_session_id = nullif(c->>'joinSessionId', '')::uuid,
        delivery = case when c->>'step' = 'online' then 'online' else 'face_to_face' end,
        status = 'scheduled', needs_reschedule = false, made_up_by = null,
        reschedule_reason = v_label, reschedule_note = nullif(btrim(p_data->>'note'), ''),
        is_manual = true, updated_at = now(), updated_by = auth.uid()
       where id = s.id returning * into s;
      v_kind := case c->>'step' when 'other_trainer' then 'trainer' when 'other_room' then 'room' when 'join_other_intake' then 'joined'
                                when 'online' then 'online' else 'moved' end;
      v_new_when := public.class_reschedule_when(s.session_date, s.start_time, s.end_time)
        || case when c->>'step' = 'online' then ' (online)' when c->>'step' = 'join_other_intake' then ' with ' || coalesce(c->>'joinGroup', 'another intake') else '' end;
      v_room := case when c->>'step' = 'online' then null
                     else (select name from public.classrooms where id = coalesce(s.room_id, (select classroom_id from public.course_intakes where id = s.intake_id))) end;
      v_new := jsonb_build_object('date', s.session_date, 'start', s.start_time, 'end', s.end_time, 'roomId', s.room_id, 'trainerId', s.trainer_id,
        'joinSessionId', s.joined_session_id, 'delivery', s.delivery,
        'trainerName', (select string_agg(btrim(p.first_name || ' ' || p.last_name), ', ') from hr.staff_profiles p
                        where p.id = any(public.session_trainer_ids(s.trainer_id, s.intake_id, s.unit_id))),
        'roomName', v_room);
    end if;

    if coalesce((p_data->>'notify')::boolean, true) then
      v_n := public.class_reschedule_notify(s.intake_id, v_course, false, v_unit, v_old_when, v_new_when, v_room, p_data->>'note');
    end if;
    insert into public.class_session_changes(session_id, intake_id, kind, reason_key, reason_label, note, step, old, new, notified, by_user, by_name)
      values (s.id, s.intake_id, v_kind, p_data->>'reason', v_label, nullif(btrim(p_data->>'note'), ''), c->>'step', v_old, v_new, v_n, auth.uid(), v_by);
    return jsonb_build_object('ok', true, 'notified', v_n, 'new', v_new_when);
  end if;

  raise exception 'Unknown action.' using errcode = '22023';
end $$;

-- 11. Grants: the RPC only.
do $$ declare f text; begin
  foreach f in array array['class_reschedule_default_rules()', 'class_reschedule_rules_for(text)', 'class_sessions_no_drop()',
    'class_session_clash_ex(uuid, uuid, text, uuid, uuid, date, time, time, uuid)', 'class_sessions_follow_joined()',
    'class_reschedule_group_size(uuid)', 'class_reschedule_window(uuid)', 'class_reschedule_problem(uuid, date, time, time, uuid, uuid, uuid)',
    'class_reschedule_candidates(uuid, text, integer)', 'class_reschedule_can(uuid)', 'class_reschedule_session_json(public.class_sessions)',
    'class_reschedule_notify(uuid, text, boolean, text, text, text, text, text)', 'class_reschedule_when(date, time, time)',
    'course_completions_no_waiting_classes()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  revoke all on function public.class_reschedule(text, jsonb) from public, anon;
  grant execute on function public.class_reschedule(text, jsonb) to authenticated;
end $$;
