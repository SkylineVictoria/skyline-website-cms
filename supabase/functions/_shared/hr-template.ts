// HRMS > Templates: the placeholder catalogue, HTML sanitising and rendering (HTML, plain text, and blocks for the offer PDF).
// Pure and runtime-neutral: the admin pages (preview), the Edge Functions (sending) and the offline tests run the same code, so
// what an Admin previews is what is sent. No DOM is used: templates are parsed with a small tokenizer and rebuilt from an
// allow-list, so nothing an editor pastes (scripts, event handlers, styles, frames) survives.

export type TemplateType = "offer_letter" | "offer_email" | "document_request" | "document_reupload" | "welcome_login" | "rejection";
export const TEMPLATE_TYPES: ReadonlyArray<{ type: TemplateType; label: string; kind: "letter" | "email"; description: string; requires: readonly string[] }> = [
  { type: "offer_letter", label: "Offer letter", kind: "letter", description: "The letter itself. It is saved as a PDF against the employee and signed on the page.", requires: [] },
  { type: "offer_email", label: "Offer email", kind: "email", description: "The email that tells the person their offer is ready, with their sign-in link.", requires: ["signing_link"] },
  { type: "document_request", label: "Document request email", kind: "email", description: "Sent with the private link to add details and documents.", requires: ["document_link"] },
  { type: "document_reupload", label: "Document re-upload email", kind: "email", description: "Sent when a document is rejected, with the reasons and a link to upload it again.", requires: ["document_link"] },
  { type: "welcome_login", label: "Welcome / login email", kind: "email", description: "Sent when a new sign-in link is needed (Resend login).", requires: ["signing_link"] },
  { type: "rejection", label: "Rejection email", kind: "email", description: "Sent when an application is rejected or withdrawn and the email box is ticked.", requires: [] },
];
export const TEMPLATE_TYPE_LABEL = Object.fromEntries(TEMPLATE_TYPES.map((t) => [t.type, t.label])) as Record<TemplateType, string>;
export const isTemplateType = (value: unknown): value is TemplateType => TEMPLATE_TYPES.some((t) => t.type === value);

export interface PlaceholderSpec { key: string; label: string; sample: string; group: "Person" | "Job and pay" | "Company" | "Links"; only?: readonly TemplateType[] }
/** Every placeholder an Admin can insert. `only` limits a link placeholder to the emails that carry that link. */
export const PLACEHOLDERS: readonly PlaceholderSpec[] = [
  { key: "first_name", label: "First name", sample: "Asha", group: "Person" },
  { key: "last_name", label: "Last name", sample: "Patel", group: "Person" },
  { key: "full_name", label: "Full name", sample: "Asha Patel", group: "Person" },
  { key: "email", label: "Email address", sample: "asha.patel@example.com", group: "Person" },
  { key: "position", label: "Position", sample: "Trainer (Commercial Cookery)", group: "Job and pay" },
  { key: "department", label: "Department", sample: "Training", group: "Job and pay" },
  { key: "employment_type", label: "Employment type", sample: "Full time", group: "Job and pay" },
  { key: "start_date", label: "Start date", sample: "2 February 2027", group: "Job and pay" },
  { key: "pay_rate", label: "Pay rate", sample: "$42.50", group: "Job and pay" },
  { key: "pay_basis", label: "Pay basis", sample: "per hour", group: "Job and pay" },
  { key: "pay_schedule", label: "Pay schedule", sample: "Fortnightly", group: "Job and pay" },
  { key: "hours_per_week", label: "Hours per week", sample: "38", group: "Job and pay" },
  { key: "manager_name", label: "Reporting manager", sample: "Jordan Lee", group: "Job and pay" },
  { key: "work_location", label: "Work location", sample: "Melbourne", group: "Job and pay" },
  { key: "company_name", label: "Company name", sample: "Skyline Institute of Technology", group: "Company" },
  { key: "today", label: "Today's date", sample: "10 November 2026", group: "Company" },
  { key: "signing_link", label: "Offer sign-in link", sample: "https://example.com/staff/welcome", group: "Links", only: ["offer_email", "welcome_login"] },
  { key: "login_url", label: "Login page", sample: "https://example.com/login", group: "Links" },
  { key: "document_link", label: "Document upload link", sample: "https://example.com/staff/onboard", group: "Links", only: ["document_request", "document_reupload"] },
  { key: "link_expiry", label: "Link expiry date", sample: "24 November 2026", group: "Links", only: ["offer_email", "welcome_login", "document_request", "document_reupload"] },
  { key: "rejected_documents", label: "Rejected documents and reasons", sample: "Passport: the photo page is cut off", group: "Links", only: ["document_reupload"] },
];
const PLACEHOLDER_KEYS = new Set(PLACEHOLDERS.map((p) => p.key));
export const placeholdersFor = (type: TemplateType): PlaceholderSpec[] => PLACEHOLDERS.filter((p) => !p.only || p.only.includes(type));
/** Values that may legitimately be empty for a person (the template still renders; the gap is simply left out). */
export const OPTIONAL_PLACEHOLDERS: ReadonlySet<string> = new Set(["department", "manager_name", "work_location", "hours_per_week", "last_name"]);
export const sampleValues = (): Record<string, string> => Object.fromEntries(PLACEHOLDERS.map((p) => [p.key, p.sample]));

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
/** The placeholder keys a text uses, in order of first use. */
export function templatePlaceholders(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(TOKEN)) { const key = match[1].toLowerCase(); if (!seen.includes(key)) seen.push(key); }
  return seen;
}

