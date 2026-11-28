// APPLICATION-FORM-TEMPLATES (owner 2026-11-27): the signed application is printed from an "Application form" template kept in
// Documents & Signatures › Templates (hr.sign_templates, category application_form), the version that was the default when the student
// signed (public.application_form_used). One renderer for the template editor's preview, the portal's Download and the email worker,
// so a signed application always comes out the same. The template is HTML (header, body, footer) with {{tokens}}: simple values are
// escaped text; block tokens are whole sections built here (the answers, the declarations as agreed, the signatures). No signing
// certificate detail (IP, signing key, user agent, hashes) is ever printed.

import { buildSubmissionModel, type SubmissionPdfInput } from "./submission-pdf.ts";
import type { SignedParts } from "./signed-page.ts";

export const APPLICATION_FORM_CATEGORY = "application_form";

export interface ApplicationFormToken { key: string; label: string; description: string; sample: string; block?: boolean }
/** Every token an application form template may use (the editor's variable list). */
export const APPLICATION_FORM_TOKENS: readonly ApplicationFormToken[] = [
  { key: "application.reference", label: "Application reference", description: "The application's reference number.", sample: "SLIT-2026-0148" },
  { key: "application.submitted_on", label: "Submitted on", description: "The date the application was signed and submitted.", sample: "27 November 2026" },
  { key: "student.full_name", label: "Student full name", description: "The student's name as on the application.", sample: "Asha Patel" },
  { key: "student.email", label: "Student email", description: "The student's email address.", sample: "asha.patel@example.com" },
  { key: "student.date_of_birth", label: "Date of birth", description: "The student's date of birth.", sample: "5 April 1999" },
  { key: "course.name", label: "Course", description: "The course applied for (code and name).", sample: "CHC33021 Certificate III in Individual Support" },
  { key: "course.intake", label: "Intake", description: "The intake or start date chosen.", sample: "Feb 2027" },
  { key: "institute.name", label: "Institute name", description: "The institute (Website Settings).", sample: "Skyline Institute of Technology" },
  { key: "institute.logo", label: "Institute logo", description: "The logo from Website Settings (a picture).", sample: "[Logo]", block: true },
  { key: "institute.legal_name", label: "Legal name", description: "The institute's legal entity name.", sample: "INDOPACIFIC GLOBAL PTY LTD T/A Skyline Institute of Technology (SLIT)" },
  { key: "institute.address", label: "Address", description: "Head office address.", sample: "Level 8, 310 King Street, Melbourne VIC 3000" },
  { key: "institute.phone", label: "Phone", description: "Phone number.", sample: "03 9125 1661" },
  { key: "institute.email", label: "Email", description: "Email address.", sample: "info@slit.edu.au" },
  { key: "institute.website", label: "Website", description: "Website address.", sample: "slit.edu.au" },
  { key: "institute.rto", label: "RTO code", description: "RTO number.", sample: "45989" },
  { key: "institute.cricos", label: "CRICOS code", description: "CRICOS provider code.", sample: "04114B" },
  { key: "institute.abn", label: "ABN", description: "Australian Business Number.", sample: "20 643 760 721" },
  { key: "institute.contact_line", label: "Contact line", description: "Phone, email and website on one line (empty parts left out).", sample: "03 9125 1661  |  info@slit.edu.au  |  slit.edu.au" },
  { key: "institute.registration_line", label: "Registration line", description: "RTO and CRICOS codes on one line (empty parts left out).", sample: "RTO 45989  |  CRICOS 04114B" },
  { key: "signed.by", label: "Signed by", description: "Who signed the application.", sample: "Asha Patel" },
  { key: "signed.on", label: "Signed on", description: "The date the student signed.", sample: "27 November 2026" },
  { key: "page.number", label: "Page number", description: "This page's number (header or footer).", sample: "1" },
  { key: "page.total", label: "Total pages", description: "How many pages the document has (header or footer).", sample: "3" },
  { key: "application.answers", label: "All answers (sections)", description: "Every answer of the application, section by section, as submitted.", sample: "[All answers]", block: true },
  { key: "application.declarations", label: "Declarations agreed", description: "Each declaration ticked, in the wording the student agreed to.", sample: "[Declarations]", block: true },
  { key: "application.signatures", label: "Signatures", description: "The student's drawn signature (and the parent / guardian's), with names and dates.", sample: "[Signatures]", block: true },
];
const TOKEN_KEYS = new Set(APPLICATION_FORM_TOKENS.map((t) => t.key));
const TOKEN = /\{\{\s*([a-z][a-z0-9_.]{0,60})(?:\|h(\d{1,3}))?\s*\}\}/gi;

