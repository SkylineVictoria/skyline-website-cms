-- UNIT-PREREQ-MANUAL (owner, 2026-11-18): staff choose a unit's prerequisites by hand (LMS > Units > a unit > Details), on top of
-- those read from Training.gov.au. Both feed every prerequisite rule (rto_unit_requires: timeline order, late joiners, carry-over)
-- and show on the main Units list. Only an RTO Manager sets them; a unit cannot require itself or a unit that already requires it.
-- Additive: column cms_course_units.prerequisite_ids, rto_unit_requires replaced (as hosted plus the hand-picked units), new
-- unit_prerequisites_set. Rollback (manual): restore rto_unit_requires from 20261117213518; drop function unit_prerequisites_set;
-- alter table cms_course_units drop column prerequisite_ids.
begin;

alter table public.cms_course_units add column if not exists prerequisite_ids text[] not null default '{}';

-- The units of the same course that a unit needs first: named in its Training.gov.au prerequisites, or picked by staff.
create or replace function public.rto_unit_requires(p_unit text) returns setof text
language sql stable security definer set search_path = public as $function$
 select c.id from public.cms_course_units u
 join public.cms_course_units c on c.course_id = u.course_id and c.id <> u.id and c.is_active
 where u.id = p_unit and coalesce(btrim(u.tga_prerequisites), '') <> ''
  and regexp_replace(upper(coalesce(c.code, '')), '[^A-Z0-9]', '', 'g') ~ '^[A-Z]{3,}[A-Z0-9]*[0-9]'
  and upper(u.tga_prerequisites) ~ ('\m' || regexp_replace(upper(c.code), '[^A-Z0-9]', '', 'g') || '\M')
 union
 select c.id from public.cms_course_units u
 join public.cms_course_units c on c.course_id = u.course_id and c.id <> u.id and c.is_active
 where u.id = p_unit and c.id = any(u.prerequisite_ids);
$function$;

create function public.unit_prerequisites_set(p_unit text, p_ids text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u public.cms_course_units; v_ids text[] := coalesce((select array_agg(distinct x) from unnest(coalesce(p_ids, '{}')) x where x is not null and x <> ''), '{}'); bad text;
begin
  if not coalesce(public.cms_is_rto_manager(), false) then raise exception 'Only an RTO Manager can set prerequisites' using errcode = '42501'; end if;
  select * into u from public.cms_course_units where id = p_unit;
  if u.id is null then raise exception 'Unit not found' using errcode = 'P0002'; end if;
  if p_unit = any(v_ids) then raise exception 'A unit cannot be its own prerequisite' using errcode = '22023'; end if;
  select x into bad from unnest(v_ids) x where not exists (select 1 from public.cms_course_units c where c.id = x and c.course_id = u.course_id) limit 1;
  if bad is not null then raise exception 'Prerequisites must be units of the same course' using errcode = '22023'; end if;
  select c.code into bad from unnest(v_ids) x join public.cms_course_units c on c.id = x
  where p_unit in (select public.rto_unit_requires_all(x)) limit 1;
  if bad is not null then raise exception '% already needs this unit first, so it cannot also be its prerequisite', bad using errcode = '22023'; end if;
  update public.cms_course_units set prerequisite_ids = v_ids where id = p_unit;
  return public.rto_course_prereqs(u.course_id);
end;
$$;

revoke all on function public.unit_prerequisites_set(text, text[]) from public, anon;
grant execute on function public.unit_prerequisites_set(text, text[]) to authenticated;

commit;
