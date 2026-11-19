/*
 * Office 365 accounts from Administration > Email Management > Create Email and the student page (owner 2026-11-20).
 *   student  -> <first.last>@<EF_MICROSOFT365_STUDENT_DOMAIN> (student.slit.edu.au) with STANDARDWOFFPACK_STUDENT
 *   employee / trainer (staff) -> <first.last>@slit.edu.au with STANDARDWOFFPACK_FACULTY (Office 365 A1 for faculty; owner's choice).
 *   A staff person is never offered the student domain or the student licence. OFFICESUBSCRIPTION_FACULTY (no mailbox) is never assigned.
 *   Agents get no mailbox.
 * Before creating, the person is looked up in Microsoft 365: their linked account, the work email on their record, their username
 * (first.last on our domains) and their name. A linked / work-email match means they already have a mailbox: nothing is created, the
 * screen offers to link it. A username / name match may be someone else: the administrator says "link" or "different person"; only for a
 * different person does the address get a number. Licence seats are checked BEFORE the user is created.
 * dryRun: every check, the address and the licence that would be used; no database write and no Microsoft POST / PATCH.
 * The temporary password is never stored or returned.
 */

export type PersonKind = "student" | "employee" | "trainer";
export const KINDS: readonly PersonKind[] = ["student", "employee", "trainer"];
export const GRAPH = "https://graph.microsoft.com/v1.0";

export interface Plan { kind: PersonKind; staff: boolean; domain: string; sku: string; licenceName: string }
const LICENCE_NAMES: Record<string, string> = { STANDARDWOFFPACK_STUDENT: "Office 365 A1 for students", STANDARDWOFFPACK_FACULTY: "Office 365 A1 for faculty" };

type Env = (name: string) => string | undefined;
const read = (env: Env, n: string) => (env(n) ?? "").trim();

/** The domain and licence for a person type. Throws when the staff domain would be the student domain. */
export function planFor(kind: PersonKind, env: Env): Plan {
  const studentDomain = read(env, "EF_MICROSOFT365_STUDENT_DOMAIN").toLowerCase();
  if (kind === "student") {
    const sku = read(env, "EF_MICROSOFT365_STUDENT_SKU") || "STANDARDWOFFPACK_STUDENT";
    return { kind, staff: false, domain: studentDomain, sku, licenceName: LICENCE_NAMES[sku] ?? sku };
  }
  const domain = (read(env, "EF_MICROSOFT365_STAFF_DOMAIN") || "slit.edu.au").toLowerCase();
  const sku = read(env, "EF_MICROSOFT365_STAFF_SKU") || "STANDARDWOFFPACK_FACULTY";
  if (domain === studentDomain || sku === (read(env, "EF_MICROSOFT365_STUDENT_SKU") || "STANDARDWOFFPACK_STUDENT")) throw new Error("staff_plan_invalid");
  return { kind, staff: true, domain, sku, licenceName: LICENCE_NAMES[sku] ?? sku };
}

