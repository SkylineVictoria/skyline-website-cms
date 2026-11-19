-- LIVE-COURSES + JOIN-DATES (2026-11-20, owner):
-- 1. A course goes live (Published, active) by itself when its wizard is finished: active units, a saved master timetable and an
--    intake whose classes have been created. Once live it stays live. Courses already finished are made live here.
-- 2. The application form lists live (Published) courses only; an unfinished course is refused on submit.
-- 3. The form's intake dropdown lists start dates: day one of an intake not started yet and every upcoming unit start of the
--    offered intakes (course_join_options), each saying the unit and whether missed prerequisites come first. The date picked is
--    kept in the application values (intake_join_date), checked on submit, and automatic placement starts the student there.
begin;

-- 1. Live when the wizard is finished.
create or replace function public.course_setup_complete(p_course text) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.cms_course_units u where u.course_id = p_course and u.is_active)
     and exists (select 1 from public.course_master_timetables m where m.course_id = p_course)
     and exists (select 1 from public.class_sessions s join public.course_intakes i on i.id = s.intake_id
                  where i.course_id = p_course and coalesce(i.status, 'open') not in ('closed', 'draft'));
$$;
revoke all on function public.course_setup_complete(text) from public, anon, authenticated;

create or replace function public.course_go_live_after_classes() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  update public.cms_courses c set status = 'Published', is_active = true
   where c.id in (select distinct i.course_id from new_rows n join public.course_intakes i on i.id = n.intake_id)
     and (c.status is distinct from 'Published' or not c.is_active)
     and public.course_setup_complete(c.id);
  return null;
end $$;
drop trigger if exists class_sessions_course_go_live on public.class_sessions;
create trigger class_sessions_course_go_live after insert on public.class_sessions
  referencing new table as new_rows for each statement execute function public.course_go_live_after_classes();

update public.cms_courses c set status = 'Published', is_active = true
 where (c.status is distinct from 'Published' or not c.is_active) and public.course_setup_complete(c.id);

-- 2. The form lists live courses only.
do $$
declare d text := pg_get_functiondef('public.portal_course_options'::regproc::oid);
  a text := 'and (c.status = ''Published'' or exists (select 1 from public.course_intake_offered(c.id)));';
begin
  if position(a in d) = 0 then raise exception 'portal_course_options: anchor not found'; end if;
  execute replace(d, a, 'and c.status = ''Published'';');
end $$;

-- 3. Start dates for the dropdown.
create or replace function public.course_join_options(p_course text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_cid text := public.course_resolve_id(p_course); v_today date := public.course_intake_today(); v_old jsonb; v_list jsonb;
begin
  -- Keeps the automatic next intake and the fallback months of the old list.
  v_old := public.course_intakes_open(p_course);
  if v_cid is null then return v_old; end if;
  select coalesce(jsonb_agg(public.course_intake_json(i) || jsonb_build_object(
      'fallback', false, 'running', i.start_date <= v_today, 'joinDate', s.d, 'firstDay', s.d = i.start_date,
      'unitCode', cu.code, 'unitName', cu.name, 'prereqFirst', p.missed,
      'option', format('Starts %s – %s (%s)%s', to_char(s.d, 'FMDD Mon YYYY'),
        case when s.d = i.start_date then 'day one of the course' else coalesce(cu.code || ' ' || cu.name, 'next unit') end,
        public.course_intake_name(i), case when p.missed then ' · missed prerequisites first' else '' end))
    order by s.d, i.start_date, i.id), '[]'::jsonb) into v_list
  from public.course_intakes i
  cross join lateral (
    select distinct z.d from (select i.start_date d union all select u.start_date from public.intake_units u where u.intake_id = i.id) z
     where z.d >= v_today and (i.end_date is null or z.d <= i.end_date)) s
  left join lateral (select u.unit_id from public.intake_units u where u.intake_id = i.id and u.start_date = s.d order by u.sort, u.id limit 1) fu on true
  left join public.cms_course_units cu on cu.id = fu.unit_id
  cross join lateral (select s.d > i.start_date and exists (
      select 1 from public.intake_units q cross join lateral public.rto_unit_requires(q.unit_id) r(unit_id)
        join public.intake_units pr on pr.intake_id = i.id and pr.unit_id = r.unit_id
       where q.intake_id = i.id and q.start_date >= s.d and pr.start_date < s.d) missed) p
  where i.id in (select public.course_intake_offered(v_cid));
  if jsonb_array_length(v_list) > 0 then return v_list; end if;
  return v_old;
end $$;
revoke all on function public.course_join_options(text) from public;
grant execute on function public.course_join_options(text) to anon, authenticated;

-- Submit check: the course is live, and the start date picked belongs to the chosen intake.
create or replace function public.application_intake_problem(p_application_id uuid)
 returns text language plpgsql stable security definer set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare k record; v_values jsonb := public.application_values(p_application_id); v_first record; v_join date;
begin
 for k in select c.course_id, c.intake_id from public.enrollment_application_courses c where c.application_id = p_application_id order by c.created_at loop
  if not exists (select 1 from public.cms_courses x where x.id = k.course_id and x.status = 'Published') then
   return 'This course is not open for applications yet. Choose another course.';
  end if;
  if k.intake_id is null then
   -- No intake row: allowed only for a course that has no open intake (the fallback months).
   if public.course_has_open_intake(k.course_id) then return 'Choose an intake for the course'; end if;
  elsif not public.course_intake_open_for(k.intake_id, k.course_id) then return 'The chosen intake is not open for this course any more. Choose another intake.';
  end if;
 end loop;
 select c.course_id, c.intake_id into v_first from public.enrollment_application_courses c where c.application_id = p_application_id order by c.created_at limit 1;
 if not found then return null; end if;
 if v_first.intake_id is not null then
  if (v_values->>'preferred_intake') is distinct from (select public.course_intake_display(i) from public.course_intakes i where i.id = v_first.intake_id) then
   return 'The preferred intake does not match the chosen intake. Choose the intake again.';
  end if;
  if nullif(v_values->>'intake_join_date', '') is not null then
   begin v_join := (v_values->>'intake_join_date')::date; exception when others then return 'Choose the start date again.'; end;
   if not exists (select 1 from public.course_intakes i where i.id = v_first.intake_id and i.start_date = v_join)
      and not exists (select 1 from public.intake_units u where u.intake_id = v_first.intake_id and u.start_date = v_join) then
    return 'The chosen start date is not a start of this intake any more. Choose the start date again.';
   end if;
  end if;
 elsif not exists (select 1 from jsonb_array_elements(public.course_intake_fallback(v_first.course_id)) x where x->>'display' = v_values->>'preferred_intake') then
  return 'Choose one of the listed start months for the course.';
 end if;
 return null;
end $function$;

-- Automatic placement starts the student on the date picked (never before today or the intake's day one).
do $$
declare d text := pg_get_functiondef('public.rto_auto_place_one'::regproc::oid);
  a text := 'greatest(public.course_intake_today(), coalesce(i.start_date, public.course_intake_today())));';
  b text := 'greatest(public.course_intake_today(), coalesce(i.start_date, public.course_intake_today()),'
         || ' coalesce(case when c.id = (select x.id from public.enrollment_application_courses x where x.application_id = a.id order by x.created_at limit 1)'
         || ' then nullif(public.application_values(a.id)->>''intake_join_date'', '''')::date end, public.course_intake_today())));';
begin
  if position('intake_join_date' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'rto_auto_place_one: anchor not found'; end if;
  execute replace(d, a, b);
end $$;

insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261120140000', 'live_courses_join_dates', array['see repo file']) on conflict do nothing;
commit;
