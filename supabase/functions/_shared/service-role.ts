// =====================================================================
// Service-role caller check without the PDF module graph. The same rule as _shared/notification/delivery.ts authorizeWorker
// (which small functions cannot import: its graph reaches pdf-lib and needs an import map). Kept here for holiday-sync.
//
// SECURITY: the claims are read WITHOUT verifying the signature, so this is only safe behind the platform gateway with
// config.toml verify_jwt = true for the calling function (the gateway has verified the token). It deliberately does not
// compare against SUPABASE_SERVICE_ROLE_KEY: that variable may hold the newer opaque sb_secret_ key, which no JWT, and so no
// pg_cron call, can ever equal. Claim values are never logged or returned.
// =====================================================================

function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function projectRefOf(supabaseUrl: string): string | null {
  try {
    const host = new URL(supabaseUrl).hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : null;
  } catch {
    return null;
  }
}

/** 200 = the project's service-role token (role service_role and, hosted, this project's ref); 401 = no bearer token; 403 = any other token. */
export function serviceRoleStatus(authorization: string | null, supabaseUrl: string): 200 | 401 | 403 {
  const token = /^Bearer (.+)$/.exec((authorization ?? "").trim())?.[1] ?? "";
  if (!token) return 401;
  const claims = jwtClaims(token);
  if (!claims || claims.role !== "service_role") return 403;
  const expected = projectRefOf(supabaseUrl);
  if (expected && claims.ref !== expected) return 403;
  return 200;
}
