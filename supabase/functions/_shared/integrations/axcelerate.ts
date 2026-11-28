// axcelerateClient: the ONLY way Skyline talks to aXcelerate (AXCELERATE-IMPORT, owner 2026-11-28).
// Data flows one way, aXcelerate -> Skyline. aXcelerate has no read-only tokens, so Skyline enforces read-only here:
//   * HTTP GET only. Any other method throws AxcelerateBlocked (the caller logs a security event).
//   * Only the paths on AXCELERATE_ALLOWED. Anything else (enrol, contact create / update, notes, messages, verifyUSI, invoice
//     approve / void / unarchive, payment URLs and forms, report runs, user login / logout, portalConfig, webhooks ...) is refused.
//   * No report API, no webhook registration.
// Every request carries the headers `apitoken` and `wstoken`; the address is per college: https://{subdomain}.app.axcelerate.com/api
// (production) or https://{subdomain}.stg.axcelerate.com/api (staging). Rate limit 200 requests a minute (429 + Retry-After).
// Runtime-neutral (no Deno globals) so scripts/test-document-provider.ts checks it offline. The tokens stay inside this module's
// caller (an Edge Function holding the service role); they are never returned, logged or put in an error message.

export type AxcelerateFields = { environment: 'production' | 'staging'; subdomain: string; apiToken: string; wsToken: string };
export type AxcelerateRequest = { method: 'GET'; path: string; params: Record<string, string> };
export type AxcelerateAnswer = { status: number; data: unknown; truncated: boolean; retryAfter?: string };

const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const ID = '[0-9]{1,12}';

/** The read endpoints Skyline may call (owner's Part 1 list). A trailing slash is accepted. Matched against the whole path. */
export const AXCELERATE_ALLOWED: readonly RegExp[] = [
  // Contacts
  '/contacts/search', `/contact/${ID}`, `/contact/enrolments/${ID}`, `/contact/notes/${ID}`, '/contact/portfolio', '/contact/portfolio/file',
  '/contact/enrolment/certificate',
  // Courses
  '/courses', '/course/detail', '/course/discounts', '/course/instances', '/course/instance/detail', '/course/instance/search',
  '/course/instance/attendance', '/course/calendar', '/course/deliveryLocations', '/venues', '/course/enrolments', '/enrolment/enrolmentInfo',
  // People and organisations
  `/trainer/${ID}`, '/trainer/availability', '/users', '/contactRoles', `/agent/${ID}`, '/organisations', `/organisation/${ID}`,
  `/organisation/${ID}/children`,
  // Finance (read only)
  '/accounting/invoice', `/accounting/invoice/${ID}`, `/accounting/creditnote/${ID}`, '/accounting/transaction', '/accounting/catalogueitem',
  // Other
  '/tasks', '/followUps', '/customFields', '/template/email', '/template/sms', '/portfolio/checklists', '/portfolio/types',
].map((p) => new RegExp(`^${p}/?$`));

export type BlockReason = 'method_not_allowed' | 'path_not_allowed' | 'bad_request';
/** A call Skyline refused before anything left the server. Its message never contains a token. */
export class AxcelerateBlocked extends Error {
  constructor(public reason: BlockReason, public method: string, public path: string, message: string) { super(message); }
}

/** The saved details (the Vault document), or null when they are missing or malformed. */
export function axcelerateFields(secret: string | null | undefined): AxcelerateFields | null {
  if (!secret) return null;
  try {
    const f = (JSON.parse(secret) as { fields?: Record<string, unknown> }).fields ?? {};
    const environment = f.environment === 'staging' ? 'staging' : f.environment === 'production' ? 'production' : null;
    const subdomain = typeof f.subdomain === 'string' ? f.subdomain : '';
    const apiToken = typeof f.apiToken === 'string' ? f.apiToken : '';
    const wsToken = typeof f.wsToken === 'string' ? f.wsToken : '';
    if (!environment || !SUBDOMAIN.test(subdomain) || !apiToken || !wsToken) return null;
    return { environment, subdomain, apiToken, wsToken };
  } catch { return null; }
}

export function axcelerateBaseUrl(f: Pick<AxcelerateFields, 'environment' | 'subdomain'>): string {
  return `https://${f.subdomain}.${f.environment === 'staging' ? 'stg' : 'app'}.axcelerate.com/api`;
}

/** True when the path is on the allow-list (no query string, no "..", no host). */
export function axcelerateAllowed(path: string): boolean {
  return typeof path === 'string' && !path.includes('..') && !path.includes('//') && !path.includes('?') && AXCELERATE_ALLOWED.some((re) => re.test(path));
}

