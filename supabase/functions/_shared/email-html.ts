// The one branded HTML email layout (2026-11-24, owner: "every email to users looks professional"). Email-client safe: nested tables,
// inline styles, 600 px, bulletproof buttons, a hidden preheader, light / dark tolerant, readable on a phone. Everything that comes from
// data is escaped; links must be https (plain http only for a local stack) and are written once, as given. No tracking, no remote fonts;
// the only remote picture is the institution's own logo (Website settings › logo, https only).
//
// Branding (logo, colour, legal name, address, phone, email, website, ABN, RTO, CRICOS) comes from public.cms_settings and the
// institution name from Business Rule comms.email_institution_name. loadEmailBranding(client) reads them once per request (cached for
// five minutes per isolate); until then the built-in SLIT defaults below are used. The database builds the same layout for the queued
// emails (public.email_html_wrap), so both look the same.
//
// textEmailHtml() turns an existing plain-text email into this layout without changing its words: blank-line paragraphs, "- " lists,
// "Label: value" blocks as a detail table, "Label:\n<link>" / "Label: <link>" as a button, "Message from ...:" blocks as a note, and the
// plain-text sign-off ("Skyline Institute of Technology / This is an automated message.") as the signature and footer.

export const escapeEmailHtml = (text: string) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const esc = escapeEmailHtml;
/** An https link (http only for a local stack), else null. */
export function safeEmailUrl(url: string): string | null {
  const value = String(url ?? "").trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.username || u.password) return null;
    if (u.protocol === "https:") return value;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "kong", "host.docker.internal"].includes(u.hostname) ? value : null;
  } catch { return null; }
}

// ------------------------------------------------------------------------------------------------------------------------ branding
export interface EmailBranding {
  /** The institution as people know it (sign-off, header wordmark, logo alt text). */
  name: string;
  /** The legal entity printed in the footer (cms_settings.legal_name); the name when empty. */
  legalName: string;
  logoUrl: string | null;
  /** Logo size in pixels when known (from the PNG header), so Outlook does not draw it at its full size. */
  logoWidth: number | null;
  logoHeight: number | null;
  primary: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  abn: string | null;
  rto: string | null;
  cricos: string | null;
}

export const DEFAULT_EMAIL_BRANDING: EmailBranding = {
  name: "Skyline Institute of Technology", legalName: "Skyline Institute of Technology", logoUrl: null, logoWidth: null, logoHeight: null,
  primary: "#ea6619", address: null, phone: null, email: null, website: null, abn: null, rto: null, cricos: null,
};

let current: EmailBranding = { ...DEFAULT_EMAIL_BRANDING };
let loadedAt = 0;
const CACHE_MS = 5 * 60_000;

// eslint-disable-next-line no-control-regex -- control characters never belong in a printed value
const clean = (value: unknown, max = 200) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null;
const HEX = /^#[0-9a-f]{6}$/i;

/** The branding emails use now. */
export function emailBranding(): EmailBranding { return current; }
/** Sets (part of) the branding: empty values keep what is there. */
export function setEmailBranding(partial: Partial<EmailBranding>) {
  const next = { ...current };
  for (const [key, value] of Object.entries(partial) as Array<[keyof EmailBranding, unknown]>) {
    if (value === undefined || value === null || value === "") continue;
    (next as Record<string, unknown>)[key] = value;
  }
  if (!HEX.test(next.primary)) next.primary = DEFAULT_EMAIL_BRANDING.primary;
  current = next;
}
/** Back to the built-in defaults (tests). */
export function resetEmailBranding() { current = { ...DEFAULT_EMAIL_BRANDING }; loadedAt = 0; }

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Supabase client, structurally
type BrandingClient = { from: (table: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: unknown }> };

/** Width and height of a PNG from its first bytes (IHDR), else null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  return width > 0 && height > 0 && width < 10000 && height < 10000 ? { width, height } : null;
}

/**
 * Reads the branding for this project (cms_settings without a tenant, the first row) and the institution name rule, once per five
 * minutes per isolate. Never throws: on any problem the current (default) branding stays.
 */
