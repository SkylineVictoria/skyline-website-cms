-- Direct LMS allocations reuse CRM students and the course catalogue. No timetable or admissions writes.
create schema lms_allocation_private;
revoke all on schema lms_allocation_private from public, anon, authenticated;
grant usage on schema lms_allocation_private to authenticated;

alter table public.course_intakes add constraint course_intakes_id_course_key unique (id, course_id);
alter table public.cms_course_units add constraint cms_course_units_id_course_key unique (id, course_id);

create table public.lms_intake_students (
  intake_id uuid not null references public.course_intakes(id) on delete cascade,
  student_id uuid not null references public.enrollment_students(id) on delete cascade,
  enrolled_at timestamptz not null default now(),
  primary key (intake_id, student_id)
);

create table public.lms_unit_students (
  intake_id uuid not null,
  unit_id text not null,
  student_id uuid not null,
  course_id text not null,
  allocated_at timestamptz not null default now(),
  primary key (intake_id, unit_id, student_id),
  foreign key (intake_id, student_id) references public.lms_intake_students(intake_id, student_id) on delete cascade,
  foreign key (intake_id, course_id) references public.course_intakes(id, course_id) on delete cascade,
  foreign key (unit_id, course_id) references public.cms_course_units(id, course_id) on delete cascade
);

create index lms_intake_students_student_idx on public.lms_intake_students(student_id);
create index lms_unit_students_enrolment_idx on public.lms_unit_students(intake_id, student_id);
create index lms_unit_students_unit_idx on public.lms_unit_students(unit_id, course_id);

-- RLS denies direct browser access. All operations pass through the scoped LMS function.
alter table public.lms_intake_students enable row level security;
alter table public.lms_unit_students enable row level security;
revoke all on public.lms_intake_students, public.lms_unit_students from public, anon, authenticated;

create function lms_allocation_private.intake_students(
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
        'id', s.id, 'name', s.full_name, 'email', s.email
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

      insert into public.lms_intake_students (intake_id, student_id)
      select p_intake_id, requested.id from unnest(p_student_ids) requested(id)
      order by requested.id
      on conflict (intake_id, student_id) do nothing;

      if p_unit_id is not null then
        insert into public.lms_unit_students (intake_id, unit_id, student_id, course_id)
        select p_intake_id, p_unit_id, requested.id, p_course_id from unnest(p_student_ids) requested(id)
        order by requested.id
        on conflict (intake_id, unit_id, student_id) do nothing;
      end if;
      return 'null'::jsonb;

    when 'remove_unit_student' then
      if p_unit_id is null or coalesce(cardinality(p_student_ids), 0) <> 1 then
        raise exception 'Select a unit and one student.' using errcode = '22023';
      end if;
      delete from public.lms_unit_students a using public.enrollment_students s
      where a.intake_id = p_intake_id and a.unit_id = p_unit_id and a.student_id = p_student_ids[1]
        and s.id = a.student_id and s.tenant_id is not distinct from v_tenant;
      return 'null'::jsonb;

    else
      raise exception 'Unknown student allocation action.' using errcode = '22023';
  end case;
  return v_result;
end
$$;

create function public.lms_intake_students(
  p_action text,
  p_course_id text,
  p_intake_id uuid default null,
  p_unit_id text default null,
  p_student_ids uuid[] default null,
  p_search text default ''
) returns jsonb
language sql security invoker set search_path = ''
as $$
  select lms_allocation_private.intake_students(
    p_action, p_course_id, p_intake_id, p_unit_id, p_student_ids, p_search
  );
$$;

revoke all on function lms_allocation_private.intake_students(text, text, uuid, text, uuid[], text) from public, anon, authenticated;
grant execute on function lms_allocation_private.intake_students(text, text, uuid, text, uuid[], text) to authenticated;
revoke all on function public.lms_intake_students(text, text, uuid, text, uuid[], text) from public, anon, authenticated;
grant execute on function public.lms_intake_students(text, text, uuid, text, uuid[], text) to authenticated;