/** Checks a request; throws AxcelerateBlocked for anything that is not an allowed GET. */
export function axcelerateRequest(input: Record<string, unknown>): AxcelerateRequest {
  const method = String(input.method ?? 'GET').toUpperCase();
  const path = String(input.path ?? '').trim();
  if (method !== 'GET') throw new AxcelerateBlocked('method_not_allowed', method, path, 'Skyline only reads from aXcelerate: only GET requests are allowed.');
  if (!axcelerateAllowed(path)) throw new AxcelerateBlocked('path_not_allowed', method, path, 'This aXcelerate path is not on Skyline’s read-only list.');
  const raw = input.params ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) throw new AxcelerateBlocked('bad_request', method, path, 'Parameters must be name / value pairs.');
  const params: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 60) throw new AxcelerateBlocked('bad_request', method, path, 'Send at most 60 parameters.');
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9_.[\]-]{1,80}$/.test(name)) throw new AxcelerateBlocked('bad_request', method, path, `"${name}" is not a valid parameter name.`);
    if (value === null || value === undefined || value === '') continue;
    const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
    if (text.length > 4000) throw new AxcelerateBlocked('bad_request', method, path, `The value of "${name}" is too long.`);
    params[name] = text;
  }
  return { method: 'GET', path, params };
}

/** The fetch() arguments for an allowed GET: parameters in the address, the two token headers, no body, no redirects. */
export function axcelerateFetchArgs(f: AxcelerateFields, r: AxcelerateRequest): { url: string; init: RequestInit } {
  if (r.method !== 'GET' || !axcelerateAllowed(r.path)) throw new AxcelerateBlocked(r.method !== 'GET' ? 'method_not_allowed' : 'path_not_allowed', r.method, r.path, 'Refused: not an allowed aXcelerate read.');
  const query = new URLSearchParams(r.params).toString();
  return {
    url: axcelerateBaseUrl(f) + r.path + (query ? `?${query}` : ''),
    init: { method: 'GET', headers: { apitoken: f.apiToken, wstoken: f.wsToken, Accept: 'application/json' }, redirect: 'error' },
  };
}

/** The answer: JSON when it is JSON, else text; cut at maxChars so a huge list cannot break the caller. */
export async function axcelerateAnswer(response: Response, maxChars = 1_500_000): Promise<AxcelerateAnswer> {
  const text = await response.text();
  const truncated = text.length > maxChars;
  let data: unknown = truncated ? text.slice(0, maxChars) : text;
  if (!truncated) { try { data = JSON.parse(text); } catch { /* keep text */ } }
  const retryAfter = response.headers.get('Retry-After') ?? undefined;
  return { status: response.status, data, truncated, ...(retryAfter ? { retryAfter } : {}) };
}

/**
 * The client. `get` is the only request method it has. `onCall` is told about every call (method, path, HTTP status) so the caller
 * can record it; it never receives the tokens. One retry after a 429, waiting what aXcelerate asks (at most 20 seconds).
 */
export function axcelerateClient(fields: AxcelerateFields, opts: { fetch?: typeof fetch; onCall?: (path: string, status: number | null) => Promise<void> | void; timeoutMs?: number } = {}) {
  const request = opts.fetch ?? fetch;
  async function get(path: string, params: Record<string, unknown> = {}): Promise<AxcelerateAnswer> {
    const r = axcelerateRequest({ method: 'GET', path, params });
    const { url, init } = axcelerateFetchArgs(fields, r);
    for (let attempt = 1; ; attempt++) {
      let answer: AxcelerateAnswer | null = null;
      try { answer = await axcelerateAnswer(await request(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 30000) })); }
      catch { answer = null; }
      await opts.onCall?.(r.path, answer?.status ?? null);
      if (!answer) throw new Error('aXcelerate could not be reached.');
      if (answer.status === 429 && attempt === 1) {
        await new Promise((res) => setTimeout(res, Math.min(20, Math.max(1, Number(answer!.retryAfter) || 5)) * 1000));
        continue;
      }
      return answer;
    }
  }
  /** Reads every page of a list (offset + displayLength, or offset + limit for /course/enrolments). Stops at maxRows. */
  async function getAll(path: string, params: Record<string, unknown> = {}, opt: { pageSize?: number; sizeParam?: 'displayLength' | 'limit'; maxRows?: number } = {}): Promise<Record<string, unknown>[]> {
    const size = opt.pageSize ?? 100, key = opt.sizeParam ?? 'displayLength', max = opt.maxRows ?? 20000;
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; rows.length < max; offset += size) {
      const a = await get(path, { ...params, offset, [key]: size });
      if (a.status < 200 || a.status >= 300) throw new Error(`aXcelerate answered HTTP ${a.status} for ${path}.`);
      const page = Array.isArray(a.data) ? a.data as Record<string, unknown>[] : [];
      rows.push(...page);
      if (page.length < size) break;
    }
    return rows.slice(0, max);
  }
  return { get, getAll };
}
