/**
 * ASM-AI-IMPORT: the verbatim rule. Question and instruction text must be the PDF's own words, never the model's wording.
 *
 * The PDF text layer is read line by line, so a question in a table cell reaches us interleaved with the other columns of the same
 * lines ("Describe the PPE needed  Satisfactory / for cutting concrete."). The check therefore looks for the item's words IN ORDER
 * in the page's words, allowing a few foreign words between two of them (another column), after normalising whitespace, quotes,
 * dashes, ligatures and invisible characters. Nothing is ever rewritten: a mismatch goes on the "Check this" list with the closest
 * PDF wording for the admin to compare.
 */
const ZERO_WIDTH = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

/** Whitespace, quotes, dashes, bullets, ligatures and invisible characters normalised; case kept. */
export function normText(s: string): string {
  return s.normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2022\u25cf\u25aa\u25a0\u2023\u2043\u25e6\uf0b7\uf0a7]/g, " ")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words for comparison: table separators dropped, trailing punctuation kept apart so "circuit." matches "circuit ." */
export function words(s: string): string[] {
  return normText(s).split(" ").flatMap((w) => {
    if (w === "|" || w === "") return [];
    const m = /^(.*?)([.,;:!?]+)$/.exec(w);
    return m && m[1] ? [m[1], m[2]] : [w];
  });
}

const fold = (w: string) => w.toLowerCase();

export interface VerbatimResult {
  /** exact: every word in order; close: 85 % or more in order (differs a little); missing: not the PDF's wording. */
  status: "exact" | "close" | "missing" | "empty";
  /** Share of the item's words found in order (0..1). */
  coverage: number;
  /** The PDF's words around the best place found, for the admin to compare (normalised whitespace). */
  pdfText: string | null;
}

/** Longest in-order run of `item` words inside `source` words, allowing up to `gap` foreign words between two matches. */
function bestRun(item: string[], source: string[], gap: number): { found: number; start: number; end: number } {
  const it = item.map(fold);
  const src = source.map(fold);
  let best = { found: 0, start: -1, end: -1 };
  for (let s = 0; s < src.length; s++) {
    if (src[s] !== it[0] && (it.length < 2 || src[s] !== it[1])) continue;
    let i = src[s] === it[0] ? 0 : 1;
    let j = s;
    let found = 0;
    let last = s;
    let skipped = i; // items skipped (a missing first word)
    while (i < it.length && j < src.length) {
      if (src[j] === it[i]) { found += 1; last = j; i += 1; j += 1; continue; }
      // look ahead a little in the source for this word (a foreign column word), else skip the item word (model wording)
      let k = j + 1;
      while (k < src.length && k - j <= gap && src[k] !== it[i]) k += 1;
      if (k < src.length && k - j <= gap && src[k] === it[i]) { j = k; continue; }
      i += 1; skipped += 1;
      if (skipped > Math.max(2, Math.ceil(it.length * 0.25))) break;
    }
    if (found > best.found) best = { found, start: s, end: last };
    if (found === it.length) break;
  }
  return best;
}

/**
 * Checks an item's text against the text of the pages it came from.
 * `exact` also requires that the words are found close together (no more than `gap` foreign words between two of them).
 */
export function checkVerbatim(text: string, pageTexts: string[], gap = 8): VerbatimResult {
  const item = words(text);
  if (!item.length) return { status: "empty", coverage: 0, pdfText: null };
  let best: { found: number; start: number; end: number; src: string[] } = { found: 0, start: -1, end: -1, src: [] };
  for (const page of pageTexts) {
    const src = words(page);
    const run = bestRun(item, src, gap);
    if (run.found > best.found) best = { ...run, src };
    if (best.found === item.length) break;
  }
  // a question can run over a page break: try the pages joined
  if (best.found < item.length && pageTexts.length > 1) {
    const src = words(pageTexts.join(" "));
    const run = bestRun(item, src, gap);
    if (run.found > best.found) best = { ...run, src };
  }
  const coverage = best.found / item.length;
  const pdfText = best.start >= 0 ? best.src.slice(best.start, Math.min(best.src.length, best.end + 1)).join(" ").replace(/ ([.,;:!?])/g, "$1") : null;
  if (best.found === item.length) return { status: "exact", coverage: 1, pdfText };
  if (coverage >= 0.85) return { status: "close", coverage, pdfText };
  return { status: "missing", coverage, pdfText };
}

/** Bag-of-words similarity (Dice, 0..1) used to suggest a match by content. */
export function similarity(a: string, b: string): number {
  const stop = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "be", "with", "your", "you", "what", "how", "why", "which", "this", "that", "it", "as", "by", "at", "from"]);
  const bag = (s: string) => words(s).map(fold).filter((w) => w.length > 1 && !/^[.,;:!?]+$/.test(w) && !stop.has(w));
  const x = bag(a); const y = bag(b);
  if (!x.length || !y.length) return 0;
  const counts = new Map<string, number>();
  for (const w of x) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of y) { const n = counts.get(w) ?? 0; if (n > 0) { common += 1; counts.set(w, n - 1); } }
  return (2 * common) / (x.length + y.length);
}
