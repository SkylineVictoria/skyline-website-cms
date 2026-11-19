-- ROOM-AVAILABILITY (2026-11-20, owner: "for availability always use same module"): a room's open hours and time off live in
-- the Bookings tables (booking_availability, booking_time_off), a row belonging to a person (user_id) or to a room (room_id).
-- Bookings › Availability › Whose availability: Rooms (Admins / RTO Managers see, RTO Managers save).
-- Once a room has hours: an intake's weekly class time can only use it inside them; hours an intake uses cannot be removed;
-- time off cannot cover classes already in the room, automatic classes skip it, a class moved onto it by hand is refused.
-- A room with no hours yet works as before. Bookings for people are unchanged (their rows keep user_id, room_id null).
begin;

-- The first draft's separate tables were never applied; dropped here in case a copy exists.
drop table if exists public.room_open_slots;
drop table if exists public.room_closed_dates;

alter table public.booking_availability alter column user_id drop not null;
alter table public.booking_availability add column if not exists room_id uuid references public.classrooms(id) on delete cascade;
alter table public.booking_availability drop constraint if exists booking_availability_owner;
alter table public.booking_availability add constraint booking_availability_owner check (num_nonnulls(user_id, room_id) = 1);
create index if not exists booking_availability_room_idx on public.booking_availability(room_id) where room_id is not null;

alter table public.booking_time_off alter column user_id drop not null;
alter table public.booking_time_off add column if not exists room_id uuid references public.classrooms(id) on delete cascade;
alter table public.booking_time_off drop constraint if exists booking_time_off_owner;
alter table public.booking_time_off add constraint booking_time_off_owner check (num_nonnulls(user_id, room_id) = 1);
create index if not exists booking_time_off_room_idx on public.booking_time_off(room_id) where room_id is not null;

-- Is the room open for this weekly time? (intake weekday 1 = Monday ... 7 = Sunday; Bookings weekday 0 = Sunday ... 6)
create or replace function public.room_open_for(p_room uuid, p_weekday int, p_start time, p_end time) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.booking_availability where room_id = p_room)
      or exists (select 1 from public.booking_availability a where a.room_id = p_room and a.weekday = p_weekday % 7
                   and a.start_time <= p_start and a.end_time >= p_end);
$$;
revoke all on function public.room_open_for(uuid, int, time, time) from public, anon, authenticated;

