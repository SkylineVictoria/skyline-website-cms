-- Registry entries only. Tenant rows and Vault writes require explicit admin actions.
set local lock_timeout = '5s';

insert into public.integration_definitions (id, name, auth_type, availability, description)
values
 ('openai', 'OpenAI', 'api_key', 'available', 'AI generation, document extraction and assistant indexing.'),
 ('postmark', 'Postmark', 'api_key', 'available', 'Transactional email delivery.'),
 ('geoscape', 'Geoscape', 'api_key', 'available', 'Australian address verification and autocomplete.'),
 ('training_gov_au', 'Training.gov.au', 'username_password', 'available', 'Training register search and qualification import.'),
 ('cloudflare_turnstile', 'Cloudflare Turnstile', 'site_secret_key', 'available', 'CAPTCHA verification for public staff registration.'),
 ('abr', 'ABN Lookup', 'api_key', 'available', 'Australian Business Register verification.'),
 ('data_gov_au', 'data.gov.au', 'none', 'available', 'Public government reference data via CKAN.'),
 ('nager_date', 'Nager.Date', 'none', 'available', 'Public holiday reference data and holiday sync fallback.')
on conflict (id) do nothing;

alter table public.integration_connections
  add column if not exists managed_state text check (managed_state in ('staged', 'active', 'disabled'));

-- Keep the authorization gate in integrations-admin. This service-only RPC handles version
-- fencing, the Vault write and auditing in a single transaction.
create or replace function public.integration_managed_change(
  p_tenant uuid, p_provider text, p_action text, p_connection uuid, p_version timestamptz,
  p_secret text default null
) returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  c public.integration_connections%rowtype;
  log_code text;
begin
  if p_provider not in ('openai', 'postmark', 'geoscape', 'training_gov_au', 'cloudflare_turnstile', 'abr') then
    raise exception 'Unsupported managed provider';
  end if;
  if p_connection is null and p_action = 'save' then
    insert into public.integration_connections (tenant_id, connector_id)
      values (p_tenant, p_provider) returning * into c;
  else
    select * into c from public.integration_connections
      where id = p_connection and tenant_id is not distinct from p_tenant and connector_id = p_provider
      for update;
    if not found or c.updated_at is distinct from p_version then
      raise exception 'Connection changed';
    end if;
  end if;

  case p_action
    when 'save' then
      if c.managed_state = 'active' or coalesce(p_secret, '') = '' then
        raise exception 'Invalid credential or state';
      end if;
      perform public.integration_credential_write(c.id, 'api_key', p_secret);
      update public.integration_connections
        set status = 'not_connected', managed_state = case when c.managed_state = 'disabled' then 'disabled' else 'staged' end
        where id = c.id;
      log_code := 'managed_configuration_saved';
    when 'tested', 'test_failed' then
      if not c.credential_configured or c.managed_state is null then
        raise exception 'No saved credentials';
      end if;
      update public.integration_connections
        set status = case when c.managed_state = 'active' then c.status
                          when p_action = 'tested' then 'connected' else 'error' end,
            last_success_at = case when p_action = 'tested' then now() else last_success_at end,
            updated_at = now()
        where id = c.id;
      log_code := case when p_action = 'tested' then 'managed_test_succeeded' else 'managed_test_failed' end;
    when 'activate' then
      if p_provider <> 'training_gov_au' or c.managed_state is null or c.managed_state = 'active'
        or c.status <> 'connected' or not c.credential_configured then
        raise exception 'Connection is not ready for activation';
      end if;
      update public.integration_connections set managed_state = 'active', updated_at = now() where id = c.id;
      log_code := 'managed_connection_activated';
    when 'disable' then
      if c.managed_state is distinct from 'active' then raise exception 'Connection is not active'; end if;
      update public.integration_connections set managed_state = 'disabled', status = 'disabled', updated_at = now() where id = c.id;
      log_code := 'managed_connection_disabled';
    else
      raise exception 'Unsupported managed operation';
  end case;

  insert into public.integration_logs (connection_id, connector_id, severity, code)
    values (c.id, p_provider, case when p_action = 'test_failed' then 'error' else 'info' end, log_code);
  return c.id;
end;
$$;

-- A single snapshot binds the selected credential to its tenant and activation state.
create or replace function public.integration_managed_runtime(p_tenant uuid, p_provider text)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object(
      'state', coalesce(c.managed_state, 'legacy'),
      'credential', case when c.managed_state = 'active' and c.status = 'connected'
                        then public.integration_credential_read(c.id, 'api_key') end
    )
    from public.integration_connections c
    where c.connector_id = p_provider and c.tenant_id is not distinct from p_tenant
  ), '{"state":"legacy"}'::jsonb);
$$;

revoke all on function public.integration_managed_change(uuid,text,text,uuid,timestamptz,text),
  public.integration_managed_runtime(uuid,text) from public, anon, authenticated;
grant execute on function public.integration_managed_change(uuid,text,text,uuid,timestamptz,text),
  public.integration_managed_runtime(uuid,text) to service_role;
