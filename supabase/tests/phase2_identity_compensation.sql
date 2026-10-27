-- Rehearse a temporary fail-closed disable, then restore the captured definition.
-- Never drop the RPC or data. Transaction rolls back all rehearsal changes.
begin;
select plan(3);
create temporary table identity_restore as select pg_get_functiondef('public.portal_identity()'::regprocedure) as definition;
create or replace function public.portal_identity() returns jsonb language sql stable security definer set search_path=public
as $$ select jsonb_build_object('is_slit_admin',false,'profile_id',null,'agency_id',null,'role',null) $$;
set local role authenticated;
select is(public.portal_identity()->>'role',null,'compensation fails closed');
reset role;
do $$ begin execute (select definition from identity_restore); end $$;
select is(pg_get_functiondef('public.portal_identity()'::regprocedure),(select definition from identity_restore),'original RPC restored exactly');
select ok(has_function_privilege('authenticated','public.portal_identity()','execute'),'compensation preserves authenticated callable contract');
select * from finish();
rollback;
