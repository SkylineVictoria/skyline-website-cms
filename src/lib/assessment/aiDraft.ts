/**
 * ASM-AI-IMPORT: the draft definition and the assessor keys built from the AI's checked document or the standard reader's result
 * (pure logic, shared by the Add assessment screen and the Node tests). Text is used exactly as checked; nothing is reworded here.
 * Answers only ever become QuestionKeys (asm_question_keys), never part of the definition.
 */
import { attachmentCapable, newId, newQuestion, withSchema, isAnswerable } from "./registry";
import { flattenQuestions } from "./definition";
import { workbookNumbering } from "./workbookLayout";
import type { ImportResult, WbImage } from "./workbookImport";
import type { Definition, ImportMeta, Question, QuestionKey, Section, Task } from "./types";
import type { CheckedDocument, CheckedItem, ImportSummary } from "../../../supabase/functions/_shared/asm-import/schema.ts";
import { normalizeNumber } from "../../../supabase/functions/_shared/asm-import/numbering.ts";
import { isResponseLabel } from "../../../supabase/functions/_shared/asm-import/classify.ts";
import { sameHeading } from "../../../supabase/functions/_shared/asm-import/pipeline.ts";
import { checkDocuments, matchGuide, type DocumentCheck, type GuideAnswer, type MatchOutcome, type MatchQuestion } from "../../../supabase/functions/_shared/asm-import/match.ts";

/** Text to read (an instruction item, not a section heading or a drawing): it goes to the task's instructions. */
const isReading = (it: CheckedItem) => it.kind === "instruction" && it.itemType !== "section_heading";

export type { CheckedDocument, DocumentCheck, MatchOutcome, GuideAnswer };
export type ImportKind = "workbook" | "guide";

export interface ImportStatus {
  id: string;
  kind: ImportKind;
  state: "uploading" | "queued" | "running" | "done" | "failed";
  fileName: string;
  pages: number;
  progress: { label: string; done: number; total: number };
  summary: Partial<ImportSummary> & { unit?: string | null; version?: string | null };
  error: string | null;
  usage: { input_tokens?: number; output_tokens?: number; calls?: number; cost_usd?: number | null };
  provider: string | null;
  model: string | null;
  cached: boolean;
  /** The reader version that read it (part of the cache key; older results are read again). */
  readerVersion?: number;
  result: CheckedDocument | null;
}

/** ASM-OVERVIEW C: the stages of the Add assessment waiting screen, driven by the job's real progress (done / total / label). */
export const IMPORT_STAGES = ["Reading the document", "Finding tasks and questions", "Checking numbering and answers", "Almost done"] as const;
export function importStage(s: Pick<ImportStatus, "state" | "progress"> | null): { stage: number; percent: number } {
  if (!s || s.state === "uploading") return { stage: 0, percent: 4 };
  if (s.state === "queued") return { stage: 0, percent: 8 };
  if (s.state === "done") return { stage: IMPORT_STAGES.length, percent: 100 };
  const total = Math.max(1, s.progress?.total ?? 1);
  const done = Math.max(0, Math.min(total, s.progress?.done ?? 0));
  const f = done / total;
  // the worker: outline (done 0 -> 1), one step per task chunk ("Reading task 2 of 3"), then "Finishing" (assembling, checks)
  if (done === 0) return { stage: 0, percent: 10 };
  if (/finish/i.test(s.progress?.label ?? "") || done >= total - 1) return { stage: 3, percent: Math.max(90, Math.min(99, Math.round(100 * f))) };
  return { stage: f >= 0.6 ? 2 : 1, percent: Math.round(10 + 80 * f) };
}

/* ------------------------------------------------------------------ the draft from the AI's checked document */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function meta(it: Pick<CheckedItem, "flags" | "text"> & Partial<Pick<CheckedItem, "pages" | "canonical" | "pdfText" | "itemType" | "classification" | "autoResolved" | "blocking" | "responseAreas">>, number?: string | null): ImportMeta {
  return {
    page: it.pages?.[0] ?? null, confidence: it.flags.length ? "low" : "high", ...(it.flags.length ? { note: it.flags.join(" · "), flags: it.flags } : {}),
    number: number ?? it.canonical ?? null, via: "ai", original: it.text, ...(it.pdfText ? { pdfText: it.pdfText } : {}),
    ...(it.itemType ? { itemType: it.itemType } : {}), ...(it.classification ? { classification: it.classification } : {}),
    ...(it.autoResolved?.length ? { autoResolved: it.autoResolved } : {}), ...(it.blocking ? { blocking: true } : {}),
    ...(it.responseAreas?.length ? { responseAreas: it.responseAreas } : {}),
  };
}

