-- ENROLMENT-UNITS-FASTER (2026-11-18): rto_enrolment_units (as in 20261118120000) did its prerequisite checks once for every unit row, so a batch of 34
-- units took about 100 ms per call and the carry-over planner (which calls it many times) made an intake change take minutes. The same rules are now
-- computed once per call: the batch's units and the prerequisite pairs are read once, and whether a prerequisite was missed is decided once.
-- Results are identical (same suite); additive redefinition. Rollback (manual): restore the 20261118120000 definition.
create or replace function public.rto_enrolment_units(p_enrolment uuid) returns table(intake_unit_id uuid, unit_id text, start_date date, end_date date, sort integer)
language sql stable security definer set search_path = public as $$
 with e as (select * from public.batch_enrolments where id = p_enrolment),
 bu as (select u.* from e cross join lateral public.rto_batch_units(e.batch_id) u),
 req as (select b.unit_id, r.req_unit from bu b cross join lateral public.rto_unit_requires_all(b.unit_id) as r(req_unit)),
 missed as (select exists (
   select 1 from e, bu p
   where p.end_date < e.enrolled_on
    and exists (select 1 from req q where q.unit_id <> p.unit_id and q.req_unit = p.unit_id)
    and not exists (select 1 from public.rto_unit_outcome(e.student_id, p.unit_id) o where o.outcome = 'C')) as m)
 select u.intake_unit_id, u.unit_id, u.start_date, u.end_date, u.sort
 from e cross join bu u cross join missed
 where case when e.carry_over then exists (select 1 from public.batch_enrolment_units eu where eu.enrolment_id = e.id and eu.unit_id = u.unit_id)
  else u.end_date >= e.enrolled_on and not missed.m
   and not exists (
    select 1 from req q join bu p on p.unit_id = q.req_unit
    where q.unit_id = u.unit_id and p.end_date < e.enrolled_on
     and not exists (select 1 from public.rto_unit_outcome(e.student_id, q.req_unit) o where o.outcome = 'C' and o.signed_on <= u.start_date)) end;
$$;
