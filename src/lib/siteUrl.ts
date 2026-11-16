/**
 * The public origin is deployment configuration, not request data.  In
 * particular, never use window.location.origin for links sent in email: a
 * preview, compromised host header, or local browser must not choose where an
 * authentication token is delivered.
 */
const configured = import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined;
// A Vercel preview build has no fixed address: Vercel's own build-time system variables name it (also build configuration, not request data).
const vercelPreview = import.meta.env.VITE_VERCEL_ENV === "preview" && typeof import.meta.env.VITE_VERCEL_URL === "string" && import.meta.env.VITE_VERCEL_URL
  ? `https://${import.meta.env.VITE_VERCEL_URL}` : "";

export function publicSiteOrigin(): string {
  const candidate = configured?.trim() || vercelPreview || (import.meta.env.DEV ? `http://localhost:${window.location.port || "3000"}` : "");
  if (!candidate) throw new Error("Password recovery is not configured for this deployment.");

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("VITE_PUBLIC_SITE_URL must be an absolute http(s) URL.");
  }
  if (url.protocol !== "https:" && !(import.meta.env.DEV && url.protocol === "http:")) {
    throw new Error("VITE_PUBLIC_SITE_URL must use HTTPS outside local development.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("VITE_PUBLIC_SITE_URL must be an origin without a path, query, or credentials.");
  }
  return url.origin;
}

export function passwordRecoveryUrl(): string {
  const base = __BASE_PATH__.split("/").filter(Boolean).join("/");
  return `${publicSiteOrigin()}${base ? `/${base}` : ""}/reset-password`;
}
