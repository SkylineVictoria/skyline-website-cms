// A plain, compact HTML email (offer letter, signing code, CoE / VoE): one column, system fonts, one primary button. Everything that
// comes from data is escaped; links must be https (or http for a local stack) and are written once, as given. No images, no tracking.

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const safeUrl = (url: string) => (/^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null);

export interface SimpleEmail {
  /** Small line above the heading (the institution). */
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
}

export function simpleEmailHtml(email: SimpleEmail): string {
  const primary = /^#[0-9a-f]{6}$/i.test(email.primary ?? "") ? email.primary! : "#1d4ed8";
  const para = (text: string, style = "margin:0 0 14px;font-size:15px;line-height:1.5;color:#1f2937") =>
    `<p style="${style}">${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  const url = email.button ? safeUrl(email.button.url) : null;
  const button = email.button && url
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:22px 0"><tr><td style="border-radius:8px;background:${primary}">` +
      `<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(email.button.label)}</a>` +
      `</td></tr></table>` + para(`If the button does not work, copy this link into your browser:\n${url}`, "margin:0 0 14px;font-size:12px;line-height:1.5;color:#6b7280;word-break:break-all")
    : "";
  const code = email.code ? `<p style="margin:18px 0;font-family:Consolas,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:#111827">${escapeHtml(email.code)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(email.heading)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb">` +
    `<tr><td style="padding:24px 26px">` +
    para(email.brand, `margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:${primary}`) +
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827">${escapeHtml(email.heading)}</h1>` +
    email.paragraphs.filter((p) => p.trim()).map((p) => para(p)).join("") + code + button +
    (email.note ? para(email.note, "margin:0 0 6px;font-size:13px;line-height:1.5;color:#4b5563") : "") +
    `</td></tr></table>` +
    (email.footer ? para(email.footer, "margin:14px 0 0;font-size:12px;line-height:1.5;color:#9ca3af") : "") +
    `</td></tr></table></body></html>`;
}
