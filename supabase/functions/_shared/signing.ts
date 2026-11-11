import { escapeHtml } from "./hr-template.ts";


/** The agreement a signer accepts. The database compares the exact text (public.signing_service), so the two change together. */
export const SIGNING_CONSENT = "I have read this document and agree to its contents. I consent to sign it electronically and adopt the signature I provide here as my electronic signature.";
// A variable is a plain name ({{salary}}) or a record and a field ({{student.first_name}}, {{course.fees}}, {{current_date}}).
const TOKEN = /\{\{\s*([a-z][a-z0-9_]{0,39}(?:\.[a-z][a-z0-9_]{0,39})?)\s*\}\}/g;
export function signingVariables(source: string): string[] {
  const keys = [...new Set([...source.matchAll(TOKEN)].map((m) => m[1]))];
  if (/\{\{|\}\}/.test(source.replace(TOKEN, ""))) throw new Error("Use variables like {{full_name}} or {{student.first_name}}: lowercase letters, numbers and underscores.");
  if (keys.length > 40) throw new Error("Use no more than 40 variables.");
  return keys;
}
/** Plain text templates: substitution happens once, values never become markup or new variables. */
export function fillSigningTemplate(source: string, values: Record<string, unknown>): string {
  if (!source.trim() || source.length > 40000) throw new Error("Enter document text up to 40,000 characters.");
  const keys = signingVariables(source);
  for (const key of keys) {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new Error(`Enter a value for {{${key}}} (up to 2,000 characters).`);
  }
  return source.replace(TOKEN, (_, key: string) => String(values[key]).trim());
}
export const signingHtml = (text: string) => text.split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
export const signingNameValid = (value: unknown): value is string => typeof value === "string" && value.trim().length >= 2 && value.trim().length <= 150 && !/[\x00-\x1f\x7f]/.test(value);

// ---------------------------------------------------------------------------------------------------------------- second stage (SIGN-02)
export const SIGN_FIELD_TYPES = ["signature", "initials", "date", "name", "text", "checkbox"] as const;
export type SignFieldType = typeof SIGN_FIELD_TYPES[number];
export const SIGN_CATEGORIES: Record<string, { label: string; audience: "student" | "employee" | "agent" | "any" }> = {
  enrolment_agreement: { label: "Enrolment agreement", audience: "student" }, consent_form: { label: "Consent form", audience: "student" },
  fee_agreement: { label: "Fee agreement", audience: "student" }, employment_contract: { label: "Employment contract", audience: "employee" },
  offer_letter: { label: "Offer letter", audience: "employee" }, hr_declaration: { label: "HR declaration", audience: "employee" },
  agency_agreement: { label: "Agency agreement", audience: "agent" }, commission_agreement: { label: "Commission agreement", audience: "agent" },
  other: { label: "Other document", audience: "any" },
};
/** The variables each kind of record fills by itself (hr.sign_subject); anything else is typed by the administrator. */
export const SUBJECT_VARIABLES: Record<"student" | "employee" | "agent", string[]> = {
  student: ["student.first_name", "student.last_name", "student.full_name", "student.email", "student.phone", "student.address", "student.date_of_birth", "student.passport_number",
    "student.nationality", "course.name", "course.code", "course.fees", "course.duration", "course.cricos", "current_date"],
  employee: ["employee.name", "employee.first_name", "employee.last_name", "employee.email", "employee.phone", "employee.address", "employee.position", "employee.department",
    "employee.employment_type", "employee.start_date", "employee.work_location", "current_date"],
  agent: ["agent.name", "agent.email", "agent.phone", "agent.marn", "agency.name", "agency.abn", "agency.email", "agency.phone", "current_date"],
};
/** "12 November 2026" in Melbourne, the value of {{current_date}} when no record supplies it. */
export const signingToday = (now = new Date()) => new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "long", year: "numeric" }).format(now);
/** Every variable of a template: its title, its text and the values its sender-filled fields print. */
export function templateVariables(template: { title?: string | null; body?: string | null; fields?: Array<{ role?: string; value?: string }> | null }): string[] {
  const parts = [template.title ?? "", template.body ?? "", ...(template.fields ?? []).filter((f) => f.role === "sender").map((f) => f.value ?? "")];
  return signingVariables(parts.join("\n"));
}
/** Fills what can be filled and shows the rest as [name]: for a preview and for placing fields before a real person is chosen. */
export function sampleFill(source: string, values: Record<string, unknown>): string {
  signingVariables(source);
  return source.replace(TOKEN, (_, key: string) => {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    return typeof value === "string" && value.trim() ? value.trim() : `[${key}]`;
  });
}
/**
 * Rich (HTML) templates, one table since 20261113170000: fills the variables that have a value, escaped so a value never becomes
 * markup; a variable with no value is left in place when `leave(key)` says the HRMS renderer owns it (its own placeholders, with
 * formatting and optional lines), otherwise refused, or shown as [name] in a sample.
 */
