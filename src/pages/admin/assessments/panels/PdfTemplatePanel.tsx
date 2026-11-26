import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, ConfirmDialog } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import FieldEditor, { type EditorField, type EditorOwner, type FieldKindSpec } from "@/components/signing/FieldEditor";
import { AUTO_KEYS, SUBMISSION_OPTIONS, templateProblems, type AutoKey, type FieldKind, type FieldRole, type PdfTemplate, type TemplateField } from "@/lib/assessment/pdfTemplate/model";
import { detectWorkbook, downloadWorkbook, loadTemplate, saveTemplate, unitInWorkbook, uploadWorkbook, type TemplateState } from "@/lib/assessment/pdfTemplate/api";
import { checkUnit, unitDecisionError, type UnitCheck } from "@/lib/assessment/workbookFiling";
import { asmAdmin } from "@/pages/admin/lib/assessments";
import { supabase } from "@/pages/admin/lib/supabase";

/** ASM-PDF-TEMPLATE: who fills a field, in the editor's colours (blue student, amber trainer, green record). */
const OWNERS: EditorOwner[] = [{ id: "student", label: "Student" }, { id: "trainer", label: "Trainer / assessor" }, { id: "auto", label: "Filled from the record" }];
const KINDS: Record<FieldKind, FieldKindSpec> = {
  text: { label: "Text answer", icon: "ri-text", w: 0.8, h: 0.08 },
  table_cell: { label: "Table cell", icon: "ri-table-line", w: 0.2, h: 0.03 },
  yes_no: { label: "Yes / No choice", icon: "ri-checkbox-circle-line", w: 0.02, h: 0.015 },
  checkbox: { label: "Tick box", icon: "ri-checkbox-line", w: 0.02, h: 0.015 },
  signature: { label: "Signature", icon: "ri-quill-pen-line", w: 0.25, h: 0.04 },
  date: { label: "Date", icon: "ri-calendar-line", w: 0.18, h: 0.025 },
  rating: { label: "Rating choice", icon: "ri-star-line", w: 0.02, h: 0.015 },
  auto: { label: "From the record", icon: "ri-database-2-line", w: 0.3, h: 0.025 },
};

type Field = EditorField<FieldKind>;
const toEditor = (f: TemplateField): Field => ({ key: f.id, type: f.kind, owner: f.role, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: !!f.required, label: f.label,
  meta: { questionKey: f.questionKey, dataKey: f.dataKey ?? null, option: f.option ?? null, group: f.group ?? null, attempt: f.attempt ?? null, table: f.table ?? null, step: f.step ?? null, slot: f.slot ?? null, checklist: f.checklist ?? null } });
const fromEditor = (f: Field): TemplateField => {
  const m = (f.meta ?? {}) as Partial<TemplateField>;
  const out: TemplateField = { id: f.key, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, role: f.owner as FieldRole, kind: f.type, questionKey: m.questionKey ?? null, label: f.label };
  if (f.required) out.required = true;
  if (m.dataKey) out.dataKey = m.dataKey;
  if (m.option) out.option = m.option;
  if (m.group) out.group = m.group;
  if (m.attempt) out.attempt = m.attempt;
  if (m.table) out.table = m.table;
  if (m.step) out.step = m.step;
  if (m.slot) out.slot = m.slot;
  if (m.checklist) out.checklist = m.checklist;
  return out;
};
/** A field moved to "Filled from the record" becomes an auto field, and back (the database requires both together). */
const normalise = (fields: Field[]): Field[] => fields.map((f) => {
  if (f.owner === "auto" && f.type !== "auto") return { ...f, type: "auto" };
  if (f.type === "auto" && f.owner !== "auto") return { ...f, owner: "auto" };
  return f;
});
const ranges = (pages: number[]) => pages.reduce<string[]>((out, p, i) => { if (i && p === pages[i - 1] + 1) out[out.length - 1] = `${out[out.length - 1].split("–")[0]}–${p}`; else out.push(String(p)); return out; }, []).join(", ");

