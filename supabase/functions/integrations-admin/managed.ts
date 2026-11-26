import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { managedDefinition, type ManagedProvider } from '../_shared/integrations/managed-catalog.ts';
import { parseManagedFields, validateManagedFields } from '../_shared/integrations/managed-runtime.ts';
import { probeManagedProvider } from '../_shared/integrations/managed-probe.ts';

const env = (name: string) => (Deno.env.get(name) ?? '').trim();
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function environmentFields(provider: ManagedProvider): Record<string, string> {
  switch (provider) {
    case 'openai': return { apiKey: env('OPENAI_API_KEY') };
    case 'postmark': return { token: env('EF_POSTMARK_SERVER_TOKEN') };
    case 'geoscape': return { apiKey: env('EF_ADDRESS_SEARCH_GEOSCAPE_KEY') };
    case 'training_gov_au': return {
      environment: 'sandbox',
      username: Deno.env.get('EF_TGA_SANDBOX_USERNAME') ?? '',
      password: Deno.env.get('EF_TGA_SANDBOX_PASSWORD') ?? '',
    };
    case 'cloudflare_turnstile': return { secretKey: env('EF_CAPTCHA_SECRET_KEY') };
    case 'abr': return { guid: env('EF_ABR_GUID') || env('ABR_GUID') };
    default: return {};
  }
}

export function usesEnvironment(provider: ManagedProvider): boolean {
  const fields = Object.values(environmentFields(provider));
  return fields.length > 0 && fields.every(value => Boolean(value.trim()));
}

export async function managedAction(
  caller: SupabaseClient, admin: SupabaseClient, tenant: string | null, action: string,
  body: Record<string, unknown>, json: (body: unknown, status?: number) => Response,
) {
  const provider = body.provider as ManagedProvider;
  const definition = managedDefinition(provider);
  if (!definition) return json({ error: 'Unknown provider.' }, 404);
  const { data: registered, error: registryError } = await caller
    .from('integration_definitions').select('id').eq('id', provider).maybeSingle();
  if (registryError || !registered) return json({ error: 'Provider registration is unavailable.' }, 404);

  let query = caller.from('integration_connections')
    .select('id, status, managed_state, credential_configured, updated_at, last_success_at').eq('connector_id', provider);
  query = tenant === null ? query.is('tenant_id', null) : query.eq('tenant_id', tenant);
  const { data: connection, error: lookupError } = await query.maybeSingle();
  if (lookupError) return json({ error: 'Configuration unavailable.' }, 503);
  if (body.connectionId != null && (typeof body.connectionId !== 'string' ||
    !uuid.test(body.connectionId) || body.connectionId !== connection?.id)) {
    return json({ error: 'Connection not found.' }, 404);
  }
  const publicApi = definition.fields.length === 0;
  const environmentConfigured = usesEnvironment(provider);
  const source = publicApi ? 'Public API — no credentials required'
    : connection?.managed_state === 'active' && connection.status === 'connected' && connection.credential_configured ? 'Centrally managed'
    : connection?.managed_state === 'active' || connection?.managed_state === 'disabled' ? 'Configuration unavailable'
    : environmentConfigured ? 'Existing environment configuration' : 'Not configured';

  if (action === 'managed_details') {
    let lastSync: string | null = null;
    if (publicApi && tenant === null) {
      const result = await caller.rpc('hr_admin_holiday_sync_status');
      const recent = [...(result.data?.runs ?? []), result.data?.lastOk];
      const name = provider === 'data_gov_au' ? 'data.gov.au' : 'nager';
      lastSync = recent.find(run => run?.status === 'ok' && Object.values(run.sources ?? {}).includes(name))?.finishedAt ?? null;
    }
    return json({
      definition, source, connection, lastSync,
      canTestEnvironment: environmentConfigured && provider !== 'cloudflare_turnstile',
      emailDeliveryEnabled: provider === 'postmark' ? env('EF_NOTIFICATION_EMAIL_ENABLED') === 'true' : undefined,
      sender: provider === 'postmark' ? env('EF_HR_EMAIL_FROM') : undefined,
      model: provider === 'openai' ? env('OPENAI_DOCUMENT_MODEL') : undefined,
    });
  }

  const change = async (operation: string, secret: string | null = null) => {
    return await admin.rpc('integration_managed_change', {
      p_tenant: tenant, p_provider: provider, p_action: operation, p_connection: connection?.id ?? null,
      p_version: operation === 'tested' || operation === 'test_failed' ? connection?.updated_at ?? null : body.version ?? null,
      p_secret: secret,
    });
  };

  if (action === 'managed_save') {
    if (publicApi) return json({ error: 'This public API already has a read-only configuration.' }, 400);
    const fields = validateManagedFields(provider, body.fields);
    if (!fields) return json({ error: 'Enter valid values for all required configuration fields.' }, 400);
    const saved = await change('save', JSON.stringify({ version: 1, fields }));
    if (saved.error) return json({ error: 'The configuration changed or could not be saved. Reload and try again.' }, 409);
    return json({ connectionId: saved.data });
  }

  if (action === 'managed_activate' || action === 'managed_disable') {
    if (!definition.runtime || !connection || body.connectionId !== connection.id || typeof body.version !== 'string') {
      return json({ error: 'This connection does not support that change.' }, 409);
    }
    const changed = await change(action === 'managed_activate' ? 'activate' : 'disable');
    if (changed.error) return json({ error: 'The connection changed or has not passed validation. Reload and try again.' }, 409);
    return json({ ok: true });
  }

  if (action === 'managed_test') {
    const testCandidate = connection?.credential_configured && connection.managed_state && body.connectionId === connection.id;
    const testEnvironment = !connection?.managed_state && environmentConfigured && provider !== 'cloudflare_turnstile';
    if (!publicApi && !testCandidate && !testEnvironment) {
      return json({ error: 'Save a candidate configuration before testing.' }, 409);
    }
    const stored = testCandidate ? await admin.rpc('integration_credential_read', { p_connection: connection.id, p_kind: 'api_key' }) : null;
    const fields = publicApi ? {} : testCandidate ? parseManagedFields(provider, stored?.data) : environmentFields(provider);
    if (!fields || stored?.error) return json({ error: 'Saved configuration is unavailable.' }, 503);
    const result = await probeManagedProvider(provider, fields);
    if (testCandidate && result !== 'format_only') {
      const saved = await change(result === 'verified' ? 'tested' : 'test_failed');
      if (saved.error) return json({ error: 'Configuration changed during the test. Reload and retry.' }, 409);
    }
    if (result === 'invalid') return json({ error: 'The provider rejected the saved credential.' }, 422);
    if (result === 'unavailable') return json({ error: 'The provider check did not succeed. Check the configuration and try again.' }, 502);
    return json({ result });
  }
  return json({ error: 'Unknown operation.' }, 400);
}
