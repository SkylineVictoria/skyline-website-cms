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
 * Every assign / remove / sign-in block / allow (also refused and failed ones) is written to email_account_audit; success is only
 * reported once Graph shows the change (group-based licences explained, not hidden); the Skyline account row keeps the licence
 * (o365_licence_record). No user is ever deleted here.
 */
import { appToken, fail, graphError, graphFor, LICENCE_NAMES, planFor, type Graph, type PersonKind, type Ports, type Reply } from "./office365-provision.ts";

interface GUser {
  id: string; displayName: string | null; userPrincipalName: string; mail: string | null; accountEnabled?: boolean; userType?: string | null; createdDateTime?: string | null;
  assignedLicenses?: Array<{ skuId: string }>; assignedPlans?: Array<{ service?: string; capabilityStatus?: string }>; usageLocation?: string | null;
  /** How each licence came: assignedByGroup set = group-based licensing (it cannot be removed from the user directly). */
  licenseAssignmentStates?: Array<{ skuId: string; assignedByGroup?: string | null; state?: string; error?: string }>;
}
const SELECT = "id,displayName,userPrincipalName,mail,accountEnabled,assignedLicenses,assignedPlans,createdDateTime,userType";
export type DirectoryType = "student" | "employee" | "trainer" | "agent" | "not_linked" | "shared";
interface Person { email: string; kind: "student" | "employee" | "trainer" | "agent"; id: string; name: string; source: "account" | "record" }
export const PAGE_SIZE = 50;
export const ADMIN_ROLE_PERMISSION = "RoleManagement.Read.Directory";
const read = (ports: Ports, n: string) => (ports.env(n) ?? "").trim();
const low = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