/**
 * ASM-BUILDER-COMPACT: the answer areas printed for a question ("Submission of Supporting Evidence…" = upload, "Mathematics
 * Calculation Box…" = calc) are its response types: the question takes attachments; the areas never become questions.
 */
function withResponseAreas(q: Question, it: CheckedItem): Question {
  if (!it.responseAreas?.length) return q;
  return withSchema({ ...q, config: { ...(q.config ?? {}), ...(attachmentCapable(q.type) ? { allowAttachment: true } : {}) } });
}

function questionFromItem(it: CheckedItem, pictures: WbImage[], used: Set<WbImage>): Question {
  return withResponseAreas(baseQuestionFromItem(it, pictures, used), it);
}

function baseQuestionFromItem(it: CheckedItem, pictures: WbImage[], used: Set<WbImage>): Question {
  // a section heading ("1. Introduction" of a report template) is a section label, never a question: no answer, no model answer
  if (it.itemType === "section_heading") {
    const q = newQuestion("instruction");
    q.config = { html: `<h4>${esc([it.number, it.text].filter(Boolean).join(" "))}</h4>`, attachments: [] };
    q.importMeta = meta(it, it.number ?? null);
    return withSchema(q);
  }
  if (it.kind === "instruction" || it.kind === "drawing") {
    const q = newQuestion("instruction");
    const imgs = it.kind === "drawing" ? pictures.filter((p) => !used.has(p) && it.pages.includes(p.page)).slice(0, 3) : [];
    imgs.forEach((p) => used.add(p));
    const body = it.kind === "drawing"
      ? `${imgs.map((p) => `<figure><img src="${p.src}" alt="${esc(it.text || "Drawing")}" /></figure>`).join("")}${it.text ? `<p><em>${esc(it.text)}</em></p>` : ""}`
      : it.text.split(/\n+/).map((l) => `<p>${esc(l)}</p>`).join("");
    q.config = { html: body, attachments: [] };
    // a drawing the reader found where the workbook's pictures could not be drawn in this browser: say so, and where
    const noPicture = it.kind === "drawing" && !imgs.length ? [`No picture found on page ${it.pages.join(", ")}: add the drawing from the PDF`] : [];
    q.importMeta = meta({ ...it, flags: [...it.flags, ...noPicture] }, null);
    return withSchema(q);
  }
  if (it.kind === "declaration") {
    const q = newQuestion("declaration");
    q.label = "Student declaration"; q.config = { text: it.text };
    q.importMeta = meta(it, null);
    return withSchema(q);
  }
  if (it.kind === "evidence") {
    const q = newQuestion("file_upload");
    q.label = it.text;
    q.importMeta = meta(it);
    return withSchema(q);
  }
  if (it.kind === "table" && it.table && it.table.columns.length) {
    const q = newQuestion("table_grid");
    q.label = it.text || "Complete the table";
    // a category table ("a. Australian and other relevant Standards | Short answer"): the first column names the rows, the others
    // are the answer cells (empty or a box label such as "Short answer")
    const labelled = it.table.columns.length >= 2 && !(it.table.columns[0] ?? "").trim() && it.table.rows.length > 0 && it.table.rows.every((r) => (r[0] ?? "").trim() && r.slice(1).every((c) => !c.trim() || isResponseLabel(c)));
    const answerCols = labelled ? it.table.columns.slice(1) : it.table.columns;
    const columns = answerCols.map((label, i) => ({ id: `c${i + 1}`, label: label || (labelled && answerCols.length === 1 ? "Answer" : `Column ${i + 1}`), kind: "text" }));
    const rows = (it.table.rows.length ? it.table.rows : [[""], [""]]).map((r, i) => ({ id: `r${i + 1}`, label: (r[0] ?? "").trim() || String(i + 1) }));
    q.config = { ...(q.config ?? {}), columns, rows, allowAddRows: false };
    q.importMeta = meta(it);
    return withSchema(q);
  }
  if (it.kind === "multipart" && it.parts.length) {
    const q = newQuestion("case_study");
    q.label = it.text; q.config = { scenario: "" };
    q.children = it.parts.map((p) => {
      const c = newQuestion("short_answer");
      c.label = p.text || p.label;
      const flags = p.verbatim === "close" || p.verbatim === "missing" ? [p.diff || (p.verbatim === "close" ? "Wording differs from the PDF" : "Text not found in the PDF")]
        : p.verbatim === "scanned" ? ["Read from a scanned page: check the text against the page"] : [];
      c.importMeta = { page: it.pages[0] ?? null, confidence: flags.length ? "low" : "high", ...(flags.length ? { flags, note: flags.join(" · ") } : {}), number: it.canonical ? `${normalizeNumber(it.canonical)?.base ?? it.canonical}${p.part}` : p.part, via: "ai", original: c.label, ...(p.pdfText ? { pdfText: p.pdfText } : {}) };
      return withSchema(c);
    });
    q.importMeta = meta(it);
    return withSchema(q);
  }
  const q = newQuestion("long_answer");
  q.label = it.text;
  q.importMeta = meta(it);
  return withSchema(q);
}

