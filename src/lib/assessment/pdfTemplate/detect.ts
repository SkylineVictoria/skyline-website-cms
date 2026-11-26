/**
 * ASM-PDF-TEMPLATE: finds where answers and marks go on a workbook PDF from what the PDF itself draws (no AI, no text rebuilt).
 * Pure: takes the page models (pageModel.ts) and returns the template; shared by the admin screen (browser) and the Node tests.
 *
 * The SLIT workbook layout it reads:
 *  - a question = a header row of shaded cells (#f8f9fa): "Q<n>" (the running number), the question text (starting with the printed
 *    number "Q2.1.8" when there is one) and "Satisfactory Response Yes / No" with two drawn circles (the trainer's mark);
 *  - its answer box = the bluish box (#f5f7ff) right under the header; inside it "Short answer" zones (smaller bluish boxes), tables
 *    (cells bounded by borders or white cells) or free space; a box that reaches the page bottom continues at the top of the next page;
 *  - sheets: marking / evidence checklists (Yes / No circles per row), results sheet (S / NS circles, Date line, Feedback box per
 *    attempt), declaration and summary (label cell + value cell, Signature / Date lines, tick squares per attempt column), Appendix A
 *    (reasonable adjustment tick squares, trainer only), Appendix B (learner evaluation: five rating marks per row, the student's).
 */
import type { Box, DrawnRect, PageModel, PageText } from "./pageModel";
import { tablesOf } from "./student";
import { AUTO_KEYS, TRAINER_PAGES, type FieldStep, toFraction, type AutoKey, type FieldKind, type FieldRole, type PageKind, type PdfTemplate, type Rect, type TemplateField, type TemplatePage, type TemplateQuestion, type TemplateTask } from "./model";

export const DETECTOR_VERSION = "asm-pdf-detect/1";

// ---------- colours and boxes ----------
const rgb = (f: string | null) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(f ?? ""); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null; };
const lum = (f: string | null) => { const c = rgb(f); return c ? (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255 : 1; };
const isWhite = (f: string | null) => !f || lum(f) > 0.995;
const isAnswerFill = (f: string | null) => { const c = rgb(f); return !!c && c[2] - c[0] >= 6 && lum(f) > 0.9; };
const isHeaderFill = (f: string | null) => { const c = rgb(f); return !!c && !isAnswerFill(f) && lum(f) > 0.95 && lum(f) <= 0.995 && Math.abs(c[2] - c[0]) <= 4; };
const isDark = (f: string | null) => lum(f) < 0.9;

const bottom = (b: Box) => b.y + b.h;
const right = (b: Box) => b.x + b.w;
const inside = (a: Box, b: Box, pad = 1.5) => a.x >= b.x - pad && right(a) <= right(b) + pad && a.y >= b.y - pad && bottom(a) <= bottom(b) + pad;
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
const centreIn = (t: Box, b: Box, pad = 1) => t.x + Math.min(t.w, 6) / 2 >= b.x - pad && t.x < right(b) + pad && t.y + t.h / 2 >= b.y - pad && t.y + t.h / 2 <= bottom(b) + pad;
const baseline = (t: PageText) => t.y + t.h * 0.8;
const same = (a: Box, b: Box, tol = 1.2) => Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.w - b.w) < tol && Math.abs(a.h - b.h) < tol;

/** Answer-box labels that are not answers ("Short answer", the Word placeholder). */
/** A table column the assessor fills ("Signature / Authority (Assessor Use)"): its cells are the trainer's. */
const ASSESSOR_COLUMN = /\b(assessor|trainer|office)\s+(use|only)\b/i;
const LABEL_ONLY = /^(short answer|long answer|click or tap here to enter text\.?|response|answer:?)?$/i;

/** One page prepared for the rules: filled boxes as painted last (a box painted twice keeps its last colour), frames, texts. */
interface Page {
  m: PageModel;
  fills: DrawnRect[];
  frames: DrawnRect[];
  texts: PageText[];
  circles: Box[];
  squares: Box[];
  hlines: Box[];
}

function prepare(m: PageModel): Page {
  const fills: DrawnRect[] = [];
  for (const r of m.rects) {
    if (!r.fill) continue;
    const i = fills.findIndex((f) => same(f, r));
    if (i >= 0) fills.splice(i, 1);
    fills.push(r);
  }
  const frames = m.rects.filter((r) => r.stroke && !r.fill);
  // the running page header (address block) and footer (version / page number) are never part of a field
  const texts = m.texts.filter((t) => bottom(t) > 100 && t.y < m.H - 40);
  const circles = m.curves.filter((c) => c.stroke && c.w > 6 && c.w < 16 && Math.abs(c.w - c.h) < 1.5);
  const squares = frames.filter((r) => r.w > 6.5 && r.w < 17 && Math.abs(r.w - r.h) < 1.5);
  const hlines = m.lines.filter((l) => l.dir === "h");
  return { m, fills, frames, texts, circles, squares, hlines };
}

/** The text inside a box, in reading order. */
function textIn(p: Page, b: Box, pad = 1): string {
  const ts = p.texts.filter((t) => centreIn(t, b, pad)).sort((a, c) => Math.round(a.y) - Math.round(c.y) || a.x - c.x);
  return ts.map((t) => t.s).join(" ").replace(/\s+/g, " ").trim();
}

/** Text rows of the page (top to bottom), for headings. */
function rows(p: Page): { y: number; x: number; s: string }[] {
  const out: { y: number; x: number; parts: PageText[] }[] = [];
  for (const t of [...p.texts].sort((a, b) => a.y - b.y)) {
    const r = out.find((o) => Math.abs(o.y - t.y) < 3);
    if (r) r.parts.push(t); else out.push({ y: t.y, x: t.x, parts: [t] });
  }
  return out.map((r) => { const parts = r.parts.sort((a, b) => a.x - b.x); return { y: r.y, x: parts[0].x, s: parts.map((t) => t.s).join(" ").replace(/\s+/g, " ") }; });
}

