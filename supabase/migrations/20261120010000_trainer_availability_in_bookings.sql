-- TRAINER-AVAILABILITY (2026-11-20, owner): Bookings › Availability › Whose availability gains Trainers, beside Rooms, in the
-- same Bookings tables. A trainer's hours are their own Bookings hours (user_id) when they have a booking page; an Admin / RTO
-- Manager can set them without one (staff_id rows), and those rows move to the trainer's own (user_id) when the trainer opens
-- their booking page. Once a trainer has hours, an intake's weekly class time naming the trainer can only fall inside them;
-- hours a class uses cannot be removed, time off cannot cover days the trainer teaches. A trainer with no hours works as before.
begin;

alter table public.booking_availability add column if not exists staff_id uuid references hr.staff_profiles(id) on delete cascade;
alter table public.booking_availability drop constraint if exists booking_availability_owner;
alter table public.booking_availability add constraint booking_availability_owner check (num_nonnulls(user_id, room_id, staff_id) = 1);
create index if not exists booking_availability_staff_idx on public.booking_availability(staff_id) where staff_id is not null;

alter table public.booking_time_off add column if not exists staff_id uuid references hr.staff_profiles(id) on delete cascade;
alter table public.booking_time_off drop constraint if exists booking_time_off_owner;
alter table public.booking_time_off add constraint booking_time_off_owner check (num_nonnulls(user_id, room_id, staff_id) = 1);
create index if not exists booking_time_off_staff_idx on public.booking_time_off(staff_id) where staff_id is not null;

