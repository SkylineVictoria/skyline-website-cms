/**
 * P09-01: which public institution a public (anonymous) request is for. A hostname only selects published content; it never
 * grants staff authority. The selected hostname must then resolve through tenant_resolve (verified domain, active tenant),
 * and an unresolved hostname fails closed: it is never answered from another institution's knowledge.
 *
 * - The site sends x-tenant-domain on non-legacy hosts (src/lib/tenantHost.ts). A browser's Origin must agree with it.
 * - A browser on a non-legacy host without the header is still scoped by its Origin (no silent fallback to the legacy site).
 * - Legacy hosts (and server-side callers without Origin or header) use the existing institution (tenant null).
 * No imports: kept runnable by the offline Node tests.
 */
const LEGACY_HOSTS = ["slit.edu.au", "www.slit.edu.au", "localhost", "127.0.0.1"];

export function isLegacyHostname(hostname: string): boolean {
  return LEGACY_HOSTS.includes(hostname) || hostname.endsWith(".vercel.app");
}

export function normalizedHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname) ||
    hostname.split(".").some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))
  ) return null;
  return hostname;
}

/** A public document is indexed only from its own institution's public storage: the legacy institution's cms-media forms/
 * and policies/, a tenant's tenant-public-media/<tenant id>/. Private buckets never qualify. public_assistant_commit_index
 * re-checks the same rule against the CMS row inside the fenced commit. */
export function trustedDocumentLocation(tenant: string | null, bucket: string, path: string): boolean {
  if (!path || path.includes("..") || path.startsWith("/") || path.includes("\\")) return false;
  if (tenant === null) return bucket === "cms-media" && (path.startsWith("forms/") || path.startsWith("policies/"));
  return bucket === "tenant-public-media" && path.startsWith(`${tenant}/`) && path.length > tenant.length + 1;
}

export type PublicTenantSelector =
  | { ok: true; hostname: string | null }
  | { ok: false; status: 400 | 403; code: "invalid_tenant_domain" | "invalid_origin" | "tenant_origin_mismatch" };

export function publicTenantSelector(header: string | null, origin: string | null): PublicTenantSelector {
  let selected: string | null = null;
  if (header !== null && header.trim() !== "") {
    selected = normalizedHostname(header);
    if (!selected) return { ok: false, status: 400, code: "invalid_tenant_domain" };
  }
  let originHost: string | null = null;
  if (origin !== null && origin.trim() !== "" && origin !== "null") {
    try {
      const parsed = new URL(origin);
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("origin");
      originHost = normalizedHostname(parsed.hostname);
    } catch {
      originHost = null;
    }
    if (!originHost) return { ok: false, status: 400, code: "invalid_origin" };
  }
  if (selected && originHost && selected !== originHost) return { ok: false, status: 403, code: "tenant_origin_mismatch" };
  if (selected) return { ok: true, hostname: selected };
  if (originHost && !isLegacyHostname(originHost)) return { ok: true, hostname: originHost };
  return { ok: true, hostname: null };
}