/** Table cells inside a region: rectangles bounded by border lines on four sides, plus white filled cells. */
function cellsIn(p: Page, region: Box): Box[] {
  const inR = (l: Box) => inside(l, region, 2.5);
  const hs = p.m.lines.filter((l) => l.dir === "h" && l.w > 8 && inR(l));
  const vs = p.m.lines.filter((l) => l.dir === "v" && l.h > 5 && inR(l));
  const out: Box[] = [];
  const ys = [...new Set(hs.map((l) => Math.round(l.y)))].sort((a, b) => a - b);
  for (let i = 0; i + 1 < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) {
      const top = ys[i]; const bot = ys[j];
      if (bot - top < 7) continue;
      const xs = [...new Set(vs.filter((v) => v.y <= top + 2.5 && bottom(v) >= bot - 2.5).map((v) => Math.round(v.x)))].sort((a, b) => a - b);
      if (xs.length < 2) continue;
      let used = false;
      for (let k = 0; k + 1 < xs.length; k++) {
        const left = xs[k]; const rt = xs[k + 1];
        if (rt - left < 8) continue;
        const cov = (y: number) => hs.some((l) => Math.abs(Math.round(l.y) - y) <= 1 && l.x <= left + 2.5 && right(l) >= rt - 2.5);
        if (cov(top) && cov(bot)) { out.push({ x: left, y: top, w: rt - left, h: bot - top }); used = true; }
      }
      if (used) break; // the nearest bottom border closes the row
    }
  }
  // a cell found twice (two border lines close together) counts once
  for (let i = out.length - 1; i >= 0; i--) if (out.some((c, k) => k < i && overlap(c, out[i]) > 0.6 * Math.min(c.w * c.h, out[i].w * out[i].h))) out.splice(i, 1);
  for (const f of p.fills) {
    if (!isWhite(f.fill) || f.w < 8 || f.h < 7 || !inside(f, region, 1) || f.w > region.w - 4) continue;
    if (!out.some((c) => overlap(c, f) > 0.6 * Math.min(c.w * c.h, f.w * f.h))) out.push({ x: f.x, y: f.y, w: f.w, h: f.h });
  }
  return out;
}

