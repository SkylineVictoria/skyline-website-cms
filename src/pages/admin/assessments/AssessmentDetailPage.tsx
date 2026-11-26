import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button, ConfirmDialog, Field, SectionTabs, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Empty, MoreMenu, SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import { fmtDateTime } from "@/lib/assessment/api";
import type { UnitMapping } from "@/lib/assessment/types";
import { asmAdmin, attemptsRange, type AssessmentDetail } from "@/pages/admin/lib/assessments";
import { rto, type CourseDetail } from "@/pages/admin/lib/rto";
import { supabase } from "@/pages/admin/lib/supabase";
import { loadTemplate } from "@/lib/assessment/pdfTemplate/api";
import { questionName } from "@/lib/assessment/pdfTemplate/model";
import AssignmentsPanel from "./panels/AssignmentsPanel";
import AttemptDrawer from "./panels/AttemptDrawer";
import MappingPanel, { type MapQuestion } from "./panels/MappingPanel";
import PdfTemplatePanel from "./panels/PdfTemplatePanel";

const TABS = [
  { id: "pdf", label: "PDF template", icon: "ri-file-pdf-2-line" }, { id: "mapping", label: "Unit mapping", icon: "ri-links-line" },
  { id: "assignments", label: "Assignments", icon: "ri-group-line" }, { id: "versions", label: "Versions", icon: "ri-git-branch-line" }, { id: "settings", label: "Settings", icon: "ri-settings-3-line" },
];

/**
 * One assessment (ASM-PDF-TEMPLATE phase 4, 2026-11-26): its workbook PDF with the fields found on it (PDF template, the default tab),
 * the unit mapping keyed by the workbook's printed question numbers, assignments to intakes, versions, settings. Publishing needs the
 * workbook PDF template; a published version is frozen and the next change starts the next draft (template and mapping carried over).
 */