/* ------------------------------------------------------------------ ASM-OVERVIEW: the task's structure (layout 2) */

/** The Definition layout the Overview reads: activities, templates, requirements, materials, steps (older drafts fall back). */
export const COMPACT_LAYOUT = 2;

interface Entry { it: CheckedItem; section: string; si: number; idx: number }
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with", "&", "-", "/", "+"]);
const isCap = (w: string) => /^[("'‘“]?[A-Z0-9]/.test(w);

/**
 * The title an activity's text starts with ("Identify and Assess Risks Conduct a risk assessment…" -> "Identify and Assess Risks"):
 * the title-case words before the capitalised word that starts the description (the last capital before the first lowercase word).
 * Null when the text does not start that way.
 */
export function leadingTitle(text: string): string | null {
  const w = words(text.replace(/\s+/g, " "));
  const firstLower = w.findIndex((x) => !isCap(x) && !SMALL_WORDS.has(x.toLowerCase()));
  if (firstLower < 2) return null;
  let start = firstLower - 1;
  while (start > 0 && !isCap(w[start])) start -= 1;
  const title = w.slice(0, start);
  while (title.length && SMALL_WORDS.has(title[title.length - 1].toLowerCase())) title.pop();
  if (title.length < 2 || title.length > 9) return null;
  return title.join(" ").replace(/[:.,]$/, "");
}

/** A heading a reading paragraph starts with ("Assessment Instructions (How?)", "Candidate Role:", "Timing:"), and the rest. */
export function paragraphHeading(text: string): { heading: string; rest: string } | null {
  const t = text.replace(/\s+/g, " ").trim();
  const q = t.match(/^(.{3,90}?\([^)]{1,60}\?\))\.?\s+(.+)$/); // "Assessment date/s and timing/s (When?) This assessment…"
  if (q && words(q[1]).length <= 12) return { heading: q[1], rest: q[2] };
  const c = t.match(/^([A-Z][^:.?!]{1,60}?):\s+(.+)$/); // "Candidate Role: Pavement Design Technician…"
  if (!c) return null;
  // a heading, not the start of a sentence ("Candidates must interpret this brief to: …"): short, or mostly capitalised words
  // ("Assessment method-based instructions and guidelines:" is a heading; a sentence has a verb such as must / will / are / to)
  const w = words(c[1]);
  const VERBISH = new Set(["must", "should", "will", "shall", "are", "is", "be", "can", "may", "to", "need", "needs", "have", "has"]);
  if (w.length <= 8 && !w.some((x) => VERBISH.has(x.toLowerCase()))) return { heading: c[1], rest: c[2] };
  return null;
}

const para = (text: string) => text.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("");
/** A reading paragraph as HTML: its own heading (when it starts with one) as <h4>, the text as paragraphs. */
const readingHtml = (text: string) => { const h = paragraphHeading(text); return h ? `<h4>${esc(h.heading)}</h4>${para(h.rest)}` : para(text); };

const FIELD_LABEL = /^(project|prepared by|approved by|date|subject|to|from|summary|notes?|remarks|recommendations|validated by|validation outcome|justification|conclusion|overview|selected option|reason|details|purpose of validation)\s*:?$/i;
/** A form field / part of a report template: a short label, a table, a numbered section with its parts, or "Label:". */
function fieldLike(it: CheckedItem): boolean {
  if (it.kind === "table" || it.itemType === "section_heading" || it.itemType === "table_row") return true;
  if (it.kind === "multipart") return it.parts.every((p) => /^\d+\.?$|^[a-z]$/i.test(p.part || p.label));
  if (it.kind !== "question" && it.kind !== "evidence") return false;
  const t = it.text.trim();
  return FIELD_LABEL.test(t) || /:\s*(short answer)?$/i.test(t) || (words(t).length <= 3 && !t.includes("?"))
    || (/^[A-Z][\w &/-]{1,30}:\s+\S/.test(t) && words(t).length <= 8); // "Selected Option: AC10 Asphalt"
}
const isHardCopyNote = (it: CheckedItem) => it.kind === "evidence" && !it.canonical && /hard copy|securely attached/i.test(it.text);
const isReferenceList = (it: CheckedItem) => it.kind === "question" && /reference list|references? (to|used)|list (all )?(the )?references/i.test(it.text);
const isCaseStudy = (e: Entry) => /^case study\b/i.test(e.it.text) || /^(appendix|case study)\b/i.test(e.section) || /\bproject plan\b/i.test(e.section) && /^task \d/i.test(e.section);
const isRolePlay = (e: Entry) => /role-?\s?play brief/i.test(e.section);
/** Words that say what a block / deliverable is, for matching an activity's deliverable with its response template. */
const keyWords = (s: string) => new Set(s.toLowerCase().replace(/occasion \d+/g, " ").replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 2 && !["and", "the", "with", "for", "completed", "record", "sheet", "document", "report"].includes(w)));
function sameDeliverable(deliverable: string, title: string): boolean {
  const a = keyWords(deliverable); const b = keyWords(title);
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / Math.min(a.size, b.size) >= 0.6;
}
/** The short title of a template / response block: up to "Title:", the form fields printed after it, or "- Occasion 2". */
function blockTitle(head: CheckedItem, section: string): string {
  const text = head.text.replace(/\s+/g, " ").trim();
  if (!text || FIELD_LABEL.test(text)) return section;
  const cut = text.split(/:\s|:$| Project Prepared by\b| To: | Date: /)[0].replace(/\s*-\s*Occasion \d+.*$/i, (m) => m.match(/-\s*Occasion \d+/i)?.[0] ?? "").trim();
  return cut || section;
}
const UPLOAD_LABELS: [RegExp, string][] = [[/graph/i, "graphs"], [/calculation|mathematic/i, "calculations"], [/additional work/i, "additional work"], [/screenshot/i, "screenshots"]];
const uploadLabel = (a: { kind: string; text: string }) => (a.kind === "calc" ? "calculations" : UPLOAD_LABELS.find(([re]) => re.test(a.text))?.[1] ?? "files");

