// intake-groups: keeps each intake's Microsoft 365 group in step with the intake (INTAKE-GROUPS, 2026-11-20).
// Callers: an Admin / RTO Manager from the intake's Group tab (body { intakeId }: that group only), or the scheduled job with the
// service role (body {}: every group with work). The work list and the results go through intake_group_m365_work /
// intake_group_m365_record (service role only).
// Per group: create the Microsoft 365 group once (Unified, private, mail-enabled, address = mailNickname @ the student domain),
// add members who should be in it (students by their SLIT Microsoft 365 account; staff by their work account in the tenant,
// or invited as a guest without an invitation email), remove members who left or when the group is closed.
// Not configured (EF_MICROSOFT365_* missing) -> groups marked not_configured, nothing else happens.
// Microsoft app permissions (Application, admin consent) in addition to student-office365's: Group.ReadWrite.All,
// GroupMember.ReadWrite.All, User.Read.All, User.Invite.All.
// Diagnose (body { action: 'diagnose' }, Admin / RTO Manager or service role): read-only. A fresh client-credentials token, the
// tenant and client IDs in use (identifiers, not secrets), the token's tid / appid / roles, GET /organization, GET /groups?$top=1
// and the welcome sender's licences, each with Microsoft's exact status and error. Nothing in Microsoft 365 is created or changed.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { isServiceCaller } from '../_shared/service-role.ts';
import { loadRules, ruleText, type RuleValues } from '../_shared/business-rules.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const env = (n: string) => (Deno.env.get(n) ?? '').trim();
const domainRe = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

type Member = { kind: 'student' | 'staff'; id: string; active: boolean; status: string; msUserId: string | null; upn: string | null; studentMsUserId: string | null; email: string | null };
type Work = { intakeId: string; groupId: string | null; mailNickname: string; displayName: string; closed: boolean; members: Member[] };
type Result = { kind: string; id: string; status: string; msUserId?: string | null; error?: string | null };

