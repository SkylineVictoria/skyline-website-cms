import { searchAddresses } from '../validation/address.ts';
import { lookupAbr } from '../validation/abr.ts';
import { DATA_GOV_API, DATA_GOV_DATASET, NAGER_API } from '../../holiday-sync/core.ts';
import { searchQualifications } from '../../tga-course-import/tga.ts';
import type { ManagedProvider } from './managed-catalog.ts';
import type { ManagedFields } from './managed-runtime.ts';

type Probe = 'verified' | 'invalid' | 'unavailable' | 'format_only';

export async function probeManagedProvider(provider: ManagedProvider, fields: ManagedFields, request = fetch): Promise<Probe> {
  // Disallow redirects even when a provider moves its endpoint, so credentials stay at the intended origin.
  const send: typeof fetch = (input, init) => request(input, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  try {
    if (provider === 'cloudflare_turnstile') return 'format_only';
    if (provider === 'training_gov_au') {
      await searchQualifications('BSB50120', { username: fields.username, password: fields.password }, send);
      return 'verified';
    }
    if (provider === 'geoscape') {
      const result = await searchAddresses('Federation Square Melbourne', fields.apiKey, send);
      if (result.kind === 'ok') return 'verified';
      return ['provider_status_401', 'provider_status_403'].includes(result.reason) ? 'invalid' : 'unavailable';
    }
    if (provider === 'abr') {
      // Public Australian Taxation Office ABN. No SLIT business record is read or written.
      const result = await lookupAbr('51824753556', fields.guid, send);
      return result.ok ? 'verified' : 'unavailable';
    }
    if (provider === 'openai' || provider === 'postmark') {
      const response = provider === 'openai'
        ? await send('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${fields.apiKey}` } })
        : await send('https://api.postmarkapp.com/server', { headers: { Accept: 'application/json', 'X-Postmark-Server-Token': fields.token } });
      // Postmark's server metadata can contain API tokens. Discard the body.
      await response.body?.cancel();
      if (response.ok) return 'verified';
      return response.status === 401 || response.status === 403 ? 'invalid' : 'unavailable';
    }
    const response = await send(provider === 'data_gov_au'
      ? `${DATA_GOV_API}/package_show?id=${DATA_GOV_DATASET}`
      : `${NAGER_API}/PublicHolidays/${new Date().getUTCFullYear()}/AU`);
    if (!response.ok) {
      await response.body?.cancel();
      return 'unavailable';
    }
    const body = await response.json();
    return (provider === 'data_gov_au'
      ? body?.success === true && Array.isArray(body.result?.resources)
      : Array.isArray(body) && body.some(row => row?.countryCode === 'AU' && typeof row.date === 'string'))
      ? 'verified' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