function fieldsFromItem(it: CheckedItem, pictures: WbImage[], used: Set<WbImage>): Question[] {
  if (it.kind === "multipart" && it.parts.length && it.parts.every((p) => /^\d+\.?$/.test(p.part || p.label))) {
    // the numbered sections of a report template ("1. Introduction", "6. Approval Process"): one field each
    return it.parts.map((p) => {
      const q = newQuestion("long_answer");
      const marker = (p.part || p.label).replace(/\.?$/, ".");
      const empty = !p.text.trim();
      q.label = empty ? `Part ${marker}` : `${marker} ${p.text}`.trim();
      const flags = empty ? [`No text was read for part ${marker} on page ${it.pages.join(", ")}: add its heading from the PDF`] : [];
      q.importMeta = { page: it.pages[0] ?? null, confidence: flags.length ? "low" : "high", ...(flags.length ? { flags, note: flags[0] } : {}), number: null, via: "ai", original: q.label };
      return withSchema(q);
    });
  }
  const q = questionFromItem(it, pictures, used);
  // a form field ("Project", "Prepared by", "Date") is a short answer; the numbered printed number belongs to the template, not the field
  if (q.type === "long_answer" && (FIELD_LABEL.test(q.label.trim()) || words(q.label).length <= 3)) { q.type = "short_answer"; }
  if (q.importMeta) q.importMeta = { ...q.importMeta, number: null };
  return [withSchema(q)];
}