export async function loadEmailBranding(client: BrandingClient, options: { force?: boolean; fetch?: typeof fetch } = {}): Promise<EmailBranding> {
  if (!options.force && loadedAt && Date.now() - loadedAt < CACHE_MS) return current;
  loadedAt = Date.now();
  try {
    const { data } = await client.from("cms_settings").select("name, legal_name, logo, primary_color, address, phone, email, website, abn, rto, cricos, tenant_id")
      .order("id", { ascending: true }).limit(5);
    const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
    const row = rows.find((r) => r.tenant_id === null) ?? rows[0];
    let rule: string | null = null;
    if (client.rpc) {
      try {
        const { data: rules } = await client.rpc("business_rule_values", { p_ids: ["comms.email_institution_name"] });
        rule = clean((rules as Record<string, unknown> | null)?.["comms.email_institution_name"], 120);
      } catch { /* the setting's name applies */ }
    }
    if (row) {
      const logo = clean(row.logo, 1000);
      const logoUrl = logo && /^https:\/\//i.test(logo) ? safeEmailUrl(logo) : null;
      let size: { width: number; height: number } | null = null;
      if (logoUrl && logoUrl !== current.logoUrl) {
        try {
          const response = await (options.fetch ?? fetch)(logoUrl, { headers: { Range: "bytes=0-63" }, signal: AbortSignal.timeout(3000) });
          size = response.ok ? pngSize(new Uint8Array(await response.arrayBuffer()).slice(0, 64)) : null;
        } catch { size = null; }
      } else if (logoUrl && current.logoWidth && current.logoHeight) size = { width: current.logoWidth, height: current.logoHeight };
      // Business Rule comms.email_institution_name (its own fallback is the built-in name), as the plain-text sign-off uses.
      const name = rule ?? DEFAULT_EMAIL_BRANDING.name;
      current = {
        name: name ?? DEFAULT_EMAIL_BRANDING.name,
        legalName: clean(row.legal_name, 200) ?? name ?? DEFAULT_EMAIL_BRANDING.legalName,
        logoUrl, logoWidth: size?.width ?? null, logoHeight: size?.height ?? null,
        primary: HEX.test(String(row.primary_color ?? "")) ? String(row.primary_color) : DEFAULT_EMAIL_BRANDING.primary,
        address: clean(row.address, 300), phone: clean(row.phone, 60), email: clean(row.email, 254),
        website: (() => { const w = clean(row.website, 300); return w ? safeEmailUrl(w) : null; })(),
        abn: clean(row.abn, 40), rto: clean(row.rto, 20), cricos: clean(row.cricos, 20),
      };
    } else if (rule) setEmailBranding({ name: rule });
  } catch { /* keep the current branding */ }
  return current;
}

// ------------------------------------------------------------------------------------------------------------------------ colours
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrastWithWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);
/** The brand colour darkened until white text on it reads well (WCAG AA 4.5:1); the colour itself when it already does. */
export function readableOnWhite(hex: string): string {
  let color = HEX.test(hex) ? hex.toLowerCase() : DEFAULT_EMAIL_BRANDING.primary;
  for (let i = 0; i < 20 && contrastWithWhite(color) < 4.5; i++) {
    color = "#" + [1, 3, 5].map((p) => Math.max(0, Math.round(parseInt(color.slice(p, p + 2), 16) * 0.92)).toString(16).padStart(2, "0")).join("");
  }
  return color;
}

// ------------------------------------------------------------------------------------------------------------------------ layout
export type EmailBlock =
  | { type: "p"; text: string; muted?: boolean }
  | { type: "list"; items: string[] }
  | { type: "details"; rows: Array<{ label: string; value: string }> }
  | { type: "button"; label: string; url: string; note?: string | null }
  | { type: "note"; title?: string | null; text: string }
  | { type: "code"; code: string; label?: string | null }
  /** Already-safe HTML (an HRMS template rendered and sanitised by hr-template.ts). */
  | { type: "html"; html: string };

