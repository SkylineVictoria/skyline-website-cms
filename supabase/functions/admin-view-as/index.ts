// admin-view-as: lets an administrator open the Student, Agent or Staff workspace as the shared test account of that workspace,
// or (VIEW-AS-PERSON, 20261117181523) as a chosen real student, agent or staff member with that person's full access.
// verify_jwt = true. The caller must be an active CMS Admin (cms_is_admin with the caller's own token).
// - { kind } : the fixed test account of the workspace (created on first use, admin_view_as_seed re-checks the email).
// - { kind, action: 'people', query } : people the admin can sign in as (admin_view_as_people: active members of that workspace,
//   never a CMS user, at most 25).
// - { kind, userId } : that person; admin_view_as_person re-checks the workspace and that the person is not a CMS user, records
//   the switch with the person, and returns the person's sign-in email.
// It returns a one-time sign-in token hash; no email is sent.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-tenant-domain', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const kinds = ['student', 'agent', 'staff'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    if (body.action === 'people') {
      const query = String(body.query ?? '').slice(0, 80);
      const people = await admin.rpc('admin_view_as_people', { p_kind: kind, p_query: query, p_admin: who.user.id });
      if (people.error) return json({ error: people.error.code === '42501' ? 'Administrator access required.' : 'The list could not be loaded. Is the VIEW-AS-PERSON update applied?' }, people.error.code === '42501' ? 403 : 503);
      return json({ people: people.data ?? [] });
    }

    let email: string;
    if (body.userId !== undefined && body.userId !== null && body.userId !== '') {
      const target = String(body.userId);
      if (!uuid.test(target)) return json({ error: 'Choose a person.' }, 400);
      const person = await admin.rpc('admin_view_as_person', { p_kind: kind, p_target: target, p_admin: who.user.id });
      if (person.error || !person.data) {
        const code = person.error?.code;
        return json({ error: code === '42501' ? 'You cannot sign in as this person.' : code === 'P0002' ? 'This person has no active sign-in in that workspace.' : 'The person could not be checked.' }, code === '42501' ? 403 : code === 'P0002' ? 404 : 500);
      }
      email = (person.data as { email: string }).email;
    } else {
      const account = await admin.rpc('admin_view_as_account', { p_kind: kind });
      if (account.error || !account.data) return json({ error: 'Switch view is not set up in the database yet.' }, 503);
      const { name } = account.data as { email: string; name: string; authUserId: string | null };
      email = (account.data as { email: string }).email;
      let userId = (account.data as { authUserId: string | null }).authUserId;
      if (!userId) {
        const password = crypto.randomUUID() + crypto.randomUUID();
        const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name, test_account: true } });
        if (created.error || !created.data.user) return json({ error: 'The test account could not be created.' }, 500);
        userId = created.data.user.id;
      }
      const seeded = await admin.rpc('admin_view_as_seed', { p_kind: kind, p_auth_user: userId, p_admin: who.user.id });
      if (seeded.error) return json({ error: 'The test account could not be prepared.' }, 500);
    }
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const tokenHash = link.data?.properties?.hashed_token;
    if (link.error || !tokenHash) return json({ error: 'The sign-in could not be started.' }, 500);
    return json({ ok: true, kind, email, tokenHash });
  } catch {
    return json({ error: 'The request could not be completed. Retry.' }, 500);
  }
});