export interface ApplicationFormTemplate { title: string; header_html: string | null; body_html: string; footer_html: string | null;
  /** LETTERHEAD-DESIGNER: the smaller header of pages 2 and on (absent: the header repeats). */ header_later_html?: string | null }
/** The institute's details (Website Settings); the logo as a PNG or JPEG data URL, so it prints without a network fetch. */
export interface ApplicationFormInstitute { name?: string; legalName?: string; address?: string; phone?: string; email?: string; website?: string; rto?: string; cricos?: string; abn?: string; logo?: string | null }
export interface ApplicationFormData {
  reference: string; submittedAt: string | null; institution: string; timezone?: string | null; institute?: ApplicationFormInstitute;
  snapshot: unknown; signed: SignedParts | null; studentName: string;
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const day = (iso: string | null | undefined, tz?: string | null) => {
  if (!iso) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try { return d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : tz || "Australia/Melbourne" }); } catch { return String(iso).slice(0, 10); }
};

// The house style of the blocks (the template's own HTML styles everything else). Colours: SLIT orange, slate text, soft greys.
const ACCENT = "#ea6619", INK = "#111827", MUTED = "#6b7280", LINE = "#e5e7eb", TINT = "#fdf1ea", ZEBRA = "#f9fafb";
const sectionHeading = (title: string) =>
  `<table style="border:none;width:100%"><tr><td style="background-color:${TINT};border-left:3pt solid ${ACCENT};padding:5pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:10.5pt"><strong><span style="color:${INK}">${esc(title.toUpperCase())}</span></strong></span></p></td></tr></table>`;
const spacer = (pt = 6) => `<table style="border:none;width:100%"><tr><td style="padding:0pt 0pt"><p style="margin-bottom:0pt"><span style="font-size:${pt}pt">&nbsp;</span></p></td></tr></table>`;

/** The answers, section by section: an accented heading and a label / value table per section, as submitted. */
export function answersHtml(data: Pick<ApplicationFormData, "reference" | "institution" | "submittedAt" | "snapshot">): string {
  const input: SubmissionPdfInput = { reference: data.reference, institution: data.institution, version: 1, submittedAt: data.submittedAt, snapshot: data.snapshot };
  const { sections } = buildSubmissionModel(input);
  // Only what the student answered (an empty section is left out); the form's own declaration section is the Declarations block.
  const answered = sections.filter((s) => s.title !== "Consent" && !/declaration/i.test(s.title)).map((section) => ({
    title: section.title,
    rows: section.rows.map((row) => ({ label: row.label, text: row.paras.map((p) => (p.check ? "Yes: " : "") + p.spans.map((x) => x.text).join("")).filter((t) => t.trim()) }))
      .filter((row) => row.text.length && !row.text.every((t) => /^(not provided|pending)$/i.test(t.trim()))),
  })).filter((section) => section.rows.length);
  return answered.map((section) => {
    const rows = section.rows.map((row, i) => {
      const value = row.text.map(esc).join("<br>");
      const shade = i % 2 ? "" : `background-color:${ZEBRA};`;
      return `<tr><td style="${shade}width:36%;border-bottom:0.5pt solid ${LINE};padding:4pt 6pt"><p style="margin-bottom:0pt"><span style="font-size:8.5pt"><span style="color:${MUTED}">${esc(row.label)}</span></span></p></td>`
        + `<td style="${shade}border-bottom:0.5pt solid ${LINE};padding:4pt 6pt"><p style="margin-bottom:0pt"><span style="font-size:9pt"><span style="color:${INK}">${value || `<em><span style="color:${MUTED}">Not provided</span></em>`}</span></span></p></td></tr>`;
    }).join("");
    return sectionHeading(section.title) + `<table style="border:none;width:100%">${rows}</table>` + spacer(8);
  }).join("");
}