export interface BrandedEmail {
  /** The heading in the email (usually the subject). */
  heading: string;
  /** The hidden line mail apps show next to the subject; the first paragraph when not given. */
  preheader?: string | null;
  /** A small label above the heading (for example "Agent onboarding"). */
  eyebrow?: string | null;
  blocks: EmailBlock[];
  /** "Kind regards, ..." under the body: true = the institution, a string = a team ("Admissions team"), false / null = none. */
  signOff?: boolean | string | null;
  /** An extra line in the footer above the automated-message line. */
  footerNote?: string | null;
  /** Overrides the brand colour (a #rrggbb value). */
  primary?: string | null;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TEXT = "#1f2937", MUTED = "#6b7280", BORDER = "#e5e7eb", SOFT = "#f8fafc";

/** Plain text with links made clickable (the text is escaped first; only http(s) links that pass safeEmailUrl become links). */
function inline(text: string, link: string): string {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
    const trail = /[.,;:!?)]+$/.exec(raw)?.[0] ?? "";
    const href = raw.slice(0, raw.length - trail.length);
    const url = safeEmailUrl(href.replace(/&amp;/g, "&"));
    return url ? `<a href="${esc(url)}" style="color:${link};text-decoration:underline;word-break:break-all">${href}</a>${trail}` : raw;
  }).replace(/\n/g, "<br>");
}

function renderBlock(block: EmailBlock, primary: string, link: string): string {
  const p = (html: string, style = `margin:0 0 16px;font-size:15px;line-height:1.6;color:${TEXT}`) => `<p class="em-text" style="${style}">${html}</p>`;
  switch (block.type) {
    case "p":
      return block.text.trim() ? p(inline(block.text, link), block.muted ? `margin:0 0 16px;font-size:13px;line-height:1.6;color:${MUTED}` : undefined) : "";
    case "list":
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px">` +
        block.items.map((item) => `<tr><td valign="top" style="padding:0 10px 6px 2px;font-size:15px;line-height:1.6;color:${primary}">&#8226;</td>` +
          `<td class="em-text" style="padding:0 0 6px;font-size:15px;line-height:1.6;color:${TEXT}">${inline(item, link)}</td></tr>`).join("") + `</table>`;
    case "details":
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-box" style="margin:4px 0 20px;border:1px solid ${BORDER};border-radius:8px;background:${SOFT};border-collapse:separate">` +
        block.rows.map((row, i) => `<tr><td class="em-muted em-dlabel" valign="top" style="padding:10px 14px;${i ? `border-top:1px solid ${BORDER};` : ""}width:36%;font-size:13px;line-height:1.5;color:${MUTED}">${esc(row.label)}</td>` +
          `<td class="em-text" valign="top" style="padding:10px 14px;${i ? `border-top:1px solid ${BORDER};` : ""}font-size:14px;line-height:1.5;color:${TEXT};font-weight:600;word-break:break-word">${inline(row.value, link)}</td></tr>`).join("") + `</table>`;
    case "button": {
      const url = safeEmailUrl(block.url);
      if (!url) return p(inline(`${block.label}: ${block.url}`, link));
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 12px"><tr><td align="center" bgcolor="${primary}" style="border-radius:8px;background:${primary}">` +
        `<a href="${esc(url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px;mso-padding-alt:0">${esc(block.label)}</a>` +
        `</td></tr></table>` +
        (block.note ? p(esc(block.note), `margin:0 0 8px;font-size:13px;line-height:1.5;color:${MUTED}`) : "") +
        p(`If the button does not work, copy this link into your browser:<br><a href="${esc(url)}" style="color:${link};word-break:break-all">${esc(url)}</a>`,
          `margin:0 0 20px;font-size:12px;line-height:1.5;color:${MUTED};word-break:break-all`);
    }
    case "note":
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 20px"><tr>` +
        `<td class="em-box" style="padding:14px 16px;border-left:4px solid ${primary};border-radius:6px;background:${SOFT}">` +
        (block.title ? `<p class="em-text" style="margin:0 0 6px;font-size:13px;font-weight:700;line-height:1.4;color:${TEXT}">${esc(block.title)}</p>` : "") +
        `<p class="em-text" style="margin:0;font-size:14px;line-height:1.6;color:${TEXT}">${inline(block.text, link)}</p></td></tr></table>`;
    case "code":
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 20px"><tr>` +
        `<td class="em-box" style="padding:16px 26px;border:1px dashed ${primary};border-radius:10px;background:${SOFT}">` +
        (block.label ? `<p class="em-muted" style="margin:0 0 4px;font-size:12px;line-height:1.4;color:${MUTED};text-transform:uppercase;letter-spacing:.06em">${esc(block.label)}</p>` : "") +
        `<p class="em-text" style="margin:0;font-family:Consolas,'SFMono-Regular',Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px;line-height:1.2;color:${TEXT}">${esc(block.code)}</p></td></tr></table>`;
    case "html":
      return `<div class="em-text em-html" style="font-size:15px;line-height:1.6;color:${TEXT}">${block.html}</div>`;
  }
}

