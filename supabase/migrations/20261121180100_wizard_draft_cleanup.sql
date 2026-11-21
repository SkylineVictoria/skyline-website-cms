-- WIZARD DRAFT CLEANUP, BACK AND LOUD (owner, 2026-11-21): daily timetables are saved as hidden draft intakes while the
-- wizard runs (20261121180000), so an abandoned wizard (closed tab, crashed laptop) leaves hidden intakes behind again.
-- The hourly sweep is restored. Unlike before it FAILS THE MIGRATION when pg_cron is not installed: silently skipping
-- the schedule (the old behaviour) meant hidden intakes piled up forever with no error anywhere.
create or replace function public.intake_wizard_cleanup() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
 delete from public.course_intakes ci
  where ci.wizard_pending and ci.created_at < now() - make_interval(hours => public.rule_int('lms.wizard_draft_hours', 24))
    and not exists (select 1 from public.intake_enrolments e where e.intake_id = ci.id)
    and not exists (select 1 from public.lms_intake_students s where s.intake_id = ci.id)
    and not exists (select 1 from public.enrollment_application_courses c where c.intake_id = ci.id)
    and not exists (select 1 from public.asm_assignments a where a.intake_id = ci.id)
    and not exists (select 1 from public.course_completions cc where cc.intake_id = ci.id);
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function public.intake_wizard_cleanup() from public, anon, authenticated;

do $$ begin
 if not exists (select 1 from pg_extension where extname = 'pg_cron') then
  raise exception 'WIZARD-DRAFT-CLEANUP: the pg_cron extension is not installed, so hidden course-wizard draft intakes would never be removed. Enable pg_cron and re-run this migration.';
 end if;
 perform cron.unschedule(jobid) from cron.job where jobname = 'intake-wizard-cleanup';
 perform cron.schedule('intake-wizard-cleanup', '17 * * * *', 'select public.intake_wizard_cleanup()');
end $$;