const domain = () => env('EF_MICROSOFT365_STUDENT_DOMAIN').toLowerCase();
function configured() { return !!(env('EF_MICROSOFT365_CLIENT_ID') && env('EF_MICROSOFT365_CLIENT_SECRET') && env('EF_MICROSOFT365_TENANT_ID') && domainRe.test(domain())); }
async function appToken() {
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env('EF_MICROSOFT365_TENANT_ID'))}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env('EF_MICROSOFT365_CLIENT_ID'), client_secret: env('EF_MICROSOFT365_CLIENT_SECRET'), grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }), signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!r.ok) {
    let detail = ''; try { const b = await r.json(); detail = `${b?.error ?? ''} ${(b?.error_codes ?? []).map((c: number) => `AADSTS${c}`).join(' ')}`.trim(); } catch { /* no body */ }
    throw Error(`Skyline could not sign in to Microsoft 365. Check the app ID, secret and tenant ID. [token: HTTP ${r.status}${detail ? ` ${detail}` : ''}]`);
  }
  const t = await r.json(); if (typeof t.access_token !== 'string') throw Error('Skyline could not sign in to Microsoft 365.'); return t.access_token as string;
}
function graph(token: string, method: string, path: string, body?: unknown) {
  return fetch(GRAPH + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' });
}
function problem(status: number) {
  return status === 401 || status === 403 ? 'The Skyline Microsoft app is missing a group permission or admin consent.'
    : status === 429 || status >= 500 ? 'Microsoft 365 could not be reached. It will retry.' : `Microsoft 365 refused the request (${status}).`;
}
/** Microsoft's own status, error code and message (never a token or secret), shortened. */
async function graphError(r: Response, what: string) {
  let code = '', message = '';
  try { const b = await r.json(); code = String(b?.error?.code ?? ''); message = String(b?.error?.message ?? ''); } catch { /* no JSON body */ }
  return `${problem(r.status)} [${what}: HTTP ${r.status}${code ? ` ${code}` : ''}${message ? `: ${message.slice(0, 300)}` : ''}]`;
}

// Business Rules office365.intake_group_visibility (Private / Public) and office365.intake_group_description ({name} = the group name),
// used when a group is created.
function groupSettings(rules: RuleValues, name: string) {
  const visibility = ruleText(rules, 'office365.intake_group_visibility', 'Private').trim().toLowerCase() === 'public' ? 'Public' : 'Private';
  const description = ruleText(rules, 'office365.intake_group_description', 'SLIT class group: {name}').replaceAll('{name}', name).slice(0, 1024);
  return { visibility, description };
}

async function ensureGroup(token: string, w: Work, rules: RuleValues): Promise<{ id: string; address: string }> {
  const address = `${w.mailNickname}@${domain()}`;
  if (w.groupId) return { id: w.groupId, address };
  // An earlier run may have created it before recording: look it up by its address first.
  const f = await graph(token, 'GET', `/groups?$filter=${encodeURIComponent(`mailNickname eq '${w.mailNickname}'`)}&$select=id,mail`);
  if (!f.ok) throw Error(await graphError(f, 'GET /groups'));
  const found = (await f.json()).value?.[0];
  if (found?.id) return { id: found.id, address: found.mail ?? address };
  const c = await graph(token, 'POST', '/groups', { displayName: w.displayName, description: groupSettings(rules, w.displayName).description, mailEnabled: true, mailNickname: w.mailNickname, securityEnabled: false, groupTypes: ['Unified'], visibility: groupSettings(rules, w.displayName).visibility });
  if (!c.ok) throw Error(await graphError(c, 'POST /groups'));
  const g = await c.json();
  return { id: g.id, address: g.mail ?? address };
}

// The member's Microsoft user id: a student's SLIT account; a staff member's work account in the tenant, or a guest invitation.
async function userIdOf(token: string, m: Member): Promise<string | null> {
  if (m.msUserId) return m.msUserId;
  if (m.kind === 'student') return m.studentMsUserId;
  if (!m.email) return null;
  const u = await graph(token, 'GET', `/users/${encodeURIComponent(m.email)}?$select=id`);
  if (u.ok) return (await u.json()).id ?? null;
  if (u.status !== 404) throw Error(await graphError(u, 'GET /users'));
  await u.body?.cancel();
  const inv = await graph(token, 'POST', '/invitations', { invitedUserEmailAddress: m.email, inviteRedirectUrl: 'https://myapps.microsoft.com', sendInvitationMessage: false });
  if (!inv.ok) throw Error(await graphError(inv, 'POST /invitations'));
  return (await inv.json()).invitedUser?.id ?? null;
}

async function syncGroup(token: string, w: Work, rules: RuleValues) {
  const g = await ensureGroup(token, w, rules);
  const results: Result[] = [];
  for (const m of w.members) {
    try {
      if (m.active) {
        const id = await userIdOf(token, m);
        if (!id) { results.push({ kind: m.kind, id: m.id, status: 'no_account', error: m.kind === 'student' ? 'The student has no SLIT Microsoft 365 email yet.' : 'The staff member has no email.' }); continue; }
        const r = await graph(token, 'POST', `/groups/${g.id}/members/$ref`, { '@odata.id': `${GRAPH}/directoryObjects/${id}` });
        // 400 "already exists" counts as done.
        if (r.ok || r.status === 400) { await r.body?.cancel(); results.push({ kind: m.kind, id: m.id, status: 'member', msUserId: id }); }
        else results.push({ kind: m.kind, id: m.id, status: 'failed', error: await graphError(r, 'POST members') });
      } else {
        if (m.msUserId) {
          const r = await graph(token, 'DELETE', `/groups/${g.id}/members/${m.msUserId}/$ref`);
          if (!r.ok && r.status !== 404) { results.push({ kind: m.kind, id: m.id, status: 'member', error: await graphError(r, 'DELETE member') }); continue; }
          await r.body?.cancel();
        }
        results.push({ kind: m.kind, id: m.id, status: 'removed' });
      }
    } catch (e) {
      results.push({ kind: m.kind, id: m.id, status: m.active ? 'failed' : 'member', error: e instanceof Error ? e.message : 'Microsoft 365 error.' });
    }
  }
  return { groupId: g.id, address: g.address, results };
}

/** The claims of an access token, read without verifying it (it came straight from Microsoft). Only identifiers and roles leave. */
function claims(token: string): Record<string, unknown> {
  try { const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4))); } catch { return {}; }
}
const NEEDED = ['Group.ReadWrite.All', 'GroupMember.ReadWrite.All', 'User.Read.All', 'User.Invite.All', 'User.ReadWrite.All', 'Organization.Read.All', 'LicenseAssignment.ReadWrite.All', 'Domain.Read.All', 'Mail.Send'];
async function probe(token: string, path: string) {
  const r = await graph(token, 'GET', path);
  const text = await r.text();
  let error: unknown = null, sample: unknown = null;
  try { const b = JSON.parse(text); if (r.ok) sample = b; else error = b?.error ?? b; } catch { if (!r.ok) error = text.slice(0, 300); }
  return { call: `GET ${path}`, status: r.status, ok: r.ok, error, sample };
}
async function diagnose() {
  const tenantId = env('EF_MICROSOFT365_TENANT_ID'), clientId = env('EF_MICROSOFT365_CLIENT_ID'), sender = env('EF_MICROSOFT365_WELCOME_SENDER');
  const out: Record<string, unknown> = { tenantId: tenantId || null, clientId: clientId || null, clientSecretSet: !!env('EF_MICROSOFT365_CLIENT_SECRET'),
    studentDomain: domain() || null, welcomeSender: sender || null, tokenFlow: 'client_credentials, scope https://graph.microsoft.com/.default, fresh token (no cache)' };
  if (!configured()) return { ...out, problem: 'Not configured: EF_MICROSOFT365_CLIENT_ID / _CLIENT_SECRET / _TENANT_ID / _STUDENT_DOMAIN are not all set.' };
  let token = '';
  try { token = await appToken(); } catch (e) { return { ...out, token: { ok: false, error: e instanceof Error ? e.message : 'Token request failed.' } }; }
  const c = claims(token);
  const roles = Array.isArray(c.roles) ? (c.roles as string[]).slice().sort() : [];
  out.token = { ok: true, tid: c.tid ?? null, appid: c.appid ?? c.azp ?? null, roles, missing: NEEDED.filter((r) => !roles.includes(r)),
    tidMatchesTenantId: c.tid === tenantId, appidMatchesClientId: (c.appid ?? c.azp) === clientId, issuedAt: typeof c.iat === 'number' ? new Date(c.iat * 1000).toISOString() : null };
  const org = await probe(token, '/organization?$select=id,displayName');
  out.organization = { ...org, sample: org.ok ? ((org.sample as { value?: unknown[] })?.value?.[0] ?? null) : null };
  const groups = await probe(token, '/groups?$top=1&$select=id,displayName');
  out.groups = { ...groups, sample: groups.ok ? `${((groups.sample as { value?: unknown[] })?.value ?? []).length} group(s) readable` : null };
  if (sender) {
    const lic = await probe(token, `/users/${encodeURIComponent(sender)}/licenseDetails?$select=skuPartNumber`);
    const skus = lic.ok ? (((lic.sample as { value?: Array<{ skuPartNumber: string }> })?.value ?? []).map((x) => x.skuPartNumber)) : [];
    out.welcomeSenderLicence = { ...lic, sample: lic.ok ? skus : null, licensed: lic.ok ? skus.length > 0 : null,
      note: 'An Exchange Application Access Policy or RBAC for Applications can still block Mail.Send; Graph cannot read them (Exchange Online PowerShell: Get-ApplicationAccessPolicy, Test-ApplicationAccessPolicy).' };
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const url = env('SUPABASE_URL'), serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const auth = req.headers.get('Authorization');
  let body: { intakeId?: string; action?: string } = {};
  try { body = await req.json(); } catch { body = {}; }
  const intakeId = typeof body.intakeId === 'string' && uuid.test(body.intakeId) ? body.intakeId : null;

  const service = isServiceCaller(auth, serviceKey, url);
  if (!service) {
    // A signed-in Admin / RTO Manager, one group at a time (or the read-only diagnosis).
    if (!intakeId && body.action !== 'diagnose') return json({ error: 'Choose an intake.' }, 400);
    const caller = createClient(url, env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth ?? '' } }, auth: { persistSession: false } });
    const { data: ok, error } = await caller.rpc('intake_group_can_manage');
    if (error || ok !== true) return json({ error: 'Only Admins and RTO Managers can sync the group.' }, 403);
  }
  if (body.action === 'diagnose') return json({ diagnosis: await diagnose() });
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: work, error: workError } = await db.rpc('intake_group_m365_work', { p_intake: intakeId });
  if (workError) return json({ error: 'The group list could not be read.' }, 500);
  const groups = (work ?? []) as Work[];
  if (!groups.length) return json({ synced: 0 });

  if (!configured()) {
    for (const w of groups) await db.rpc('intake_group_m365_record', { p_data: { intakeId: w.intakeId, groupStatus: 'not_configured', error: 'Microsoft 365 is not set up yet (Supabase secrets EF_MICROSOFT365_*).' } });
    return json({ synced: 0, notConfigured: groups.length });
  }
  let token: string;
  try { token = await appToken(); } catch (e) {
    const msg = e instanceof Error ? e.message : 'Microsoft 365 sign-in failed.';
    for (const w of groups) await db.rpc('intake_group_m365_record', { p_data: { intakeId: w.intakeId, groupStatus: 'failed', error: msg } });
    return json({ error: msg }, 502);
  }
  const rules = await loadRules(db, ['office365.intake_group_visibility', 'office365.intake_group_description']);
  let synced = 0, failed = 0;
  for (const w of groups.slice(0, 20)) {
    try {
      const r = await syncGroup(token, w, rules);
      await db.rpc('intake_group_m365_record', { p_data: { intakeId: w.intakeId, groupId: r.groupId, address: r.address, groupStatus: 'ready', error: '', members: r.results } });
      synced++;
    } catch (e) {
      failed++;
      await db.rpc('intake_group_m365_record', { p_data: { intakeId: w.intakeId, groupStatus: 'failed', error: e instanceof Error ? e.message : 'Microsoft 365 error.' } });
    }
  }
  return json({ synced, failed, remaining: Math.max(0, groups.length - 20) });
});
