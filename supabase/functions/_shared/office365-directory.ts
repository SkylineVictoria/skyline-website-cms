/*
 * Email Management > Account directory (owner 2026-11-21): the tenant's Microsoft 365 users (read live with User.ReadWrite.All), who each
 * one is in Skyline, and licence actions limited to the two licences Skyline assigns (Office 365 A1 for students / for faculty).
 *   directory       GET /users (paged with @odata.nextLink), guests left out; shared mailboxes (sign-in blocked, nobody in Skyline) under
 *                   the Shared filter only; search, type and status filters and 50 per page on this side; the top cards' counts.
 *   licence_remove  POST /users/{id}/assignLicense removeLicenses (the Skyline licences only; other licences untouched). Refused for the
 *                   signed-in administrator's own account, any account holding an Entra admin role, shared mailboxes and the login-email
 *                   sender. The admin-role check reads /directoryRoles (needs RoleManagement.Read.Directory): without it every removal is
 *                   refused, never guessed.
 *   licence_assign  the licence of the person's type (students only the student licence, staff only the faculty one: planFor, as Create
 *                   Email); seats checked first; usage location set when missing (Microsoft requires it to assign a licence).
 * Every assign / remove (also refused and failed ones) is written to email_account_audit; the Skyline account row keeps the licence
 * (o365_licence_record). No user is ever deleted here.
 */
import { appToken, fail, graphError, graphFor, LICENCE_NAMES, planFor, type Graph, type PersonKind, type Ports, type Reply } from "./office365-provision.ts";

interface GUser {
  id: string; displayName: string | null; userPrincipalName: string; mail: string | null; accountEnabled?: boolean; userType?: string | null; createdDateTime?: string | null;
  assignedLicenses?: Array<{ skuId: string }>; assignedPlans?: Array<{ service?: string; capabilityStatus?: string }>; usageLocation?: string | null;
}
const SELECT = "id,displayName,userPrincipalName,mail,accountEnabled,assignedLicenses,assignedPlans,createdDateTime,userType";
export type DirectoryType = "student" | "employee" | "trainer" | "agent" | "not_linked" | "shared";
interface Person { email: string; kind: "student" | "employee" | "trainer" | "agent"; id: string; name: string; source: "account" | "record" }
export const PAGE_SIZE = 50;
export const ADMIN_ROLE_PERMISSION = "RoleManagement.Read.Directory";
const read = (ports: Ports, n: string) => (ports.env(n) ?? "").trim();
const low = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

// The tenant's users, kept for a minute per instance (a page, a search and a filter reuse it); dropped after every licence action.
let cache: { at: number; users: GUser[] } | null = null;
export const resetDirectoryCache = () => { cache = null; };
async function allUsers(graph: Graph): Promise<GUser[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.users;
  const users: GUser[] = [];
  let path: string | null = `/users?$select=${SELECT}&$top=999`;
  for (let page = 0; path && page < 50; page++) {
    const r = await graph("GET", path);
    if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_unavailable")); }
    const body = await r.json() as { value?: GUser[]; "@odata.nextLink"?: string };
    users.push(...(body.value ?? []));
    path = body["@odata.nextLink"] ? body["@odata.nextLink"].replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "") : null;
  }
  cache = { at: Date.now(), users };
  return users;
}
async function skus(graph: Graph): Promise<Array<{ skuId: string; part: string; total: number; available: number }>> {
  const r = await graph("GET", "/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits");
  if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_unavailable")); }
  return (((await r.json()) as { value?: Array<{ skuId: string; skuPartNumber: string; prepaidUnits?: { enabled?: number }; consumedUnits?: number }> }).value ?? [])
    .map((s) => { const total = Number(s.prepaidUnits?.enabled ?? 0); return { skuId: s.skuId, part: s.skuPartNumber, total, available: Math.max(0, total - Number(s.consumedUnits ?? 0)) }; });
}
/** Ids of every member of an activated Entra directory role; null when the app may not read them (then no licence is removed). */
async function adminIds(graph: Graph): Promise<Set<string> | null> {
  const r = await graph("GET", "/directoryRoles?$select=id,displayName&$expand=members($select=id)");
  if (r.status === 401 || r.status === 403) { await r.body?.cancel(); return null; }
  if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_unavailable")); }
  const roles = ((await r.json()) as { value?: Array<{ members?: Array<{ id: string }> }> }).value ?? [];
  return new Set(roles.flatMap((x) => (x.members ?? []).map((m) => m.id)));
}
async function people(ports: Ports): Promise<Map<string, Person>> {
  const r = await ports.rpc("o365_directory_people", {});
  if (r.error) throw new Error("people_unavailable");
  const map = new Map<string, Person>();
  // An account row (the UPN Skyline created or linked) wins over an email on a record.
  for (const p of (r.data as Person[] | null) ?? []) { const have = map.get(p.email); if (!have || (have.source === "record" && p.source === "account")) map.set(p.email, p); }
  return map;
}
/** The Skyline licences: the student plan's and the staff plan's SKU (EF_MICROSOFT365_*_SKU or the Business Rules fallbacks). */
function skylineSkus(ports: Ports): { student: string; staff: string } {
  return { student: planFor("student", ports.env, ports.rules).sku, staff: planFor("employee", ports.env, ports.rules).sku };
}
const friendly = (part: string) => part === "STANDARDWOFFPACK_STUDENT" ? "A1 for students" : part === "STANDARDWOFFPACK_FACULTY" ? "A1 for faculty" : (LICENCE_NAMES[part] ?? part);

