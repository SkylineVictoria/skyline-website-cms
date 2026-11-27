/**
 * ASM-ANY-LAYOUT (owner 2026-11-27): a workbook template for any layout, by rules (no AI), from the candidates (candidates.ts).
 *  - Questions: their labels vary ("Question 1", "Q1", "1.", "1.1", "Task 1 Question 2", "a)"); empty areas are found first, then each
 *    is attached to the nearest question label above it (same page, else the pages before). No SLIT header row or Satisfactory column
 *    is needed.
 *  - Record fields (name, ID, unit, dates), signatures, Yes / No pairs, rating rows, marking-checklist rows: by their printed labels.
 *  - What the rules cannot settle is returned as `unresolved`: only those go to the AI classifier (the page image + numbered list), and
 *    its answers are applied with applyClassification (only real candidates; anything else is refused).
 * The SLIT design keeps its own detector (detect.ts) as the fast path: detectAny uses it whenever it finds that design's questions.
 */
import type { Box, PageModel } from "./pageModel";
import { findCandidates, pageChrome, textRows, type Candidate } from "./candidates";
import { detectTemplate, type DetectInput } from "./detect";
import { toFraction, TRAINER_PAGES, type AutoKey, type FieldKind, type FieldRole, type PageKind, type PdfTemplate, type Rect, type TemplateField, type TemplatePage, type TemplateQuestion, type TemplateTask } from "./model";

export const GENERIC_DETECTOR_VERSION = "asm-pdf-generic/1";

const bottom = (b: Box) => b.y + b.h;
const right = (b: Box) => b.x + b.w;

/** A question label as printed. Returns the printed number and how it is written. */
export function questionLabel(s: string): { num: string; display: string } | null {
  const t = s.trim();
  let m = /^task\s*(\d+)\s*[-–:]?\s*question\s*(\d+(?:\.\d+)*)\b/i.exec(t);
  if (m) return { num: `${m[1]}.${m[2]}`, display: m[0].replace(/\s+/g, " ") };
  m = /^question\s*(\d+(?:\.\d+)*[a-z]?)\b\.?/i.exec(t);
  if (m) return { num: m[1], display: `Question ${m[1]}` };
  m = /^q\s*(\d+(?:\.\d+)*[a-z]?)\b\.?/i.exec(t);
  if (m) return { num: m[1], display: `Q${m[1]}` };
  m = /^(\d+(?:\.\d+)+)\.?\s+\S/.exec(t);
  if (m) return { num: m[1], display: m[1] };
  m = /^(\d{1,2})[.)]\s+\S/.exec(t);
  if (m) return { num: m[1], display: `${m[1]}.` };
  m = /^\(?([a-z])\)\s+\S/.exec(t);
  if (m) return { num: m[1], display: `${m[1]})` };
  return null;
}