/** The declarations as agreed: each in a box, ticked, its title and the stored wording. */
export function declarationsHtml(signed: SignedParts | null): string {
  const list = (signed?.declarations ?? []).filter((d) => d.role !== "guardian");
  if (!signed) return `<p><span style="font-size:9pt"><em><span style="color:${MUTED}">Not signed yet: the student agrees to the declarations when signing.</span></em></span></p>`;
  if (!list.length) return `<p><span style="color:${MUTED}">No declarations are recorded for this application.</span></p>`;
  return list.map((d) => {
    const body = d.body ? d.body.split(/\n+/).filter((l) => l.trim()).map((l) => `<p style="margin-bottom:2pt"><span style="font-size:8.5pt"><span style="color:#374151">${esc(l)}</span></span></p>`).join("")
      : `<p><em><span style="font-size:8.5pt;color:${MUTED}">The wording of this declaration version is not stored.</span></em></p>`;
    return `<table style="border:none;width:100%"><tr>`
      + `<td style="width:22pt;vertical-align:top;padding:6pt 4pt"><table style="width:12pt"><tr><td style="border-top:1pt solid ${INK};border-right:1pt solid ${INK};border-bottom:1pt solid ${INK};border-left:1pt solid ${INK};padding:0pt 2pt;text-align:center"><p style="text-align:center;margin-bottom:0pt"><span style="font-size:8pt"><strong>X</strong></span></p></td></tr></table></td>`
      + `<td style="border-bottom:0.5pt solid ${LINE};padding:6pt 6pt"><p style="margin-bottom:3pt"><span style="font-size:9.5pt"><strong><span style="color:${INK}">${esc(d.title)}</span></strong></span></p>${body}</td></tr></table>`;
  }).join("") + spacer(6);
}

/** The signature panel: the student's drawn signature (and the parent / guardian's) on a line, with the name and the date. */
export function signaturesHtml(signed: SignedParts | null, fallbackName: string, tz?: string | null): string {
  const cell = (label: string, png: string | null, name: string, date: string) =>
    `<td style="width:50%;vertical-align:bottom;padding:4pt 10pt 4pt 0pt">`
    + (png && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(png) ? `<p style="margin-bottom:0pt"><img src="${png}" width="190"></p>` : `<p style="margin-bottom:0pt"><span style="font-size:20pt">&nbsp;</span></p>`)
    + `<table style="border:none;width:100%"><tr><td style="border-top:0.75pt solid ${INK};padding:3pt 0pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:${MUTED}">${esc(label.toUpperCase())}</span></span></p>`
    + `<p style="margin-bottom:0pt"><span style="font-size:9.5pt"><strong>${esc(name)}</strong></span></p><p style="margin-bottom:0pt"><span style="font-size:8.5pt"><span style="color:${MUTED}">${esc(date)}</span></span></p></td></tr></table></td>`;
  const student = signed?.signatures.find((s) => s.role === "student");
  const declared = signed?.declarations.find((d) => d.role !== "guardian");
  const name = student?.name || signed?.signedBy || declared?.name || fallbackName;
  const at = student?.signedAt || signed?.signedAt || declared?.at || null;
  const left = cell("Signature of the student", student?.png ?? null, name, at ? `Signed ${day(at, tz)}` : "Not signed yet");
  const guardian = signed?.signatures.find((s) => s.role === "guardian");
  const right = guardian || signed?.guardian
    ? cell(`Parent / guardian${signed?.guardian?.relationship ? ` (${signed.guardian.relationship})` : ""}`, guardian?.png ?? null, guardian?.name || signed?.guardian?.name || "", guardian ? `Signed ${day(guardian.signedAt, tz)}` : "Not signed yet")
    : `<td style="width:50%"><p>&nbsp;</p></td>`;
  return `<table style="border:none;width:100%"><tr>${left}${right}</tr></table>`;
}

/** The institute logo (Website Settings) as a picture, when it was given as a PNG / JPEG data URL. */
const logoHtml = (institute: ApplicationFormInstitute | undefined, name: string, height = 46) =>
  institute?.logo && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(institute.logo)
    ? `<img src="${institute.logo}" height="${Math.min(120, Math.max(10, height))}">` : `<strong><span style="font-size:${height < 30 ? 10 : 14}pt">${esc(name)}</span></strong>`;

