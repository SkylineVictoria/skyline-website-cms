import { imageFromBytes } from "./pdf-logo.ts";
import { formatPhone, normalizeUsi, PHONE_FIELDS, usiStatus } from "../validation/identifiers.ts";
import { EXPIRY_FIELDS, getDocumentExpiryStatus, type ExpiryDocument } from "../validation/document-expiry.ts";
import { PdfWriter, MAX_PDF_PAGES, type ImageData, type Para, type Row } from "./pdf-layout.ts";
import { conditionMet, NON_ANSWER_TYPES, type PdfField, type PdfSection } from "./pdf-form.ts";
import { PDF_FORM_SECTIONS } from "./pdf-form-layout.ts";
// Runtime-neutral (Deno Edge Function and browser) branded PDF of a submitted application. ONE builder serves the email attachment and the
// admin "Download PDF" / "Preview", so the two can never differ. The PDF exists only in memory: nothing here logs, stores or returns it elsewhere.

export { MAX_ATTACHMENT_BYTES, adminPdfFileName, attachmentFileName, toBase64 } from "./attachment.ts";
export { MAX_PDF_PAGES };

export const DEFAULT_PRIMARY_HEX = "#ea6619"; // the Skyline orange, used when a tenant colour is missing or invalid
export const DEFAULT_TIMEZONE = "Australia/Sydney";

/* ----------------------------------------------------------------- Branding */

const channelOf = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (rgb: readonly [number, number, number]) => 0.2126 * channelOf(rgb[0]) + 0.7152 * channelOf(rgb[1]) + 0.0722 * channelOf(rgb[2]);
/** WCAG contrast of a colour against white. */
export const contrastOnWhite = (rgb: readonly [number, number, number]) => 1.05 / (luminance(rgb) + 0.05);

function parseHex(raw: unknown): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(t) ? t.split("").map((c) => c + c).join("") : t;
  return /^[0-9a-f]{6}$/i.test(full) ? [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number] : null;
}
const toHex = (rgb: readonly number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

export interface ResolvedPrimary { hex: string; rgb: [number, number, number]; tint: [number, number, number]; fellBack: boolean; darkened: boolean }

/**
 * The accent for headings, rules, links and the table: the tenant colour when it is a valid hex, otherwise the default orange.
 * A colour that is too light to read on white (contrast under 4.5) is darkened step by step, keeping its hue. The tint is the label-cell background.
 */
export function resolvePrimary(raw: unknown): ResolvedPrimary {
  const parsed = parseHex(raw);
  let rgb = parsed ?? parseHex(DEFAULT_PRIMARY_HEX)!;
  let darkened = false;
  for (let i = 0; i < 40 && contrastOnWhite(rgb) < 4.5; i++) { rgb = rgb.map((v) => v * 0.93) as [number, number, number]; darkened = true; }
  const tint = rgb.map((v) => 255 - (255 - v) * 0.1) as [number, number, number];
  return { hex: toHex(rgb), rgb, tint, fellBack: !parsed, darkened };
}

/** DD/MM/YYYY HH:mm in the tenant's timezone (an unknown timezone falls back to Australia/Sydney). */
export function formatDateTime(value: string | Date | null | undefined, timezone: string = DEFAULT_TIMEZONE): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = (zone: string) => Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((p) => [p.type, p.value]));
  let p: Record<string, string>;
  try { p = parts(timezone); } catch { p = parts(DEFAULT_TIMEZONE); }
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** DD/MM/YYYY from a stored YYYY-MM-DD (or already day-first) date; anything else is returned as typed. */
export function formatDateOnly(value: unknown): string {
  const text = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(text);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  return dayFirst ? `${dayFirst[1].padStart(2, "0")}/${dayFirst[2].padStart(2, "0")}/${dayFirst[3]}` : text;
}

export { imageFromBytes, loadLogo, sniffUnembeddable, type LogoFormat, type LogoRasteriser } from "./pdf-logo.ts";

/* -------------------------------------------------------------------- Input */