/** Record values by their printed label (what the enrolment fills). */
const RECORD_LABELS: [RegExp, AutoKey][] = [
  [/^(student|candidate|learner)('s)?\s*(full\s*)?name\b|^name of (the )?(student|candidate|learner)/i, "student_name"],
  [/^(student|candidate|learner)\s*(id|number|no\.?)\b/i, "student_id"],
  [/^(student|candidate|learner)\s*e-?mail/i, "student_email"],
  [/^(trainer|assessor)(\s*\/\s*(trainer|assessor))?(\s*full)?\s*name\b/i, "trainer_name"],
  [/^unit\s*code\s*(&|and)\s*(title|name)|^unit\s*of\s*competency\b/i, "unit_code_name"],
  [/^unit\s*code\b/i, "unit_code"],
  [/^unit\s*(name|title)\b/i, "unit_name"],
  [/^qualification\s*code/i, "qualification_code"],
  [/^qualification(\s*(name|title))?$/i, "qualification_name"],
  [/^(date\s*of\s*submission|submission\s*date|date\s*submitted)\b/i, "submission_date"],
  [/^start\s*date/i, "start_date"],
  [/^end\s*date/i, "end_date"],
];
const clean = (s: string) => s.replace(/\s*[:*]\s*$/, "").replace(/\s+/g, " ").trim();
const recordKey = (label: string): AutoKey | null => RECORD_LABELS.find(([re]) => re.test(clean(label)))?.[1] ?? null;
const SIGNATURE = /signature|signed|\bsign\b/i;
const DATE_LABEL = /^(date|dates|date\/s|assessment date\/?s?|date signed|completion date)\b/i;
const TRAINER_WORDS = /\b(assessor|trainer|supervisor|office use|marker)\b/i;
const STUDENT_WORDS = /\b(student|candidate|learner)\b/i;

const TRAINER_SECTION = /^(office use only|for (the )?assessor use only|assessor use only|assessment marking|assessment marking checklist|assessment outcome|results sheet|outcome recording sheet|assessor declaration)/i;
const EVALUATION = /evaluation form/i;
const APPENDIX = /^appendix\b/i;
const TASK_HEADING = /^(assessment\s+)?task\s*[-–]?\s*(\d+)\b/i;

interface Label { page: number; y: number; x: number; num: string; display: string; text: string; task: number | null; rowIndex: number; strong: boolean; key?: string }
interface Row extends Box { s: string }

export interface GenericResult {
  template: PdfTemplate;
  candidates: Candidate[];
  /** Candidates the rules could not settle (the AI classifier's input). */
  unresolved: Candidate[];
  /** How each candidate was settled: "rules" or left for "ai"; ids of candidates rejected as not fields. */
  settledBy: Record<string, "rules" | "ai" | "none">;
  /** Each page's size in points (for candidate rectangles as fractions). */
  sizes?: Record<number, { W: number; H: number }>;
}

/** The SLIT design's detector when it recognises the workbook; else the generic rules (fast path first, no AI either way). */
export function detectAny(models: PageModel[], pdf: DetectInput, at = new Date().toISOString()): GenericResult & { path: "slit" | "generic" } {
  const slit = detectTemplate(models, pdf, at);
  if (slit.questions.length > 0) return { template: slit, candidates: [], unresolved: [], settledBy: {}, path: "slit" };
  return { ...detectGeneric(models, pdf, at), path: "generic" };
}

export function detectGeneric(models: PageModel[], pdf: DetectInput, at = new Date().toISOString()): GenericResult {
  const chrome = pageChrome(models);
  const rowsOf: Row[][] = models.map((m, i) => textRows(m.texts.filter((t) => t.y >= chrome[i].top - 1 && bottom(t) <= chrome[i].bottom + 1)));
  const candidates = findCandidates(models);
  const byPage = new Map<number, Candidate[]>();
  for (const c of candidates) { if (!byPage.has(c.page)) byPage.set(c.page, []); byPage.get(c.page)!.push(c); }

  // ---------- pages: tasks, trainer section, evaluation ----------
  const pages: TemplatePage[] = []; const tasks: TemplateTask[] = [];
  let task: number | null = null; let trainer = false; let evaluation = false; let appendix = false;
  models.forEach((m, i) => {
    const rs = rowsOf[i];
    const head = rs.slice(0, 3).map((r) => r.s).join(" ");
    if (rs.slice(0, 2).some((r) => TRAINER_SECTION.test(r.s))) trainer = true;
    if (!trainer && rs.slice(0, 2).some((r) => EVALUATION.test(r.s))) evaluation = true;
    if (!trainer && !evaluation && rs.slice(0, 1).some((r) => APPENDIX.test(r.s))) appendix = true;
    const th = rs.find((r) => r.h >= 13 && TASK_HEADING.test(r.s) && r.y < chrome[i].top + 120);
    let kind: PageKind = "info";
    if (th && !trainer) {
      task = Number(TASK_HEADING.exec(th.s)![2]); appendix = false; evaluation = false;
      const title = rs.find((r) => r.y > th.y + 2)?.s ?? th.s;
      tasks.push({ number: String(task), title: title.slice(0, 200), firstPage: m.page, lastPage: m.page });
      kind = "task_start";
    }
    if (trainer) {
      kind = /outcome|results/i.test(head) ? "results_sheet" : /declaration/i.test(head) ? "summary" : "marking_checklist";
      const t2 = rs.find((r) => TASK_HEADING.test(r.s.replace(/^assessment\s+/i, "assessment ")));
      if (t2) task = Number(TASK_HEADING.exec(t2.s)![2]);
    } else if (evaluation) kind = "appendix_b";
    else if (appendix) kind = "info";
    else if (!task && (byPage.get(m.page) ?? []).length) kind = "details";
    if (task && !trainer && !appendix && !evaluation && tasks.length) tasks[tasks.length - 1].lastPage = m.page;
    pages.push({ page: m.page, kind, audience: trainer ? "trainer" : "student", task: trainer ? task : appendix || evaluation ? null : task });
  });
  const pageInfo = (n: number) => pages[n - 1];

  // ---------- question labels (student task pages) ----------
  const labels: Label[] = [];
  models.forEach((m, i) => {
    const p = pages[i];
    if (p.audience !== "student" || p.task == null) return;
    rowsOf[i].forEach((r, k) => {
      const q = questionLabel(r.s);
      if (!q) return;
      // a numbered instruction ("1. Ensure you answer...") is a label only if an empty area follows before the next label
      // the label with the question text under it (until the next label or empty area)
      const nextStop = Math.min(...rowsOf[i].slice(k + 1).filter((x) => questionLabel(x.s)).map((x) => x.y), ...(byPage.get(m.page) ?? []).filter((c) => c.box.y > r.y + 2).map((c) => c.box.y), chrome[i].bottom);
      const text = rowsOf[i].slice(k).filter((x) => x.y < nextStop - 1).slice(0, 8).map((x) => x.s).join(" ");
      labels.push({ page: m.page, y: r.y, x: r.x, num: q.num, display: q.display, text, task: p.task, rowIndex: k, strong: /^(task|question|q)/i.test(q.display) });
    });
  });
  labels.sort((a, b) => a.page - b.page || a.y - b.y);
  // a numbered list item ("1. Ensure you...") or a part ("a)") is a question label only when an empty area follows it before the next label
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i]; if (l.strong) continue;
    const next = labels.slice(i + 1).find((x) => x.page === l.page);
    const limit = next ? next.y : Infinity;
    if (!(byPage.get(l.page) ?? []).some((c) => c.shape !== "tick" && c.box.y > l.y + 2 && c.box.y < limit)) labels.splice(i, 1);
  }
  // keys: the printed number, prefixed with the task when two tasks print the same number
  const tasksOfNum = new Map<string, Set<number | null>>();
  for (const l of labels) { if (!tasksOfNum.has(l.num)) tasksOfNum.set(l.num, new Set()); tasksOfNum.get(l.num)!.add(l.task); }
  // numbering that restarts in each task: every key carries its task (1.1 ... 1.10, 2.1 ...)
  const anyRepeat = [...tasksOfNum.values()].some((s) => s.size > 1);
  const keyUsed = new Set<string>();
  for (const l of labels) {
    let k = l.task != null && anyRepeat ? `${l.task}.${l.num}` : l.num;
    if (keyUsed.has(k)) { let n = 2; while (keyUsed.has(`${k}-${n}`)) n++; k = `${k}-${n}`; }
    keyUsed.add(k); l.key = k;
  }
  const keyOf = (l: Label): string => l.key!;

  const fields: TemplateField[] = [];
  const settledBy: Record<string, "rules" | "ai" | "none"> = {};
  const unresolved: Candidate[] = [];
  const W = (n: number) => models[n - 1].W; const Hh = (n: number) => models[n - 1].H;
  const frac = (c: Candidate) => toFraction(c.page, W(c.page), Hh(c.page), c.box);
  const used = new Set<string>();
  const add = (c: Candidate, f: Omit<TemplateField, keyof Rect | "id"> & { id?: string }) => {
    let id = f.id ?? `g${c.page}-${c.n}`;
    while (used.has(id)) id += "x";
    used.add(id);
    fields.push({ ...frac(c), ...f, id, origin: "rules" } as TemplateField);
    settledBy[c.id] = "rules";
  };

  // nearest question label above a candidate (same page, else earlier pages of the same task)
  const labelFor = (c: Candidate): Label | null => {
    const p = pageInfo(c.page);
    let best: Label | null = null;
    for (const l of labels) {
      if (l.task !== p.task) continue;
      if (l.page < c.page || (l.page === c.page && l.y < c.box.y - 1)) best = l; else break;
    }
    return best;
  };

  // ---------- rule passes ----------
  const pageCands = (n: number) => byPage.get(n) ?? [];
  for (const [page, cs] of byPage) {
    const p = pageInfo(page);
    const aud: FieldRole = p.audience === "trainer" ? "trainer" : "student";
    // ticks: Yes / No pairs, rating rows (columns 1..5), checklist rows
    const ticks = cs.filter((c) => c.shape === "tick");
    const rowsOfTicks = new Map<string, Candidate[]>();
    for (const t of ticks) { const k = `${t.table?.id ?? "free"}:${Math.round(t.box.y / 4)}`; if (!rowsOfTicks.has(k)) rowsOfTicks.set(k, []); rowsOfTicks.get(k)!.push(t); }
    for (const [k, row] of rowsOfTicks) {
      row.sort((a, b) => a.box.x - b.box.x);
      const opts = row.map((t) => (t.tickLabel || t.column).trim().toLowerCase());
      const yesNo = row.length === 2 && /^(yes|y|s|satisfactory|competent|c)$/.test(opts[0]) && /^(no|n|ns|nys|not satisfactory|not yet competent|nyc)$/.test(opts[1]);
      const rating = row.length >= 3 && row.length <= 7 && opts.every((o, i) => o === String(i + 1));
      const group = `g${page}-${k.replace(/[^a-z0-9]+/gi, "-")}`;
      const rowLabel = (row[0].left || row[0].above).slice(0, 160);
      if (yesNo) {
        const q = aud === "student" ? labelFor(row[0]) : null;
        const checklist = aud === "trainer" ? checklistRow(row[0], labels, p.task) : null;
        row.forEach((t, i) => add(t, { role: aud, kind: "yes_no", questionKey: checklist?.label ? keyOf(checklist.label) : q ? keyOf(q) : null, label: rowLabel, group, option: i === 0 ? "yes" : "no", checklist: checklist?.kind ?? null }));
      } else if (rating) {
        row.forEach((t, i) => add(t, { role: aud, kind: "rating", questionKey: null, label: rowLabel, group, option: String(i + 1) }));
      }
    }
    for (const c of cs) {
      if (settledBy[c.id]) continue;
      const label = clean(c.left || (c.table && c.table.row > 0 ? "" : c.column));
      const rk = label ? recordKey(label) : null;
      if (rk && !(aud === "trainer" && rk === "trainer_name" && false)) {
        add(c, { role: "auto", kind: "auto", questionKey: null, label, dataKey: rk });
        continue;
      }
      if (label && SIGNATURE.test(label)) {
        const role: FieldRole = TRAINER_WORDS.test(label) ? "trainer" : STUDENT_WORDS.test(label) ? "student" : aud;
        add(c, { role, kind: "signature", questionKey: null, label });
        continue;
      }
      if ((label && DATE_LABEL.test(label)) || /date/i.test(c.placeholder ?? "")) {
        const role: FieldRole = TRAINER_WORDS.test(label) ? "trainer" : STUDENT_WORDS.test(label) ? "student" : aud;
        add(c, { role, kind: "date", questionKey: null, label: label || "Date" });
        continue;
      }
      if (c.shape === "tick") continue; // single ticks without a pattern: the classifier
      if (label && /^(feedback|comments?|notes?|remarks|assessor comments|trainer comments)\b/i.test(label) && c.shape === "box") {
        add(c, { role: aud === "trainer" || TRAINER_WORDS.test(label) ? "trainer" : "student", kind: "text", questionKey: null, label });
        continue;
      }
      // an answer area under a question label (student task pages)
      if (aud === "student" && p.task != null) {
        const q = labelFor(c);
        if (q) {
          const isCell = c.shape === "cell" && c.table && (c.left || c.column);
          add(c, {
            role: "student", kind: isCell ? "table_cell" : "text", questionKey: keyOf(q), label: isCell ? [c.left, c.column].filter(Boolean).join(" · ").slice(0, 160) || q.display : q.display,
            table: isCell ? { row: c.table!.row, col: c.table!.col, rowLabel: c.left || undefined, column: c.column || undefined, group: `g${c.page}-${c.table!.id}` } : null,
          });
          continue;
        }
      }
    }
  }

  // ---------- questions ----------
  const qFields = new Map<string, TemplateField[]>();
  for (const f of fields) if (f.questionKey && f.role === "student") { if (!qFields.has(f.questionKey)) qFields.set(f.questionKey, []); qFields.get(f.questionKey)!.push(f); }
  const questions: TemplateQuestion[] = [];
  let seq = 0;
  const seenKeys = new Set<string>();
  for (const l of labels) {
    const key = keyOf(l);
    if (seenKeys.has(key)) continue;
    const fs = qFields.get(key);
    if (!fs?.length) continue;
    seenKeys.add(key);
    seq++;
    const m = models[l.page - 1]; const rs = rowsOf[l.page - 1];
    const firstOnPage = fs.filter((f) => f.page === l.page).map((f) => f.y * m.H);
    const end = firstOnPage.length ? Math.min(...firstOnPage) : chrome[l.page - 1].bottom;
    const textRowsQ = rs.filter((r) => r.y >= l.y - 1 && r.y < end - 1);
    const text = textRowsQ.map((r) => r.s).join(" ").replace(/\s+/g, " ").trim();
    const hb = { x: Math.max(0, Math.min(l.x, ...textRowsQ.map((r) => r.x)) - 4), y: Math.max(0, l.y - 3), w: 0, h: 0 };
    hb.w = Math.min(m.W - hb.x, Math.max(...textRowsQ.map((r) => right(r)), l.x + 100) + 6 - hb.x);
    hb.h = Math.max(10, Math.min(end, Math.max(...textRowsQ.map((r) => bottom(r)), l.y + 12) + 3) - hb.y);
    const header = toFraction(l.page, m.W, m.H, hb);
    const areas: Rect[] = [];
    for (const page of [...new Set(fs.map((f) => f.page))].sort((a, b) => a - b)) {
      const on = fs.filter((f) => f.page === page);
      const x = Math.min(...on.map((f) => f.x)); const y = Math.min(...on.map((f) => f.y));
      areas.push({ page, x, y, w: Math.max(...on.map((f) => f.x + f.w)) - x, h: Math.max(...on.map((f) => f.y + f.h)) - y });
    }
    questions.push({ key, seq: `Q${seq}`, display: l.display, label: text.replace(/^(task\s*\d+\s*)?(question|q)\s*\d+(\.\d+)*\s*/i, "").slice(0, 600) || l.display, task: l.task, header, prompt: header, areas });
  }
  // a field whose label produced no question (none attached) keeps no question key
  const keys = new Set(questions.map((q) => q.key));
  for (const f of fields) if (f.questionKey && !keys.has(f.questionKey)) f.questionKey = null;

  // ---------- what is left goes to the classifier ----------
  for (const c of candidates) {
    if (settledBy[c.id]) continue;
    const p = pageInfo(c.page);
    if (p.kind === "info" && p.task == null && p.audience === "student" && !pageCands(c.page).some((x) => settledBy[x.id])) {
      // appendix / case study pages: an empty box there is still asked about (it may be a form)
    }
    settledBy[c.id] = "ai";
    unresolved.push(c);
  }
  // pages with fields of a question are question pages
  for (const p of pages) if (p.audience === "student" && p.kind === "info" && fields.some((f) => f.page === p.page && f.questionKey)) p.kind = "question";

  const template: PdfTemplate = {
    version: 1,
    pdf: { path: pdf.path, sha256: pdf.sha256, pages: models.length, fileName: pdf.fileName ?? null },
    pages, tasks, questions, fields,
    detected: { by: GENERIC_DETECTOR_VERSION, at },
  };
  const sizes = Object.fromEntries(models.map((m) => [m.page, { W: m.W, H: m.H }]));
  return { template, candidates, unresolved, settledBy, sizes };
}