// ---------- labels ----------
const AUTO_LABELS: [RegExp, AutoKey][] = [
  [/^student('s)? (full )?name\b|^name of (the )?student/i, "student_name"],
  [/^student (id|number)\b/i, "student_id"],
  [/^student e-?mail/i, "student_email"],
  [/^(trainer|assessor|trainer\s*\/\s*assessor)( full)? name\b/i, "trainer_name"],
  [/^unit (code )?(&|and) name|^unit of competency name/i, "unit_code_name"],
  [/^unit code\b/i, "unit_code"],
  [/^unit (name|title)\b/i, "unit_name"],
  [/^qualification code/i, "qualification_code"],
  [/^qualification (name|title)/i, "qualification_name"],
  [/^start date/i, "start_date"],
  [/^end date/i, "end_date"],
  [/^date of evaluation/i, "submission_date"],
];
const clean = (s: string) => s.replace(/\s*:\s*$/, "").replace(/\s+/g, " ").trim();
const autoKeyOf = (label: string): AutoKey | null => AUTO_LABELS.find(([re]) => re.test(clean(label)))?.[1] ?? null;
const LABEL_WORDS = /\b(name|id|e-?mail|signature|date|dates|code|title|employer|site|evaluation|feedback|comments?|location|prepared|approved|project|unit|qualification|initial|updated)\b/i;

// ---------- the detector ----------
interface Draft extends Box { page: number; role: FieldRole; kind: FieldKind; questionKey: string | null; label: string; dataKey?: AutoKey | null; option?: string | null; group?: string | null; attempt?: number | null; table?: TemplateField["table"]; step?: FieldStep | null; required?: boolean; slot?: string | null; checklist?: TemplateField["checklist"] }

interface PageInfo { kind: PageKind; sheet: PageKind | null; task: number | null }

const TASK_RE = /^Assessment Task\s*[-–]\s*(\d+)\s*[–-]\s*(.+)$/i;

export interface DetectInput { path: string; sha256: string; fileName?: string | null }

export function detectTemplate(models: PageModel[], pdf: DetectInput, at = new Date().toISOString()): PdfTemplate {
  const pages = models.map(prepare);
  const drafts: Draft[] = [];
  const questions: (Omit<TemplateQuestion, "header" | "areas"> & { header: Rect; areas: Rect[]; page: number })[] = [];
  const info: PageInfo[] = [];
  const taskTitles = new Map<number, { title: string; page: number }>();
  let carry: { key: string; heading: string | null } | null = null;
  let lastTail: string | null = null;
  let task: number | null = null;
  let appendix: "a" | "b" | null = null;
  let seqCount = 0;
  const rowsOf: Record<number, { y: number; x: number; s: string }[]> = {};
  const declarations: NonNullable<PdfTemplate["declarations"]> = [];

  const add = (d: Draft) => {
    const own = drafts.filter((o) => o.page === d.page);
    if (own.some((o) => overlap(o, d) > 0.5 * Math.min(o.w * o.h, d.w * d.h))) return false;
    drafts.push(d);
    return true;
  };

  for (const p of pages) {
    const no = p.m.page;
    const rs = rows(p);
    rowsOf[no] = rs;
    const all = rs.map((r) => r.s).join(" \n ");
    const head = rs.slice(0, 6).map((r) => r.s).join(" \n ");
    // ----- task title ("Assessment Task - 2 – Project …") -----
    for (const [i, r] of rs.slice(0, 4).entries()) {
      const t = TASK_RE.exec(r.s);
      if (!t || /results sheet/i.test(t[2]) || r.x > 120) continue;
      task = Number(t[1]);
      let title = t[2].replace(/^Assessment Task\s*\d+\s*[–-]\s*/i, "").trim();
      // a title wrapped onto the next line ("Project (Includes a" / "role-play)")
      const next = rs[i + 1];
      if ((title.match(/\(/g) ?? []).length > (title.match(/\)/g) ?? []).length && next && Math.abs(next.x - r.x) < 4 && next.y - r.y < 30) title = `${title} ${next.s}`;
      if (!taskTitles.has(task)) taskTitles.set(task, { title, page: no });
      break;
    }
    if (/Appendix A\b/.test(head)) appendix = "a";
    if (/Appendix B\b/.test(head)) appendix = "b";
    let sheet: PageKind | null = null;
    if (appendix === "a") sheet = "appendix_a";
    else if (appendix === "b") sheet = "appendix_b";
    else if (/ASSESSMENT SUMMARY SHEET/i.test(head)) sheet = "summary";
    else if (/Results Sheet/i.test(head)) sheet = "results_sheet";
    else if (/MARKING CHECKLIST/i.test(head) || (/SATISFACTORY/.test(head) && /Criteria/.test(head))) sheet = "marking_checklist";
    else if (/evidence (submission )?checklist/i.test(all)) sheet = "evidence_checklist";
    else if (/I declare that the answers I have provided/i.test(all)) sheet = "declaration";
    else if (no === 1) sheet = "cover";
    else if (/Student and trainer details/i.test(head)) sheet = "details";
    const trainerSheet = !!sheet && TRAINER_PAGES.has(sheet);

    // ----- questions -----
    const qCells = p.fills.filter((r) => isHeaderFill(r.fill) && /^Q\d+$/.test(textIn(p, r)));
    const pageQuestions: string[] = [];
    let lastArea: Box | null = null;
    for (const q of qCells.sort((a, b) => a.y - b.y)) {
      const row = p.fills.filter((r) => isHeaderFill(r.fill) && Math.abs(r.y - q.y) < 2 && Math.abs(r.h - q.h) < 2).sort((a, b) => a.x - b.x);
      const sat = row.find((r) => /satisfactory/i.test(textIn(p, r))) ?? null;
      const textCell = row.filter((r) => r !== q && r !== sat).sort((a, b) => b.w - a.w)[0] ?? null;
      const text = textCell ? textIn(p, textCell) : "";
      const seq = textIn(p, q);
      seqCount += 1;
      const printedAs = /^Q?\d+(?:\.\d+)+\b/.exec(text)?.[0] ?? null;
      const printed = printedAs ? printedAs.replace(/^Q/, "") : null;
      const references = !printed && /^References\b/i.test(text);
      // an unprinted question: <task>.<its running number> ("Q3" of task 2 -> 2.3); a reference list: <task>.references
      let key = printed ?? (references && task ? `${task}.references` : task ? `${task}.${seq.replace(/^Q/, "")}` : seq);
      if (questions.some((o) => o.key === key)) key = `${key}-${seqCount}`;
      while (questions.some((o) => o.key === key)) key = `${key}b`;
      const header: Box = { x: Math.min(...row.map((r) => r.x)), y: q.y, w: Math.max(...row.map(right)) - Math.min(...row.map((r) => r.x)), h: q.h };
      const label = (printedAs ? text.slice(printedAs.length) : references ? text.replace(/^References\s*/i, "") : text).trim().slice(0, 400);
      // what the header row prints as the question's name: "Q2.1.8", "References", else the running number ("Q3")
      const display = printedAs ?? (references ? "References" : seq);
      // what the student is shown of the header: the number and the question, never the trainer's Satisfactory column
      const promptCells = row.filter((r) => r !== sat);
      const prompt: Box = { x: Math.min(...promptCells.map((r) => r.x)), y: q.y, w: Math.max(...promptCells.map(right)) - Math.min(...promptCells.map((r) => r.x)), h: q.h };
      const entry = { key, seq, display, label, task, prompt: toFraction(no, p.m.W, p.m.H, prompt), header: toFraction(no, p.m.W, p.m.H, header), areas: [] as Rect[], page: no };
      questions.push(entry);
      pageQuestions.push(key);
      // the trainer's Satisfactory Yes / No
      if (sat) {
        const cs = p.circles.filter((c) => inside(c, sat, 2)).sort((a, b) => a.x - b.x);
        cs.slice(0, 2).forEach((c, i) => add({ page: no, ...c, role: "trainer", kind: "yes_no", questionKey: key, label: "Satisfactory", option: i === 0 ? "yes" : "no", group: `q.${key}` }));
      }
      const answer = p.fills.filter((r) => isAnswerFill(r.fill) && r.y >= bottom(header) - 3 && r.y <= bottom(header) + 8 && r.w > header.w * 0.8).sort((a, b) => b.h - a.h)[0];
      // the last line of the header row: a part's heading printed there ("a. Australian and other relevant Standards") names the space under it
      const headerTail = textCell ? rows({ ...p, texts: p.texts.filter((t) => centreIn(t, textCell)) }).pop()?.s ?? null : null;
      if (answer) {
        entry.areas.push(toFraction(no, p.m.W, p.m.H, answer));
        lastTail = area(p, answer, key, add, true, { headerTail });
        lastArea = answer;
      } else { lastArea = null; lastTail = null; }
    }
    // ----- an answer box at the top of a page with no header: the previous page's question continues -----
    let continuation = false;
    if (!qCells.length && carry) {
      const top = p.fills.filter((r) => isAnswerFill(r.fill) && r.y < 180 && r.w > 300 && r.h > 20).sort((a, b) => a.y - b.y)[0];
      if (top) {
        const q = questions.find((o) => o.key === carry!.key)!;
        q.areas.push(toFraction(no, p.m.W, p.m.H, top));
        lastTail = area(p, top, q.key, add, false, { carryHeading: carry.heading });
        continuation = true;
        lastArea = top;
        pageQuestions.push(q.key);
      }
    }
    // a question continues only when its answer box reaches the bottom of the page
    const lastKey = pageQuestions[pageQuestions.length - 1];
    carry = lastArea && lastKey && bottom(lastArea) > p.m.H - 110 ? { key: lastKey, heading: lastTail } : null;

    const kind: PageKind = qCells.length ? "question" : continuation ? "continuation" : sheet ?? (rs.slice(0, 3).some((r) => TASK_RE.test(r.s)) ? "task_start" : "info");
    info.push({ kind, sheet, task: appendix || sheet === "summary" ? null : task });

    // ----- sheet fields (outside answer boxes) -----
    const areas = questions.filter((q) => q.areas.some((a) => a.page === no)).flatMap((q) => q.areas.filter((a) => a.page === no)).map((a) => ({ x: a.x * p.m.W, y: a.y * p.m.H, w: a.w * p.m.W, h: a.h * p.m.H }));
    const headers = questions.filter((q) => q.header.page === no).map((q) => ({ x: q.header.x * p.m.W, y: q.header.y * p.m.H, w: q.header.w * p.m.W, h: q.header.h * p.m.H }));
    const free = (b: Box) => !areas.some((a) => inside(b, a, 2)) && !headers.some((h) => inside(b, h, 2));
    const defaultRole: FieldRole = trainerSheet ? "trainer" : "student";
    // attempt columns (summary: "1st Attempt" …) or attempt sections (results sheet: "First attempt:" …)
    const cols = p.texts.filter((t) => /^(1st|2nd|3rd) Attempt/i.test(t.s)).map((t) => ({ x: t.x + t.w / 2, y: t.y, n: Number(t.s[0]) }));
    const secs = p.texts.filter((t) => /^(First|Second|Third) attempt/i.test(t.s)).map((t) => ({ y: t.y, n: /^First/i.test(t.s) ? 1 : /^Second/i.test(t.s) ? 2 : 3 }));
    const attemptOf = (b: Box): number | null => {
      const c = cols.filter((c) => c.y < b.y);
      // a box as wide as several columns belongs to none of them
      if (c.length) return b.w > 200 ? null : c.sort((a, d) => Math.abs(a.x - (b.x + b.w / 2)) - Math.abs(d.x - (b.x + b.w / 2)))[0].n;
      const s = secs.filter((s) => s.y <= b.y + 6).sort((a, d) => d.y - a.y)[0];
      return s?.n ?? null;
    };
    /** The row's label: the text of the label column cell (left, x < the field) on the same band. */
    const rowLabel = (b: Box): string => {
      const cell = p.fills.filter((f) => f.x < b.x - 4 && f.y <= b.y + b.h / 2 && bottom(f) >= b.y + b.h / 2 && f.w < 300 && f.h < 200).sort((a, d) => a.x - d.x)[0];
      const t = cell ? textIn(p, cell) : "";
      // the label, not the declaration printed under it ("Trainer/Assessor Signature I declare that …")
      return clean(t.replace(/\s+I (declare|understand)\b.*$/i, "")).slice(0, 120);
    };

    // circles (outside question headers): rows of 5 = a rating, rows of 2 = a Yes / No (S / NS)
    const loose = p.circles.filter((c) => !headers.some((h) => inside(c, h, 2)) && free(c));
    const circleRows: Box[][] = [];
    for (const c of loose.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const r = circleRows.find((row) => Math.abs(row[0].y - c.y) < 3);
      if (r) r.push(c); else circleRows.push([c]);
    }
    circleRows.forEach((row, i) => {
      row.sort((a, b) => a.x - b.x);
      const cell = p.fills.filter((f) => f.y <= row[0].y && bottom(f) >= bottom(row[0]) && right(f) <= row[0].x + 1 && f.w < 400 && !isDark(f.fill)).sort((a, b) => b.w - a.w)[0];
      const band: Box = cell ?? { x: 40, y: row[0].y - 10, w: row[0].x - 45, h: row[0].h + 20 };
      const label = clean(p.texts.filter((t) => t.y + t.h / 2 >= band.y && t.y + t.h / 2 <= bottom(band) && right(t) <= row[0].x - 2).sort((a, b) => a.y - b.y || a.x - b.x).map((t) => t.s).join(" ")).replace(/^\d+\s+/, "").slice(0, 160) || "Choice";
      const group = `p${no}.r${i + 1}`;
      const attempt = attemptOf(row[0]);
      if (row.length >= 4) {
        row.slice(0, 5).forEach((c, k) => add({ page: no, ...pad(c, 2), role: sheet === "appendix_b" ? "student" : defaultRole, kind: "rating", questionKey: null, label, option: String(k + 1), group }));
      } else if (row.length >= 2) {
        const lbl = sheet === "results_sheet" ? "Outcome" : label;
        row.slice(0, 2).forEach((c, k) => add({ page: no, ...pad(c, 2), role: defaultRole, kind: "yes_no", questionKey: null, label: lbl, option: k === 0 ? "yes" : "no", group, attempt }));
      } else add({ page: no, ...pad(row[0], 2), role: defaultRole, kind: "checkbox", questionKey: null, label, attempt });
    });

    // tick squares: Satisfactory / Not Satisfactory and Competent / Not Yet Competent pairs, else a tick on its own
    const sqs = p.squares.filter(free).sort((a, b) => a.y - b.y || a.x - b.x);
    const used = new Set<Box>();
    for (const s of sqs) {
      if (used.has(s)) continue;
      const word = squareLabel(p, s);
      const yes = /^(satisfactory|competent)\b/i.test(word);
      const partner = yes ? sqs.find((o) => o !== s && !used.has(o) && Math.abs(o.x - s.x) < 2 && o.y > s.y && o.y - s.y < 20 && /^not\b/i.test(squareLabel(p, o))) : undefined;
      const attempt = attemptOf(s);
      if (partner) {
        used.add(s); used.add(partner);
        const rl = rowLabel(s) || (/competent/i.test(word) ? "Final result" : "Outcome");
        const group = `p${no}.${slug(rl)}.a${attempt ?? 0}`;
        add({ page: no, ...pad(s, 1.5), role: defaultRole, kind: "yes_no", questionKey: null, label: rl, option: "yes", group, attempt });
        add({ page: no, ...pad(partner, 1.5), role: defaultRole, kind: "yes_no", questionKey: null, label: rl, option: "no", group, attempt });
        continue;
      }
      used.add(s);
      // "4. Assessment Submission Method": ticked from the record (online through the LMS), never by hand
      const method = submissionOption(word);
      if (method && /Assessment Submission Method/i.test(all)) { add({ page: no, ...pad(s, 1.5), role: "auto", kind: "auto", questionKey: null, label: word, dataKey: "submission_method", option: method }); continue; }
      add({ page: no, ...pad(s, 1.5), role: defaultRole, kind: "checkbox", questionKey: null, label: word || "Tick", attempt });
    }

    // label cell + empty value cell to its right (or below): Student Name, Student ID, Trainer/Assessor Signature, Date …
    const signatures: { box: Box; role: FieldRole; slot: string }[] = [];
    for (const l of p.fills.filter((f) => free(f) && f.w < 300 && f.h < 140).sort((a, b) => a.y - b.y || a.x - b.x)) {
      const lt = clean(textIn(p, l));
      if (!lt || lt.length > 60 || !(LABEL_WORDS.test(lt) || isDark(l.fill))) continue;
      const v = p.fills.find((o) => o !== l && Math.abs(o.y - l.y) < 2 && Math.abs(o.h - l.h) < 3 && Math.abs(o.x - right(l)) < 3 && free(o));
      if (!v || !LABEL_ONLY.test(textIn(p, v)) || p.squares.some((s) => inside(s, v)) || p.circles.some((c) => inside(c, v))) continue;
      const d = labelled(p, no, lt, inset(v), defaultRole, sheet, signatures, task);
      if (d) { d.attempt = attemptOf(v); if (add(d) && d.kind === "signature") signatures.push({ box: v, role: d.role, slot: d.slot ?? "pack" }); }
    }

    // "Signature:" / "Date:" written on a line (a horizontal rule after the words, or right under them)
    // a table border (a vertical line meets its end) is not a writing line
    const isBorder = (l: Box) => p.m.lines.some((v) => v.dir === "v" && (Math.abs(v.x - l.x) < 1.2 || Math.abs(v.x - right(l)) < 1.2) && v.y <= l.y + 2.5 && bottom(v) >= l.y - 2.5);
    const writing = p.hlines.filter((l) => !isBorder(l));
    for (const t of p.texts.filter((t) => t.s.length < 40 && /:\s*$/.test(t.s) && LABEL_WORDS.test(t.s) && free(t))) {
      const after = writing.find((l) => l.w > 25 && Math.abs(l.y - baseline(t)) < 5 && l.x >= right(t) - 4 && l.x < right(t) + 70);
      const under = !after ? writing.find((l) => l.w > 40 && l.y > baseline(t) + 3 && l.y < baseline(t) + 18 && Math.abs(l.x - t.x) < 8) : undefined;
      let box: Box | null = null;
      if (after) box = { x: after.x, y: after.y - 14, w: after.w, h: 15 };
      else if (under) box = { x: right(t) + 4, y: t.y - 2, w: right(under) - right(t) - 4, h: under.y - t.y + 2 };
      if (!box || box.w < 20) continue;
      const lt = clean(t.s);
      const rl = rowLabel(box);
      const role: FieldRole = /signature/i.test(lt) && rl ? (/student/i.test(rl) ? "student" : /trainer|assessor/i.test(rl) ? "trainer" : defaultRole) : defaultRole;
      const d = labelled(p, no, rl && /signature|date/i.test(lt) ? `${rl} · ${lt}` : lt, box, role, sheet, signatures, task, lt);
      if (d) { d.attempt = attemptOf(box); if (add(d) && d.kind === "signature") signatures.push({ box, role: d.role, slot: d.slot ?? "pack" }); }
    }

    // empty framed boxes (Feedback, Explanation of reasonable adjustments …) and white boxes under a heading (Additional comments)
    for (const f of p.frames.filter((r) => r.w > 60 && r.h > 25 && free(r))) {
      if (!LABEL_ONLY.test(textIn(p, f)) || p.squares.some((s) => inside(s, f)) || p.circles.some((c) => inside(c, f))) continue;
      // the heading right above: its line(s) back to the first gap of more than a line
      const above = p.texts.filter((t) => bottom(t) <= f.y + 3 && bottom(t) > f.y - 45 && t.x < right(f) && right(t) > f.x).sort((a, b) => b.y - a.y);
      const block: PageText[] = [];
      for (const t of above) if (!block.length || block[block.length - 1].y - bottom(t) < 6) block.push(t); else break;
      const aboveText = clean(block.reverse().map((t) => t.s).join(" "));
      const left = p.texts.filter((t) => right(t) <= f.x + 3 && t.y + t.h / 2 >= f.y - 4 && t.y < bottom(f) && right(t) > f.x - 160).sort((a, b) => a.y - b.y)[0];
      const lbl = clean(left?.s ?? rowLabel(f) ?? "") || aboveText || "Comments";
      add({ page: no, ...inset(f), role: /^student/i.test(lbl) && !trainerSheet ? "student" : defaultRole, kind: "text", questionKey: null, label: lbl.slice(0, 120), attempt: attemptOf(f) });
    }
    // the student's declaration of the task, as printed (shown to the student and kept with the submission)
    if (sheet === "declaration") {
      const cell = p.fills.filter((f) => /^I declare that the answers/i.test(textIn(p, f))).sort((a, b) => a.w * a.h - b.w * b.h)[0];
      if (cell) declarations.push({ task, page: no, text: textIn(p, cell).slice(0, 2000), rect: toFraction(no, p.m.W, p.m.H, cell) });
    }
    if (sheet === "appendix_b") {
      // "Additional Comments on …": the empty white box under the heading
      for (const t of p.texts.filter((t) => /^Additional Comments/i.test(t.s))) {
        const box = p.fills.find((f) => !isDark(f.fill) && f.y >= bottom(t) - 2 && f.y < bottom(t) + 20 && f.w > 300 && f.h > 30 && LABEL_ONLY.test(textIn(p, f)))
          ?? p.frames.find((f) => f.y >= bottom(t) - 2 && f.y < bottom(t) + 20 && f.w > 300 && f.h > 30);
        if (box) add({ page: no, ...inset(box), role: "student", kind: "text", questionKey: null, label: clean(t.s) });
      }
    }
  }

  // ----- tasks: from its title page to its last sheet (declaration / results) -----
  const tasks: TemplateTask[] = [];
  const nums = [...taskTitles.keys()].sort((a, b) => a - b);
  nums.forEach((n, i) => {
    const sheets = info.map((pi, k) => ({ pi, page: k + 1 })).filter(({ pi }) => pi.task === n && (pi.sheet === "declaration" || pi.sheet === "results_sheet" || pi.sheet === "marking_checklist"));
    const lastPage = sheets.length ? sheets[sheets.length - 1].page : (i + 1 < nums.length ? taskTitles.get(nums[i + 1])!.page - 1 : info.length);
    const firstPage = i === 0 ? taskTitles.get(n)!.page : tasks[i - 1].lastPage + 1;
    tasks.push({ number: String(n), title: taskTitles.get(n)!.title, firstPage, lastPage });
  });
  const pageList: TemplatePage[] = info.map((pi, k) => {
    const page = k + 1;
    const t = tasks.find((x) => page >= x.firstPage && page <= x.lastPage);
    // trainer-only sheets never reach the student (their student signature is filled from the student's one signature)
    return { page, kind: pi.kind, audience: TRAINER_PAGES.has(pi.kind) ? "trainer" : "student", task: t ? Number(t.number) : null };
  });
  for (const q of questions) q.task = pageList[q.page - 1]?.task ?? q.task;
  checklists(drafts, pageList, questions, rowsOf);
  const pack = packDeclaration(pages, rowsOf);
  if (pack) declarations.push(pack);

  const fields: TemplateField[] = drafts.map((d, i) => {
    const m = models[d.page - 1];
    const r = toFraction(d.page, m.W, m.H, d);
    const f: TemplateField = { id: `p${d.page}-${i + 1}`, ...r, role: d.role, kind: d.kind, questionKey: d.questionKey, label: d.label };
    if (d.dataKey) f.dataKey = d.dataKey;
    if (d.option) f.option = d.option;
    if (d.group) f.group = d.group;
    if (d.attempt) f.attempt = d.attempt;
    if (d.table) f.table = d.table;
    if (d.step) f.step = d.step;
    if (d.required) f.required = true;
    if (d.slot) f.slot = d.slot;
    if (d.checklist) f.checklist = d.checklist;
    return f;
  });
  groupTables(fields);
  return {
    version: 1,
    pdf: { path: pdf.path, sha256: pdf.sha256, pages: models.length, fileName: pdf.fileName ?? null },
    pages: pageList,
    tasks,
    questions: questions.map(({ page: _page, ...q }) => q),
    declarations: declarations.map((d) => ({ ...d, task: pageList[d.page - 1]?.task ?? d.task })),
    fields,
    detected: { by: DETECTOR_VERSION, at },
  };
}

const pad = (b: Box, n: number): Box => ({ x: b.x - n, y: b.y - n, w: b.w + 2 * n, h: b.h + 2 * n });
const inset = (b: Box, n = 1.5): Box => ({ x: b.x + n, y: b.y + n, w: Math.max(2, b.w - 2 * n), h: Math.max(2, b.h - 2 * n) });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "row";

/** The submission method a tick box of "Assessment Submission Method" stands for. */
function submissionOption(word: string): string | null {
  if (/\bLMS\b|online/i.test(word)) return "lms";
  if (/by hand/i.test(word)) return "hand";
  if (/e-?mail/i.test(word)) return "email";
  if (/other method/i.test(word)) return "other";
  return null;
}

/** The words beside a tick square: "Label:" just before it, else the words right after it on the same line. */
function squareLabel(p: Page, s: Box): string {
  const cy = s.y + s.h / 2;
  const line = p.texts.filter((t) => Math.abs(t.y + t.h / 2 - cy) < 6);
  const before = line.filter((t) => right(t) <= s.x + 1 && right(t) > s.x - 12 && /:\s*$/.test(t.s)).sort((a, b) => b.x - a.x)[0];
  if (before) return clean(before.s);
  const after = line.filter((t) => t.x >= right(s) - 1 && t.x < right(s) + 20).sort((a, b) => a.x - b.x)[0];
  return clean(after?.s ?? "").slice(0, 120);
}

/** A field from its label's words: auto record value, signature, date or text; who fills it. */
function labelled(p: Page, page: number, label: string, box: Box, role: FieldRole, sheet: PageKind | null, signatures: { box: Box; role: FieldRole; slot: string }[], task: number | null, words = label): Draft | null {
  const auto = autoKeyOf(words) ?? autoKeyOf(label);
  const base = { page, ...box, questionKey: null, label: clean(label).slice(0, 120) };
  if (auto) return { ...base, role: "auto", kind: "auto", dataKey: auto };
  if (/signature/i.test(words)) {
    const r: FieldRole = /student/i.test(label) ? "student" : /trainer|assessor/i.test(label) ? "trainer" : role;
    // which signature: the student's declaration of the task (its declaration page), of the whole pack (elsewhere, signed on the
    // submit step), the acknowledgement of the result (the summary sheet's student row, after the results are released); the
    // assessor's sign-off of the attempt for every trainer signature
    const slot = r !== "student" ? "signoff" : sheet === "summary" ? "ack" : sheet === "declaration" && task != null ? `decl:${task}` : "pack";
    return { ...base, role: r, kind: "signature", slot, ...(slot === "ack" ? { step: "acknowledge" as const } : {}) };
  }
  if (/^date:?$/i.test(clean(words)) || /\bdate\b/i.test(words) && clean(words).length < 20) {
    // the date beside a signature is the day that signature was made: on a task declaration page the student's declaration
    if (sheet === "declaration" && task != null) return { ...base, role: "auto", kind: "auto", dataKey: "signed_date", slot: `decl:${task}` };
    const sig = signatures.filter((s) => s.box.y < box.y && box.y - s.box.y < 120 && Math.abs(s.box.x - box.x) < 140).sort((a, b) => b.box.y - a.box.y)[0];
    if (sig) return { ...base, role: "auto", kind: "auto", dataKey: "signed_date", slot: sig.slot, ...(sig.slot === "ack" ? { step: "acknowledge" as const } : {}) };
    return { ...base, role, kind: "date" };
  }
  if (/^(initial|updated)$/i.test(clean(words))) return { ...base, role: "trainer", kind: "checkbox" };
  return { ...base, role, kind: "text" };
}

/** The fields of one answer box: its "Short answer" zones, the empty cells of its tables, else the free space. */
function area(p: Page, box: Box, key: string, add: (d: Draft) => boolean, first: boolean, opts: { carryHeading?: string | null; headerTail?: string | null } = {}): string | null {
  const no = p.m.page;
  const zones = p.fills.filter((r) => r !== box && isAnswerFill(r.fill) && inside(r, box, 1) && r.w < box.w - 4 && r.h > 20 && !same(r, box));
  const taken: Box[] = [];
  for (const z of zones.sort((a, b) => a.y - b.y)) {
    const heading = p.texts.filter((t) => bottom(t) <= z.y + 2 && t.y > z.y - 45 && !LABEL_ONLY.test(t.s) && t.x < right(z)).sort((a, b) => b.y - a.y)[0];
    if (heading) { add({ page: no, ...inset(z), role: "student", kind: "text", questionKey: key, label: clean(heading.s).slice(0, 120), required: true }); taken.push(z); continue; }
    // a zone at the top of a continued page with no heading above it: the part whose heading ended the page before (its whole box is
    // here), else the rest of the part that ended that page (the same answer, carried on: never required on its own)
    const atTop = z.y - box.y < 30;
    if (atTop && opts.carryHeading) { add({ page: no, ...inset(z), role: "student", kind: "text", questionKey: key, label: clean(opts.carryHeading).slice(0, 120), required: true }); opts.carryHeading = null; }
    else add({ page: no, ...inset(z), role: "student", kind: "text", questionKey: key, label: "Answer", ...(atTop ? {} : { required: true }) });
    taken.push(z);
  }
  const cells = cellsIn(p, box).filter((c) => !zones.some((z) => overlap(z, c) > 0.5 * c.w * c.h));
  if (cells.length) {
    // rows and columns of the box's tables
    const ys = [...new Set(cells.map((c) => Math.round(c.y / 3)))].sort((a, b) => a - b);
    const xs = [...new Set(cells.map((c) => Math.round(c.x / 3)))].sort((a, b) => a - b);
    const textOf = new Map(cells.map((c) => [c, textIn(p, c)] as const));
    for (const c of cells) {
      const t = textOf.get(c) ?? "";
      if (!LABEL_ONLY.test(t)) continue;
      const rowCells = cells.filter((o) => Math.abs(o.y - c.y) < 3 && o.x < c.x && !LABEL_ONLY.test(textOf.get(o) ?? "")).sort((a, b) => a.x - b.x);
      const rowLabel = clean(rowCells[0] ? textOf.get(rowCells[0])! : "");
      const colHead = cells.filter((o) => o.y < c.y && Math.abs(o.x - c.x) < 3 && Math.abs(o.w - c.w) < 4 && !LABEL_ONLY.test(textOf.get(o) ?? "")).sort((a, b) => b.y - a.y)[0];
      const column = clean(colHead ? textOf.get(colHead)! : "");
      const sameRow = cells.filter((o) => Math.abs(o.y - c.y) < 3);
      // a two-column form row ("Project Title" | ____) is a plain field
      const formRow = sameRow.length === 2 && rowCells.length === 1 && !column;
      const d: Draft = formRow
        ? { page: no, ...inset(c), role: "student", kind: /\bdate\b/i.test(rowLabel) ? "date" : "text", questionKey: key, label: rowLabel || "Answer", required: true }
        : { page: no, ...inset(c), role: ASSESSOR_COLUMN.test(column) ? "trainer" : "student", kind: "table_cell", questionKey: key, label: [rowLabel, column].filter(Boolean).join(" · ") || "Cell", table: { row: ys.indexOf(Math.round(c.y / 3)), col: xs.indexOf(Math.round(c.x / 3)), ...(rowLabel ? { rowLabel } : {}), ...(column ? { column } : {}) } };
      if (add(d)) taken.push(c);
    }
    for (const c of cells) taken.push(c);
  }
  // free space of the box (no zone, table or printed words) of a useful height: one text answer
  const occupied = [...taken, ...p.texts.filter((t) => centreIn(t, box) && !LABEL_ONLY.test(t.s))].map((b) => ({ y: b.y - 2, b: bottom(b) + 2 })).sort((a, b) => a.y - b.y);
  let y = box.y + 1;
  const gaps: { y: number; h: number }[] = [];
  for (const o of occupied) { if (o.y - y >= 40) gaps.push({ y, h: o.y - y }); y = Math.max(y, o.b); }
  if (bottom(box) - 1 - y >= 40) gaps.push({ y, h: bottom(box) - 1 - y });
  // a plain answer box (nothing else in it) must be answered; space left over beside tables or zones, or a continued box, may stay empty
  const plain = first && !zones.length && !cells.length && gaps.length === 1;
  const part = opts.headerTail && /^[a-z]{1,2}[.)]\s+\S/i.test(opts.headerTail) ? clean(opts.headerTail) : null;
  for (const g of gaps) {
    // the space right under the header, named by the part heading the header ends with, is that part's answer
    if (first && part && g.y - box.y < 6) { add({ page: no, x: box.x + 2, y: g.y + 1, w: box.w - 4, h: g.h - 2, role: "student", kind: "text", questionKey: key, label: part.slice(0, 120), required: true }); continue; }
    add({ page: no, x: box.x + 2, y: g.y + 1, w: box.w - 4, h: g.h - 2, role: "student", kind: "text", questionKey: key, label: "Answer", ...(plain ? { required: true } : {}) });
  }
  // a part heading at the foot of the box with no box after it: its answer starts on the next page
  const lastBottom = Math.max(box.y, ...taken.map(bottom));
  const tail = p.texts.filter((t) => centreIn(t, box) && !LABEL_ONLY.test(t.s) && t.y > lastBottom).sort((a, b) => b.y - a.y)[0];
  return tail ? clean(tail.s) : null;
}

/** The auto keys a field can take, for the editor's dropdown. */
export const AUTO_OPTIONS = Object.entries(AUTO_KEYS).map(([value, label]) => ({ value: value as AutoKey, label }));

/* ------------------------------------------------------------------ after the pages are read */
const SECTION_LIST = /^(\d+(?:\.\d+)+)\s+Evidence submission checklist/i;
const WORD = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "for", "with", "completed", "candidate", "submitted", "sheet", "form", "record"].includes(w));

