alter table public.batch_enrolments add column if not exists prereq_first boolean not null default false;

create or replace function public.rto_enrolment_pending(e public.batch_enrolments) returns boolean
language sql stable security definer set search_path = public as $function$
 select e.carry_over and not coalesce(e.prereq_first, false) and e.status in ('active', 'deferred') and e.enrolled_on > public.course_intake_today()
  and not exists (select 1 from public.lms_attendance_marks m where m.enrolment_id = e.id);
$function$;

create or replace function public.rto_enrolment_units(p_enrolment uuid)
returns table(intake_unit_id uuid, unit_id text, start_date date, end_date date, sort integer)
language sql stable security definer set search_path = public as $function$
 with e as (select * from public.batch_enrolments where id = p_enrolment),
 bu as (select u.* from e cross join lateral public.rto_batch_units(e.batch_id) u),
 req as (select b.unit_id, r.req_unit from bu b cross join lateral public.rto_unit_requires_all(b.unit_id) as r(req_unit)),
 planned as (
  select eu.unit_id, max(x.end_date) as end_date
  from e join public.batch_enrolments c on c.student_id = e.student_id and c.id <> e.id and c.status in ('active', 'deferred', 'completed')
  join public.batch_enrolment_units eu on eu.enrolment_id = c.id
  cross join lateral public.rto_batch_units(c.batch_id) x
  where x.unit_id = eu.unit_id
  group by eu.unit_id),
 missed as (select exists (
   select 1 from e, bu p
   where p.end_date < e.enrolled_on
    and exists (select 1 from req q where q.unit_id <> p.unit_id and q.req_unit = p.unit_id)
    and not exists (select 1 from public.rto_unit_outcome(e.student_id, p.unit_id) o where o.outcome = 'C')
    and not exists (select 1 from planned pl where pl.unit_id = p.unit_id and pl.end_date < e.enrolled_on)) as m)
 select u.intake_unit_id, u.unit_id, u.start_date, u.end_date, u.sort
 from e cross join bu u cross join missed
 where case when e.carry_over then exists (select 1 from public.batch_enrolment_units eu where eu.enrolment_id = e.id and eu.unit_id = u.unit_id)
  else u.end_date >= e.enrolled_on and not missed.m
   and not exists (
    select 1 from req q join bu p on p.unit_id = q.req_unit
    where q.unit_id = u.unit_id and p.end_date < e.enrolled_on
     and not exists (select 1 from public.rto_unit_outcome(e.student_id, q.req_unit) o where o.outcome = 'C' and o.signed_on <= u.start_date)
     and not exists (select 1 from planned pl where pl.unit_id = q.req_unit and pl.end_date < u.start_date)) end;
$function$;

create or replace function public.rto_batch_assign(p_student uuid, p_course text, p_intake uuid default null, p_type text default 'CoE', p_on date default current_date)
returns uuid language plpgsql security definer set search_path = public as $function$
declare v_intake uuid := p_intake; v_batch uuid; v_enrol uuid; v_latest uuid; v_on date := p_on; v_next uuid; v_src public.course_intakes;
 v_pbatch uuid; v_p text[]; v_from date; v_to date; v_return date; v_prev_return date; v_round integer; v_penrol uuid; v_was text;
begin
 if not public.rto_auto_placing() then raise exception 'Students are placed in batches automatically when their offer is accepted.' using errcode = '42501'; end if;
 if v_intake is null then
  v_intake := public.rto_open_intake(p_course, v_on);
  if v_intake is null then
   select ci.id into v_latest from public.course_intakes ci where ci.course_id = p_course order by ci.start_date desc limit 1;
   if v_latest is not null then v_intake := public.rto_intake_auto_next(v_latest); end if;
  end if;
  if v_intake is null then raise exception 'This course has no open intake. Add one first.' using errcode = '22023'; end if;
 end if;
 select e.id into v_enrol from public.batch_enrolments e join public.batches b on b.id = e.batch_id
 where b.intake_id = v_intake and e.student_id = p_student and e.status in ('active', 'deferred') order by e.carry_over, e.enrolled_on limit 1;
 if v_enrol is not null then return v_enrol; end if;
 if public.rto_prereq_missed(p_student, v_intake, v_on) then
  select * into v_src from public.course_intakes where id = v_intake;
  select ci.id into v_next from public.course_intakes ci
  where ci.course_id = v_src.course_id and ci.study_load = v_src.study_load and ci.is_active and ci.status = 'open' and ci.start_date > v_src.start_date
  order by ci.start_date, ci.id limit 1;
  if v_next is null then v_next := public.rto_intake_auto_next(v_intake); end if;
  if v_next is not null then
   v_pbatch := public.rto_batch_pick(v_next, null, (select start_date from public.course_intakes where id = v_next), true);
   v_return := v_on;
   if v_pbatch is not null then
    for v_round in 1..6 loop
     select array_agg(distinct p.unit_id) into v_p from public.intake_units p
     where p.intake_id = v_intake and p.end_date < v_return
      and exists (select 1 from public.intake_units x where x.intake_id = v_intake and x.unit_id <> p.unit_id and p.unit_id in (select public.rto_unit_requires_all(x.unit_id)))
      and not exists (select 1 from public.rto_unit_outcome(p_student, p.unit_id) o where o.outcome = 'C');
     select min(u.start_date), max(u.end_date) into v_from, v_to from public.rto_batch_units(v_pbatch) u where u.unit_id = any(v_p);
     exit when v_to is null;
     v_prev_return := v_return;
     v_return := greatest(v_on, v_to + 1);
     exit when v_return = v_prev_return;
    end loop;
   end if;
   if v_pbatch is not null and v_to is not null and cardinality(v_p) > 0
      and exists (select 1 from public.intake_units iu where iu.intake_id = v_intake and iu.start_date >= v_return) then
    v_was := coalesce(current_setting('rto.carry_over_planning', true), '');
    perform set_config('rto.carry_over_planning', 'on', true);
    insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on, carry_over, prereq_first)
    values (v_pbatch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_from, true, true)
    on conflict (batch_id, student_id) do update set status = 'active', enrolled_on = excluded.enrolled_on, carry_over = true, prereq_first = true
    returning id into v_penrol;
    insert into public.batch_enrolment_units(enrolment_id, unit_id) select v_penrol, unnest(v_p) on conflict do nothing;
    perform set_config('rto.carry_over_planning', v_was, true);
    v_on := v_return;
   else
    select ci.start_date into v_on from public.course_intakes ci where ci.id = v_next;
    v_intake := v_next;
    select e.id into v_enrol from public.batch_enrolments e join public.batches b on b.id = e.batch_id
    where b.intake_id = v_intake and e.student_id = p_student and e.status in ('active', 'deferred') order by e.carry_over, e.enrolled_on limit 1;
    if v_enrol is not null then return v_enrol; end if;
   end if;
  end if;
 end if;
 v_batch := public.rto_batch_pick(v_intake, null, v_on);
 if v_batch is null then
  raise exception 'No batch could be opened for this intake. Set the course''s class days and times first.' using errcode = '22023';
 end if;
 if not public.rto_student_on_course(p_student, p_course) then
  perform public.rto_direct_application(p_student, v_intake);
 end if;
 insert into public.batch_enrolments(batch_id, student_id, enrolment_type, status, enrolled_on)
 values (v_batch, p_student, coalesce(nullif(p_type, ''), 'CoE'), 'active', v_on)
 on conflict (batch_id, student_id) do update set status = 'active', enrolment_type = excluded.enrolment_type
 returning id into v_enrol;
 return v_enrol;
end $function$;