interface Context { users: GUser[]; people: Map<string, Person>; skuPart: Map<string, string>; mine: { student: string; staff: string }; admins: Set<string> | null; studentDomain: string; sender: string; caller: string }
async function context(ports: Ports, graph: Graph, caller: string, withAdmins: boolean): Promise<Context> {
  const [users, who, list, admins] = await Promise.all([allUsers(graph), people(ports), skus(graph), withAdmins ? adminIds(graph) : Promise.resolve(null)]);
  return { users, people: who, skuPart: new Map(list.map((s) => [s.skuId, s.part])), mine: skylineSkus(ports), admins,
    studentDomain: low(read(ports, "EF_MICROSOFT365_STUDENT_DOMAIN")), sender: low(read(ports, "EF_MICROSOFT365_WELCOME_SENDER")), caller: low(caller) };
}
function personOf(ctx: Context, u: GUser): Person | null { return ctx.people.get(low(u.userPrincipalName)) ?? (u.mail ? ctx.people.get(low(u.mail)) ?? null : null); }
/** A shared mailbox: sign-in blocked and nobody in Skyline (the login-email sender always). */
function isShared(ctx: Context, u: GUser, person: Person | null): boolean {
  return low(u.userPrincipalName) === ctx.sender || low(u.mail) === ctx.sender || (u.accountEnabled === false && !person);
}
const isSelf = (ctx: Context, u: GUser) => !!ctx.caller && (low(u.userPrincipalName) === ctx.caller || low(u.mail) === ctx.caller);

function row(ctx: Context, u: GUser) {
  const person = personOf(ctx, u);
  const shared = isShared(ctx, u, person);
  const type: DirectoryType = shared ? "shared" : person ? person.kind : low(u.userPrincipalName).endsWith("@" + ctx.studentDomain) && ctx.studentDomain ? "student" : "not_linked";
  const parts = (u.assignedLicenses ?? []).map((l) => ctx.skuPart.get(l.skuId) ?? l.skuId);
  const skyline = parts.filter((p) => p === ctx.mine.student || p === ctx.mine.staff);
  const exchange = (u.assignedPlans ?? []).some((p) => p.service === "exchange" && p.capabilityStatus === "Enabled");
  const admin = ctx.admins ? ctx.admins.has(u.id) : null;
  const self = isSelf(ctx, u);
  // Remove: a Skyline licence held, and none of the protections applies. Assign: no Skyline licence yet and a known person type.
  const removeBlocked = !skyline.length ? "No Skyline licence" : self ? "Your own account" : shared ? "Shared mailbox" : admin === null ? `Admin roles cannot be checked (${ADMIN_ROLE_PERMISSION})` : admin ? "Has an admin role" : null;
  const assignKind: PersonKind | null = skyline.length || shared ? null : type === "student" ? "student" : type === "employee" || type === "trainer" || type === "agent" ? type : null;
  const assignSku = assignKind ? (assignKind === "student" ? ctx.mine.student : ctx.mine.staff) : null;
  return { id: u.id, name: u.displayName ?? "", upn: low(u.userPrincipalName), mail: u.mail ? low(u.mail) : null, enabled: u.accountEnabled !== false, type,
    person: person ? { kind: person.kind, id: person.id, name: person.name } : null, licences: parts.map((p) => ({ sku: p, name: friendly(p), skyline: skyline.includes(p) })),
    exchange, admin, self, createdAt: u.createdDateTime ?? null,
    canRemove: !removeBlocked, removeBlocked, assign: assignSku ? { sku: assignSku, name: friendly(assignSku) } : null };
}

