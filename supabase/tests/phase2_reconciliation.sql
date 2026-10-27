-- Guarded runner only: synthetic network:none SQL harness, never hosted.
begin;
select plan(3);
select has_function('public','portal_identity',array[]::text[],'portal_identity is reproducible from migrations');
select function_returns('public','portal_identity',array[]::text[],'jsonb','identity response preserves existing browser JSON contract');
select is(has_function_privilege('authenticated',to_regprocedure('public.portal_identity()'),'execute'),true,'authenticated callers can resolve portal identity');
select * from finish();
rollback;
