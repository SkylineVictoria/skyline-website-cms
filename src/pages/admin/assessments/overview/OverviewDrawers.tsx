/**
 * ASM-OVERVIEW A2: the side drawer of one Overview block (learner instructions, general steps, a supporting material / role-play
 * brief, a question with its parts / table rows, a template's fields and sections). Save / Cancel; Escape closes (the shared
 * Drawer). Each save is audited (asm_overview_save: who, when, the block, its text before / after). Structure (questions, tasks)
 * is changed in the Builder.
 */
import { useMemo, useRef, useState, useEffect } from "react";
import { Drawer } from "@/pages/admin/components/rto/shared";
import RichBlockEditor from "@/components/assessment/RichBlockEditor";
import { asHtml, plainText } from "@/lib/assessment/checkList";
import { findQuestion, updateQuestion } from "@/lib/assessment/definition";
import { auditExcerpt } from "@/lib/assessment/overview";
import { attachmentCapable, isAnswerable, newId, newQuestion, withSchema } from "@/lib/assessment/registry";
import type { Definition, Question, QuestionKey, Task } from "@/lib/assessment/types";

export type BlockTarget =
  | { kind: "instructions"; taskId: string }
  | { kind: "steps"; taskId: string }
  | { kind: "material"; taskId: string; materialId: string }
  | { kind: "question"; taskId: string; questionId: string }
  | { kind: "template"; taskId: string; questionId: string };
/** The audit entry of one save (asm_overview_save p_payload.block). */
export interface BlockAudit { kind: "instructions" | "steps" | "material" | "roleplay" | "question" | "parts" | "template"; id: string; label: string; before: string; after: string }
/** Saves the whole definition and keys with the block's audit entry; resolves with an error message, or null when saved. */
export type BlockSave = (definition: Definition, keys: QuestionKey[], block: BlockAudit) => Promise<string | null>;

const FIELD = "w-full rounded-lg border border-background-300 bg-white px-3 py-2 text-sm text-foreground-900 focus:border-primary-400 focus:outline-none";
const BTN = "inline-flex min-h-[40px] cursor-pointer items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const ICON = "flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-600 hover:bg-background-100 hover:text-foreground-900 disabled:cursor-not-allowed disabled:opacity-30";

interface ListItem { id: string; text: string; kind?: "field" | "section" }
/** Add, remove, reorder and rename the items of a list (parts, table rows, steps, a template's fields and sections). */
function ListEditor({ label, items, onChange, addLabels }: { label: string; items: ListItem[]; onChange: (items: ListItem[]) => void; addLabels: { kind?: "field" | "section"; label: string }[] }) {
  const move = (i: number, d: number) => { const n = [...items]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n); };
  return (
    <fieldset className="space-y-1.5" data-testid="list-editor">
      <legend className="mb-1 text-sm font-semibold text-foreground-800">{label}</legend>
      {items.map((it, i) => (
        <div key={it.id} className="flex items-center gap-1">
          {it.kind ? <span className={`w-14 shrink-0 text-2xs font-semibold uppercase ${it.kind === "section" ? "text-primary-700" : "text-foreground-500"}`}>{it.kind}</span> : <span className="w-6 shrink-0 text-xs text-foreground-500">{i + 1}</span>}
          <input className={FIELD} value={it.text} aria-label={`${it.kind ?? "Item"} ${i + 1}`} onChange={(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, text: e.target.value } : x)))} />
          <button type="button" className={ICON} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${it.text || `item ${i + 1}`} up`}><i className="ri-arrow-up-line" aria-hidden="true" /></button>
          <button type="button" className={ICON} disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${it.text || `item ${i + 1}`} down`}><i className="ri-arrow-down-line" aria-hidden="true" /></button>
          <button type="button" className={ICON} onClick={() => onChange(items.filter((x) => x.id !== it.id))} aria-label={`Remove ${it.text || `item ${i + 1}`}`}><i className="ri-delete-bin-6-line" aria-hidden="true" /></button>
        </div>
      ))}
      <div className="flex flex-wrap gap-3 pt-1">{addLabels.map((a) => <button key={a.label} type="button" className="min-h-[36px] cursor-pointer text-sm font-semibold text-primary-700 hover:underline" onClick={() => onChange([...items, { id: newId("n"), text: "", ...(a.kind ? { kind: a.kind } : {}) }])}>+ {a.label}</button>)}</div>
    </fieldset>
  );
}