/**
 * Marking checklists: the rows under "PERFORMANCE OUTCOME" (and on the page it runs on to) are the task's questions in order, each
 * filled from its question's mark; the "EVIDENCE OUTCOME" rows are the trainer's to tick. Written evidence lists: a row named like a
 * question of the task is ticked Yes when the student answered it (the trainer can change it).
 */
function checklists(drafts: Draft[], pages: TemplatePage[], questions: { key: string; task: number | null; header: Rect; label: string }[], rowsOf: Record<number, { y: number; s: string }[]>) {
  const rowGroups = (page: number) => {
    const g = new Map<string, Draft[]>();
    for (const d of drafts.filter((x) => x.page === page && x.kind === "yes_no" && x.role === "trainer" && x.group && !x.group.startsWith("q."))) g.set(d.group!, [...(g.get(d.group!) ?? []), d]);
    return [...g.values()].sort((a, b) => a[0].y - b[0].y);
  };
  let mode: "evidence" | "performance" = "evidence"; let lastTask: number | null = null;
  const perfRows = new Map<number | null, Draft[][]>();
  for (const pg of pages) {
    const rs = rowsOf[pg.page] ?? [];
    const taskQs = questions.filter((q) => q.task === pg.task).sort((a, b) => a.header.page - b.header.page || a.header.y - b.header.y);
    if (pg.kind === "marking_checklist") {
      if (pg.task !== lastTask) { mode = "evidence"; lastTask = pg.task; }
      const ev = rs.find((r) => /^EVIDENCE OUTCOME/i.test(r.s)); const perf = rs.find((r) => /^PERFORMANCE OUTCOME/i.test(r.s));
      if (ev) mode = "evidence";
      for (const row of rowGroups(pg.page)) {
        const y = row[0].y;
        const isPerf = perf ? y > perf.y : ev ? false : mode === "performance";
        if (perf && y > perf.y) mode = "performance";
        for (const d of row) d.checklist = isPerf ? "performance" : "evidence";
        if (isPerf) perfRows.set(pg.task, [...(perfRows.get(pg.task) ?? []), row]);
      }
    }
    if (rs.some((r) => /evidence (submission )?checklist/i.test(r.s))) {
      const used = new Set<string>();
      // "2.2 Evidence submission checklist": only the questions of section 2.2
      const section = rs.map((r) => SECTION_LIST.exec(r.s)?.[1]).find(Boolean);
      const candidates = section ? taskQs.filter((q) => q.key.startsWith(`${section}.`)) : taskQs;
      for (const row of rowGroups(pg.page)) {
        const words = new Set(WORD(row[0].label));
        let best: { key: string; score: number } | null = null;
        for (const q of candidates) {
          if (used.has(q.key)) continue;
          const qw = new Set(WORD(q.label));
          const common = [...words].filter((w) => qw.has(w)).length;
          const score = common / Math.max(1, Math.min(words.size, qw.size));
          if (!best || score > best.score) best = { key: q.key, score };
        }
        for (const d of row) d.checklist = "written";
        if (best && best.score >= 0.5) { used.add(best.key); for (const d of row) d.questionKey = best.key; }
      }
    }
  }
  // the performance rows are the task's questions in order, when there are as many rows as questions (reference lists not counted);
  // otherwise (rows naming activities, not questions) the trainer ticks them
  for (const [task, rowsList] of perfRows) {
    const qs = questions.filter((q) => q.task === task && !/\.references$/.test(q.key)).sort((a, b) => a.header.page - b.header.page || a.header.y - b.header.y);
    if (rowsList.length === qs.length) rowsList.forEach((row, i) => { for (const d of row) d.questionKey = qs[i].key; });
  }
}

