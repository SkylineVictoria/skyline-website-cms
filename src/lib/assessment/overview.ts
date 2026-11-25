/**
 * ASM-OVERVIEW (owner, 2026-11-25; design "Assessment details page – compact redesign"): what the read-only Overview of an
 * assessment shows, worked out from the definition (pure, so the rules are tested without the screen).
 *
 *  Summary strip   Tasks · Questions · Activities · Uploads · Check (from the item roles, never from page text).
 *  Task card       "Task N" · title · "<n> questions · <time>" / "<n> activities · <time>"; collapsed: what is attached.
 *  Inside a task   Learner instructions (one block, "7 sections · method, how, when…"), General task steps, Supporting material
 *                  (case study / drawings / role-play brief, with pages), the Questions / Activities rows (number · first sentence ·
 *                  chips), "Also required" (reference list, student declaration), "Uploads accepted".
 *  Older imports   (no source.layout 2) keep the plain list of the task's items and a hint to re-import.
 * Only learner-facing numbers are shown; no page numbers, no "required" badge.
 */
import { isAnswerable } from "./registry";
import { checkRows, plainText, isOptional } from "./checkList";
import { OCCASION_TITLE } from "./workbookLayout";
import type { Definition, Material, Question, Task } from "./types";

export type ChipKind = "upload" | "calc" | "table" | "parts" | "template" | "roleplay" | "deliverable" | "optional" | "assessor" | "conditional";
export interface Chip { kind: ChipKind; label: string }
/** What an expandable row opens to: a grid of parts / table rows (a, b, c…), or a template's fields and sections. */
export type RowDetail =
  | { kind: "grid"; items: { marker: string; text: string }[] }
  | { kind: "template"; title: string; items: { kind: "field" | "section"; text: string; id: string }[] };
export interface OverviewRow {
  kind: "item";
  id: string;
  number: string | null;
  /** The first sentence (the whole text is in `full`). */
  text: string;
  full: string;
  chips: Chip[];
  detail: RowDetail | null;
  question: Question;
  /** Text to read among the items (an older import's instruction block, a section label). */
  reading: boolean;
  heading: boolean;
  /** The occasion group the row belongs to (hidden while that group is collapsed). */
  group: string | null;
}
/** One occasion of a workbook's project: "Activities · Occasion 2", collapsed after the first, with how it differs from the first. */
export interface OverviewGroup { id: string; occasion: number; note: string | null; differences: string[]; collapsed: boolean }
/** A section label; `group` = an occasion heading (a toggle); `sub` = a label inside a group ("Response templates"). */
export interface OverviewLabel { kind: "label"; id: string; text: string; group?: OverviewGroup; sub?: boolean; groupId?: string | null }
export interface OverviewTask {
  id: string;
  index: number;
  title: string;
  /** "5 questions · 3 hrs", "19 activities · 2 templates · 4 hrs". */
  count: string;
  /** Muted line under a collapsed card: what is attached. */
  attached: string;
  instructions: { html: string; summary: string; sections: number } | null;
  steps: Task["steps"];
  materials: Material[];
  /** "Questions" or "Activities". */
  itemsLabel: string;
  rows: (OverviewRow | OverviewLabel)[];
  alsoRequired: { id: string; text: string }[];
  uploadsAccepted: string[];
  task: Task;
}
export interface OverviewModel {
  /** Built with the Overview layout (activities, templates, materials…); false = an older import, shown as a plain list. */
  compact: boolean;
  /** An AI import from before the Overview layout: the page says "Re-import to get the compact view". */
  reimportHint: boolean;
  counts: { tasks: number; questions: number; activities: number; uploads: number };
  tasks: OverviewTask[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first sentence of a text (questions often run on: the row shows the sentence, the full text opens with the row). */
export function firstSentence(text: string, max = 140): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{12,}?[.?!])(\s|$)/);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A task title without the workbook's own "Assessment Task - 2 -" / "Task 2:" prefixes (the card shows "Task 2" as a pill). */
export function displayTaskTitle(title: string): string {
  let t = title.trim(); let prev = "";
  while (t !== prev) { prev = t; t = t.replace(/^(task\s+(?=assessment)|(assessment\s+)?task\s*[-–]?\s*\d+(\.\d+)*\s*[-–:]?\s*)/i, "").trim(); }
  return t || title;
}

/** A role-less answerable item counts as a question; templates count as questions too (numbered response items). */
const isQuestionItem = (q: Question) => isAnswerable(q) && !q.role && !["declaration", "adjustment_record", "observation_checklist"].includes(q.type) || q.role === "template";
const isRequirement = (q: Question) => q.role === "requirement" || q.type === "declaration";

