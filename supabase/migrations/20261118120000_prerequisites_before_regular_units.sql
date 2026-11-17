-- PREREQ-FIRST (2026-11-18): a student who joins after a prerequisite unit of the intake has already ended, and is not Competent in it, takes
-- none of this intake's units now: the prerequisite units come first (they are the first units of every intake timeline), then the regular
-- units. The units they do not take here are owed, so the rolling carry-over places them in the next intake, prerequisites before the units
-- that need them. Before this a late joiner started the regular units that needed no prerequisite straight away.
-- A student who joins before the prerequisites have ended (or while one is running) is unaffected. Additive: rto_enrolment_units is redefined
-- (as in 20261117213518) with one more condition. Rollback (manual): restore that definition.
create or replace function public.rto_enrolment_units(p_enrolment uuid) returns table(intake_unit_id uuid, unit_id text, start_date date, end_date date, sort integer)
language sql stable security definer set search_path = public as $$
 select u.intake_unit_id, u.unit_id, u.start_date, u.end_date, u.sort
 from public.batch_enrolments e cross join lateral public.rto_batch_units(e.batch_id) u
 where e.id = p_enrolment
  and case when e.carry_over then exists(select 1 from public.batch_enrolment_units eu where eu.enrolment_id = e.id and eu.unit_id = u.unit_id)
      else u.end_date >= e.enrolled_on
       and not exists (
        select 1 from public.rto_unit_requires_all(u.unit_id) r
        join public.rto_batch_units(e.batch_id) p on p.unit_id = r
        where p.end_date < e.enrolled_on
         and not exists (select 1 from public.rto_unit_outcome(e.student_id, r) o where o.outcome = 'C' and o.signed_on <= u.start_date))
       -- a prerequisite unit (one that another unit of this batch needs) that ended before they joined and they have not passed
       and not exists (
        select 1 from public.rto_batch_units(e.batch_id) p
        where p.end_date < e.enrolled_on
         and exists (select 1 from public.rto_batch_units(e.batch_id) x where x.unit_id <> p.unit_id and p.unit_id in (select public.rto_unit_requires_all(x.unit_id)))
         and not exists (select 1 from public.rto_unit_outcome(e.student_id, p.unit_id) o where o.outcome = 'C')) end;
$$;
