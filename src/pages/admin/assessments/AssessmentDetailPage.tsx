import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, ConfirmDialog, Field, PageHeader, SectionTabs, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Empty, SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import { fmtDateTime } from "@/lib/assessment/api";
import { countQuestions } from "@/lib/assessment/definition";
import { validateDefinition } from "@/lib/assessment/validate";
import type { Definition, QuestionKey, UnitMapping } from "@/lib/assessment/types";
import { asmAdmin, downloadJson, type AssessmentDetail } from "@/pages/admin/lib/assessments";
import { rto, type CourseDetail } from "@/pages/admin/lib/rto";
import Builder from "./builder/Builder";
import AssignmentsPanel from "./panels/AssignmentsPanel";
import AttemptDrawer from "./panels/AttemptDrawer";
import MappingPanel from "./panels/MappingPanel";

const TABS = [
  { id: "builder", label: "Builder", icon: "ri-layout-masonry-line" }, { id: "mapping", label: "Unit mapping", icon: "ri-links-line" },
  { id: "assignments", label: "Assignments", icon: "ri-group-line" }, { id: "versions", label: "Versions & export", icon: "ri-git-branch-line" }, { id: "settings", label: "Settings", icon: "ri-settings-3-line" },
];

/** One assessment: builder (autosaved draft), unit mapping with coverage, assignments to batches, versions / publish / export, overrides. */
export default function AssessmentDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { push } = useToast();
  const tab = params.get("tab") ?? "builder";
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
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await asmAdmin<AssessmentDetail>("assessment_get", { id });
      setDetail(d); setError("");
      if (d.editing) { setDefinition(d.editing.definition); setKeys(d.editing.keys); setMappings(d.editing.mappings); setSavedAt(d.editing.updatedAt); }
      else { setDefinition({ tasks: [] }); setKeys([]); setMappings([]); }
      setDirty(false);
      rto<CourseDetail>("course_get", { courseId: d.courseId }).then((c) => setUnits(c.units.filter((u) => u.isActive).map((u) => ({ id: u.id ?? "", code: u.code, name: u.name })))).catch(() => undefined);
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
  const onBuilderChange = (def: Definition, k: QuestionKey[]) => {
    setDefinition(def); setKeys(k); setDirty(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(def, k, mappings), 1200);
  };
  const onMappingsChange = (m: UnitMapping[]) => { setMappings(m); setDirty(true); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => definition && void save(definition, keys, m), 800); };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const problems = useMemo(() => (definition ? validateDefinition(definition) : []), [definition]);
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

  if (error && !detail) return <ErrorNote text={error} />;
  if (!detail || !definition) return <SkeletonLines lines={8} />;
  const current = detail.versions.find((v) => v.id === detail.currentVersionId);
  const canAssign = Boolean(detail.versions.some((v) => v.status === "published")) && !detail.archivedAt;
  return (
    <div>
      <PageHeader breadcrumb="Master Data › Assessments" title={detail.title} titleSuffix={detail.code ? <span className="ml-2 text-base font-normal text-foreground-500">{detail.code}</span> : null}
        description={`${units.find((u) => u.id === detail.unitId)?.code ?? ""} ${units.find((u) => u.id === detail.unitId)?.name ?? "No unit chosen"} · ${countQuestions(definition)} questions · ${detail.editing ? `v${detail.editing.versionNo} ${detail.editing.status}` : "no version"}${current ? ` · published v${current.versionNo}` : ""}`}
        actions={<>
          <span className="text-xs text-foreground-500" role="status">{saving ? "Saving…" : dirty ? "Unsaved changes" : savedAt ? `Saved ${fmtDateTime(savedAt)}` : ""}</span>
          <Button variant="outline" icon="ri-arrow-left-line" onClick={() => navigate("/admin/assessments")}>All assessments</Button>
          {editable ? <Button icon="ri-upload-2-line" disabled={!detail.editing || detail.editing.status !== "draft" || problems.length > 0} title={problems[0]?.message} onClick={() => setConfirmPublish(true)}>Publish v{detail.editing?.versionNo ?? 1}</Button> : null}
        </>} />
      {error ? <div className="mb-3"><ErrorNote text={error} /></div> : null}
      {problems.length ? <p className="mb-3 text-sm text-primary-700">{problems[0].message}</p> : null}
      <SectionTabs tabs={TABS} active={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === "builder" ? (draftIsPublished ? <div className="mb-3 rounded-md border border-background-200 bg-background-100 px-3 py-2 text-sm text-foreground-700">Version {detail.editing?.versionNo} is published and frozen. Your first change opens version {(detail.editing?.versionNo ?? 0) + 1} as a draft; students keep the version they started on.</div> : null) : null}
      {tab === "builder" ? <Builder definition={definition} keys={keys} onChange={onBuilderChange} readOnly={!editable} declarationText={String(detail.effectiveSettings.declaration_text ?? "")} /> : null}
      {tab === "mapping" ? <MappingPanel definition={definition} unitId={detail.unitId} versionId={detail.editing?.versionId ?? null} elements={detail.elements} mappings={mappings} onChange={onMappingsChange} onElementsChanged={() => void load()} readOnly={!editable} /> : null}
      {tab === "assignments" ? <AssignmentsPanel assessmentId={detail.id} courseId={detail.courseId} assignments={detail.assignments} canAssign={canAssign} onChanged={() => void load()} onOpenAttempt={setAttempt} /> : null}
      {tab === "versions" ? <VersionsPanel detail={detail} onChanged={() => void load()} /> : null}
      {tab === "settings" ? <SettingsPanel detail={detail} units={units} onChanged={() => void load()} /> : null}
      {attempt ? <AttemptDrawer attemptId={attempt} onClose={() => setAttempt(null)} onChanged={() => void load()} /> : null}
      <ConfirmDialog open={confirmPublish} title={`Publish version ${detail.editing?.versionNo ?? 1}?`} confirmLabel="Publish" message="A published version is frozen: its questions never change. Edits after publishing create the next version; students on this version keep it." onCancel={() => setConfirmPublish(false)} onConfirm={() => void publish()} />
    </div>
  );
}