create or replace function public.intake_class_times_room_open() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_room text;
begin
  if new.room_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.room_id is not distinct from old.room_id and new.weekday = old.weekday
     and new.start_time = old.start_time and new.end_time = old.end_time then return new; end if;
  if not public.room_open_for(new.room_id, new.weekday, new.start_time, new.end_time) then
    select name into v_room from public.classrooms where id = new.room_id;
    raise exception '% is not open on % %–%. Add the hours in Bookings › Availability › Rooms or pick another room.',
      coalesce(v_room, 'This room'), (array['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])[new.weekday],
      to_char(new.start_time, 'HH24:MI'), to_char(new.end_time, 'HH24:MI') using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists intake_class_times_room_open on public.intake_class_times;
create trigger intake_class_times_room_open before insert or update on public.intake_class_times
  for each row execute function public.intake_class_times_room_open();

-- Classes on a room's time off: an automatic class is skipped, a class put there by hand is refused.
create or replace function public.class_sessions_room_time_off() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_note text;
begin
  if new.room_id is null or new.status <> 'scheduled' then return new; end if;
  if tg_op = 'UPDATE' and new.room_id is not distinct from old.room_id and new.session_date = old.session_date and old.status = 'scheduled' then return new; end if;
  select coalesce(nullif(t.note, ''), 'time off') into v_note from public.booking_time_off t
   where t.room_id = new.room_id and new.session_date between t.start_date and t.end_date limit 1;
  if v_note is null then return new; end if;
  if tg_op = 'INSERT' and not new.is_manual then return null; end if;
  raise exception 'The room is closed on % (%).', to_char(new.session_date, 'DD Mon YYYY'), v_note using errcode = '23514';
end $$;
drop trigger if exists class_sessions_room_time_off on public.class_sessions;
create trigger class_sessions_room_time_off before insert or update on public.class_sessions
  for each row execute function public.class_sessions_room_time_off();

-- Intakes using a room now (running or still to start, not closed).
create or replace function public.room_bookings(p_room uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('weekday', t.weekday % 7,
      'startTime', to_char(t.start_time, 'HH24:MI'), 'endTime', to_char(t.end_time, 'HH24:MI'), 'type', t.session_type,
      'intakeId', ci.id, 'intake', public.rto_intake_json(ci)->>'name', 'courseCode', c.code,
      'startDate', ci.start_date, 'endDate', ci.end_date) order by t.weekday, t.start_time), '[]'::jsonb)
  from public.intake_class_times t
  join public.course_intakes ci on ci.id = t.intake_id
  join public.cms_courses c on c.id = ci.course_id
  where t.room_id = p_room and coalesce(ci.end_date, 'infinity'::date) >= current_date
    and coalesce(public.rto_intake_json(ci)->>'status', 'open') <> 'closed';
$$;
revoke all on function public.room_bookings(uuid) from public, anon, authenticated;

-- list | get {roomId} | save {roomId, availability: [{weekday 0-6, start, end}], timeOff: [{start, end, note}]}
create or replace function public.booking_room_availability(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_room uuid := nullif(p_data->>'roomId', '')::uuid;
  r jsonb; v_n int; v_bad text;
begin
  if not (public.cms_is_admin() or public.cms_is_rto_manager()) then
    raise exception 'Only Admins and RTO Managers can see room availability.' using errcode = '42501';
  end if;

  if p_action = 'list' then
    return jsonb_build_object('canEdit', public.cms_is_rto_manager(), 'rooms', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'name', x.name, 'capacity', x.capacity, 'location', coalesce(l.name, 'Other rooms'),
        'openDays', (select count(distinct a.weekday) from public.booking_availability a where a.room_id = x.id))
      order by l.sort nulls last, l.name nulls last, x.sort, x.name)
      from public.classrooms x left join public.locations l on l.id = x.location_id where x.is_active), '[]'::jsonb));
  end if;

  if v_room is null or not exists (select 1 from public.classrooms where id = v_room) then
    raise exception 'Choose a room.' using errcode = '22023';
  end if;

  if p_action = 'save' then
    if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can change room availability.' using errcode = '42501'; end if;
    if jsonb_typeof(p_data->'availability') <> 'array' or jsonb_typeof(p_data->'timeOff') <> 'array' then
      raise exception 'Nothing to save.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_data->'availability') > 42 or jsonb_array_length(p_data->'timeOff') > 100 then
      raise exception 'Too many rows.' using errcode = '22023';
    end if;
    delete from public.booking_availability where room_id = v_room;
    for r in select * from jsonb_array_elements(p_data->'availability') loop
      if (r->>'start')::time >= (r->>'end')::time then raise exception 'Each "to" time must be after its "from" time.' using errcode = '22023'; end if;
      insert into public.booking_availability(room_id, weekday, start_time, end_time)
        values (v_room, (r->>'weekday')::smallint, (r->>'start')::time, (r->>'end')::time);
    end loop;
    -- Hours an intake uses cannot be removed.
    select string_agg(distinct format('%s %s (%s %s–%s)', b->>'courseCode', b->>'intake',
             (array['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[(b->>'weekday')::int + 1], b->>'startTime', b->>'endTime'), ', ')
      into v_bad from jsonb_array_elements(public.room_bookings(v_room)) b
     where exists (select 1 from public.booking_availability where room_id = v_room)
       and not exists (select 1 from public.booking_availability a where a.room_id = v_room and a.weekday = (b->>'weekday')::int
                         and a.start_time <= (b->>'startTime')::time and a.end_time >= (b->>'endTime')::time);
    if v_bad is not null then
      raise exception 'These classes use the room outside the new hours: %. Keep those hours or move the intake first.', v_bad using errcode = '23514';
    end if;
    delete from public.booking_time_off where room_id = v_room and end_date >= current_date;
    for r in select * from jsonb_array_elements(p_data->'timeOff') loop
      if nullif(r->>'start', '') is null or nullif(r->>'end', '') is null or (r->>'end')::date < (r->>'start')::date then
        raise exception 'Enter the first and last day of each time off.' using errcode = '22023';
      end if;
      select count(*) into v_n from public.class_sessions
       where room_id = v_room and status = 'scheduled' and session_date between (r->>'start')::date and (r->>'end')::date;
      if v_n > 0 then
        raise exception '% class(es) are already in this room between % and %. Move them first.', v_n,
          to_char((r->>'start')::date, 'DD Mon YYYY'), to_char((r->>'end')::date, 'DD Mon YYYY') using errcode = '23514';
      end if;
      insert into public.booking_time_off(room_id, start_date, end_date, note)
        values (v_room, (r->>'start')::date, (r->>'end')::date, left(btrim(coalesce(r->>'note', '')), 200));
    end loop;
  elsif p_action <> 'get' then
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;

  return jsonb_build_object('roomId', v_room,
    'availability', coalesce((select jsonb_agg(jsonb_build_object('weekday', a.weekday, 'start', to_char(a.start_time, 'HH24:MI'), 'end', to_char(a.end_time, 'HH24:MI')) order by a.weekday, a.start_time)
                                from public.booking_availability a where a.room_id = v_room), '[]'::jsonb),
    'timeOff', coalesce((select jsonb_agg(jsonb_build_object('start', t.start_date, 'end', t.end_date, 'note', t.note) order by t.start_date)
                           from public.booking_time_off t where t.room_id = v_room and t.end_date >= current_date), '[]'::jsonb),
    'bookings', public.room_bookings(v_room));
end $$;
revoke all on function public.booking_room_availability(text, jsonb) from public, anon;
grant execute on function public.booking_room_availability(text, jsonb) to authenticated;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261120003000', 'room_availability_in_bookings', array['see repo file']) on conflict do nothing;
commit;
