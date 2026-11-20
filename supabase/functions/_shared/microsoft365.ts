/*
 * Microsoft 365 status (owner 2026-11-20): the ONE check behind Integrations > Connections > Microsoft 365 and Administration > Email
 * Management. App-only (client credentials) with Skyline's Entra app, the same app registration the Connections sign-in uses
 * (EF_MICROSOFT365_CLIENT_ID / _CLIENT_SECRET / _TENANT_ID). Every item is a real Microsoft call:
 *   connection    a token from login.microsoftonline.com for the tenant
 *   admin consent the application permissions granted to the app, read from the token's "roles" claim (only admin-consented
 *                 application permissions appear there)
 *   organization  GET /organization (Organization.Read.All)
 *   domain        GET /domains (Domain.Read.All): slit.edu.au and the student domain verified
 *   licence       GET /subscribedSkus: seats left (enabled - consumed), the student licence first
 * Nothing is created or changed. No secret, token or Microsoft response body leaves this module; only the facts below.
 */

export const GRAPH = "https://graph.microsoft.com/v1.0";
/** Application permissions Email Management needs (owner's list) and the one the welcome email needs. */
export const REQUIRED_ROLES = ["User.ReadWrite.All", "Organization.Read.All", "LicenseAssignment.ReadWrite.All", "Domain.Read.All"] as const;
export const WELCOME_ROLE = "Mail.Send";
/** SLIT's own email domain, always checked. */
export const SLIT_DOMAIN = "slit.edu.au";

export type CheckState = "ok" | "missing" | "failed" | "not_checked";
export interface Microsoft365Status {
  configured: boolean;
  connected: boolean;
  /** "Connected" only when every check passes. */
  ready: boolean;
  tenant: { id: string; name: string } | null;
  clientIdEnd: string | null;
  checks: { connection: CheckState; consent: CheckState; domain: CheckState; licence: CheckState };
  consent: { granted: string[]; missing: string[]; welcomeEmail: boolean };
  domains: Array<{ name: string; verified: boolean; found: boolean }>;
  licences: Array<{ sku: string; available: number; total: number; student: boolean; staff: boolean }>;
  /** The mailbox the login emails are sent from (EF_MICROSOFT365_WELCOME_SENDER): found in the tenant, enabled, with an Exchange licence. */
  sender: { address: string; found: boolean; enabled: boolean; exchangeLicence: boolean; plans: string[] } | null;
  /** One plain sentence per problem, in the order to fix them. */
  problems: string[];
  checkedAt: string;
}

type Env = (name: string) => string | undefined;

/** The "roles" claim of an app-only access token (the admin-consented application permissions). Not a verification: the token came straight from Microsoft. */
export function tokenRoles(token: string): string[] {
  try {
    const part = token.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const roles = (JSON.parse(json) as { roles?: unknown }).roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [];
  } catch { return []; }
}

/** What Microsoft's sign-in error code means, without echoing its text. */
function authProblem(code: string): string {
  if (/AADSTS7000215|invalid_client/i.test(code)) return "Microsoft rejected the app's client secret (wrong or expired). Create a new client secret in Entra > App registrations > the app > Certificates & secrets, then update EF_MICROSOFT365_CLIENT_SECRET.";
  if (/AADSTS700016|unauthorized_client/i.test(code)) return "Microsoft does not know this app in the tenant. Check EF_MICROSOFT365_CLIENT_ID and EF_MICROSOFT365_TENANT_ID.";
  if (/AADSTS90002|AADSTS900023|invalid_request/i.test(code)) return "The tenant ID is not valid. Check EF_MICROSOFT365_TENANT_ID.";
  return "Skyline could not sign in to Microsoft 365 with the app. Check the app ID, secret and tenant ID.";
}

