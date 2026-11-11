// The offer letter as a PDF, made from a filled-in template (HRMS > Templates), on the shared Skyline PDF styling (notification/pdf-layout.ts:
// the same Noto Sans text, letterhead header, primary colour, margins and "Page x of y" footer as the submitted application PDF). Runtime-neutral
// (Deno Edge Function and the offline tests run the same code; pdf-lib comes from the function's import map or node_modules). Real, selectable
// text; the signature page is added to this file later by stampSignedOffer.
import { PdfWriter, type Para, type Span } from "./notification/pdf-layout.ts";
import { formatDateOnly, resolvePrimary } from "./notification/submission-pdf.ts";
import { templateBlocks, type TemplateBlock } from "./hr-template.ts";
import { DEFAULT_INSTITUTION, type Letterhead } from "./letterhead.ts";

export const MAX_LETTER_PAGES = 30;
const SIZE: Record<TemplateBlock["type"], number> = { h1: 16, h2: 13, h3: 11.5, h4: 10.5, p: 9.5, li: 9.5, quote: 9.5, hr: 9.5 };
const GAP: Record<TemplateBlock["type"], number> = { h1: 8, h2: 6, h3: 5, h4: 4, p: 7, li: 2, quote: 7, hr: 0 };

/** The palette the writer draws with, from the letterhead's primary colour (the Skyline orange when none is set or it is invalid). */
export function paletteOf(primary: string | null | undefined): { primary: [number, number, number]; tint: [number, number, number] } {
  const resolved = resolvePrimary(primary);
  return { primary: resolved.rgb.map((v) => v / 255) as [number, number, number], tint: resolved.tint.map((v) => v / 255) as [number, number, number] };
}

/** A template block as a paragraph the writer lays out: bold / underline / strike per run, a link's address after its text, markers for lists. */
function paraOf(block: TemplateBlock): Para {
  const spans: Span[] = block.runs.map((run) => {
    const linkTail = run.href && run.href !== run.text.trim() && !run.text.includes(run.href) ? ` (${run.href})` : "";
    return { text: run.text + linkTail, ...(run.href ? { url: run.href } : {}), ...(run.underline && !run.href ? { underline: true } : {}), ...(run.strike ? { strike: true } : {}) };
  });
  const heading = /^h[1-4]$/.test(block.type);
  return {
    spans, size: SIZE[block.type], bold: heading || (block.runs.length > 0 && block.runs.every((r) => r.bold)),
    align: block.align === "center" ? "center" : block.align === "right" ? "right" : "left",
    ...(block.type === "li" ? { indent: 16 + 14 * (block.depth ?? 0), marker: block.marker ?? "•" } : {}),
    ...(block.type === "quote" ? { quote: true } : {}),
    ...(heading ? { keepWithNext: true } : {}),
  };
}

/**
 * Lays the sanitised, filled-in letter out on A4 pages with the shared letterhead: headings, paragraphs, bullet and numbered lists, quotes,
 * rules, bold / underline / strike, links (underlined, with the address after the text when it differs) and left / centre / right alignment.
 * Italic text is set in the regular face (the embedded Noto Sans has no italic). Throws when the letter is empty or longer than MAX_LETTER_PAGES.
 */
/**
 * The texts the embedded font cannot set as typed (a character that would be folded or printed as "?"), or null when every one prints as
 * it is. For callers that must refuse rather than alter (document signing: the signer's typed name, a template's text).
 */
let checker: Promise<PdfWriter> | null = null;
export async function unsupportedText(texts: string[]): Promise<string | null> {
  // One writer per isolate: only its character sets are read (a signature used to embed both fonts once more just for this check).
  checker ??= PdfWriter.create("check", paletteOf(null));
  const writer = await checker.catch((error) => { checker = null; throw error; });
  return texts.find((t) => writer.clean(t) !== t || writer.clean(t, true) !== t) ?? null;
}

export async function buildLetterPdf(input: { title: string; html: string; footer?: string; letterhead?: Letterhead | null; date?: string | null; kind?: string }): Promise<{ bytes: Uint8Array; pages: number }> {
  const blocks = templateBlocks(input.html);
  if (!blocks.some((b) => b.runs.length > 0)) throw new Error("The letter is empty.");
  const institution = input.letterhead?.institution?.trim() || input.footer?.trim() || DEFAULT_INSTITUTION;
  const writer = await PdfWriter.create(input.title.slice(0, 200), paletteOf(input.letterhead?.primary));
  let logo = input.letterhead?.logo ?? null;
  if (logo) { try { await writer.prepareImage(logo); } catch { logo = null; } }
  const date = formatDateOnly(input.date ?? new Date().toISOString().slice(0, 10));
  writer.header({ institution, logo, title: input.title, meta: [input.kind ?? "Offer letter", date] });

  // Blocks flow in runs between horizontal rules, so a rule is drawn where the letter puts it.
  let run: Para[] = [];
  const flush = () => { if (run.length) { writer.flow(run.map((p) => p), 0); run = []; } };
  for (const block of blocks) {
    if (writer.truncated) break;
    if (block.type === "hr") { flush(); writer.divider(); continue; }
    const para = paraOf(block);
    run.push(para);
    // The gap after a block is part of its paragraph: flow() takes one gap for all, so add it as a trailing empty line instead.
    run.push({ spans: [{ text: "" }], size: GAP[block.type] / 1.42 });
  }
  flush();
  if (writer.pageCount > MAX_LETTER_PAGES || writer.truncated) throw new Error(`The letter is longer than ${MAX_LETTER_PAGES} pages.`);
  writer.footers(institution, input.title);
  return { bytes: await writer.save(), pages: writer.pageCount };
}

export { letterFileName } from "./offer-rules.ts";