/** The chips of a row: what the learner hands in and how (upload, calc, table · n rows, n parts, template · n fields…). */
export function overviewChips(q: Question): Chip[] {
  const out: Chip[] = [];
  const areas = q.importMeta?.responseAreas ?? [];
  const fields = (q.children ?? []).filter(isAnswerable);
  if (q.role === "activity" && q.deliverable) out.push({ kind: "deliverable", label: q.deliverable });
  if ((q.role === "activity" || q.role === "template") && fields.length > 1) out.push({ kind: "template", label: `template · ${plural(fields.length, "field")}` });
  else if (q.role === "activity" && fields.length === 1 && fields[0].type === "table_grid") out.push({ kind: "table", label: "table" });
  if (q.type === "table_grid") { const rows = (q.config?.rows as unknown[] | undefined)?.length ?? 0; out.push({ kind: "table", label: rows ? `table · ${plural(rows, "row")}` : "table" }); }
  if (q.type === "file_upload" || q.config?.allowAttachment === true || areas.some((a) => a.kind === "upload")) if (!(q.role === "activity" && fields.length)) out.push({ kind: "upload", label: "upload" });
  if (areas.some((a) => a.kind === "calc")) out.push({ kind: "calc", label: "calc" });
  if (!q.role && q.type === "case_study" && fields.length) out.push({ kind: "parts", label: plural(fields.length, "part") });
  if (/role-?\s?play/i.test(`${q.label} ${q.title ?? ""}`)) out.push({ kind: "roleplay", label: "role-play" });
  if (q.assessorOnly) out.push({ kind: "assessor", label: "assessor" });
  if (q.showIf) out.push({ kind: "conditional", label: "conditional" });
  if (isOptional(q)) out.push({ kind: "optional", label: "optional" });
  return out;
}

const marker = (q: Question, i: number) => {
  const n = q.importMeta?.number ? String(q.importMeta.number) : "";
  const tail = n.match(/[a-z]$/)?.[0];
  return tail ?? String.fromCharCode(97 + (i % 26));
};
/** A row label of a category table ("k. Selection approval") without its letter: the grid prints the letter itself. */
const stripMarker = (s: string) => s.replace(/^\s*[a-z][.)]\s+/i, "").trim();

/** What a row opens to: table rows / parts as a grid, a template's fields and sections. */
export function rowDetail(q: Question): RowDetail | null {
  if (q.role === "activity" || q.role === "template") {
    const kids = q.children ?? [];
    if (!kids.length) return null;
    if (q.role === "activity" && kids.length === 1 && kids[0].type === "table_grid") return tableGrid(kids[0]);
    return {
      kind: "template", title: q.title || q.deliverable || q.label,
      items: kids.map((c) => (c.type === "instruction" || c.type === "content"
        ? { kind: "section" as const, text: plainText(String(c.config?.html ?? "")) || "Section", id: c.id }
        : { kind: "field" as const, text: c.label.replace(/:\s*$/, "") || "Field", id: c.id })),
    };
  }
  if (q.type === "table_grid") return tableGrid(q);
  const kids = (q.children ?? []).filter(isAnswerable);
  if (kids.length) return { kind: "grid", items: kids.map((c, i) => ({ marker: marker(c, i), text: stripMarker(c.label) || "Part" })) };
  return null;
}
function tableGrid(q: Question): RowDetail | null {
  const rows = (q.config?.rows as { label: string }[] | undefined) ?? [];
  if (!rows.length) return null;
  return { kind: "grid", items: rows.map((r, i) => { const m = r.label.match(/^\s*([a-z])[.)]\s+/i); return { marker: m ? m[1].toLowerCase() : String.fromCharCode(97 + (i % 26)), text: stripMarker(r.label) }; }) };
}

/** Upload places: items a learner attaches a file to, plus what a task accepts besides the answers. */
const hasUpload = (q: Question) => overviewChips(q).some((c) => c.kind === "upload");