/** One task of the AI's document in the Overview layout (see COMPACT_LAYOUT). Text is never reworded. */
function taskFromAi(t: CheckedDocument["tasks"][0], pictures: WbImage[], used: Set<WbImage>): Task {
  const stream: Entry[] = t.sections.flatMap((s, si) => s.items.map((it) => ({ it, section: s.title, si }))).map((e, idx) => ({ ...e, idx }));
  const taken = new Set<number>();
  const task: Task = { id: newId("t"), title: t.number && !t.title.includes(t.number) ? `Task ${t.number}: ${t.title}` : t.title, instructions: "", sections: [] };
  const materials: NonNullable<Task["materials"]> = [];
  const pages = new Set<number>();

  // general task steps: reading items numbered 1., 2., 3. … in a row (at least three)
  for (let i = 0; i < stream.length; i++) {
    if (!(isReading(stream[i].it) && /^1\.?$/.test(stream[i].it.number ?? ""))) continue;
    let j = i;
    while (j + 1 < stream.length && isReading(stream[j + 1].it) && new RegExp(`^${j + 2 - i}\\.?$`).test(stream[j + 1].it.number ?? "")) j++;
    if (j - i + 1 >= 3) { task.steps = stream.slice(i, j + 1).map((e) => { taken.add(e.idx); return { text: e.it.text.trim(), page: e.it.pages[0] ?? null }; }); break; }
  }
  // supporting material: drawings (with their picture), the case study, the role-play brief (one card per brief)
  const rolePlay = new Map<string, Entry[]>();
  for (const e of stream) {
    if (taken.has(e.idx)) continue;
    if (e.it.kind === "drawing") {
      const imgs = pictures.filter((p) => !used.has(p) && e.it.pages.includes(p.page)).slice(0, 3);
      if (!imgs.length) continue; // no picture here: stays a flagged block among the questions (see baseQuestionFromItem)
      imgs.forEach((p) => used.add(p));
      materials.push({ id: newId("m"), kind: "drawing", title: e.it.text || "Drawing", pages: e.it.pages, html: imgs.map((p) => `<figure><img src="${p.src}" alt="${esc(e.it.text || "Drawing")}" /></figure>`).join("") });
      taken.add(e.idx);
    } else if (isReading(e.it) && isRolePlay(e)) {
      rolePlay.set(e.section, [...(rolePlay.get(e.section) ?? []), e]); taken.add(e.idx);
    } else if (isReading(e.it) && isCaseStudy(e)) {
      const own = e.it.text.match(/^case study(\s*\([^)]*\))?/i)?.[0];
      materials.push({ id: newId("m"), kind: "case_study", title: own ? own.replace(/^case study/i, "Case Study") : e.section, pages: e.it.pages, html: readingHtml(e.it.text) });
      taken.add(e.idx);
    }
  }
  for (const [title, list] of rolePlay) {
    materials.push({ id: newId("m"), kind: "role_play", title, pages: [...new Set(list.flatMap((e) => e.it.pages))].sort((a, b) => a - b), html: list.map((e) => readingHtml(e.it.text)).join("") });
  }
  // a hard-copy note printed above the upload / calculation boxes belongs to those boxes: the boxes go to the next question
  let carryAreas: NonNullable<ImportMeta["responseAreas"]> = [];
  const areasOf = new Map<number, NonNullable<ImportMeta["responseAreas"]>>();
  for (const e of stream) {
    if (taken.has(e.idx)) continue;
    if (isHardCopyNote(e.it)) {
      carryAreas = [...carryAreas, ...(e.it.responseAreas ?? []).map((a, k) => ({ ...a, ...(k === 0 ? { note: e.it.text } : {}) }))];
      taken.add(e.idx); continue;
    }
    if (carryAreas.length && !isReading(e.it) && e.it.kind !== "drawing") { areasOf.set(e.idx, [...carryAreas, ...(e.it.responseAreas ?? [])]); carryAreas = []; }
  }
  const withAreas = (e: Entry): CheckedItem => (areasOf.has(e.idx) ? { ...e.it, responseAreas: areasOf.get(e.idx) } : e.it);

  // activities: a reading item followed by its (unnumbered, short) evidence = one activity with that deliverable
  interface Activity { e: Entry; evidence: Entry; title: string }
  const activities: Activity[] = [];
  for (let i = 0; i + 1 < stream.length; i++) {
    const a = stream[i]; const b = stream[i + 1];
    if (taken.has(a.idx) || taken.has(b.idx) || !isReading(a.it) || b.it.kind !== "evidence" || b.it.canonical || words(b.it.text).length > 16) continue;
    // a section of its own ("Identify and Assess Risks": the activity and its evidence) is the activity's printed name
    const ownSection = !sameHeading(a.section, t.title) && stream.filter((x) => x.si === a.si && !taken.has(x.idx)).length <= 2;
    const title = ownSection ? a.section : (leadingTitle(a.it.text) ?? words(a.it.text).slice(0, 6).join(" "));
    activities.push({ e: a, evidence: b, title });
    taken.add(a.idx); taken.add(b.idx);
  }

  // response blocks: a numbered item and the form fields printed after it (a template when it has two fields or more)
  interface Block { head: Entry; items: Entry[]; title: string }
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const e of stream) {
    if (taken.has(e.idx) || isReading(e.it) || e.it.kind === "drawing" || e.it.kind === "declaration") { if (!isReading(e.it)) cur = null; continue; }
    // a template's numbered sections read in two pieces ("1."-"5." then "6.", "7." under another printed number) are one template
    const lastParts = cur ? [...cur.items].reverse().find((x) => x.it.kind === "multipart")?.it.parts ?? null : null;
    const continuesParts = Boolean(cur && e.it.kind === "multipart" && lastParts?.length && Number.parseInt(e.it.parts[0]?.part ?? "", 10) === Number.parseInt(lastParts.at(-1)?.part ?? "", 10) + 1);
    // the same printed number on more boxes of one question (the same or the next page); far apart it is a real clash, not a box
    const near = (a: CheckedItem, b: CheckedItem) => a.pages.some((p) => b.pages.some((q) => Math.abs(p - q) <= 1));
    const sameNumber = Boolean(cur && e.it.canonical && e.it.canonical === cur.head.it.canonical && near(cur.items[cur.items.length - 1].it, e.it));
    // a numbered section heading of a template ("3. Evaluation of Surfacing Options") is a field, not a new question
    const unnumbered = !e.it.canonical || e.it.itemType === "section_heading";
    if (cur && (continuesParts || sameNumber || (unnumbered && fieldLike(e.it) && !isReferenceList(e.it)))) { cur.items.push(e); continue; }
    cur = { head: e, items: [e], title: blockTitle(e.it, e.section) };
    blocks.push(cur);
    if (isReferenceList(e.it)) cur = null;
  }
  // a template: the numbered item and at least one answer field after it (a heading alone after a question is not a template)
  const isTemplate = (b: Block) => b.items.slice(1).some((x) => x.it.itemType !== "section_heading") && b.items.slice(1).every((x) => fieldLike(x.it) || x.it.canonical === b.head.it.canonical || x.it.kind === "multipart");
  // each activity takes the first unused response block after it whose title names its deliverable
  const blockOf = new Map<Activity, Block>();
  const usedBlocks = new Set<Block>();
  for (const a of activities) {
    const b = blocks.find((x) => !usedBlocks.has(x) && x.head.idx > a.evidence.idx && !isReferenceList(x.head.it) && sameDeliverable(a.evidence.it.text, x.title));
    if (b) { blockOf.set(a, b); usedBlocks.add(b); }
  }

  // the questions, in reading order: activities, the remaining blocks / questions, the reference list (a requirement)
  const uploads = new Set<string>();
  interface Placed { at: number; section: string; q: Question; activity: boolean }
  const placed: Placed[] = [];
  const blockFields = (b: Block) => b.items.flatMap((x) => fieldsFromItem(withAreas(x), pictures, used));
  for (const a of activities) {
    const b = blockOf.get(a);
    const page = a.e.it.pages[0] ?? null;
    let q: Question;
    if (b) {
      q = newQuestion("case_study");
      q.children = blockFields(b);
      q.config = { scenario: "" };
      for (const x of b.items) for (const area of withAreas(x).responseAreas ?? []) uploads.add(uploadLabel(area));
    } else {
      q = newQuestion("file_upload");
    }
    q.label = a.e.it.text.trim(); q.role = "activity"; q.title = a.title; q.deliverable = a.evidence.it.text.trim().replace(/[.:]$/, "");
    q.importMeta = { ...meta({ ...a.e.it, flags: [...a.e.it.flags, ...a.evidence.it.flags] }, null), page, itemType: "question" };
    placed.push({ at: a.e.idx, section: a.e.section, q: withSchema(q), activity: true });
  }
  for (const b of blocks) {
    if (usedBlocks.has(b)) continue;
    if (isReferenceList(b.head.it)) {
      const q = questionFromItem(withAreas(b.head), pictures, used);
      q.role = "requirement"; q.title = "Reference list";
      const help = stream.filter((x) => x.section === b.head.section && isReading(x.it) && /reference list/i.test(x.it.text));
      if (help.length) { q.helpText = help.map((x) => x.it.text.trim()).join("\n"); help.forEach((x) => taken.add(x.idx)); }
      placed.push({ at: b.head.idx, section: b.head.section, q, activity: false });
    } else if (isTemplate(b)) {
      const q = newQuestion("case_study");
      q.label = b.title; q.title = b.title; q.role = "template"; q.config = { scenario: "" };
      q.children = blockFields(b);
      q.importMeta = meta(b.head.it, b.head.it.canonical);
      placed.push({ at: b.head.idx, section: b.head.section, q: withSchema(q), activity: false });
    } else {
      for (const x of b.items) placed.push({ at: x.idx, section: x.section, q: questionFromItem(withAreas(x), pictures, used), activity: false });
    }
  }
  // what is left: drawings without a picture (flagged blocks), declarations and anything else not read as text
  for (const e of stream) if (!taken.has(e.idx) && !isReading(e.it) && !placed.some((p) => p.at === e.idx) && !blocks.some((b) => b.items.includes(e))) placed.push({ at: e.idx, section: e.section, q: questionFromItem(withAreas(e), pictures, used), activity: false });
  placed.sort((x, y) => x.at - y.at);

  // sections: activities in a row form one group (two groups = the workbook's occasions); other items keep their printed section
  const occasions = /occasion/i.test(t.sections.map((s) => s.title).join(" ") + blocks.map((b) => b.title).join(" "));
  const activityGroups = placed.reduce((n, p, i) => n + (p.activity && !(placed[i - 1]?.activity) ? 1 : 0), 0);
  let group = 0;
  // a response template printed after an occasion's activities that no activity names (2.1.10, 2.1.11) stays in that occasion
  let occasionOpen = false;
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const prev = placed[i - 1];
    if (p.activity) {
      if (!prev?.activity) { group += 1; occasionOpen = occasions && activityGroups > 1; task.sections.push({ id: newId("s"), title: occasionOpen ? `Occasion ${group}` : p.section, questions: [] }); }
    } else if (occasionOpen && p.q.role === "template") {
      // kept in the occasion's section: listed there as a response template, named, not numbered
    } else if (!prev || prev.activity || occasionOpen || !sameHeading(prev.section, p.section)) {
      occasionOpen = false;
      task.sections.push({ id: newId("s"), title: p.section, questions: [] });
    }
    task.sections[task.sections.length - 1].questions.push(p.q);
  }

  // the learner instructions: one rich-text block (paragraph headings kept), with the pages they came from
  const html: string[] = t.instructions ? [t.instructions] : [];
  let lastSection = "";
  for (const e of stream) {
    if (taken.has(e.idx) || !isReading(e.it)) continue;
    if (e.section !== lastSection && !sameHeading(e.section, t.title) && !paragraphHeading(e.it.text)) html.push(`<h3>${esc(e.section)}</h3>`);
    lastSection = e.section;
    html.push(readingHtml(e.it.text));
    e.it.pages.forEach((p) => pages.add(p));
  }
  task.instructions = html.join("");
  task.instructionPages = [...pages].sort((a, b) => a - b);
  if (materials.length) task.materials = materials.sort((a, b) => (a.pages[0] ?? 0) - (b.pages[0] ?? 0));
  if (uploads.size) task.uploadsAccepted = [...uploads];
  const time = stream.map((e) => e.it.text.match(/time allowed[^.]*?\b(\d+(?:\.\d+)?)\s*hours?\b/i)).find(Boolean);
  if (time) task.duration = `${time[1]} hrs`;
  return task;
}

