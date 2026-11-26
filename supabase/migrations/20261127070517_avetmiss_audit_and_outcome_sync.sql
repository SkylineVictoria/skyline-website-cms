-- AVETMISS-AUDIT phase 1 (owner, 2026-11-26: complete AVETMISS enforcement; see docs/compliance/AVETMISS.md).
-- 1. Assessment sign-off -> unit enrolment outcome is deterministic: exactly one unit enrolment must match (student + unit, and the
--    intake when the sign-off names one). None or several = nothing is changed and the sign-off waits in
--    public.avetmiss_outcome_reconcile for staff to resolve (never a silent no-op, never several activities updated at once).
-- 2. public.avetmiss_full_audit(): read-only findings (category, severity, record, field, rule, message) over relationships,
--    orphans, duplicates, cross-field logic, outcome reconciliation, deletion behaviour and the NAT files. Nothing is modified.

begin;

create table if not exists public.avetmiss_outcome_reconcile (
  id uuid primary key default gen_random_uuid(),
  outcome_id uuid not null references public.asm_unit_outcomes(id) on delete restrict,
  student_id uuid not null,
  unit_id text not null,
  intake_id uuid,
  reason text not null check (reason in ('no_unit_enrolment', 'ambiguous_unit_enrolment')),
  matches integer not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text check (resolution_note is null or char_length(resolution_note) between 5 and 1000)
);
comment on table public.avetmiss_outcome_reconcile is 'AVETMISS NAT00120: assessment sign-offs that matched no unit enrolment, or several; staff resolve each one.';
alter table public.avetmiss_outcome_reconcile enable row level security;
drop policy if exists avetmiss_outcome_reconcile_admin_read on public.avetmiss_outcome_reconcile;
create policy avetmiss_outcome_reconcile_admin_read on public.avetmiss_outcome_reconcile for select using (public.cms_is_admin());

create or replace function public.asm_outcome_to_avetmiss()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_day date := (new.signed_at at time zone public.institution_tz())::date;
  v_assignment uuid; v_used integer := 0; v_max integer; v_code text; v_matches integer;
begin
  if new.outcome = 'C' then
    v_code := '20';
  elsif new.outcome = 'NYC' then
    select t.assignment_id into v_assignment
      from asm_attempts t join asm_assignments a on a.id = t.assignment_id
     where a.assessment_id = new.assessment_id and t.student_id = new.student_id
     order by t.attempt_no desc, t.created_at desc limit 1;
    select count(*) into v_used
      from asm_attempts t join asm_assignments a on a.id = t.assignment_id
     where a.assessment_id = new.assessment_id and t.student_id = new.student_id
       and t.voided_at is null and t.submitted_at is not null;
    v_max := case when v_assignment is not null then asm_max_attempts(v_assignment) end;
    v_code := case when v_max is null or v_used >= v_max then '30' else '70' end;
  else
    return null;
  end if;

  -- Exactly one unit enrolment (training activity) may take this result.
  select count(*) into v_matches from lms_unit_students u
   where u.student_id = new.student_id and u.unit_id = new.unit_id
     and (new.intake_id is null or u.intake_id = new.intake_id);
  if v_matches <> 1 then
    insert into avetmiss_outcome_reconcile (outcome_id, student_id, unit_id, intake_id, reason, matches)
    values (new.id, new.student_id, new.unit_id, new.intake_id,
            case when v_matches = 0 then 'no_unit_enrolment' else 'ambiguous_unit_enrolment' end, v_matches);
    return null;
  end if;

  update lms_unit_students u
     set outcome_code = v_code, outcome_recorded_at = now(), outcome_recorded_by = new.signed_by,
         actual_end_date = case when v_code = '70' then null else v_day end,
         actual_start_date = coalesce(u.actual_start_date, least(u.assigned_start_date, v_day))
   where u.student_id = new.student_id and u.unit_id = new.unit_id
     and (new.intake_id is null or u.intake_id = new.intake_id)
     and coalesce(u.outcome_code, '') not in ('40', '41', '51', '52', '60', '61');
  return null;
end $function$;

create or replace function public.avetmiss_full_audit(p_from date default date_trunc('year', current_date)::date,
                                                      p_to date default (date_trunc('year', current_date) + interval '1 year - 1 day')::date)
