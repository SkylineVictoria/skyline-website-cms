// usi-service: USI Verify, Locate and Create for the application form (USI-SERVICE, 2026-11-23, owner). USI Web Services v5 through
// MAS-ST (WS-Trust) with Skyline's M2M credential; the protocol is _shared/usi/soap.ts (a port of docs/usi/usi-test.js).
// Callers (JWT verified by the gateway, config.toml verify_jwt = true):
//   a signed-in person, body { action: 'verify', applicationId, usi } | { action: 'locate', applicationId }
//     | { action: 'create', applicationId, document: { type, values }, overrides?: { townCityOfBirth?, countryOfBirthCode? } } | { action: 'countries' }
//   who may run what, consent and the limits are decided by public.usi_access with the caller's own JWT; the student's details come
//   from the application, never from the request. Results go through public.usi_record (service role), which also writes the audit.
//   the service role (pg_net from usi_reverify_dispatch, or an operator): { action: 'reverify' } (automatic re-checks),
//     { action: 'status' } (configuration, no secrets), { action: 'selftest' } (the kit's 3PT cases; refused outside the test environment).
// Secrets: EF_USI_ENVIRONMENT (test | production), EF_USI_KEYSTORE_XML (the keystore XML, or base64 of it), EF_USI_CREDENTIAL_ID,
// EF_USI_CREDENTIAL_PASSWORD, EF_USI_ORG_CODE, EF_USI_STS_URL, EF_USI_SERVICE_URL. A test configuration can only reach the 3PT hosts and
// a production one only the production hosts (checkUsiConfig).
// Never logged or returned: the keystore, the password, the MAS-ST token or proof key, identity document numbers. The token is kept in
// memory only (per worker) until two minutes before it expires.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { isServiceCaller } from '../_shared/service-role.ts';
import { createBodyWithoutDocument, faultText, redactUsiXml, UsiClient, UsiError, type Country, type UsiConfig, type UsiCreate, type VerifyResult } from '../_shared/usi/soap.ts';
import { livesInAustralia, usiAustralianMobile, usiCountryCode, usiCreateMobile, usiDate, usiEmail, usiGender, usiInternationalAddress, usiNames,
  usiNationalAddress, usiTownOfBirth, usiVerifyInput, type Values } from '../_shared/usi/person.ts';
import { usiDocument, usiDocumentProblems, usiDocumentXml } from '../_shared/validation/usi-documents.ts';
import { normalizeUsi, validateUsi } from '../_shared/validation/identifiers.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-tenant-domain', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const env = (n: string) => (Deno.env.get(n) ?? '').trim();

/* ------------------------------------------------------------------ configuration and the shared connection */
function config(): UsiConfig {
  return {
    environment: env('EF_USI_ENVIRONMENT') === 'production' ? 'production' : env('EF_USI_ENVIRONMENT') === 'test' ? 'test' : ('' as 'test'),
    keystoreXml: Deno.env.get('EF_USI_KEYSTORE_XML') ?? '', credentialId: env('EF_USI_CREDENTIAL_ID'), password: Deno.env.get('EF_USI_CREDENTIAL_PASSWORD') ?? '',
    orgCode: env('EF_USI_ORG_CODE'), stsUrl: env('EF_USI_STS_URL'), usiUrl: env('EF_USI_SERVICE_URL'),
  };
}
let shared: UsiClient | null = null;
let tokenFetches = 0;
const counting: typeof fetch = (input, init) => { if (String(input).includes('softwareauthorisations')) tokenFetches++; return fetch(input, init); };
function usi(): UsiClient { shared ??= new UsiClient(config(), counting); return shared; }

let countryCache: { at: number; list: Country[] } | null = null;
async function countries(client: UsiClient): Promise<Country[]> {
  if (countryCache && Date.now() - countryCache.at < 24 * 3600_000) return countryCache.list;
  const list = await client.countries();
  countryCache = { at: Date.now(), list };
  return list;
}

