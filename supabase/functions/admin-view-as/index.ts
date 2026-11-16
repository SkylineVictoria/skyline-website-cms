// admin-view-as: lets an administrator open the Student, Agent or Staff workspace as the shared test account of that workspace.
// verify_jwt = true. The caller must be an active CMS Admin (cms_is_admin with the caller's own token). It never signs in as a real
// person: the only accounts it can touch are the three fixed test emails returned by admin_view_as_account, and admin_view_as_seed
// re-checks that in the database. It creates the test Auth user on first use (confirmed, random password nobody knows), creates
// its workspace records, records the switch, and returns a one-time sign-in token hash for that test account only.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-tenant-domain', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const kinds = ['student', 'agent', 'staff'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL') ?? '', anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '', service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!url || !anon || !service) return json({ error: 'Edge Function configuration is unavailable.' }, 503);
    const authorization = req.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return json({ error: 'Sign in required.' }, 401);
    const caller = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const { data: who, error: whoError } = await caller.auth.getUser();
    if (whoError || !who.user) return json({ error: 'Sign in required.' }, 401);
    const isAdmin = await caller.rpc('cms_is_admin');
    if (isAdmin.error || isAdmin.data !== true) return json({ error: 'Administrator access required.' }, 403);

    let body: Record<string, unknown>;
    try { body = JSON.parse((await req.text()).slice(0, 2000)); } catch { return json({ error: 'Invalid JSON.' }, 400); }
    const kind = String(body.kind ?? '');
    if (!kinds.includes(kind)) return json({ error: 'Choose Student, Agent or Staff.' }, 400);

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const account = await admin.rpc('admin_view_as_account', { p_kind: kind });
    if (account.error || !account.data) return json({ error: 'Switch view is not set up in the database yet.' }, 503);
    const { email, name } = account.data as { email: string; name: string; authUserId: string | null };
    let userId = (account.data as { authUserId: string | null }).authUserId;
    if (!userId) {
      const password = crypto.randomUUID() + crypto.randomUUID();
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name, test_account: true } });
      if (created.error || !created.data.user) return json({ error: 'The test account could not be created.' }, 500);
      userId = created.data.user.id;
    }
    const seeded = await admin.rpc('admin_view_as_seed', { p_kind: kind, p_auth_user: userId, p_admin: who.user.id });
    if (seeded.error) return json({ error: 'The test account could not be prepared.' }, 500);
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const tokenHash = link.data?.properties?.hashed_token;
    if (link.error || !tokenHash) return json({ error: 'The test sign-in could not be started.' }, 500);
    return json({ ok: true, kind, email, tokenHash });
  } catch {
    return json({ error: 'The request could not be completed. Retry.' }, 500);
  }
});