const TYPE_LABEL: Record<DirectoryType, string> = { student: "Student", employee: "Employee", trainer: "Trainer", agent: "Agent", not_linked: "Not linked", shared: "Shared" };
export async function directoryList(ports: Ports, caller: string, q: { search?: string; type?: string; status?: string; page?: number }): Promise<Reply> {
  try {
    const graph = graphFor(ports, await appToken(ports));
    const ctx = await context(ports, graph, caller, true);
    const members = ctx.users.filter((u) => (u.userType ?? "Member") !== "Guest").map((u) => row(ctx, u));
    const words = low(q.search).split(/\s+/).filter(Boolean);
    const type = String(q.type ?? ""), status = String(q.status ?? "");
    const filtered = members.filter((r) => (type ? r.type === type : r.type !== "shared") && (status === "enabled" ? r.enabled : status === "blocked" ? !r.enabled : true)
      && words.every((w) => [r.name, r.upn, r.mail ?? "", TYPE_LABEL[r.type], r.person?.name ?? ""].join(" ").toLowerCase().includes(w)))
      .sort((a, b) => (a.name || a.upn).localeCompare(b.name || b.upn));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const page = Math.min(Math.max(1, Math.floor(Number(q.page) || 1)), pages);
    const byType = Object.fromEntries((Object.keys(TYPE_LABEL) as DirectoryType[]).map((t) => [t, members.filter((r) => r.type === t).length]));
    return { status: 200, body: {
      rows: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: filtered.length, page, pageSize: PAGE_SIZE, pages,
      counts: { accounts: members.length, activeMailboxes: members.filter((r) => r.enabled && r.exchange).length, byType },
      adminRolesReadable: ctx.admins !== null, adminRolePermission: ADMIN_ROLE_PERMISSION } };
  } catch (e) { return fail(e); }
}

async function audit(ports: Ports, action: "licence_assigned" | "licence_removed", u: { upn: string; id: string }, sku: string | null, result: "ok" | "refused" | "failed", detail: Record<string, unknown>) {
  try { await ports.rpc("email_account_audit_add", { p_action: action, p_upn: u.upn, p_ms_user: u.id, p_sku: sku, p_licence_name: sku ? friendly(sku) : null, p_result: result, p_detail: detail }); }
  catch { /* the action's own answer still says what happened */ }
}
async function userById(graph: Graph, id: string): Promise<GUser | null> {
  const r = await graph("GET", `/users/${encodeURIComponent(id)}?$select=${SELECT},usageLocation`);
  if (r.status === 404) { await r.body?.cancel(); return null; }
  if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_unavailable")); }
  return await r.json() as GUser;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Remove the Skyline licence(s) from up to 50 accounts; every account answered and logged on its own. */
export async function licenceRemove(ports: Ports, caller: string, ids: unknown): Promise<Reply> {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))].filter((x) => UUID.test(x)).slice(0, 50) : [];
  if (!list.length) return { status: 400, body: { error: "Choose the accounts." } };
  try {
    const graph = graphFor(ports, await appToken(ports));
    const ctx = await context(ports, graph, caller, true);
    if (!ctx.admins) return { status: 409, body: { code: "admin_roles_unreadable",
      error: `No licence was removed: Skyline must check that an account has no admin role first, which needs the Microsoft Graph application permission ${ADMIN_ROLE_PERMISSION} with admin consent.` } };
    const partToId = new Map([...ctx.skuPart].map(([id, part]) => [part, id]));
    const results: Array<{ id: string; upn: string; ok: boolean; error?: string; removed?: string[] }> = [];
    for (const id of list) {
      const u = await userById(graph, id);
      if (!u) { results.push({ id, upn: "", ok: false, error: "No longer in Microsoft 365." }); continue; }
      const r = row(ctx, u); const who = { upn: r.upn, id: u.id };
      const remove = r.licences.filter((l) => l.skyline).map((l) => l.sku);
      if (!r.canRemove) { results.push({ id, upn: r.upn, ok: false, error: r.removeBlocked ?? "Not allowed" }); await audit(ports, "licence_removed", who, remove[0] ?? null, "refused", { reason: r.removeBlocked }); continue; }
      const res = await graph("POST", `/users/${encodeURIComponent(u.id)}/assignLicense`, { addLicenses: [], removeLicenses: remove.map((p) => partToId.get(p)).filter(Boolean) });
      await res.body?.cancel();
      if (!res.ok) { results.push({ id, upn: r.upn, ok: false, error: `Microsoft refused (${res.status}).` }); await audit(ports, "licence_removed", who, remove[0], "failed", { status: res.status }); continue; }
      try { await ports.rpc("o365_licence_record", { p_upn: r.upn, p_sku: null }); } catch { /* Microsoft is the source; the row follows on the next lookup */ }
      await audit(ports, "licence_removed", who, remove.join(","), "ok", { removed: remove });
      results.push({ id, upn: r.upn, ok: true, removed: remove.map(friendly) });
    }
    resetDirectoryCache();
    return { status: 200, body: { results, removed: results.filter((x) => x.ok).length, refused: results.filter((x) => !x.ok).length } };
  } catch (e) { return fail(e); }
}