export function slug(s: string) { return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
/** first.last (accents and symbols dropped), at most 56 characters. */
export function localPart(fullName: string) {
  const p = fullName.trim().split(/\s+/).map(slug).filter(Boolean);
  if (!p.length) return "";
  return (p.length === 1 ? p[0] : `${p[0]}.${p[p.length - 1]}`).slice(0, 56).replace(/\.+$/, "");
}
export function names(fullName: string) { const p = fullName.trim().split(/\s+/).filter(Boolean); return { given: p[0] ?? "", surname: p.length > 1 ? p[p.length - 1] : "" }; }
export function tempPassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%*?"]; const all = sets.join("");
  const r = crypto.getRandomValues(new Uint32Array(32)); const c = sets.map((s, i) => s[r[i] % s.length]);
  for (let i = 4; i < 16; i++) c.push(all[r[i] % all.length]);
  for (let i = c.length - 1; i > 0; i--) { const j = r[16 + i] % (i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  return c.join("");
}

export const MESSAGES: Record<string, string> = {
  microsoft_not_configured: "Microsoft 365 is not set up yet. Add the Microsoft settings in Supabase secrets.",
  microsoft_auth_failed: "Skyline could not sign in to Microsoft 365. Check the app ID, secret and tenant ID.",
  microsoft_permission_missing: "The Skyline Microsoft app is missing a permission or admin consent.",
  licence_not_found: "Your Microsoft 365 has no licence of this kind.",
  no_licences_available: "No licences of this kind are free. Add seats in the Microsoft 365 admin centre, then try again.",
  microsoft_rejected_user: "Microsoft 365 rejected the new account. Check the domain is verified in Microsoft 365.",
  licence_assignment_failed: "The account was created but the licence could not be assigned. Retry.",
  welcome_email_failed: "The account was created but the login email could not be sent. Check the sender mailbox, then retry.",
  microsoft_unavailable: "Microsoft 365 could not be reached. Retry shortly.",
  staff_plan_invalid: "The staff domain or licence is set to the student one. Check EF_MICROSOFT365_STAFF_DOMAIN / EF_MICROSOFT365_STAFF_SKU.",
};

export interface Existing { id: string; upn: string; mail: string | null; displayName: string; enabled: boolean; match: "linked" | "email" | "username" | "name" }
export interface Person { fullName: string; recordEmail: string | null; trainer?: boolean; account: null | { email: string; status: string; lastError: string | null; welcomeSentAt: string | null; msUserId?: string | null; linked?: boolean } }
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
export interface Ports { env: Env; fetch: typeof fetch; rpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult> }
export type Reply = { status: number; body: Record<string, unknown> };

const RPC = {
  student: { prepare: "student_o365_prepare", claim: "student_o365_claim", finish: "student_o365_finish", key: "p_student" },
  staff: { prepare: "staff_o365_prepare", claim: "staff_o365_claim", finish: "staff_o365_finish", key: "p_staff" },
} as const;
const rpcSet = (kind: PersonKind) => kind === "student" ? RPC.student : RPC.staff;
const emailRe = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const mask = (email: string) => { const [u, d] = email.split("@"); return d ? `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d}` : ""; };
function graphError(status: number, fallback: string) { return status === 401 || status === 403 ? "microsoft_permission_missing" : status >= 500 || status === 429 ? "microsoft_unavailable" : fallback; }

async function appToken(ports: Ports) {
  const env = ports.env;
  if (!read(env, "EF_MICROSOFT365_CLIENT_ID") || !read(env, "EF_MICROSOFT365_CLIENT_SECRET") || !read(env, "EF_MICROSOFT365_TENANT_ID")) throw new Error("microsoft_not_configured");
  const r = await ports.fetch(`https://login.microsoftonline.com/${encodeURIComponent(read(env, "EF_MICROSOFT365_TENANT_ID"))}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15000), redirect: "error",
    body: new URLSearchParams({ client_id: read(env, "EF_MICROSOFT365_CLIENT_ID"), client_secret: read(env, "EF_MICROSOFT365_CLIENT_SECRET"), grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }) });
  if (!r.ok) { await r.body?.cancel(); throw new Error("microsoft_auth_failed"); }
  const t = await r.json(); if (typeof t.access_token !== "string") throw new Error("microsoft_auth_failed");
  return t.access_token as string;
}
function graphFor(ports: Ports, token: string) {
  return (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => ports.fetch(GRAPH + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: "error" });
}
type Graph = ReturnType<typeof graphFor>;
const SELECT = "$select=id,userPrincipalName,mail,displayName,accountEnabled";
type GraphUser = { id: string; userPrincipalName: string; mail: string | null; displayName: string; accountEnabled?: boolean };
const toExisting = (u: GraphUser, match: Existing["match"]): Existing => ({ id: u.id, upn: String(u.userPrincipalName).toLowerCase(), mail: u.mail ? String(u.mail).toLowerCase() : null, displayName: u.displayName ?? "", enabled: u.accountEnabled !== false, match });

async function userBy(graph: Graph, upnOrId: string): Promise<GraphUser | null> {
  const r = await graph("GET", `/users/${encodeURIComponent(upnOrId)}?${SELECT}`);
  if (r.status === 404) { await r.body?.cancel(); return null; }
  if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_unavailable")); }
  return await r.json() as GraphUser;
}
async function usersWhere(graph: Graph, filter: string): Promise<GraphUser[]> {
  const r = await graph("GET", `/users?$filter=${encodeURIComponent(filter)}&$count=true&$top=10&${SELECT}`, undefined, { ConsistencyLevel: "eventual" });
  if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_unavailable")); }
  return ((await r.json()) as { value?: GraphUser[] }).value ?? [];
}
const quote = (s: string) => s.replace(/'/g, "''");

/** The person's possible Microsoft 365 accounts, strongest match first (linked, email, username, name), one row per account. */
export async function findExisting(graph: Graph, q: { linked?: string | null; emails: string[]; usernames: string[]; name: string }): Promise<Existing[]> {
  const found = new Map<string, Existing>();
  const add = (u: GraphUser | null, match: Existing["match"]) => { if (u && !found.has(u.id)) found.set(u.id, toExisting(u, match)); };
  if (q.linked) add(await userBy(graph, q.linked), "linked");
  for (const email of q.emails) {
    add(await userBy(graph, email), "email");
    for (const u of await usersWhere(graph, `proxyAddresses/any(x:x eq 'smtp:${quote(email)}')`)) add(u, "email");
  }
  for (const upn of q.usernames) add(await userBy(graph, upn), "username");
  if (q.name.trim()) for (const u of await usersWhere(graph, `displayName eq '${quote(q.name.trim())}'`)) add(u, "name");
  return [...found.values()];
}
export const certain = (e: Existing) => e.match === "linked" || e.match === "email";

async function addressTaken(graph: Graph, upn: string) {
  if (await userBy(graph, upn)) return true;
  return (await usersWhere(graph, `proxyAddresses/any(x:x eq 'smtp:${quote(upn)}')`)).length > 0;
}
async function seats(graph: Graph, sku: string) {
  const r = await graph("GET", "/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits");
  if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_unavailable")); }
  const s = (((await r.json()) as { value?: Array<{ skuId: string; skuPartNumber: string; prepaidUnits?: { enabled?: number }; consumedUnits?: number }> }).value ?? []).find((x) => x.skuPartNumber === sku);
  if (!s) return null;
  const total = Number(s.prepaidUnits?.enabled ?? 0);
  return { skuId: s.skuId, total, available: Math.max(0, total - Number(s.consumedUnits ?? 0)) };
}

async function prepare(ports: Ports, kind: PersonKind, personId: string): Promise<Person | Reply> {
  const set = rpcSet(kind);
  const r = await ports.rpc(set.prepare, { [set.key]: personId });
  if (r.error) return { status: r.error.code === "42501" ? 403 : r.error.code === "P0002" ? 404 : 500,
    body: { error: r.error.code === "42501" ? "Administrator access required." : r.error.code === "P0002" ? "Person not found." : "The person could not be loaded." } };
  const p = r.data as Person & { personalEmail?: string | null };
  const person: Person = { fullName: p.fullName ?? "", recordEmail: (p.recordEmail ?? p.personalEmail ?? null), trainer: p.trainer, account: p.account ?? null };
  if (kind === "trainer" && !person.trainer) return { status: 400, body: { error: "This staff member is not a trainer. Choose Employee." } };
  return person;
}
const isReply = (x: unknown): x is Reply => !!x && typeof x === "object" && "status" in x && "body" in x;

/** What would happen for this person: existing accounts, the address, the licence and its free seats. Read-only. */
export async function lookup(ports: Ports, kind: PersonKind, personId: string): Promise<Reply> {
  let plan: Plan; try { plan = planFor(kind, ports.env); } catch (e) { return fail(e); }
  const person = await prepare(ports, kind, personId); if (isReply(person)) return person;
  try {
    const graph = graphFor(ports, await appToken(ports));
    const q = queryFor(person, plan, ports.env);
    const existing = await findExisting(graph, q);
    const licence = await seats(graph, plan.sku);
    const free = existing.some(certain) ? null : await firstFreeAddress(graph, localPart(person.fullName), plan.domain, existing);
    return { status: 200, body: { person: { name: person.fullName, email: person.recordEmail }, plan: { domain: plan.domain, sku: plan.sku, licenceName: plan.licenceName },
      licence: licence ? { total: licence.total, available: licence.available } : null, account: person.account, existing, address: free,
      blocked: blockedReason(plan, licence, existing, person) } };
  } catch (e) { return fail(e); }
}

function queryFor(person: Person, plan: Plan, env: Env) {
  const domains = [plan.domain, read(env, "EF_MICROSOFT365_STUDENT_DOMAIN").toLowerCase(), (read(env, "EF_MICROSOFT365_STAFF_DOMAIN") || "slit.edu.au").toLowerCase()].filter(Boolean);
  const email = String(person.recordEmail ?? "").toLowerCase().trim();
  const base = localPart(person.fullName);
  return {
    linked: person.account?.msUserId || (person.account?.status === "active" ? person.account.email : null),
    emails: emailRe.test(email) && domains.includes(email.split("@")[1]) ? [email] : [],
    usernames: base ? [...new Set(domains)].map((d) => `${base}@${d}`) : [],
    name: person.fullName,
  };
}
async function firstFreeAddress(graph: Graph, base: string, domain: string, existing: Existing[]) {
  if (!base) return null;
  for (let n = 1; n <= 30; n++) {
    const upn = `${n === 1 ? base : base + n}@${domain}`;
    if (existing.some((e) => e.upn === upn || e.mail === upn)) continue;
    if (!(await addressTaken(graph, upn))) return upn;
  }
  return null;
}
function blockedReason(plan: Plan, licence: { total: number; available: number } | null, existing: Existing[], person: Person): string | null {
  const has = existing.find(certain);
  if (person.account?.status === "active") return `Already has ${person.account.email}.`;
  if (has) return `Already has ${has.upn}. Link it to this record instead of creating another.`;
  if (!licence) return `The tenant has no ${plan.licenceName} (${plan.sku}) licence.`;
  if (licence.available <= 0) return `No ${plan.licenceName} licences are free (${licence.total} of ${licence.total} in use). Add seats in the Microsoft 365 admin centre, then try again.`;
  return null;
}
function fail(e: unknown): Reply {
  const raw = e instanceof Error ? e.message : ""; const code = MESSAGES[raw] ? raw : "microsoft_unavailable";
  return { status: code === "microsoft_not_configured" ? 503 : code === "microsoft_unavailable" ? 502 : 409, body: { error: MESSAGES[code], code } };
}

/** Create (or retry a failed attempt), or with dryRun only say what would be created. */
export async function provision(ports: Ports, kind: PersonKind, personId: string, opts: { dryRun?: boolean; differentPerson?: boolean } = {}): Promise<Reply> {
  let plan: Plan; try { plan = planFor(kind, ports.env); } catch (e) { return fail(e); }
  const person = await prepare(ports, kind, personId); if (isReply(person)) return person;
  if (person.account?.status === "active") return { status: 409, body: { error: `Already has ${person.account.email}.`, code: "already_has", email: person.account.email } };
  const personal = String(person.recordEmail ?? "").trim();
  if (!emailRe.test(personal)) return { status: 400, body: { error: "Add the person's email on their record first; the login details are sent there." } };
  const sender = read(ports.env, "EF_MICROSOFT365_WELCOME_SENDER");
  if (!plan.domain || !emailRe.test(sender)) return fail(new Error("microsoft_not_configured"));
  const resuming = person.account?.status === "failed" || person.account?.status === "creating";
  let graph: Graph;
  try { graph = graphFor(ports, await appToken(ports)); } catch (e) { return fail(e); }
  try {
    // 1. Licence seats first: nothing is created when no seat is free (a retry whose user already has the licence is fine).
    const licence = await seats(graph, plan.sku);
    if (!licence) return { status: 409, body: { error: `The tenant has no ${plan.licenceName} (${plan.sku}) licence.`, code: "licence_not_found" } };
    // 2. An existing mailbox: never a second one.
    let existing: Existing[] = [];
    if (!resuming) {
      existing = await findExisting(graph, queryFor(person, plan, ports.env));
      const has = existing.find(certain);
      if (has) return { status: 409, body: { error: `Already has ${has.upn}. Link it to this record instead of creating another.`, code: "already_has", existing } };
      if (existing.length && !opts.differentPerson) return { status: 409, body: { code: "possible_match", existing,
        error: `Microsoft 365 already has ${existing.map((e) => `${e.displayName} (${e.upn})`).join(", ")}. If that is this person, link it. If it is a different person, confirm and the new address gets a number.` } };
    }
    if (licence.available <= 0 && !resuming) return { status: 409, body: { code: "no_licences_available",
      error: `No ${plan.licenceName} licences are free (${licence.total} of ${licence.total} in use). Add seats in the Microsoft 365 admin centre, then try again.` } };
    // 3. The address: the earlier attempt's, or the first free first.last[n]@domain.
    const upn0 = resuming ? person.account!.email : await firstFreeAddress(graph, localPart(person.fullName), plan.domain, existing);
    if (!upn0) return { status: 409, body: { error: localPart(person.fullName) ? "No free email address was found for this name." : "The name has no letters that can be used in an email address. Edit the name first." } };
    if (opts.dryRun) return { status: 200, body: { dryRun: true, email: upn0, domain: plan.domain, sku: plan.sku, licenceName: plan.licenceName,
      licence: { total: licence.total, available: licence.available }, welcomeTo: mask(personal), existing, resuming } };
    // 4. Reserve, create, licence, email, record.
    const set = rpcSet(kind);
    const c = await ports.rpc(set.claim, { [set.key]: personId, p_upn: upn0 });
    if (c.error) return { status: 409, body: { error: c.error.code === "23505" ? "Already has an Office 365 email." : c.error.code === "55P03" ? "Creation is already in progress. Wait a moment and reload." : "The address could not be reserved." } };
    const claim = c.data as { conflict?: boolean; upn: string; msUserId: string | null };
    if (claim.conflict) return { status: 409, body: { error: "That address was just taken. Try again." } };
    const upn = claim.upn; let msUser = claim.msUserId; let welcome = false;
    try {
      const password = tempPassword(), nm = names(person.fullName), usage = read(ports.env, "EF_MICROSOFT365_USAGE_LOCATION") || "AU";
      if (!msUser) {
        const r = await graph("POST", "/users", { accountEnabled: true, displayName: person.fullName.trim().slice(0, 256), ...(nm.given ? { givenName: nm.given.slice(0, 64) } : {}), ...(nm.surname ? { surname: nm.surname.slice(0, 64) } : {}),
          mailNickname: upn.split("@")[0], userPrincipalName: upn, usageLocation: usage, passwordProfile: { forceChangePasswordNextSignIn: true, password } });
        if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_rejected_user")); }
        msUser = (await r.json()).id;
      } else {
        const r = await graph("PATCH", `/users/${encodeURIComponent(msUser)}`, { accountEnabled: true, usageLocation: usage, passwordProfile: { forceChangePasswordNextSignIn: true, password } });
        await r.body?.cancel(); if (!r.ok) throw new Error(graphError(r.status, "microsoft_rejected_user"));
      }
      const has = await graph("GET", `/users/${encodeURIComponent(msUser!)}/licenseDetails?$select=skuId`);
      if (!has.ok) { await has.body?.cancel(); throw new Error(graphError(has.status, "microsoft_unavailable")); }
      if (!(((await has.json()).value ?? []) as Array<{ skuId: string }>).some((l) => l.skuId === licence.skuId)) {
        if (licence.available <= 0) throw new Error("no_licences_available");
        const r = await graph("POST", `/users/${encodeURIComponent(msUser!)}/assignLicense`, { addLicenses: [{ skuId: licence.skuId, disabledPlans: [] }], removeLicenses: [] });
        await r.body?.cancel(); if (!r.ok) throw new Error(graphError(r.status, "licence_assignment_failed"));
      }
      const what = plan.staff ? "SLIT staff email account" : "student email account";
      const content = `Hello ${nm.given || "there"},\n\nYour ${what} has been created.\n\nEmail: ${upn}\nTemporary password: ${password}\n\nSign in at https://www.office.com. You will be asked to choose a new password the first time you sign in.\n\nIf you did not expect this email, please contact us.`;
      const m = await graph("POST", `/users/${encodeURIComponent(sender)}/sendMail`, { message: { subject: `Your ${what}`, body: { contentType: "Text", content }, toRecipients: [{ emailAddress: { address: personal } }] }, saveToSentItems: false });
      await m.body?.cancel(); if (m.status !== 202) throw new Error("welcome_email_failed");
      welcome = true;
      const f = await ports.rpc(set.finish, { [set.key]: personId, p_ms_user: msUser, p_ok: true, p_error: null, p_sku: plan.sku, p_welcome: true });
      return { status: 200, body: { ok: true, email: upn, welcomeSent: true, ...(f.error ? { warning: "Created, but the result could not be recorded. Reload." } : {}) } };
    } catch (e) {
      const raw = e instanceof Error ? e.message : ""; const code = MESSAGES[raw] ? raw : "microsoft_unavailable";
      await ports.rpc(set.finish, { [set.key]: personId, p_ms_user: msUser ?? "", p_ok: false, p_error: code, p_sku: "", p_welcome: welcome });
      return { status: code === "microsoft_unavailable" ? 502 : 409, body: { error: MESSAGES[code], code, email: upn, canRetry: true } };
    }
  } catch (e) { return fail(e); }
}

/** Link an existing Microsoft 365 account to the person's record (no account is created or changed in Microsoft 365). */
export async function link(ports: Ports, kind: PersonKind, personId: string, msUserId: string): Promise<Reply> {
  let plan: Plan; try { plan = planFor(kind, ports.env); } catch (e) { return fail(e); }
  if (!/^[0-9a-f-]{36}$/i.test(msUserId)) return { status: 400, body: { error: "Choose the Microsoft 365 account to link." } };
  const person = await prepare(ports, kind, personId); if (isReply(person)) return person;
  try {
    const graph = graphFor(ports, await appToken(ports));
    const u = await userBy(graph, msUserId);
    if (!u) return { status: 404, body: { error: "That Microsoft 365 account no longer exists." } };
    const upn = String(u.userPrincipalName).toLowerCase();
    if (upn.split("@")[1] !== plan.domain) return { status: 400, body: { error: `A ${plan.staff ? "staff" : "student"} record links only to an @${plan.domain} account; ${upn} is not one.` } };
    const r = await ports.rpc("o365_link", { p_kind: kind === "student" ? "student" : "staff", p_person: personId, p_upn: upn, p_ms_user: u.id });
    if (r.error) return { status: 409, body: { error: r.error.code === "23505" ? `${upn} is already linked to another record.` : r.error.message ?? "The account could not be linked." } };
    return { status: 200, body: { ok: true, linked: true, email: upn } };
  } catch (e) { return fail(e); }
}
