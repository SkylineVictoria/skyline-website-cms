begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
-- AVETMISS-AUDIT (20261127070517): the full audit runs read-only and reports by rule; an assessment result applies to exactly one unit
-- enrolment, otherwise it waits in avetmiss_outcome_reconcile; the AVETMISS guards cannot be dropped silently. Rolled back.
-- Run: node scripts/lab/staff-lab.mjs sql
select plan(8);

select lives_ok($$select count(*) from public.avetmiss_full_audit()$$, 'the full audit runs');
select ok((select bool_and(severity in ('critical', 'warning')) from public.avetmiss_full_audit()) is not false, 'every finding has a severity');
select ok((select bool_and(rule ~ '^AVM-[A-Z]+-[0-9]{3}$') from public.avetmiss_full_audit()) is not false, 'every finding names its rule');
select has_table('public', 'avetmiss_outcome_reconcile', 'unmatched assessment results are kept for staff');
select ok(pg_get_functiondef('public.asm_outcome_to_avetmiss'::regproc) like '%if v_matches <> 1 then%', 'a result applies to exactly one unit enrolment');
select ok(pg_get_functiondef('public.asm_outcome_to_avetmiss'::regproc) like '%not in (''40'', ''41'', ''51'', ''52'', ''60'', ''61'')%', 'withdrawal, RPL, credit transfer and superseded outcomes are never overwritten');
select is((select count(*)::int from public.avetmiss_guard_gaps()), 0, 'no AVETMISS column without a guard');
select ok(exists (select 1 from pg_trigger where tgname = 'asm_outcome_to_avetmiss'), 'the sign-off trigger is installed');

select * from finish();
rollback;
