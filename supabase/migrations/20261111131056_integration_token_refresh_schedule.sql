-- Keeps OAuth integration connections alive: daily call to the integrations-refresh Edge Function.
-- Same pattern as hr_holiday_sync_dispatch: service-role token and function URL from Vault, called through pg_net.
create or replace function public.integration_refresh_dispatch()
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public', 'vault', 'net', 'pg_temp'
as $function$
declare v_key text; v_url text;
begin
 if not pg_try_advisory_xact_lock(9343, 20261111) then return null; end if;
 select decrypted_secret into v_key from vault.decrypted_secrets where name = 'hr_retention_service_role_key' limit 1;
 select regexp_replace(decrypted_secret, '/staff-admin$', '/integrations-refresh') into v_url from vault.decrypted_secrets where name = 'hr_retention_function_url' limit 1;
 if nullif(v_key, '') is null or nullif(v_url, '') is null or v_url !~ '^https?://[^/]+/functions/v1/integrations-refresh$' then return null; end if;
 return net.http_post(url := v_url, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
  body := '{"trigger":"cron"}'::jsonb, timeout_milliseconds := 55000);
end $function$;

revoke all on function public.integration_refresh_dispatch() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'integration-token-refresh';
select cron.schedule('integration-token-refresh', '40 4 * * *', 'select public.integration_refresh_dispatch();');
