import { managedDefinition, type ManagedProvider } from './managed-catalog.ts';

export type ManagedFields = Record<string, string>;

export function validateManagedFields(provider: ManagedProvider, input: unknown): ManagedFields | null {
  const definition = managedDefinition(provider);
  if (!definition || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !definition.fields.some(field => field.key === key))) return null;
  const fields: ManagedFields = {};
  for (const field of definition.fields) {
    const value = raw[field.key];
    if (typeof value !== 'string' || value.length > (field.secret ? 3000 : 250) || /[\u0000-\u001f\u007f]/.test(value)) return null;
    if ((field.required && !value.trim()) || (field.kind === 'sandbox' && value !== 'sandbox')) return null;
    fields[field.key] = field.secret && field.key === 'password' ? value : value.trim();
  }
  if (provider === 'abr' && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(fields.guid)) return null;
  if (provider === 'cloudflare_turnstile' && (![fields.siteKey, fields.secretKey].every(value => /^[\w-]{15,200}$/.test(value)))) return null;
  return fields;
}

export function parseManagedFields(provider: ManagedProvider, value: unknown): ManagedFields | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.version === 1 ? validateManagedFields(provider, parsed.fields) : null;
  } catch {
    return null;
  }
}

type ReadResult = PromiseLike<{ data: unknown; error: unknown }>;
type Rpc = (name: string, args: Record<string, unknown>) => ReadResult;

/** Call only after the consuming workflow derives and authorizes its tenant on the server. */
export async function resolveManagedCredential(
  rpc: Rpc,
  tenant: string | null,
  provider: ManagedProvider,
): Promise<{ source: 'legacy' } | { source: 'unavailable' } | { source: 'central'; fields: ManagedFields }> {
  const { data, error } = await rpc('integration_managed_runtime', { p_tenant: tenant, p_provider: provider });
  if (error || !data || typeof data !== 'object') return { source: 'unavailable' };
  const result = data as { state?: unknown; credential?: unknown };
  if (result.state === 'legacy' || result.state === 'staged') return { source: 'legacy' };
  if (result.state !== 'active') return { source: 'unavailable' };
  const fields = parseManagedFields(provider, result.credential);
  return fields ? { source: 'central', fields } : { source: 'unavailable' };
}