function VersionsPanel({ detail, onChanged }: { detail: AssessmentDetail; onChanged: () => void }) {
  const { push } = useToast();
  const [error, setError] = useState("");
  const act = async (action: string, data: Record<string, unknown>, done: string) => { try { await asmAdmin(action, data); push(done); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : "Not done."); } };
  const exportJson = async (versionId?: string) => { try { const out = await asmAdmin<Record<string, unknown>>("assessment_export", { id: detail.id, versionId }); downloadJson(`${(detail.code || detail.title).replace(/[^A-Za-z0-9-]+/g, "_")}-v${String(out.versionNo)}.json`, out); } catch (e) { setError(e instanceof Error ? e.message : "Not exported."); } };
  return (
    <div className="space-y-3">
      {error ? <ErrorNote text={error} /> : null}
      <ul className="divide-y divide-background-100 rounded-md border border-background-200">{detail.versions.map((v) => (
        <li key={v.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
          <span className="font-medium text-foreground-900">Version {v.versionNo}</span>
          <Badge tone={v.status === "published" ? "success" : v.status === "draft" ? "accent" : "muted"}>{v.status}</Badge>
          <span className="min-w-0 flex-1 truncate text-xs text-foreground-600">{v.publishedAt ? `published ${fmtDateTime(v.publishedAt)}` : `created ${fmtDateTime(v.createdAt)}`} · {v.assignments} assignment{v.assignments === 1 ? "" : "s"} · {v.attempts} attempt{v.attempts === 1 ? "" : "s"}{v.checksum ? ` · ${v.checksum.slice(0, 12)}…` : ""}</span>
          <Button size="sm" variant="outline" icon="ri-download-2-line" onClick={() => void exportJson(v.id)}>Export JSON</Button>
          {v.status === "published" ? <Button size="sm" variant="ghost" onClick={() => window.confirm(`Retire version ${v.versionNo}? Its open assignments close; attempts keep their history.`) && void act("version_retire", { versionId: v.id }, "Version retired.")}>Retire</Button> : null}
          {v.status === "draft" && v.versionNo > 1 ? <Button size="sm" variant="ghost" onClick={() => window.confirm("Discard this draft? The published version stays.") && void act("draft_discard", { assessmentId: detail.id }, "Draft discarded.")}>Discard draft</Button> : null}
        </li>))}</ul>
      <p className="text-xs text-foreground-600">Import: Master Data › Assessments › New assessment › "From a JSON export". Attempts are always bound to the version they started on.</p>
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
    <div className="max-w-3xl space-y-4">
      {error ? <ErrorNote text={error} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" required><TextInput value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Code"><TextInput value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Description (shown to students)"><TextArea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        <Field label="Unit of competency"><Select value={unitId} onChange={(e) => setUnitId(e.target.value)}><option value="">(none)</option>{units.map((u) => <option key={u.id} value={u.id}>{u.code} {u.name}</option>)}</Select></Field>
        <div className="flex items-end"><Toggle label="Also usable as a template" checked={isTemplate} onChange={setIsTemplate} /></div>
      </div>
      <div className="rounded-md border border-background-200 p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground-500">Overrides of the institution's rules (blank = institution default)</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Maximum attempts (default ${String(eff.max_attempts)})`}><TextInput type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} /></Field>
          <Field label={`Reassessment window, days (default ${String(eff.reassessment_days)})`}><TextInput type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <Field label={`Late submissions (default ${String(eff.late_submission)})`}><Select value={late} onChange={(e) => setLate(e.target.value)}><option value="">(default)</option><option value="allow">Allow (flagged late)</option><option value="block">Block after the late date</option></Select></Field>
        </div>
      </div>
      <div className="flex flex-wrap gap-2"><Button icon="ri-save-line" onClick={() => void save()}>Save</Button>{!detail.archivedAt ? <Button variant="ghost" icon="ri-archive-line" onClick={() => window.confirm("Archive this assessment? Open assignments must be closed first.") && void archive()}>Archive</Button> : <Badge tone="muted">Archived</Badge>}</div>
      <p className="text-xs text-foreground-500"><Link className="underline" to="/admin/assessments?tab=settings">Institution settings</Link> hold the declaration wording, instructions, evidence limits and the rollup rule.</p>
    </div>
  );
}
export { Empty };