/** The simple values of one application, by token. */
export function applicationFormValues(data: ApplicationFormData): Record<string, string> {
  const snap = plain(data.snapshot) ? data.snapshot : {};
  const values = plain(snap.values) ? snap.values : {};
  const str = (k: string) => (typeof values[k] === "string" ? String(values[k]).trim() : "");
  const courses = Array.isArray(snap.courses) ? (snap.courses as Record<string, unknown>[]) : [];
  const first = courses[0] ?? {};
  const course = [first.course_code ?? first.code, first.course_title ?? first.title].filter((x) => typeof x === "string" && x.trim()).join(" ");
  const student = data.signed?.signatures.find((s) => s.role === "student");
  const declared = data.signed?.declarations.find((d) => d.role !== "guardian");
  const fullName = [str("first_name"), str("middle_name"), str("last_name")].filter(Boolean).join(" ") || data.studentName;
  return {
    "application.reference": data.reference,
    "application.submitted_on": day(data.submittedAt, data.timezone) || "Not submitted yet",
    "student.full_name": fullName,
    "student.email": str("email"),
    "student.date_of_birth": day(str("dob") || null, data.timezone),
    "course.name": course || (Array.isArray(values.courses_of_interest) ? (values.courses_of_interest as unknown[]).map(String).join(", ") : ""),
    "course.intake": str("preferred_intake") || (typeof first.intake === "string" ? first.intake : ""),
    "institute.name": data.institute?.name || data.institution,
    "institute.legal_name": data.institute?.legalName || data.institution,
    "institute.address": data.institute?.address || "",
    "institute.phone": data.institute?.phone || "",
    "institute.email": data.institute?.email || "",
    "institute.website": (data.institute?.website || "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
    "institute.rto": data.institute?.rto || "",
    "institute.cricos": data.institute?.cricos || "",
    "institute.abn": data.institute?.abn || "",
    "institute.contact_line": [data.institute?.phone, data.institute?.email, (data.institute?.website || "").replace(/^https?:\/\//, "").replace(/\/$/, "")].filter((x) => x && x.trim()).join("  |  "),
    "institute.registration_line": [data.institute?.rto ? `RTO ${data.institute.rto}` : "", data.institute?.cricos ? `CRICOS ${data.institute.cricos}` : ""].filter(Boolean).join("  |  "),
    "signed.by": student?.name || data.signed?.signedBy || declared?.name || fullName,
    "signed.on": day(student?.signedAt || data.signed?.signedAt || declared?.at || data.submittedAt, data.timezone),
  };
}

/** Fills one part of the template: block tokens become their sections, the others escaped text; an unknown token is left visible. */
export function fillApplicationFormHtml(html: string | null | undefined, data: ApplicationFormData): string {
  const values = applicationFormValues(data);
  return String(html ?? "").replace(TOKEN, (whole, raw: string, height?: string) => {
    const key = raw.toLowerCase();
    if (!TOKEN_KEYS.has(key) || key.startsWith("page.")) return whole;
    if (key === "application.answers") return `</p>${answersHtml(data)}<p>`;
    if (key === "application.declarations") return `</p>${declarationsHtml(data.signed)}<p>`;
    if (key === "application.signatures") return `</p>${signaturesHtml(data.signed, data.studentName, data.timezone)}<p>`;
    if (key === "institute.logo") return logoHtml(data.institute, data.institute?.name || data.institution, height ? Number(height) : undefined);
    return esc(values[key] ?? "");
  }).replace(/<p>\s*<\/p>/g, "");
}

/** The tokens of a template that are not application form tokens (the editor warns about them before saving). */
export function unknownApplicationFormTokens(...parts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const part of parts) for (const m of String(part ?? "").matchAll(TOKEN)) if (!TOKEN_KEYS.has(m[1].toLowerCase())) out.add(m[1]);
  return [...out];
}

/** The signed application as a PDF from the template (A4, header and footer on every page, page numbers). */
export async function buildApplicationFormPdf(template: ApplicationFormTemplate, data: ApplicationFormData): Promise<Uint8Array> {
  const { buildDocumentPdf } = await import("../document-pdf.ts");
  const result = await buildDocumentPdf({
    title: fillApplicationFormHtml(template.title, data).replace(/<[^>]*>/g, "") || "Application for enrolment",
    header: fillApplicationFormHtml(template.header_html, data) || null,
    headerLater: template.header_later_html ? fillApplicationFormHtml(template.header_later_html, data) : null,
    body: fillApplicationFormHtml(template.body_html, data) || "<p></p>",
    footer: fillApplicationFormHtml(template.footer_html, data) || null,
    values: {}, brackets: false, images: {},
    // page numbers per page; anything else left in the template prints nothing (the editor warns about unknown tokens before saving)
    curly: (key) => (key === "page.number" ? { kind: "page" } : key === "page.total" ? { kind: "total" } : { kind: "value", text: "" }),
  });
  return result.bytes;
}

/** A drawn sample signature (preview only). */
const SAMPLE_SIGNATURE = "data:image/png;base64,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";

/** A complete sample application (preview with sample application). */
export function sampleApplicationFormData(): ApplicationFormData {
  const png = SAMPLE_SIGNATURE;
  return {
    reference: "SLIT-2026-0000", submittedAt: "2026-11-27T05:00:00Z", institution: "Skyline Institute of Technology", timezone: "Australia/Melbourne", studentName: "Asha Patel",
    snapshot: { values: { first_name: "Asha", last_name: "Patel", email: "asha.patel@example.com", dob: "1999-04-05", nationality: "India", passport_number: "PA1234567", preferred_intake: "Feb 2027", usi_number: "ABC234DEF5", ec_name: "Ravi Patel", ec_relationship: "Brother", ec_phone: "+61400000000" },
      courses: [{ course_code: "CHC33021", course_title: "Certificate III in Individual Support", intake: "Feb 2027" }] },
    signed: {
      signatures: [{ role: "student", name: "Asha Patel", png, signedAt: "2026-11-27T05:00:00Z" }],
      declarations: [
        { title: "Written agreement (ESOS)", body: "I accept this application, the letter of offer that SLIT will issue and SLIT's policies as my written agreement.", role: "student", name: "Asha Patel", at: "2026-11-27T05:00:00Z" },
        { title: "Unique Student Identifier (USI)", body: "I consent to SLIT using and providing my USI for enrolment, reporting and verification purposes.", role: "student", name: "Asha Patel", at: "2026-11-27T05:00:00Z" },
      ],
      guardian: null,
    },
  };
}

/**
 * The starting template (owner 2026-11-27: "one super looking form, it is the first impression"): the letterhead (logo, contact block,
 * an orange rule), a dark title band with the reference and the date, a summary card, the answers, the declarations, the signature
 * panel and an office-use block; the footer carries the reference, the page count and the institute's registration details.
 * The database seeds it as the default Application form template; staff can edit it (each save is a new version).
 */
export const DEFAULT_APPLICATION_FORM_TEMPLATE: ApplicationFormTemplate & { name: string } = {
  name: "Application for Enrolment (standard)",
  title: "Application for Enrolment {{application.reference}}",
  header_html:
    `<table style="border:none;width:100%"><tr>`
    + `<td style="width:50%;vertical-align:middle;padding:0pt 0pt">{{institute.logo}}</td>`
    + `<td style="width:50%;vertical-align:middle;text-align:right;padding:0pt 0pt">`
    + `<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.address}}</span></span></p>`
    + `<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.contact_line}}</span></span></p>`
    + `<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">{{institute.registration_line}}</span></span></p>`
    + `</td></tr>`
    + `<tr><td colspan="2" style="border-bottom:2.5pt solid #ea6619;padding:0pt 0pt"><p style="margin-bottom:0pt"><span style="font-size:3pt">&nbsp;</span></p></td></tr></table>`,
  body_html:
    // Title band
    `<table style="border:none;width:100%"><tr>`
    + `<td style="background-color:#1f2937;width:64%;padding:12pt 14pt;vertical-align:middle">`
    + `<p style="margin-bottom:2pt"><span style="font-size:17pt"><strong><span style="color:#ffffff">APPLICATION FOR ENROLMENT</span></strong></span></p>`
    + `<p style="margin-bottom:0pt"><span style="font-size:9pt"><span style="color:#d1d5db">Student application, declarations and signature</span></span></p></td>`
    + `<td style="background-color:#ea6619;padding:12pt 14pt;vertical-align:middle">`
    + `<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#fde7d9">REFERENCE</span></span></p>`
    + `<p style="text-align:right;margin-bottom:4pt"><span style="font-size:12pt"><strong><span style="color:#ffffff">{{application.reference}}</span></strong></span></p>`
    + `<p style="text-align:right;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#fde7d9">SUBMITTED</span></span></p>`
    + `<p style="text-align:right;margin-bottom:0pt"><span style="font-size:10pt"><strong><span style="color:#ffffff">{{application.submitted_on}}</span></strong></span></p></td>`
    + `</tr></table>`
    + `<p style="margin-bottom:0pt"><span style="font-size:8pt">&nbsp;</span></p>`
    // Summary card
    + `<table style="border:none;width:100%"><tr>`
    + `<td style="background-color:#f8fafc;border-top:0.5pt solid #e5e7eb;border-left:0.5pt solid #e5e7eb;padding:7pt 10pt;width:50%"><p style="margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#6b7280">STUDENT</span></span></p><p style="margin-bottom:0pt"><span style="font-size:11pt"><strong>{{student.full_name}}</strong></span></p><p style="margin-bottom:0pt"><span style="font-size:8.5pt"><span style="color:#4b5563">{{student.email}}</span></span></p></td>`
    + `<td style="background-color:#f8fafc;border-top:0.5pt solid #e5e7eb;border-right:0.5pt solid #e5e7eb;padding:7pt 10pt"><p style="margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#6b7280">DATE OF BIRTH</span></span></p><p style="margin-bottom:0pt"><span style="font-size:10pt"><strong>{{student.date_of_birth}}</strong></span></p></td>`
    + `</tr><tr>`
    + `<td style="background-color:#f8fafc;border-bottom:0.5pt solid #e5e7eb;border-left:0.5pt solid #e5e7eb;padding:7pt 10pt"><p style="margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#6b7280">COURSE</span></span></p><p style="margin-bottom:0pt"><span style="font-size:10pt"><strong>{{course.name}}</strong></span></p></td>`
    + `<td style="background-color:#f8fafc;border-bottom:0.5pt solid #e5e7eb;border-right:0.5pt solid #e5e7eb;padding:7pt 10pt"><p style="margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#6b7280">INTAKE</span></span></p><p style="margin-bottom:0pt"><span style="font-size:10pt"><strong>{{course.intake}}</strong></span></p></td>`
    + `</tr></table>`
    + `<p style="margin-bottom:0pt"><span style="font-size:10pt">&nbsp;</span></p>`
    + `<p>{{application.answers}}</p>`
    // Declarations
    + `<table style="border:none;width:100%"><tr><td style="background-color:#fdf1ea;border-left:3pt solid #ea6619;padding:5pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:10.5pt"><strong>DECLARATIONS</strong></span></p></td></tr></table>`
    + `<p style="margin-bottom:2pt"><span style="font-size:8.5pt"><span style="color:#4b5563">The student read and agreed to each declaration below, in the wording shown, when signing this application.</span></span></p>`
    + `<p>{{application.declarations}}</p>`
    // Signature: one block, kept on one page (a table row is never split)
    + `<table style="border:none;width:100%"><tr><td style="padding:0pt 0pt">`
    + `<table style="border:none;width:100%"><tr><td style="background-color:#fdf1ea;border-left:3pt solid #ea6619;padding:5pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:10.5pt"><strong>SIGNATURE</strong></span></p></td></tr></table>`
    + `<p style="margin-bottom:4pt"><span style="font-size:8.5pt"><span style="color:#4b5563">By signing, the student confirms that the information in this application is true and complete, and that the documents provided are genuine.</span></span></p>`
    + `<p>{{application.signatures}}</p>`
    + `</td></tr></table>`
    + `<p style="margin-bottom:0pt"><span style="font-size:10pt">&nbsp;</span></p>`
    // Office use
    + `<table style="width:100%"><tr><td colspan="4" style="background-color:#f3f4f6;padding:4pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><strong><span style="color:#374151">FOR OFFICE USE ONLY</span></strong></span></p></td></tr>`
    + `<tr><td style="width:22%;padding:6pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#6b7280">Received by</span></span></p></td><td style="width:28%;padding:6pt 8pt"><p>&nbsp;</p></td>`
    + `<td style="width:22%;padding:6pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#6b7280">Date</span></span></p></td><td style="padding:6pt 8pt"><p>&nbsp;</p></td></tr>`
    + `<tr><td style="padding:6pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#6b7280">Entry requirements checked</span></span></p></td><td style="padding:6pt 8pt"><p>&nbsp;</p></td>`
    + `<td style="padding:6pt 8pt"><p style="margin-bottom:0pt"><span style="font-size:8pt"><span style="color:#6b7280">Student ID</span></span></p></td><td style="padding:6pt 8pt"><p>&nbsp;</p></td></tr></table>`,
  footer_html:
    `<table style="border:none;width:100%"><tr><td style="border-top:0.5pt solid #d1d5db;padding:4pt 0pt 0pt 0pt">`
    + `<p style="text-align:center;margin-bottom:0pt"><span style="font-size:7.5pt"><span style="color:#4b5563">Application for Enrolment  |  {{application.reference}}  |  Page {{page.number}} of {{page.total}}</span></span></p>`
    + `<p style="text-align:center;margin-bottom:0pt"><span style="font-size:6.5pt"><span style="color:#9ca3af">{{institute.legal_name}}  |  ABN {{institute.abn}}  |  {{institute.registration_line}}</span></span></p>`
    + `</td></tr></table>`,
};
