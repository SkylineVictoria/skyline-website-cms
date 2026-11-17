-- Direct intake study plans are append-only and retain the dates assigned to each student.
alter table public.lms_unit_students
  add column assigned_start_date date,
  add column assigned_end_date date,
  add column carried_from_intake_id uuid references public.course_intakes(id);

update public.lms_unit_students a set
  assigned_start_date = (select min(u.start_date) from public.intake_units u where u.intake_id=a.intake_id and u.unit_id=a.unit_id),
  assigned_end_date = (select max(u.end_date) from public.intake_units u where u.intake_id=a.intake_id and u.unit_id=a.unit_id);

create index lms_unit_students_student_course_idx on public.lms_unit_students(student_id, course_id, unit_id);

create function lms_allocation_private.preserve_allocation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Student allocations are permanent. Their original intake and dates must be retained.' using errcode='23514';
end $$;
create trigger lms_unit_students_permanent before update or delete on public.lms_unit_students
for each row execute function lms_allocation_private.preserve_allocation();
create trigger lms_intake_students_permanent before update or delete on public.lms_intake_students
for each row execute function lms_allocation_private.preserve_allocation();

create function lms_allocation_private.unit_completed(p_student uuid, p_unit text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((
    select o.outcome = 'C' from public.asm_unit_outcomes o
    where o.student_id=p_student and o.unit_id=p_unit
    order by o.signed_at desc, o.created_at desc, o.id desc limit 1
  ), false);
$$;

create function lms_allocation_private.plan_student(p_intake uuid, p_student uuid) returns void
language plpgsql set search_path = '' as $$
declare
  intake public.course_intakes;
  next_intake public.course_intakes;
  joined date;
  boundary date;
  next_start date;
  missed text[];
begin
  select * into strict intake from public.course_intakes where id=p_intake;
  perform pg_advisory_xact_lock(hashtextextended('lms_intake_plan:'||intake.course_id,0));
  select (e.enrolled_at at time zone 'Australia/Melbourne')::date into joined
    from public.lms_intake_students e where e.intake_id=p_intake and e.student_id=p_student;

  if not exists(select 1 from public.intake_units where intake_id=p_intake)
    or exists(select 1 from public.cms_course_units u where u.course_id=intake.course_id and u.is_active
      and not exists(select 1 from public.intake_units t where t.intake_id=p_intake and t.unit_id=u.id)) then
    raise exception 'Generate dates for every active course unit before enrolling students.' using errcode='22023';
  end if;

  insert into public.lms_unit_students(intake_id,unit_id,student_id,course_id,assigned_start_date,assigned_end_date)
  select p_intake,t.unit_id,p_student,intake.course_id,min(t.start_date),max(t.end_date)
  from public.intake_units t join public.cms_course_units u on u.id=t.unit_id
  where t.intake_id=p_intake and u.course_id=intake.course_id and u.is_active
    and not lms_allocation_private.unit_completed(p_student,t.unit_id)
    and not exists(select 1 from public.lms_unit_students a
      where a.student_id=p_student and a.course_id=intake.course_id and a.unit_id=t.unit_id)
  group by t.unit_id
  having max(t.end_date)>=joined
  order by t.unit_id
  on conflict do nothing;

  select array_agg(u.id order by u.id) into missed
  from public.cms_course_units u
  where u.course_id=intake.course_id and u.is_active
    and not lms_allocation_private.unit_completed(p_student,u.id)
    and not exists(select 1 from public.lms_unit_students a
      where a.student_id=p_student and a.course_id=intake.course_id and a.unit_id=u.id);
  if coalesce(cardinality(missed),0)=0 then return; end if;

  select greatest(joined,max(t.end_date),intake.end_date) into boundary
    from public.intake_units t where t.intake_id=p_intake;
  -- Use a complete future repetition of this course after the current intake ends.
  select * into next_intake from public.course_intakes i
  where i.course_id=intake.course_id and i.study_load=intake.study_load
    and i.start_date>boundary and i.status='open'
    and not exists(select 1 from unnest(missed) m(id)
      where not exists(select 1 from public.intake_units t where t.intake_id=i.id and t.unit_id=m.id and t.start_date>boundary))
  order by i.start_date,i.id limit 1;

  if next_intake.id is null then
    perform set_config('rto.course',intake.course_id,true);
    next_start := public.rto_next_working_day(boundary+1);
    while exists(select 1 from public.course_intakes where course_id=intake.course_id and start_date=next_start) loop
      next_start := public.rto_next_working_day(next_start+1);
    end loop;
    insert into public.course_intakes(course_id,start_date,status,study_load,auto_created,campus,capacity)
    values(intake.course_id,next_start,'open',intake.study_load,true,intake.campus,intake.capacity)
    returning * into next_intake;
    perform public.intake_generate_schedule(next_intake.id,next_start,null::text[],null::date);
  end if;

  insert into public.lms_intake_students(intake_id,student_id)
    values(next_intake.id,p_student) on conflict do nothing;
  insert into public.lms_unit_students(intake_id,unit_id,student_id,course_id,assigned_start_date,assigned_end_date,carried_from_intake_id)
  select next_intake.id,t.unit_id,p_student,intake.course_id,min(t.start_date),max(t.end_date),p_intake
    from public.intake_units t where t.intake_id=next_intake.id and t.unit_id=any(missed)
    group by t.unit_id order by t.unit_id on conflict do nothing;
end $$;

revoke all on function lms_allocation_private.preserve_allocation(),
  lms_allocation_private.unit_completed(uuid,text),
  lms_allocation_private.plan_student(uuid,uuid) from public,anon,authenticated;

create or replace function lms_allocation_private.intake_students(
  p_action text,
  p_course_id text,
  p_intake_id uuid,
  p_unit_id text,
  p_student_ids uuid[],
  p_search text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_student uuid;
  v_result jsonb;
  v_search text := lower(left(btrim(coalesce(p_search, '')), 200));
begin
  if auth.uid() is null or not coalesce(case
    when public.tenant_request_domain() is null then public.cms_is_admin()
    else public.tenant_has_role(public.tenant_current(), array['tenant_admin'])
  end, false) then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  select c.tenant_id into v_tenant
  from public.cms_courses c
  where c.id = p_course_id and public.tenant_scope(c.tenant_id)
    and (c.tenant_id is null or public.tenant_has_role(c.tenant_id, array['tenant_admin']));
  if not found then
    raise exception 'Course is unavailable.' using errcode = '42501';
  end if;

  if p_action = 'counts' then
    select coalesce(jsonb_object_agg(t.intake_id, t.total), '{}') into v_result
    from (
      select e.intake_id, count(*) as total
      from public.course_intakes i
      join public.lms_intake_students e on e.intake_id = i.id
      join public.enrollment_students s on s.id = e.student_id
      where i.course_id = p_course_id and s.tenant_id is not distinct from v_tenant
      group by e.intake_id
    ) t;
    return v_result;
  end if;

  if not exists (select 1 from public.course_intakes i where i.id = p_intake_id and i.course_id = p_course_id) then
    raise exception 'Select an intake for this course.' using errcode = '22023';
  end if;
  if p_unit_id is not null and not exists (
    select 1 from public.cms_course_units u
    where u.id = p_unit_id and u.course_id = p_course_id and u.tenant_id is not distinct from v_tenant
  ) then
    raise exception 'Select a unit for this intake’s course.' using errcode = '22023';
  end if;

  case p_action
    when 'units' then
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', u.id, 'code', u.code, 'name', u.name, 'count', coalesce(t.total, 0)
      ) order by u.sort, u.code, u.id), '[]') into v_result
      from public.cms_course_units u
      left join (
        select a.unit_id, count(*) as total
        from public.lms_unit_students a
        join public.enrollment_students s on s.id = a.student_id
        where a.intake_id = p_intake_id and s.tenant_id is not distinct from v_tenant
        group by a.unit_id
      ) t on t.unit_id = u.id
      where u.course_id = p_course_id and u.tenant_id is not distinct from v_tenant;

    when 'roster' then
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.full_name, 'email', s.email,
        'plan', coalesce((
          select jsonb_agg(jsonb_build_object(
            'unitId', a.unit_id, 'code', u.code, 'intakeId', a.intake_id,
            'intakeStart', i.start_date, 'startDate', a.assigned_start_date,
            'endDate', a.assigned_end_date, 'carried', a.carried_from_intake_id is not null,
            'completed', lms_allocation_private.unit_completed(s.id,a.unit_id)
          ) order by a.assigned_start_date,a.unit_id)
          from public.lms_unit_students a join public.cms_course_units u on u.id=a.unit_id
          join public.course_intakes i on i.id=a.intake_id
          where a.student_id=s.id and a.course_id=p_course_id
        ), '[]'::jsonb)
      ) order by s.full_name, s.id), '[]') into v_result
      from public.lms_intake_students e
      join public.enrollment_students s on s.id = e.student_id
      where e.intake_id = p_intake_id and s.tenant_id is not distinct from v_tenant
        and (p_unit_id is null or exists (
          select 1 from public.lms_unit_students a
          where a.intake_id = e.intake_id and a.student_id = s.id and a.unit_id = p_unit_id
        ));

    when 'search' then
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.full_name, 'email', s.email
      ) order by s.full_name, s.id), '[]') into v_result
      from (
        select s.id, s.full_name, s.email
        from public.enrollment_students s
        where s.tenant_id is not distinct from v_tenant
          and (strpos(lower(s.full_name), v_search) > 0
            or strpos(lower(s.email), v_search) > 0 or strpos(s.id::text, v_search) > 0)
          and case when p_unit_id is null then not exists (
            select 1 from public.lms_intake_students e
            where e.intake_id = p_intake_id and e.student_id = s.id
          ) else not exists (
            select 1 from public.lms_unit_students a
            where a.intake_id = p_intake_id and a.unit_id = p_unit_id and a.student_id = s.id
          ) end
        order by s.full_name, s.id
        limit 50
      ) s;

    when 'add' then
      if coalesce(cardinality(p_student_ids), 0) not between 1 and 100 then
        raise exception 'Select between 1 and 100 students.' using errcode = '22023';
      end if;
      if exists (
        select 1 from unnest(p_student_ids) requested(id)
        where not exists (
          select 1 from public.enrollment_students s
          where s.id = requested.id and s.tenant_id is not distinct from v_tenant
        )
      ) then
        raise exception 'One or more selected students are unavailable.' using errcode = '22023';
      end if;

      -- Lock before enrolment so concurrent additions keep the same first admission date.
      perform pg_advisory_xact_lock(hashtextextended('lms_intake_plan:'||p_course_id,0));
      for v_student in select distinct id from unnest(p_student_ids) requested(id) order by id loop
        insert into public.lms_intake_students(intake_id,student_id)
          values(p_intake_id,v_student) on conflict do nothing;
        perform lms_allocation_private.plan_student(p_intake_id,v_student);
      end loop;
      return 'null'::jsonb;

    when 'remove_unit_student' then
      raise exception 'Student allocations are permanent.' using errcode='23514';

    else
      raise exception 'Unknown student allocation action.' using errcode = '22023';
  end case;
  return v_result;
end
$$;


-- Extend existing enrolments using their original admission dates, preserving existing allocations.
do $backfill$
declare e record;
begin
  for e in select intake_id,student_id from public.lms_intake_students order by enrolled_at,intake_id,student_id loop
    perform lms_allocation_private.plan_student(e.intake_id,e.student_id);
  end loop;
end $backfill$;
