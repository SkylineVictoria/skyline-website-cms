// The offer letter as a PDF, made from a filled-in template (HRMS > Templates). Runtime-neutral like offer-pdf.ts: pdf-lib 1.17.1
// is passed in, so the Edge Function and the offline tests run the same code. A4 pages, the standard Helvetica fonts, real text
// (selectable, and safe to sign: the signature page is added to this file later by stampSignedOffer).
import type { PdfLib } from "./offer-pdf.ts";
import { templateBlocks, type TemplateBlock, type TemplateRun } from "./hr-template.ts";

const PAGE: [number, number] = [595.28, 841.89];
const MARGIN_X = 62, MARGIN_TOP = 70, MARGIN_BOTTOM = 68;
const SIZE: Record<TemplateBlock["type"], number> = { h1: 18, h2: 14.5, h3: 12, h4: 11, p: 10.5, li: 10.5, quote: 10.5, hr: 10.5 };
const GAP_AFTER: Record<TemplateBlock["type"], number> = { h1: 10, h2: 8, h3: 6, h4: 5, p: 8, li: 3, quote: 8, hr: 10 };
const LINE = 1.42;
export const MAX_LETTER_PAGES = 30;

// The standard fonts are WinAnsi: these punctuation marks exist there, everything else outside Latin-1 is folded or replaced.
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
/** Text the standard PDF fonts can draw: Latin-1 and the WinAnsi punctuation stay, accents on other letters are dropped, the rest becomes "?". */
export function winAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) { out += ch; continue; }
    if (ch === "\n" || ch === "\t" || code === 0x200b) { out += ch === "\n" ? "\n" : " "; continue; }
    const folded = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += folded && [...folded].every((c) => { const k = c.codePointAt(0)!; return (k >= 0x20 && k <= 0x7e) || (k >= 0xa0 && k <= 0xff); }) ? folded : "?";
  }
  return out;
}

interface Word { text: string; run: TemplateRun; width: number; spaceBefore: boolean }

/**
 * Lays the sanitised, filled-in letter out on A4 pages: headings, paragraphs, bullet and numbered lists, quotes, rules, bold /
 * italic / underline / strike, links (underlined, with the address after the text when it differs) and left / centre / right
 * alignment. Every page gets "Page x of y" and the footer text. Throws when the letter is empty or longer than MAX_LETTER_PAGES.
 */