/* ------------------------------------------------------------------ results */
type Outcome = 'valid' | 'mismatch' | 'not_found' | 'deactivated';
function verifyOutcome(r: VerifyResult): Outcome {
  if (r.usiStatus === 'Invalid') return 'not_found';
  if (r.usiStatus === 'Deactivated') return 'deactivated';
  return [r.firstName, r.familyName, r.singleName, r.dateOfBirth].includes('NoMatch') ? 'mismatch' : 'valid';
}
const LOCATE: Record<string, string> = { Exact: 'exact', MultipleExact: 'multiple', NoMatch: 'no_match', SingleNoContactMatch: 'contact_mismatch', MultipleNoContactMatch: 'contact_mismatch', NoIdenticalStrongPartial: 'partial' };
const errorCode = (e: unknown) => e instanceof UsiError ? (e.fault?.detailCode || e.fault?.subcode || e.stage) : 'internal';
const errorText = (e: unknown) => e instanceof UsiError ? (faultText(e.fault) || e.message) : 'The USI service could not be reached.';
const friendly = (e: unknown) => e instanceof UsiError && e.stage === 'config' ? 'The USI service is not set up yet. Ask SLIT to finish the USI connection.'
  : e instanceof UsiError && e.stage === 'fault' && e.fault?.detailMessage ? `The USI Registry refused the request: ${e.fault.detailMessage}`
  : 'The USI Registry could not be reached. Try again in a few minutes.';

async function record(service: SupabaseClient, callId: number, result: Record<string, unknown>) {
  const { error } = await service.rpc('usi_record', { p_call: callId, p_result: { environment: usi().environment, ...result } });
  if (error) console.error('usi_record failed', error.code);
}

/** usi_access as the caller; a refusal becomes the HTTP answer. */
async function access(caller: SupabaseClient, applicationId: string, op: 'verify' | 'locate' | 'create') {
  const { data, error } = await caller.rpc('usi_access', { p_application: applicationId, p_op: op });
  if (error) {
    const status = error.code === 'US429' ? 429 : error.code === 'US403' || error.code === '42501' ? 403 : 400;
    return { refused: json({ error: error.message, code: error.code === 'US403' ? 'consent_required' : error.code === 'US429' ? 'rate_limited' : 'refused' }, status) };
  }
  return { grant: data as { callId: number; role: string; values: Values; usi: string | null } };
}

async function runVerify(service: SupabaseClient, callId: number, usiNumber: string, values: Values) {
  const input = usiVerifyInput(values);
  if (input.problems.length) {
    await record(service, callId, { outcome: 'error', errorCode: 'missing_details', error: `Missing ${input.problems.join(' and ')}` });
    return { status: 422, body: { error: `Add ${input.problems.join(' and ')} to the application first.`, code: 'missing_details' } };
  }
  try {
    const r = await usi().verify({ usi: usiNumber, ...input.names, dateOfBirth: input.dateOfBirth });
    const outcome = verifyOutcome(r);
    const matches = { firstName: r.firstName, familyName: r.familyName, singleName: r.singleName, dateOfBirth: r.dateOfBirth };
    await record(service, callId, { outcome, usi: usiNumber, usiStatus: r.usiStatus, matches });
    return { status: 200, body: { outcome, usi: usiNumber, usiStatus: r.usiStatus, matches, environment: usi().environment } };
  } catch (e) {
    await record(service, callId, { outcome: 'error', errorCode: errorCode(e), error: errorText(e) });
    console.error('verify failed', errorCode(e));
    return { status: 502, body: { error: friendly(e), code: 'usi_unavailable' } };
  }
}

/* ------------------------------------------------------------------ operations for a signed-in person */
async function verifyAction(caller: SupabaseClient, service: SupabaseClient, body: Record<string, unknown>) {
  const applicationId = String(body.applicationId ?? '');
  if (!uuidRe.test(applicationId)) return json({ error: 'Choose an application.' }, 400);
  const usiNumber = normalizeUsi(String(body.usi ?? ''));
  if (!usiNumber) return json({ error: 'Enter the USI first.', code: 'missing_usi' }, 400);
  const problem = validateUsi(usiNumber);
  if (problem) return json({ error: problem, code: 'invalid_usi' }, 400);   // checked here, before any call or limit is used
  const { refused, grant } = await access(caller, applicationId, 'verify');
  if (refused) return refused;
  const r = await runVerify(service, grant!.callId, usiNumber, grant!.values);
  return json(r.body, r.status);
}