/** A one-line summary of the learner instructions: "7 sections · method, how, when, specifications…". */
export function instructionsSummary(html: string): { summary: string; sections: number } {
  const heads = [...html.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi)].map((m) => plainText(m[1])).filter((h) => !/^notes?$/i.test(h));
  const list = heads.length >= 2 ? heads : [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)].map((m) => plainText(m[1]));
  const STOP = new Set(["assessment", "required", "the", "a", "an", "of", "and", "your", "task", "for"]);
  const keyword = (h: string) => {
    const ask = h.match(/\((how|when|where|what|why|who)\?\)/i);
    if (ask) return ask[1].toLowerCase();
    const w = h.toLowerCase().replace(/[^a-z\s/-]+/g, " ").split(/\s+/).find((x) => x && !STOP.has(x));
    return (w ?? h.toLowerCase()).replace(/-based$/, "").replace(/\/.*$/, "");
  };
  if (!list.length) {
    const text = plainText(html);
    return { summary: text ? `${plural(1, "section")} · ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}` : "", sections: text ? 1 : 0 };
  }
  const words = [...new Set(list.map(keyword))];
  return { summary: `${plural(list.length, "section")} · ${words.slice(0, 7).join(", ")}${words.length > 7 ? "…" : ""}`, sections: list.length };
}

