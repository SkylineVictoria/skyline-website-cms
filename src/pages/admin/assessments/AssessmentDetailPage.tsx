import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, ConfirmDialog, Field, SectionTabs, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Empty, SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import { fmtDateTime } from "@/lib/assessment/api";
import { countQuestions } from "@/lib/assessment/definition";
import { validateDefinition } from "@/lib/assessment/validate";
import type { Definition, QuestionKey, UnitMapping } from "@/lib/assessment/types";
import { asmAdmin, attemptsRange, downloadJson, type AssessmentDetail } from "@/pages/admin/lib/assessments";
import { rto, type CourseDetail } from "@/pages/admin/lib/rto";
import Builder from "./builder/Builder";
import { PdfPreviewDialog } from "@/components/assessment/CheckList";
import { publishedBase, withNextVersion } from "@/lib/assessment/checkList";
import { blankWorkbookPdf } from "@/lib/assessment/workbookExport";
import { useAuth } from "@/pages/admin/lib/authContext";
import { bumpVersion } from "../../../../supabase/functions/_shared/asm-import/match.ts";
import AssignmentsPanel from "./panels/AssignmentsPanel";
import AttemptDrawer from "./panels/AttemptDrawer";
import AssessmentOverview from "./overview/AssessmentOverview";
import type { BlockSave } from "./overview/OverviewDrawers";
import AssessmentRenderer from "@/components/assessment/AssessmentRenderer";
import { MoreMenu } from "@/pages/admin/components/rto/overlay";
import { workbookNumbering } from "@/lib/assessment/workbookLayout";
import { issuesOf } from "@/lib/assessment/overview";
import { supabase } from "@/pages/admin/lib/supabase";
import type { Responses } from "@/lib/assessment/types";
import MappingPanel from "./panels/MappingPanel";
import PdfTemplatePanel from "./panels/PdfTemplatePanel";

const TABS = [
  { id: "overview", label: "Overview", icon: "ri-file-list-3-line" }, { id: "pdf", label: "PDF template", icon: "ri-file-pdf-2-line" }, { id: "builder", label: "Builder", icon: "ri-layout-masonry-line" }, { id: "mapping", label: "Unit mapping", icon: "ri-links-line" },
  { id: "assignments", label: "Assignments", icon: "ri-group-line" }, { id: "versions", label: "Versions & export", icon: "ri-git-branch-line" }, { id: "settings", label: "Settings", icon: "ri-settings-3-line" },
];