/** After a USI was found or created: verify it at once (as the same person, within their verify limit). */
async function followUpVerify(caller: SupabaseClient, service: SupabaseClient, applicationId: string, usiNumber: string) {
  const { grant } = await access(caller, applicationId, 'verify');
  if (!grant) return null;
  const r = await runVerify(service, grant.callId, usiNumber, grant.values);
  return r.status === 200 ? r.body : null;
}

async function locateAction(caller: SupabaseClient, service: SupabaseClient, body: Record<string, unknown>) {
  const applicationId = String(body.applicationId ?? '');
  if (!uuidRe.test(applicationId)) return json({ error: 'Choose an application.' }, 400);
  const { refused, grant } = await access(caller, applicationId, 'locate');
  if (refused) return refused;
  const v = grant!.values;
  const names = usiNames(v), dateOfBirth = usiDate(v.dob), town = usiTownOfBirth(v), email = usiEmail(v), mobile = usiAustralianMobile(v.mobile);
  const missing = [!names.familyName && !names.singleName && "the student's name", !dateOfBirth && 'the date of birth',
    !(names.firstName || names.middleName || town || email || mobile) && 'an email address or the town / city of birth'].filter(Boolean);
  if (missing.length) {
    await record(service, grant!.callId, { outcome: 'error', errorCode: 'missing_details', error: `Missing ${missing.join(', ')}` });
    return json({ error: `Add ${missing.join(', ')} to the application first.`, code: 'missing_details' }, 422);
  }
  try {
    const r = await usi().locate({ userReference: `skyline-${grant!.callId}`, gender: usiGender(v), ...names, dateOfBirth, townCityOfBirth: town || undefined, email: email || undefined, mobile: mobile ?? undefined });
    const outcome = LOCATE[r.result] ?? (r.errors.length ? 'error' : 'no_match');
    const found = outcome === 'exact' && r.usi && !validateUsi(r.usi) ? r.usi : null;
    await record(service, grant!.callId, { outcome, usi: found, locateResult: r.result, errorCode: r.errors[0]?.code, error: r.errors.map((e) => e.message).join(' ') || undefined });
    const verified = found ? await followUpVerify(caller, service, applicationId, found) : null;
    return json({ outcome, usi: found, message: r.message, errors: r.errors, verified, environment: usi().environment });
  } catch (e) {
    await record(service, grant!.callId, { outcome: 'error', errorCode: errorCode(e), error: errorText(e) });
    console.error('locate failed', errorCode(e));
    return json({ error: friendly(e), code: 'usi_unavailable' }, 502);
  }
}

