-- CLASS-SESSIONS: dated class sessions generated from a batch's weekly pattern instead of a hand-typed master timetable.
-- Inputs, all edited in the CMS: the batch's weekly sessions (day, time, type, room), the intake's unit order,
-- each unit's SLIT theory / practical / assessment hours, term breaks (academic_breaks) and confirmed public holidays (hr.public_holidays).
-- Additive: one new table and five new functions. No existing table or function is changed.

create table if not exists public.class_sessions (
 id uuid primary key default gen_random_uuid(),
 batch_id uuid not null references public.batches(id) on delete cascade,
 session_date date not null,
 start_time time not null, end_time time not null,
 session_type text not null check (session_type in ('theory', 'practical', 'assessment')),
 room_id uuid references public.classrooms(id) on delete set null,
 unit_id text references public.cms_course_units(id) on delete set null,
 status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
 is_manual boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid default auth.uid(),
 check (end_time > start_time),
 unique (batch_id, session_date, start_time)
);
create index if not exists class_sessions_date on public.class_sessions(session_date, room_id);
alter table public.class_sessions enable row level security;
revoke all on public.class_sessions from anon, authenticated;

-- A teaching day: any day of the week (SLIT teaches weekends), not a confirmed public holiday, not in a term break.
create or replace function public.rto_is_teaching_day(p_day date) returns boolean
language sql stable security definer set search_path = public, hr as $$
 select not exists(select 1 from hr.public_holidays h where h.holiday_date = p_day and h.status = 'confirmed' and not h.is_optional)
  and not exists(select 1 from public.academic_breaks b where p_day between b.start_date and b.end_date);
$$;

-- Room clashes: another batch's scheduled session in the same room, same day, overlapping times.
create or replace function public.rto_class_session_clashes(p_batch uuid) returns jsonb
language sql stable security definer set search_path = public as $$
 select coalesce(jsonb_agg(jsonb_build_object('date', a.session_date, 'startTime', a.start_time, 'room', r.name, 'otherBatch', ob.name)
  order by a.session_date, a.start_time), '[]'::jsonb)
 from public.class_sessions a
 join public.class_sessions o on o.room_id = a.room_id and o.session_date = a.session_date and o.batch_id <> a.batch_id
  and o.status = 'scheduled' and o.start_time < a.end_time and a.start_time < o.end_time
 join public.classrooms r on r.id = a.room_id
 join public.batches ob on ob.id = o.batch_id
 where a.batch_id = p_batch and a.status = 'scheduled';
$$;