/** The footer lines (escaped HTML) for a branding. */
function footerHtml(b: EmailBranding, link: string, note?: string | null): string {
  const lines: string[] = [`<strong style="color:#374151" class="em-text">${esc(b.legalName || b.name)}</strong>`];
  if (b.address) lines.push(esc(b.address));
  const contact = [
    b.phone ? `Phone ${esc(b.phone)}` : null,
    b.email ? `<a href="mailto:${esc(b.email)}" style="color:${MUTED};text-decoration:underline">${esc(b.email)}</a>` : null,
    b.website ? `<a href="${esc(b.website)}" style="color:${MUTED};text-decoration:underline">${esc(b.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>` : null,
  ].filter(Boolean);
  if (contact.length) lines.push(contact.join(" &nbsp;&middot;&nbsp; "));
  const ids = [b.abn ? `ABN ${esc(b.abn)}` : null, b.rto ? `RTO ${esc(b.rto)}` : null, b.cricos ? `CRICOS ${esc(b.cricos)}` : null].filter(Boolean);
  if (ids.length) lines.push(ids.join(" &nbsp;&middot;&nbsp; "));
  void link;
  return lines.join("<br>") +
    (note ? `<br><br>${esc(note)}` : "") +
    `<br><br><span style="color:#9ca3af">This is an automated message from ${esc(b.name)}.${b.email ? ` If you have a question, contact us at ${esc(b.email)}${b.phone ? ` or ${esc(b.phone)}` : ""}.` : ""}</span>`;
}