export interface PdfBranding { primary?: string | null; logo?: ImageData | null; timezone?: string | null }
export interface PdfDocumentLink { category: string; fileName: string; url: string | null }
export interface SubmissionPdfInput {
  reference: string; institution: string; version: number; submittedAt: string | null; snapshot: unknown;
  /** The application form definition; defaults to the generated copy of the enrolment form. */
  sections?: PdfSection[];
  branding?: PdfBranding;
  /** Uploaded documents with a signed link each (null url = filename only). Undefined / empty: no documents section. */
  documents?: PdfDocumentLink[];
  /** Link to the application in the portal. */
  portalLink?: string;
  /** DD/MM/YYYY the signed document links stop working (email PDF only). */
  linksExpireOn?: string;
  /** Today, for the passport / visa / English notes. */
  now?: Date;
}

/* ------------------------------------------------------------------- Values */

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const humanize = (key: string) => { const s = key.replace(/[_-]+/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Scalars as text; arrays list their items; a map of booleans lists only the chosen keys. */
function formatValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(CONTROL, " ").trim().slice(0, 4000);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((v) => formatValue(v, depth + 1)).filter(Boolean).join(", ").slice(0, 4000);
  if (plain(value) && depth < 2) {
    const entries = Object.entries(value);
    if (entries.length && entries.every(([, v]) => typeof v === "boolean")) return entries.filter(([, v]) => v).map(([k]) => k).join(", ");
    return entries.map(([k, v]) => [humanize(k), formatValue(v, depth + 1)]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ").slice(0, 4000);
  }
  return "";
}
const list = (value: unknown): string[] => (Array.isArray(value) ? value : plain(value) ? Object.entries(value).filter(([, v]) => v === true).map(([k]) => k) : [value]).map((v) => formatValue(v)).filter(Boolean);
const TRUTHY = /^(true|yes|on|1|checked|agree|agreed)$/i;

const QUALIFICATION_PARTS = ["institution", "qualification", "program", "year", "result"] as const;
type QualificationParts = Record<typeof QUALIFICATION_PARTS[number], string>;

/**
 * Qualifications to print: the snapshot's list (file-linked and manual entries), plus the single
 * institution / qualification / year fields when the list does not already hold them.
 */
export function qualificationLines(snap: Record<string, unknown>, values: Record<string, unknown>): string[] {
  const part = (source: Record<string, unknown>, key: string, prefix: string) => formatValue(source[`${prefix}${key}`]);
  const read = (source: Record<string, unknown>, prefix: string) => Object.fromEntries(QUALIFICATION_PARTS.map((key) => [key, part(source, key, prefix)])) as QualificationParts;
  const listed = Array.isArray(snap.academicQualifications) ? snap.academicQualifications as Record<string, unknown>[] : [];
  const entries = listed.filter((entry) => entry && typeof entry === "object").map((entry) => {
    const fromKeys = read(entry, "");
    return QUALIFICATION_PARTS.some((key) => fromKeys[key]) ? fromKeys : read(entry, "academic_");
  }).filter((entry) => QUALIFICATION_PARTS.some((key) => entry[key]));
  const single = read(values, "academic_");
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (QUALIFICATION_PARTS.some((key) => single[key]) && !entries.some((e) => same(e.institution, single.institution) && same(e.qualification, single.qualification) && same(e.year, single.year))) entries.push(single);
  return entries.map((e) => [e.qualification || e.program, e.institution, e.program !== e.qualification ? e.program : "", e.year, e.result].filter(Boolean).join(", "));
}

const text = (value: string, tone?: "muted" | "warn" | "danger" | "link", url?: string) => ({ text: value, ...(tone ? { tone } : {}), ...(url ? { url } : {}) });
const SIGNATURE_IMAGE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

function signatureImage(raw: unknown): ImageData | null {
  const match = typeof raw === "string" ? SIGNATURE_IMAGE.exec(raw.trim()) : null;
  if (!match || match[2].length > 400_000) return null;
  try { return imageFromBytes(Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))); } catch { return null; }
}

