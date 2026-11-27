/**
 * ASM-ANY-LAYOUT (owner 2026-11-27): every empty fillable area of a workbook page, found from what the PDF draws (no AI).
 * Works on any layout: closed boxes rebuilt from the border segments (Word tables and boxes drawn as four lines included), tick glyphs
 * ("☐"), underscore / signature lines and Word placeholders ("Click or tap to enter a date."). Each candidate keeps its exact rectangle
 * (PDF points, top-left origin) and the text around it (the cell on its left, its column header, the line above), which the rules and,
 * only when they cannot decide, the AI classifier use to say what the field is. Pure: shared by the browser and the Node tests.
 */
import type { Box, PageModel, PageText } from "./pageModel";

export type CandidateShape = "box" | "cell" | "tick" | "line" | "placeholder";
export interface Candidate {
  /** 1-based number on its page (what the classifier is shown next to the box). */
  n: number;
  id: string;
  page: number;
  box: Box;
  shape: CandidateShape;
  /** A Word placeholder inside the area ("Click or tap to enter a date."). */
  placeholder?: string;
  /** The text right before it: the cell on its left in the same row, or the words on its left on the same line. */
  left: string;
  /** The header cell of its column (the first row of its table), when it is a table cell. */
  column: string;
  /** The nearest line of text above it (for a table cell: above the table). */
  above: string;
  /** Table cells: which table on the page and the row / column (0-based). */
  table?: { id: string; row: number; col: number; rows: number; cols: number } | null;
  /** A tick: the word printed right after it ("Yes", "No", "1"). */
  tickLabel?: string;
  /** Background of the cell (a filled cell), if any. */
  fill?: string | null;
}

export const PLACEHOLDER = /^click or tap (here )?to enter (a )?(text|date)\.?$/i;
const TICK = /^[☐□☑☒❑❒]$/;
const UNDERSCORES = /_{5,}/;

const bottom = (b: Box) => b.y + b.h;
const right = (b: Box) => b.x + b.w;
const centreIn = (t: Box, b: Box, pad = 1) => t.x + Math.min(t.w, 6) / 2 >= b.x - pad && t.x < right(b) + pad && t.y + t.h / 2 >= b.y - pad && t.y + t.h / 2 <= bottom(b) + pad;
const lum = (f: string | null | undefined) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(f ?? ""); return m ? (parseInt(m[1], 16) * 0.299 + parseInt(m[2], 16) * 0.587 + parseInt(m[3], 16) * 0.114) / 255 : 1; };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

interface Seg { a: number; b: number; at: number }

