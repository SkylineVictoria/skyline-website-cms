// axcelerate-import (AXCELERATE-IMPORT, owner 2026-11-28): imports aXcelerate data into Skyline. One way only: aXcelerate is read
// through axcelerateClient (GET, read-only allow-list); nothing is ever sent back.
// verify_jwt = true. Before anything else: the caller's token must belong to a holder of the "aXcelerate import" permission
// (axcelerate_import_allowed, checked with the caller's token); a refused caller is recorded as a security event (admins emailed).
// Actions:
//   start    {entities: ['trainers'|'classes'|'breaks'], mode: 'page'|'everything'}  -> starts a run and works on it
//   continue {runId}                                                                  -> works on a running run (the page calls it until done)
//   retry    {runId}                                                                  -> a new run for the same entities as a failed / cancelled one
//   survey   {}                                                                       -> record counts in aXcelerate (read only)
// Cancel, conflicts, errors, the skipped list and the permission list are database functions the page calls directly.
// The tokens are read here from Vault with the service role and never returned, logged or put in an answer.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { axcelerateClient, axcelerateFields } from '../_shared/integrations/axcelerate.ts';
import { IMPORT_ENTITIES, runImport, type Counts, type Cursor, type ImportEntity } from '../_shared/integrations/axcelerate-import.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-tenant-domain', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Each call works for at most this long, then saves its place (the page calls "continue"). */
const BUDGET_MS = 100_000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const started = Date.now();
  try {
    const url = Deno.env.get('SUPABASE_URL') ?? '', anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '', service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const authorization = req.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return json({ error: 'Sign in required.' }, 401);
    const caller = createClient(url, anon, { global: { headers: { Authorization: authorization, ...(req.headers.get('x-tenant-domain') ? { 'x-tenant-domain': req.headers.get('x-tenant-domain')! } : {}) } }, auth: { persistSession: false } });
    const { data: who, error: whoError } = await caller.auth.getUser();
    if (whoError || !who.user) return json({ error: 'Sign in required.' }, 401);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
    const raw = await req.text();
    if (raw.length > 8000) return json({ error: 'Request too large.' }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || '{}'); } catch { return json({ error: 'Invalid JSON.' }, 400); }
    const action = String(body.action ?? '');

    // The connection of this organisation (or the one named, if it is an aXcelerate connection).
    let q = admin.from('integration_connections').select('id,tenant_id,status').eq('connector_id', 'axcelerate');
    q = typeof body.connectionId === 'string' && uuid.test(body.connectionId) ? q.eq('id', body.connectionId) : q.is('tenant_id', null);
    const { data: conn, error: connError } = await q.order('created_at').limit(1).maybeSingle();
    if (connError) return json({ error: 'The aXcelerate connection could not be read.' }, 500);

    // Permission first, on the server: hiding a button is not enough.
    const allowed = await caller.rpc('axcelerate_import_allowed');
    if (allowed.error || allowed.data !== true) {
      if (conn) await admin.rpc('axcelerate_security_event', { p_connection: conn.id, p_user: who.user.id, p_method: 'IMPORT', p_path: `axcelerate-import:${action}`.slice(0, 200), p_reason: 'no_permission', p_ip: ip });
      return json({ error: 'The aXcelerate import permission is required.' }, 403);
    }
    if (!conn) return json({ error: 'Add the aXcelerate connection first (External Integrations).' }, 409);
    if (conn.status === 'disabled') return json({ error: 'The aXcelerate connection is switched off.' }, 409);
    const cred = await admin.rpc('integration_credential_read', { p_connection: conn.id, p_kind: 'api_key' });
    const fields = axcelerateFields(cred.data as string | null);
    if (cred.error || !fields) return json({ error: 'Save the aXcelerate subdomain and tokens first (External Integrations › aXcelerate).' }, 409);
    const client = axcelerateClient(fields, {
      onCall: async (path, status) => { await admin.from('axcelerate_api_calls').insert({ connection_id: conn.id, user_id: who.user.id, method: 'GET', path, http_status: status }); },
    });

    if (action === 'survey') {
      const counted = async (path: string, params: Record<string, unknown>) => {
        try { return (await client.getAll(path, params, { maxRows: 50000 })).length; } catch { return null; }
      };
      const courses = await counted('/courses', { type: 'p' });
      const custom = await client.get('/customFields', {}).catch(() => null);
      const survey = {
        at: new Date().toISOString(),
        courses,
        workshops: await counted('/courses', { type: 'w' }),
        deliveryLocations: await counted('/course/deliveryLocations', {}),
        customFields: custom && custom.status < 300 && Array.isArray(custom.data)
          ? (custom.data as Record<string, unknown>[]).map((f) => ({ label: f.LABEL ?? f.VARIABLENAME, variable: f.VARIABLENAME, type: f.TYPE, linkTo: f.LINKTO })) : null,
      };
      await admin.rpc('axcelerate_audit', { p_connection: conn.id, p_actor: who.user.id, p_action: 'axcelerate_survey', p_detail: { courses: survey.courses }, p_ip: ip });
      return json({ ok: true, survey });
    }

    let runId: string | null = null;
    let entities: ImportEntity[] = [];
    let cursor: Cursor = {};
    let counts: Counts = {};
    if (action === 'start' || action === 'retry') {
      let retryOf: string | null = null;
      let mode = body.mode === 'everything' ? 'everything' : 'page';
      if (action === 'retry') {
        if (typeof body.runId !== 'string' || !uuid.test(body.runId)) return json({ error: 'Choose the import to retry.' }, 400);
        const { data: old } = await admin.from('axcelerate_import_runs').select('id,entities,mode,status,connection_id').eq('id', body.runId).maybeSingle();
        if (!old || old.connection_id !== conn.id || !['failed', 'cancelled', 'done'].includes(old.status)) return json({ error: 'This import cannot be retried.' }, 409);
        entities = (old.entities as string[]).filter((e): e is ImportEntity => (IMPORT_ENTITIES as readonly string[]).includes(e));
        mode = old.mode === 'everything' ? 'everything' : 'page';
        retryOf = old.id;
      } else {
        const asked = Array.isArray(body.entities) ? body.entities.map(String) : [];
        entities = mode === 'everything' ? [...IMPORT_ENTITIES] : asked.filter((e): e is ImportEntity => (IMPORT_ENTITIES as readonly string[]).includes(e));
      }
      if (!entities.length) return json({ error: 'Choose what to import.' }, 400);
      const r = await admin.rpc('axcelerate_run_start', { p_connection: conn.id, p_actor: who.user.id, p_mode: mode, p_entities: entities, p_retry_of: retryOf, p_ip: ip });
      if (r.error) return json({ error: r.error.message ?? 'The import could not start.' }, 409);
      runId = r.data as string;
    } else if (action === 'continue') {
      if (typeof body.runId !== 'string' || !uuid.test(body.runId)) return json({ error: 'Choose the import.' }, 400);
      const { data: run } = await admin.from('axcelerate_import_runs').select('id,entities,status,cursor,counts,connection_id').eq('id', body.runId).maybeSingle();
      if (!run || run.connection_id !== conn.id) return json({ error: 'Import not found.' }, 404);
      if (run.status !== 'running') return json({ ok: true, run });
      runId = run.id; entities = run.entities as ImportEntity[]; cursor = (run.cursor ?? {}) as Cursor; counts = (run.counts ?? {}) as Counts;
    } else {
      return json({ error: 'Unknown action.' }, 400);
    }

    const save = async (cur: Cursor, cnt: Counts) => {
      const r = await admin.rpc('axcelerate_run_save', { p_run: runId, p_cursor: cur, p_counts: cnt, p_status: null, p_error: null });
      return !r.error && (r.data as { status?: string } | null)?.status === 'running';
    };
    let status: 'running' | 'done' | 'failed' | 'cancelled' = 'running';
    let lastError: string | null = null;
    try {
      const result = await runImport({ client, rpc: (n, a) => admin.rpc(n, a), connection: conn.id, run: runId!, actor: who.user.id, entities, cursor, counts, deadline: started + BUDGET_MS, save });
      cursor = result.cursor; counts = result.counts;
      status = result.cancelled ? 'cancelled' : result.done ? 'done' : 'running';
    } catch (e) {
      status = 'failed';
      lastError = e instanceof Error ? e.message.slice(0, 500) : 'The import stopped.';
    }
    const final = await admin.rpc('axcelerate_run_save', { p_run: runId, p_cursor: cursor, p_counts: counts, p_status: status === 'running' ? null : status, p_error: lastError });
    return json({ ok: status !== 'failed', run: final.data, error: lastError ?? undefined });
  } catch {
    return json({ error: 'The aXcelerate import could not be completed. Try again.' }, 500);
  }
});
