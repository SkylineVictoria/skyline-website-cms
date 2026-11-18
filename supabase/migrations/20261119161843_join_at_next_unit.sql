-- JOIN-AT-NEXT-UNIT (owner, 2026-11-19): a student never starts in the middle of a unit. A unit already running on the join day is
-- not given to them (it comes round in the next cycle); they start at the next unit's start date. If a prerequisite unit has already
-- started, the student first does the prerequisites on their own from the join day (student_prereq_catchup, stage 3), then joins
-- the group at the first unit that starts after their catch-up ends.
-- Fix: the catch-up list was worked out once on the join day, so a prerequisite running while the student was still catching up
-- was missed and every unit needing it was blocked (a student joining mid-unit 1 got only one unit). It is now repeated until stable.
-- Patched in place on the hosted definitions (marker JOIN-AT-NEXT-UNIT): rto_enrolment_units (start_date >= join day instead of
-- end_date >= join day), rto_batch_assign (master catch-up loop). Verified in a rolled-back probe on CPC30326 Intake 1 (joins on
-- day 1: 34 units; mid unit 1 / after prerequisites / mid CPCCCA2011: catch-up then the next unit start, 33 / 33 / 30 units).
-- Rollback (manual): put back 'u.end_date >= e.enrolled_on' in rto_enrolment_units and the three-line catch-up block in rto_batch_assign.
do $m$
declare d text; a text; b text;
begin
  d := pg_get_functiondef('public.rto_enrolment_units(uuid)'::regprocedure);
  if (select count(*) from regexp_matches(d, 'u\.end_date >= e\.enrolled_on and not missed\.m', 'g')) <> 1 then raise exception 'anchor 1 missing'; end if;
  execute replace(d, 'u.end_date >= e.enrolled_on and not missed.m', 'u.start_date >= e.enrolled_on and not missed.m /* JOIN-AT-NEXT-UNIT */');
  d := pg_get_functiondef('public.rto_batch_assign(uuid,text,uuid,text,date)'::regprocedure);
  a := '   v_from := v_on;' || E'\r\n' || '   v_return := public.course_master_catchup_end(v_src.course_id, v_p, v_on);' || E'\r\n'
    || '   v_on := coalesce((select min(iu.start_date) from public.intake_units iu where iu.intake_id = v_intake and iu.start_date > v_return), v_return + 1);' || E'\r\n';
  if position(a in d) = 0 then raise exception 'anchor 2 missing'; end if;
  b := '   v_from := v_on;' || E'\n'
    || '   -- JOIN-AT-NEXT-UNIT: prerequisites that run while the student is still catching up are added too, until the list is stable' || E'\n'
    || '   for v_round in 1..10 loop' || E'\n'
    || '    v_return := public.course_master_catchup_end(v_src.course_id, v_p, v_from);' || E'\n'
    || '    v_on := coalesce((select min(iu.start_date) from public.intake_units iu where iu.intake_id = v_intake and iu.start_date > v_return), v_return + 1);' || E'\n'
    || '    select count(*) into v_n from unnest(v_p);' || E'\n'
    || '    select array_agg(distinct p.unit_id) into v_p from public.intake_units p' || E'\n'
    || '    where p.intake_id = v_intake and p.start_date < v_on' || E'\n'
    || '     and exists (select 1 from public.intake_units x where x.intake_id = v_intake and x.unit_id <> p.unit_id and p.unit_id in (select public.rto_unit_requires_all(x.unit_id)))' || E'\n'
    || '     and not exists (select 1 from public.rto_unit_outcome(p_student, p.unit_id) o where o.outcome = ''C'');' || E'\n'
    || '    exit when cardinality(v_p) = v_n;' || E'\n'
    || '   end loop;' || E'\n';
  execute replace(d, a, b);
end $m$;
