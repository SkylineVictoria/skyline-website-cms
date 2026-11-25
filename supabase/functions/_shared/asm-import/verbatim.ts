/**
 * ASM-AI-IMPORT: the verbatim rule. Question and instruction text must be the PDF's own words, never the model's wording.
 *
 * Formatting is never a difference. Before comparing, both sides are put in the same form (compareTokens):
 *   - quotes, dashes, bullets, ligatures (ﬁ ﬂ), non-breaking spaces, soft hyphens and zero-width characters normalised (normText);
 *   - a word broken over a line with a hyphen or a slash joined ("role-\nplays" = "role-plays" = "roleplays", "MATLAB/ AUTOCAD");
 *   - case and punctuation ignored (words are compared by their letters and digits only);
 *   - the item's own number ("1.2", "a.", "Q3") left out at the start of the text.
 * The page text it is compared with has the repeating page headers / footers taken out first (stripRunningText), and the pages
 * are read as one text, so a question that runs over a page break reads as one.
 *
 * The PDF text layer is read line by line, so a question in a table cell reaches us interleaved with the other cells of the same
 * lines ("Assessment description | This assessment task is … you are / (What?) / required to …"). The match runs in three steps:
 *   1. run: the item's words are a run of the page's words (the common case);
 *   2. in order: the item's words appear in order with other cells' words between them;
 *   3. reflowed: every word of the item sits in a short stretch of the page in another order (a cell's second line printed among
 *      the next cell's lines).
 * Words of the page skipped inside the stretch are accepted as other cells only in a table (a line with cells in the stretch), only
 * when they are whole line / cell pieces and never more than LONG_RUN in a row; anything else is text the model left out.
 * When every word is found that way the text IS the PDF's (status exact) and the PDF's own spelling and punctuation are returned
 * (`text`) for the caller to use. Only real wording differences, text the model added and text it left out are reported (close /
 * missing), with what differs (`diff`).
 */
const ZERO_WIDTH = /[­​-‏⁠﻿]/g;

/** Whitespace, quotes, dashes, bullets, ligatures and invisible characters normalised; case kept. */
export function normText(s: string): string {
  return s.normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ") // control characters (a bullet glyph with no Unicode reads as NUL)
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[•●▪■‣⁃◦-]/g, " ") // bullets, and symbol-font glyphs (private use: ,  …)
    .replace(/…/g, "...")
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

/** A word in comparison form: lower case, letters and digits only ("(What?)" -> "what", "role-plays" -> "roleplays"). */
export const core = (w: string) => w.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * A word of a text: `raw` keeps the PDF's own spelling and punctuation, `core` is the comparison form (empty for "|" and bullets),
 * `start` / `end`: the word begins / ends a line or a table cell.
 */
export interface Tok { raw: string; core: string; start: boolean; end: boolean; line: number }

const JOINS = /[\p{L}\p{N}][-/]$/u;

/**
 * The words of a text in comparison form. A word that ends in a hyphen or a slash is joined to the next one (a line break inside a
 * word or a path: "role- plays", "GeoGebra/MATLAB/ AUTOCAD/"); separators ("|") and punctuation-only marks are kept with an empty
 * comparison form (bullets are put back when the PDF's text is used).
 */
export function compareTokens(s: string): Tok[] {
  const lines = s.split("\n").map((l) => normText(l).split(" ").filter(Boolean)).filter((l) => l.length);
  const flat: { raw: string; start: boolean; end: boolean; line: number }[] = [];
  lines.forEach((l, n) => l.forEach((raw, i) => flat.push({ raw, start: i === 0 || l[i - 1] === "|", end: i === l.length - 1 || l[i + 1] === "|", line: n })));
  const out: Tok[] = [];
  for (let i = 0; i < flat.length; i++) {
    const t = { ...flat[i] };
    // the raw text keeps the PDF's spacing: at the end of a line the word goes on ("role-" / "plays", "MATLAB/" / "AUTOCAD/");
    // inside a line the space stays ("AUTOCAD/ Handwritten"). Only a word or a number is joined on, never "(What".
    let lastLine = t.line;
    while (JOINS.test(t.raw) && i + 1 < flat.length && /^[\p{L}\p{N}]/u.test(flat[i + 1].raw)) {
      const lineBreak = flat[i + 1].line !== lastLine;
      t.raw += (lineBreak ? "" : " ") + flat[i + 1].raw; t.end = flat[i + 1].end; lastLine = flat[i + 1].line; i += 1;
    }
    out.push({ ...t, core: core(t.raw) });
  }
  return out;
}