/** The draft definition built from the AI's checked document (text exactly as checked; nothing reworded here). */
export function definitionFromAi(doc: CheckedDocument, pictures: WbImage[] = []): Definition {
  const used = new Set<WbImage>();
  // ASM-OVERVIEW (layout 2): text to read goes to its task's instructions (one rich-text block), steps / materials to the task,
  // activities carry their deliverable and response template, templates are one item, the reference list is a requirement
  const tasks: Task[] = doc.tasks.map((t) => taskFromAi(t, pictures, used));
  return {
    instructions: "",
    tasks,
    source: { qualification: doc.qualification, unit: doc.unit, version: doc.version, fileName: null, layout: COMPACT_LAYOUT },
  };
}

/* ------------------------------------------------------------------ the answer guide */

export function guideAnswersFromAi(doc: CheckedDocument): GuideAnswer[] {
  return doc.tasks.flatMap((t) => t.sections.flatMap((s) => s.items))
    .filter((i) => i.kind !== "instruction" && i.kind !== "drawing" && i.kind !== "declaration")
    .map((i) => ({ number: i.number, questionText: i.text || null, answer: i.answer, lookFor: i.lookFor, parts: i.parts.map((p) => ({ label: p.part || p.label, answer: p.answer, text: p.text })) }));
}