function Toggle({ label, checked, onChange, testid }: { label: string; checked: boolean; onChange: (v: boolean) => void; testid?: string }) {
  return <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-2 text-sm text-foreground-800"><input type="checkbox" className="h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />{label}</label>;
}

const taskOf = (def: Definition, id: string) => def.tasks.find((t) => t.id === id);
const patchTask = (def: Definition, id: string, patch: (t: Task) => Task): Definition => ({ ...def, tasks: def.tasks.map((t) => (t.id === id ? patch(t) : t)) });
/** Instruction blocks of an older import shown among the questions (text to read, not a heading or a picture): folded into the block. */
const legacyReading = (t: Task) => t.sections.flatMap((s) => s.questions).filter((q) => (q.type === "instruction" || q.type === "content") && q.importMeta?.itemType !== "section_heading" && !/<img\b/i.test(String(q.config?.html ?? "")) && plainText(String(q.config?.html ?? "")));

/** Parts / table rows of a question as a list (table_grid rows, or a question's parts). */
function partsOf(q: Question): ListItem[] | null {
  if (q.type === "table_grid") return ((q.config?.rows as { id: string; label: string }[] | undefined) ?? []).map((r) => ({ id: r.id, text: r.label }));
  if (q.type === "case_study" && !q.role) return (q.children ?? []).filter(isAnswerable).map((c) => ({ id: c.id, text: c.label }));
  return null;
}
function withParts(q: Question, items: ListItem[]): Question {
  if (q.type === "table_grid") return withSchema({ ...q, config: { ...(q.config ?? {}), rows: items.map((it) => ({ id: it.id, label: it.text })) } });
  const old = new Map((q.children ?? []).map((c) => [c.id, c]));
  const kept = (q.children ?? []).filter((c) => !isAnswerable(c));
  return withSchema({ ...q, children: [...kept, ...items.map((it) => { const c = old.get(it.id); if (c) return { ...c, label: it.text }; const n = newQuestion("short_answer"); n.label = it.text; return withSchema({ ...n, id: it.id.startsWith("n_") ? newId("q") : it.id }); })] });
}
function templateItems(q: Question): ListItem[] {
  return (q.children ?? []).map((c) => (c.type === "instruction" || c.type === "content"
    ? { id: c.id, text: plainText(String(c.config?.html ?? "")), kind: "section" as const }
    : { id: c.id, text: c.label, kind: "field" as const }));
}
function withTemplateItems(q: Question, items: ListItem[]): Question {
  const old = new Map((q.children ?? []).map((c) => [c.id, c]));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const children = items.map((it) => {
    const c = old.get(it.id);
    if (it.kind === "section") {
      const base = c && (c.type === "instruction" || c.type === "content") ? c : { ...newQuestion("instruction"), id: newId("q") };
      return withSchema({ ...base, config: { ...(base.config ?? {}), html: `<h4>${esc(it.text)}</h4>` } });
    }
    if (c && c.type !== "instruction" && c.type !== "content") return { ...c, label: it.text };
    const n = newQuestion("short_answer"); n.label = it.text;
    return withSchema({ ...n, id: newId("q") });
  });
  return withSchema({ ...q, children });
}
const areaToggle = (q: Question, kind: "upload" | "calc", on: boolean): Question => {
  const areas = (q.importMeta?.responseAreas ?? []).filter((a) => a.kind !== kind);
  const next = on ? [...areas, { kind, text: kind === "upload" ? "Upload supporting evidence" : "Calculation box", page: null }] : areas;
  const config = kind === "upload" && attachmentCapable(q.type) ? { ...(q.config ?? {}), allowAttachment: on } : q.config;
  return withSchema({ ...q, config, importMeta: { ...(q.importMeta ?? { confidence: "high" }), responseAreas: next } });
};
const questionText = (q: Question, answer: string) => [q.label, ...(partsOf(q) ?? []).map((p, i) => `${String.fromCharCode(97 + i)}. ${p.text}`), answer ? `What the trainer should look for: ${answer}` : "", q.required === false ? "(optional)" : ""].filter(Boolean).join("\n");

