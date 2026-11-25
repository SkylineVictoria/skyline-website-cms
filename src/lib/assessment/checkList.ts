/**
 * ASM-BUILDER (2026-11-25): the rules shared by the Add assessment wizard's Check step and the assessment page's Builder:
 * which items "need a look", the number a question shows, and the trace kept when imported text is edited (original, who, when).
 */
import { flattenQuestions, type FlatQuestion } from "./definition";
import { isAnswerable } from "./registry";
import type { Definition, Question, QuestionKey } from "./types";

export interface CheckRow {
  id: string; number: string; label: string; reason: string; tag: "Answer missing" | "Import check" | "Answer check"; parentId: string | null;
  /** Must be resolved before publishing (two questions with the same number). */
  blocking?: boolean;
}

/** An item whose differences were resolved by a rule: listed under "Auto-resolved" with the reasons, until reopened. */
export interface AutoResolvedRow { id: string; number: string; label: string; notes: string[]; heading: boolean }

const NO_ANSWER_TYPES = new Set(["declaration", "adjustment_record", "observation_checklist", "file_upload"]);
export const plainText = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** The number a question shows: the printed one (AI import), else the workbook numbering, a part letter after its parent's. */
export function numberOf(f: FlatQuestion, numbers: Map<string, { number: string }>): string {
  const q = f.question;
  if (q.importMeta?.number) return q.importMeta.number;
  if (!f.parent) return numbers.get(q.id)?.number ?? "";
  return `${numbers.get(f.parent.id)?.number ?? ""}${String.fromCharCode(97 + Math.max(0, (f.parent.children ?? []).indexOf(q)))}`;
}

/** A question's (or an instruction block's) line text. */
export const lineText = (q: Question) => (q.type === "instruction" || q.type === "content" ? plainText(String(q.config?.html ?? "")) || "Instruction" : q.label);

/** The flags of an imported item (older imports only have a low confidence with a note). */
export const flagsOf = (q: Question): string[] => q.importMeta?.flags ?? (q.importMeta?.confidence === "low" ? [q.importMeta.note || "Check this"] : []);

/**
 * The "Needs a look" rows: imported items still flagged (not marked reviewed), and, when an answer guide was applied, questions
 * without an answer or matched by content.
 */
export function checkRows(definition: Definition, numbers: Map<string, { number: string }>, guide?: { hasAnswer: (q: Question) => boolean; review: Map<string, string> } | null): CheckRow[] {
  const out: CheckRow[] = [];
  for (const f of flattenQuestions(definition)) {
    const q = f.question;
    const num = numberOf(f, numbers);
    const flags = flagsOf(q);
    const reopened = q.importMeta?.reopenedAt ? (q.importMeta.autoResolved ?? []).map((n) => `Reopened: ${n.note}`) : [];
    const all = [...flags, ...reopened];
    if (all.length && !q.importMeta?.reviewedAt) out.push({ id: q.id, number: num, label: lineText(q), reason: all[0], tag: "Import check", parentId: f.parent?.id ?? null, ...(q.importMeta?.blocking && flags.length ? { blocking: true } : {}) });
    if (!f.parent && guide && isAnswerable(q) && !NO_ANSWER_TYPES.has(q.type)) {
      if (!guide.hasAnswer(q)) out.push({ id: `${q.id}#answer`, number: num, label: q.label, reason: "No answer found in the guide", tag: "Answer missing", parentId: null });
      else if (guide.review.has(q.id)) out.push({ id: `${q.id}#answer`, number: num, label: q.label, reason: guide.review.get(q.id) ?? "Check the answer", tag: "Answer check", parentId: null });
    }
  }
  return out;
}