/** The standard reader's fallback for an answer guide: an assessor version's keys, by the printed numbering. */
export function guideAnswersFromParser(r: ImportResult): GuideAnswer[] {
  const numbers = workbookNumbering(r.definition);
  const keyOf = new Map(r.keys.map((k) => [k.questionId, k]));
  const out: GuideAnswer[] = [];
  for (const f of flattenQuestions(r.definition)) {
    const k = keyOf.get(f.question.id);
    if (!k || (!k.modelAnswer && !k.assessorGuidance)) continue;
    const top = f.parent ? numbers.get(f.parent.id)?.number : numbers.get(f.question.id)?.number;
    const part = f.parent ? String.fromCharCode(97 + Math.max(0, (f.parent.children ?? []).indexOf(f.question))) : "";
    out.push({ number: top ? `${top}${part}` : null, questionText: f.question.label || null, answer: k.modelAnswer ?? null, lookFor: k.assessorGuidance ?? null, parts: [] });
  }
  return out;
}

/** The questions of a draft as the matcher needs them: the printed number (AI) or the workbook numbering (standard reader). */
export function matchQuestions(def: Definition): MatchQuestion[] {
  const numbers = workbookNumbering(def);
  const out: MatchQuestion[] = [];
  for (const t of def.tasks) for (const s of t.sections) for (const q of s.questions) {
    if (!isAnswerable(q) || q.type === "declaration" || q.type === "adjustment_record") continue;
    const number = q.importMeta?.number ?? numbers.get(q.id)?.number ?? null;
    out.push({
      id: q.id, number, text: q.label,
      parts: (q.children ?? []).filter(isAnswerable).map((c, i) => ({ id: c.id, label: (c.importMeta?.number ? normalizeNumber(c.importMeta.number)?.part : null) ?? String.fromCharCode(97 + i), text: c.label })),
    });
  }
  return out;
}

