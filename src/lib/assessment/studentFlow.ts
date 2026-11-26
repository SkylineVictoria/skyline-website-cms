/**
 * ASM-AI-IMPORT stages 3-4: the small rules behind the student's and the trainer's screens (pure, shared with the tests).
 *  - which items of a task the student answers, and which are reference material (briefs, tables, drawings: the Reference drawer);
 *  - whether a question is answered (text, choices, tables, parts, uploaded evidence), and "4 of 6 answered" per task;
 *  - the unit outcome: every task Satisfactory -> Competent, otherwise Not Yet Competent (and nothing while a task is undecided).
 */
import { isAnswerable, isAssessorOnly } from "./registry";
import { taskStepsHtml } from "./definition";
import type { EvidenceFile, Outcome, Question, Responses, Task, UnitOutcome } from "./types";

const NOT_STUDENT = new Set(["declaration", "adjustment_record"]);

/** The questions a student answers in a task, in reading order (top level; parts are inside their question). */
export function studentQuestions(task: Task): Question[] {
  return task.sections.flatMap((s) => s.questions).filter((q) => isAnswerable(q) && !isAssessorOnly(q) && !NOT_STUDENT.has(q.type));
}

export interface ReferenceItem { id: string; title: string; html: string; page: number | null; hasPicture: boolean; hasTable: boolean }

const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Briefs, tables, drawings and the task's own instructions: shown in the Reference drawer, never inline above the questions. */
export function referenceItems(task: Task, taskNo: number): ReferenceItem[] {
  const out: ReferenceItem[] = [];
  if (task.instructions?.trim()) out.push({ id: `${task.id}:instructions`, title: `Task ${taskNo} instructions`, html: /^\s*</.test(task.instructions) ? task.instructions : `<p>${esc(task.instructions).replace(/\n+/g, "</p><p>")}</p>`, page: null, hasPicture: false, hasTable: false });
  // ASM-OVERVIEW: the task's general steps and supporting material (case study, drawings, role-play brief) are reference items too
  if (task.steps?.length) out.push({ id: `${task.id}:steps`, title: "General task steps", html: taskStepsHtml(task), page: task.steps[0].page, hasPicture: false, hasTable: false });
  for (const m of task.materials ?? []) out.push({ id: m.id, title: m.title, html: m.html, page: m.pages[0] ?? null, hasPicture: /<img\b/i.test(m.html), hasTable: /<table\b/i.test(m.html) });
  for (const q of task.sections.flatMap((s) => s.questions)) {
    if (isAnswerable(q)) continue;
    const html = String(q.config?.html ?? "");
    if (!plain(html) && !/<img\b/i.test(html)) continue;
    const text = plain(html);
    const caption = /<figcaption>(.*?)<\/figcaption>/i.exec(html)?.[1] ?? /<em>(.*?)<\/em>/i.exec(html)?.[1] ?? "";
    const title = plain(caption) || text.split(/(?<=[.:])\s/)[0]?.slice(0, 80) || (/<img\b/i.test(html) ? "Drawing" : "Information");
    out.push({ id: q.id, title, html, page: q.importMeta?.page ?? null, hasPicture: /<img\b/i.test(html), hasTable: /<table\b/i.test(html) });
  }
  return out;
}

const filled = (v: unknown): boolean => {
  if (v == null) return false;
  if (typeof v === "string") return v.replace(/<[^>]*>/g, "").trim() !== "";
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.some(filled);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).some(filled);
  return false;
};

/** Answered: a value (or, for an upload, a file); a question with parts needs every part; attachments count for evidence items. */
export function isAnswered(q: Question, responses: Responses, evidence: EvidenceFile[] = []): boolean {
  const files = evidence.filter((e) => e.questionId === q.id && !e.byAssessor).length;
  if (q.type === "file_upload") return files > 0;
  if (q.children?.length) {
    const scope = (responses[q.id] as Responses | undefined) ?? {};
    const parts = q.children.filter((c) => isAnswerable(c) && !isAssessorOnly(c));
    return parts.length > 0 && parts.every((c) => isAnswered(c, scope, evidence)) || (parts.length === 0 && filled(responses[q.id]));
  }
  return filled(responses[q.id]) || files > 0;
}

export function taskProgress(task: Task, responses: Responses, evidence: EvidenceFile[] = []): { answered: number; total: number } {
  const qs = studentQuestions(task);
  return { answered: qs.filter((q) => isAnswered(q, responses, evidence)).length, total: qs.length };
}

/** The unit outcome worked out from the task outcomes: all S -> C; any NYS -> NYC; a task not decided yet -> null. */
export function unitOutcome(tasks: { id: string }[], outcomes: Record<string, Outcome | null | undefined>): UnitOutcome | null {
  if (!tasks.length) return null;
  const list = tasks.map((t) => outcomes[t.id] ?? null);
  if (list.some((o) => o === "NYS")) return list.every((o) => o !== null) ? "NYC" : null;
  return list.every((o) => o === "S") ? "C" : null;
}

/** A task's outcome from its questions' marks: every question S -> S; any NS -> NYS; not all marked -> null. */
export function taskOutcomeFromMarks(questionIds: string[], marks: Record<string, Outcome | null | undefined>): Outcome | null {
  if (!questionIds.length) return null;
  const list = questionIds.map((id) => marks[id] ?? null);
  if (list.some((o) => o === null)) return null;
  return list.every((o) => o === "S") ? "S" : "NYS";
}