export const rowQuestionId = (rowId: string) => rowId.replace(/#answer$/, "");

/** The items the import resolved by a rule (a section heading's number, an answer box label left out…), not reopened. */
export function autoResolvedRows(definition: Definition, numbers: Map<string, { number: string }>): AutoResolvedRow[] {
  return flattenQuestions(definition)
    .filter((f) => f.question.importMeta?.autoResolved?.length && !f.question.importMeta.reopenedAt)
    .map((f) => ({ id: f.question.id, number: numberOf(f, numbers), label: lineText(f.question), notes: (f.question.importMeta?.autoResolved ?? []).map((n) => n.note), heading: isSectionHeading(f.question) }));
}

/** Reopen: the classifier or the rule may have been wrong; the item goes back on "Needs a look" with the note as its reason. */
export const reopenAutoResolved = (q: Question): Question => ({ ...q, importMeta: { ...(q.importMeta ?? { confidence: "high" }), reopenedAt: new Date().toISOString(), reviewedAt: null } });

/** A section heading found by the import: shown as a section label, never as a question. */
export const isSectionHeading = (q: Question) => q.importMeta?.itemType === "section_heading";

/** The audit-log notes for asm_import_auto_resolved: one per resolved difference, reopened ones marked. */
export function autoResolvedNotes(definition: Definition): { questionId: string; rule: string; text: string; note: string; page: number | null; reopened: boolean }[] {
  return flattenQuestions(definition).flatMap((f) => (f.question.importMeta?.autoResolved ?? []).map((n) => ({
    questionId: f.question.id, rule: n.rule, text: n.text, note: n.note, page: n.page ?? null, reopened: Boolean(f.question.importMeta?.reopenedAt),
  })));
}

/** New text for an imported question, keeping the original and who / when changed it (cleared when it is put back). */
export function withLabelEdit(q: Question, text: string, who: { id: string | null; name: string | null }): Question {
  const original = q.importMeta?.original ?? q.label;
  const changed = text !== original;
  return { ...q, label: text, importMeta: { ...(q.importMeta ?? { confidence: "high" }), original, editedAt: changed ? new Date().toISOString() : null, editedBy: changed ? who.id : null, editedByName: changed ? who.name : null } };
}

/** The same for an instruction block's text. */
export function withHtmlEdit(q: Question, html: string, who: { id: string | null; name: string | null }): Question {
  const original = q.importMeta?.original ?? String(q.config?.html ?? "");
  const changed = html !== original;
  return { ...q, config: { ...(q.config ?? {}), html }, importMeta: { ...(q.importMeta ?? { confidence: "high" }), original, editedAt: changed ? new Date().toISOString() : null, editedBy: changed ? who.id : null, editedByName: changed ? who.name : null } };
}

export const markReviewed = (q: Question): Question => ({ ...q, importMeta: { ...(q.importMeta ?? { confidence: "high" }), reviewedAt: new Date().toISOString() } });

/** Edits since the draft was made from the published version: questions whose text changed, and answers changed. */
export const editCount = (def: Definition, keys: (QuestionKey & { edited?: boolean })[] = []) =>
  flattenQuestions(def).filter((f) => f.question.importMeta?.editedAt).length + keys.filter((k) => k.edited).length;

/** Rows already listed stay listed, in their place, so finishing one strikes it through instead of making it vanish. */
export function stableRows(listed: CheckRow[], computed: CheckRow[]): CheckRow[] {
  const fresh = new Map(computed.map((r) => [r.id, r]));
  const seen = new Set(listed.map((r) => r.id));
  return [...listed.map((r) => fresh.get(r.id) ?? r), ...computed.filter((r) => !seen.has(r.id))];
}

/** Text that is not HTML yet, as paragraphs (older instructions were plain text). */
export const asHtml = (text: string) => (/^\s*</.test(text) || !text.trim() ? text : `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br>")).join("</p><p>")}</p>`);

/**
 * A published version opened for editing: the "Edited" trace starts again from its wording (so "Show original" shows the published
 * text), and the printed version moves on once (1.0 -> 1.1) when the definition carries one; without one the PDF prints the version
 * number, which the new draft already has.
 */
export function publishedBase(def: Definition): Definition {
  const clean = (q: Question): Question => {
    const out: Question = { ...q };
    if (q.importMeta) out.importMeta = { ...q.importMeta, original: undefined, editedAt: null, editedBy: null, editedByName: null };
    if (q.children) out.children = q.children.map(clean);
    return out;
  };
  return { ...def, tasks: def.tasks.map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, questions: s.questions.map(clean) })) })) };
}
export const withNextVersion = (def: Definition, bump: (v: string | null | undefined) => string): Definition =>
  def.source?.version ? { ...def, source: { ...def.source, version: bump(def.source.version) } } : def;