export interface GuideApplied {
  keys: QuestionKey[];
  outcome: MatchOutcome;
  check: DocumentCheck;
  /** question id -> why the admin should look at its answer */
  review: Map<string, string>;
}

/** Applies a guide to a draft: refused (no keys) when the units differ. */
export function applyGuide(def: Definition, guide: { unitCode: string | null; version: string | null; answers: GuideAnswer[] }): GuideApplied {
  const check = checkDocuments({ unitCode: def.source?.unit?.code ?? null, version: def.source?.version ?? null }, guide);
  const questions = matchQuestions(def);
  if (check.block) return { keys: [], outcome: { keys: [], matched: 0, total: questions.length, missing: questions.map((q) => q.id), unused: guide.answers }, check, review: new Map() };
  const outcome = matchGuide(questions, guide.answers);
  const review = new Map<string, string>();
  for (const k of outcome.keys) if (k.review) review.set(k.questionId, k.review);
  return { keys: outcome.keys.map((k) => ({ questionId: k.questionId, modelAnswer: k.modelAnswer, assessorGuidance: k.assessorGuidance })), outcome, check, review };
}

/** Which reader's result to use: the AI's when it finished, else the standard reader (and why). */
export function chooseImportPath(ai: { status: ImportStatus | null; timedOut: boolean; skipped?: boolean } | null): { path: "ai" | "parser"; reason: string | null } {
  if (ai?.skipped) return { path: "parser", reason: "Read without AI (as you asked)." };
  if (!ai || !ai.status) return { path: "parser", reason: "The AI reader could not start." };
  if (ai.status.state === "done" && ai.status.result) return { path: "ai", reason: null };
  if (ai.timedOut) return { path: "parser", reason: "The AI reader took too long." };
  if (ai.status.state === "failed") return { path: "parser", reason: ai.status.error || "The AI reader failed." };
  return { path: "parser", reason: "The AI reader did not finish." };
}

/** Questions whose imported text or answer the admin changed (the version is bumped on publish). */
export function editedCount(def: Definition, keys: (QuestionKey & { originalModelAnswer?: string | null })[]): number {
  const q = flattenQuestions(def).filter((f) => f.question.importMeta?.editedAt).length;
  const k = keys.filter((x) => x.originalModelAnswer !== undefined && (x.originalModelAnswer ?? "") !== (x.modelAnswer ?? "")).length;
  return q + k;
}

/** Parser-only content the AI path keeps: the general instructions and compliance pages, and the items only the standard reader knows. */
const PARSER_ONLY = new Set(["adjustment_record", "observation_checklist", "declaration"]);

/**
 * The AI reads the tasks; the standard reader also reads the pages around them (plagiarism / appeals instructions, the reasonable
 * adjustment record, the student declaration, assessor observation checklists). Those are taken from the standard reader's draft:
 * each goes into the AI task whose pages hold it (else the last task), flagged so the admin checks where it landed.
 */
export function mergeParserExtras(ai: Definition, parser: Definition, taskPages: { firstPage: number; lastPage: number }[]): Definition {
  const out: Definition = structuredClone(ai);
  if (!out.instructions && parser.instructions) out.instructions = parser.instructions;
  const have = new Set(flattenQuestions(out).map((f) => f.question.type));
  for (const f of flattenQuestions(parser)) {
    const q = f.question;
    if (f.parent || !PARSER_ONLY.has(q.type)) continue;
    if (q.type !== "observation_checklist" && have.has(q.type)) continue; // one declaration / one adjustment record
    const page = q.importMeta?.page ?? null;
    // the task whose pages hold it, else the task it follows (a declaration or record printed after a task's pages belongs to it)
    let ti = page == null ? -1 : taskPages.findIndex((t) => page >= t.firstPage && page <= t.lastPage);
    if (ti < 0 && page != null) ti = taskPages.reduce((found, t, i) => (t.firstPage <= page ? i : found), page < (taskPages[0]?.firstPage ?? 0) ? 0 : -1);
    const task = out.tasks[ti >= 0 ? ti : out.tasks.length - 1];
    if (!task) continue;
    if (!task.sections.length) task.sections.push({ id: newId("s"), title: task.title, questions: [] });
    const flags = ti >= 0 ? [] : ["Added from the standard reader without a page: check which task it belongs to"];
    const copy: Question = { ...structuredClone(q), importMeta: { ...(q.importMeta ?? { confidence: "high" }), via: "parser", ...(flags.length ? { flags, confidence: "low" as const, note: flags[0] } : {}) } };
    task.sections[task.sections.length - 1].questions.push(copy);
  }
  return out;
}