/** What one answered field prints: only the chosen value(s), formatted with the shared helpers; no paragraphs means "Not provided". */
export function fieldParas(field: PdfField, values: Record<string, unknown>, now: Date, consented: boolean): Para[] {
  const raw = values[field.name];
  if (field.type === "terms") return consented ? (field.options ?? []).map((t) => ({ spans: [text(t)], check: true })) : [];
  if (field.type === "checkbox") {
    const picked = list(raw);
    const options = field.options ?? [];
    const ticked = options.length === 1 ? (picked.length && (picked.some((p) => options[0].toLowerCase() === p.toLowerCase()) || picked.every((p) => TRUTHY.test(p))) ? [options[0]] : []) : picked;
    return ticked.map((t) => ({ spans: [text(t)], check: true }));
  }
  if (field.name === "digital_signature") {
    const image = signatureImage(raw);
    if (image) return [{ spans: [], image }];
  }
  const joined = Array.isArray(raw) || plain(raw) ? list(raw).join(", ") : formatValue(raw);
  if (!joined) return [];
  let shown = joined;
  if (field.format === "phone" || PHONE_FIELDS.has(field.name)) shown = formatPhone(joined);
  else if (field.format === "usi" || field.name === "usi_number") shown = normalizeUsi(joined);
  else if (field.type === "date") shown = formatDateOnly(joined);
  const spans = [text(shown)];
  const expiryType = (Object.keys(EXPIRY_FIELDS) as ExpiryDocument[]).find((k) => EXPIRY_FIELDS[k] === field.name);
  if (expiryType) {
    const expiry = getDocumentExpiryStatus(expiryType, values, now);
    if (expiry.status === "expired") spans.push(text("  Expired", "danger"));
    else if (expiry.status === "expiring_soon") spans.push(text(expiry.expiresToday ? "  Expires today" : "  Expires soon", "warn"));
  }
  return [{ spans }];
}

export interface PdfModelSection { title: string; rows: Row[] }

const SKIP_UNKNOWN = /(_upload|_copy|_file|_docs)$/;
const INTERNAL_KEYS = new Set(["courses", "wizard", "provenance", "submission", "consent", "academicQualifications"]);

/** The sections and rows to print, built from the form definition; visible-but-empty fields say "Not provided", empty sections are dropped. */
export function buildSubmissionModel(input: SubmissionPdfInput): { sections: PdfModelSection[]; consent: Record<string, unknown> | null } {
  const snap = (plain(input.snapshot) ? input.snapshot : {}) as Record<string, unknown>;
  const values = (plain(snap.values) ? snap.values : {}) as Record<string, unknown>;
  const now = input.now ?? new Date();
  const usiPending = plain(snap.wizard) && snap.wizard.usiPending === true;
  const consent = (plain(snap.submission) && plain(snap.submission.consent) ? snap.submission.consent : null) as Record<string, unknown> | null;
  const definition = input.sections ?? PDF_FORM_SECTIONS;
  const known = new Set<string>();
  const sections: PdfModelSection[] = [];
  const courses = (Array.isArray(snap.courses) ? snap.courses : []).filter(plain).map((c) => {
    const title = formatValue(c.course_title ?? c.title) || formatValue(c.course_id ?? c.courseId);
    const code = formatValue(c.course_code ?? c.code);
    const variant = formatValue(c.variant);
    return { title, code, variant };
  }).filter((c) => c.title || c.code);
  let coursesPrinted = false;
  const courseRows = (): Row[] => courses.map((c, i) => ({ label: courses.length > 1 ? `Course ${i + 1}` : "Course", paras: [{ spans: [text(c.title), ...(c.code ? [text(`  (${c.code})`, "muted")] : []), ...(c.variant ? [text(`  ${c.variant}`, "muted")] : [])] }] }));
  let qualificationsPrinted = false;
  const qualifications = qualificationLines(snap, values);

  for (const section of definition) {
    section.fields.forEach((f) => known.add(f.name));
    if (!conditionMet(section.showIf, values)) continue;
    const rows: Row[] = [];
    for (const field of section.fields) {
      // A USI the agent will add later prints as Pending (the number field is hidden while the answer is No).
      if (field.name === "usi_number" && usiStatus(values, usiPending) === "pending") { rows.push({ label: field.label, paras: [{ spans: [text("Pending", "warn")] }] }); continue; }
      if (NON_ANSWER_TYPES.has(field.type) || field.name === "confirm_email" || !conditionMet(field.showIf, values)) continue;
      if (field.name === "courses_of_interest") {
        if (courses.length) { rows.push(...courseRows()); coursesPrinted = true; continue; }
        const fallback = list(values[field.name]);
        rows.push({ label: field.label, paras: fallback.map((t) => ({ spans: [text(t)] })) });
        continue;
      }
      if (field.name.startsWith("academic_")) {
        if (!qualificationsPrinted) {
          qualificationsPrinted = true;
          rows.push(...(qualifications.length ? qualifications.map((q, i) => ({ label: qualifications.length > 1 ? `Qualification ${i + 1}` : "Qualification", paras: [{ spans: [text(q)] }] })) : [{ label: "Academic qualifications", paras: [] }]));
        }
        continue;
      }
      rows.push({ label: field.label || humanize(field.name), paras: fieldParas(field, values, now, !!consent) });
    }
    if (rows.length) sections.push({ title: section.title, rows });
  }
  if (courses.length && !coursesPrinted) sections.push({ title: "Courses", rows: courseRows() });
  if (qualifications.length && !qualificationsPrinted) sections.push({ title: "Academic qualifications", rows: qualifications.map((q, i) => ({ label: `Qualification ${i + 1}`, paras: [{ spans: [text(q)] }] })) });

  // Unknown answers (a field added to the stored form but not yet in the definition) still print: label plus value.
  const extra: Row[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (known.has(key) || INTERNAL_KEYS.has(key) || SKIP_UNKNOWN.test(key) || key.startsWith("academic_") || plain(value)) continue;
    const shown = formatValue(value);
    if (shown) extra.push({ label: humanize(key), paras: [{ spans: [text(PHONE_FIELDS.has(key) ? formatPhone(shown) : shown)] }] });
  }
  if (extra.length) sections.push({ title: "Other details", rows: extra });

  if (input.documents?.length) {
    sections.push({
      title: "Documents",
      rows: input.documents.map((d) => ({ label: d.category || "Document", paras: [{ spans: [text(d.fileName), ...(d.url ? [text("   "), text("Open attachment", "link", d.url)] : [])] }] })),
    });
  }
  sections.push({
    title: "Consent",
    rows: [{ label: "Consent recorded", paras: consent ? [{ spans: [text(`Student consent and agent authorisation confirmed (${formatValue(consent.method) || "recorded"}, declaration ${formatValue(consent.declarationVersion) || "1.0"}).`)] }] : [] }],
  });
  return { sections, consent };
}