/** The item's own number at the start of its text ("1.2", "Q1.2:", "a.", "(iv)", "Question 3 -") is not part of the wording. */
export function stripLeadingNumber(s: string): string {
  return s.replace(/^\s*(?:(?:question|q)\s*)?(?:\d{1,3}(?:\.\d{1,3})*[a-z]?|[a-z]|[ivx]{1,5})(?:[.):]|\s+-)\s+(?=\S)/i, "")
    .replace(/^\s*\d{1,3}(?:\.\d{1,3})+[a-z]?\s+(?=\S)/i, "")
    .replace(/^\s*\((?:\d{1,3}|[a-z]|[ivx]{1,5})\)\s+(?=\S)/i, "")
    .replace(/^\s*(?:question|q)\s*\d{1,3}(?:\.\d{1,3})*[a-z]?\s+(?=\S)/i, "");
}

/* ------------------------------------------------------------------ running headers and footers */

const RUNNING_TOP = 7;
const RUNNING_BOTTOM = 4;
const mask = (line: string) => normText(line).toLowerCase().replace(/\d+/g, "#");
const PICTURE_LINE = /^\[picture\]$/i;

/**
 * Pages with their repeating headers and footers removed (logo text, address block, "Version Number / Unit Code / Page x of y"):
 * a line near the top or the bottom of a page whose text (digits ignored) is near the top or bottom of at least 40 % of the pages
 * (and 3 pages). Picture markers ([Picture]) go too. Lines inside the page are never touched, so a table heading repeated on many
 * pages stays.
 */
export function stripRunningText<T extends { page: number; text: string; scanned?: boolean }>(pages: T[], opts: { keepPictures?: boolean } = {}): T[] {
  const withText = pages.filter((p) => !p.scanned && p.text.trim());
  // a header / footer line sits at the same place on every page: the same line counted from the top (or from the bottom), with
  // the same text (digits ignored). Repeated content ("Model answer: …" on every page of a guide) moves about and is never taken.
  // a line can be in both zones of a short page: it has both places (from the top and from the bottom)
  const slotsOf = (i: number, n: number) => [...(i < RUNNING_TOP ? [`t${i}`] : []), ...(n - 1 - i < RUNNING_BOTTOM ? [`b${n - 1 - i}`] : [])];
  const textLines = (p: { text: string }) => p.text.split("\n").filter((l) => !PICTURE_LINE.test(l.trim()));
  const seen = new Map<string, string[]>();
  for (const p of withText) {
    const lines = textLines(p);
    lines.forEach((l, i) => { const t = normText(l); if (!t) return; for (const slot of slotsOf(i, lines.length)) { const key = `${slot}|${mask(t)}`; seen.set(key, [...(seen.get(key) ?? []), t]); } });
  }
  const need = Math.max(3, Math.ceil(withText.length * 0.4));
  // the same line on many pages, where at most one number changes (the page number); "Q12 | Q2.2.1 | Satisfactory" on many
  // pages changes two numbers from page to page, so a question's table heading is never taken for a header
  const oneNumberVaries = (lines: string[]) => {
    const nums = lines.map((l) => l.match(/\d+/g) ?? []);
    const varying = (nums[0] ?? []).filter((_, i) => nums.some((n) => n[i] !== nums[0][i])).length;
    return varying <= 1;
  };
  const running = new Set([...seen].filter(([, ls]) => ls.length >= need && oneNumberVaries(ls)).map(([key]) => key));
  return pages.map((p) => {
    const all = p.text.split("\n");
    const n = textLines(p).length;
    let i = -1;
    const keep = all.filter((l) => {
      if (PICTURE_LINE.test(l.trim())) return Boolean(opts.keepPictures);
      i += 1;
      const m = mask(normText(l));
      return !slotsOf(i, n).some((slot) => running.has(`${slot}|${m}`));
    });
    return { ...p, text: keep.join("\n") };
  });
}

