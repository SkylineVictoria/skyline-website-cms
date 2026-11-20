-- Read-only unit calendar of an intake that is on offer, for the application form (students, agents, staff): unit, dates, hours.
create or replace function public.intake_unit_calendar(p_intake uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_course text;
begin
 if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
 select course_id into v_course from public.course_intakes where id = p_intake;
 if v_course is null or p_intake not in (select public.course_intake_offered(v_course)) then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('unitCode', u.code, 'unitName', u.name, 'unitType', u.unit_type,
    'startDate', s.start_date, 'endDate', s.end_date, 'hours', s.hours) order by s.start_date, s.sort)
  from public.intake_units s join public.cms_course_units u on u.id = s.unit_id where s.intake_id = p_intake), '[]'::jsonb);
end $$;
revoke all on function public.intake_unit_calendar(uuid) from public, anon;
grant execute on function public.intake_unit_calendar(uuid) to authenticated;