async function createAction(caller: SupabaseClient, service: SupabaseClient, body: Record<string, unknown>) {
  const applicationId = String(body.applicationId ?? '');
  if (!uuidRe.test(applicationId)) return json({ error: 'Choose an application.' }, 400);
  const doc = (body.document ?? {}) as { type?: string; values?: Record<string, unknown> };
  const type = String(doc.type ?? '');
  // An identity document is required in every environment (owner): checked before any call or limit is used.
  const docProblems = usiDocumentProblems(type, doc.values ?? {});
  if (Object.keys(docProblems).length) return json({ error: 'Complete the identity document.', code: 'document_required', problems: docProblems }, 422);
  const documentXml = usiDocumentXml(type, doc.values ?? {});
  const { refused, grant } = await access(caller, applicationId, 'create');
  if (refused) return refused;
  const v = grant!.values, callId = grant!.callId, client = usi();
  const overrides = (body.overrides ?? {}) as Record<string, unknown>;
  try {
    const list = await countries(client);
    const names = usiNames(v);
    const inAustralia = livesInAustralia(v);
    const national = inAustralia ? usiNationalAddress(v) : null;
    const international = inAustralia ? '' : usiInternationalAddress(v);
    const countryOfBirthCode = String(overrides.countryOfBirthCode ?? '').trim() || usiCountryCode(v.birth_country, list);
    const countryOfResidenceCode = inAustralia ? '1101' : usiCountryCode(v.ov_country, list);
    const townCityOfBirth = String(overrides.townCityOfBirth ?? '').trim().slice(0, 50) || usiTownOfBirth(v);
    const email = usiEmail(v), mobile = usiCreateMobile(v.mobile);
    const contacts = [email, mobile, national || international].filter(Boolean).length;
    const missing = [
      !(names.firstName && names.familyName) && !names.singleName && "the student's name",
      !usiDate(v.dob) && 'the date of birth', !countryOfBirthCode && 'the country of birth', !townCityOfBirth && 'the town / city of birth',
      !countryOfResidenceCode && 'the country of residence', contacts < 2 && 'two contact details (email, mobile or address)',
    ].filter(Boolean) as string[];
    if (missing.length) {
      await record(service, callId, { outcome: 'error', errorCode: 'missing_details', documentType: type, error: `Missing ${missing.join(', ')}` });
      return json({ error: `Add ${missing.join(', ')} to the application first.`, code: 'missing_details', missing }, 422);
    }
    const requestId = `SK${client.environment === 'test' ? 'T' : 'P'}${callId}${crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase()}`.slice(0, 20);
    const input: UsiCreate = {
      requestId, applicationId: '1', userReference: `skyline-${callId}`, ...names, gender: usiGender(v), dateOfBirth: usiDate(v.dob), countryOfBirthCode, townCityOfBirth,
      countryOfResidenceCode, email: email || undefined, mobile: mobile ?? undefined, nationalAddress: national ?? undefined, internationalAddress: international || undefined, documentXml,
    };
    const r = await client.create(input);
    const created = r.result === 'Success' && r.usi && !validateUsi(r.usi) ? r.usi : null;
    await record(service, callId, { outcome: created ? 'created' : 'failure', usi: created, documentType: type, requestId,
      errorCode: r.errors[0]?.code, error: r.errors.map((e) => e.message).join(' ') || undefined });
    const verified = created ? await followUpVerify(caller, service, applicationId, created) : null;
    return json({ outcome: created ? 'created' : 'failure', usi: created, identityDocumentVerified: r.identityDocumentVerified, errors: r.errors, verified,
      documentType: usiDocument(type)?.label, environment: client.environment }, created ? 200 : 422);
  } catch (e) {
    await record(service, callId, { outcome: 'error', documentType: type, errorCode: errorCode(e), error: errorText(e) });
    console.error('create failed', errorCode(e));
    return json({ error: friendly(e), code: 'usi_unavailable' }, 502);
  }
}

