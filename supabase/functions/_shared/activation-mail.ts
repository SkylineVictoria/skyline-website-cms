// INV-LINK: the "Activate access" email for an invitation to an email that already has a confirmed login. Small on purpose: it
// sends through Postmark with the same switches as the other mail (EF_NOTIFICATION_EMAIL_ENABLED = "true", EF_POSTMARK_SERVER_TOKEN,
// EF_HR_EMAIL_FROM, EF_HR_PUBLIC_SITE_URL) without importing the notification module (which pulls the PDF libraries).
import { simpleEmailHtml } from "./email-html.ts";

const EMAIL = /^[^@\s<>",]+@[^@\s<>",]+\.[^@\s<>",]+$/;
type Env = Record<string, string | undefined>;

export function activationFrom(env: Env): { name: string; email: string } | null {
  const raw = (env.EF_HR_EMAIL_FROM ?? "").trim();
  const named = raw.match(/^(.*)<([^<>]+)>$/);
  const address = (named ? named[2] : raw).trim().toLowerCase();
  return EMAIL.test(address) ? { name: (named?.[1] ?? "").replace(/"/g, "").trim() || "Skyline", email: address } : null;
}

/** EF_HR_PUBLIC_SITE_URL (https), else the https origin of the address the administrator is working on. */
export function activationSite(env: Env, redirectTo?: string): string | null {
  for (const candidate of [env.EF_HR_PUBLIC_SITE_URL ?? "", redirectTo ?? ""]) {
    try {
      const u = new URL(candidate.trim());
      if (u.protocol === "https:" && !u.username && !u.password) return candidate === redirectTo ? u.origin : u.toString().replace(/\/+$/, "");
    } catch { /* try the next */ }
  }
  return null;
}

export async function sendActivationEmail(env: Env, mail: { to: string; name: string; link: string; role?: string; agencyName?: string | null; expiresAt?: string },
  request: typeof fetch = fetch): Promise<{ ok: true } | { error: string }> {
  if ((env.EF_NOTIFICATION_EMAIL_ENABLED ?? "").trim() !== "true") return { error: "email sending is switched off" };
  const token = (env.EF_POSTMARK_SERVER_TOKEN ?? "").trim();
  if (!token) return { error: "EF_POSTMARK_SERVER_TOKEN is not set" };
  const from = activationFrom(env);
  if (!from) return { error: "EF_HR_EMAIL_FROM is not set" };
  const role = mail.role === "agency_admin" ? "an agency administrator" : mail.role === "student" ? "a student" : "an agent";
  const where = mail.agencyName ? ` for ${mail.agencyName}` : "";
  const expires = mail.expiresAt ? new Date(mail.expiresAt).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Melbourne" }) : "";
  const intro = `Hello ${mail.name || "there"},`;
  const body = `You have been invited to the Skyline portal as ${role}${where}. Open the link below to activate your access and create your password. Until you do, the portal stays locked for this invitation.`;
  const note = `${expires ? `This link works until ${expires}. ` : ""}If you did not expect this email, you can ignore it; nothing changes unless you open the link.`;
  const subject = "Activate your Skyline portal access";
  const text = `${intro}\n\n${body}\n\nActivate access: ${mail.link}\n\n${note}`;
  const html = simpleEmailHtml({ brand: from.name, heading: "Activate your portal access", paragraphs: [intro, body], button: { label: "Activate access and create password", url: mail.link }, note });
  const display = from.name.replace(/[\u0000-\u001f\u007f<>"\\]/g, " ").trim().slice(0, 100);
  try {
    const response = await request("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
      body: JSON.stringify({ From: `"${display}" <${from.email}>`, To: mail.to, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: "outbound", TrackOpens: false, TrackLinks: "None" }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => null) as { ErrorCode?: number } | null;
    return response.status === 200 && result?.ErrorCode === 0 ? { ok: true } : { error: `postmark ${response.status}/${result?.ErrorCode ?? "?"}` };
  } catch {
    return { error: "postmark unreachable" };
  }
}