/* ------------------------------------------------------------------ the match */

export interface VerbatimResult {
  /** exact: the PDF's words (formatting aside); close: 85 % or more of the words (a small wording difference); missing: not the PDF's wording. */
  status: "exact" | "close" | "missing" | "empty";
  /** Share of the item's words found (0..1). */
  coverage: number;
  /** Where the words were found: one run, in order between other cells' words, or reflowed from table cells. */
  layout: "run" | "columns" | "reflowed" | null;
  /** exact: the item's text in the PDF's own spelling and punctuation (in reading order), to use instead of the model's. */
  text: string | null;
  /** The PDF's words around the best place found, for the admin to compare (close / missing). */
  pdfText: string | null;
  /** close / missing: what differs (words the model added, PDF words it left out). */
  diff: { added: string[]; left: string[]; leftPieces?: string[][] } | null;
}

/** Other cells' words allowed between two of the item's words (one line of a table). */
const GAP = 14;
/** A longer run of the page's own words inside the stretch is text the model left out, not another cell. */
const LONG_RUN = 14;
const OPENERS = /^[(["']+$/;
/** A bullet or an opening bracket printed right before a word belongs to it (a dash only when it starts the line or cell). */
const opener = (t: Tok) => !t.core && (OPENERS.test(t.raw) || (t.start && /^[-·•*]+$/.test(t.raw)));

/** An alignment: per item word the source index of its first piece (-1 = not found), and the second piece of a split word. */
interface Align { at: number[]; split: Map<number, number> }

/** The source words skipped inside the matched stretch, as runs; `ok` when every run is another table cell (not the model's omission). */
function skipped(align: Align, src: Tok[]): { ok: boolean; omitted: string[]; pieces: string[][] } {
  const hits = align.at.filter((k) => k >= 0);
  if (!hits.length) return { ok: false, omitted: [], pieces: [] };
  const lo = Math.min(...hits); const hi = Math.max(...hits, ...align.split.values());
  const used = new Set([...hits, ...align.split.values()]);
  const tabular = isTable(src, lo, hi);
  // the skipped words, piece by piece (one cell on one line); a whole piece in a table is another cell, unless a long stretch of
  // them in a row (more than LONG_RUN words with none of the item's) shows text the model left out
  const omitted = new Set<number>();
  let piece: number[] = []; let row: number[] = [];
  const closePiece = () => {
    if (piece.length && !(tabular && src[piece[0]].start && src[piece[piece.length - 1]].end)) piece.forEach((k) => omitted.add(k));
    piece = [];
  };
  const closeRow = () => { if (row.length > LONG_RUN) row.forEach((k) => omitted.add(k)); row = []; };
  for (let k = lo; k <= hi; k++) {
    if (!src[k].core) continue;
    if (used.has(k)) { closePiece(); closeRow(); continue; }
    if (piece.length && (src[k].start || src[k].line !== src[piece[piece.length - 1]].line)) closePiece();
    piece.push(k); row.push(k);
  }
  closePiece(); closeRow();
  // the left-out words again as pieces (a cell's part of one line), so a whole "Short answer" line can be recognised by the caller
  const sorted = [...omitted].sort((a, b) => a - b);
  const pieces: string[][] = [];
  sorted.forEach((k, i) => {
    const prev = sorted[i - 1];
    const joined = prev !== undefined && src[k].line === src[prev].line && !src[k].start && src.slice(prev + 1, k).every((t) => !t.core);
    if (joined) pieces[pieces.length - 1].push(src[k].raw); else pieces.push([src[k].raw]);
  });
  return { ok: omitted.size === 0, omitted: sorted.map((k) => src[k].raw), pieces };
}

/** Contiguous: the item's words are a run of the source's words. */
function contiguous(it: string[], src: Tok[], idx: number[]): Align | null {
  outer: for (let a = 0; a + it.length <= idx.length; a++) {
    for (let j = 0; j < it.length; j++) if (src[idx[a + j]].core !== it[j]) continue outer;
    return { at: it.map((_, j) => idx[a + j]), split: new Map() };
  }
  return null;
}

/** In order, allowing up to GAP other words between two matches and a word split over two pieces ("Conseque" + "nce"). */
function inOrder(it: string[], src: Tok[], idx: number[]): { align: Align; found: number }[] {
  const s = idx.map((k) => src[k].core);
  const out: { align: Align; found: number }[] = [];
  const starts = new Set(it.slice(0, 3));
  for (let a = 0; a < s.length; a++) {
    if (!starts.has(s[a])) continue;
    const at = it.map(() => -1); const split = new Map<number, number>();
    let i = it.indexOf(s[a]); let j = a; let found = 0; let missed = i;
    while (i < it.length && j < s.length) {
      let hit = -1;
      for (let k = j; k < s.length && k - j <= GAP; k++) {
        if (s[k] === it[i]) { hit = k; break; }
        if (s[k].length >= 2 && it[i].length > s[k].length && it[i].startsWith(s[k])) {
          const rest = it[i].slice(s[k].length);
          for (let r = k + 1; r < s.length && r - k <= GAP + 2; r++) if (s[r] === rest) { hit = k; split.set(i, idx[r]); break; }
          if (hit >= 0) break;
        }
      }
      if (hit >= 0) { at[i] = idx[hit]; found += 1; i += 1; j = hit + 1; continue; }
      i += 1; missed += 1;
      if (missed > Math.max(2, Math.ceil(it.length * 0.25))) break;
    }
    if (found) out.push({ align: { at, split }, found });
  }
  return out.sort((x, y) => y.found - x.found);
}

/** A table: a line of the stretch (from the first word's line to the last word's) has cells. */
function isTable(src: Tok[], lo: number, hi: number): boolean {
  const from = src[lo].line; const to = src[hi].line;
  for (let k = lo; k >= 0 && src[k].line >= from; k--) if (src[k].raw === "|") return true;
  for (let k = lo; k < src.length && src[k].line <= to; k++) if (src[k].raw === "|") return true;
  return false;
}

const bagOf = (ws: string[]) => { const m = new Map<string, number>(); for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1); return m; };

/**
 * Reflowed table cells: the item is made of whole cell pieces (a cell's part of one line) of a short stretch, in any order, and every
 * other piece in the stretch is another cell's. Pieces holding a word the item does not have are other cells; among the rest the
 * pieces whose words add up exactly to the item's words are chosen (a small search: "Risk" in two cells of a row goes to the right
 * one). A word split over two lines of a narrow cell ("Conseque" / "nce", "Implement" / "ed") counts as its two pieces.
 */
function reflowed(it: string[], src: Tok[], idx: number[]): Align | null {
  // the item's words, with a word the source only has in two pieces split into them
  const have = new Set(idx.map((k) => src[k].core));
  const words: { core: string; item: number; second: boolean }[] = [];
  it.forEach((w, i) => {
    if (!have.has(w)) for (let cut = 2; cut <= w.length - 2; cut++) if (have.has(w.slice(0, cut)) && have.has(w.slice(cut))) { words.push({ core: w.slice(0, cut), item: i, second: false }, { core: w.slice(cut), item: i, second: true }); return; }
    words.push({ core: w, item: i, second: false });
  });
  const need = bagOf(words.map((w) => w.core));
  const total = words.length;
  // pieces: runs of words of one cell on one line
  const pieces: { toks: number[]; bag: Map<string, number>; fits: boolean }[] = [];
  for (const k of idx) {
    const last = pieces[pieces.length - 1];
    if (!last || src[k].start || src[k].line !== src[last.toks[last.toks.length - 1]].line) pieces.push({ toks: [k], bag: new Map(), fits: true }); else last.toks.push(k);
  }
  for (const p of pieces) { p.bag = bagOf(p.toks.map((k) => src[k].core)); p.fits = [...p.bag].every(([w, n]) => (need.get(w) ?? 0) >= n); }
  const limit = Math.ceil(total * 2.5) + 12;
  let steps = 0;
  let best: { chosen: number[]; span: number } | null = null;
  for (let a = 0; a < pieces.length && steps < 60_000; a++) {
    if (!pieces[a].fits) continue;
    let size = 0; const cover = new Map<string, number>();
    for (let b = a; b < pieces.length && size <= limit; b++) {
      size += pieces[b].toks.length;
      if (!pieces[b].fits) continue;
      for (const [w, n] of pieces[b].bag) cover.set(w, (cover.get(w) ?? 0) + n);
      if ([...need].some(([w, n]) => (cover.get(w) ?? 0) < n)) continue;
      // every word is available in the stretch: choose the pieces that make up the item exactly
      const cands: number[] = []; for (let k = a; k <= b; k++) if (pieces[k].fits) cands.push(k);
      const left = new Map(need); let leftN = total; const chosen: number[] = [];
      const rest = cands.map((_, i) => cands.slice(i).reduce((n, c) => n + pieces[c].toks.length, 0));
      const dfs = (i: number): boolean => {
        if (leftN === 0) return true;
        if (i >= cands.length || rest[i] < leftN || ++steps > 60_000) return false;
        const p = pieces[cands[i]];
        if ([...p.bag].every(([w, n]) => (left.get(w) ?? 0) >= n)) {
          for (const [w, n] of p.bag) left.set(w, (left.get(w) ?? 0) - n);
          leftN -= p.toks.length; chosen.push(cands[i]);
          if (dfs(i + 1)) return true;
          chosen.pop(); leftN += p.toks.length;
          for (const [w, n] of p.bag) left.set(w, (left.get(w) ?? 0) + n);
        }
        return i > 0 && dfs(i + 1); // the stretch starts with one of the item's pieces
      };
      if (dfs(0)) {
        const span = pieces[chosen[chosen.length - 1]].toks.slice(-1)[0] - pieces[chosen[0]].toks[0];
        if (!best || span < best.span) best = { chosen: [...chosen], span };
      }
      break; // a longer stretch from the same start is never better
    }
  }
  if (!best) return null;
  // each chosen piece goes where its words stand in the item (longest pieces first, so "(Where and in what condition?)" takes the
  // label's "Where", not the next cell's "where"); a single word that fits several places takes the first free one
  const seq = words.map((w) => w.core);
  const slot = seq.map(() => -1);
  const chosen = best.chosen.map((c) => pieces[c]).sort((x, y) => y.toks.length - x.toks.length);
  for (const p of chosen) {
    const cores = p.toks.map((k) => src[k].core);
    let placed = false;
    for (let s = 0; s + cores.length <= seq.length && !placed; s++) {
      if (cores.every((c, j) => slot[s + j] < 0 && seq[s + j] === c)) { p.toks.forEach((k, j) => { slot[s + j] = k; }); placed = true; }
    }
    if (!placed) for (const k of p.toks) { const s = seq.findIndex((c, j) => slot[j] < 0 && c === src[k].core); if (s < 0) return null; slot[s] = k; }
  }
  const at = it.map(() => -1); const split = new Map<number, number>();
  words.forEach((w, j) => { if (w.second) split.set(w.item, slot[j]); else at[w.item] = slot[j]; });
  if (at.some((k) => k < 0)) return null;
  const align = { at, split };
  return skipped(align, src).ok ? align : null;
}

/**
 * The item's text rebuilt from the PDF's own words, in the item's reading order: item words that follow each other in the PDF make
 * one run, printed as the PDF prints it (its punctuation and signs such as & + –, a bullet or bracket before it); separators dropped.
 */
function rebuild(align: Align, src: Tok[]): string {
  const nextWord = (k: number) => { for (let j = k + 1; j < src.length; j++) if (src[j].core) return j; return -1; };
  const order = align.at.map((k, i) => ({ k, i })).filter((x) => x.k >= 0);
  const out: string[] = [];
  const taken = new Set<number>();
  for (let g = 0; g < order.length;) {
    const second = align.split.get(order[g].i);
    let h = g;
    if (second === undefined) while (h + 1 < order.length && !align.split.has(order[h + 1].i) && nextWord(order[h].k) === order[h + 1].k) h += 1;
    let from = order[g].k;
    while (from > 0 && !taken.has(from - 1) && opener(src[from - 1])) from -= 1;
    for (let k = from; k <= order[h].k; k++) { if (src[k].raw !== "|" && !taken.has(k)) out.push(src[k].raw); taken.add(k); }
    if (second !== undefined) { out[out.length - 1] += src[second].raw; taken.add(second); }
    g = h + 1;
  }
  return normText(out.join(" "));
}

const spanText = (src: Tok[], lo: number, hi: number) => normText(src.slice(lo, hi + 1).map((t) => t.raw).filter((r) => r !== "|").join(" "));

/**
 * Checks an item's text against the text of the pages it came from (running headers / footers already removed). The pages are
 * read as one text, so a question that runs over a page break is found.
 */
export function checkVerbatim(text: string, pageTexts: string[], opts: { stripNumber?: boolean } = {}): VerbatimResult {
  const itemToks = compareTokens(opts.stripNumber === false ? normText(text) : stripLeadingNumber(normText(text))).filter((t) => t.core);
  if (!itemToks.length) return { status: "empty", coverage: 0, layout: null, text: null, pdfText: null, diff: null };
  const src = compareTokens(pageTexts.join("\n"));
  const idx = src.map((t, i) => (t.core ? i : -1)).filter((i) => i >= 0);
  const it = itemToks.map((t) => t.core);

  const run = contiguous(it, src, idx);
  if (run) {
    let from = run.at[0]; while (from > 0 && opener(src[from - 1])) from -= 1;
    return { status: "exact", coverage: 1, layout: "run", text: spanText(src, from, run.at[run.at.length - 1]), pdfText: null, diff: null };
  }
  const ordered = inOrder(it, src, idx);
  const whole = ordered.find((o) => o.found === it.length && skipped(o.align, src).ok);
  if (whole) return { status: "exact", coverage: 1, layout: "columns", text: rebuild(whole.align, src), pdfText: null, diff: null };
  const flow = reflowed(it, src, idx);
  if (flow) return { status: "exact", coverage: 1, layout: "reflowed", text: rebuild(flow, src), pdfText: null, diff: null };

  // a real difference: the words the model added, the PDF words it left out (inside the matched stretch)
  const best = ordered[0];
  if (!best) return { status: "missing", coverage: 0, layout: null, text: null, pdfText: null, diff: { added: itemToks.map((t) => t.raw), left: [] } };
  const hits = best.align.at.filter((k) => k >= 0);
  const coverage = best.found / it.length;
  const added = itemToks.filter((_, i) => best.align.at[i] < 0).map((t) => t.raw);
  const { omitted: left, pieces: leftPieces } = skipped(best.align, src);
  const exactWords = coverage === 1 && !added.length;
  return {
    status: coverage >= 0.85 ? "close" : "missing", coverage: exactWords ? 0.99 : coverage, layout: null, text: null,
    pdfText: spanText(src, Math.min(...hits), Math.max(...hits)), diff: { added, left, leftPieces },
  };
}

const quote = (ws: string[]) => { const s = ws.join(" "); return `"${s.length > 80 ? `${s.slice(0, 77)}...` : s}"`; };

/** The difference in words, for the "Check this" list. */
export function describeDiff(r: VerbatimResult, pages: number[] = []): string {
  const where = pages.length ? ` on page${pages.length > 1 ? "s" : ""} ${pages.join(", ")}` : "";
  if (r.status === "missing") {
    return r.pdfText
      ? `Text not found in the PDF${where}: only ${Math.round(r.coverage * 100)} % of its words are there${r.diff?.added.length ? `; not in the PDF: ${quote(r.diff.added)}` : ""}`
      : `Text not found in the PDF${where}`;
  }
  const parts: string[] = [];
  if (r.diff?.added.length) parts.push(`not in the PDF: ${quote(r.diff.added)}`);
  if (r.diff?.left.length) parts.push(`left out: ${quote(r.diff.left)}`);
  return `Wording differs from the PDF${where}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

/** Bag-of-words similarity (Dice, 0..1) used to suggest a match by content. */
export function similarity(a: string, b: string): number {
  const stop = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "be", "with", "your", "you", "what", "how", "why", "which", "this", "that", "it", "as", "by", "at", "from"]);
  const bag = (s: string) => words(s).map((w) => w.toLowerCase()).filter((w) => w.length > 1 && !/^[.,;:!?]+$/.test(w) && !stop.has(w));
  const x = bag(a); const y = bag(b);
  if (!x.length || !y.length) return 0;
  const counts = new Map<string, number>();
  for (const w of x) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of y) { const n = counts.get(w) ?? 0; if (n > 0) { common += 1; counts.set(w, n - 1); } }
  return (2 * common) / (x.length + y.length);
}