export function fillHtmlVariables(source: string, values: Record<string, unknown>, options: { sample?: boolean; leave?: (key: string) => boolean } = {}): string {
  if (source.length > 200000) throw new Error("Keep the document under 200,000 characters.");
  const has = (key: string) => { const value = Object.hasOwn(values, key) ? values[key] : undefined; return typeof value === "string" && value.trim() !== "" && value.length <= 2000 ? value.trim() : null; };
  for (const key of signingVariables(source)) {
    if (has(key) === null && !options.sample && !options.leave?.(key)) throw new Error(`Enter a value for {{${key}}} (up to 2,000 characters).`);
  }
  return source.replace(TOKEN, (whole, key: string) => {
    const value = has(key);
    if (value !== null) return escapeHtml(value).replace(/\r?\n/g, "<br>");
    return options.leave?.(key) ? whole : `[${key}]`;
  });
}
export const signingEmailValid = (value: unknown): value is string => typeof value === "string" && value.length <= 254 && /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(value);
export const initialsOf = (name: string) => name.trim().split(/\s+/).map((part) => part[0] ?? "").join("").toUpperCase().slice(0, 4);

export interface SignRecipientInput { name: string; email: string; role: string; label: string; order: number; required: boolean }
/** The recipients of a new request, checked: 1 to 10, a name and an email each, no email twice, at least one required. */
export function checkRecipients(input: unknown): SignRecipientInput[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) throw new Error("Add between 1 and 10 recipients.");
  const seen = new Set<string>(), roles = new Set<string>();
  const out = input.map((raw, index) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = String(r.name ?? "").trim(), email = String(r.email ?? "").trim().toLowerCase();
    if (!signingNameValid(name) || !signingEmailValid(email)) throw new Error(`Enter the full name and email of recipient ${index + 1}.`);
    if (seen.has(email)) throw new Error(`${email} is listed twice. Each recipient needs their own email address.`);
    seen.add(email);
    const role = /^[a-z][a-z0-9_]{0,39}$/.test(String(r.role ?? "")) ? String(r.role) : `signer${index + 1}`;
    if (roles.has(role)) throw new Error("Each signer role can be given to one recipient only.");
    roles.add(role);
    const order = Number.isInteger(r.order) && Number(r.order) >= 1 && Number(r.order) <= 50 ? Number(r.order) : index + 1;
    return { name, email, role, label: String(r.label ?? "").trim().slice(0, 80) || `Signer ${index + 1}`, order, required: r.required !== false };
  });
  if (!out.some((r) => r.required)) throw new Error("At least one recipient must be required.");
  return out;
}

export type SigningMailKind = "invite" | "reminder" | "expired" | "declined" | "voided" | "completed";
export interface SigningMailJob { kind: SigningMailKind; audience: "recipient" | "admin"; title: string; reference: string; name?: string | null; role?: string | null; message?: string | null;
  expires_at?: string | null; reason?: string | null; declined_by?: string | null; signers?: Array<{ name: string; role: string; state: string }> | null }
