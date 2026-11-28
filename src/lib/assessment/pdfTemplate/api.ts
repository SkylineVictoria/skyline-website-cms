/**
 * ASM-PDF-TEMPLATE: the admin screen's calls. The workbook PDF goes to the private bucket assessment-templates as
 * <assessment id>/<sha256>.pdf (never replaced: a changed file has another hash), is read in the browser with pdf.js and its fields are
 * found by the detector; the template is saved on the assessment's draft (asm_template_save).
 */
import { supabase } from "@/pages/admin/lib/supabase";
import { detectTemplate } from "./detect";
import { pageModel, type PageModel, type PdfJsLike } from "./pageModel";
import type { PdfTemplate } from "./model";
import type { PdfBundle } from "./output";
import { textRows, type Candidate } from "./candidates";
import { applyClassification, detectAny, type AiAnswer, type GenericResult } from "./generic";
import { applyProfile, correctionsFrom, layoutChrome, layoutSignature, type Correction } from "./profile";

export const TEMPLATE_BUCKET = "assessment-templates";
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

export interface TemplateState { assessmentId: string; versionId: string | null; versionNo: number | null; status: string | null; updatedAt: string | null; template: PdfTemplate | null }

export async function loadTemplate(assessmentId: string): Promise<TemplateState> {
  const { data, error } = await supabase.rpc("asm_template_get", { p_assessment: assessmentId });
  if (error) throw new Error(error.message);
  return data as TemplateState;
}

export async function saveTemplate(assessmentId: string, template: PdfTemplate, expectedUpdatedAt: string | null): Promise<{ ok: boolean; errors?: string[]; versionNo?: number; updatedAt?: string }> {
  const { data, error } = await supabase.rpc("asm_template_save", { p_assessment: assessmentId, p_template: template, p_expected_updated_at: expectedUpdatedAt });
  if (error) throw new Error(error.code === "40001" ? "Someone else changed this draft. Reload the page before saving." : error.message);
  return data as { ok: boolean; errors?: string[]; versionNo?: number; updatedAt?: string };
}

/** The attempt's workbook template as the student sees it (null: the assessment has no PDF template). */
export async function loadStudentTemplate(attemptId: string): Promise<PdfTemplate | null> {
  const { data, error } = await supabase.rpc("asm_student_template", { p_attempt: attemptId });
  if (error) {
    // before the phase 2 migration is released the function does not exist: the assessment opens as before
    if (/asm_student_template|function .* does not exist|PGRST202/i.test(`${error.code} ${error.message}`)) return null;
    throw new Error(error.message);
  }
  return (data as PdfTemplate | null) ?? null;
}

/** A declaration the student signs: its slot ("decl:1", "pack"), who and when. */
export interface PdfSignature { slot: string; signerName: string; method: string; signaturePng: string | null; statement: string; signedAt: string }

export async function pdfSignatures(attemptId: string): Promise<PdfSignature[]> {
  const { data, error } = await supabase.rpc("asm_pdf_signatures_of", { p_attempt: attemptId });
  if (error) return [];
  return (data as PdfSignature[] | null) ?? [];
}

/** Signs one declaration of the draft attempt; "saved" signs with the student's saved signature (one tap). */
export async function pdfSign(attemptId: string, slot: string, method: "saved" | "drawn" | "uploaded" | "typed", png: string | null, statement: string): Promise<PdfSignature> {
  const { data, error } = await supabase.rpc("asm_pdf_sign", { p_attempt: attemptId, p_slot: slot, p_method: method, p_png: png, p_statement: statement });
  if (error) throw new Error(error.message);
  return data as PdfSignature;
}

/** Everything that draws an attempt's PDF (null: not an assessment on its workbook PDF, or the release before phase 3). */
export async function loadPdfAttempt(attemptId: string): Promise<PdfBundle | null> {
  const { data, error } = await supabase.rpc("asm_pdf_attempt", { p_attempt: attemptId });
  if (error) {
    if (/asm_pdf_attempt|does not exist|PGRST202/i.test(`${error.code} ${error.message}`)) return null;
    throw new Error(error.message);
  }
  return (data as PdfBundle | null) ?? null;
}