/**
 * The assessment as its workbook PDF (owner 2026-11-26): upload the PDF, its answer boxes, marks, signatures and record values are
 * found on the pages, then checked and corrected here like an e-sign template (drag, resize, add, remove). Saved on the draft.
 */
type UnitRow = { id: string; code: string; name: string };
export default function PdfTemplatePanel({ assessmentId, editable, onChanged, unit = null, units = [] }: { assessmentId: string; editable: boolean; onChanged: () => void; unit?: UnitRow | null; units?: UnitRow[] }) {
  const toast = useToast();
  const [state, setState] = useState<TemplateState | null>(null);
  const [template, setTemplate] = useState<PdfTemplate | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // ASM-UNIT-CHECK: the unit the uploaded workbook names, against the assessment's unit; a mismatch waits for Switch or Keep (with a
  // reason) before the template can be saved, and the decision is audited (asm_import_unit_check)
  const [unitCheck, setUnitCheck] = useState<UnitCheck | null>(null);
  const [keepReason, setKeepReason] = useState("");
  // the unit the uploaded workbook names, waiting to be compared: the assessment's unit arrives with the course (course_get), which
  // can still be loading when the PDF is uploaded; saving waits until the comparison is made
  const [workbookUnit, setWorkbookUnit] = useState<{ code: string | null; name: string | null } | null>(null);
  useEffect(() => {
    if (!workbookUnit || !unit) return;
    const check = checkUnit(workbookUnit, { code: unit.code, name: unit.name });
    setUnitCheck(check.status === "mismatch" ? check : null); setKeepReason(""); setWorkbookUnit(null);
  }, [workbookUnit, unit]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await loadTemplate(assessmentId);
      setState(s); setTemplate(s.template); setFields((s.template?.fields ?? []).map(toEditor)); setDirty(false);
      setPdf(s.template ? await downloadWorkbook(s.template.pdf.path) : null);
    } catch (e) { setError((e as Error).message); }
  }, [assessmentId]);
  useEffect(() => { void load(); }, [load]);

  const current = useMemo<PdfTemplate | null>(() => template ? { ...template, fields: fields.map(fromEditor) } : null, [template, fields]);
  const problems = useMemo(() => current ? templateProblems(current) : [], [current]);
  const counts = useMemo(() => ({ student: fields.filter((f) => f.owner === "student").length, trainer: fields.filter((f) => f.owner === "trainer").length, auto: fields.filter((f) => f.owner === "auto").length }), [fields]);
  const trainerPages = useMemo(() => template?.pages.filter((p) => p.audience === "trainer").map((p) => p.page) ?? [], [template]);

  const readFile = async (file: File) => {
    setError(null);
    try {
      setBusy("Uploading the PDF…");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const where = await uploadWorkbook(assessmentId, bytes);
      const found = await detectWorkbook(bytes, { ...where, fileName: file.name }, (n, of) => setBusy(`Reading page ${n} of ${of}…`));
      // the unit the workbook names, read from its own copy before the page viewer takes the bytes
      const named = await unitInWorkbook(bytes.slice()).catch(() => ({ code: null, name: null }));
      setPdf(bytes); setTemplate(found); setFields(found.fields.map(toEditor)); setDirty(true);
      setUnitCheck(null); setWorkbookUnit(named);
      toast.push(`${found.questions.length} questions and ${found.fields.length} fields found. Check them, then save.`, "success");
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const detectAgain = async () => {
    if (!pdf || !template) return;
    setBusy("Reading the pages again…");
    try {
      const found = await detectWorkbook(pdf, template.pdf, (n, of) => setBusy(`Reading page ${n} of ${of}…`));
      setTemplate(found); setFields(found.fields.map(toEditor)); setDirty(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const decideUnit = async (kind: "switched" | "kept") => {
    if (!unitCheck) return;
    const why = unitDecisionError({ kind, reason: keepReason });
    if (why) { setError(why); return; }
    const target = units.find((u) => u.code.toUpperCase() === (unitCheck.found.code ?? "").toUpperCase()) ?? null;
    try {
      if (kind === "switched") {
        if (!target) { setError(`${unitCheck.found.code} is not a unit of this qualification in Skyline. Keep ${unit?.code ?? "the selected unit"} with a reason, or add the unit to the course first.`); return; }
        await asmAdmin("assessment_update", { id: assessmentId, unitId: target.id });
      }
      const { error: e } = await supabase.rpc("asm_import_unit_check", { p_assessment: assessmentId, p_decision: { kind, reason: keepReason, foundCode: unitCheck.found.code, foundTitle: unitCheck.found.name, selectedCode: unitCheck.selected.code, selectedTitle: unitCheck.selected.name } });
      if (e) throw new Error(e.message);
      setUnitCheck(null); setError(null);
      toast.push(kind === "switched" ? `The assessment is now filed under ${target?.code}.` : `Kept under ${unit?.code}; the reason is recorded.`, "success");
      if (kind === "switched") onChanged();
    } catch (e) { setError((e as Error).message); }
  };
  const save = async () => {
    if (!current || problems.length || unitCheck || workbookUnit) return;
    setBusy("Saving…");
    try {
      const out = await saveTemplate(assessmentId, current, state?.status === "draft" ? state.updatedAt : null);
      if (!out.ok) { setError((out.errors ?? ["The template could not be saved."]).slice(0, 5).join(" ")); return; }
      toast.push(`PDF template saved on draft v${out.versionNo}.`, "success");
      await load(); onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (!state && !error) return <SkeletonLines lines={6} />;
  const pick = (file: File | undefined) => { if (!file) return; if (template) setConfirmReplace(file); else void readFile(file); };

  return <div className="space-y-4" data-testid="pdf-template-panel">
    <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" data-testid="pdf-template-file" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-background-200 bg-white px-4 py-3">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-foreground-900">{template ? (template.pdf.fileName || "Workbook PDF") : "No workbook PDF yet"}</p>
        {template
          ? <p className="flex flex-wrap items-center gap-2 text-xs text-foreground-600" data-testid="pdf-template-summary">
              {template.pdf.pages} pages · {template.questions.length} questions · {template.tasks.length} tasks
              {([["Student", counts.student, "#2563eb"], ["Trainer", counts.trainer, "#d97706"], ["From the record", counts.auto, "#059669"]] as const).map(([label, n, colour]) =>
                <span key={label} className="inline-flex items-center gap-1 rounded-full bg-background-100 px-2.5 py-0.5 font-medium text-foreground-800"><span className="h-2 w-2 rounded-full" style={{ background: colour }} aria-hidden="true" />{label} {n}</span>)}
              {state?.status ? <Badge tone="muted">{state.status === "draft" ? `Draft v${state.versionNo}` : `Published v${state.versionNo}`}</Badge> : null}
              {dirty ? <Badge tone="accent">Not saved</Badge> : null}
            </p>
          : <p className="text-xs text-foreground-600">Upload the workbook as it is. Its answer boxes, the trainer's marks, signatures and the student's details are found on its pages; you check them here.</p>}
        {trainerPages.length ? <p className="text-xs text-foreground-500">Trainer only (never shown to the student): pages {ranges(trainerPages)}.</p> : null}
      </div>
      {editable ? <div className="flex flex-wrap gap-2">
        <Button variant={template ? "outline" : "primary"} size="sm" icon="ri-upload-2-line" disabled={!!busy} onClick={() => fileInput.current?.click()} data-testid="pdf-template-upload">{template ? "Replace PDF" : "Upload workbook PDF"}</Button>
        {template ? <Button variant="outline" size="sm" icon="ri-refresh-line" disabled={!!busy || !pdf} onClick={() => void detectAgain()}>Find fields again</Button> : null}
        {template ? <Button size="sm" icon="ri-save-3-line" disabled={!!busy || !dirty || problems.length > 0 || !!unitCheck || !!workbookUnit} onClick={() => void save()} data-testid="pdf-template-save">Save draft</Button> : null}
      </div> : null}
    </div>
    {busy ? <p role="status" className="rounded-lg bg-background-100 px-3 py-2 text-sm text-foreground-700">{busy}</p> : null}
    {unitCheck ? <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" role="alert" data-testid="unit-mismatch">
      <p className="font-medium">{unitCheck.message}. Saving waits until you choose.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void decideUnit("switched")} data-testid="unit-switch">Switch to {unitCheck.found.code ?? unitCheck.found.name}</Button>
        <input className="min-w-[14rem] flex-1 rounded-md border border-amber-300 bg-white px-2 py-1.5" placeholder={`Why it belongs to ${unitCheck.selected.code ?? "the selected unit"} (at least 5 characters)`} value={keepReason} onChange={(e) => setKeepReason(e.target.value)} aria-label="Reason to keep the selected unit" data-testid="unit-keep-reason" />
        <Button size="sm" variant="outline" disabled={keepReason.trim().length < 5} onClick={() => void decideUnit("kept")} data-testid="unit-keep">Keep {unitCheck.selected.code}</Button>
      </div>
    </div> : null}
    {error ? <ErrorNote text={error} /> : null}
    {problems.length ? <div className="rounded-lg border border-accent-300 bg-accent-50 px-3 py-2 text-sm text-foreground-800" data-testid="pdf-template-problems">
      <p className="font-medium">Fix before saving ({problems.length}):</p>
      <ul className="ml-4 list-disc text-xs">{problems.slice(0, 8).map((p) => <li key={p}>{p}</li>)}</ul>
    </div> : null}
    {template && pdf ? <div className="flex h-[78vh] min-h-[520px] flex-col">
      <FieldEditor<FieldKind> source={pdf} owners={OWNERS} kinds={KINDS} presets={false} lazy ownerLabel="New fields are filled by"
        fields={fields} onChange={(next) => { if (!editable) return; setFields(normalise(next)); setDirty(true); }}
        details={(f, update) => <FieldDetails field={f} update={update} questions={template.questions.map((q) => q.key)} />}
        panel={<QuestionList template={template} fields={fields} />} />
    </div> : null}
    <ConfirmDialog open={!!confirmReplace} title="Replace the workbook PDF?" confirmLabel="Replace and find fields"
      message="The fields are found again on the new PDF; corrections made here to the current fields are not kept. Nothing is saved until you press Save draft."
      onCancel={() => setConfirmReplace(null)} onConfirm={() => { const f = confirmReplace; setConfirmReplace(null); if (f) void readFile(f); }} />
  </div>;
}

const input = "mt-1 w-full rounded border border-background-300 px-2 py-1.5 text-sm";

function FieldDetails({ field, update, questions }: { field: Field; update: (patch: Partial<Field>) => void; questions: string[] }) {
  const meta = (field.meta ?? {}) as Partial<TemplateField>;
  const setMeta = (patch: Partial<TemplateField>) => update({ meta: { ...meta, ...patch } });
  return <>
    <label className="block text-xs">Filled by
      <select value={field.owner} onChange={(e) => update({ owner: e.target.value, ...(e.target.value === "auto" ? { type: "auto" as FieldKind } : field.type === "auto" ? { type: "text" as FieldKind } : {}) })} className={input} data-testid="tpl-field-role">
        {OWNERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
    {field.owner !== "auto" ? <label className="block text-xs">Kind
      <select value={field.type} onChange={(e) => update({ type: e.target.value as FieldKind })} className={input}>
        {(Object.keys(KINDS) as FieldKind[]).filter((k) => k !== "auto").map((k) => <option key={k} value={k}>{KINDS[k].label}</option>)}</select></label>
      : <label className="block text-xs">Record value
        <select value={meta.dataKey ?? ""} onChange={(e) => setMeta({ dataKey: (e.target.value || null) as AutoKey | null })} className={input} data-testid="tpl-field-datakey">
          <option value="">Choose…</option>
          {(Object.entries(AUTO_KEYS) as [AutoKey, string][]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
    <label className="block text-xs">Label<input value={field.label} maxLength={120} onChange={(e) => update({ label: e.target.value })} className={input} /></label>
    <label className="block text-xs">Question
      <select value={meta.questionKey ?? ""} onChange={(e) => setMeta({ questionKey: e.target.value || null })} className={input}>
        <option value="">None (a sheet or the cover)</option>
        {questions.map((q) => <option key={q} value={q}>{q}</option>)}</select></label>
    {field.type === "yes_no" || field.type === "rating" ? <div className="grid grid-cols-2 gap-2">
      <label className="block text-xs">Group<input value={meta.group ?? ""} maxLength={80} onChange={(e) => setMeta({ group: e.target.value || null })} className={input} /></label>
      <label className="block text-xs">Option<input value={meta.option ?? ""} maxLength={20} onChange={(e) => setMeta({ option: e.target.value || null })} className={input} placeholder={field.type === "yes_no" ? "yes / no" : "1–5"} /></label>
    </div> : null}
    {field.owner === "trainer" ? <label className="block text-xs">Attempt
      <select value={String(meta.attempt ?? "")} onChange={(e) => setMeta({ attempt: e.target.value ? Number(e.target.value) : null })} className={input}>
        <option value="">Any</option><option value="1">First</option><option value="2">Second</option><option value="3">Third</option></select></label> : null}
    {meta.dataKey === "submission_method" ? <label className="block text-xs">This box is
      <select value={meta.option ?? ""} onChange={(e) => setMeta({ option: e.target.value || null })} className={input}>
        <option value="">Choose…</option>
        {SUBMISSION_OPTIONS.map((o) => <option key={o} value={o}>{({ hand: "By hand", email: "By email", lms: "Online via LMS (ticked)", other: "Any other method" } as Record<string, string>)[o]}</option>)}</select></label> : null}
    {(field.owner === "student" && field.type === "signature") || meta.dataKey === "acknowledged_date" ? <label className="block text-xs">Signed when
      <select value={meta.step ?? "submit"} onChange={(e) => setMeta({ step: e.target.value === "acknowledge" ? "acknowledge" : null })} className={input} data-testid="tpl-field-step">
        <option value="submit">Submitting the work</option><option value="acknowledge">Acknowledging the released result</option></select></label> : null}
    {field.owner === "student" ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={field.required} onChange={(e) => update({ required: e.target.checked })} /> Required</label> : null}
  </>;
}

function QuestionList({ template, fields }: { template: PdfTemplate; fields: Field[] }) {
  return <details className="rounded-md border border-background-300 p-2 text-xs" open>
    <summary className="cursor-pointer font-semibold text-foreground-800">Questions ({template.questions.length})</summary>
    <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto" data-testid="pdf-template-questions">
      {template.questions.map((q) => {
        const own = fields.filter((f) => (f.meta as Partial<TemplateField> | undefined)?.questionKey === q.key);
        const pages = [...new Set([q.header.page, ...q.areas.map((a) => a.page)])];
        const answers = own.filter((f) => f.owner === "student").length; const marks = own.filter((f) => f.owner === "trainer").length;
        return <li key={q.key} className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate"><span className="font-semibold">{q.key}</span> {q.label}</span>
          <span className={`shrink-0 ${answers && marks ? "text-foreground-500" : "font-medium text-red-700"}`}>p{ranges(pages)} · {answers}/{marks}</span>
        </li>;
      })}
    </ul>
    <p className="mt-1 text-2xs text-foreground-500">p = pages · answer fields / trainer marks</p>
  </details>;
}
