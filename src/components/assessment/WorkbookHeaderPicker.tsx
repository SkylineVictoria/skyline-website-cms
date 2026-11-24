/**
 * ASM-HEADER: choose the workbook header picture: upload one (stored in the template-assets bucket) or use the Skyline logo that
 * ships with the site, with a live preview of the header as the workbook prints it. Used by Assessments > Settings and, once, by
 * the Add assessment wizard while no header is set. Saving tells every open preview (saveWorkbookHeader).
 */
import { useState } from "react";
import { uploadTemplateAsset } from "@/lib/offerLetters";
import { DEFAULT_WORKBOOK_HEADER, saveWorkbookHeader, WORKBOOK_HEADER_HINT, WORKBOOK_HEADER_MAX_BYTES, type WorkbookLetterhead } from "@/lib/assessment/workbookExport";
import { WorkbookHeader } from "./WorkbookTables";

const BTN = "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-60";

/** Width and height of a picture file, to say when it is smaller than recommended. */
const pictureSize = (file: File) => new Promise<{ w: number; h: number } | null>((resolve) => {
  const url = URL.createObjectURL(file); const img = new Image();
  img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
  img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
  img.src = url;
});

export default function WorkbookHeaderPicker({ head, current, onSaved, title = "Workbook header" }: {
  /** The address block (and the current picture) for the preview. */
  head: WorkbookLetterhead | null;
  /** The picture set now (null: none yet). */
  current: string | null;
  onSaved?: (url: string | null) => void;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const shown = current ?? head?.logoUrl ?? DEFAULT_WORKBOOK_HEADER;

  const save = async (url: string) => {
    setBusy(true); setError("");
    try { const saved = await saveWorkbookHeader(url); onSaved?.(saved); }
    catch (e) { setError(e instanceof Error ? e.message : "The header was not saved."); }
    finally { setBusy(false); }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setNote(""); setError("");
    if (!/^image\/(png|jpeg)$/.test(file.type)) { setError("Use a PNG or JPEG picture."); return; }
    if (file.size > WORKBOOK_HEADER_MAX_BYTES) { setError("The picture is larger than 1 MB: the PDF could not include it. Save a smaller PNG."); return; }
    const size = await pictureSize(file);
    if (size && (size.w < 1200 || size.h < 300)) setNote(`This picture is ${size.w} × ${size.h} px; at least 1200 × 300 px prints sharper.`);
    setBusy(true);
    try { await save(await uploadTemplateAsset(file)); }
    catch (e) { setError(e instanceof Error ? e.message : "The picture was not uploaded."); setBusy(false); }
  };

  return (
    <section className="space-y-3 rounded-lg border border-background-200 bg-background-50 p-4" data-testid="workbook-header-picker">
      <div>
        <p className="font-heading text-sm font-semibold text-foreground-950">{title}</p>
        <p className="mt-0.5 text-xs text-foreground-600">The picture on the left of every workbook page and on the cover: the Review step, the student view and “Export as workbook PDF”. The address on the right comes from Website Settings.</p>
        <p className="mt-1 text-xs font-medium text-foreground-700" data-testid="workbook-header-hint">Recommended: {WORKBOOK_HEADER_HINT}.</p>
      </div>
      <div className="rounded-md border border-background-200 bg-white p-4" aria-label="Header preview">
        <WorkbookHeader head={head ? { ...head, logoUrl: shown } : { name: "", lines: [], logoUrl: shown }} />
        <p className="pt-2 text-[11px] text-neutral-400">{current ? (current === DEFAULT_WORKBOOK_HEADER ? "Using the Skyline logo that ships with the site." : "Using the uploaded header.") : "No header set yet: the Skyline logo is used until you choose one."}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className={BTN} aria-disabled={busy}>
          <i className="ri-upload-2-line" aria-hidden="true" />{current && current !== DEFAULT_WORKBOOK_HEADER ? "Replace header picture" : "Upload header picture"}
          <input type="file" accept="image/png,image/jpeg" className="sr-only" disabled={busy} data-testid="workbook-header-file" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <button type="button" className={BTN} disabled={busy || current === DEFAULT_WORKBOOK_HEADER} onClick={() => void save(DEFAULT_WORKBOOK_HEADER)}><i className="ri-image-line" aria-hidden="true" />Use current Skyline logo</button>
        {busy ? <span className="text-xs text-foreground-500" role="status"><i className="ri-loader-4-line mr-1 animate-spin" aria-hidden="true" />Saving…</span> : null}
      </div>
      {note ? <p className="text-xs text-amber-800" role="status">{note}</p> : null}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </section>
  );
}