/** The branded email document. */
export function brandedEmailHtml(email: BrandedEmail, branding: EmailBranding = current): string {
  const brandColor = HEX.test(email.primary ?? "") ? email.primary! : branding.primary;
  const primary = readableOnWhite(brandColor);
  const link = primary;
  const firstText = email.blocks.find((b): b is { type: "p"; text: string } => b.type === "p" && !/^(hello|hi|dear)\b/i.test(b.text.trim()));
  const preheader = (email.preheader ?? firstText?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  const logo = branding.logoUrl && safeEmailUrl(branding.logoUrl);
  const logoH = 44;
  const logoW = branding.logoWidth && branding.logoHeight ? Math.min(240, Math.round(branding.logoWidth * logoH / branding.logoHeight)) : null;
  const header = logo
    ? `<img src="${esc(logo)}" alt="${esc(branding.name)}" height="${logoH}"${logoW ? ` width="${logoW}"` : ""} style="display:block;height:${logoH}px;${logoW ? `width:${logoW}px;` : "width:auto;"}max-width:240px;border:0;outline:none;text-decoration:none">`
    : `<span style="font-size:20px;font-weight:800;letter-spacing:-.01em;color:${primary}">${esc(branding.name)}</span>`;
  const sign = email.signOff === undefined || email.signOff === null || email.signOff === false ? ""
    : `<p class="em-text" style="margin:8px 0 0;font-size:15px;line-height:1.6;color:${TEXT}">Kind regards,<br><strong>${typeof email.signOff === "string" && email.signOff.trim() ? `${esc(email.signOff.trim())} &middot; ` : ""}${esc(branding.name)}</strong></p>`;
  const body = email.blocks.map((b) => renderBlock(b, primary, link)).join("");
  return `<!doctype html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<meta name="format-detection" content="telephone=no,address=no,email=no,date=no"><title>${esc(email.heading)}</title>` +
    `<style>body{margin:0!important;padding:0!important;width:100%!important}a{color:${link}}` +
    `@media only screen and (max-width:620px){.em-card{border-radius:0!important}.em-pad{padding-left:20px!important;padding-right:20px!important}.em-outer{padding:0!important}.em-dlabel{width:40%!important}}` +
    `@media (prefers-color-scheme:dark){.em-bg{background:#111827!important}.em-card{background:#1f2937!important;border-color:#374151!important}.em-text{color:#f3f4f6!important}.em-muted{color:#9ca3af!important}` +
    `.em-box{background:#111827!important;border-color:#374151!important}.em-foot{background:#111827!important;color:#9ca3af!important;border-color:#374151!important}.em-head{background:#ffffff!important}}</style>` +
    `<!--[if mso]><style>table,td,p,a,span{font-family:Arial,Helvetica,sans-serif!important}</style><![endif]--></head>` +
    `<body class="em-bg" style="margin:0;padding:0;background:#f1f3f6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">` +
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f1f3f6;opacity:0">${esc(preheader)}${"&nbsp;&zwnj;".repeat(30)}</div>` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-bg" style="background:#f1f3f6"><tr><td align="center" class="em-outer" style="padding:28px 12px">` +
    `<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-card" style="max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;border-collapse:separate;overflow:hidden;font-family:${FONT}">` +
    `<tr><td height="5" style="height:5px;line-height:5px;font-size:0;background:${brandColor}" bgcolor="${brandColor}">&nbsp;</td></tr>` +
    `<tr><td class="em-pad em-head" style="padding:22px 32px 18px;background:#ffffff;border-bottom:1px solid ${BORDER}">${header}</td></tr>` +
    `<tr><td class="em-pad" style="padding:28px 32px 12px">` +
    (email.eyebrow ? `<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${primary}">${esc(email.eyebrow)}</p>` : "") +
    `<h1 class="em-text" style="margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:700;color:#111827">${esc(email.heading)}</h1>` +
    body + `<!--email-note-->` + sign +
    `</td></tr>` +
    `<tr><td class="em-pad em-foot em-muted" style="padding:20px 32px 24px;background:${SOFT};border-top:1px solid ${BORDER};font-size:12px;line-height:1.6;color:${MUTED}">${footerHtml(branding, link, email.footerNote)}</td></tr>` +
    `</table><!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`;
}

// ------------------------------------------------------------------------------------------------------------------------ text -> layout
const URL_ONLY = /^(https?:\/\/[^\s<>"']+)$/i;
const LABELLED_URL = /^(.*[.!?]\s+)?([^.!?:]{2,70}?)\s*(\(([^)]{1,60})\))?\s*:\s*(https?:\/\/[^\s<>"']+)\s*$/i;
const DETAIL = /^([A-Z][A-Za-z0-9 /&()'.,-]{0,38}):\s+(\S.{0,500})$/;
const BULLET = /^\s*(?:[-*•])\s+(.+)$/;
const GREETING = /^(hello|hi|dear)\b/i;

/** A button label for a link whose own words are too long to be one (the words stay above it as text). */
function guessLabel(context: string, url: string): string {
  const c = `${context} ${url}`.toLowerCase();
  if (/accept-invite|set your password|choose (a|your) password/.test(c) && !/sign in to your staff|use your personal link to sign in/.test(c)) return "Set your password";
  if (/sign in|sign-in/.test(c) && !/no sign-in|sign-in (is )?(needed|required)/.test(c)) return "Sign in";
  if (/\/sign#|\bsign\b|signing/.test(c)) return "Review and sign";
  if (/\bpay\b|deposit/.test(c)) return "Pay now";
  if (/upload/.test(c)) return "Upload documents";
  if (/document|details/.test(c)) return "Add your details and documents";
  if (/ticket/.test(c)) return "View ticket";
  if (/whatsapp|group/.test(c)) return "Join the group";
  if (/application/.test(c)) return "Open the application";
  if (/offer/.test(c)) return "Open your offer";
  return "Open link";
}
const LABEL_MAX = 34;
const capital = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;

/** True when a paragraph is only the plain-text sign-off (the institution and / or "This is an automated message."). */
function isSignOff(lines: string[], names: string[]): boolean {
  const known = new Set(names.map((n) => n.toLowerCase().trim()).filter(Boolean));
  return lines.length > 0 && lines.every((line) => {
    const l = line.trim().toLowerCase();
    return known.has(l) || l === "this is an automated message." || l === "this is an automated message" || l === "skyline" || l === "the skyline team";
  });
}

export interface TextEmailOptions { heading?: string | null; eyebrow?: string | null; signOff?: boolean | string | null; footerNote?: string | null; preheader?: string | null; branding?: EmailBranding }

/** Splits a plain-text email into layout blocks, keeping every word (only the plain-text sign-off becomes the signature). */
export function textEmailBlocks(text: string, branding: EmailBranding = current): { blocks: EmailBlock[]; greeting: boolean; signedOff: boolean } {
  const paragraphs = String(text ?? "").replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n+/).map((p) => p.split("\n").map((l) => l.replace(/\s+$/, ""))).filter((p) => p.some((l) => l.trim()));
  let signedOff = false;
  const names = [branding.name, branding.legalName, DEFAULT_EMAIL_BRANDING.name, "Skyline Institute Of Technology"];
  if (paragraphs.length > 1 && isSignOff(paragraphs[paragraphs.length - 1], names)) { paragraphs.pop(); signedOff = true; }
  const blocks: EmailBlock[] = [];
  const greeting = paragraphs.length > 0 && GREETING.test(paragraphs[0][0]?.trim() ?? "");
  let lastText = "";
  for (const lines of paragraphs) {
    const trimmed = lines.map((l) => l.trim()).filter(Boolean);
    // A list: every line is a bullet (indented continuation lines are joined to the item before).
    if (trimmed.length && BULLET.test(trimmed[0]) && trimmed.every((l) => BULLET.test(l))) { blocks.push({ type: "list", items: trimmed.map((l) => BULLET.exec(l)![1]) }); continue; }
    // "Some heading:" then bullets: the heading line, then the list.
    if (trimmed.length >= 2 && /:$/.test(trimmed[0]) && !BULLET.test(trimmed[0]) && trimmed.slice(1).every((l) => BULLET.test(l))) {
      blocks.push({ type: "p", text: trimmed[0] }, { type: "list", items: trimmed.slice(1).map((l) => BULLET.exec(l)![1]) });
      continue;
    }
    // A detail block: two or more "Label: value" lines, none of them a link.
    if (trimmed.length >= 2 && trimmed.every((l) => DETAIL.test(l) && !/https?:\/\//i.test(l))) {
      blocks.push({ type: "details", rows: trimmed.map((l) => { const m = DETAIL.exec(l)!; return { label: m[1], value: m[2].trim() }; }) });
      continue;
    }
    // "Message from the sender:" / "Message from admissions:" / "Reason given: ..." followed by free text: a note box.
    if (trimmed.length >= 2 && /^(message from [^:]{1,60}|note|notes|reason given|comments?):$/i.test(trimmed[0])) {
      blocks.push({ type: "note", title: trimmed[0].replace(/:$/, ""), text: trimmed.slice(1).join("\n") });
      continue;
    }
    // Lines: links become buttons where they are labelled; the rest stays text.
    let buffer: string[] = [];
    const flush = () => { if (buffer.length) { blocks.push({ type: "p", text: buffer.join("\n") }); lastText = buffer.join(" "); buffer = []; } };
    for (let i = 0; i < trimmed.length; i++) {
      const line = trimmed[i];
      const only = URL_ONLY.exec(line);
      if (only && safeEmailUrl(only[1])) {
        const previous = buffer[buffer.length - 1];
        if (previous && /:$/.test(previous) && previous.length <= LABEL_MAX + 1 && !/[.!?]\s/.test(previous)) {
          buffer.pop(); flush();
          blocks.push({ type: "button", label: capital(previous.replace(/:$/, "").trim()), url: only[1] });
        } else {
          flush();
          blocks.push({ type: "button", label: guessLabel(previous ?? lastText, only[1]), url: only[1] });
        }
        continue;
      }
      const labelled = LABELLED_URL.exec(line);
      if (labelled && safeEmailUrl(labelled[5]) && !/https?:\/\//i.test(labelled[2])) {
        if (labelled[1]?.trim()) buffer.push(labelled[1].trim());
        const words = labelled[2].trim();
        // A label too long for a button stays as text above it, and the button gets a short label.
        if (words.length > LABEL_MAX) buffer.push(`${words}${labelled[3] ? ` ${labelled[3]}` : ""}:`);
        flush();
        blocks.push({ type: "button", label: words.length > LABEL_MAX ? guessLabel(words, labelled[5]) : capital(words), url: labelled[5],
          note: words.length <= LABEL_MAX && labelled[4] ? capital(labelled[4].trim()) : null });
        continue;
      }
      buffer.push(line);
    }
    flush();
  }
  return { blocks, greeting, signedOff };
}

/** A plain-text email in the branded layout (the text itself stays the plain-text part of the email). */
export function textEmailHtml(subject: string, text: string, options: TextEmailOptions = {}): string {
  const branding = options.branding ?? current;
  const { blocks, greeting, signedOff } = textEmailBlocks(text, branding);
  return brandedEmailHtml({
    heading: (options.heading ?? subject ?? "").trim() || branding.name, eyebrow: options.eyebrow ?? null, blocks,
    signOff: options.signOff !== undefined ? options.signOff : (greeting || signedOff ? true : null),
    footerNote: options.footerNote ?? null, preheader: options.preheader ?? null,
  }, branding);
}

/** An HRMS template body (already sanitised HTML) in the branded layout. */
export function htmlEmailDocument(bodyHtml: string, options: { heading?: string | null; preheader?: string | null; branding?: EmailBranding } = {}): string {
  const branding = options.branding ?? current;
  const heading = (options.heading ?? "").trim();
  const plain = bodyHtml.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return brandedEmailHtml({ heading: heading || branding.name, preheader: options.preheader ?? plain.slice(0, 140), blocks: [{ type: "html", html: bodyHtml }], signOff: null }, branding);
}

// ------------------------------------------------------------------------------------------------------------------------ compact API
// The earlier compact email (offer letter, signing code, CoE / VoE, account emails), now drawn in the branded layout.
export interface SimpleEmail {
  /** Earlier: the small line above the heading (the institution); the branding names the institution now. */
  brand: string;
  heading: string;
  /** Paragraphs of plain text; a blank line inside one keeps its line breaks. */
  paragraphs: string[];
  button?: { label: string; url: string } | null;
  /** Small print under the button (link validity, "do not forward"). */
  note?: string | null;
  /** A large monospaced value (a one-time code). */
  code?: string | null;
  footer?: string | null;
  primary?: string | null;
  /** Optional rows shown as a detail table under the paragraphs. */
  details?: Array<{ label: string; value: string }> | null;
  eyebrow?: string | null;
  /** Accepted for older callers; the branded layout uses the Website settings logo. */
  logo?: { url: string; alt: string };
}

export function simpleEmailHtml(email: SimpleEmail): string {
  const blocks: EmailBlock[] = email.paragraphs.filter((p) => p.trim()).map((text) => ({ type: "p" as const, text }));
  if (email.details?.length) blocks.push({ type: "details", rows: email.details });
  if (email.code) blocks.push({ type: "code", code: email.code });
  if (email.button) blocks.push({ type: "button", label: email.button.label, url: email.button.url });
  if (email.note) blocks.push({ type: "p", text: email.note, muted: true });
  const footer = (email.footer ?? "").trim();
  const greeting = GREETING.test(email.paragraphs[0]?.trim() ?? "");
  return brandedEmailHtml({ heading: email.heading, eyebrow: email.eyebrow ?? null, blocks, signOff: greeting ? true : null, primary: email.primary ?? null,
    footerNote: footer && !/^this is an automated message\.?$/i.test(footer) ? footer : null });
}
