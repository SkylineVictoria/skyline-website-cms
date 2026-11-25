/**
 * ASM-AI-IMPORT, browser (and Node tests): the PDF's own text layer, page by page, as the AI import reads it and checks it against.
 * Lines are grouped by baseline; the cells of one line (table columns) are joined with " | ". Headers and footers are kept (the
 * version number is often only in the footer; the worker leaves the repeating ones out of the task calls and the checks). A page with
 * almost no text is marked scanned: the browser draws it to a JPEG and the worker sends that image instead (every item read from it
 * is flagged for review). The pictures found on a page (imageRegionsFromPdf: drawings, plans, photos; logos excluded) are marked
 * with a line [Picture] where they are printed, and counted, so the AI reader places a drawing item for each one.
 */
import { SCANNED_BELOW_CHARS } from "../../../supabase/functions/_shared/asm-import/pipeline.ts";
import type { PdfDocLike, WbImage } from "./workbookImport";

export interface PageTextOut { page: number; text: string; scanned: boolean; pictures: number }

interface Item { str: string; transform: number[]; width: number; height: number }

export const PICTURE_MARK = "[Picture]";

export async function pageTextsFromPdf(doc: PdfDocLike, pictures: Pick<WbImage, "page" | "top">[] = []): Promise<PageTextOut[]> {
  const out: PageTextOut[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = (tc.items as Item[]).filter((i) => typeof i.str === "string" && i.str.trim() !== "");
    const rows: { y: number; items: Item[] }[] = [];
    for (const it of items.slice().sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
      const row = rows.find((r) => Math.abs(r.y - it.transform[5]) <= 2.5);
      if (row) row.items.push(it); else rows.push({ y: it.transform[5], items: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map((r) => {
      const its = r.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const size = Math.max(...its.map((i) => Math.abs(i.height) || Math.abs(i.transform[3]) || 10));
      const cells: string[] = [];
      let prevEnd = -Infinity;
      for (const it of its) {
        const x = it.transform[4];
        const gap = x - prevEnd;
        if (cells.length && gap <= Math.max(8, size * 0.9)) cells[cells.length - 1] += (gap > size * 0.12 && !/\s$/.test(cells[cells.length - 1]) && !/^\s/.test(it.str) ? " " : "") + it.str;
        else cells.push(it.str);
        prevEnd = x + (it.width || it.str.length * size * 0.5);
      }
      return { y: r.y, text: cells.map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ") };
    }).filter((l) => l.text);
    const text = lines.map((l) => l.text).join("\n");
    // the pictures of this page, each marked before the first line printed below its top edge
    const scanned = text.replace(/\s+/g, "").length < SCANNED_BELOW_CHARS;
    const here = scanned ? [] : pictures.filter((x) => x.page === p).sort((a, b) => b.top - a.top); // a scan is one big picture: sent as an image instead
    const marked: string[] = [];
    let k = 0;
    for (const l of lines) {
      while (k < here.length && l.y < here[k].top) { marked.push(PICTURE_MARK); k += 1; }
      marked.push(l.text);
    }
    while (k < here.length) { marked.push(PICTURE_MARK); k += 1; }
    out.push({ page: p, text: marked.join("\n"), scanned, pictures: here.length });
  }
  return out;
}
