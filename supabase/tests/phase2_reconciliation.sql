-- Guarded runner only: synthetic network:none SQL harness, never hosted.
begin;
-- Hosted guard: test suites run on a local stack only (set skyline.allow_hosted = on in the session to override; see scripts/lab/hosted-guard.mjs).
do $hosted_guard$ begin if (select system_identifier from pg_control_system()) = 7692130048193495360 and coalesce(current_setting('skyline.allow_hosted', true), '') <> 'on' then raise exception 'Refusing to run a test suite on the hosted project (xcpydisstlvtvcsqnjob); set skyline.allow_hosted = on to override.'; end if; end $hosted_guard$;
select plan(3);
select has_function('public','portal_identity',array[]::text[],'portal_identity is reproducible from migrations');
select function_returns('public','portal_identity',array[]::text[],'jsonb','identity response preserves existing browser JSON contract');
select is(has_function_privilege('authenticated',to_regprocedure('public.portal_identity()'),'execute'),true,'authenticated callers can resolve portal identity');
select * from finish();
rollback;