/* ------------------------------------------------------------------ sanitising */

const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote"]);
const INLINE_TAGS = new Set(["strong", "em", "u", "s", "a"]);
const VOID_TAGS = new Set(["br", "hr"]);
/** Tags renamed to the one this module keeps. */
const RENAME: Record<string, string> = { b: "strong", i: "em", strike: "s", del: "s", div: "p", h5: "h4", h6: "h4" };
/** Elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "title", "head", "form", "textarea", "select", "button"]);
const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</gi;

export const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•", copy: "©" };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function attribute(raw: string, name: string): string | null {
  const match = raw.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}
/** A link target: http(s), mailto, or a single link placeholder. Anything else (javascript:, data:, relative) is dropped. */
function safeHref(value: string | null): string | null {
  const href = (value ?? "").trim();
  if (/^\{\{\s*[a-zA-Z0-9_]+\s*\}\}$/.test(href)) return href;
  // eslint-disable-next-line no-control-regex -- control characters are never valid in a link
  if (/^(https?:\/\/|mailto:)[^\s<>"'\u0000-\u001f]+$/i.test(href) && href.length <= 2000) return href;
  return null;
}
function alignOf(raw: string): string | null {
  const style = attribute(raw, "style") ?? "";
  const match = style.match(/text-align\s*:\s*(left|center|right|justify)/i) ?? (attribute(raw, "align") ?? "").match(/^(left|center|right|justify)$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Rebuilds the HTML from an allow-list: paragraphs, headings, lists, quotes, bold / italic / underline / strike, links, line
 * breaks and rules, with text alignment as the only style. Unknown tags are removed (their text stays); scripts, styles, frames
 * and forms go with their content. The result is well formed (every opened tag is closed).
 */
export function sanitizeTemplateHtml(html: string): string {
  let out = "";
  const open: string[] = [];
  // Styled spans (what some editors and pasted text use for bold / italic / underline) become the matching tags.
  const spans: string[][] = [];
  let skipping: string | null = null;
  const close = (tag: string) => {
    const at = open.lastIndexOf(tag);
    if (at < 0) return;
    while (open.length > at) out += `</${open.pop()}>`;
  };
  for (const match of String(html ?? "").matchAll(TAG)) {
    const token = match[0];
    const rawName = match[1]?.toLowerCase();
    if (!rawName) {
      if (skipping || token.startsWith("<!")) continue;
      out += token === "<" ? "&lt;" : token.replace(/>/g, "&gt;");
      continue;
    }
    const closing = token[1] === "/";
    if (skipping) { if (closing && rawName === skipping) skipping = null; continue; }
    if (DROP_WITH_CONTENT.has(rawName)) { if (!closing && !/\/\s*>$/.test(token)) skipping = rawName; continue; }
    const name = RENAME[rawName] ?? rawName;
    if (name === "span" || name === "font") {
      if (closing) { for (const tag of (spans.pop() ?? []).reverse()) close(tag); continue; }
      const style = attribute(match[2] ?? "", "style") ?? "";
      const tags: string[] = [];
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) tags.push("strong");
      if (/font-style\s*:\s*italic/i.test(style)) tags.push("em");
      if (/text-decoration[^;]*underline/i.test(style)) tags.push("u");
      if (/text-decoration[^;]*line-through/i.test(style)) tags.push("s");
      for (const tag of tags) { out += `<${tag}>`; open.push(tag); }
      spans.push(tags);
      continue;
    }
    if (VOID_TAGS.has(name)) { if (!closing) { if (name === "hr") while (open.length) out += `</${open.pop()}>`; out += `<${name}>`; } continue; }
    if (!BLOCK_TAGS.has(name) && !INLINE_TAGS.has(name)) continue;
    if (closing) { close(name); continue; }
    if (name === "a") {
      const href = safeHref(attribute(match[2] ?? "", "href"));
      if (!href) continue;
      close("a");
      out += `<a href="${escapeHtml(href)}">`;
      open.push("a");
      continue;
    }
    if (name === "li" && open.lastIndexOf("li") > Math.max(open.lastIndexOf("ul"), open.lastIndexOf("ol"))) close("li");
    if (BLOCK_TAGS.has(name) && name !== "li" && name !== "ul" && name !== "ol") {
      // A paragraph or heading never nests inside another one (pasted <div><div>): the earlier one ends here.
      for (const tag of ["p", "h1", "h2", "h3", "h4"]) close(tag);
    }
    const align = BLOCK_TAGS.has(name) && name !== "ul" && name !== "ol" ? alignOf(match[2] ?? "") : null;
    out += align && align !== "left" ? `<${name} style="text-align:${align}">` : `<${name}>`;
    open.push(name);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out.replace(/<p>\s*<\/p>/g, "").trim();
}

/* ------------------------------------------------------------------ rendering */

export interface RenderedTemplate { html: string; missing: string[]; unknown: string[] }
// Marks left by a fill and removed again before the result is returned (they can never be typed into a template or a value).
const EMPTY_MARK = "\u0001";
const FILLED_MARK = "\u0002";
const LEAF_BLOCK = /<(li|p)\b[^>]*>(?:(?!<\/?(?:li|p|ul|ol|h[1-4]|blockquote)\b)[\s\S])*?<\/\1>/g;
/**
 * Fills the placeholders of sanitised HTML (or a plain subject line when `plain` is set). A value is escaped; line breaks in a
 * value become <br>. `missing` lists the placeholders with no value (optional ones are simply left empty); `unknown` lists
 * placeholders that are not in the catalogue. A sender refuses to send while either list is non-empty.
 *
 * A line (a paragraph or a list item) whose only placeholders are optional details with no value, for example
 * "Reporting to: {{manager_name}}" for someone without a manager, is left out, so a letter never shows a bare label.
 */
export function renderTemplate(source: string, values: Record<string, string | null | undefined>, options: { plain?: boolean } = {}): RenderedTemplate {
  const missing: string[] = [];
  const unknown: string[] = [];
  const html = source.replace(TOKEN, (_whole, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (!PLACEHOLDER_KEYS.has(key)) { if (!unknown.includes(key)) unknown.push(key); return options.plain ? `[${key}]` : `<strong>[${escapeHtml(key)}]</strong>`; }
    const value = String(values[key] ?? "").trim();
    if (!value) {
      if (OPTIONAL_PLACEHOLDERS.has(key)) return options.plain ? "" : EMPTY_MARK;
      if (!missing.includes(key)) missing.push(key);
      return options.plain ? `[${key}]` : `<strong>[${escapeHtml(key)}]</strong>`;
    }
    // eslint-disable-next-line no-control-regex -- a subject line never carries control characters
    return options.plain ? value.replace(/[\u0000-\u001f\u007f]+/g, " ") : FILLED_MARK + escapeHtml(value).replace(/\r?\n/g, "<br>");
  });
  if (options.plain) return { html, missing, unknown };
  // Leave out the lines that hold nothing but an empty optional detail, then any list left empty, then the marks.
  const cleaned = html.replace(LEAF_BLOCK, (block) => (block.includes(EMPTY_MARK) && !block.includes(FILLED_MARK) && !/<strong>\[/.test(block) ? "" : block))
    .replace(/<(ul|ol)>\s*<\/\1>/g, "").split(EMPTY_MARK).join("").split(FILLED_MARK).join("");
  return { html: cleaned, missing, unknown };
}

/** Readable names for a list of placeholder keys, for error messages. */
export const placeholderLabels = (keys: readonly string[]): string => keys.map((k) => PLACEHOLDERS.find((p) => p.key === k)?.label ?? `{{${k}}}`).join(", ");

export interface TemplateBlock { type: "p" | "h1" | "h2" | "h3" | "h4" | "li" | "quote" | "hr"; align: "left" | "center" | "right" | "justify"; runs: TemplateRun[]; marker?: string; depth?: number }
export interface TemplateRun { text: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean; href?: string }

/** Sanitised HTML as a flat list of blocks with styled text runs (the offer PDF and the plain-text email are built from this). */
export function templateBlocks(html: string): TemplateBlock[] {
  const blocks: TemplateBlock[] = [];
  const state: { current: TemplateBlock | null } = { current: null };
  const style = { bold: 0, italic: 0, underline: 0, strike: 0 };
  let href: string | undefined;
  const lists: Array<{ ordered: boolean; n: number }> = [];
  let quote = 0;
  const start = (type: TemplateBlock["type"], align: TemplateBlock["align"] = "left", marker?: string): TemplateBlock => {
    const block: TemplateBlock = { type, align, runs: [], ...(marker !== undefined ? { marker, depth: Math.max(0, lists.length - 1) } : {}) };
    state.current = block;
    blocks.push(block);
    return block;
  };
  const finish = () => { state.current = null; };
  const text = (value: string) => {
    if (!value) return;
    const block = state.current ?? start(quote ? "quote" : "p");
    block.runs.push({ text: value, bold: style.bold > 0 || /^h[1-4]$/.test(block.type), italic: style.italic > 0, underline: style.underline > 0 || href !== undefined, strike: style.strike > 0, ...(href ? { href } : {}) });
  };
  for (const match of sanitizeTemplateHtml(html).matchAll(TAG)) {
    const token = match[0];
    const name = match[1]?.toLowerCase();
    if (!name) { text(decodeEntities(token).replace(/\s+/g, " ")); continue; }
    const closing = token[1] === "/";
    const align = (alignOf(match[2] ?? "") ?? "left") as TemplateBlock["align"];
    switch (name) {
      case "p": case "h1": case "h2": case "h3": case "h4":
        if (closing) finish(); else if (!state.current || state.current.type !== "li") start(quote && name === "p" ? "quote" : name, align);
        break;
      case "blockquote": quote += closing ? -1 : 1; finish(); break;
      case "ul": case "ol": if (closing) lists.pop(); else lists.push({ ordered: name === "ol", n: 0 }); finish(); break;
      case "li": {
        if (closing) { finish(); break; }
        const list = lists[lists.length - 1] ?? { ordered: false, n: 0 };
        list.n += 1;
        start("li", align, list.ordered ? `${list.n}.` : "•");
        break;
      }
      case "br": text("\n"); break;
      case "hr": finish(); start("hr"); finish(); break;
      case "strong": style.bold += closing ? -1 : 1; break;
      case "em": style.italic += closing ? -1 : 1; break;
      case "u": style.underline += closing ? -1 : 1; break;
      case "s": style.strike += closing ? -1 : 1; break;
      case "a": href = closing ? undefined : attribute(match[2] ?? "", "href") ?? undefined; break;
    }
  }
  // Trim the white space around each block and drop blocks left empty.
  for (const block of blocks) {
    while (block.runs.length && !block.runs[0].text.trim()) block.runs.shift();
    while (block.runs.length && !block.runs[block.runs.length - 1].text.trim()) block.runs.pop();
    if (block.runs.length) { block.runs[0].text = block.runs[0].text.replace(/^[ \t]+/, ""); const last = block.runs[block.runs.length - 1]; last.text = last.text.replace(/[ \t]+$/, ""); }
  }
  return blocks.filter((b) => b.type === "hr" || b.runs.length > 0);
}

/** The plain-text version of a rendered email: one paragraph per block, list markers, and link targets in brackets. */
export function templateText(html: string): string {
  const lines: string[] = [];
  for (const block of templateBlocks(html)) {
    if (block.type === "hr") { lines.push("----------"); continue; }
    let line = "";
    for (const run of block.runs) line += run.href && run.href !== run.text.trim() && !run.text.includes(run.href) ? `${run.text} (${run.href})` : run.text;
    line = line.split("\n").map((part) => part.trim()).join("\n");
    lines.push(block.type === "li" ? `${"  ".repeat(block.depth ?? 0)}${block.marker === "•" ? "-" : block.marker} ${line}` : line);
  }
  const out: string[] = [];
  lines.forEach((line, index) => {
    const previous = lines[index - 1];
    // List items stay together; everything else is separated by a blank line.
    if (index > 0 && !(/^\s*(-|\d+\.) /.test(line) && /^\s*(-|\d+\.) /.test(previous ?? ""))) out.push("");
    out.push(line);
  });
  return out.join("\n").trim();
}

/** A rendered email body wrapped for mail clients (system font, readable width). */
export const emailHtmlDocument = (bodyHtml: string): string =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f8"><div style="max-width:640px;margin:0 auto;padding:28px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2933">${bodyHtml}</div></body></html>`;

/* ------------------------------------------------------------------ values */

/** What the database returns for a person (hr_admin_template_values / hr_svc_template_values): raw, unformatted. */
export interface TemplatePerson {
  firstName?: string | null; lastName?: string | null; fullName?: string | null; email?: string | null;
  position?: string | null; department?: string | null; employmentType?: string | null; startDate?: string | null;
  payRate?: number | string | null; payBasis?: string | null; paySchedule?: string | null; hoursPerWeek?: number | string | null;
  managerName?: string | null; workLocation?: string | null; companyName?: string | null; today?: string | null;
}
const EMPLOYMENT_TYPE: Record<string, string> = { full_time: "Full time", part_time: "Part time", casual: "Casual" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2027-02-02" (or an ISO timestamp) as "2 February 2027"; anything else is returned empty. */
export function longDate(value: string | null | undefined): string {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : "";
}
export function moneyText(value: number | string | null | undefined): string {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").trim() || NaN);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const [whole, cents] = amount.toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}
/** The placeholder values for a person. Link values (signing_link, document_link, link_expiry, …) are added by the sender. */
export function templateValues(person: TemplatePerson, links: Record<string, string> = {}): Record<string, string> {
  const hours = Number(person.hoursPerWeek);
  return {
    first_name: String(person.firstName ?? "").trim(),
    last_name: String(person.lastName ?? "").trim(),
    full_name: String(person.fullName ?? "").trim() || [person.firstName, person.lastName].filter(Boolean).join(" ").trim(),
    email: String(person.email ?? "").trim(),
    position: String(person.position ?? "").trim(),
    department: String(person.department ?? "").trim(),
    employment_type: EMPLOYMENT_TYPE[String(person.employmentType ?? "")] ?? "",
    start_date: longDate(person.startDate),
    pay_rate: moneyText(person.payRate),
    pay_basis: person.payBasis === "hourly" ? "per hour" : person.payBasis === "salary" ? "per year" : "",
    pay_schedule: String(person.paySchedule ?? "").trim(),
    hours_per_week: Number.isFinite(hours) && hours > 0 ? String(Number(hours.toFixed(2))) : "",
    manager_name: String(person.managerName ?? "").trim(),
    work_location: String(person.workLocation ?? "").trim(),
    company_name: String(person.companyName ?? "").trim() || "Skyline Institute of Technology",
    today: longDate(person.today) || longDate(new Date().toISOString()),
    ...links,
  };
}

export interface TemplateSource { subject: string; bodyHtml: string }
export interface RenderedMessage { subject: string; html: string; text: string; missing: string[]; unknown: string[] }
/** Subject and body of a template filled for one person: sanitised HTML, its plain text, and what could not be filled. */
export function renderMessage(template: TemplateSource, values: Record<string, string>): RenderedMessage {
  const subject = renderTemplate(template.subject, values, { plain: true });
  const body = renderTemplate(sanitizeTemplateHtml(template.bodyHtml), values);
  return {
    subject: subject.html.replace(/\s+/g, " ").trim().slice(0, 200), html: body.html, text: templateText(body.html),
    missing: [...new Set([...subject.missing, ...body.missing])], unknown: [...new Set([...subject.unknown, ...body.unknown])],
  };
}
