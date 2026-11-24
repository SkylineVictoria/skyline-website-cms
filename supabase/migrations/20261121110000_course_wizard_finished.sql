-- A course's wizard is finished when it has active units, its CoE weekly calendar (master timetable) and, for both CoE and VoE,
-- an intake that is not hidden / closed with its daily timetable (dated classes). New intakes are offered for those courses only.
create or replace function public.course_wizard_finished(p_course text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cms_course_units u where u.course_id = p_course and u.is_active)
    and exists (select 1 from public.course_master_timetables m where m.course_id = p_course)
    and not exists (
      select 1 from (values ('coe'), ('voe')) l(load)
      where not exists (select 1 from public.course_intakes i
        where i.course_id = p_course and i.study_load = l.load and not i.wizard_pending and coalesce(i.status, 'open') not in ('closed', 'draft')
          and exists (select 1 from public.class_sessions s where s.intake_id = i.id)));
$$;
create or replace function public.course_wizard_finished_ids() returns text[]
language plpgsql stable security definer set search_path = public as $$
begin
  if not coalesce(public.cms_is_staff(), false) then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
  return coalesce((select array_agg(c.id order by c.id) from public.cms_courses c where public.course_wizard_finished(c.id)), '{}');
end $$;
revoke all on function public.course_wizard_finished(text) from public, anon, authenticated;
revoke all on function public.course_wizard_finished_ids() from public, anon;
grant execute on function public.course_wizard_finished_ids() to authenticated;