/** A marking-checklist row: "performance" when its text or number matches a question of its task, else "evidence". */
function checklistRow(c: Candidate, labels: Label[], task: number | null): { kind: "performance" | "evidence"; label: Label | null } {
  const text = c.left.toLowerCase();
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const tw = words(text);
  let best: { l: Label; score: number } | null = null;
  for (const l of labels) {
    if (task != null && l.task !== task) continue;
    const lw = words(l.text);
    let n = 0; for (const w of tw) if (lw.has(w)) n++;
    const score = tw.size ? n / tw.size : 0;
    if (!best || score > best.score) best = { l, score };
  }
  return best && best.score >= 0.5 ? { kind: "performance", label: best.l } : { kind: "evidence", label: null };
}

/** The classifier's answer for one candidate (asm-import classify_fields; validated there against the real candidate numbers). */
export interface AiAnswer { n: number; class: "student_answer" | "trainer_field" | "record_field" | "not_a_field"; question: string | null; kind: "text" | "table_cell" | "yes_no" | "tick" | "signature" | "date"; record: string | null }

const AUTO_OK = new Set<string>(["student_name", "student_id", "student_email", "trainer_name", "unit_code", "unit_name", "unit_code_name", "qualification_code", "qualification_name", "submission_date", "start_date", "end_date"]);
/** "Question 4", "Q4", "4." -> "4"; a key is matched on the printed number, with or without its task. */
const printedNum = (s: string) => s.replace(/^(tasks*d+s*)?(question|q)s*/i, "").replace(/[.)s]+$/, "").trim();