// The tenant's users, kept for a minute per instance (a page, a search and a filter reuse it). The cache is per instance, so an action
// on one instance cannot clear another's: after an action the screen asks with `fresh` (2026-11-21: a removed licence stayed on the row).
let cache: { at: number; users: GUser[] } | null = null;
export const resetDirectoryCache = () => { cache = null; };
async function allUsers(graph: Graph, fresh = false): Promise<GUser[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.users;
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

interface Context { users: GUser[]; people: Map<string, Person>; skuPart: Map<string, string>; mine: { student: string; staff: string }; admins: Set<string> | null; studentDomain: string; sender: string; caller: string;
  /** Accounts whose sign-in Skyline blocked (latest sign-in action in the audit log): a blocked account, never a shared mailbox. */
  skylineBlocked: Set<string> }
async function blockedBySkyline(ports: Ports): Promise<Set<string>> {
  try { const r = await ports.rpc("email_account_skyline_blocked", {}); return new Set(((r.data as string[] | null) ?? []).map(low)); } catch { return new Set(); }
}
async function context(ports: Ports, graph: Graph, caller: string, withAdmins: boolean, fresh = false): Promise<Context> {
  const [users, who, list, admins, blocked] = await Promise.all([allUsers(graph, fresh), people(ports), skus(graph), withAdmins ? adminIds(graph) : Promise.resolve(null), blockedBySkyline(ports)]);
  return { users, people: who, skuPart: new Map(list.map((s) => [s.skuId, s.part])), mine: skylineSkus(ports), admins, skylineBlocked: blocked,
    studentDomain: low(read(ports, "EF_MICROSOFT365_STUDENT_DOMAIN")), sender: low(read(ports, "EF_MICROSOFT365_WELCOME_SENDER")), caller: low(caller) };
}
function personOf(ctx: Context, u: GUser): Person | null { return ctx.people.get(low(u.userPrincipalName)) ?? (u.mail ? ctx.people.get(low(u.mail)) ?? null : null); }
/**
 * A shared mailbox: the login-email sender always; otherwise sign-in blocked, nobody in Skyline and NOT on the student domain (a blocked
 * @student account is a former student, listed as a student with sign-in blocked). Exact detection would need MailboxSettings.Read
 * (mailboxSettings.userPurpose) per account; this rule errs on the safe side (protected from licence removal).
 */
function isShared(ctx: Context, u: GUser, person: Person | null): boolean {
  if (low(u.userPrincipalName) === ctx.sender || low(u.mail) === ctx.sender) return true;
  const studentDomain = !!ctx.studentDomain && low(u.userPrincipalName).endsWith("@" + ctx.studentDomain);
  return u.accountEnabled === false && !person && !studentDomain && !ctx.skylineBlocked.has(low(u.userPrincipalName));
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
  // Block / allow sign-in (2026-11-21): the same protections as licence removal.
  const signinBlocked = self ? "Your own account" : shared ? "Shared mailbox" : admin === null ? `Admin roles cannot be checked (${ADMIN_ROLE_PERMISSION})` : admin ? "Has an admin role" : null;
  const enabled = u.accountEnabled !== false;
  return { id: u.id, name: u.displayName ?? "", upn: low(u.userPrincipalName), mail: u.mail ? low(u.mail) : null, enabled, type,
    person: person ? { kind: person.kind, id: person.id, name: person.name } : null, licences: parts.map((p) => ({ sku: p, name: friendly(p), skyline: skyline.includes(p) })),
    exchange, admin, self, createdAt: u.createdDateTime ?? null,
    canRemove: !removeBlocked, removeBlocked, assign: assignSku ? { sku: assignSku, name: friendly(assignSku) } : null,
    canBlock: enabled && !signinBlocked, canAllow: !enabled && !signinBlocked, signinBlocked };
}

const TYPE_LABEL: Record<DirectoryType, string> = { student: "Student", employee: "Employee", trainer: "Trainer", agent: "Agent", not_linked: "Not linked", shared: "Shared" };
export async function directoryList(ports: Ports, caller: string, q: { search?: string; type?: string; status?: string; page?: number; fresh?: boolean }): Promise<Reply> {
  try {
    const graph = graphFor(ports, await appToken(ports));
    const ctx = await context(ports, graph, caller, true, q.fresh === true);
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

type AuditAction = "licence_assigned" | "licence_removed" | "signin_blocked" | "signin_allowed";
async function audit(ports: Ports, action: AuditAction, u: { upn: string; id: string }, sku: string | null, result: "ok" | "refused" | "failed", detail: Record<string, unknown>) {
  try { await ports.rpc("email_account_audit_add", { p_action: action, p_upn: u.upn, p_ms_user: u.id, p_sku: sku, p_licence_name: sku ? friendly(sku) : null, p_result: result, p_detail: detail }); }
  catch { /* the action's own answer still says what happened */ }
}
async function userById(graph: Graph, id: string): Promise<GUser | null> {
  const r = await graph("GET", `/users/${encodeURIComponent(id)}?$select=${SELECT},usageLocation,licenseAssignmentStates`);
  if (r.status === 404) { await r.body?.cancel(); return null; }
  if (!r.ok) { await r.body?.cancel(); throw new Error(graphError(r.status, "microsoft_unavailable")); }
  return await r.json() as GUser;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Microsoft's error code and message of a refused call, for the person (codes only are logged). */
async function graphReason(r: Response): Promise<{ code: string; message: string }> {
  try { const b = await r.json() as { error?: { code?: string; message?: string } }; return { code: String(b?.error?.code ?? r.status), message: String(b?.error?.message ?? "").slice(0, 300) }; }
  catch { return { code: String(r.status), message: "" }; }
}
/**
 * Reads the account again until Graph shows the change (a few seconds at most): success is only ever reported from Microsoft's own
 * answer. `done` says whether the user now looks as intended.
 */
async function confirmed(graph: Graph, id: string, done: (u: GUser) => boolean): Promise<GUser | null> {
  for (const wait of [0, 1500, 3000]) {
    if (wait) await sleep(wait);
    const u = await userById(graph, id);
    if (u && done(u)) return u;
  }
  return null;
}

/** Remove the Skyline licence(s) from up to 50 accounts; every account answered and logged on its own; success only when Graph confirms. */
export async function licenceRemove(ports: Ports, caller: string, ids: unknown): Promise<Reply> {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))].filter((x) => UUID.test(x)).slice(0, 50) : [];
  if (!list.length) return { status: 400, body: { error: "Choose the accounts." } };
  try {
    const graph = graphFor(ports, await appToken(ports));
    const ctx = await context(ports, graph, caller, true);
    if (!ctx.admins) return { status: 409, body: { code: "admin_roles_unreadable",
      error: `No licence was removed: Skyline must check that an account has no admin role first, which needs the Microsoft Graph application permission ${ADMIN_ROLE_PERMISSION} with admin consent.` } };
    const partToId = new Map([...ctx.skuPart].map(([id, part]) => [part, id]));
    const results: Array<{ id: string; upn: string; ok: boolean; error?: string; removed?: string[]; row?: ReturnType<typeof row> }> = [];
    for (const id of list) {
      const u = await userById(graph, id);
      if (!u) { results.push({ id, upn: "", ok: false, error: "No longer in Microsoft 365." }); continue; }
      const r = row(ctx, u); const who = { upn: r.upn, id: u.id };
      const remove = r.licences.filter((l) => l.skyline).map((l) => l.sku);
      if (!r.canRemove) { results.push({ id, upn: r.upn, ok: false, error: r.removeBlocked ?? "Not allowed", row: r }); await audit(ports, "licence_removed", who, remove[0] ?? null, "refused", { reason: r.removeBlocked }); continue; }
      const removeIds = remove.map((p) => partToId.get(p)).filter((x): x is string => !!x);
      // A licence that comes from a group cannot be removed from the user: say so before trying.
      const byGroup = (u.licenseAssignmentStates ?? []).filter((s) => removeIds.includes(s.skuId) && s.assignedByGroup);
      if (byGroup.length) {
        const why = `The licence comes from a group (group-based licensing, group ${byGroup[0].assignedByGroup}): remove the person from that group, or the licence from the group, in the Microsoft 365 admin centre.`;
        results.push({ id, upn: r.upn, ok: false, error: why, row: r }); await audit(ports, "licence_removed", who, remove.join(","), "refused", { reason: "group-based licence", group: byGroup[0].assignedByGroup }); continue;
      }
      const res = await graph("POST", `/users/${encodeURIComponent(u.id)}/assignLicense`, { addLicenses: [], removeLicenses: removeIds });
      if (!res.ok) { const g = await graphReason(res); results.push({ id, upn: r.upn, ok: false, error: `Microsoft refused (${g.code}${g.message ? `: ${g.message}` : ""}).`, row: r }); await audit(ports, "licence_removed", who, remove.join(","), "failed", { status: res.status, code: g.code }); continue; }
      await res.body?.cancel();
      const after = await confirmed(graph, u.id, (x) => !(x.assignedLicenses ?? []).some((l) => removeIds.includes(l.skuId)));
      if (!after) {
        const now = await userById(graph, u.id);
        const group = (now?.licenseAssignmentStates ?? []).find((s) => removeIds.includes(s.skuId) && s.assignedByGroup)?.assignedByGroup;
        const why = group ? `Microsoft put the licence back from group ${group} (group-based licensing).` : "Microsoft still lists the licence on the account a few seconds later; it was not removed. Try again, or check the account in the Microsoft 365 admin centre.";
        results.push({ id, upn: r.upn, ok: false, error: why, row: now ? row(ctx, now) : r }); await audit(ports, "licence_removed", who, remove.join(","), "failed", { reason: group ? "group-based licence" : "still listed", group: group ?? null }); continue;
      }
      try { await ports.rpc("o365_licence_record", { p_upn: r.upn, p_sku: null }); } catch { /* Microsoft is the source; the row follows on the next lookup */ }
      await audit(ports, "licence_removed", who, remove.join(","), "ok", { removed: remove, confirmed: true });
      results.push({ id, upn: r.upn, ok: true, removed: remove.map(friendly), row: row(ctx, after) });
    }
    resetDirectoryCache();
    return { status: 200, body: { results, removed: results.filter((x) => x.ok).length, refused: results.filter((x) => !x.ok).length } };
  } catch (e) { return fail(e); }
}

/** Assign the licence of the person's type (student: the student licence; employee / trainer / agent: the faculty one); confirmed by Graph. */
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
    if (!res.ok) { const g = await graphReason(res); await audit(ports, "licence_assigned", who, r.assign.sku, "failed", { status: res.status, code: g.code }); return { status: 409, body: { error: `Microsoft refused the licence (${g.code}${g.message ? `: ${g.message}` : ""}).` } }; }
    await res.body?.cancel();
    const after = await confirmed(graph, u.id, (x) => (x.assignedLicenses ?? []).some((l) => l.skuId === seat.skuId));
    if (!after) { await audit(ports, "licence_assigned", who, r.assign.sku, "failed", { reason: "not listed afterwards" }); return { status: 409, body: { error: "Microsoft accepted the request but does not list the licence on the account yet. Reload in a minute; nothing else was changed." } }; }
    try { await ports.rpc("o365_licence_record", { p_upn: r.upn, p_sku: r.assign.sku }); } catch { /* the row follows on the next lookup */ }
    await audit(ports, "licence_assigned", who, r.assign.sku, "ok", { confirmed: true });
    resetDirectoryCache();
    return { status: 200, body: { ok: true, upn: r.upn, licence: r.assign.name, row: row(ctx, after) } };
  } catch (e) { return fail(e); }
}

