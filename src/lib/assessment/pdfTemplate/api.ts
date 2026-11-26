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
  return (await stampPdf(original, bundle.template, stampValues(bundle, opts), { footer, continuedAtEnd: opts.continuedAtEnd })).bytes;
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
