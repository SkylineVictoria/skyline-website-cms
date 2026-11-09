// =====================================================================
// xero-push — Xero Payroll AU push. TYPED STUB ONLY: not activated, not scheduled, no secrets.
//
// The HRMS exports approved hours, leave and public holidays per pay period (public.hr_admin_xero_export, stored in
// hr.xero_exports with a CSV). This function is the future home of the push to Xero Payroll AU over OAuth2
// (client credentials / authorization code with PKCE, tenant id, Payroll AU timesheets API). Until the owner activates
// it (sets EF_XERO_CLIENT_ID / EF_XERO_CLIENT_SECRET / EF_XERO_TENANT_ID and switches EF_XERO_PUSH_ENABLED to "true"),
// every call answers 501 and nothing leaves Skyline. Nothing schedules it.
// =====================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-domain",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** One export line as stored by public.hr_admin_xero_export (hr.xero_exports.lines[]). */
export interface XeroExportLine {
  profileId: string;
  xeroEmployeeId: string;
  employeeName: string;
  /** Local (Australia/Melbourne) calendar date, YYYY-MM-DD. */
  date: string;
  /** Ordinary | Overtime | Public Holiday | <leave type name> */
  payItem: string;
  hours: number;
  leaveTypeCode: string | null;
}

/** The request body this function will accept once activated. */
export interface XeroPushRequest {
  action: "push";
  exportId: string;
}

/** Xero Payroll AU OAuth2 settings (names only; values come from Edge Function secrets, never from the repo). */
export interface XeroOAuthConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  /** https://identity.xero.com/connect/token */
  tokenUrl: string;
  /** https://api.xero.com/payroll.xro/1.0 */
  payrollApiUrl: string;
  scopes: readonly string[];
}

export const XERO_SCOPES = ["payroll.timesheets", "payroll.employees.read", "payroll.settings.read"] as const;

export function readConfig(env: { get(name: string): string | undefined }): { enabled: boolean; config: XeroOAuthConfig; missing: string[] } {
  const enabled = (env.get("EF_XERO_PUSH_ENABLED") ?? "").trim().toLowerCase() === "true";
  const config: XeroOAuthConfig = {
    clientId: env.get("EF_XERO_CLIENT_ID") ?? "",
    clientSecret: env.get("EF_XERO_CLIENT_SECRET") ?? "",
    tenantId: env.get("EF_XERO_TENANT_ID") ?? "",
    tokenUrl: "https://identity.xero.com/connect/token",
    payrollApiUrl: "https://api.xero.com/payroll.xro/1.0",
    scopes: XERO_SCOPES,
  };
  const missing = (["EF_XERO_CLIENT_ID", "EF_XERO_CLIENT_SECRET", "EF_XERO_TENANT_ID"] as const).filter((n) => !(env.get(n) ?? "").trim());
  return { enabled, config, missing };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { enabled, missing } = readConfig(Deno.env);
  // Not activated: the push is a stub. Activation is an explicit owner decision (secrets + EF_XERO_PUSH_ENABLED=true), never a deploy.
  return json({ error: "xero-push is not activated", enabled, missingSettings: missing, hint: "Download the CSV from Staff > Xero Export and import it in Xero Payroll AU." }, 501);
});
