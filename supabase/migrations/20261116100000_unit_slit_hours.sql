-- UNIT-SLIT-HOURS: SLIT's own delivery hours per course unit, beside the Training.gov.au nominal hours.
-- SLIT hours split into theory, practical and assessment. The page suggests the nominal hours split 40/40/20;
-- nothing is stored until an RTO Manager accepts or changes them, so hours_confirmed_at marks reviewed units.

alter table public.cms_course_units
  add column if not exists slit_hours integer,
  add column if not exists theory_hours integer,
  add column if not exists practical_hours integer,
  add column if not exists assessment_hours integer,
  add column if not exists hours_confirmed_at timestamptz,
  add column if not exists hours_confirmed_by uuid;

alter table public.cms_course_units drop constraint if exists cms_course_units_slit_hours_check;
alter table public.cms_course_units add constraint cms_course_units_slit_hours_check check (
  (slit_hours is null and theory_hours is null and practical_hours is null and assessment_hours is null)
  or (slit_hours >= 0 and theory_hours >= 0 and practical_hours >= 0 and assessment_hours >= 0
      and theory_hours + practical_hours + assessment_hours = slit_hours));

-- Any CMS staff member can read a course's unit hours.
create or replace function public.rto_unit_hours_list(p_course_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.cms_is_staff() then raise exception 'Sign in to the CMS first.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('unitId', u.id, 'slitHours', u.slit_hours, 'theoryHours', u.theory_hours,
      'practicalHours', u.practical_hours, 'assessmentHours', u.assessment_hours, 'confirmedAt', u.hours_confirmed_at))
    from public.cms_course_units u where u.course_id = p_course_id), '[]'::jsonb);
end;
$$;

-- An RTO Manager accepts or changes one unit's hours. The three parts must add up to the SLIT hours.
create or replace function public.rto_unit_hours_save(p_unit_id text, p_slit integer, p_theory integer, p_practical integer, p_assessment integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.cms_course_units;
begin
  if not public.cms_is_rto_manager() then raise exception 'Only an RTO Manager can set unit hours.' using errcode = '42501'; end if;
  if p_slit is null or p_theory is null or p_practical is null or p_assessment is null then
    raise exception 'Enter SLIT, theory, practical and assessment hours.' using errcode = '22023'; end if;
  if p_slit < 0 or p_theory < 0 or p_practical < 0 or p_assessment < 0 then
    raise exception 'Hours cannot be negative.' using errcode = '22023'; end if;
  if p_theory + p_practical + p_assessment <> p_slit then
    raise exception 'Theory, practical and assessment hours must add up to the SLIT hours (%).', p_slit using errcode = '22023'; end if;
  update public.cms_course_units set slit_hours = p_slit, theory_hours = p_theory, practical_hours = p_practical,
    assessment_hours = p_assessment, hours_confirmed_at = now(), hours_confirmed_by = auth.uid()
   where id = p_unit_id returning * into u;
  if not found then raise exception 'Unit not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('unitId', u.id, 'slitHours', u.slit_hours, 'theoryHours', u.theory_hours,
    'practicalHours', u.practical_hours, 'assessmentHours', u.assessment_hours, 'confirmedAt', u.hours_confirmed_at);
end;
$$;

revoke all on function public.rto_unit_hours_list(text) from public, anon;
grant execute on function public.rto_unit_hours_list(text) to authenticated;
revoke all on function public.rto_unit_hours_save(text, integer, integer, integer, integer) from public, anon;
grant execute on function public.rto_unit_hours_save(text, integer, integer, integer, integer) to authenticated;