const mailLine = (value: unknown, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); // eslint-disable-line no-control-regex
const MAIL_SIGN_OFF = "\n\nSkyline Institute of Technology\nThis is an automated message.";
/** Plain-text signing emails. Only an invitation or a reminder carries the personal link; nothing else contains a URL. */
export function renderSigningEmail(job: SigningMailJob, link: string | null): { subject: string; text: string } | null {
  const title = mailLine(job.title), ref = mailLine(job.reference, 40), hello = `Hello ${mailLine(job.name, 80) || "there"},`;
  const until = job.expires_at ? new Date(job.expires_at).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, "") : "";
  const note = job.message ? `\n\nMessage from the sender:\n${String(job.message).slice(0, 2000)}` : "";
  const people = (job.signers ?? []).map((s) => `- ${mailLine(s.name, 80)} (${mailLine(s.role, 80)}): ${s.state === "signed" ? "signed" : s.state === "declined" ? "declined" : s.state === "skipped" ? "not required" : "waiting"}`).join("\n");
  if (job.kind === "invite" || job.kind === "reminder") {
    if (!link) return null;
    const lead = job.kind === "invite" ? `You have been asked to review and sign "${title}"${job.role ? ` as ${mailLine(job.role, 80)}` : ""}.` : `This is a reminder that "${title}" is still waiting for your signature.`;
    return { subject: mailLine(`${job.kind === "invite" ? "Please sign" : "Reminder to sign"}: ${title}`),
      text: `${hello}\n\n${lead}${note}\n\nOpen your personal signing link:\n${link}\n\n${until ? `The link works until ${until}. ` : ""}It is personal: please do not forward it. Reference ${ref}.${MAIL_SIGN_OFF}` };
  }
  if (job.kind === "completed") return job.audience === "admin"
    ? { subject: mailLine(`Completed: ${title}`), text: `Everyone required has signed "${title}" (reference ${ref}). The signed document and its completion certificate are attached.\n\n${people}${MAIL_SIGN_OFF}` }
    : { subject: mailLine(`Signed copy: ${title}`), text: `${hello}\n\n"${title}" is complete: everyone required has signed. The signed document and its completion certificate are attached for your records. Reference ${ref}.${MAIL_SIGN_OFF}` };
  if (job.kind === "declined") return job.audience === "admin"
    ? { subject: mailLine(`Declined: ${title}`), text: `${mailLine(job.declined_by, 80) || "A recipient"} declined to sign "${title}" (reference ${ref}).${job.reason ? `\n\nReason given: ${mailLine(job.reason, 500)}` : ""}\n\nThe request is closed and its links no longer work.${MAIL_SIGN_OFF}` }
    : { subject: mailLine(`Signing cancelled: ${title}`), text: `${hello}\n\n"${title}" (reference ${ref}) will not be completed because another recipient declined to sign. Your signature on it has no effect. The sender will contact you if a new document is needed.${MAIL_SIGN_OFF}` };
  if (job.kind === "expired") return job.audience === "admin"
    ? { subject: mailLine(`Expired: ${title}`), text: `"${title}" (reference ${ref}) expired before everyone signed. Its links no longer work.\n\n${people}${MAIL_SIGN_OFF}` }
    : { subject: mailLine(`Signing link expired: ${title}`), text: `${hello}\n\nThe time to sign "${title}" (reference ${ref}) has passed and your link no longer works. Please contact the sender if you still need to sign it.${MAIL_SIGN_OFF}` };
  if (job.kind === "voided") return { subject: mailLine(`Signing request cancelled: ${title}`),
    text: `${hello}\n\nThe request to sign "${title}" (reference ${ref}) was cancelled by the sender and your link no longer works. You do not need to do anything.${MAIL_SIGN_OFF}` };
  return null;
}

/**
 * The text of a Word document (word/document.xml): one line per paragraph, a blank line between paragraphs, tabs and line breaks kept.
 * Runs are joined first, so a {{variable}} that Word split across runs is whole again. Formatting is not kept: the text becomes a template.
 */
export function docxXmlToText(xml: string): string {
  if (/<!DOCTYPE/i.test(xml)) throw new Error("This Word document could not be read.");
  const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
  const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)].map((m) =>
    [...m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)(?:\s[^>]*)?\/>/g)].map((part) => part[2] ? (part[2] === "tab" ? "\t" : "\n") : decode(part[1])).join("").trimEnd());
  // eslint-disable-next-line no-control-regex -- control characters never belong in a template
  const text = paragraphs.join("\n\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("No text was found in this Word document.");
  if (text.length > 40000) throw new Error("This Word document is longer than a template allows (40,000 characters).");
  return text;
}
