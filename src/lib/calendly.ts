/**
 * Calendly on the public Contact page. The scheduling link is saved in the CMS (Contact Information) and stored on
 * cms_settings.calendly_url; the same shape check runs in the database (migration 20261106110000).
 */
const CALENDLY_LINK = /^https:\/\/calendly\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.-]+)*\/?$/;

/** "" when the link is empty or a Calendly scheduling link; otherwise what to fix. */
export function calendlyUrlProblem(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return CALENDLY_LINK.test(value) ? "" : "Enter a Calendly link such as https://calendly.com/your-team/30min";
}

/** The inline-embed address Calendly's own widget would build: no third-party script is loaded on the site. */
export function calendlyEmbedSrc(url: string, host: string): string {
  const base = url.trim().replace(/\/+$/, "");
  if (!base || calendlyUrlProblem(base)) return "";
  const params = new URLSearchParams({ embed_type: "Inline", hide_gdpr_banner: "1" });
  if (host) params.set("embed_domain", host);
  return `${base}?${params.toString()}`;
}