/** Assign the licence of the person's type (student: the student licence; employee / trainer / agent: the faculty one). */
export async function licenceAssign(ports: Ports, caller: string, id: unknown): Promise<Reply> {
  if (!UUID.test(String(id ?? ""))) return { status: 400, body: { error: "Choose an account." } };
  try {
    const graph = graphFor(ports, await appToken(ports));
    const ctx = await context(ports, graph, caller, false);
    const u = await userById(graph, String(id));
    if (!u) return { status: 404, body: { error: "This account is no longer in Microsoft 365." } };
    const r = row(ctx, u); const who = { upn: r.upn, id: u.id };
    if ((u.userType ?? "Member") === "Guest" || r.type === "shared") { await audit(ports, "licence_assigned", who, null, "refused", { reason: "shared or guest" }); return { status: 409, body: { error: "Shared mailboxes and guests do not get a Skyline licence." } }; }
    if (!r.assign) { await audit(ports, "licence_assigned", who, null, "refused", { reason: r.licences.some((l) => l.skyline) ? "already licensed" : "type unknown" });
      return { status: 409, body: { error: r.licences.some((l) => l.skyline) ? "This account already has a Skyline licence." : "Link this account to a student, employee, trainer or agent in Skyline first: the licence follows the person's type." } }; }
    const seat = (await skus(graph)).find((s) => s.part === r.assign!.sku);
    if (!seat) return { status: 409, body: { error: `The tenant has no ${r.assign.name} licence.` } };
    if (seat.available <= 0) { await audit(ports, "licence_assigned", who, r.assign.sku, "refused", { reason: "no seats" }); return { status: 409, body: { error: `No ${r.assign.name} licences are free (${seat.total} of ${seat.total} in use).` } }; }
    if (!u.usageLocation) {
      const p = await graph("PATCH", `/users/${encodeURIComponent(u.id)}`, { usageLocation: read(ports, "EF_MICROSOFT365_USAGE_LOCATION") || "AU" });
      await p.body?.cancel(); if (!p.ok) throw new Error(graphError(p.status, "licence_assignment_failed"));
    }
    const res = await graph("POST", `/users/${encodeURIComponent(u.id)}/assignLicense`, { addLicenses: [{ skuId: seat.skuId, disabledPlans: [] }], removeLicenses: [] });
    await res.body?.cancel();
    if (!res.ok) { await audit(ports, "licence_assigned", who, r.assign.sku, "failed", { status: res.status }); return { status: 409, body: { error: `Microsoft refused the licence (${res.status}).` } }; }
    try { await ports.rpc("o365_licence_record", { p_upn: r.upn, p_sku: r.assign.sku }); } catch { /* the row follows on the next lookup */ }
    await audit(ports, "licence_assigned", who, r.assign.sku, "ok", {});
    resetDirectoryCache();
    return { status: 200, body: { ok: true, upn: r.upn, licence: r.assign.name } };
  } catch (e) { return fail(e); }
}