-- The trainer's own booking page, when they have one (their hours then live under user_id).
create or replace function public.trainer_booking_user(p_staff uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select h.user_id from hr.staff_profiles s join public.booking_hosts h on h.user_id = s.auth_user_id where s.id = p_staff;
$$;
revoke all on function public.trainer_booking_user(uuid) from public, anon, authenticated;

-- Hours set for a trainer before they had a booking page become theirs when they open it.
create or replace function public.booking_hosts_take_staff_hours() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_staff uuid;
begin
  select id into v_staff from hr.staff_profiles where auth_user_id = new.user_id;
  if v_staff is not null then
    update public.booking_availability set user_id = new.user_id, staff_id = null where staff_id = v_staff;
    update public.booking_time_off set user_id = new.user_id, staff_id = null where staff_id = v_staff;
  end if;
  return new;
end $$;
drop trigger if exists booking_hosts_take_staff_hours on public.booking_hosts;
create trigger booking_hosts_take_staff_hours after insert on public.booking_hosts
  for each row execute function public.booking_hosts_take_staff_hours();

create or replace function public.trainer_open_for(p_staff uuid, p_weekday int, p_start time, p_end time) returns boolean
language sql stable security definer set search_path = public as $$
  with mine as (select a.* from public.booking_availability a
                 where a.staff_id = p_staff or (a.user_id is not null and a.user_id = public.trainer_booking_user(p_staff)))
  select not exists (select 1 from mine)
      or exists (select 1 from mine where weekday = p_weekday % 7 and start_time <= p_start and end_time >= p_end);
$$;
revoke all on function public.trainer_open_for(uuid, int, time, time) from public, anon, authenticated;

create or replace function public.intake_class_times_trainer_open() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if new.trainer_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.trainer_id is not distinct from old.trainer_id and new.weekday = old.weekday
     and new.start_time = old.start_time and new.end_time = old.end_time then return new; end if;
  if not public.trainer_open_for(new.trainer_id, new.weekday, new.start_time, new.end_time) then
    select btrim(first_name || ' ' || last_name) into v_name from hr.staff_profiles where id = new.trainer_id;
    raise exception '% is not available on % %–%. Add the hours in Bookings › Availability › Trainers or pick another trainer.',
      coalesce(v_name, 'This trainer'), (array['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])[new.weekday],
      to_char(new.start_time, 'HH24:MI'), to_char(new.end_time, 'HH24:MI') using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists intake_class_times_trainer_open on public.intake_class_times;
create trigger intake_class_times_trainer_open before insert or update on public.intake_class_times
  for each row execute function public.intake_class_times_trainer_open();

-- Weekly class times naming the trainer, in intakes running or still to start.
create or replace function public.trainer_bookings(p_staff uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('weekday', t.weekday % 7,
      'startTime', to_char(t.start_time, 'HH24:MI'), 'endTime', to_char(t.end_time, 'HH24:MI'), 'type', t.session_type,
      'intakeId', ci.id, 'intake', public.rto_intake_json(ci)->>'name', 'courseCode', c.code,
      'startDate', ci.start_date, 'endDate', ci.end_date) order by t.weekday, t.start_time), '[]'::jsonb)
  from public.intake_class_times t
  join public.course_intakes ci on ci.id = t.intake_id
  join public.cms_courses c on c.id = ci.course_id
  where t.trainer_id = p_staff and coalesce(ci.end_date, 'infinity'::date) >= current_date
    and coalesce(public.rto_intake_json(ci)->>'status', 'open') <> 'closed';
$$;
revoke all on function public.trainer_bookings(uuid) from public, anon, authenticated;

-- list | get {staffId} | save {staffId, availability: [{weekday 0-6, start, end}], timeOff: [{start, end, note}]}
create or replace function public.booking_trainer_availability(p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_staff uuid := nullif(p_data->>'staffId', '')::uuid;
  v_user uuid; r jsonb; v_n int; v_bad text;
begin
  if not (public.cms_is_admin() or public.cms_is_rto_manager()) then
    raise exception 'Only Admins and RTO Managers can see trainer availability.' using errcode = '42501';
  end if;

  if p_action = 'list' then
    return jsonb_build_object('canEdit', public.cms_is_rto_manager(), 'trainers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', btrim(s.first_name || ' ' || s.last_name), 'email', s.email,
        'ownPage', public.trainer_booking_user(s.id) is not null,
        'openDays', (select count(distinct a.weekday) from public.booking_availability a
                      where a.staff_id = s.id or (a.user_id is not null and a.user_id = public.trainer_booking_user(s.id))))
      order by s.first_name, s.last_name)
      from hr.staff_profiles s where s.status = 'active'), '[]'::jsonb));
  end if;

  if v_staff is null or not exists (select 1 from hr.staff_profiles where id = v_staff) then
    raise exception 'Choose a trainer.' using errcode = '22023';
  end if;
  v_user := public.trainer_booking_user(v_staff);

  if p_action = 'save' then
    if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can change trainer availability.' using errcode = '42501'; end if;
    if jsonb_typeof(p_data->'availability') <> 'array' or jsonb_typeof(p_data->'timeOff') <> 'array' then
      raise exception 'Nothing to save.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_data->'availability') > 42 or jsonb_array_length(p_data->'timeOff') > 100 then
      raise exception 'Too many rows.' using errcode = '22023';
    end if;
    delete from public.booking_availability where staff_id = v_staff or (v_user is not null and user_id = v_user);
    for r in select * from jsonb_array_elements(p_data->'availability') loop
      if (r->>'start')::time >= (r->>'end')::time then raise exception 'Each "to" time must be after its "from" time.' using errcode = '22023'; end if;
      insert into public.booking_availability(user_id, staff_id, weekday, start_time, end_time)
        values (v_user, case when v_user is null then v_staff end, (r->>'weekday')::smallint, (r->>'start')::time, (r->>'end')::time);
    end loop;
    select string_agg(distinct format('%s %s (%s %s–%s)', b->>'courseCode', b->>'intake',
             (array['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[(b->>'weekday')::int + 1], b->>'startTime', b->>'endTime'), ', ')
      into v_bad from jsonb_array_elements(public.trainer_bookings(v_staff)) b
     where not public.trainer_open_for(v_staff, case when (b->>'weekday')::int = 0 then 7 else (b->>'weekday')::int end,
                                       (b->>'startTime')::time, (b->>'endTime')::time);
    if v_bad is not null then
      raise exception 'These classes are taught outside the new hours: %. Keep those hours or change the trainer first.', v_bad using errcode = '23514';
    end if;
    delete from public.booking_time_off where (staff_id = v_staff or (v_user is not null and user_id = v_user)) and end_date >= current_date;
    for r in select * from jsonb_array_elements(p_data->'timeOff') loop
      if nullif(r->>'start', '') is null or nullif(r->>'end', '') is null or (r->>'end')::date < (r->>'start')::date then
        raise exception 'Enter the first and last day of each time off.' using errcode = '22023';
      end if;
      select count(*) into v_n from public.class_sessions cs
       where cs.status = 'scheduled' and cs.session_date between (r->>'start')::date and (r->>'end')::date
         and v_staff = any(public.session_trainer_ids(cs.trainer_id, cs.intake_id, cs.unit_id));
      if v_n > 0 then
        raise exception 'The trainer teaches % class(es) between % and %. Give those classes another trainer first.', v_n,
          to_char((r->>'start')::date, 'DD Mon YYYY'), to_char((r->>'end')::date, 'DD Mon YYYY') using errcode = '23514';
      end if;
      insert into public.booking_time_off(user_id, staff_id, start_date, end_date, note)
        values (v_user, case when v_user is null then v_staff end, (r->>'start')::date, (r->>'end')::date, left(btrim(coalesce(r->>'note', '')), 200));
    end loop;
  elsif p_action <> 'get' then
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;

  return jsonb_build_object('staffId', v_staff, 'ownPage', v_user is not null,
    'availability', coalesce((select jsonb_agg(jsonb_build_object('weekday', a.weekday, 'start', to_char(a.start_time, 'HH24:MI'), 'end', to_char(a.end_time, 'HH24:MI')) order by a.weekday, a.start_time)
                                from public.booking_availability a where a.staff_id = v_staff or (v_user is not null and a.user_id = v_user)), '[]'::jsonb),
    'timeOff', coalesce((select jsonb_agg(jsonb_build_object('start', t.start_date, 'end', t.end_date, 'note', t.note) order by t.start_date)
                           from public.booking_time_off t where (t.staff_id = v_staff or (v_user is not null and t.user_id = v_user)) and t.end_date >= current_date), '[]'::jsonb),
    'bookings', public.trainer_bookings(v_staff));
end $$;
revoke all on function public.booking_trainer_availability(text, jsonb) from public, anon;
grant execute on function public.booking_trainer_availability(text, jsonb) to authenticated;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261120010000', 'trainer_availability_in_bookings', array['see repo file']) on conflict do nothing;
commit;