/* ------------------------------------------------------------------ Rendering */

/** Lays the document out (not yet saved). Never throws for a missing / unreadable logo: the institution name is printed instead. */
export async function renderSubmission(input: SubmissionPdfInput): Promise<PdfWriter> {
  const primary = resolvePrimary(input.branding?.primary);
  const reference = input.reference || "Draft";
  const institution = input.institution || "Institution";
  const model = buildSubmissionModel(input);
  const writer = await PdfWriter.create(`Application ${reference}`, { primary: primary.rgb.map((v) => v / 255) as [number, number, number], tint: primary.tint.map((v) => v / 255) as [number, number, number] });
  let logo: ImageData | null = null;
  if (input.branding?.logo) { try { await writer.prepareImage(input.branding.logo); logo = input.branding.logo; } catch { logo = null; } }
  for (const section of model.sections) for (const row of section.rows) for (const para of row.paras) {
    if (para.image) { try { await writer.prepareImage(para.image); } catch { para.image = undefined; para.spans = [text("Signature recorded", "muted")]; } }
  }
  writer.header({ institution, logo, reference, submitted: formatDateTime(input.submittedAt, input.branding?.timezone || DEFAULT_TIMEZONE) || "Not recorded", version: input.version, title: "Student application" });
  for (const section of model.sections) writer.section(section.title, section.rows);
  const closing: Para[] = [];
  if (input.linksExpireOn) closing.push({ spans: [text(`Links expire on ${input.linksExpireOn}. Sign in to the portal to access documents later.`, "muted")] });
  if (input.portalLink) closing.push({ spans: [text("Open this application in the portal", "link", input.portalLink)] });
  closing.push({ spans: [text("This document is a copy of the submitted form. The portal record is authoritative.", "muted")] });
  if (!writer.truncated) writer.block(closing);
  if (writer.truncated) writer.truncationNote();
  writer.footers(institution, reference);
  return writer;
}

export async function buildSubmissionPdf(input: SubmissionPdfInput): Promise<Uint8Array> {
  return await (await renderSubmission(input)).save();
}