export const OUTPUT_BUCKET = "assessment-output";

/**
 * Stores a PDF of a final attempt (named by its SHA-256) and records it with the snapshot, marking (and acknowledgement) hashes it
 * was drawn from: "final" at the trainer's sign-off, "acknowledged" once the student has acknowledged (the official record).
 */
export async function storeFinalPdf(attemptId: string, bytes: Uint8Array, kind: "final" | "acknowledged" = "final"): Promise<{ path: string; pdf_sha256: string; snapshot_hash: string }> {
  const sha = await sha256Hex(bytes);
  const path = `${attemptId}/${kind}-${sha}.pdf`;
  const { error } = await supabase.storage.from(OUTPUT_BUCKET).upload(path, new Blob([bytes.slice()], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
  if (error && !/exist|duplicate/i.test(error.message)) throw new Error(`The final PDF could not be stored: ${error.message}`);
  const { data, error: e2 } = await supabase.rpc("asm_pdf_output_record", { p_attempt: attemptId, p_path: path, p_sha256: sha, p_kind: kind });
  if (e2) throw new Error(e2.message);
  return data as { path: string; pdf_sha256: string; snapshot_hash: string };
}

/**
 * A final attempt the student has acknowledged gets its acknowledged copy (sign-off copy kept): drawn from the snapshot, the marks and
 * the acknowledgement and stored once. Run by the student's results view right after signing, and by any later opening (student or
 * trainer) if that did not finish. True when a copy was stored now.
 */
export async function ensureAcknowledgedCopy(bundle: PdfBundle): Promise<boolean> {
  const a = bundle.attempts.find((x) => x.attemptNo === bundle.attemptNo);
  const kinds = new Set((a?.outputs ?? []).map((o) => o.kind));
  if (!a || a.state !== "final" || !a.acknowledgement || !kinds.has("final") || kinds.has("acknowledged")) return false;
  await storeFinalPdf(a.id, await buildStampedPdf(bundle, { trainer: true }), "acknowledged");
  return true;
}

export async function downloadOutput(path: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(OUTPUT_BUCKET).download(path);
  if (error || !data) throw new Error("The stored PDF could not be opened.");
  return new Uint8Array(await data.arrayBuffer());
}

/** The attempt's workbook with everything printed in place: from the snapshot; the trainer's marks only when `trainer`. */
export async function buildStampedPdf(bundle: PdfBundle, opts: { attemptNo?: number; trainer?: boolean; continuedAtEnd?: boolean } = {}): Promise<Uint8Array> {
  const [{ stampPdf }, { stampValues }, original] = await Promise.all([import("./stamp"), import("./output"), downloadWorkbook(bundle.template.pdf.path)]);
  const cur = bundle.attempts.find((a) => a.attemptNo === (opts.attemptNo ?? bundle.attemptNo));
  const footer = cur?.snapshot ? `Submission snapshot SHA-256 ${cur.snapshot.hash}` : undefined;
  return (await stampPdf(original, bundle.template, stampValues(bundle, opts), { footer, continuedAtEnd: opts.continuedAtEnd, letterhead: await workbookLetterhead() })).bytes;
}

let letterheadCache: Promise<{ pdf: Uint8Array; height: number } | null> | null = null;
/**
 * LETTERHEAD-DESIGNER: the active letterhead's strip for the pages a workbook gains (continued / answer pages), when the admin applied
 * it to workbooks; null otherwise (or for someone who cannot read it), and the pages print as before.
 */
async function workbookLetterhead(): Promise<{ pdf: Uint8Array; height: number } | null> {
  letterheadCache ??= (async () => {
    const { data, error } = await supabase.rpc("brand_letterhead_active");
    const html = !error && data && typeof (data as { workbookHeader?: unknown }).workbookHeader === "string" ? (data as { workbookHeader: string }).workbookHeader : "";
    if (!html) return null;
    const { buildDocumentPdf } = await import("../../../../supabase/functions/_shared/document-pdf");
    const r = await buildDocumentPdf({ title: "Letterhead", header: html, body: "<p>&nbsp;</p>", values: {}, brackets: false, images: {} });
    return r.bands.header ? { pdf: r.bytes, height: r.bands.header } : null;
  })().catch(() => null);
  return letterheadCache;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uploads the workbook (once per file: the same file already there is fine) and returns where it is. */
export async function uploadWorkbook(assessmentId: string, bytes: Uint8Array): Promise<{ path: string; sha256: string }> {
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("The PDF is larger than 50 MB.");
  if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("This file is not a PDF.");
  const sha256 = await sha256Hex(bytes);
  const path = `${assessmentId}/${sha256}.pdf`;
  const { error } = await supabase.storage.from(TEMPLATE_BUCKET).upload(path, new Blob([bytes.slice()], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
  if (error && !/exist|duplicate/i.test(error.message)) throw new Error(`The PDF could not be uploaded: ${error.message}`);
  return { path, sha256 };
}

export async function downloadWorkbook(path: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(TEMPLATE_BUCKET).download(path);
  if (error || !data) throw new Error("The workbook PDF could not be opened.");
  return new Uint8Array(await data.arrayBuffer());
}

async function pdfjs() {
  const [pdf, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
  pdf.GlobalWorkerOptions.workerSrc = worker.default;
  return pdf;
}

/** Reads every page of the PDF and finds its fields (about 2 s for a 100-page workbook). */
/**
 * ASM-UNIT-CHECK on the workbook: the unit code (and title) the workbook names on its first pages, for the comparison with the
 * assessment's unit. A code next to "Unit Code" wins, else the code printed most often (training.gov.au unit codes: 3 letters,
 * 2-4 letters, 3-4 digits, maybe a letter; qualification codes such as CPC30620 do not match).
 */
export async function unitInWorkbook(bytes: Uint8Array, pages = 6): Promise<{ code: string | null; name: string | null }> {
  return { code: (await codesInWorkbook(bytes, pages)).unit, name: null };
}

/** Page text of the first pages, joined per page (one pdf.js pass shared by the unit and qualification readers). */
async function firstPagesText(bytes: Uint8Array, pages: number): Promise<string[]> {
  const pdf = await pdfjs();
  const doc = await pdf.getDocument({ data: bytes.slice() }).promise;
  try {
    const out: string[] = [];
    for (let n = 1; n <= Math.min(pages, doc.numPages); n++) {
      out.push(((await (await doc.getPage(n)).getTextContent()).items as { str?: string }[]).map((x) => x.str ?? "").join(" ").replace(/\s+/g, " "));
    }
    return out;
  } finally {
    void (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/** The code printed most often (null when none). */
const mostCommon = (texts: string[], re: RegExp) => {
  const counts = new Map<string, number>();
  for (const t of texts) for (const m of t.matchAll(re)) counts.set(m[1].toUpperCase(), (counts.get(m[1].toUpperCase()) ?? 0) + 1);
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
};

/**
 * UPLOAD-FIRST Add assessment (owner 2026-11-26) and ASM-UNIT-CHECK: the unit code and the qualification code the workbook names on its
 * first pages. Unit: a code next to "Unit Code" wins, else the code printed most often (training.gov.au unit codes: 3 letters, 2-4
 * letters, 3-4 digits, maybe a letter). Qualification: a code next to "Qualification" / "Course" wins, else the one printed most often
 * (3 letters + 5 digits, such as CPC30620; unit codes never match it). The code only: a title read from the page text picks up the
 * headers around it.
 */
export async function codesInWorkbook(bytes: Uint8Array, pages = 6): Promise<{ unit: string | null; qualification: string | null }> {
  const texts = await firstPagesText(bytes, pages);
  const UNIT = /\b([A-Z]{3}[A-Z]{2,4}\d{3,4}[A-Z]?)\b/g; const QUAL = /\b([A-Z]{3}\d{5})\b/g;
  let unit: string | null = null; let qualification: string | null = null;
  for (const t of texts) {
    unit ??= /unit\s+code\s*(?:&\s*name)?\s*[:-]?\s*([A-Z]{3}[A-Z]{2,4}\d{3,4}[A-Z]?)\b/i.exec(t)?.[1].toUpperCase() ?? null;
    qualification ??= /(?:qualification|course)\s*(?:code)?\s*(?:&\s*name)?\s*[:-]?\s*([A-Z]{3}\d{5})\b/i.exec(t)?.[1].toUpperCase() ?? null;
  }
  return { unit: unit ?? mostCommon(texts, UNIT), qualification: qualification ?? mostCommon(texts, QUAL) };
}

export async function detectWorkbook(bytes: Uint8Array, pdfInfo: { path: string; sha256: string; fileName?: string | null }, onProgress?: (page: number, pages: number) => void): Promise<PdfTemplate> {
  const pdf = await pdfjs();
  const doc = await pdf.getDocument({ data: bytes.slice() }).promise;
  try {
    const models: PageModel[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.(n, doc.numPages);
      models.push(await pageModel(pdf as unknown as PdfJsLike, await doc.getPage(n) as never, n));
    }
    return detectTemplate(models, pdfInfo);
  } finally {
    void (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

// ---------- ASM-ANY-LAYOUT: any workbook layout (rules, layout profile, then the AI only for what is left) ----------
export interface AnyLayoutRun {
  template: PdfTemplate;
  path: "slit" | "generic";
  /** The generic detection (candidates, what is left); null on the SLIT fast path. */
  result: GenericResult | null;
  profile: { signature: string; chrome: string[]; applied: number } | null;
  ai: { pages: number; asked: number; added: number; notFields: number; refused: number; costUsd: number; spentUsd: number; model: string | null; stopped: string | null };
}

/** A page image with each candidate outlined and numbered (what the classifier sees), as a JPEG data URL. */
async function candidateImage(page: unknown, cands: Candidate[]): Promise<{ dataUrl: string; width: number; height: number }> {
  const p = page as { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> } };
  const base = p.getViewport({ scale: 1 });
  const scale = Math.min(2, 1100 / base.width);
  const vp = p.getViewport({ scale });
  const canvas = document.createElement("canvas"); canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.render({ canvasContext: ctx, viewport: vp }).promise;
  for (const c of cands) {
    ctx.strokeStyle = "#e11d48"; ctx.lineWidth = 2; ctx.strokeRect(c.box.x * scale, c.box.y * scale, c.box.w * scale, c.box.h * scale);
    const label = String(c.n); ctx.font = "bold 13px sans-serif"; const w = ctx.measureText(label).width + 6;
    ctx.fillStyle = "#e11d48"; ctx.fillRect(c.box.x * scale, c.box.y * scale - 15, w, 15);
    ctx.fillStyle = "#fff"; ctx.fillText(label, c.box.x * scale + 3, c.box.y * scale - 3);
  }
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.8), width: canvas.width, height: canvas.height };
}

export async function detectWorkbookAny(bytes: Uint8Array, pdfInfo: { path: string; sha256: string; fileName?: string | null }, assessmentId: string,
  onProgress?: (message: string) => void): Promise<AnyLayoutRun> {
  const pdf = await pdfjs();
  const doc = await pdf.getDocument({ data: bytes.slice() }).promise;
  const ai: AnyLayoutRun["ai"] = { pages: 0, asked: 0, added: 0, notFields: 0, refused: 0, costUsd: 0, spentUsd: 0, model: null, stopped: null };
  try {
    const models: PageModel[] = [];
    for (let n = 1; n <= doc.numPages; n++) { onProgress?.(`Reading page ${n} of ${doc.numPages}…`); models.push(await pageModel(pdf as unknown as PdfJsLike, await doc.getPage(n) as never, n)); }
    const first = detectAny(models, pdfInfo);
    if (first.path === "slit") return { template: first.template, path: "slit", result: null, profile: null, ai };
    const result: GenericResult = first;
    // the layout's saved corrections first (no AI for them)
    const chrome = layoutChrome(models); const signature = await layoutSignature(chrome);
    let applied = 0;
    const { data: saved } = await supabase.rpc("asm_layout_profile_get", { p_signature: signature });
    if (saved && typeof saved === "object") applied = applyProfile(result, { signature, chrome, corrections: (saved as { corrections?: Correction[] }).corrections ?? [] });
    // then the classifier, one page at a time, only for pages that still have open areas
    const answers: Record<number, AiAnswer[]> = {};
    const pagesLeft = [...new Set(result.unresolved.map((c) => c.page))].sort((a, b) => a - b);
    for (const n of pagesLeft) {
      onProgress?.(`Asking the AI about page ${n} (${pagesLeft.indexOf(n) + 1} of ${pagesLeft.length})…`);
      const cands = result.unresolved.filter((c) => c.page === n);
      const img = await candidateImage(await doc.getPage(n), cands);
      const pageText = textRows(models[n - 1].texts).map((r) => r.s).join("\n").slice(0, 3000);
      const { data, error } = await supabase.functions.invoke("asm-import", { body: { action: "classify_fields", assessmentId, pdfSha256: pdfInfo.sha256,
        page: { page: n, imageDataUrl: img.dataUrl, imageWidth: img.width, imageHeight: img.height, pageText,
          candidates: cands.map((c) => ({ n: c.n, shape: c.shape, left: c.left, column: c.column, above: c.above, tickLabel: c.tickLabel, placeholder: c.placeholder, table: c.table ? `${c.table.id} row ${c.table.row + 1} col ${c.table.col + 1}` : null })) } } });
      if (error) {
        const body = await (error as { context?: Response }).context?.json?.().catch(() => null) as { error?: string; code?: string; spentUsd?: number } | null;
        ai.stopped = body?.error ?? error.message;
        if (body?.spentUsd != null) ai.spentUsd = body.spentUsd;
        break;
      }
      const r = data as { fields: AiAnswer[]; refused: number; costUsd: number; spentUsd: number; model: string };
      answers[n] = r.fields; ai.pages++; ai.asked += cands.length; ai.refused += r.refused; ai.costUsd += r.costUsd; ai.spentUsd = r.spentUsd; ai.model = r.model;
    }
    const merged = applyClassification(result, answers);
    ai.added = merged.added; ai.notFields = merged.notFields;
    result.template = merged.template;
    return { template: merged.template, path: "generic", result, profile: { signature, chrome, applied }, ai };
  } finally {
    void (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/** Saves what the admin decided on a generic workbook as its layout's profile (used by later workbooks of the same layout). */
export async function saveLayoutProfile(run: AnyLayoutRun, saved: PdfTemplate, assessmentId: string): Promise<number> {
  if (run.path !== "generic" || !run.result || !run.profile) return 0;
  const corrections = correctionsFrom(run.result, saved);
  if (!corrections.length) return 0;
  const { error } = await supabase.rpc("asm_layout_profile_save", { p_signature: run.profile.signature, p_chrome: run.profile.chrome, p_corrections: corrections, p_assessment: assessmentId });
  if (error) throw new Error(error.message);
  return corrections.length;
}

export async function aiUsageSummary(assessmentId: string): Promise<{ calls: number; costUsd: number; inputTokens: number; outputTokens: number; models: string[]; limitUsd: number } | null> {
  const { data, error } = await supabase.rpc("asm_ai_usage_summary", { p_assessment: assessmentId });
  return error ? null : data as never;
}
