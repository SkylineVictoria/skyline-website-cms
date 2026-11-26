-- Run against an isolated migrated database. The fixtures are rolled back.
begin;

do $$
declare
  provider_count integer;
  test_connection uuid;
  other_scope uuid := gen_random_uuid();
  version timestamptz;
  old_version timestamptz;
  secret text := '{"version":1,"fields":{"environment":"sandbox","username":"synthetic","password":"synthetic"}}';
begin
  select count(*) into provider_count from public.integration_definitions where id in
    ('openai','postmark','geoscape','training_gov_au','cloudflare_turnstile','abr','data_gov_au','nager_date');
  assert provider_count = 8, 'All eight providers are registered';
  assert not exists(select 1 from public.integration_connections where connector_id in ('data_gov_au','nager_date')),
    'Public providers require no connection records';
  assert not has_function_privilege('authenticated', 'public.integration_managed_runtime(uuid,text)', 'EXECUTE'),
    'Clients cannot access the runtime secret';
  assert not has_function_privilege('anon', 'public.integration_managed_change(uuid,text,text,uuid,timestamptz,text)', 'EXECUTE'),
    'Anonymous clients cannot update managed credentials';
  assert not has_function_privilege('authenticated', 'public.integration_managed_change(uuid,text,text,uuid,timestamptz,text)', 'EXECUTE'),
    'Authenticated clients require the scoped Edge Function';

  assert public.integration_managed_runtime(null, 'training_gov_au')->>'state' = 'legacy';
  test_connection := public.integration_managed_change(null, 'training_gov_au', 'save', null, null, secret);
  select updated_at into version from public.integration_connections where id = test_connection;
  assert public.integration_managed_runtime(null, 'training_gov_au')->>'state' = 'staged';
  assert public.integration_managed_runtime(null, 'training_gov_au')->>'credential' is null;
  begin
    perform public.integration_managed_change(null, 'training_gov_au', 'activate', test_connection, version);
    raise exception 'Expected untested activation to be refused' using errcode = 'XX000';
  exception when raise_exception then null;
  end;
  begin
    perform public.integration_managed_change(other_scope, 'training_gov_au', 'tested', test_connection, version);
    raise exception 'Expected cross-tenant mutation to be refused' using errcode = 'XX000';
  exception when raise_exception then null;
  end;

  old_version := version - interval '1 second';
  begin
    perform public.integration_managed_change(null, 'training_gov_au', 'tested', test_connection, old_version);
    raise exception 'Expected stale test to be refused' using errcode = 'XX000';
  exception when raise_exception then null;
  end;
  perform public.integration_managed_change(null, 'training_gov_au', 'tested', test_connection, version);
  select updated_at into version from public.integration_connections where id = test_connection;
  perform public.integration_managed_change(null, 'training_gov_au', 'activate', test_connection, version);
  assert public.integration_managed_runtime(null, 'training_gov_au')->>'credential' = secret;
  assert public.integration_managed_runtime(other_scope, 'training_gov_au')->>'state' = 'legacy';
  assert public.integration_managed_runtime(other_scope, 'training_gov_au')->>'credential' is null;

  select updated_at into version from public.integration_connections where id = test_connection;
  perform public.integration_managed_change(null, 'training_gov_au', 'disable', test_connection, version);
  assert public.integration_managed_runtime(null, 'training_gov_au')->>'state' = 'disabled';
  assert public.integration_managed_runtime(null, 'training_gov_au')->>'credential' is null;
  select updated_at into version from public.integration_connections where id = test_connection;
  perform public.integration_managed_change(null, 'training_gov_au', 'save', test_connection, version, secret);
  assert public.integration_managed_runtime(null, 'training_gov_au')->>'state' = 'disabled',
    'Replacing a disabled credential must not reactivate environment fallback';
  assert exists(select 1 from public.integration_logs where connection_id = test_connection and code = 'managed_connection_disabled');
end;
$$;

rollback;
