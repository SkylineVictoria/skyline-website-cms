/**
 * ASM-AI-IMPORT, browser side: the workbook / answer guide is read for the AI import and, at the same time, by the standard reader
 * (workbookImport.ts) so the fallback is ready the moment the AI fails, times out or is skipped.
 *
 *   prepare(file)    fingerprint (SHA-256), the PDF's own text page by page, pages with no text drawn to JPEG, the standard reader's
 *                    result and the workbook's pictures.
 *   startAiImport()  asm_import_start (the finished import of the same file comes back at once: cached, no cost) -> upload into
 *                    asm-imports/<job>/ -> asm_import_queue; then watchImport() polls asm_import_status for live progress.
 *   definitionFromAi() / guideAnswersFrom*() / applyGuide(): the draft definition and the assessor keys (asm_question_keys only).
 *
 * Only the workbook and the answer guide are uploaded; never student data. The AI does not mark.
 */
import { supabase } from "@/pages/admin/lib/supabase";
import { buildFromLines, imageRegionsFromPdf, linesFromPdf, type ImportResult, type PdfDocLike, type PdfOps, type WbImage } from "./workbookImport";
import { pageTextsFromPdf, type PageTextOut } from "./pageText";

import type { ImportKind, ImportStatus } from "./aiDraft";
export * from "./aiDraft";

export interface Prepared {
  file: File;
  bytes: Uint8Array;
  sha256: string;
  pages: PageTextOut[];
  /** JPEGs of the pages with no text layer (sent to a vision model; every item from them is flagged). */
  scannedImages: Map<number, Blob>;
  /** The standard reader's result: the fallback, and the pictures for the AI's drawings. */
  parser: ImportResult;
  images: WbImage[];
}

const MAX_IMAGE_PX = 1600;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface RenderablePage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown; canvas: HTMLCanvasElement }) => { promise: Promise<void> };
}

async function renderPageJpeg(doc: { getPage: (n: number) => Promise<unknown> }, n: number): Promise<Blob | null> {
  try {
    const page = (await doc.getPage(n)) as RenderablePage;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, MAX_IMAGE_PX / Math.max(1, base.width)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d"); if (!ctx) return null;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
    canvas.width = 0; canvas.height = 0;
    // an empty page (white) is not a scan: a few KB of JPEG
    return blob && blob.size > 12_000 ? blob : null;
  } catch { return null; }
}

/** Reads a PDF once for both readers. Word files use the standard reader only (the AI import reads a PDF's text layer). */
export async function prepare(file: File, renderRegions: (doc: unknown, regions: Omit<WbImage, "src">[]) => Promise<WbImage[]>): Promise<Prepared> {
  if (!file.name.toLowerCase().endsWith(".pdf")) throw new Error("not-pdf");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const [pdf, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
  pdf.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdf.getDocument({ data: bytes.slice() }).promise;
  try {
    const sha256 = await sha256Hex(bytes);
    const pages = await pageTextsFromPdf(doc as unknown as PdfDocLike);
    const scannedImages = new Map<number, Blob>();
    for (const p of pages.filter((x) => x.scanned).slice(0, 40)) {
      const jpeg = await renderPageJpeg(doc, p.page);
      if (jpeg) scannedImages.set(p.page, jpeg); else p.scanned = false; // a blank page: nothing to read
    }
    let images: WbImage[] = [];
    try { images = await renderRegions(doc, await imageRegionsFromPdf(doc, pdf.OPS as unknown as PdfOps)); } catch { images = []; }
    const { lines, version } = await linesFromPdf(doc as unknown as PdfDocLike);
    const parser = buildFromLines(lines, { fileName: file.name, images, version });
    return { file, bytes, sha256, pages, scannedImages, parser, images };
  } finally { void doc.cleanup(); }
}

const rpcError = (e: { message?: string } | null, fallback: string) => new Error(e?.message || fallback);

/** Starts (or finds) the AI import of a prepared file. */
export async function startAiImport(kind: ImportKind, p: Prepared, opts: { force?: boolean } = {}): Promise<ImportStatus> {
  const scanned = p.pages.filter((x) => x.scanned).map((x) => x.page);
  const { data, error } = await supabase.rpc("asm_import_start", { p_kind: kind, p_sha256: p.sha256, p_file_name: p.file.name, p_bytes: p.bytes.byteLength, p_pages: p.pages.length, p_scanned: scanned, p_force: Boolean(opts.force) });
  if (error) throw rpcError(error, "The AI import could not start.");
  const job = data as ImportStatus;
  if (job.state !== "uploading") return job;
  const bucket = supabase.storage.from("asm-imports");
  const put = async (name: string, body: Blob | Uint8Array, contentType: string) => {
    const { error: e } = await bucket.upload(`${job.id}/${name}`, body, { contentType, upsert: false });
    if (e) throw new Error(`The upload failed (${name}): ${e.message}`);
  };
  await put("source.pdf", new Blob([p.bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }), "application/pdf");
  await put("pages.json", new Blob([JSON.stringify(p.pages)], { type: "application/json" }), "application/json");
  for (const [n, jpeg] of p.scannedImages) await put(`page-${n}.jpg`, jpeg, "image/jpeg");
  const queued = await supabase.rpc("asm_import_queue", { p_id: job.id });
  if (queued.error) throw rpcError(queued.error, "The AI import could not be queued.");
  return queued.data as ImportStatus;
}

export async function importStatus(id: string): Promise<ImportStatus> {
  const { data, error } = await supabase.rpc("asm_import_status", { p_id: id });
  if (error) throw rpcError(error, "The import status could not be read.");
  return data as ImportStatus;
}

/**
 * Polls until done / failed, calling `onUpdate` on every change. Resolves with the last status; a job that shows no progress for
 * `stallMs` (default 4 minutes) or runs past `timeoutMs` (default 12 minutes) resolves as timed out (the caller falls back).
 */
export async function watchImport(id: string, onUpdate: (s: ImportStatus) => void, signal: AbortSignal, opts: { stallMs?: number; timeoutMs?: number; everyMs?: number } = {}): Promise<{ status: ImportStatus | null; timedOut: boolean }> {
  const start = Date.now();
  let last: ImportStatus | null = null; let lastChange = Date.now(); let key = "";
  while (!signal.aborted) {
    try {
      const s = await importStatus(id);
      const k = `${s.state}|${s.progress?.done}|${s.progress?.label}`;
      if (k !== key) { key = k; lastChange = Date.now(); }
      last = s; onUpdate(s);
      if (s.state === "done" || s.state === "failed") return { status: s, timedOut: false };
    } catch { /* a missed poll is retried */ }
    if (Date.now() - lastChange > (opts.stallMs ?? 240_000) || Date.now() - start > (opts.timeoutMs ?? 720_000)) return { status: last, timedOut: true };
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 1500));
  }
  return { status: last, timedOut: false };
}

