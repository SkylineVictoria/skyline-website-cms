// aXcelerate API (AXCELERATE-CONNECTION, 2026-11-28). Every request carries the headers `apitoken` and `wstoken`
// (developer.axcelerate.com Guides > Authentication); the address is per college: https://{subdomain}.app.axcelerate.com/api
// (production) or https://{subdomain}.stg.axcelerate.com/api (staging). Rate limit 200 requests a minute, 429 + Retry-After.
// Runtime-neutral (no Deno globals) so scripts/test-axcelerate.ts can check it offline.

export type AxcelerateFields = { environment: 'production' | 'staging'; subdomain: string; apiToken: string; wsToken: string };
export type AxcelerateMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type AxcelerateRequest = { method: AxcelerateMethod; path: string; params: Record<string, string> };

const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** An API path: /contacts/search, /course/instance/detail, /contact/123. No query string, no "..", no host. */
const PATH = /^\/[A-Za-z0-9/_.-]{1,160}$/;

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

/** Checks a request from the browser; returns the error message, or the cleaned request. */
export function axcelerateRequest(input: Record<string, unknown>): AxcelerateRequest | { error: string } {
  const method = String(input.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return { error: 'Choose GET, POST, PUT or DELETE.' };
  const path = String(input.path ?? '').trim();
  if (!PATH.test(path) || path.includes('..') || path.includes('//')) return { error: 'Enter an aXcelerate API path such as /contacts/search (no address, no ?).' };
  const raw = input.params ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) return { error: 'Parameters must be name / value pairs.' };
  const params: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 60) return { error: 'Send at most 60 parameters.' };
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9_.[\]-]{1,80}$/.test(name)) return { error: `"${name}" is not a valid parameter name.` };
    if (value === null || value === undefined) continue;
    const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
    if (text.length > 4000) return { error: `The value of "${name}" is too long.` };
    params[name] = text;
  }
  return { method: method as AxcelerateMethod, path, params };
}

/** The fetch() arguments for a request: GET / DELETE send the parameters in the address, POST / PUT as a form. */
export function axcelerateFetchArgs(f: AxcelerateFields, r: AxcelerateRequest): { url: string; init: RequestInit } {
  const query = new URLSearchParams(r.params).toString();
  const withQuery = r.method === 'GET' || r.method === 'DELETE';
  const url = axcelerateBaseUrl(f) + r.path + (withQuery && query ? `?${query}` : '');
  const headers: Record<string, string> = { apitoken: f.apiToken, wstoken: f.wsToken, Accept: 'application/json' };
  if (!withQuery) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return { url, init: { method: r.method, headers, ...(withQuery ? {} : { body: query }), redirect: 'error' } };
}

/** The answer for the browser: JSON when it is JSON, else text; cut at maxChars so a huge list cannot break the page. */
export async function axcelerateAnswer(response: Response, maxChars = 1_500_000): Promise<{ status: number; data: unknown; truncated: boolean; retryAfter?: string }> {
  const text = await response.text();
  const truncated = text.length > maxChars;
  let data: unknown = truncated ? text.slice(0, maxChars) : text;
  if (!truncated) { try { data = JSON.parse(text); } catch { /* keep text */ } }
  const retryAfter = response.headers.get('Retry-After') ?? undefined;
  return { status: response.status, data, truncated, ...(retryAfter ? { retryAfter } : {}) };
}