/**
 * Adds the classifier's fields to the template (origin "ai", review "pending"): only for candidates that were left unresolved, each
 * once; "not a field" adds nothing. Yes / No answers on one row form one choice (first = yes). Returns the template and the count.
 */
export function applyClassification(result: GenericResult, answers: Record<number, AiAnswer[]>): { template: PdfTemplate; added: number; notFields: number } {
  const t: PdfTemplate = structuredClone(result.template);
  const open = new Map(result.unresolved.map((c) => [`${c.page}:${c.n}`, c] as const));
  const ids = new Set(t.fields.map((f) => f.id));
  let added = 0; let notFields = 0;
  const pageOf = (n: number) => t.pages[n - 1];
  for (const [pageStr, list] of Object.entries(answers)) {
    const page = Number(pageStr);
    const p = pageOf(page);
    const yesNo: { c: Candidate; a: AiAnswer }[] = [];
    for (const a of list) {
      const c = open.get(`${page}:${a.n}`);
      if (!c) continue;
      open.delete(`${page}:${a.n}`);
      if (a.class === "not_a_field") { notFields++; result.settledBy[c.id] = "none"; continue; }
      const q = a.question ? t.questions.find((x) => (x.task === p?.task || x.task == null) && (printedNum(x.display ?? "") === printedNum(a.question!) || x.key === a.question || x.key.endsWith(`.${printedNum(a.question!)}`))) : undefined;
      if (a.kind === "yes_no") { yesNo.push({ c, a }); continue; }
      let id = `ai${page}-${c.n}`; while (ids.has(id)) id += "x"; ids.add(id);
      const label = [c.left, c.column].filter(Boolean).join(" · ").slice(0, 160) || c.above.slice(0, 160) || "Field";
      const base = { id, ...toFraction(page, 1, 1, { x: 0, y: 0, w: 0, h: 0 }), origin: "ai" as const, review: "pending" as const };
      const geo = { page, x: 0, y: 0, w: 0, h: 0 };
      Object.assign(geo, fracOf(result, c));
      if (a.class === "record_field" && a.record && AUTO_OK.has(a.record)) {
        t.fields.push({ ...base, ...geo, role: "auto", kind: "auto", questionKey: null, label, dataKey: a.record as AutoKey });
      } else {
        const role: FieldRole = a.class === "trainer_field" || (a.class === "record_field" && p?.audience === "trainer") ? "trainer" : "student";
        const kind: FieldKind = a.kind === "tick" ? "checkbox" : a.kind;
        t.fields.push({ ...base, ...geo, role, kind, questionKey: q?.key ?? null, label,
          table: kind === "table_cell" && c.table ? { row: c.table.row, col: c.table.col, rowLabel: c.left || undefined, column: c.column || undefined, group: `g${page}-${c.table.id}` } : null });
      }
      result.settledBy[c.id] = "ai"; added++;
    }
    // Yes / No: the two options of one row are one choice
    const rows = new Map<number, { c: Candidate; a: AiAnswer }[]>();
    for (const y of yesNo) { const k = Math.round(y.c.box.y / 4); if (!rows.has(k)) rows.set(k, []); rows.get(k)!.push(y); }
    for (const [k, row] of rows) {
      row.sort((a, b) => a.c.box.x - b.c.box.x);
      const group = `ai${page}-r${k}`;
      row.forEach(({ c, a }, i) => {
        let id = `ai${page}-${c.n}`; while (ids.has(id)) id += "x"; ids.add(id);
        const role: FieldRole = a.class === "trainer_field" ? "trainer" : "student";
        const opt = /^(no|n|ns|nys|nyc)$/i.test(c.tickLabel || c.column) ? "no" : /^(yes|y|s|c)$/i.test(c.tickLabel || c.column) ? "yes" : i === 0 ? "yes" : "no";
        t.fields.push({ id, ...fracOf(result, c), role, kind: "yes_no", questionKey: null, label: (c.left || c.above).slice(0, 160) || "Yes / No", group, option: opt, origin: "ai", review: "pending" });
        result.settledBy[c.id] = "ai"; added++;
      });
    }
  }
  return { template: t, added, notFields };
}

/** A candidate's rectangle as page fractions (the page size is kept with the result). */
function fracOf(result: GenericResult, c: Candidate): Rect {
  const size = result.sizes?.[c.page] ?? { W: 595.32, H: 841.92 };
  return toFraction(c.page, size.W, size.H, c.box);
}