export default function AssessmentDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { push } = useToast();
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [questions, setQuestions] = useState<MapQuestion[]>([]);
  const [mappings, setMappings] = useState<UnitMapping[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const [attempt, setAttempt] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copying, setCopying] = useState(false);
  const [units, setUnits] = useState<{ id: string; code: string; name: string }[]>([]);
  const [course, setCourse] = useState<{ code: string; name: string } | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await asmAdmin<AssessmentDetail>("assessment_get", { id });
      setDetail(d); setError(""); setMappings(d.editing?.mappings ?? []);
      const t = await loadTemplate(d.id).catch(() => null);
      setQuestions((t?.template?.questions ?? []).map((q) => ({ key: q.key, number: `Task ${q.task ?? ""} · ${questionName(q)}`.replace("Task  · ", ""), label: q.label ?? "" })));
      rto<CourseDetail>("course_get", { courseId: d.courseId }).then((c) => { setUnits(c.units.filter((u) => u.isActive).map((u) => ({ id: u.id ?? "", code: u.code, name: u.name }))); setCourse(c.course ? { code: c.course.code, name: c.course.name } : null); }).catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : "The assessment did not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const editable = Boolean(detail && !detail.archivedAt);
  const saveMappings = useCallback(async (m: UnitMapping[]) => {
    if (!detail) return;
    setSaving("Saving…");
    try {
      const out = await asmAdmin<{ ok: boolean; updatedAt?: string; versionNo?: number }>("draft_save", { assessmentId: detail.id, mappings: m });
      setSaving(`Saved ${fmtDateTime(out.updatedAt ?? new Date().toISOString())}`);
      if (detail.editing?.status === "published") { push(`Saved as version ${out.versionNo ?? ""} (draft). The published version is unchanged.`); await load(); }
    } catch (e) { setSaving(""); setError(e instanceof Error ? e.message : "Not saved."); }
  }, [detail, load, push]);
  const onMappingsChange = (m: UnitMapping[]) => { setMappings(m); setSaving("Unsaved changes"); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void saveMappings(m), 800); };

  const publish = async () => {
    if (!detail) return;
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; await saveMappings(mappings); }
    try {
      const out = await asmAdmin<{ ok: boolean; errors?: { message: string }[]; versionNo?: number }>("version_publish", { assessmentId: detail.id });
      if (!out.ok) { setError(out.errors?.map((e) => e.message).join(" ") ?? "Not published."); return; }
      push(`Version ${out.versionNo} published.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Not published."); }
    setConfirmPublish(false);
  };
  const discardDraft = async () => {
    if (!detail) return;
    try { await asmAdmin("draft_discard", { assessmentId: detail.id }); push("Draft discarded."); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Not discarded."); }
    setConfirmDiscard(false);
  };
  /** A copy: the workbook PDF template and the mapping (asm_admin assessment_create fromAssessmentId), the PDF file copied into its folder. */
  const copy = async () => {
    if (!detail) return;
    setCopying(true);
    try {
      const out = await asmAdmin<{ id: string; copyPdf: { from: string; to: string } | null }>("assessment_create", { courseId: detail.courseId, unitId: detail.unitId, title: `Copy of ${detail.title}`, fromAssessmentId: detail.id });
      if (out.copyPdf) {
        const { error: e } = await supabase.storage.from("assessment-templates").copy(out.copyPdf.from, out.copyPdf.to);
        if (e && !/exist|duplicate/i.test(e.message)) throw new Error(`The copy was made but its workbook PDF was not copied: ${e.message}. Upload the PDF again on its PDF template tab.`);
      }
      push("Copied."); navigate(`/admin/assessments/${out.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Not copied."); } finally { setCopying(false); }
  };

  if (error && !detail) return <ErrorNote text={error} />;
  if (!detail) return <SkeletonLines lines={8} />;
  const current = detail.versions.find((v) => v.id === detail.currentVersionId) ?? null;
  const canAssign = detail.versions.some((v) => v.status === "published") && !detail.archivedAt;
  const unit = units.find((u) => u.id === detail.unitId) ?? null;
  const editingDraft = detail.editing?.status === "draft";
  const ready = Boolean(detail.editing?.hasTemplate && detail.editing.questions > 0);
  const tab = params.get("tab") ?? "pdf";
  const n = detail.editing?.versionNo ?? 1;
  const status = detail.archivedAt ? { text: "Archived", cls: "bg-background-200 text-foreground-700" } : editingDraft ? { text: "Draft", cls: "bg-primary-50 text-primary-800" } : { text: "Published", cls: "bg-green-100 text-green-900" };
  const publishTitle = !editingDraft ? "Nothing to publish: change the workbook or the mapping to start the next version" : !ready ? "Upload the workbook PDF and save its fields first" : undefined;
  return (
    <div>
      <header className="mb-4 space-y-2" data-testid="assessment-header">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-1.5 text-sm text-foreground-600">
          <Link className="hover:text-primary-700 hover:underline" to="/admin/assessments">Assessments</Link><span aria-hidden="true">/</span>
          <span>{course ? `${course.code} ${course.name}` : "Qualification"}</span><span aria-hidden="true">/</span>
          <span className="font-medium text-foreground-900" aria-current="page">{unit?.code ?? detail.title}</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 font-heading text-2xl font-bold text-foreground-950">{detail.title}<span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${status.cls}`} data-testid="status-badge">{status.text}</span></h1>
            <p className="text-sm text-foreground-600" data-testid="header-line">{[unit ? `${unit.code} ${unit.name}` : null, detail.editing ? `${detail.editing.questions} question${detail.editing.questions === 1 ? "" : "s"} on the workbook` : null].filter(Boolean).join(" · ")}</p>
            {editingDraft && current ? <p className="mt-1 text-sm font-medium text-amber-900" data-testid="version-line">Editing v{n} draft · v{current.versionNo} is live</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {saving ? <span className="text-xs text-foreground-500" role="status">{saving}</span> : null}
            {editingDraft && current ? <Button variant="outline" onClick={() => setConfirmDiscard(true)} data-testid="discard-draft">Discard draft</Button> : null}
            <Button onClick={() => setConfirmPublish(true)} disabled={!editable || !editingDraft || !ready} title={publishTitle} data-testid="publish-version">{editingDraft && current ? `Publish v${n}` : "Publish"}</Button>
            <MoreMenu label="More actions" items={[{ label: copying ? "Copying…" : "Copy assessment", icon: "ri-file-copy-line", onClick: () => void copy() }, { label: "All assessments", icon: "ri-arrow-left-line", onClick: () => navigate("/admin/assessments") }]} />
          </div>
        </div>
      </header>
      {error ? <div className="mb-3"><ErrorNote text={error} /></div> : null}
      <SectionTabs tabs={TABS} active={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === "pdf" ? <PdfTemplatePanel assessmentId={detail.id} editable={editable} unit={unit} units={units} onChanged={() => void load()} /> : null}
      {tab === "mapping" ? (questions.length
        ? <MappingPanel assessmentId={detail.id} questions={questions} unitId={detail.unitId} unitCode={unit?.code ?? null} elements={detail.elements} mappings={mappings} onChange={onMappingsChange} onElementsChanged={() => void load()} readOnly={!editable} />
        : <Empty icon="ri-links-line" title="No questions to map yet" text="Upload the workbook PDF on the PDF template tab and save its fields: its questions are mapped here by their printed numbers." />) : null}
      {tab === "assignments" ? <AssignmentsPanel assessmentId={detail.id} courseId={detail.courseId} assignments={detail.assignments} canAssign={canAssign} onChanged={() => void load()} onOpenAttempt={setAttempt} /> : null}
      {tab === "versions" ? <VersionsPanel detail={detail} onChanged={() => void load()} /> : null}
      {tab === "settings" ? <SettingsPanel detail={detail} units={units} onChanged={() => void load()} /> : null}
      {attempt ? <AttemptDrawer attemptId={attempt} onClose={() => setAttempt(null)} onChanged={() => void load()} /> : null}
      <ConfirmDialog open={confirmDiscard} title={`Discard the version ${n} draft?`} confirmLabel="Discard draft" message={`Its changes are lost. Version ${current?.versionNo ?? ""} stays live.`} onCancel={() => setConfirmDiscard(false)} onConfirm={() => void discardDraft()} />
      <ConfirmDialog open={confirmPublish} title={`Publish version ${n}?`} confirmLabel="Publish" message="A published version is frozen: its workbook and fields never change. Changes after publishing create the next version; students on this version keep it." onCancel={() => setConfirmPublish(false)} onConfirm={() => void publish()} />
    </div>
  );
}

const SMALL_BTN = "inline-flex cursor-pointer items-center gap-1 rounded-md border border-background-300 bg-white px-2 py-1 text-xs font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700";
const CARD = "overflow-hidden rounded-xl border border-background-200 bg-white";
const CARD_HEAD = "border-b border-background-200 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-900";

function VersionsPanel({ detail, onChanged }: { detail: AssessmentDetail; onChanged: () => void }) {
  const { push } = useToast();
  const [error, setError] = useState("");
  const act = async (action: string, data: Record<string, unknown>, done: string) => { try { await asmAdmin(action, data); push(done); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : "Not done."); } };
  return (
    <div className="space-y-3">
      {error ? <ErrorNote text={error} /> : null}
      <section className={CARD}>
        <p className={CARD_HEAD}>Versions</p>
        <ul className="divide-y divide-background-100" data-testid="versions-list">{detail.versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
            <span className="w-20 shrink-0 font-semibold text-foreground-900">Version {v.versionNo}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${v.status === "published" ? "bg-green-100 text-green-900" : v.status === "draft" ? "bg-amber-100 text-amber-900" : "bg-background-100 text-foreground-600"}`}>{v.status === "published" ? "Published" : v.status === "draft" ? "Draft" : "Retired"}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground-600">{v.publishedAt ? `published ${fmtDateTime(v.publishedAt)}` : `created ${fmtDateTime(v.createdAt)}`} · {v.assignments} assignment{v.assignments === 1 ? "" : "s"} · {v.attempts} attempt{v.attempts === 1 ? "" : "s"}</span>
            <span className="flex shrink-0 items-center gap-1">
              {v.status === "published" ? <button type="button" className={SMALL_BTN} onClick={() => window.confirm(`Retire version ${v.versionNo}? Its open assignments close; attempts keep their history.`) && void act("version_retire", { versionId: v.id }, "Version retired.")}>Retire</button> : null}
              {v.status === "draft" && v.versionNo > 1 ? <button type="button" className={SMALL_BTN} onClick={() => window.confirm("Discard this draft? The published version stays.") && void act("draft_discard", { assessmentId: detail.id }, "Draft discarded.")}>Discard draft</button> : null}
            </span>
          </li>))}</ul>
      </section>
      <p className="text-xs text-foreground-600">Students already in an attempt stay on the version they started. Each version keeps its own workbook PDF and fields.</p>
    </div>
  );
}

function SettingsPanel({ detail, units, onChanged }: { detail: AssessmentDetail; units: { id: string; code: string; name: string }[]; onChanged: () => void }) {
  const { push } = useToast();
  const [title, setTitle] = useState(detail.title); const [code, setCode] = useState(detail.code ?? ""); const [description, setDescription] = useState(detail.description); const [unitId, setUnitId] = useState(detail.unitId ?? "");
  const [isTemplate, setIsTemplate] = useState(detail.isTemplate);
  const ov = detail.settingsOverride as Record<string, unknown>;
  const [maxAttempts, setMaxAttempts] = useState(ov.max_attempts !== undefined ? String(ov.max_attempts) : "");
  const [days, setDays] = useState(ov.reassessment_days !== undefined ? String(ov.reassessment_days) : "");
  const [late, setLate] = useState(String(ov.late_submission ?? ""));
  const [error, setError] = useState("");
  const save = async () => {
    try {
      const settingsOverride: Record<string, unknown> = {};
      if (maxAttempts) settingsOverride.max_attempts = Number(maxAttempts); if (days) settingsOverride.reassessment_days = Number(days); if (late) settingsOverride.late_submission = late;
      await asmAdmin("assessment_update", { id: detail.id, title, code: code || null, description, unitId: unitId || null, isTemplate, settingsOverride }); push("Saved."); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "Not saved."); }
  };
  const archive = async () => { try { await asmAdmin("assessment_archive", { id: detail.id }); push("Archived."); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : "Not archived."); } };
  const eff = detail.effectiveSettings;
  return (
    <div className="max-w-3xl space-y-4" data-testid="settings-panel">
      {error ? <ErrorNote text={error} /> : null}
      <section className={CARD}>
      <p className={CARD_HEAD}>Assessment</p>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Title" required><TextInput value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Code"><TextInput value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Description (shown to students)"><TextArea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        <Field label="Unit of competency"><Select value={unitId} searchPlaceholder="Search units…" noMatchText="No units match" onChange={(e) => setUnitId(e.target.value)}><option value="">(none)</option>{units.map((u) => <option key={u.id} value={u.id}>{u.code} {u.name}</option>)}</Select></Field>
        <div className="flex items-end"><Toggle label="Also usable as a template" checked={isTemplate} onChange={setIsTemplate} /></div>
      </div>
      </section>
      <section className={CARD}>
        <p className={CARD_HEAD}>Overrides of the institution's rules <span className="font-normal text-foreground-500">· blank = institution default</span></p>
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Field label={`Maximum attempts (default ${String(eff.max_attempts)})`}><TextInput type="number" min={attemptsRange().minimum} max={attemptsRange().maximum} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} /></Field>
          <Field label={`Reassessment window, days (default ${String(eff.reassessment_days)})`}><TextInput type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <Field label={`Late submissions (default ${String(eff.late_submission)})`}><Select value={late} onChange={(e) => setLate(e.target.value)}><option value="">(default)</option><option value="allow">Allow (flagged late)</option><option value="block">Block after the late date</option></Select></Field>
        </div>
      </section>
      <div className="flex flex-wrap gap-2"><Button icon="ri-save-line" onClick={() => void save()}>Save</Button>{!detail.archivedAt ? <Button variant="outline" icon="ri-archive-line" onClick={() => window.confirm("Archive this assessment? Open assignments must be closed first.") && void archive()}>Archive</Button> : null}</div>
      <p className="text-xs text-foreground-500"><Link className="underline" to="/admin/assessments?tab=settings">Institution settings</Link> hold the evidence limits and the attempt rules.</p>
    </div>
  );
}
export { Empty };
