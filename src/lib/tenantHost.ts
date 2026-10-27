import { portalScopeDomain } from "./portalScope";
/** Hostnames select public sites; they never grant staff authorization. */
export function normalizedHostname(value: string): string {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname) || hostname.split(".").some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))) {
    throw new Error("Website unavailable for this hostname.");
  }
  return hostname;
}

// Existing Skyline deployment and local legacy regression entry points only.
// New institutions require explicit verified database domain records.
export function isLegacyHostname(hostname: string): boolean {
  return ["slit.edu.au", "www.slit.edu.au", "localhost", "127.0.0.1"].includes(hostname);
}

export function requestWebsiteDomain(): string | null {
  if (typeof window === "undefined") return null;
  if (window.location.pathname.startsWith("/agency")) return portalScopeDomain();
  const hostname = normalizedHostname(window.location.hostname);
  return isLegacyHostname(hostname) ? null : hostname;
}