/* ------------------------------------------------------------------ service-role operations */
async function reverify(service: SupabaseClient) {
  const { data, error } = await service.rpc('usi_reverify_claim', { p_limit: 10 });
  if (error) return json({ error: 'Could not claim re-checks.' }, 500);
  const work = (data ?? []) as { callId: number; applicationId: string; usi: string; values: Values }[];
  const tally: Record<string, number> = {};
  for (const w of work) {
    const r = await runVerify(service, w.callId, w.usi, w.values);
    const key = r.status === 200 ? String((r.body as { outcome: string }).outcome) : 'error';
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return json({ checked: work.length, outcomes: tally });
}

/** Each crypto step the connection needs, in this runtime (error names and messages only; no key material). */
async function primitives(cfg: UsiConfig) {
  const steps: { step: string; ok: boolean; detail?: string }[] = [];
  const step = async (name: string, fn: () => unknown) => {
    try { const r = await fn(); steps.push({ step: name, ok: true, detail: typeof r === 'string' ? r : undefined }); return r; }
    catch (e) { steps.push({ step: name, ok: false, detail: `${(e as Error)?.name ?? 'Error'}: ${String((e as Error)?.message ?? e).slice(0, 200)}` }); return null; }
  };
  const nodeCrypto = await import('node:crypto');
  const { Buffer } = await import('node:buffer');
  const { decryptPkcs12ShroudedKey } = await import('../_shared/usi/pkcs12.ts');
  const { keystoreText } = await import('../_shared/usi/soap.ts');
  const xml = await step('keystore secret decodes to XML', () => { const t = keystoreText(cfg.keystoreXml); if (!t.includes('<credential ')) throw Error('no <credential> in the keystore'); return `${t.length} characters`; }) as string | null;
  const text = xml ? keystoreText(cfg.keystoreXml) : '';
  const block = text.split('<credential ').slice(1).find((b) => b.includes(`id="${cfg.credentialId}"`)) ?? '';
  const enc = Buffer.from((block.match(/<protectedPrivateKey>([\s\S]*?)<\/protectedPrivateKey>/)?.[1] ?? '').replace(/\s/g, ''), 'base64');
  await step('sha1 / sha256 / hmac-sha1', () => { nodeCrypto.createHash('sha1').update('x').digest(); nodeCrypto.createHash('sha256').update('x').digest(); nodeCrypto.createHmac('sha1', Buffer.alloc(32, 1)).update('x').digest(); return 'ok'; });
  await step('des-ede3-cbc decipher', () => { const d = nodeCrypto.createDecipheriv('des-ede3-cbc', Buffer.alloc(24, 1), Buffer.alloc(8, 2)); d.setAutoPadding(false); Buffer.concat([d.update(Buffer.alloc(8)), d.final()]); return 'ok'; });
  const pkcs8 = await step('PKCS#12 3DES key decryption', () => decryptPkcs12ShroudedKey(enc, cfg.password)) as Uint8Array | null;
  const key = pkcs8 ? await step('createPrivateKey (plain PKCS#8 DER)', () => nodeCrypto.createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })) as import('node:crypto').KeyObject | null : null;
  if (key) {
    await step('createPublicKey + export spki', () => { nodeCrypto.createPublicKey(key).export({ type: 'spki', format: 'der' }); return 'ok'; });
    await step('sign rsa-sha256', () => `${nodeCrypto.sign('sha256', Buffer.from('<SignedInfo/>'), key).length} bytes`);
  }
  const p7 = Buffer.from((block.match(/<publicCertificate>([\s\S]*?)<\/publicCertificate>/)?.[1] ?? '').replace(/\s/g, ''), 'base64');
  await step('X509Certificate from the PKCS#7 bundle', () => {
    for (let i = 0; i < p7.length - 8; i++) {
      if (p7[i] === 0x30 && p7[i + 1] === 0x82 && p7[i + 4] === 0x30 && p7[i + 5] === 0x82) {
        try { const c = new nodeCrypto.X509Certificate(p7.subarray(i, i + (p7[i + 2] << 8) + p7[i + 3] + 4)); c.publicKey.export({ type: 'spki', format: 'der' }); return `parsed, valid to ${c.validTo}`; } catch { /* next offset */ }
      }
    }
    throw Error('no certificate could be parsed');
  });
  return steps;
}

