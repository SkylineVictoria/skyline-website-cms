/*
 * Office 365 accounts from Administration > Email Management > Create Email and the student page (owner 2026-11-20).
 *   student  -> <first.last>@<EF_MICROSOFT365_STUDENT_DOMAIN> (student.slit.edu.au) with STANDARDWOFFPACK_STUDENT
 *   employee / trainer (staff) -> <first.last>@slit.edu.au with STANDARDWOFFPACK_FACULTY (Office 365 A1 for faculty; owner's choice).
 *   agent (2026-11-20, owner's second brief) -> the staff plan too.
 *   A staff person is never offered the student domain or the student licence. OFFICESUBSCRIPTION_FACULTY (no mailbox) is never assigned.
 * Domains: only the tenant's verified domains, filtered by person type (student domain / slit.edu.au), never *.onmicrosoft.com.
 * Steps are recorded per person (o365_step: account, licence, groups, welcome with Microsoft's error code). A person whose Microsoft user
 * exists is never created again: "resend" issues a new temporary password, finishes a missing licence / groups step and emails the login.
 * Groups: EF_MICROSOFT365_GROUPS_STUDENT / EF_MICROSOFT365_GROUPS_STAFF (comma-separated group ids), empty until the owner maps them.
 * Before creating, the person is looked up in Microsoft 365: their linked account, the work email on their record, their username
 * (first.last on our domains) and their name. A linked / work-email match means they already have a mailbox: nothing is created, the
 * screen offers to link it. A username / name match may be someone else: the administrator says "link" or "different person"; only for a
 * different person does the address get a number. Licence seats are checked BEFORE the user is created.
 * dryRun: every check, the address and the licence that would be used; no database write and no Microsoft POST / PATCH.
 * The temporary password is never stored or returned.
 */

export type PersonKind = "student" | "employee" | "trainer" | "agent";
export const KINDS: readonly PersonKind[] = ["student", "employee", "trainer", "agent"];
/** The record table family of a person type (o365_step / o365_link). */
export const recordKind = (kind: PersonKind) => kind === "student" ? "student" : kind === "agent" ? "agent" : "staff";
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
export interface Steps { accountCreatedAt: string | null; licenceAssignedAt: string | null; groupsAddedAt: string | null; groupsError: string | null; welcomeSentAt: string | null; welcomeError: string | null }
export interface Person { fullName: string; recordEmail: string | null; trainer?: boolean; account: null | { email: string; status: string; lastError: string | null; welcomeSentAt: string | null; msUserId?: string | null; linked?: boolean; licenceSku?: string | null; steps?: Steps } }
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
export interface Ports { env: Env; fetch: typeof fetch; rpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult> }
export type Reply = { status: number; body: Record<string, unknown> };

const RPC = {
  student: { prepare: "student_o365_prepare", claim: "student_o365_claim", finish: "student_o365_finish", key: "p_student" },
  staff: { prepare: "staff_o365_prepare", claim: "staff_o365_claim", finish: "staff_o365_finish", key: "p_staff" },
  agent: { prepare: "agent_o365_prepare", claim: "agent_o365_claim", finish: "agent_o365_finish", key: "p_agent" },
} as const;
const rpcSet = (kind: PersonKind) => RPC[recordKind(kind)];
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