export default function BlockDrawer({ target, definition, keys, numbers, onClose, onSave }: {
  target: BlockTarget; definition: Definition; keys: QuestionKey[]; numbers: Map<string, { number: string }>; onClose: () => void; onSave: BlockSave;
}) {
  const task = taskOf(definition, target.taskId);
  const q = "questionId" in target ? findQuestion(definition, target.questionId) ?? null : null;
  const material = target.kind === "material" ? task?.materials?.find((m) => m.id === target.materialId) ?? null : null;
  const key = q ? keys.find((k) => k.questionId === q.id) : undefined;
  const legacy = useMemo(() => (task && target.kind === "instructions" ? legacyReading(task) : []), [task, target.kind]);
  // the form state
  const [html, setHtml] = useState(() => (target.kind === "instructions" ? asHtml(task?.instructions ?? "") + legacy.map((x) => String(x.config?.html ?? "")).join("") : material?.html ?? ""));
  const [title, setTitle] = useState(() => material?.title ?? q?.title ?? q?.label ?? "");
  const [label, setLabel] = useState(q?.label ?? "");
  const [answer, setAnswer] = useState(key?.modelAnswer ?? "");
  const [parts, setParts] = useState<ListItem[] | null>(() => (q ? partsOf(q) : null));
  const [items, setItems] = useState<ListItem[]>(() => (q && target.kind === "template" ? templateItems(q) : target.kind === "steps" ? (task?.steps ?? []).map((s, i) => ({ id: `s${i}`, text: s.text.replace(/^\d+\.\s*/, "") })) : []));
  const [deliverable, setDeliverable] = useState(q?.deliverable ?? "");
  const [upload, setUpload] = useState(() => Boolean(q && (q.type === "file_upload" || q.config?.allowAttachment === true || (q.importMeta?.responseAreas ?? []).some((a) => a.kind === "upload"))));
  const [calc, setCalc] = useState(() => Boolean(q?.importMeta?.responseAreas?.some((a) => a.kind === "calc")));
  const [optional, setOptional] = useState(q?.required === false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => { first.current?.focus(); }, []);

  if (!task || (("questionId" in target) && !q) || (target.kind === "material" && !material)) return null;
  const number = q ? numbers.get(q.id)?.number ?? null : null;
  const heading = target.kind === "instructions" ? `Learner instructions · Task ${definition.tasks.indexOf(task) + 1}`
    : target.kind === "steps" ? "General task steps"
    : target.kind === "material" ? (material?.kind === "role_play" ? "Role-play brief" : "Supporting material")
    : target.kind === "template" ? `${q?.role === "activity" ? "Activity" : "Template"}${number ? ` ${number}` : ""}`
    : `Question${number ? ` ${number}` : ""}`;

  const save = async () => {
    setBusy(true); setError("");
    let def = definition; let nextKeys = keys; let block: BlockAudit;
    if (target.kind === "instructions") {
      const before = plainText(task.instructions ?? "") + (legacy.length ? `\n${legacy.map((x) => plainText(String(x.config?.html ?? ""))).join("\n")}` : "");
      const fold = new Set(legacy.map((x) => x.id));
      const pages = [...new Set([...(task.instructionPages ?? []), ...legacy.map((x) => x.importMeta?.page).filter((p): p is number => typeof p === "number")])].sort((a, b) => a - b);
      def = patchTask(def, task.id, (t) => ({ ...t, instructions: html, instructionPages: pages, sections: t.sections.map((s) => ({ ...s, questions: s.questions.filter((x) => !fold.has(x.id)) })) }));
      block = { kind: "instructions", id: task.id, label: `Task ${definition.tasks.indexOf(task) + 1} learner instructions`, before, after: plainText(html) };
    } else if (target.kind === "steps") {
      const pages = task.steps ?? [];
      const steps = items.filter((x) => x.text.trim()).map((x, i) => ({ text: x.text.trim(), page: pages[i]?.page ?? null }));
      def = patchTask(def, task.id, (t) => ({ ...t, steps }));
      block = { kind: "steps", id: task.id, label: `Task ${definition.tasks.indexOf(task) + 1} general task steps`, before: (task.steps ?? []).map((s) => s.text).join("\n"), after: steps.map((s) => s.text).join("\n") };
    } else if (target.kind === "material" && material) {
      def = patchTask(def, task.id, (t) => ({ ...t, materials: (t.materials ?? []).map((m) => (m.id === material.id ? { ...m, title: title.trim() || m.title, html } : m)) }));
      block = { kind: material.kind === "role_play" ? "roleplay" : "material", id: material.id, label: material.title, before: `${material.title}\n${plainText(material.html)}`, after: `${title}\n${plainText(html)}` };
    } else if (target.kind === "template" && q) {
      const next = withTemplateItems({ ...q, title: title.trim() || q.title, ...(q.role === "template" ? { label: title.trim() || q.label } : {}), ...(q.role === "activity" ? { deliverable: deliverable.trim() || q.deliverable } : {}) }, items.filter((x) => x.text.trim()));
      def = updateQuestion(def, q.id, () => next);
      const text = (x: Question) => [x.title ?? x.label, x.deliverable ? `Deliverable: ${x.deliverable}` : "", ...templateItems(x).map((i) => `${i.kind === "section" ? "## " : "- "}${i.text}`)].filter(Boolean).join("\n");
      block = { kind: "template", id: q.id, label: `${number ?? ""} ${q.title ?? q.label}`.trim(), before: text(q), after: text(next) };
    } else if (q) {
      if (!label.trim()) { setBusy(false); setError("The question needs its text."); return; }
      let next: Question = { ...q, label: label.trim(), required: optional ? false : true };
      if (label.trim() !== q.label && q.importMeta) next.importMeta = { ...q.importMeta, original: q.importMeta.original ?? q.label };
      if (parts) next = withParts(next, parts.filter((p) => p.text.trim()));
      if (q.type !== "file_upload") { next = areaToggle(next, "upload", upload); next = areaToggle(next, "calc", calc); }
      def = updateQuestion(def, q.id, () => withSchema(next));
      const hadKey = keys.some((k) => k.questionId === q.id);
      nextKeys = hadKey ? keys.map((k) => (k.questionId === q.id ? { ...k, modelAnswer: answer.trim() || null } : k)) : answer.trim() ? [...keys, { questionId: q.id, modelAnswer: answer.trim() }] : keys;
      block = { kind: parts && JSON.stringify(parts.map((p) => p.text)) !== JSON.stringify((partsOf(q) ?? []).map((p) => p.text)) && label.trim() === q.label ? "parts" : "question", id: q.id, label: `${number ?? ""} ${q.label}`.trim().slice(0, 200), before: questionText(q, key?.modelAnswer ?? ""), after: questionText(next, answer.trim()) };
    } else { setBusy(false); return; }
    // the audit keeps up to 4000 characters a side: a long block records the part that changed (with context), not its first 4000
    const err = await onSave(def, nextKeys, { ...block, ...auditExcerpt(block.before, block.after) });
    setBusy(false);
    if (err) { setError(err); return; }
    onClose();
  };

  const footer = (
    <>
      {error ? <p role="alert" className="mr-auto self-center text-sm text-red-700" data-testid="drawer-error">{error}</p> : null}
      <button type="button" className={`${BTN} border border-background-300 bg-white text-foreground-800 hover:border-primary-300`} onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className={`${BTN} bg-primary-600 text-white hover:bg-primary-700`} onClick={() => void save()} disabled={busy} data-testid="drawer-save">{busy ? "Saving…" : "Save"}</button>
    </>
  );
  return (
    <Drawer open title={heading} onClose={busy ? () => undefined : onClose} footer={footer} width="max-w-xl" zIndex="z-[60]">
      <div data-testid="block-drawer" className="space-y-4">
        {target.kind === "instructions" ? (
          <>
            <RichBlockEditor value={html} onChange={setHtml} label="Learner instructions" autoFocus placeholder="What the learner needs to know: method, timing, conditions, what to submit…" />
            {legacy.length ? <p className="text-xs text-foreground-600" data-testid="fold-note">The {legacy.length} text block{legacy.length === 1 ? "" : "s"} listed among this task's questions {legacy.length === 1 ? "is" : "are"} included above and move{legacy.length === 1 ? "s" : ""} here when you save (their pages are kept).</p> : null}
            {task.instructionPages?.length ? <p className="text-xs text-foreground-500">From workbook pages {task.instructionPages.join(", ")}.</p> : null}
          </>
        ) : null}
        {target.kind === "steps" ? <ListEditor label="Steps, in order" items={items} onChange={setItems} addLabels={[{ label: "Add step" }]} /> : null}
        {target.kind === "material" && material ? (
          <>
            <label className="block text-sm font-semibold text-foreground-800">Title<input ref={(el) => { first.current = el; }} className={`${FIELD} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <RichBlockEditor value={html} onChange={setHtml} label={material.kind === "role_play" ? "Role-play brief" : "Material"} />
            {material.pages.length ? <p className="text-xs text-foreground-500">Workbook pages {material.pages.join(", ")}.</p> : null}
          </>
        ) : null}
        {target.kind === "template" && q ? (
          <>
            <label className="block text-sm font-semibold text-foreground-800">{q.role === "activity" ? "Activity title" : "Template title"}<input ref={(el) => { first.current = el; }} className={`${FIELD} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="template-title" /></label>
            {q.role === "activity" ? <label className="block text-sm font-semibold text-foreground-800">Deliverable<input className={`${FIELD} mt-1`} value={deliverable} onChange={(e) => setDeliverable(e.target.value)} /></label> : null}
            <ListEditor label="Fields and sections" items={items} onChange={setItems} addLabels={[{ kind: "field", label: "Add field" }, { kind: "section", label: "Add section" }]} />
          </>
        ) : null}
        {target.kind === "question" && q ? (
          <>
            <label className="block text-sm font-semibold text-foreground-800">Question text
              <textarea ref={(el) => { first.current = el; }} className={`${FIELD} mt-1`} rows={4} value={label} onChange={(e) => setLabel(e.target.value)} data-testid="question-text" />
            </label>
            <label className="block text-sm font-semibold text-foreground-800">What the trainer should look for <span className="font-normal text-foreground-500">(model answer, assessors only)</span>
              <textarea className={`${FIELD} mt-1`} rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} data-testid="model-answer" />
            </label>
            {parts ? <ListEditor label={q.type === "table_grid" ? "Table rows" : "Parts"} items={parts} onChange={setParts} addLabels={[{ label: q.type === "table_grid" ? "Add row" : "Add part" }]} /> : null}
            <fieldset className="space-y-1">
              <legend className="mb-1 text-sm font-semibold text-foreground-800">Response</legend>
              <div className="flex flex-wrap gap-x-5">
                {q.type !== "file_upload" ? <Toggle label="Upload" checked={upload} onChange={setUpload} testid="chip-upload" /> : <span className="text-sm text-foreground-600">File upload</span>}
                {q.type !== "file_upload" ? <Toggle label="Calculation box" checked={calc} onChange={setCalc} testid="chip-calc" /> : null}
                <Toggle label="Optional" checked={optional} onChange={setOptional} testid="chip-optional" />
              </div>
              <p className="text-xs text-foreground-500">{q.type === "table_grid" ? "Answered in a table." : "To answer in a table instead, change the answer type in Edit."}</p>
            </fieldset>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