/**
 * Block (enabled false) or allow (true) sign-in on up to 50 accounts (PATCH accountEnabled), with the same protections as licence
 * removal: never the caller's own account, an admin-role account or a shared mailbox. Confirmed by Graph; every account logged.
 */
export async function signinSet(ports: Ports, caller: string, ids: unknown, enabled: unknown): Promise<Reply> {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))].filter((x) => UUID.test(x)).slice(0, 50) : [];
  if (!list.length) return { status: 400, body: { error: "Choose the accounts." } };
  if (typeof enabled !== "boolean") return { status: 400, body: { error: "Say whether sign-in is blocked or allowed." } };
  const action: AuditAction = enabled ? "signin_allowed" : "signin_blocked";
  try {
    const graph = graphFor(ports, await appToken(ports));
    const ctx = await context(ports, graph, caller, true);
    if (!ctx.admins) return { status: 409, body: { code: "admin_roles_unreadable", error: `Nothing was changed: Skyline must check that an account has no admin role first, which needs ${ADMIN_ROLE_PERMISSION} with admin consent.` } };
    const results: Array<{ id: string; upn: string; ok: boolean; error?: string; row?: ReturnType<typeof row> }> = [];
    for (const id of list) {
      const u = await userById(graph, id);
      if (!u) { results.push({ id, upn: "", ok: false, error: "No longer in Microsoft 365." }); continue; }
      const r = row(ctx, u); const who = { upn: r.upn, id: u.id };
      if ((u.userType ?? "Member") === "Guest" || r.signinBlocked) { const why = r.signinBlocked ?? "Guest account"; results.push({ id, upn: r.upn, ok: false, error: why, row: r }); await audit(ports, action, who, null, "refused", { reason: why }); continue; }
      if (r.enabled === enabled) { results.push({ id, upn: r.upn, ok: true, row: r }); continue; }
      const res = await graph("PATCH", `/users/${encodeURIComponent(u.id)}`, { accountEnabled: enabled });
      if (!res.ok) { const g = await graphReason(res); results.push({ id, upn: r.upn, ok: false, error: `Microsoft refused (${g.code}${g.message ? `: ${g.message}` : ""}).`, row: r }); await audit(ports, action, who, null, "failed", { status: res.status, code: g.code }); continue; }
      await res.body?.cancel();
      const after = await confirmed(graph, u.id, (x) => (x.accountEnabled !== false) === enabled);
      if (!after) { results.push({ id, upn: r.upn, ok: false, error: "Microsoft does not show the change yet. Reload in a minute.", row: r }); await audit(ports, action, who, null, "failed", { reason: "not shown afterwards" }); continue; }
      await audit(ports, action, who, null, "ok", { confirmed: true });
      // The audit row just written makes a blocked, unlinked staff account "blocked by Skyline", not a shared mailbox.
      if (!enabled) ctx.skylineBlocked.add(r.upn); else ctx.skylineBlocked.delete(r.upn);
      results.push({ id, upn: r.upn, ok: true, row: row(ctx, after) });
    }
    resetDirectoryCache();
    return { status: 200, body: { results, changed: results.filter((x) => x.ok).length, refused: results.filter((x) => !x.ok).length } };
  } catch (e) { return fail(e); }
}