/** The whole-pack student declaration ("19. Student declaration" on one page, signed on the next): its text and where it is printed. */
function packDeclaration(pages: Page[], rowsOf: Record<number, { y: number; x: number; s: string }[]>): NonNullable<PdfTemplate["declarations"]>[number] | null {
  for (const p of pages) {
    const rs = rowsOf[p.m.page] ?? [];
    const h = rs.findIndex((r) => /^\d{1,2}\.\s*Student declaration$/i.test(r.s));
    if (h < 0) continue;
    const parts: { page: number; rows: { y: number; s: string }[] }[] = [{ page: p.m.page, rows: rs.slice(h + 1) }];
    let signPage = rs.slice(h + 1).some((r) => /^Student signature/i.test(r.s)) ? p.m.page : null;
    if (!signPage) {
      const nr = rowsOf[p.m.page + 1] ?? [];
      const sig = nr.findIndex((r) => /^Student signature/i.test(r.s));
      if (sig < 0) return null;
      parts.push({ page: p.m.page + 1, rows: nr.slice(0, sig) });
      signPage = p.m.page + 1;
    }
    for (const part of parts) { const i = part.rows.findIndex((r) => /^Student signature/i.test(r.s)); if (i >= 0) part.rows = part.rows.slice(0, i); }
    const rects = parts.filter((x) => x.rows.length).map((x) => {
      const pm = pages[x.page - 1].m; const top = x.page === p.m.page ? rs[h].y - 4 : x.rows[0].y - 4; const bottomY = x.rows[x.rows.length - 1].y + 16;
      return toFraction(x.page, pm.W, pm.H, { x: 36, y: top, w: pm.W - 72, h: bottomY - top });
    });
    return { task: null, page: signPage, kind: "pack", text: parts.flatMap((x) => x.rows.map((r) => r.s)).join(" ").replace(/\s+/g, " ").trim().slice(0, 4000), rect: rects[0], rects };
  }
  return null;
}

/** Each question's tables: the group and row every cell belongs to, and whether its rows are fixed (printed row names). */
function groupTables(fields: TemplateField[]) {
  const keys = [...new Set(fields.filter((f) => f.kind === "table_cell" && f.questionKey).map((f) => f.questionKey!))];
  for (const key of keys) {
    tablesOf(fields.filter((f) => f.questionKey === key && f.role === "student")).forEach((t, ti) => {
      for (const r of t.rows) for (const c of r.cells) if (c?.table) { c.table.group = `${key}#${ti + 1}`; c.table.rowKey = r.id; c.table.fixed = t.fixedRows; }
    });
  }
}