/** One assessment: builder (autosaved draft), unit mapping with coverage, assignments to intakes, versions / publish / export, overrides. */
export default function AssessmentDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { push } = useToast();
  const tabParam = params.get("tab");
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [error, setError] = useState("");
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [keys, setKeys] = useState<QuestionKey[]>([]);
  const [mappings, setMappings] = useState<UnitMapping[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [units, setUnits] = useState<{ id: string; code: string; name: string }[]>([]);
  const [course, setCourse] = useState<{ code: string; name: string } | null>(null);
  const [learnerPreview, setLearnerPreview] = useState(false);
  const [previewResponses, setPreviewResponses] = useState<Responses>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const timer = useRef<number | null>(null);
  const [preview, setPreview] = useState<{ bytes: Uint8Array | null; error: string } | null>(null);
  const { user } = useAuth();
  /** A published version opened for editing moves its printed version on once, with the first change (see publishedBase). */
  const pendingBump = useRef(false);
  /** The view the page opens on, decided once when it loads: an empty assessment (just created) opens in the Builder. */
  const firstTab = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await asmAdmin<AssessmentDetail>("assessment_get", { id });
      setDetail(d); setError("");
      const fromPublished = d.editing?.status === "published";
      pendingBump.current = fromPublished;
      if (firstTab.current === null) firstTab.current = d.editing && countQuestions(d.editing.definition) > 0 ? "overview" : "builder";
      if (d.editing) { setDefinition(fromPublished ? publishedBase(d.editing.definition) : d.editing.definition); setKeys(d.editing.keys); setMappings(d.editing.mappings); setSavedAt(d.editing.updatedAt); }
      else { setDefinition({ tasks: [] }); setKeys([]); setMappings([]); }
      setDirty(false);
      rto<CourseDetail>("course_get", { courseId: d.courseId }).then((c) => { setUnits(c.units.filter((u) => u.isActive).map((u) => ({ id: u.id ?? "", code: u.code, name: u.name }))); setCourse(c.course ? { code: c.course.code, name: c.course.name } : null); }).catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : "The assessment did not load."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const editable = Boolean(detail && !detail.archivedAt);
  const draftIsPublished = detail?.editing?.status === "published"; // editing a published version shows it read-only until the first change makes a new draft

  const save = useCallback(async (def: Definition, k: QuestionKey[], m: UnitMapping[]) => {
    if (!detail) return;
    setSaving(true);
    try {
      const out = await asmAdmin<{ ok: boolean; errors?: { message: string }[]; updatedAt?: string; versionNo?: number }>("draft_save", { assessmentId: detail.id, definition: def, keys: k, mappings: m, expectedUpdatedAt: draftIsPublished ? undefined : savedAt ?? undefined });
      if (!out.ok) { setError(out.errors?.map((e) => e.message).join(" ") ?? "Not saved."); return; }
      setSavedAt(out.updatedAt ?? null); setDirty(false); setError("");
      if (draftIsPublished) await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Not saved."); } finally { setSaving(false); }
  }, [detail, savedAt, draftIsPublished, load]);

  // Autosave 1.2 s after the last change (the database refuses a stale save, so two editors cannot overwrite each other silently).
  const onBuilderChange = (changed: Definition, k: QuestionKey[]) => {
    const def = pendingBump.current ? withNextVersion(changed, bumpVersion) : changed;
    pendingBump.current = false;
    setDefinition(def); setKeys(k); setDirty(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(def, k, mappings), 1200);
  };
  const onMappingsChange = (m: UnitMapping[]) => { setMappings(m); setDirty(true); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => definition && void save(definition, keys, m), 800); };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const problems = useMemo(() => (definition ? validateDefinition(definition) : []), [definition]);
  const numbers = useMemo(() => (definition ? workbookNumbering(definition) : new Map<string, { number: string }>()), [definition]);
  const issues = useMemo(() => (definition ? issuesOf(definition, numbers) : { total: 0, blocking: 0 }), [definition, numbers]);
  // an empty assessment (just created) opens in the Builder; everything else opens on the Overview
  const tab = tabParam ?? firstTab.current ?? "overview";

  /** ASM-OVERVIEW A2: a block saved from the Overview's drawer, with its audit entry (asm_overview_save: draft_save + asm_audit_log). */
  const saveBlock: BlockSave = useCallback(async (def, k, block) => {
    if (!detail) return "The assessment is not loaded.";
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    const next = pendingBump.current ? withNextVersion(def, bumpVersion) : def;
    const { data, error: e } = await supabase.rpc("asm_overview_save", { p_assessment: detail.id, p_payload: { definition: next, keys: k, ...(draftIsPublished || !savedAt ? {} : { expectedUpdatedAt: savedAt }), block } });
    if (e) return e.message;
    const out = data as { ok: boolean; errors?: { message: string }[]; updatedAt?: string; versionNo?: number };
    if (!out.ok) return out.errors?.map((x) => x.message).join(" ") || "Not saved.";
    pendingBump.current = false;
    setDefinition(next); setKeys(k); setSavedAt(out.updatedAt ?? null); setDirty(false); setError("");
    if (draftIsPublished) { push(`Saved as version ${out.versionNo ?? ""} (draft). The published version is unchanged.`); await load(); } else push("Saved.");
    return null;
  }, [detail, draftIsPublished, savedAt, load, push]);
  const discardDraft = async () => {
    if (!detail) return;
    try { await asmAdmin("draft_discard", { assessmentId: detail.id }); push("Draft discarded."); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Not discarded."); }
    setConfirmDiscard(false);
  };
  const publish = async () => {
    if (!detail || !definition) return;
    if (timer.current) { window.clearTimeout(timer.current); await save(definition, keys, mappings); }
    try {
      const out = await asmAdmin<{ ok: boolean; errors?: { message: string }[]; versionNo?: number }>("version_publish", { assessmentId: detail.id });
      if (!out.ok) { setError(out.errors?.map((e) => e.message).join(" ") ?? "Not published."); return; }
      push(`Version ${out.versionNo} published.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Not published."); }
    setConfirmPublish(false);
  };

  const previewPdf = async () => {
    if (!detail || !definition) return;
    setPreview({ bytes: null, error: "" });
    const versionNo = detail.editing ? detail.editing.versionNo + (draftIsPublished && dirty ? 1 : 0) : 1;
    const doc = { ...definition, source: { ...(definition.source ?? {}), version: definition.source?.version ?? String(versionNo) } };
    try { setPreview({ bytes: await blankWorkbookPdf(doc, detail.title), error: "" }); }
    catch (e) { setPreview({ bytes: null, error: e instanceof Error ? e.message : "The PDF could not be made." }); }
  };

  if (error && !detail) return <ErrorNote text={error} />;
  if (!detail || !definition) return <SkeletonLines lines={8} />;
  const current = detail.versions.find((v) => v.id === detail.currentVersionId);
  const canAssign = Boolean(detail.versions.some((v) => v.status === "published")) && !detail.archivedAt;
  const unit = units.find((u) => u.id === detail.unitId) ?? null;
  const published = current ?? null;
  const editingDraft = detail.editing?.status === "draft";
  return (
    <div>
      <AssessmentHeader detail={detail} definition={definition} unit={unit} course={course} published={published} editingDraft={editingDraft}
        saving={saving ? "Saving…" : dirty ? "Unsaved changes" : savedAt ? `Saved ${fmtDateTime(savedAt)}` : ""}
        publishDisabled={!editable || !editingDraft || problems.length > 0 || issues.blocking > 0}
        publishTitle={problems[0]?.message ?? (issues.blocking ? `${issues.blocking} numbering clash${issues.blocking === 1 ? "" : "es"} to fix first` : !editingDraft ? "Nothing to publish: edit the assessment to start the next version" : undefined)}
        onPreview={() => { setPreviewResponses({}); setLearnerPreview(true); }} onEdit={() => setParams({ tab: "builder" })} onPublish={() => setConfirmPublish(true)}
        onDiscard={editingDraft && published ? () => setConfirmDiscard(true) : null}
        more={[{ label: "Preview PDF", icon: "ri-file-pdf-2-line", onClick: () => void previewPdf() }, { label: "All assessments", icon: "ri-arrow-left-line", onClick: () => navigate("/admin/assessments") }]} />
      {error ? <div className="mb-3"><ErrorNote text={error} /></div> : null}
      {problems.length ? <p className="mb-3 text-sm text-primary-700">{problems[0].message}</p> : null}
      <SectionTabs tabs={TABS} active={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === "builder" && draftIsPublished && editable ? <p className="mb-3 flex items-start gap-2 rounded-xl border border-background-200 bg-white px-4 py-2.5 text-sm text-foreground-700" data-testid="published-note"><i className="ri-lock-line mt-0.5 text-foreground-500" aria-hidden="true" /><span>Version {detail.editing?.versionNo} is published. Your first change starts version {(detail.editing?.versionNo ?? 0) + 1} as a draft; students already in an attempt stay on version {detail.editing?.versionNo}.</span></p> : null}
      {tab === "overview" ? <AssessmentOverview definition={definition} keys={keys} readOnly={!editable} issues={issues} onShowIssues={() => setParams({ tab: "builder" })} onSave={saveBlock} /> : null}
      {tab === "builder" ? <Builder definition={definition} keys={keys} onChange={onBuilderChange} readOnly={!editable} declarationText={String(detail.effectiveSettings.declaration_text ?? "")} editor={{ id: user?.id ?? null, name: user?.name ?? null }} /> : null}
      {tab === "mapping" ? <MappingPanel assessmentId={detail.id} definition={definition} unitId={detail.unitId} unitCode={units.find((u) => u.id === detail.unitId)?.code ?? null} elements={detail.elements} mappings={mappings} onChange={onMappingsChange} onElementsChanged={() => void load()} readOnly={!editable} /> : null}
      {tab === "assignments" ? <AssignmentsPanel assessmentId={detail.id} courseId={detail.courseId} assignments={detail.assignments} canAssign={canAssign} onChanged={() => void load()} onOpenAttempt={setAttempt} /> : null}
      {tab === "pdf" ? <PdfTemplatePanel assessmentId={detail.id} editable={editable} onChanged={() => void load()} /> : null}
      {tab === "versions" ? <VersionsPanel detail={detail} onChanged={() => void load()} /> : null}
      {tab === "settings" ? <SettingsPanel detail={detail} units={units} onChanged={() => void load()} /> : null}
      {preview ? <PdfPreviewDialog preview={preview} title={`Preview PDF · ${detail.title}`} fileName={`${(detail.code || detail.title).replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`} onClose={() => setPreview(null)} /> : null}
      {attempt ? <AttemptDrawer attemptId={attempt} onClose={() => setAttempt(null)} onChanged={() => void load()} /> : null}
      {learnerPreview ? <LearnerPreview definition={definition} title={detail.title} responses={previewResponses} onChange={setPreviewResponses} declarationText={String(detail.effectiveSettings.declaration_text ?? "")} onClose={() => setLearnerPreview(false)} /> : null}
      <ConfirmDialog open={confirmDiscard} title={`Discard the version ${detail.editing?.versionNo ?? ""} draft?`} confirmLabel="Discard draft" message={`Its changes are lost. Version ${published?.versionNo ?? ""} stays live.`} onCancel={() => setConfirmDiscard(false)} onConfirm={() => void discardDraft()} />
      <ConfirmDialog open={confirmPublish} title={`Publish version ${detail.editing?.versionNo ?? 1}?`} confirmLabel="Publish" message="A published version is frozen: its questions never change. Edits after publishing create the next version; students on this version keep it." onCancel={() => setConfirmPublish(false)} onConfirm={() => void publish()} />
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
  const exportJson = async (versionId?: string) => { try { const out = await asmAdmin<Record<string, unknown>>("assessment_export", { id: detail.id, versionId }); downloadJson(`${(detail.code || detail.title).replace(/[^A-Za-z0-9-]+/g, "_")}-v${String(out.versionNo)}.json`, out); } catch (e) { setError(e instanceof Error ? e.message : "Not exported."); } };
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
              <button type="button" className={SMALL_BTN} onClick={() => void exportJson(v.id)}><i className="ri-download-2-line" aria-hidden="true" />Export JSON</button>
              {v.status === "published" ? <button type="button" className={SMALL_BTN} onClick={() => window.confirm(`Retire version ${v.versionNo}? Its open assignments close; attempts keep their history.`) && void act("version_retire", { versionId: v.id }, "Version retired.")}>Retire</button> : null}
              {v.status === "draft" && v.versionNo > 1 ? <button type="button" className={SMALL_BTN} onClick={() => window.confirm("Discard this draft? The published version stays.") && void act("draft_discard", { assessmentId: detail.id }, "Draft discarded.")}>Discard draft</button> : null}
            </span>
          </li>))}</ul>
      </section>
      <p className="text-xs text-foreground-600">Students already in an attempt stay on the version they started. Import: Master Data › Assessments › New assessment › "From a JSON export"; the workbook PDF is the page's Preview PDF.</p>
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
      <div className="flex flex-wrap gap-2"><Button icon="ri-save-line" onClick={() => void save()}>Save</Button>{!detail.archivedAt ? <Button variant="outline" icon="ri-archive-line" onClick={() => window.confirm("Archive this assessment? Open assignments must be closed first.") && void archive()}>Archive</Button> : <Badge tone="muted">Archived</Badge>}</div>
      <p className="text-xs text-foreground-500"><Link className="underline" to="/admin/assessments?tab=settings">Institution settings</Link> hold the declaration wording, instructions, evidence limits and the rollup rule.</p>
    </div>
  );
}
export { Empty };

/**
 * ASM-OVERVIEW header (design page 1): breadcrumb (Assessments / qualification / unit), the unit title with the Draft / Published
 * badge, "unit code · Workbook v1.0 · imported <date>", and Preview as learner / Edit / Publish (Publish waits while blocking issues
 * exist). Editing a published assessment: "Editing v2 draft · v1 is live" with Publish v2 and Discard draft.
 */
function AssessmentHeader({ detail, definition, unit, course, published, editingDraft, saving, publishDisabled, publishTitle, onPreview, onEdit, onPublish, onDiscard, more }: {
  detail: AssessmentDetail; definition: Definition; unit: { code: string; name: string } | null; course: { code: string; name: string } | null;
  published: { versionNo: number } | null; editingDraft: boolean; saving: string; publishDisabled: boolean; publishTitle?: string;
  onPreview: () => void; onEdit: () => void; onPublish: () => void; onDiscard: (() => void) | null; more: { label: string; icon: string; onClick: () => void }[];
}) {
  const n = detail.editing?.versionNo ?? 1;
  const importedAt = definition.source?.importedAt ?? [...detail.versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.createdAt ?? null;
  const date = importedAt ? new Date(importedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : null;
  const unitCode = unit?.code ?? definition.source?.unit?.code ?? detail.code ?? null;
  const title = unit?.name ?? definition.source?.unit?.name ?? detail.title;
  const status = detail.archivedAt ? { text: "Archived", cls: "bg-background-200 text-foreground-700" } : editingDraft ? { text: "Draft", cls: "bg-primary-50 text-primary-800" } : { text: "Published", cls: "bg-green-100 text-green-900" };
  const line = [unitCode, definition.source?.version ? `Workbook v${definition.source.version}` : null, date ? `imported ${date}` : null].filter(Boolean).join(" · ");
  return (
    <header className="mb-4 space-y-2" data-testid="assessment-header">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-1.5 text-sm text-foreground-600">
        <Link className="hover:text-primary-700 hover:underline" to="/admin/assessments">Assessments</Link><span aria-hidden="true">/</span>
        <span>{course ? `${course.code} ${course.name}` : "Qualification"}</span><span aria-hidden="true">/</span>
        <span className="font-medium text-foreground-900" aria-current="page">{unitCode ?? detail.title}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 font-heading text-2xl font-bold text-foreground-950">{title}<span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${status.cls}`} data-testid="status-badge">{status.text}</span></h1>
          {title !== detail.title && !detail.title.toLowerCase().includes(title.toLowerCase()) ? <p className="text-sm text-foreground-700">{detail.title}</p> : null}
          {line ? <p className="text-sm text-foreground-600" data-testid="header-line">{line}</p> : null}
          {editingDraft && published ? <p className="mt-1 text-sm font-medium text-amber-900" data-testid="version-line">Editing v{n} draft · v{published.versionNo} is live</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {saving ? <span className="text-xs text-foreground-500" role="status">{saving}</span> : null}
          <Button variant="outline" onClick={onPreview} data-testid="preview-learner">Preview as learner</Button>
          <Button variant="outline" onClick={onEdit} data-testid="edit-builder">Edit</Button>
          {onDiscard ? <Button variant="outline" onClick={onDiscard} data-testid="discard-draft">Discard draft</Button> : null}
          <Button onClick={onPublish} disabled={publishDisabled} title={publishTitle} data-testid="publish-version">{editingDraft && published ? `Publish v${n}` : "Publish"}</Button>
          <MoreMenu label="More actions" items={more} />
        </div>
      </div>
    </header>
  );
}

/** "Preview as learner": the assessment as a student fills it in (nothing is saved). */
function LearnerPreview({ definition, title, responses, onChange, declarationText, onClose }: { definition: Definition; title: string; responses: Responses; onChange: (r: Responses) => void; declarationText: string; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`Preview as learner · ${title}`} data-testid="learner-preview">
      <button type="button" aria-label="Close" className="absolute inset-0 cursor-default bg-foreground-950/30" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-4xl flex-col bg-background-100 shadow-xl">
        <div className="flex items-center justify-between border-b border-background-200 bg-white px-5 py-3">
          <div><p className="font-heading text-lg font-semibold text-foreground-950">Preview as learner</p><p className="text-xs text-foreground-600">What a student sees. Nothing you type here is saved.</p></div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-foreground-500 hover:bg-background-200" aria-label="Close preview"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6"><AssessmentRenderer definition={definition} responses={responses} onChange={onChange} mode="preview" declarationText={declarationText} /></div>
      </div>
    </div>
  );
}