returns table(category text, severity text, table_name text, record_id text, field text, rule text, message text)
language plpgsql volatile security definer set search_path to 'public' as $function$
begin
  if auth.uid() is not null and not public.cms_is_admin() then
    raise exception 'Only administrators can run the AVETMISS audit.' using errcode = '42501';
  end if;

  -- Relationships: training activity without a formal course enrolment in the same intake.
  return query select 'orphan'::text, 'critical'::text, 'lms_unit_students'::text, u.student_id::text || '/' || u.unit_id, 'intake_id'::text,
    'AVM-REL-001'::text, 'Unit enrolment has no formal course enrolment (intake_enrolments) for this student and intake.'::text
    from lms_unit_students u
   where not exists (select 1 from intake_enrolments e where e.student_id = u.student_id and e.intake_id = u.intake_id);

  -- The unit must belong to the intake's course.
  return query select 'relationship', 'critical', 'lms_unit_students', u.student_id::text || '/' || u.unit_id, 'unit_id',
    'AVM-REL-002', 'Unit ' || cu.code || ' is not a unit of the intake''s course.'
    from lms_unit_students u join cms_course_units cu on cu.id = u.unit_id join course_intakes i on i.id = u.intake_id
   where cu.course_id is distinct from i.course_id;

  -- The batch must belong to the same intake.
  return query select 'relationship', 'critical', 'lms_unit_students', u.student_id::text || '/' || u.unit_id, 'batch_id',
    'AVM-REL-003', 'Batch belongs to another intake.'
    from lms_unit_students u join intake_batches b on b.id = u.batch_id where b.intake_id <> u.intake_id;

  -- Duplicate open training activity for the same student and unit.
  return query select 'duplicate', 'critical', 'lms_unit_students', x.student_id::text || '/' || x.unit_id, 'unit_id',
    'AVM-DUP-001', x.n || ' open unit enrolments for the same student and unit (outcome blank or 70).'
    from (select student_id, unit_id, count(*) n from lms_unit_students
           where coalesce(outcome_code, '70') in ('70', '85') group by 1, 2 having count(*) > 1) x;

  -- Completions must match their enrolment's student and course.
  return query select 'relationship', 'critical', 'course_completions', cc.id::text, 'enrolment_id', 'AVM-REL-004',
    'Completion does not match its enrolment''s student or course.'
    from course_completions cc join intake_enrolments e on e.id = cc.enrolment_id join course_intakes i on i.id = e.intake_id
   where e.student_id <> cc.student_id or i.course_id <> cc.course_id;

  -- Submitted applications must reference a student.
  return query select 'orphan', 'critical', 'enrollment_applications', a.id::text, 'student_id', 'AVM-REL-005',
    'Application past draft has no student record.'
    from enrollment_applications a where a.status not in ('draft', 'withdrawn', 'rejected') and a.student_id is null;

  -- Tenant consistency between an application and its student.
  return query select 'tenant', 'critical', 'enrollment_applications', a.id::text, 'tenant_id', 'AVM-TEN-001',
    'Application and its student belong to different tenants.'
    from enrollment_applications a join enrollment_students s on s.id = a.student_id
   where a.tenant_id is not null and s.tenant_id is not null and a.tenant_id <> s.tenant_id;

  -- Cross-field: dates and outcomes on unit enrolments.
  return query select 'cross_field', 'critical', 'lms_unit_students', u.student_id::text || '/' || u.unit_id, 'actual_end_date', 'AVM-XF-001',
    'Final outcome ' || u.outcome_code || ' has no actual end date.'
    from lms_unit_students u where u.outcome_code in ('20', '30', '40', '41', '51', '52', '60', '61', '81', '82') and u.actual_end_date is null;
  return query select 'cross_field', 'warning', 'lms_unit_students', u.student_id::text || '/' || u.unit_id, 'actual_end_date', 'AVM-XF-002',
    'Actual end date is in the future.'
    from lms_unit_students u where u.actual_end_date > current_date;

  -- Cross-field: client details (date of birth, school year, disability and prior education detail).
  return query select 'cross_field', 'critical', 'enrollment_students', s.id::text, 'date_of_birth', 'AVM-XF-003',
    'Date of birth is in the future or over 100 years ago.'
    from enrollment_students s where s.date_of_birth > current_date or s.date_of_birth < current_date - interval '100 years';
  return query select 'cross_field', 'critical', 'enrollment_students', s.id::text, 'school_level_year', 'AVM-XF-004',
    'Year school completed is before the student turned 5 or after this year.'
    from enrollment_students s
   where s.school_level_year ~ '^[0-9]{4}$' and s.date_of_birth is not null
     and (s.school_level_year::int < extract(year from s.date_of_birth) + 5 or s.school_level_year::int > extract(year from current_date));
  return query select 'cross_field', 'critical', 'enrollment_students', s.id::text, 'disability_flag', 'AVM-XF-005',
    'Disability Y without any disability type (NAT00090).'
    from enrollment_students s where s.disability_flag = 'Y' and not exists (select 1 from student_disabilities d where d.student_id = s.id);
  return query select 'cross_field', 'critical', 'enrollment_students', s.id::text, 'disability_flag', 'AVM-XF-006',
    'Disability types recorded but the disability indicator is not Y.'
    from enrollment_students s where coalesce(s.disability_flag, '') <> 'Y' and exists (select 1 from student_disabilities d where d.student_id = s.id);
  return query select 'cross_field', 'critical', 'enrollment_students', s.id::text, 'prior_education_flag', 'AVM-XF-007',
    'Prior education Y without any qualification (NAT00100).'
    from enrollment_students s where s.prior_education_flag = 'Y' and not exists (select 1 from student_prior_education p where p.student_id = s.id);
  return query select 'cross_field', 'critical', 'enrollment_students', s.id::text, 'prior_education_flag', 'AVM-XF-008',
    'Prior qualifications recorded but the prior education indicator is not Y.'
    from enrollment_students s where coalesce(s.prior_education_flag, '') <> 'Y' and exists (select 1 from student_prior_education p where p.student_id = s.id);

  -- Required client details for every student with training activity.
  return query select 'mandatory', 'critical', 'enrollment_students', s.id::text, m, 'AVM-MAN-001', 'Missing for NAT00080: ' || m
    from enrollment_students s cross join lateral unnest(avetmiss_student_missing(s.id)) m
   where exists (select 1 from lms_unit_students u where u.student_id = s.id);

  -- Assessment results waiting for staff (no or several unit enrolments matched).
  return query select 'outcome', 'critical', 'avetmiss_outcome_reconcile', r.id::text, 'outcome_id', 'AVM-OUT-001',
    'Assessment result not applied: ' || replace(r.reason, '_', ' ') || ' (' || r.matches || ' matches).'
    from avetmiss_outcome_reconcile r where r.resolved_at is null;

  -- Reference data not yet loaded from the official classifications (validation is format-only for these).
  return query select 'reference', 'warning', 'avetmiss_codes', s.set_name, s.set_name, 'AVM-REF-001',
    'Official ' || s.label || ' list not loaded: values are checked for format only.'
    from (values ('field_of_education', 'ASCED field of education'), ('anzsco', 'ANZSCO occupation'), ('postcode', 'Australian postcode / suburb / state'))
           s(set_name, label)
   where not exists (select 1 from avetmiss_codes c where c.code_set = s.set_name);

  -- Deletion behaviour: cascades that can remove reportable history.
  return query select 'retention', 'warning', c.relname::text, k.conname::text, a.attname::text, 'AVM-RET-001',
    'Deleting a ' || p.relname || ' row cascades into ' || c.relname || ' (reportable history).'
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class p on p.oid = k.confrelid
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
   where k.contype = 'f' and k.confdeltype = 'c'
     and c.relname in ('lms_unit_students', 'intake_enrolment_units', 'batch_students', 'student_disabilities', 'student_prior_education', 'application_usi', 'cms_course_units');

  -- The NAT files of the period.
  return query select 'reporting', 'critical', n.nat, n.record_key, null::text, 'AVM-NAT-001', n.problem
    from avetmiss_nat_problems(avetmiss_nat_build(p_from, p_to)) n;
end $function$;

revoke all on function public.avetmiss_full_audit(date, date) from public, anon;
grant execute on function public.avetmiss_full_audit(date, date) to authenticated, service_role;

commit;