export async function microsoft365Status(env: Env, request: typeof fetch = fetch, now = () => new Date()): Promise<Microsoft365Status> {
  const read = (n: string) => (env(n) ?? "").trim();
  const clientId = read("EF_MICROSOFT365_CLIENT_ID"), secret = read("EF_MICROSOFT365_CLIENT_SECRET"), tenantId = read("EF_MICROSOFT365_TENANT_ID");
  const studentDomain = read("EF_MICROSOFT365_STUDENT_DOMAIN").toLowerCase();
  const studentSku = read("EF_MICROSOFT365_STUDENT_SKU") || "STANDARDWOFFPACK_STUDENT";
  const staffSku = read("EF_MICROSOFT365_STAFF_SKU") || "STANDARDWOFFPACK_FACULTY";
  const status: Microsoft365Status = {
    configured: !!(clientId && secret && tenantId), connected: false, ready: false, tenant: null, clientIdEnd: clientId ? clientId.slice(-4) : null,
    checks: { connection: "not_checked", consent: "not_checked", domain: "not_checked", licence: "not_checked" },
    consent: { granted: [], missing: [...REQUIRED_ROLES], welcomeEmail: false }, domains: [], licences: [], sender: null, problems: [], checkedAt: now().toISOString(),
  };
  if (!status.configured) {
    status.checks.connection = "missing";
    status.problems.push("Microsoft 365 is not set up: the app's client ID, client secret and tenant ID are not all saved as Edge Function secrets.");
    return status;
  }
  // 1. Connection: an app-only token for the tenant.
  let token = "";
  try {
    const r = await request(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, redirect: "error", signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }) });
    const body = await r.json().catch(() => ({})) as { access_token?: string; error?: string; error_codes?: number[] };
    if (!r.ok || typeof body.access_token !== "string") {
      status.checks.connection = "failed";
      status.problems.push(authProblem(`${body.error ?? ""} ${(body.error_codes ?? []).map((c) => `AADSTS${c}`).join(" ")}`));
      return status;
    }
    token = body.access_token;
  } catch {
    status.checks.connection = "failed";
    status.problems.push("Microsoft 365 could not be reached. Try again shortly.");
    return status;
  }
  status.connected = true; status.checks.connection = "ok";
  // 2. Admin consent: the application permissions granted to the app.
  const roles = tokenRoles(token);
  status.consent = { granted: roles.filter((r) => (REQUIRED_ROLES as readonly string[]).includes(r) || r === WELCOME_ROLE).sort(),
    missing: REQUIRED_ROLES.filter((r) => !roles.includes(r)), welcomeEmail: roles.includes(WELCOME_ROLE) };
  status.checks.consent = status.consent.missing.length ? "missing" : "ok";
  if (status.consent.missing.length) status.problems.push(`Admin consent is missing for: ${status.consent.missing.join(", ")}. In Entra > App registrations > the app > API permissions, add them as Microsoft Graph Application permissions, then select Grant admin consent.`);
  const graph = (path: string) => request(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15000) });
  // 3. The organization (tenant name) and its domains.
  let orgDomains: Array<{ name: string; isVerified: boolean }> = [];
  try {
    const r = await graph("/organization?$select=id,displayName,verifiedDomains");
    if (r.ok) {
      const org = ((await r.json()) as { value?: Array<{ id: string; displayName: string; verifiedDomains?: Array<{ name: string }> }> }).value?.[0];
      if (org) { status.tenant = { id: org.id, name: org.displayName }; orgDomains = (org.verifiedDomains ?? []).map((d) => ({ name: String(d.name).toLowerCase(), isVerified: true })); }
    } else await r.body?.cancel();
  } catch { /* the domain check below reports it */ }
  const wanted = [...new Set([SLIT_DOMAIN, studentDomain].filter(Boolean))];
  try {
    const r = await graph("/domains?$select=id,isVerified");
    let list: Array<{ name: string; isVerified: boolean }> = orgDomains;
    if (r.ok) list = (((await r.json()) as { value?: Array<{ id: string; isVerified: boolean }> }).value ?? []).map((d) => ({ name: String(d.id).toLowerCase(), isVerified: d.isVerified === true }));
    else { await r.body?.cancel(); if (!orgDomains.length) throw new Error(String(r.status)); }
    status.domains = wanted.map((name) => { const d = list.find((x) => x.name === name); return { name, verified: !!d?.isVerified, found: !!d }; });
    const bad = status.domains.filter((d) => !d.verified);
    status.checks.domain = bad.length ? "missing" : "ok";
    for (const d of bad) status.problems.push(d.found ? `The domain ${d.name} is in Microsoft 365 but not verified. Finish its DNS verification in the Microsoft 365 admin centre > Settings > Domains.` : `The domain ${d.name} is not added to Microsoft 365. Add and verify it in the Microsoft 365 admin centre > Settings > Domains.`);
  } catch {
    status.checks.domain = "failed";
    status.problems.push("The domains could not be read (Domain.Read.All needs admin consent).");
  }
  // 4. Licences: seats left per subscription; the student licence is the one Create Email uses for students.
  try {
    const r = await graph("/subscribedSkus?$select=skuPartNumber,prepaidUnits,consumedUnits,capabilityStatus");
    if (!r.ok) { await r.body?.cancel(); throw new Error(String(r.status)); }
    const skus = ((await r.json()) as { value?: Array<{ skuPartNumber: string; capabilityStatus?: string; prepaidUnits?: { enabled?: number }; consumedUnits?: number }> }).value ?? [];
    status.licences = skus.filter((s) => (s.capabilityStatus ?? "Enabled") === "Enabled").map((s) => {
      const total = Number(s.prepaidUnits?.enabled ?? 0); return { sku: s.skuPartNumber, total, available: Math.max(0, total - Number(s.consumedUnits ?? 0)), student: s.skuPartNumber === studentSku, staff: s.skuPartNumber === staffSku };
    }).sort((a, b) => Number(b.student) - Number(a.student) || Number(b.staff) - Number(a.staff) || b.available - a.available);
    const student = status.licences.find((l) => l.student);
    status.checks.licence = student && student.available > 0 ? "ok" : "missing";
    if (!student) status.problems.push(`The tenant has no ${studentSku} subscription (the student licence). Add it in the Microsoft 365 admin centre > Billing, or set EF_MICROSOFT365_STUDENT_SKU to the licence to use.`);
    else if (student.available <= 0) status.problems.push(`No ${studentSku} seats are free (${student.total} in use). Add seats in the Microsoft 365 admin centre > Billing > Licenses.`);
  } catch {
    status.checks.licence = "failed";
    status.problems.push("The licences could not be read (Organization.Read.All needs admin consent).");
  }
  // 5. The login-email sender: a real mailbox in the tenant (a licensed user with Exchange, or a shared mailbox).
  const sender = read("EF_MICROSOFT365_WELCOME_SENDER").toLowerCase();
  if (sender) {
    try {
      const r = await graph(`/users/${encodeURIComponent(sender)}?$select=id,accountEnabled,mail,assignedPlans`);
      if (r.status === 404) { await r.body?.cancel(); status.sender = { address: sender, found: false, enabled: false, exchangeLicence: false, plans: [] }; }
      else if (r.ok) {
        const u = await r.json() as { accountEnabled?: boolean; assignedPlans?: Array<{ service?: string; capabilityStatus?: string }> };
        const plans = [...new Set((u.assignedPlans ?? []).filter((p) => p.capabilityStatus === "Enabled").map((p) => String(p.service ?? "")))].filter(Boolean).sort();
        status.sender = { address: sender, found: true, enabled: u.accountEnabled !== false, exchangeLicence: plans.includes("exchange"), plans };
      } else await r.body?.cancel();
    } catch { /* reported as unknown */ }
    if (status.sender && !status.sender.found) status.problems.push(`The login emails are sent from ${sender}, which does not exist in Microsoft 365. Create it (a shared mailbox is enough) or change EF_MICROSOFT365_WELCOME_SENDER.`);
    // A shared mailbox has no licence and its sign-in is blocked: that is fine. Only a sign-in-enabled user without Exchange is a problem.
    else if (status.sender && !status.sender.exchangeLicence && status.sender.enabled) status.problems.push(`The login emails are sent from ${sender}, which has no Exchange Online licence. Unless it is a shared mailbox, give it a licence with Exchange (e.g. Office 365 A1 for faculty) in the Microsoft 365 admin centre.`);
  } else status.problems.push("No sender mailbox is set for login emails (EF_MICROSOFT365_WELCOME_SENDER).");
  status.ready = Object.values(status.checks).every((c) => c === "ok");
  return status;
}