-- Generate a batch's dated sessions. Each weekly slot of a type (theory, practical, assessment) takes that type's hours from the
-- first unit, in the intake's order, that still has hours of that type. Hours of a type the batch has no weekly slot for are taught
-- in the first slot type it has (theory, then practical, then assessment). Holidays and term breaks are skipped, so units move later.
-- Re-running keeps manual and past sessions, counts their hours as taught, and rebuilds the rest from today.
create or replace function public.rto_class_sessions_generate(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public, hr as $$
declare
 v_intake public.course_intakes; v_from date; v_day date; v_end date; v_fallback text;
 v_units text[] := '{}'; v_th numeric[] := '{}'; v_pr numeric[] := '{}'; v_as numeric[] := '{}';
 v_types text[]; v_left numeric; v_i int; v_pick int; v_len numeric; v_created int := 0; v_kept int; v_guard int := 0;
 u record; s record; k record;
begin
 if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can generate class sessions.' using errcode = '42501'; end if;
 select i.* into v_intake from public.batches b join public.course_intakes i on i.id = b.intake_id where b.id = p_batch;
 if not found then raise exception 'Batch not found.' using errcode = 'P0002'; end if;
 select array_agg(distinct session_type) into v_types from public.batch_sessions where batch_id = p_batch;
 if v_types is null then raise exception 'Set the batch''s weekly class times first.' using errcode = '22023'; end if;
 v_fallback := case when 'theory' = any(v_types) then 'theory' when 'practical' = any(v_types) then 'practical' else 'assessment' end;

 -- Units in teaching order: the intake's unit schedule, else the course's active units. Hours: the accepted SLIT split,
 -- else 40 / 40 / 20 of the nominal hours (the same suggestion the Units page makes).
 for u in
  with ordered as (
   select cu.id, cu.code, cu.slit_hours, cu.theory_hours, cu.practical_hours, cu.assessment_hours, cu.nominal_hours, iu.sort as o
    from public.intake_units iu join public.cms_course_units cu on cu.id = iu.unit_id where iu.intake_id = v_intake.id
   union all
   select cu.id, cu.code, cu.slit_hours, cu.theory_hours, cu.practical_hours, cu.assessment_hours, cu.nominal_hours, cu.sort
    from public.cms_course_units cu
    where cu.course_id = v_intake.course_id and cu.is_active
     and not exists(select 1 from public.intake_units iu where iu.intake_id = v_intake.id))
  select id, coalesce(slit_hours, nominal_hours, 0) as total,
   coalesce(theory_hours, round(coalesce(nominal_hours, 0) * 0.4)) as th,
   coalesce(practical_hours, round(coalesce(nominal_hours, 0) * 0.4)) as pr,
   coalesce(assessment_hours, coalesce(nominal_hours, 0) - 2 * round(coalesce(nominal_hours, 0) * 0.4)) as asm
  from ordered order by o, code
 loop
  continue when u.total <= 0;
  v_units := v_units || u.id::text; v_th := v_th || u.th::numeric; v_pr := v_pr || u.pr::numeric; v_as := v_as || u.asm::numeric;
 end loop;
 if cardinality(v_units) = 0 then raise exception 'This intake has no units with hours. Set unit hours first.' using errcode = '22023'; end if;
 for v_i in 1..cardinality(v_units) loop
  if not 'practical' = any(v_types) then
   if v_fallback = 'theory' then v_th[v_i] := v_th[v_i] + v_pr[v_i]; else v_as[v_i] := v_as[v_i] + v_pr[v_i]; end if;
   v_pr[v_i] := 0;
  end if;
  if not 'assessment' = any(v_types) then
   if v_fallback = 'theory' then v_th[v_i] := v_th[v_i] + v_as[v_i]; else v_pr[v_i] := v_pr[v_i] + v_as[v_i]; end if;
   v_as[v_i] := 0;
  end if;
  if not 'theory' = any(v_types) then
   if v_fallback = 'practical' then v_pr[v_i] := v_pr[v_i] + v_th[v_i]; else v_as[v_i] := v_as[v_i] + v_th[v_i]; end if;
   v_th[v_i] := 0;
  end if;
 end loop;

 v_from := case when exists(select 1 from public.class_sessions where batch_id = p_batch)
  then greatest(v_intake.start_date, current_date) else v_intake.start_date end;
 delete from public.class_sessions where batch_id = p_batch and not is_manual and session_date >= v_from;
 -- hours already taught or fixed by hand come off each unit
 for k in select unit_id, session_type, sum(extract(epoch from end_time - start_time) / 3600) as h
  from public.class_sessions where batch_id = p_batch and status = 'scheduled' and unit_id is not null group by 1, 2 loop
  v_i := array_position(v_units, k.unit_id);
  continue when v_i is null;
  if k.session_type = 'theory' then v_th[v_i] := v_th[v_i] - k.h;
  elsif k.session_type = 'practical' then v_pr[v_i] := v_pr[v_i] - k.h;
  else v_as[v_i] := v_as[v_i] - k.h; end if;
 end loop;
 select count(*) into v_kept from public.class_sessions where batch_id = p_batch;

 v_day := v_from;
 loop
  v_left := 0;
  for v_i in 1..cardinality(v_units) loop
   v_left := v_left + greatest(v_th[v_i], 0) + greatest(v_pr[v_i], 0) + greatest(v_as[v_i], 0);
  end loop;
  exit when v_left <= 0;
  v_guard := v_guard + 1;
  if v_guard > 1500 then raise exception 'These weekly class times cannot fit the unit hours within four years.' using errcode = '22023'; end if;
  if public.rto_is_teaching_day(v_day) then
   for s in select * from public.batch_sessions where batch_id = p_batch and weekday = extract(isodow from v_day)::int order by start_time loop
    continue when exists(select 1 from public.class_sessions c where c.batch_id = p_batch and c.session_date = v_day and c.start_time = s.start_time);
    v_pick := null;
    for v_i in 1..cardinality(v_units) loop
     if (s.session_type = 'theory' and v_th[v_i] > 0) or (s.session_type = 'practical' and v_pr[v_i] > 0)
      or (s.session_type = 'assessment' and v_as[v_i] > 0) then v_pick := v_i; exit; end if;
    end loop;
    continue when v_pick is null;
    v_len := extract(epoch from s.end_time - s.start_time) / 3600;
    if s.session_type = 'theory' then v_th[v_pick] := v_th[v_pick] - v_len;
    elsif s.session_type = 'practical' then v_pr[v_pick] := v_pr[v_pick] - v_len;
    else v_as[v_pick] := v_as[v_pick] - v_len; end if;
    insert into public.class_sessions(batch_id, session_date, start_time, end_time, session_type, room_id, unit_id)
     values (p_batch, v_day, s.start_time, s.end_time, s.session_type, s.room_id, v_units[v_pick]);
    v_created := v_created + 1;
   end loop;
  end if;
  v_day := v_day + 1;
 end loop;
 select max(session_date) into v_end from public.class_sessions where batch_id = p_batch;
 return jsonb_build_object('created', v_created, 'kept', v_kept, 'from', v_from, 'endDate', v_end,
  'clashes', public.rto_class_session_clashes(p_batch));
end $$;

-- Sessions between two dates, for one batch or (p_batch null) every batch: the batch calendar and the master room grid.
create or replace function public.rto_class_sessions_list(p_batch uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, hr as $$
begin
 if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
  raise exception 'Choose a date range of up to 400 days.' using errcode = '22023'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id', c.id, 'batchId', c.batch_id, 'batch', b.name, 'courseCode', co.code, 'date', c.session_date,
   'startTime', c.start_time, 'endTime', c.end_time, 'type', c.session_type, 'roomId', c.room_id, 'room', r.name,
   'unitId', c.unit_id, 'unitCode', u.code, 'unitName', u.name, 'status', c.status, 'manual', c.is_manual,
   'trainers', (select coalesce(string_agg(btrim(concat_ws(' ', sp.first_name, sp.last_name)), ', '), '')
     from public.batch_trainers bt join hr.staff_profiles sp on sp.id = bt.staff_id where bt.batch_id = c.batch_id))
   order by c.session_date, c.start_time, b.name)
  from public.class_sessions c
  join public.batches b on b.id = c.batch_id
  join public.course_intakes i on i.id = b.intake_id
  join public.cms_courses co on co.id = i.course_id
  left join public.classrooms r on r.id = c.room_id
  left join public.cms_course_units u on u.id = c.unit_id
  where (p_batch is null or c.batch_id = p_batch) and c.session_date between p_from and p_to), '[]'::jsonb);
