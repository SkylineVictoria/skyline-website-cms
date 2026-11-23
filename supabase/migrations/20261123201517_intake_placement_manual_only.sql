-- INTAKE-PLACEMENT-MANUAL (owner, 2026-11-23): students are no longer placed in an intake automatically when their
-- application status changes. An Admin or RTO Manager places them by hand: student page "Re-add to intake"
-- (rto_readd_to_intake) or the intake Students tab "Override: place a student" (rto_staff_place), both logged in
-- rto_placement_overrides. Withdrawn / rejected applications still take the student out of their classes
-- (admissions.withdrawal_class_removal). Carry-over planning is unchanged.

create or replace function public.rto_application_placement()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
 -- Automatic placement removed: intake placement is manual only.
 if new.status in ('withdrawn', 'rejected') and public.rule_text('admissions.withdrawal_class_removal', 'Remove from classes automatically') = 'Remove from classes automatically' and old.status = any(public.students_rule_keys('students.auto_placement_application_states', array['offer_accepted', 'coe_issued', 'enrolled'])) then
  update public.intake_enrolments e set status = 'withdrawn'
  where e.student_id = new.student_id and e.status in ('active', 'deferred')
   and e.intake_id in (select ci.id from public.course_intakes ci
    where ci.course_id in (select c.course_id from public.enrollment_application_courses c where c.application_id = new.id));
 end if;
 return new;
end $function$;

create or replace function public.batch_enrolments_auto_only()
 returns trigger
 language plpgsql
as $function$
begin
 if public.rto_auto_placing() or coalesce(current_setting('rto.carry_over_planning', true), '') = 'on' then return new; end if;
 raise exception 'Students are placed in intakes by hand: use Re-add to intake on the student page (Admin or RTO Manager).' using errcode = '42501';
end $function$;
