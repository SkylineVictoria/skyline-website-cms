// Runtime-neutral, dependency-free PDF of an immutable submitted-application snapshot (Helvetica text, A4, paginated).
// The PDF exists only in memory for the duration of one send: nothing here logs, stores or returns the content anywhere else.

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_PAGES = 40;

export type PdfStyle = "title" | "heading" | "body" | "muted";
export interface PdfLine { text: string; style?: PdfStyle }

const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;
const SIZES: Record<PdfStyle, number> = { title: 16, heading: 12, body: 10, muted: 9 };
const FONT: Record<PdfStyle, "F1" | "F2"> = { title: "F2", heading: "F2", body: "F1", muted: "F1" };

/** Standard-14 Helvetica only covers WinAnsi: accents are stripped, anything else printable-ASCII-unsafe becomes "?". */
export function pdfSafe(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, (c) => (/[\t\r\n]/.test(c) ? " " : "?"));
}
const escapePdf = (text: string) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(text: string, size: number): string[] {
  const max = Math.max(20, Math.floor((PAGE_W - 2 * MARGIN) / (size * 0.52)));
  const out: string[] = [];
  for (const paragraph of [pdfSafe(text)]) {
    let line = "";
    for (let word of paragraph.split(" ")) {
      while (word.length > max) { if (line) { out.push(line); line = ""; } out.push(word.slice(0, max)); word = word.slice(max); }
      if (!line) line = word;
      else if ((line + " " + word).length <= max) line += " " + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/** Builds a valid PDF 1.4 file. Output is plain ASCII, so byte offsets equal string offsets. */
export function buildPdf(lines: PdfLine[], title = "Document"): Uint8Array {
  type Placed = { text: string; style: PdfStyle; y: number };
  const pages: Placed[][] = [[]];
  let y = PAGE_H - MARGIN;
  let truncated = false;
  const place = (text: string, style: PdfStyle) => {
    const size = SIZES[style], lead = size * 1.4;
    if (y - lead < MARGIN) {
      if (pages.length >= MAX_PDF_PAGES) { truncated = true; return; }
      pages.push([]); y = PAGE_H - MARGIN;
    }
    y -= lead;
    pages[pages.length - 1].push({ text, style, y });
  };
  for (const line of lines) {
    const style = line.style ?? "body";
    if (style === "heading") y -= 6;
    for (const part of wrap(line.text, SIZES[style])) { if (!truncated) place(part, style); }
  }
  if (truncated) { y = MARGIN + 12; pages[pages.length - 1].push({ text: "Truncated: open the application in the portal for the full record.", style: "muted", y }); }

  // Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info, then (page, content) pairs.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[4] = `<< /Title (${escapePdf(pdfSafe(title).slice(0, 120))}) /Producer (Skyline) >>`;
  pages.forEach((page, i) => {
    const stream = page.map((p) => `BT /${FONT[p.style]} ${SIZES[p.style]} Tf 1 0 0 1 ${MARGIN} ${p.y.toFixed(2)} Tm (${escapePdf(p.text)}) Tj ET`).join("\n");
    objects[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2 + 1} 0 R >>`;
    objects[6 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// ---- snapshot -> readable lines -------------------------------------------------------------------------------------
// eslint-disable-next-line no-control-regex -- control characters are stripped from every value
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const humanize = (key: string) => { const s = key.replace(/[_-]+/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

function formatValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(CONTROL, " ").trim().slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => formatValue(v, depth + 1)).filter(Boolean).join(", ").slice(0, 500);
  if (typeof value === "object" && depth < 2) {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => [humanize(k), formatValue(v, depth + 1)]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ").slice(0, 500);
  }
  return "";
}

export interface SubmissionPdfInput { reference: string; institution: string; version: number; submittedAt: string | null; snapshot: unknown }

/** File uploads and wizard / provenance internals are left out; only what the applicant and agent entered is printed. */
export function submissionPdfLines(input: SubmissionPdfInput): PdfLine[] {
  const snap = (input.snapshot && typeof input.snapshot === "object" ? input.snapshot : {}) as Record<string, unknown>;
  const lines: PdfLine[] = [
    { text: `Application ${input.reference}`, style: "title" },
    { text: `${input.institution} - submitted application, version ${input.version}${input.submittedAt ? `, ${String(input.submittedAt).slice(0, 10)}` : ""}`, style: "muted" },
    { text: "Application details", style: "heading" },
  ];
  const values = (snap.values && typeof snap.values === "object" ? snap.values : {}) as Record<string, unknown>;
  let printed = 0;
  for (const [key, value] of Object.entries(values)) {
    if (/(_upload|_copy|_file)$/.test(key)) continue;
    const text = formatValue(value);
    if (!text) continue;
    lines.push({ text: `${humanize(key)}: ${text}` });
    printed++;
  }
  if (!printed) lines.push({ text: "No form values were recorded.", style: "muted" });
  const courses = Array.isArray(snap.courses) ? snap.courses as Record<string, unknown>[] : [];
  if (courses.length) {
    lines.push({ text: "Courses", style: "heading" });
    for (const course of courses) {
      const label = formatValue(course.title) || formatValue(course.course_id ?? course.courseId);
      const code = formatValue(course.code);
      if (label) lines.push({ text: code ? `${label} (${code})` : label });
    }
  }
  const consent = ((snap.submission as Record<string, unknown> | undefined)?.consent ?? null) as Record<string, unknown> | null;
  lines.push({ text: "Declaration", style: "heading" });
  lines.push({ text: consent ? `Student consent and agent authorisation confirmed (${formatValue(consent.method) || "recorded"}, declaration ${formatValue(consent.declarationVersion) || "1.0"}).` : "No declaration was recorded." });
  lines.push({ text: "This document is a copy of the submitted form. The portal record is authoritative.", style: "muted" });
  return lines;
}

export function buildSubmissionPdf(input: SubmissionPdfInput): Uint8Array {
  return buildPdf(submissionPdfLines(input), `Application ${input.reference}`);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const attachmentFileName = (reference: string) => `application-${reference.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "submitted"}.pdf`;