/** Collinear segments merged (touching or overlapping within tol). */
function mergeSegs(segs: Seg[], tol = 1.6): Seg[] {
  const sorted = [...segs].sort((p, q) => p.at - q.at || p.a - q.a);
  const out: Seg[] = [];
  for (const s of sorted) {
    const last = out.find((o) => Math.abs(o.at - s.at) <= 1 && s.a <= o.b + tol && s.b >= o.a - tol);
    if (last) { last.a = Math.min(last.a, s.a); last.b = Math.max(last.b, s.b); }
    else out.push({ ...s });
  }
  return out;
}
/** Coordinates within tol become one (the first seen). */
function cluster(vals: number[], tol = 1.6): number[] {
  const out: number[] = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

/** The running header and footer (the same text or line at the same place on most pages): never a field. */
export function pageChrome(models: PageModel[]): { top: number; bottom: number }[] {
  const key = (s: string, b: Box) => `${s}|${Math.round(b.x / 3)}|${Math.round(b.y / 3)}`;
  const counts = new Map<string, number>();
  const per = models.map((m) => {
    const keys = new Set<string>([...m.texts.map((t) => key(/^\d+$/.test(t.s) ? "#" : t.s, t)), ...m.lines.map((l) => key(`line${Math.round(l.w)}x${Math.round(l.h)}`, l)), ...m.rects.map((r) => key(`rect${Math.round(r.w)}x${Math.round(r.h)}`, r))]);
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    return keys;
  });
  const min = Math.max(2, Math.ceil(models.length * 0.6));
  return models.map((m, i) => {
    let top = 0; let bot = m.H;
    const items: Box[] = [...m.texts.map((t) => ({ ...t, k: key(/^\d+$/.test(t.s) ? "#" : t.s, t) })), ...m.lines.map((l) => ({ ...l, k: key(`line${Math.round(l.w)}x${Math.round(l.h)}`, l) })), ...m.rects.map((r) => ({ ...r, k: key(`rect${Math.round(r.w)}x${Math.round(r.h)}`, r) }))] as (Box & { k: string })[];
    for (const it of items as (Box & { k: string })[]) {
      if (!per[i].has(it.k) || (counts.get(it.k) ?? 0) < min) continue;
      if (bottom(it) < m.H * 0.25) top = Math.max(top, bottom(it));
      else if (it.y > m.H * 0.75) bot = Math.min(bot, it.y);
    }
    return { top, bottom: bot };
  });
}

/** Closed boxes of a page: the smallest areas bounded on all four sides by drawn borders (lines, frame edges). */
export function closedBoxes(m: PageModel): Box[] {
  const hs: Seg[] = []; const vs: Seg[] = [];
  for (const l of m.lines) {
    if (l.dir === "h" && l.w >= 4) hs.push({ a: l.x, b: right(l), at: l.y + l.h / 2 });
    if (l.dir === "v" && l.h >= 4) vs.push({ a: l.y, b: bottom(l), at: l.x + l.w / 2 });
  }
  for (const r of m.rects) {
    if (!r.stroke) continue;
    hs.push({ a: r.x, b: right(r), at: r.y }, { a: r.x, b: right(r), at: bottom(r) });
    vs.push({ a: r.y, b: bottom(r), at: r.x }, { a: r.y, b: bottom(r), at: right(r) });
  }
  const H = mergeSegs(hs); const V = mergeSegs(vs);
  if (!H.length || !V.length) return [];
  const xs = cluster(V.map((s) => s.at)); const ys = cluster(H.map((s) => s.at));
  const tol = 2.2;
  const hasH = (y: number, x0: number, x1: number) => H.some((s) => Math.abs(s.at - y) <= tol && s.a <= x0 + tol && s.b >= x1 - tol);
  const hasV = (x: number, y0: number, y1: number) => V.some((s) => Math.abs(s.at - x) <= tol && s.a <= y0 + tol && s.b >= y1 - tol);
  const R = ys.length - 1; const C = xs.length - 1;
  if (R < 1 || C < 1) return [];
  const parent = Array.from({ length: R * C }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => { const x = find(a); const y = find(b); if (x !== y) parent[y] = x; };
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (c + 1 < C && !hasV(xs[c + 1], ys[r], ys[r + 1])) join(r * C + c, r * C + c + 1);
    if (r + 1 < R && !hasH(ys[r + 1], xs[c], xs[c + 1])) join(r * C + c, (r + 1) * C + c);
  }
  const comps = new Map<number, number[]>();
  for (let i = 0; i < R * C; i++) { const k = find(i); if (!comps.has(k)) comps.set(k, []); comps.get(k)!.push(i); }
  const out: Box[] = [];
  for (const cells of comps.values()) {
    const rs = cells.map((i) => Math.floor(i / C)); const cs = cells.map((i) => i % C);
    const r0 = Math.min(...rs); const r1 = Math.max(...rs); const c0 = Math.min(...cs); const c1 = Math.max(...cs);
    if ((r1 - r0 + 1) * (c1 - c0 + 1) !== cells.length) continue; // not a rectangle (a frame around other boxes, or open)
    // closed: every outer edge is drawn
    let closed = true;
    for (let c = c0; c <= c1 && closed; c++) closed = hasH(ys[r0], xs[c], xs[c + 1]) && hasH(ys[r1 + 1], xs[c], xs[c + 1]);
    for (let r = r0; r <= r1 && closed; r++) closed = hasV(xs[c0], ys[r], ys[r + 1]) && hasV(xs[c1 + 1], ys[r], ys[r + 1]);
    if (!closed) continue;
    const b = { x: xs[c0], y: ys[r0], w: xs[c1 + 1] - xs[c0], h: ys[r1 + 1] - ys[r0] };
    if (b.w < 8 || b.h < 8) continue;
    out.push(b);
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Text rows of a page (top to bottom). */
export function textRows(texts: PageText[]): (Box & { s: string; parts: PageText[] })[] {
  const out: { y: number; parts: PageText[] }[] = [];
  for (const t of [...texts].sort((a, b) => a.y - b.y)) {
    const r = out.find((o) => Math.abs(o.y - t.y) < 3);
    if (r) r.parts.push(t); else out.push({ y: t.y, parts: [t] });
  }
  return out.map((r) => {
    const parts = r.parts.sort((a, b) => a.x - b.x);
    const x = parts[0].x; const y = Math.min(...parts.map((p) => p.y));
    return { x, y, w: Math.max(...parts.map((p) => p.x + p.w)) - x, h: Math.max(...parts.map((p) => p.y + p.h)) - y, s: norm(parts.map((t) => t.s).join(" ")), parts };
  });
}

/** Every empty fillable area of every page, numbered per page. */
export function findCandidates(models: PageModel[]): Candidate[] {
  const chrome = pageChrome(models);
  const all: Candidate[] = [];
  models.forEach((m, i) => all.push(...pageCandidates(m, chrome[i])));
  return all;
}

export function pageCandidates(m: PageModel, chrome: { top: number; bottom: number } = { top: 0, bottom: m.H }): Candidate[] {
  const inBody = (b: Box) => b.y >= chrome.top - 1 && bottom(b) <= chrome.bottom + 1;
  const texts = m.texts.filter((t) => inBody(t));
  const rows = textRows(texts);
  const boxes = closedBoxes(m).filter(inBody).filter((b) => b.w < m.W * 0.98);
  const textOf = (b: Box) => norm(texts.filter((t) => centreIn(t, b)).sort((a, c) => Math.round(a.y) - Math.round(c.y) || a.x - c.x).map((t) => t.s).join(" "));
  const fillOf = (b: Box) => {
    let f: string | null = null;
    for (const r of m.rects) if (r.fill && r.x <= b.x + 3 && right(r) >= right(b) - 3 && r.y <= b.y + 3 && bottom(r) >= bottom(b) - 3 && r.w < m.W * 0.9) f = r.fill;
    return f;
  };
  // tables: boxes that touch each other (share a border) form one table
  const touch = (a: Box, b: Box) => {
    const t = 2.5;
    const xOver = Math.min(right(a), right(b)) - Math.max(a.x, b.x) > 2; const yOver = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) > 2;
    return (xOver && (Math.abs(bottom(a) - b.y) < t || Math.abs(bottom(b) - a.y) < t)) || (yOver && (Math.abs(right(a) - b.x) < t || Math.abs(right(b) - a.x) < t));
  };
  const tid = boxes.map((_, i) => i);
  const f = (i: number): number => (tid[i] === i ? i : (tid[i] = f(tid[i])));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (touch(boxes[i], boxes[j])) { const a = f(i); const b = f(j); if (a !== b) tid[b] = a; }
  const groups = new Map<number, number[]>();
  boxes.forEach((_, i) => { const k = f(i); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(i); });
  const tableOf = new Map<number, { id: string; row: number; col: number; rows: number; cols: number; members: number[] }>();
  let tn = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    tn++;
    const tops = cluster(members.map((i) => boxes[i].y), 2.5); const lefts = cluster(members.map((i) => boxes[i].x), 2.5);
    for (const i of members) {
      const row = tops.findIndex((y) => Math.abs(y - boxes[i].y) <= 2.5); const col = lefts.findIndex((x) => Math.abs(x - boxes[i].x) <= 2.5);
      tableOf.set(i, { id: `t${tn}`, row, col, rows: tops.length, cols: lefts.length, members });
    }
  }
  const above = (b: Box, limit = 90) => {
    const cand = rows.filter((r) => bottom(r) <= b.y + 2 && b.y - bottom(r) < limit && Math.min(right(r), right(b) + 40) - Math.max(r.x, b.x - 40) > 0);
    return cand.length ? cand[cand.length - 1].s : "";
  };
  const out: Candidate[] = [];
  const push = (c: Omit<Candidate, "n" | "id" | "page">) => out.push({ ...c, n: 0, id: "", page: m.page });

  boxes.forEach((b, i) => {
    const raw = textOf(b);
    const ticks = texts.filter((t) => TICK.test(t.s) && centreIn(t, b));
    const words = raw.replace(/[☐□☑☒❑❒]/g, " ").replace(/\b(yes|no)\b/gi, " ").trim();
    const placeholder = PLACEHOLDER.test(raw) ? raw : undefined;
    if (ticks.length && !words) return; // a cell of tick boxes: the ticks are the fields
    if (raw && !placeholder && !ticks.length) {
      // a labelled box ("Feedback", "Comments"): a short label at the top and room below it is the area to fill
      const inside = texts.filter((x) => centreIn(x, b));
      const textBottom = Math.max(...inside.map((x) => bottom(x)));
      const room = bottom(b) - textBottom;
      if (raw.split(" ").length <= 6 && inside.every((x) => Math.abs(x.y - inside[0].y) < 3) && room >= 28 && b.w >= 150) {
        const area = { x: b.x, y: textBottom + 2, w: b.w, h: room - 2 };
        push({ box: area, shape: "box", left: raw, column: "", above: above(b), fill: null, table: null });
      }
      return; // printed text: a label or an instruction, not an empty area
    }
    if (raw && !placeholder) return;
    const fill = fillOf(b);
    if (fill && lum(fill) < 0.95) return; // shaded cells are headings and labels
    const t = tableOf.get(i);
    let left = ""; let column = ""; let ab = "";
    if (t) {
      const sameRow = t.members.filter((k) => k !== i && Math.abs(boxes[k].y - b.y) < 3 && right(boxes[k]) <= b.x + 3).sort((p, q) => right(boxes[q]) - right(boxes[p]));
      left = sameRow.length ? textOf(boxes[sameRow[0]]) : "";
      const head = t.members.filter((k) => k !== i && boxes[k].y < b.y - 2 && Math.min(right(boxes[k]), right(b)) - Math.max(boxes[k].x, b.x) > Math.min(b.w, boxes[k].w) * 0.5).sort((p, q) => boxes[p].y - boxes[q].y);
      column = head.length ? textOf(boxes[head[0]]) : "";
      const top = Math.min(...t.members.map((k) => boxes[k].y));
      ab = above({ x: Math.min(...t.members.map((k) => boxes[k].x)), y: top, w: Math.max(...t.members.map((k) => right(boxes[k]))) - Math.min(...t.members.map((k) => boxes[k].x)), h: 1 });
    } else {
      ab = above(b);
      const sameLine = rows.filter((r) => Math.abs(r.y + r.h / 2 - (b.y + b.h / 2)) < Math.max(6, b.h / 2) && right(r) <= b.x + 3 && b.x - right(r) < 160);
      left = sameLine.length ? sameLine[sameLine.length - 1].s : "";
    }
    push({ box: b, shape: t ? "cell" : "box", placeholder, left, column, above: ab, fill, table: t ? { id: t.id, row: t.row, col: t.col, rows: t.rows, cols: t.cols } : null });
  });

  // tick glyphs
  for (const t of texts.filter((x) => TICK.test(x.s))) {
    const base = t.y + t.h * 0.8;
    const size = Math.min(t.w, t.h) * 0.8;
    const box = { x: t.x + (t.w - size) / 2, y: base - size * 0.98, w: size, h: size };
    const row = rows.find((r) => Math.abs(r.y - t.y) < 3);
    const after = row?.parts.filter((p) => p.x >= right(t) - 1 && p.x - right(t) < 24 && !TICK.test(p.s)).sort((a, b) => a.x - b.x)[0]?.s ?? "";
    const before = row ? norm(row.parts.filter((p) => right(p) <= t.x + 1 && !TICK.test(p.s)).map((p) => p.s).join(" ")) : "";
    const cell = boxes.map((b, k) => ({ b, k })).find(({ b }) => centreIn(t, b));
    const tb = cell ? tableOf.get(cell.k) : undefined;
    let column = ""; let left = before;
    if (cell && tb) {
      // the nearest cell above in its column that prints a heading (not another row of ticks)
      const head = tb.members.filter((k) => boxes[k].y < cell.b.y - 2 && Math.min(right(boxes[k]), right(cell.b)) - Math.max(boxes[k].x, cell.b.x) > Math.min(cell.b.w, boxes[k].w) * 0.5 && !/^[☐□☑☒s]*$/.test(textOf(boxes[k]))).sort((p, q) => boxes[q].y - boxes[p].y);
      column = head.length ? textOf(boxes[head[0]]) : "";
      const rowCells = tb.members.filter((k) => Math.abs(boxes[k].y - cell.b.y) < 3 && right(boxes[k]) <= cell.b.x + 3).sort((p, q) => boxes[p].x - boxes[q].x);
      if (!before) left = norm(rowCells.map((k) => textOf(boxes[k])).filter((s) => !/^[☐□\s]*$/.test(s)).join(" · "));
    }
    push({ box, shape: "tick", left, column, above: above(box), tickLabel: after, table: cell && tb ? { id: tb.id, row: tb.row, col: tb.col, rows: tb.rows, cols: tb.cols } : null });
  }

  // underscore runs and placeholders outside boxes
  for (const r of rows) {
    for (const t of r.parts) {
      if (boxes.some((b) => centreIn(t, b))) continue;
      if (UNDERSCORES.test(t.s)) {
        const left = norm(r.parts.filter((p) => right(p) <= t.x + 1).map((p) => p.s).join(" "));
        push({ box: { x: t.x, y: t.y - 3, w: t.w, h: t.h + 3 }, shape: "line", left, column: "", above: above(r) });
      } else if (PLACEHOLDER.test(t.s)) {
        const left = norm(r.parts.filter((p) => right(p) <= t.x + 1).map((p) => p.s).join(" "));
        push({ box: { x: t.x - 1, y: t.y - 2, w: Math.max(t.w + 2, 90), h: t.h + 4 }, shape: "placeholder", placeholder: t.s, left, column: "", above: above(r) });
      }
    }
  }
  // signature / date lines drawn as a rule with a label on its left (not a border of a box)
  const edges = boxes.flatMap((b) => [b.y, bottom(b)]);
  for (const l of m.lines.filter((x) => x.dir === "h" && x.w >= 40 && x.w < m.W * 0.7 && inBody(x))) {
    if (edges.some((y) => Math.abs(y - l.y) < 2.5)) continue;
    const row = rows.find((r) => Math.abs(bottom(r) - l.y) < 6 && right(r) <= l.x + 4 && l.x - right(r) < 140);
    if (!row || !/(sign|date|name|signature)/i.test(row.s)) continue;
    push({ box: { x: l.x, y: l.y - 14, w: l.w, h: 14 }, shape: "line", left: row.s, column: "", above: above({ ...l, y: l.y - 14 }) });
  }
  out.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  out.forEach((c, i) => { c.n = i + 1; c.id = `p${m.page}c${i + 1}`; });
  return out;
}