/** The kit's 3PT cases end to end in this runtime: 6 Verify samples, GetCountries, Create (DVS mock), Locate, Verify of the new USI. */
async function selftest() {
  const cfg = config();
  if (cfg.environment !== 'test') return json({ error: 'The self-test runs only in the test (3PT) environment.' }, 403);
  const crypto = await primitives(cfg);
  if (crypto.some((s) => !s.ok)) return json({ environment: cfg.environment, runtime: { deno: Deno.version.deno }, crypto, passed: 0, total: 0, results: [], failures: [] });
  const failures: { case: string; op: string; status: number; request: string; response: string }[] = [];
  let currentCase = '', fetches = 0;
  const f: typeof fetch = (input, init) => { if (String(input).includes('softwareauthorisations')) fetches++; return fetch(input, init); };
  const client = new UsiClient(cfg, f, (op, x) => { if (x.status !== 200) failures.push({ case: currentCase, op, status: x.status, request: redactUsiXml(x.request), response: redactUsiXml(x.response) }); });
  const results: Record<string, unknown>[] = [];
  const run = async (name: string, expect: string, fn: () => Promise<unknown>, check: (r: any) => boolean) => {
    currentCase = name;
    try { const r = await fn(); results.push({ case: name, expect, pass: check(r), result: r }); return r; }
    catch (e) {
      const pass = check({ error: e instanceof UsiError ? e : null });
      results.push({ case: name, expect, pass, error: e instanceof UsiError ? errorText(e) : `${(e as Error)?.name}: ${String((e as Error)?.message ?? e).slice(0, 200)}`, code: errorCode(e) });
      return null;
    }
  };
  const samples = [
    { usi: 'BNGH7C75FN', firstName: 'Maryam', familyName: 'Fredrick', dateOfBirth: '1966-05-25', expect: 'valid' },
    { usi: 'BP6LKB3C7X', firstName: 'Csenge', familyName: 'Gumarsson', dateOfBirth: '1988-12-26', expect: 'valid' },
    { usi: 'RVJ5DM8LXJ', firstName: 'Kim', familyName: 'Juras', dateOfBirth: '1966-08-02', expect: 'valid' }, // kit: "Suspended"; the service returns Valid
    { usi: 'DG6K5YHPP3', firstName: 'Asfaha', familyName: 'Loflin', dateOfBirth: '1982-12-23', expect: 'deactivated' },
    { usi: 'QFJEGFSBC4', singleName: 'Testsinglename', dateOfBirth: '1985-01-01', expect: 'valid' },
    { usi: 'BNGH7C75FN', firstName: 'Maryam', familyName: 'Wrongname', dateOfBirth: '1966-05-25', expect: 'mismatch' },
    { usi: 'BNGH7C75FN', firstName: 'Maryam', familyName: 'Fredrick', dateOfBirth: '1966-05-26', expect: 'mismatch' },
  ];
  for (const s of samples) {
    const { expect, ...input } = s;
    await run(`verify ${s.usi} ${s.singleName ?? `${s.firstName} ${s.familyName}`} ${s.dateOfBirth}`, expect, () => client.verify(input).then((r) => ({ ...r, outcome: verifyOutcome(r) })), (r) => r?.outcome === expect);
  }
  const list = (await run('GetCountries', 'list with Australia 1101 and India 7103', () => client.countries(),
    (r) => Array.isArray(r) && r.some((c: Country) => c.code === '1101') && r.some((c: Country) => c.code === '7103'))) as Country[] | null;
  if (list) results[results.length - 1].result = { count: list.length };
  const letters = (n: number) => Array.from({ length: n }, () => 'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 23)]).join('');
  const person = (tag: string, dob: string) => {
    const family = 'Skyline' + letters(7), first = 'Test' + letters(4);
    return {
      requestId: `SKT0${Date.now().toString(36).toUpperCase()}${tag}`.slice(0, 20), applicationId: '1', userReference: 'skyline-selftest', firstName: first[0].toUpperCase() + first.slice(1), familyName: family,
      gender: 'X' as const, dateOfBirth: dob, countryOfBirthCode: usiCountryCode('India', list ?? []) || '7103', townCityOfBirth: 'Mumbai', countryOfResidenceCode: '1101',
      email: `${family.toLowerCase()}@example.com`, mobile: '0412345678', nationalAddress: { address1: '1 Collins St', suburb: 'MELBOURNE', state: 'VIC', postcode: '3000' },
    };
  };
  const ok = person('A', '1994-03-17');
  const created = await run('create with DVS mock document (non-Australian passport 111111)', 'Success, IdentityDocumentVerified True',
    () => client.create({ ...ok, documentXml: usiDocumentXml('visa', { PassportNumber: '111111' }) }), (r) => r?.result === 'Success' && !!r?.usi && r?.identityDocumentVerified === 'True') as { usi?: string } | null;
  await run('create with DVS mock "unavailable" document (non-Australian passport 000000)', 'Failure (DVS unavailable)',
    () => { const p = person('B', '1991-08-09'); return client.create({ ...p, documentXml: usiDocumentXml('visa', { PassportNumber: '000000' }) }); }, (r) => r?.result === 'Failure');
  await run('create without a document: refused by Skyline before any call', 'refused locally',
    async () => usiDocumentProblems('', {}), (r) => !!r?._type);
  await run('create without a document sent to the Registry (DVSCheckRequired true)', 'fault 1002 "DVS document must be supplied"',
    async () => { const p = person('C', '1990-02-02'); return client.call('CreateUSI', createBodyWithoutDocument(cfg.orgCode, p)); },
    (r) => r?.error?.fault?.detailCode === '1002');
  if (created?.usi) {
    await run('locate the created USI (exact)', `Exact ${created.usi}`,
      () => client.locate({ userReference: 'skyline-selftest', gender: 'X', firstName: ok.firstName, familyName: ok.familyName, dateOfBirth: ok.dateOfBirth, email: ok.email }),
      (r) => r?.result === 'Exact' && r?.usi === created.usi);
    await run('locate by town of birth instead of email', `Exact ${created.usi}`,
      () => client.locate({ userReference: 'skyline-selftest', gender: 'X', firstName: ok.firstName, familyName: ok.familyName, dateOfBirth: ok.dateOfBirth, townCityOfBirth: 'Mumbai' }),
      (r) => r?.result === 'Exact' && r?.usi === created.usi);
    await run('verify the created USI', 'valid', () => client.verify({ usi: created.usi!, firstName: ok.firstName, familyName: ok.familyName, dateOfBirth: ok.dateOfBirth }).then((r) => ({ ...r, outcome: verifyOutcome(r) })),
      (r) => r?.outcome === 'valid');
  }
  await run('locate someone who does not exist', 'NoMatch',
    () => client.locate({ userReference: 'skyline-selftest', gender: 'F', firstName: 'Nobody', familyName: 'Skylinenomatch' + letters(6), dateOfBirth: '1990-01-01', email: `nobody.${letters(6)}@example.com` }),
    (r) => r?.result === 'NoMatch');
  return json({ environment: cfg.environment, runtime: { deno: Deno.version.deno }, crypto, tokenRequests: fetches, passed: results.filter((r) => r.pass).length, total: results.length, results, failures });
}

/* ------------------------------------------------------------------ entry */
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Send a JSON body.' }, 400); }
  const action = String(body?.action ?? '');
  const url = env('SUPABASE_URL'), serviceKey = env('SUPABASE_SERVICE_ROLE_KEY'), authorization = req.headers.get('Authorization') ?? '';
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  if (isServiceCaller(authorization, serviceKey, url)) {
    if (action === 'status') {
      const cfg = config();
      let problem = '';
      try { new UsiClient(cfg); } catch (e) { problem = (e as Error).message; }
      return json({ configured: !problem, problem: problem || null, environment: cfg.environment || null, orgCode: cfg.orgCode || null, tokenCached: shared?.tokenCached ?? false, tokenFetches });
    }
    try {
      if (action === 'reverify') return await reverify(service);
      if (action === 'selftest') return await selftest();
    } catch (e) {
      console.error('service action failed', errorCode(e));
      return json({ error: friendly(e), code: errorCode(e) }, 500);
    }
    return json({ error: 'Unknown action' }, 400);
  }

  const caller = createClient(url, env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization, ...(req.headers.get('x-tenant-domain') ? { 'x-tenant-domain': req.headers.get('x-tenant-domain')! } : {}) } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: user, error: userError } = await caller.auth.getUser();
  if (userError || !user?.user) return json({ error: 'Sign in first.' }, 401);
  try {
    if (action === 'verify') return await verifyAction(caller, service, body);
    if (action === 'locate') return await locateAction(caller, service, body);
    if (action === 'create') return await createAction(caller, service, body);
    if (action === 'countries') return json({ countries: (await countries(usi())).filter((c) => c.current).map((c) => ({ code: c.code, name: c.name })) });
  } catch (e) {
    console.error('usi action failed', action, errorCode(e));
    return json({ error: friendly(e), code: errorCode(e) }, e instanceof UsiError && e.stage === 'config' ? 503 : 502);
  }
  return json({ error: 'Unknown action' }, 400);
});