const MATERIAL_NAMES: Record<Material["kind"], [string, string]> = { case_study: ["case study", "case studies"], drawing: ["drawing", "drawings"], role_play: ["role-play brief", "role-play briefs"], document: ["document", "documents"] };
function attachedLine(task: Task, templates: number): string {
  const kinds = (["case_study", "drawing", "role_play", "document"] as const).map((k) => ({ k, n: (task.materials ?? []).filter((m) => m.kind === k).length })).filter((x) => x.n);
  const names = kinds.map(({ k, n }) => (n === 1 ? MATERIAL_NAMES[k][0] : `${n} ${MATERIAL_NAMES[k][1]}`));
  const parts: string[] = [];
  if (names.length) { const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]; parts.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)} attached`); }
  if (task.steps?.length) parts.push(plural(task.steps.length, "general step"));
  if (templates) parts.push(plural(templates, "template"));
  return parts.join(" · ");
}

const ORDINAL = ["First", "Second", "Third", "Fourth", "Fifth"];
const deliverableKey = (s: string) => s.toLowerCase().replace(/\boccasion \d+\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
/** The deliverables an occasion's activities ask for ("A, B" on one activity = two), in order, without repeats. */
function deliverablesOf(qs: Question[]): string[] {
  const out = new Map<string, string>();
  for (const q of qs) if (q.role === "activity" && q.deliverable) for (const d of q.deliverable.split(/,\s*/)) if (d.trim()) out.set(deliverableKey(d), d.trim());
  return [...out.values()];
}
/** How a later occasion differs from the first: its number of activities, deliverables it adds, deliverables it leaves out. */
export function occasionDifferences(first: Question[], later: Question[], firstDeliverables = deliverablesOf(first)): string[] {
  const out: string[] = [];
  const a = first.filter((q) => q.role === "activity").length;
  const b = later.filter((q) => q.role === "activity").length;
  if (a !== b) out.push(`${plural(b, "activity", "activities")} (the first occasion has ${a})`);
  const before = new Set(firstDeliverables.map(deliverableKey));
  const now = deliverablesOf(later);
  const nowKeys = new Set(now.map(deliverableKey));
  const added = now.filter((d) => !before.has(deliverableKey(d)));
  const dropped = firstDeliverables.filter((d) => !nowKeys.has(deliverableKey(d)));
  if (added.length) out.push(`Also asks for: ${added.join("; ")}`);
  if (dropped.length) out.push(`Not asked again: ${dropped.join("; ")}`);
  return out;
}

/** Is the definition built with the Overview layout? (Hand-built assessments have no import and are shown the same way.) */
export const isCompactLayout = (def: Definition) => (def.source?.layout ?? 0) >= 2;
const aiImported = (def: Definition) => def.tasks.some((t) => t.sections.some((s) => s.questions.some((q) => q.importMeta?.via === "ai")));

export function overviewOf(def: Definition, numbers: Map<string, { number: string }>): OverviewModel {
  const compact = isCompactLayout(def);
  let questions = 0; let activities = 0; let uploads = 0;
  const tasks = def.tasks.map((task, index): OverviewTask => {
    const top = task.sections.flatMap((s) => s.questions);
    const acts = top.filter((q) => q.role === "activity").length;
    const qs = top.filter(isQuestionItem).length;
    const templates = top.filter((q) => q.role === "template" || (q.role === "activity" && (q.children ?? []).filter(isAnswerable).length > 1)).length;
    questions += qs; activities += acts;
    uploads += top.filter((q) => !isRequirement(q) && hasUpload(q)).length + (task.uploadsAccepted ?? []).length;
    const rows: (OverviewRow | OverviewLabel)[] = [];
    const withItems = task.sections.filter((s) => s.questions.some((q) => !isRequirement(q)));
    const occasions = task.sections.filter((s) => OCCASION_TITLE.test(s.title) && s.questions.some((q) => q.role === "activity"));
    const firstDeliverables = occasions[0] ? deliverablesOf(occasions[0].questions) : [];
    for (const s of task.sections) {
      const items = s.questions.filter((q) => !isRequirement(q));
      if (!items.length) continue;
      const oi = occasions.indexOf(s);
      let group: OverviewGroup | null = null;
      if (oi >= 0 && occasions.length > 1) {
        const n = Number(s.title.match(/\d+/)?.[0] ?? oi + 1);
        group = { id: s.id, occasion: n, note: oi ? `${ORDINAL[oi] ?? "Another"} observation of the same project` : null, differences: oi ? occasionDifferences(occasions[0].questions, s.questions, firstDeliverables) : [], collapsed: oi > 0 };
        rows.push({ kind: "label", id: `label-${s.id}`, text: `Activities · ${s.title}`, group });
      } else if (withItems.length > 1) rows.push({ kind: "label", id: `label-${s.id}`, text: s.title });
      const gid = group?.id ?? null;
      let templatesLabel = false;
      for (const q of items) {
        const reading = q.type === "instruction" || q.type === "content";
        const heading = reading && q.importMeta?.itemType === "section_heading";
        // a response template no activity of the occasion names: listed under "Response templates", without a number
        const loose = Boolean(group) && q.role === "template";
        if (loose && !templatesLabel) { templatesLabel = true; rows.push({ kind: "label", id: `label-tpl-${s.id}`, text: "Response templates", sub: true, groupId: gid }); }
        const full = reading ? plainText(String(q.config?.html ?? "")) : (q.role === "activity" || q.role === "template") && q.title ? q.title : q.label;
        rows.push({
          kind: "item", id: q.id, number: reading || loose ? null : (numbers.get(q.id)?.number ?? null), text: firstSentence(full || (reading ? "Text to read" : "Untitled")), full: q.label || full,
          chips: reading ? [] : overviewChips(q), detail: reading ? null : rowDetail(q), question: q, reading, heading, group: gid,
        });
      }
    }
    const html = task.instructions ?? "";
    const plain = plainText(html);
    const ins = plain ? { html, ...instructionsSummary(html) } : null;
    const time = task.duration ? ` · ${task.duration}` : "";
    const standalone = top.filter((q) => q.role === "template").length;
    const count = acts
      ? [plural(acts, "activity", "activities"), standalone ? plural(standalone, "template") : "", qs - standalone ? plural(qs - standalone, "question") : ""].filter(Boolean).join(" · ") + time
      : `${plural(qs, "question")}${time}`;
    return {
      id: task.id, index, title: displayTaskTitle(task.title), count, attached: attachedLine(task, templates),
      instructions: ins, steps: task.steps ?? [], materials: task.materials ?? [], itemsLabel: acts ? "Activities" : "Questions", rows,
      alsoRequired: top.filter(isRequirement).map((q) => ({ id: q.id, text: q.type === "declaration" ? "Student declaration" : (q.title || firstSentence(q.label, 40)) })),
      uploadsAccepted: task.uploadsAccepted ?? [], task,
    };
  });
  return { compact, reimportHint: !compact && aiImported(def), counts: { tasks: def.tasks.length, questions, activities, uploads }, tasks };
}

/**
 * The before / after an audit row keeps (asm_overview_save stores at most `max` characters a side). Short texts are kept whole; a
 * long one keeps the span that changed with `context` characters around it, "…" marking what was left out, so an edit at the end of
 * a long block is never cut away.
 */
export function auditExcerpt(before: string, after: string, max = 4000, context = 300): { before: string; after: string } {
  if (before.length <= max && after.length <= max) return { before, after };
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const cut = (s: string) => {
    const from = Math.max(0, start - context);
    const to = Math.min(s.length, s.length - end + context);
    let out = `${from > 0 ? "…" : ""}${s.slice(from, to)}${to < s.length ? "…" : ""}`;
    if (out.length > max) out = `${out.slice(0, max - 1)}…`;
    return out;
  };
  return { before: cut(before), after: cut(after) };
}

/** The issues to fix before publishing: the "Needs a look" rows (a blocking one, two questions with one number, holds Publish). */
export function issuesOf(def: Definition, numbers: Map<string, { number: string }>): { total: number; blocking: number } {
  const rows = checkRows(def, numbers);
  return { total: rows.length, blocking: rows.filter((r) => r.blocking).length };
}