end $$;

-- Change one session (cancel or restore, room, date or time). It becomes manual, so regeneration keeps it.
create or replace function public.rto_class_session_update(p_id uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.class_sessions;
begin
 if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can change class sessions.' using errcode = '42501'; end if;
 if p_data ? 'status' and p_data->>'status' not in ('scheduled', 'cancelled') then
  raise exception 'Status must be scheduled or cancelled.' using errcode = '22023'; end if;
 update public.class_sessions set
  status = coalesce(p_data->>'status', status),
  room_id = case when p_data ? 'roomId' then nullif(p_data->>'roomId', '')::uuid else room_id end,
  session_date = coalesce((p_data->>'date')::date, session_date),
  start_time = coalesce((p_data->>'startTime')::time, start_time),
  end_time = coalesce((p_data->>'endTime')::time, end_time),
  is_manual = true, updated_at = now(), updated_by = auth.uid()
 where id = p_id returning * into v;
 if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
 return jsonb_build_object('id', v.id, 'clashes', public.rto_class_session_clashes(v.batch_id));
end $$;

do $$ declare f text; begin
 foreach f in array array['rto_is_teaching_day(date)', 'rto_class_session_clashes(uuid)', 'rto_class_sessions_generate(uuid)',
  'rto_class_sessions_list(uuid, date, date)', 'rto_class_session_update(uuid, jsonb)'] loop
  execute format('revoke all on function public.%s from public, anon', f);
  execute format('grant execute on function public.%s to authenticated', f);
 end loop;
end $$;