/** The domains a person type may use: the tenant's verified domains (never *.onmicrosoft.com) that are this type's domain. */
export async function allowedDomains(graph: Graph, plan: Plan): Promise<string[]> {
  let verified: string[] = [];
  const r = await graph("GET", "/domains?$select=id,isVerified");
  if (r.ok) verified = (((await r.json()) as { value?: Array<{ id: string; isVerified: boolean }> }).value ?? []).filter((d) => d.isVerified).map((d) => String(d.id).toLowerCase());
  else {
    await r.body?.cancel();
    const o = await graph("GET", "/organization?$select=verifiedDomains");
    if (!o.ok) { await o.body?.cancel(); throw new Error(graphError(o.status, "microsoft_unavailable")); }
    verified = ((((await o.json()) as { value?: Array<{ verifiedDomains?: Array<{ name: string }> }> }).value?.[0]?.verifiedDomains) ?? []).map((d) => String(d.name).toLowerCase());
  }
  return verified.filter((d) => !d.endsWith(".onmicrosoft.com") && d === plan.domain);
}
/** Microsoft's error code from a failed Graph reply (e.g. MailboxNotEnabledForRESTAPI), never its message text. */
async function graphCode(r: Response): Promise<string> {
  try { const b = await r.json() as { error?: { code?: string } }; const c = String(b?.error?.code ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 100); return `${r.status}:${c || "unknown"}`; }
  catch { return `${r.status}:unknown`; }
}
/** Group ids for a person type from EF_MICROSOFT365_GROUPS_STUDENT / _STAFF (none until the owner maps them). */
export function groupIds(plan: Plan, env: Env): string[] {
  return read(env, plan.staff ? "EF_MICROSOFT365_GROUPS_STAFF" : "EF_MICROSOFT365_GROUPS_STUDENT").split(",").map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
}

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
    const domains = await allowedDomains(graph, plan);
    const created = !!person.account?.msUserId;
    const free = created || existing.some(certain) || !domains.length ? null : await firstFreeAddress(graph, localPart(person.fullName), plan.domain, existing);
    return { status: 200, body: { person: { name: person.fullName, email: person.recordEmail }, plan: { domain: plan.domain, sku: plan.sku, licenceName: plan.licenceName },
      licence: licence ? { total: licence.total, available: licence.available } : null, account: person.account, existing, address: free, domains, groups: groupIds(plan, ports.env).length,
      blocked: !domains.length ? `The domain ${plan.domain} is not verified in Microsoft 365.` : blockedReason(plan, licence, existing, person) } };
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
  if (person.account?.msUserId) return `Already created ${person.account.email}. Use Resend login email.`;
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
export async function provision(ports: Ports, kind: PersonKind, personId: string, opts: { dryRun?: boolean; differentPerson?: boolean; domain?: string } = {}): Promise<Reply> {
  let plan: Plan; try { plan = planFor(kind, ports.env); } catch (e) { return fail(e); }
  const person = await prepare(ports, kind, personId); if (isReply(person)) return person;
  if (person.account?.status === "active") return { status: 409, body: { error: `Already has ${person.account.email}.`, code: "already_has", email: person.account.email } };
  // Never a second account: once the Microsoft user exists, only Resend login email (which finishes any missing step).
  if (person.account?.msUserId) return { status: 409, body: { error: `Already created ${person.account.email}. Use Resend login email.`, code: "already_created", email: person.account.email } };
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
    // The domain: only a verified domain of this person type (the screen's dropdown offers exactly these).
    const domains = await allowedDomains(graph, plan);
    const domain = (opts.domain ?? plan.domain).toLowerCase();
    if (!domains.includes(domain)) return { status: 400, body: { code: "domain_not_allowed", error: domains.length ? `A ${kind} account uses @${domains.join(" / @")} only.` : `The domain ${plan.domain} is not verified in Microsoft 365.` } };
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
    const upn0 = resuming ? person.account!.email : await firstFreeAddress(graph, localPart(person.fullName), domain, existing);
    if (!upn0) return { status: 409, body: { error: localPart(person.fullName) ? "No free email address was found for this name." : "The name has no letters that can be used in an email address. Edit the name first." } };
    if (opts.dryRun) return { status: 200, body: { dryRun: true, email: upn0, domain: plan.domain, sku: plan.sku, licenceName: plan.licenceName,
      licence: { total: licence.total, available: licence.available }, welcomeTo: mask(personal), existing, resuming } };
    // 4. Reserve, create, licence, email, record.
    const set = rpcSet(kind);
    const c = await ports.rpc(set.claim, { [set.key]: personId, p_upn: upn0 });
    if (c.error) return { status: 409, body: { error: c.error.code === "23505" ? "Already has an Office 365 email." : c.error.code === "55P03" ? "Creation is already in progress. Wait a moment and reload." : "The address could not be reserved." } };
    const claim = c.data as { conflict?: boolean; upn: string; msUserId: string | null };
    if (claim.conflict) return { status: 409, body: { error: "That address was just taken. Try again." } };
    const upn = claim.upn; let msUser = claim.msUserId; let welcome = false; let welcomeError = "";
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
      await ports.rpc("o365_step", { p_kind: recordKind(kind), p_person: personId, p_step: "account", p_ok: true, p_detail: null });
      const has = await graph("GET", `/users/${encodeURIComponent(msUser!)}/licenseDetails?$select=skuId`);
      if (!has.ok) { await has.body?.cancel(); throw new Error(graphError(has.status, "microsoft_unavailable")); }
      if (!(((await has.json()).value ?? []) as Array<{ skuId: string }>).some((l) => l.skuId === licence.skuId)) {
        if (licence.available <= 0) throw new Error("no_licences_available");
        const r = await graph("POST", `/users/${encodeURIComponent(msUser!)}/assignLicense`, { addLicenses: [{ skuId: licence.skuId, disabledPlans: [] }], removeLicenses: [] });
        await r.body?.cancel(); if (!r.ok) throw new Error(graphError(r.status, "licence_assignment_failed"));
      }
      await ports.rpc("o365_step", { p_kind: recordKind(kind), p_person: personId, p_step: "licence", p_ok: true, p_detail: plan.sku });
      await addGroups(ports, graph, kind, personId, plan, msUser!);
      const what = plan.staff ? "SLIT staff email account" : "student email account";
      const content = `Hello ${nm.given || "there"},\n\nYour ${what} has been created.\n\nEmail: ${upn}\nTemporary password: ${password}\n\nSign in at https://www.office.com. You will be asked to choose a new password the first time you sign in.\n\nIf you did not expect this email, please contact us.`;
      const m = await graph("POST", `/users/${encodeURIComponent(sender)}/sendMail`, { message: { subject: `Your ${what}`, body: { contentType: "Text", content }, toRecipients: [{ emailAddress: { address: personal } }] }, saveToSentItems: false });
      if (m.status !== 202) { welcomeError = await graphCode(m); throw new Error("welcome_email_failed"); }
      await m.body?.cancel();
      welcome = true;
      const f = await ports.rpc(set.finish, { [set.key]: personId, p_ms_user: msUser, p_ok: true, p_error: null, p_sku: plan.sku, p_welcome: true });
      await ports.rpc("o365_step", { p_kind: recordKind(kind), p_person: personId, p_step: "welcome", p_ok: true, p_detail: null });
      return { status: 200, body: { ok: true, email: upn, welcomeSent: true, ...(f.error ? { warning: "Created, but the result could not be recorded. Reload." } : {}) } };
    } catch (e) {
      const raw = e instanceof Error ? e.message : ""; const code = MESSAGES[raw] ? raw : "microsoft_unavailable";
      await ports.rpc(set.finish, { [set.key]: personId, p_ms_user: msUser ?? "", p_ok: false, p_error: code, p_sku: "", p_welcome: welcome });
      if (welcomeError) await ports.rpc("o365_step", { p_kind: recordKind(kind), p_person: personId, p_step: "welcome", p_ok: false, p_detail: welcomeError });
      return { status: code === "microsoft_unavailable" ? 502 : 409, body: { error: MESSAGES[code], code, email: upn, canRetry: true, ...(welcomeError ? { graphCode: welcomeError } : {}) } };
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

/** Adds the new user to the person type's groups (none until mapped); records the step. A failure never undoes the account. */
async function addGroups(ports: Ports, graph: Graph, kind: PersonKind, personId: string, plan: Plan, msUser: string) {
  const ids = groupIds(plan, ports.env);
  if (!ids.length) return;
  const failed: string[] = [];
  for (const id of ids) {
    const r = await graph("POST", `/groups/${encodeURIComponent(id)}/members/$ref`, { "@odata.id": `${GRAPH}/directoryObjects/${msUser}` });
    if (r.ok || r.status === 204) { await r.body?.cancel(); continue; }
    const code = await graphCode(r);
    if (/One or more added object references already exist/i.test(code) || r.status === 400 && code.includes("Request_BadRequest")) continue;
    failed.push(`${id.slice(0, 8)}:${code}`);
  }
  await ports.rpc("o365_step", { p_kind: recordKind(kind), p_person: personId, p_step: "groups", p_ok: !failed.length, p_detail: failed.length ? failed.join(",").slice(0, 160) : String(ids.length) });
}

/**
 * Resend login email: for a person whose Microsoft user exists. A new temporary password (change at next sign-in), any missing licence /
 * groups step finished, the login emailed. The password is never stored, logged or returned. dryRun: the checks only.
 */
export async function resend(ports: Ports, kind: PersonKind, personId: string, opts: { dryRun?: boolean } = {}): Promise<Reply> {
  let plan: Plan; try { plan = planFor(kind, ports.env); } catch (e) { return fail(e); }
  const person = await prepare(ports, kind, personId); if (isReply(person)) return person;
  const acct = person.account;
  if (!acct?.msUserId) return { status: 409, body: { error: "No Microsoft 365 account has been created for this person yet.", code: "not_created" } };
  if (acct.linked) return { status: 409, body: { error: "This account was linked, not created by Skyline: its password is managed in Microsoft 365.", code: "linked" } };
  const personal = String(person.recordEmail ?? "").trim();
  if (!emailRe.test(personal)) return { status: 400, body: { error: "Add the person's email on their record first; the login details are sent there." } };
  const sender = read(ports.env, "EF_MICROSOFT365_WELCOME_SENDER");
  if (!emailRe.test(sender)) return fail(new Error("microsoft_not_configured"));
  const rk = recordKind(kind);
  try {
    const graph = graphFor(ports, await appToken(ports));
    const u = await userBy(graph, acct.msUserId);
    if (!u) return { status: 404, body: { error: `${acct.email} no longer exists in Microsoft 365.`, code: "user_missing" } };
    const licence = await seats(graph, plan.sku);
    const has = await graph("GET", `/users/${encodeURIComponent(u.id)}/licenseDetails?$select=skuId`);
    if (!has.ok) { await has.body?.cancel(); throw new Error(graphError(has.status, "microsoft_unavailable")); }
    const licensed = !!licence && (((await has.json()).value ?? []) as Array<{ skuId: string }>).some((l) => l.skuId === licence.skuId);
    if (opts.dryRun) return { status: 200, body: { dryRun: true, email: String(u.userPrincipalName).toLowerCase(), welcomeTo: mask(personal), sender, licensed, licenceNeeded: !licensed,
      licence: licence ? { total: licence.total, available: licence.available } : null, groups: groupIds(plan, ports.env).length } };
    if (!licensed) {
      if (!licence) return { status: 409, body: { error: `The tenant has no ${plan.licenceName} (${plan.sku}) licence.`, code: "licence_not_found" } };
      if (licence.available <= 0) return { status: 409, body: { code: "no_licences_available", error: `No ${plan.licenceName} licences are free (${licence.total} of ${licence.total} in use).` } };
      const r = await graph("POST", `/users/${encodeURIComponent(u.id)}/assignLicense`, { addLicenses: [{ skuId: licence.skuId, disabledPlans: [] }], removeLicenses: [] });
      await r.body?.cancel(); if (!r.ok) throw new Error(graphError(r.status, "licence_assignment_failed"));
    }
    await ports.rpc("o365_step", { p_kind: rk, p_person: personId, p_step: "licence", p_ok: true, p_detail: plan.sku });
    if (!acct.steps?.groupsAddedAt) await addGroups(ports, graph, kind, personId, plan, u.id);
    const password = tempPassword(), nm = names(person.fullName);
    const p = await graph("PATCH", `/users/${encodeURIComponent(u.id)}`, { passwordProfile: { forceChangePasswordNextSignIn: true, password } });
    await p.body?.cancel(); if (!p.ok) throw new Error(graphError(p.status, "microsoft_rejected_user"));
    const upn = String(u.userPrincipalName).toLowerCase();
    const what = plan.staff ? "SLIT staff email account" : "student email account";
    const content = `Hello ${nm.given || "there"},\n\nHere are the login details for your ${what}.\n\nEmail: ${upn}\nTemporary password: ${password}\n\nSign in at https://www.office.com. You will be asked to choose a new password the first time you sign in.\n\nIf you did not expect this email, please contact us.`;
    const m = await graph("POST", `/users/${encodeURIComponent(sender)}/sendMail`, { message: { subject: `Your ${what}`, body: { contentType: "Text", content }, toRecipients: [{ emailAddress: { address: personal } }] }, saveToSentItems: false });
    if (m.status !== 202) {
      const code = await graphCode(m);
      await ports.rpc("o365_step", { p_kind: rk, p_person: personId, p_step: "welcome", p_ok: false, p_detail: code });
      return { status: 409, body: { error: MESSAGES.welcome_email_failed, code: "welcome_email_failed", graphCode: code, email: upn } };
    }
    await m.body?.cancel();
    await ports.rpc("o365_step", { p_kind: rk, p_person: personId, p_step: "welcome", p_ok: true, p_detail: null });
    return { status: 200, body: { ok: true, email: upn, welcomeSent: true, welcomeTo: mask(personal) } };
  } catch (e) { return fail(e); }
}

/** The tenant's groups, for the owner to map to person types (needs Group.Read.All). */
export async function listGroups(ports: Ports): Promise<Reply> {
  try {
    const graph = graphFor(ports, await appToken(ports));
    const out: Array<{ id: string; name: string; mail: string | null; kind: string; members?: number }> = [];
    let path: string | null = "/groups?$select=id,displayName,mail,groupTypes,securityEnabled,mailEnabled&$top=200";
    for (let page = 0; path && page < 10; page++) {
      const r = await graph("GET", path);
      if (!r.ok) { const code = await graphCode(r); return { status: r.status === 403 ? 403 : 502, body: { error: r.status === 403 ? "Listing groups needs the Group.Read.All application permission (admin consent)." : "The groups could not be read.", graphCode: code } }; }
      const b = await r.json() as { value?: Array<{ id: string; displayName: string; mail: string | null; groupTypes?: string[]; securityEnabled?: boolean; mailEnabled?: boolean }>; "@odata.nextLink"?: string };
      for (const g of b.value ?? []) out.push({ id: g.id, name: g.displayName, mail: g.mail, kind: (g.groupTypes ?? []).includes("Unified") ? "Microsoft 365" : g.securityEnabled && g.mailEnabled ? "Mail-enabled security" : g.securityEnabled ? "Security" : "Distribution" });
      path = b["@odata.nextLink"] ? b["@odata.nextLink"].replace(GRAPH, "") : null;
    }
    return { status: 200, body: { groups: out.sort((a, b) => a.name.localeCompare(b.name)) } };
  } catch (e) { return fail(e); }
}
