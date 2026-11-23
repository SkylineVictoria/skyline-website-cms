import { Badge, Button, Field, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { typeUi } from "@/components/assessment/registry";
import { ATTACHMENT_DEFAULTS, attachmentCapable, MARKING_LABEL, newId, questionType } from "@/lib/assessment/registry";
import type { Question, QuestionKey } from "@/lib/assessment/types";
import ConditionEditor from "./ConditionEditor";

/** "Student can attach images / files under the answer" (config.allowAttachment) with its limits. */
function AttachmentEditor({ q, onChange }: { q: Question; onChange: (patch: Partial<Question>) => void }) {
  const c = q.config ?? {};
  const on = c.allowAttachment === true;
  const set = (patch: Record<string, unknown>) => onChange({ config: { ...ATTACHMENT_DEFAULTS, ...c, ...patch } });
  const accept = Array.isArray(c.attachmentAccept) ? (c.attachmentAccept as string[]) : ATTACHMENT_DEFAULTS.attachmentAccept;
  return (
    <div className="rounded-md border border-background-200 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground-500">Attachments</p>
      <Toggle label="The student can attach images or files under the answer" checked={on} onChange={(v) => set({ allowAttachment: v })} />
      {on ? (
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Field label="Most files"><TextInput type="number" min={1} value={String(c.attachmentMaxFiles ?? ATTACHMENT_DEFAULTS.attachmentMaxFiles)} onChange={(e) => set({ attachmentMaxFiles: Math.max(1, Number(e.target.value) || 1) })} /></Field>
          <Field label="Max MB each"><TextInput type="number" min={1} value={String(c.attachmentMaxMb ?? ATTACHMENT_DEFAULTS.attachmentMaxMb)} onChange={(e) => set({ attachmentMaxMb: Math.max(1, Number(e.target.value) || 1) })} /></Field>
          <Field label="Allowed types (MIME, one per line; empty = any)"><TextArea rows={3} value={accept.join("\n")} onChange={(e) => set({ attachmentAccept: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} /></Field>
        </div>
      ) : null}
    </div>
  );
}

export interface QuestionEditorProps {
  q: Question;
  onChange: (patch: Partial<Question>) => void;
  /** Questions earlier in the assessment, for conditions. */
  candidates: { id: string; label: string }[];
  keyRow: QuestionKey | undefined;
  onKeyChange: (patch: Partial<QuestionKey>) => void;
  onSaveToBank?: () => void;
}

/** One question's settings: common fields, the type's own config, marking mode with criteria / rubric, conditions, assessor-only data. */
export default function QuestionEditor({ q, onChange, candidates, keyRow, onKeyChange, onSaveToBank }: QuestionEditorProps) {
  const type = questionType(q.type);
  const ui = typeUi(q.type);
  const mode = q.markingMode ?? type?.defaultMarkingMode ?? "criteria";
  const content = type?.content;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><i className={`${type?.icon ?? "ri-question-line"} text-lg text-foreground-600`} aria-hidden="true" /><span className="font-medium text-foreground-900">{type?.label ?? q.type}</span><Badge tone="muted">{q.id}</Badge></div>
        {onSaveToBank && !content ? <Button size="sm" variant="outline" icon="ri-archive-line" onClick={onSaveToBank}>Save to question bank</Button> : null}
      </div>
      {type?.hint ? <p className="text-xs text-foreground-500">{type.hint}</p> : null}
      {q.importMeta ? (
        <div className={`flex flex-wrap items-start gap-2 rounded-md border p-3 text-sm ${q.importMeta.confidence === "low" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-background-200 bg-background-100 text-foreground-700"}`} role="note">
          <i className={`${q.importMeta.confidence === "low" ? "ri-error-warning-line" : "ri-file-search-line"} mt-0.5`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {q.importMeta.confidence === "low" ? <strong>Check this. </strong> : null}
            Imported from the workbook{q.importMeta.page ? `, page ${q.importMeta.page}` : ""}.{q.importMeta.note ? ` ${q.importMeta.note}` : ""}
          </span>
          <Button size="sm" variant="outline" icon="ri-check-line" onClick={() => onChange({ importMeta: undefined })}>Checked</Button>
        </div>
      ) : null}
      {!content ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2"><Field label="Question" required><TextArea rows={2} value={q.label} onChange={(e) => onChange({ label: e.target.value })} /></Field></div>
          <div className="md:col-span-2"><Field label="Help text for the student"><TextInput value={q.helpText ?? ""} onChange={(e) => onChange({ helpText: e.target.value })} /></Field></div>
          <Toggle label="Required" checked={Boolean(q.required)} onChange={(v) => onChange({ required: v })} />
          {!type?.assessorOnly ? <Toggle label="Completed by the assessor, not the student" checked={Boolean(q.assessorOnly)} onChange={(v) => onChange({ assessorOnly: v })} /> : null}
        </div>
      ) : null}
      <div className="rounded-md border border-background-200 p-3"><p className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground-500">Settings</p>{ui.Config({ q, onChange })}</div>
      {attachmentCapable(q.type) && !q.assessorOnly ? <AttachmentEditor q={q} onChange={onChange} /> : null}
      {!content ? (
        <div className="rounded-md border border-background-200 p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground-500">Marking</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Marking mode"><Select value={mode} onChange={(e) => onChange({ markingMode: e.target.value as Question["markingMode"] })}>{(type?.markingModes ?? ["criteria", "none"]).map((m) => <option key={m} value={m}>{MARKING_LABEL[m]}</option>)}</Select></Field>
          </div>
          {mode === "criteria" ? (
            <div className="mt-3">
              <span className="mb-1.5 block text-label font-medium text-foreground-800">Criteria (each marked S / NYS)</span>
              <ul className="space-y-1.5">{(q.criteria ?? []).map((c, i) => <li key={c.id} className="flex items-center gap-1.5"><span className="w-5 text-xs text-foreground-500">{i + 1}.</span><TextInput value={c.text} onChange={(e) => onChange({ criteria: (q.criteria ?? []).map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)) })} /><Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove criterion" onClick={() => onChange({ criteria: (q.criteria ?? []).filter((x) => x.id !== c.id) })} /></li>)}</ul>
              <Button size="sm" variant="outline" icon="ri-add-line" className="mt-2" onClick={() => onChange({ criteria: [...(q.criteria ?? []), { id: newId("c"), text: "" }] })}>Add criterion</Button>
            </div>
          ) : null}
          {mode === "rubric" ? (
            <div className="mt-3">
              <span className="mb-1.5 block text-label font-medium text-foreground-800">Rubric levels (student-facing; assessor descriptors go in the keys)</span>
              <ul className="space-y-1.5">{(q.rubric?.levels ?? []).map((l) => <li key={l.id} className="grid grid-cols-[2fr_1fr_auto] gap-1.5"><TextInput value={l.label} placeholder="Level" onChange={(e) => onChange({ rubric: { levels: (q.rubric?.levels ?? []).map((x) => (x.id === l.id ? { ...x, label: e.target.value } : x)) } })} /><TextInput type="number" value={l.score} onChange={(e) => onChange({ rubric: { levels: (q.rubric?.levels ?? []).map((x) => (x.id === l.id ? { ...x, score: Number(e.target.value) } : x)) } })} /><Button size="sm" variant="ghost" icon="ri-delete-bin-line" aria-label="Remove level" onClick={() => onChange({ rubric: { levels: (q.rubric?.levels ?? []).filter((x) => x.id !== l.id) } })} /></li>)}</ul>
              <Button size="sm" variant="outline" icon="ri-add-line" className="mt-2" onClick={() => onChange({ rubric: { levels: [...(q.rubric?.levels ?? []), { id: newId("r"), label: "", score: (q.rubric?.levels?.length ?? 0) + 1 }] } })}>Add level</Button>
            </div>
          ) : null}
          {mode === "auto" && !ui.Key ? <p className="mt-2 text-xs text-primary-700">This type has no auto-check key; the assessor marks it.</p> : null}
        </div>
      ) : null}
      {!content ? (
        <div className="rounded-md border border-accent-100 bg-accent-50 p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-accent-900">Assessor only (never shown to students)</p>
          <div className="space-y-3">
            {mode === "auto" && ui.Key ? <div><span className="mb-1 block text-xs text-foreground-600">Answer key (auto-check compares with it)</span>{ui.Key({ q, value: keyRow?.answerKey, onChange: (k) => onKeyChange({ answerKey: k }) })}</div> : null}
            <Field label="Model / benchmark answer"><TextArea rows={3} value={keyRow?.modelAnswer ?? ""} onChange={(e) => onKeyChange({ modelAnswer: e.target.value })} /></Field>
            <Field label="Assessor guidance"><TextArea rows={2} value={keyRow?.assessorGuidance ?? ""} onChange={(e) => onKeyChange({ assessorGuidance: e.target.value })} /></Field>
            {mode === "rubric" ? <Field label="Rubric descriptors for assessors (one per level)"><TextArea rows={3} value={typeof keyRow?.rubricLevels === "string" ? keyRow.rubricLevels : keyRow?.rubricLevels ? JSON.stringify(keyRow.rubricLevels) : ""} onChange={(e) => onKeyChange({ rubricLevels: e.target.value })} /></Field> : null}
          </div>
        </div>
      ) : null}
      <ConditionEditor value={q.showIf} onChange={(c) => onChange({ showIf: c })} candidates={candidates} />
    </div>
  );
}