export async function buildLetterPdf(lib: PdfLib, input: { title: string; html: string; footer?: string }): Promise<{ bytes: Uint8Array; pages: number }> {
  const blocks = templateBlocks(input.html);
  if (!blocks.some((b) => b.runs.length > 0)) throw new Error("The letter is empty.");
  const doc = await lib.PDFDocument.create();
  const fonts = {
    regular: await doc.embedFont(lib.StandardFonts.Helvetica), bold: await doc.embedFont(lib.StandardFonts.HelveticaBold),
    italic: await doc.embedFont(lib.StandardFonts.HelveticaOblique), boldItalic: await doc.embedFont(lib.StandardFonts.HelveticaBoldOblique),
  };
  const ink = lib.rgb(0.1, 0.1, 0.12), muted = lib.rgb(0.42, 0.42, 0.45), rule = lib.rgb(0.78, 0.78, 0.8);
  const fontOf = (run: TemplateRun) => (run.bold && run.italic ? fonts.boldItalic : run.bold ? fonts.bold : run.italic ? fonts.italic : fonts.regular);
  // deno-lint-ignore no-explicit-any
  const pages: any[] = [];
  let page = doc.addPage(PAGE); pages.push(page);
  let y = PAGE[1] - MARGIN_TOP;
  const newPage = () => {
    if (pages.length >= MAX_LETTER_PAGES) throw new Error(`The letter is longer than ${MAX_LETTER_PAGES} pages.`);
    page = doc.addPage(PAGE); pages.push(page); y = PAGE[1] - MARGIN_TOP;
  };

  for (const block of blocks) {
    const size = SIZE[block.type];
    const lineHeight = size * LINE;
    if (block.type === "hr") {
      if (y - 12 < MARGIN_BOTTOM) newPage();
      page.drawLine({ start: { x: MARGIN_X, y: y - 2 }, end: { x: PAGE[0] - MARGIN_X, y: y - 2 }, thickness: 0.7, color: rule });
      y -= GAP_AFTER.hr + 4;
      continue;
    }
    const indent = block.type === "li" ? 16 + 14 * (block.depth ?? 0) : block.type === "quote" ? 14 : 0;
    const left = MARGIN_X + indent;
    const width = PAGE[0] - MARGIN_X - left;
    // Words with their style; a link shows its address after the text when the text is not the address itself.
    const words: Word[] = [];
    const lines: Word[][] = [[]];
    const push = (text: string, run: TemplateRun, spaceBefore: boolean) => {
      let rest = winAnsi(text);
      const font = fontOf(run);
      // A word wider than the line (a long link) is cut so it never runs off the page.
      while (rest && font.widthOfTextAtSize(rest, size) > width) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
        words.push({ text: rest.slice(0, cut), run, width: font.widthOfTextAtSize(rest.slice(0, cut), size), spaceBefore });
        words.push({ text: "\n", run, width: 0, spaceBefore: false });
        rest = rest.slice(cut); spaceBefore = false;
      }
      if (rest) words.push({ text: rest, run, width: font.widthOfTextAtSize(rest, size), spaceBefore });
    };
    let pendingSpace = false;
    for (const run of block.runs) {
      const linkTail = run.href && run.href !== run.text.trim() && !run.text.includes(run.href) ? ` (${run.href})` : "";
      const parts = (run.text + linkTail).split(/(\n)/);
      for (const part of parts) {
        if (part === "\n") { words.push({ text: "\n", run, width: 0, spaceBefore: false }); pendingSpace = false; continue; }
        const startsWithSpace = /^\s/.test(part), endsWithSpace = /\s$/.test(part);
        const tokens = part.split(/\s+/).filter(Boolean);
        tokens.forEach((token, index) => push(token, run, index === 0 ? pendingSpace || startsWithSpace : true));
        pendingSpace = tokens.length ? endsWithSpace : pendingSpace || startsWithSpace || endsWithSpace;
      }
    }
    let lineWidth = 0;
    for (const word of words) {
      if (word.text === "\n") { lines.push([]); lineWidth = 0; continue; }
      const current = lines[lines.length - 1];
      const space = current.length && word.spaceBefore ? fontOf(word.run).widthOfTextAtSize(" ", size) : 0;
      if (current.length && lineWidth + space + word.width > width) { lines.push([{ ...word, spaceBefore: false }]); lineWidth = word.width; }
      else { current.push({ ...word, spaceBefore: current.length > 0 && word.spaceBefore }); lineWidth += space + word.width; }
    }
    // A heading is kept with at least two lines of what follows.
    const keep = /^h[1-4]$/.test(block.type) ? lineHeight * lines.length + 2 * SIZE.p * LINE : lineHeight;
    if (y - keep < MARGIN_BOTTOM) newPage();
    if (/^h[1-4]$/.test(block.type) && y < PAGE[1] - MARGIN_TOP) y -= 4;
    lines.forEach((line, lineIndex) => {
      if (y - lineHeight < MARGIN_BOTTOM) newPage();
      const total = line.reduce((sum, w, i) => sum + w.width + (i > 0 && w.spaceBefore ? fontOf(w.run).widthOfTextAtSize(" ", size) : 0), 0);
      let x = block.align === "center" ? left + (width - total) / 2 : block.align === "right" ? left + width - total : left;
      const baseline = y - size;
      if (block.type === "li" && lineIndex === 0 && block.marker) {
        const marker = winAnsi(block.marker);
        page.drawText(marker, { x: left - 6 - fonts.regular.widthOfTextAtSize(marker, size), y: baseline, size, font: fonts.regular, color: ink });
      }
      if (block.type === "quote") page.drawLine({ start: { x: MARGIN_X + 3, y: y + 1 }, end: { x: MARGIN_X + 3, y: y - lineHeight + 1 }, thickness: 1.5, color: rule });
      line.forEach((word, i) => {
        const font = fontOf(word.run);
        if (i > 0 && word.spaceBefore) x += font.widthOfTextAtSize(" ", size);
        page.drawText(word.text, { x, y: baseline, size, font, color: block.type === "quote" ? muted : ink });
        const next = line[i + 1];
        const joined = next && next.spaceBefore && next.run === word.run ? fontOf(next.run).widthOfTextAtSize(" ", size) : 0;
        if (word.run.underline) page.drawLine({ start: { x, y: baseline - 1.4 }, end: { x: x + word.width + joined, y: baseline - 1.4 }, thickness: 0.6, color: ink });
        if (word.run.strike) page.drawLine({ start: { x, y: baseline + size * 0.28 }, end: { x: x + word.width + joined, y: baseline + size * 0.28 }, thickness: 0.6, color: ink });
        x += word.width;
      });
      y -= lineHeight;
    });
    y -= GAP_AFTER[block.type];
  }

  const footer = winAnsi(input.footer ?? "").slice(0, 120);
  pages.forEach((p, index) => {
    const label = `Page ${index + 1} of ${pages.length}`;
    p.drawText(label, { x: PAGE[0] - MARGIN_X - fonts.regular.widthOfTextAtSize(label, 8.5), y: 38, size: 8.5, font: fonts.regular, color: muted });
    if (footer) p.drawText(footer, { x: MARGIN_X, y: 38, size: 8.5, font: fonts.regular, color: muted });
  });
  doc.setTitle(winAnsi(input.title).slice(0, 200));
  return { bytes: await doc.save(), pages: pages.length };
}

/** A safe PDF file name for a letter: "Offer of employment - Asha Patel.pdf". */
export function letterFileName(title: string, person: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from a file name
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  const base = [clean(title).slice(0, 100), clean(person).slice(0, 80)].filter(Boolean).join(" - ") || "Offer letter";
  return `${base}.pdf`;
}
