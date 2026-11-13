import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Badge, Button, Field, Modal, PageHeader, SectionTabs, Select, StatCard, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Empty, SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import CalendarView from "@/components/assessment/CalendarView";
import ProgressList, { type Progress } from "@/components/assessment/ProgressList";
import { fmtDateTime, OUTCOME_LABEL, STATE_LABEL } from "@/lib/assessment/api";
import { questionType } from "@/lib/assessment/registry";
import { asmAdmin, downloadCsv, type AssessmentRow, type AuditRow, type BankRow, type BatchOption, type OutcomeRow, type Overview, type Settings } from "@/pages/admin/lib/assessments";
import { rto, type CourseDetail, type RtoCourse } from "@/pages/admin/lib/rto";
import AttemptDrawer from "./panels/AttemptDrawer";

const TABS = [
  { id: "library", label: "Library", icon: "ri-book-2-line" }, { id: "submissions", label: "Submissions", icon: "ri-inbox-line" }, { id: "outcomes", label: "Outcomes", icon: "ri-award-line" },
  { id: "bank", label: "Question bank", icon: "ri-archive-line" }, { id: "calendar", label: "Calendar", icon: "ri-calendar-2-line" }, { id: "reports", label: "Reports", icon: "ri-bar-chart-2-line" },
  { id: "settings", label: "Settings", icon: "ri-settings-3-line" }, { id: "audit", label: "Audit", icon: "ri-history-line" },
];
const fail = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Master Data › Assessments: the library, the submissions overview, outcomes, the question bank, the calendar, reports, settings and the audit log. */
export default function AssessmentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "library";
  const [me, setMe] = useState<{ assessmentAdmin: boolean } | null>(null);
  useEffect(() => { void asmAdmin<{ assessmentAdmin: boolean }>("me").then(setMe).catch(() => setMe({ assessmentAdmin: false })); }, []);
  return (
    <div>
      <PageHeader breadcrumb="Master Data" title="Assessments" description="Form-built assessments mapped to course and unit, assigned to batches, marked by trainers, with reassessment and competency outcomes." />
      {me && !me.assessmentAdmin ? <ErrorNote text="Only an Admin or an RTO Manager can manage assessments." /> : null}
      <SectionTabs tabs={TABS} active={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === "library" ? <Library /> : null}
      {tab === "submissions" ? <Submissions /> : null}
      {tab === "outcomes" ? <Outcomes /> : null}
      {tab === "bank" ? <Bank /> : null}
      {tab === "calendar" ? <AdminCalendar /> : null}
      {tab === "reports" ? <Reports /> : null}
      {tab === "settings" ? <SettingsTab /> : null}
      {tab === "audit" ? <Audit /> : null}
    </div>
  );
}

function Library() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<AssessmentRow[] | null>(null);
  const [q, setQ] = useState(""); const [courseId, setCourseId] = useState(""); const [archived, setArchived] = useState(false);
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => asmAdmin<AssessmentRow[]>("assessment_list", { q: q || undefined, courseId: courseId || undefined, includeArchived: archived }).then(setRows).catch((e) => setError(fail(e))), [q, courseId, archived]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void rto<RtoCourse[]>("course_list").then(setCourses).catch(() => setCourses([])); }, []);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <TextInput className="max-w-xs" placeholder="Search title or code" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-auto" value={courseId} onChange={(e) => setCourseId(e.target.value)}><option value="">All courses</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
        <Toggle label="Show archived" checked={archived} onChange={setArchived} />
        <span className="flex-1" /><Button icon="ri-add-line" onClick={() => setCreating(true)}>New assessment</Button>
      </div>
      {error ? <ErrorNote text={error} /> : null}
      {rows === null ? <SkeletonLines lines={6} /> : rows.length === 0 ? <Empty icon="ri-file-list-3-line" title="No assessments yet" text="Create the first one: choose the course and unit, then build the tasks and questions." action={<Button icon="ri-add-line" onClick={() => setCreating(true)}>New assessment</Button>} /> : (
        <ul className="divide-y divide-background-100 rounded-md border border-background-200">{rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <Link to={`/admin/assessments/${r.id}`} className="min-w-0 flex-1"><span className="block truncate font-medium text-foreground-900 hover:text-primary-700">{r.title}{r.code ? <span className="ml-2 text-xs text-foreground-500">{r.code}</span> : null}</span><span className="block truncate text-xs text-foreground-600">{r.courseName}{r.unitCode ? ` · ${r.unitCode} ${r.unitName}` : " · no unit"} · updated {fmtDateTime(r.updatedAt)}</span></Link>
            {r.isTemplate ? <Badge tone="accent">Template</Badge> : null}
            <Badge tone={r.currentVersionStatus === "published" ? "success" : "muted"}>{r.currentVersionNo ? `v${r.currentVersionNo} ${r.currentVersionStatus}` : "unpublished"}</Badge>
            {r.hasDraft && r.currentVersionNo ? <Badge tone="warn">draft in progress</Badge> : null}
            <span className="text-xs text-foreground-600">{r.assignments} assignment{r.assignments === 1 ? "" : "s"}</span>
            {r.archivedAt ? <Badge tone="muted">archived</Badge> : null}
          </li>))}</ul>
      )}
      {creating ? <CreateDialog courses={courses} templates={(rows ?? []).filter((r) => r.isTemplate || r.currentVersionNo)} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/admin/assessments/${id}`)} /> : null}
    </div>
  );
}

function CreateDialog({ courses, templates, onClose, onCreated }: { courses: RtoCourse[]; templates: AssessmentRow[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? ""); const [unitId, setUnitId] = useState(""); const [title, setTitle] = useState(""); const [code, setCode] = useState(""); const [description, setDescription] = useState("");
  const [source, setSource] = useState<"blank" | "clone" | "import">("blank"); const [fromId, setFromId] = useState(""); const [importText, setImportText] = useState("");
  const [units, setUnits] = useState<{ id: string; code: string; name: string }[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { if (!courseId) return; rto<CourseDetail>("course_get", { courseId }).then((c) => setUnits(c.units.filter((u) => u.isActive).map((u) => ({ id: u.id ?? "", code: u.code, name: u.name })))).catch(() => setUnits([])); }, [courseId]);
  const create = async () => {
    setBusy(true); setError("");
    try {
      let imported: unknown;
      if (source === "import") { try { imported = JSON.parse(importText); } catch { setError("That is not valid JSON."); setBusy(false); return; } }
      const out = await asmAdmin<{ id?: string; ok?: boolean; errors?: { message: string }[] }>("assessment_create", { courseId, unitId: unitId || null, title: title || (imported as { title?: string } | undefined)?.title, code: code || null, description, fromAssessmentId: source === "clone" ? fromId : undefined, import: source === "import" ? imported : undefined });
      if (out.ok === false) { setError(out.errors?.map((e) => e.message).join(" ") ?? "Not created."); return; }
      if (out.id) onCreated(out.id);
    } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open title="New assessment" onClose={onClose} width="max-w-2xl" footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !courseId || (!title && source !== "import") || (source === "clone" && !fromId)} onClick={() => void create()}>Create</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Course" required><Select value={courseId} onChange={(e) => { setCourseId(e.target.value); setUnitId(""); }}>{courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
          <Field label="Unit of competency"><Select value={unitId} onChange={(e) => setUnitId(e.target.value)}><option value="">Choose later</option>{units.map((u) => <option key={u.id} value={u.id}>{u.code} {u.name}</option>)}</Select></Field>
          <Field label="Title" required><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Work safely: knowledge and practical" /></Field>
          <Field label="Code"><TextInput value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. CPCCWHS2001-A1" /></Field>
        </div>
        <Field label="Description for students"><TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Start from"><Select value={source} onChange={(e) => setSource(e.target.value as typeof source)}><option value="blank">Blank</option><option value="clone">A copy of an existing assessment or template</option><option value="import">A JSON export</option></Select></Field>
        {source === "clone" ? <Field label="Copy from"><Select value={fromId} onChange={(e) => setFromId(e.target.value)}><option value="">Choose…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.isTemplate ? "[Template] " : ""}{t.title} ({t.courseName})</option>)}</Select></Field> : null}
        {source === "import" ? <Field label="Paste the JSON export" hint="Keys and mappings in the file are restored; mapped elements are created on the unit by code."><TextArea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} /></Field> : null}
        {error ? <p className="text-sm text-primary-700" role="alert">{error}</p> : null}
      </div>
    </Modal>
  );
}

function Submissions() {
  const [ov, setOv] = useState<Overview | null>(null); const [error, setError] = useState(""); const [attempt, setAttempt] = useState<string | null>(null);
  const [batchId, setBatchId] = useState(""); const [batches, setBatches] = useState<BatchOption[]>([]);
  const load = useCallback(() => asmAdmin<Overview>("overview", { batchId: batchId || undefined }).then(setOv).catch((e) => setError(fail(e))), [batchId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void asmAdmin<BatchOption[]>("batch_list", { includeInactive: true }).then(setBatches).catch(() => setBatches([])); }, []);
  return (
    <div className="space-y-4">
      <Select className="w-auto" value={batchId} onChange={(e) => setBatchId(e.target.value)}><option value="">All batches</option>{batches.map((b) => <option key={b.id} value={b.id}>{b.courseName} · {b.intake} · {b.name}</option>)}</Select>
      {error ? <ErrorNote text={error} /> : null}
      {ov ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Open assignments" value={ov.assignments} icon="ri-group-line" hint={`${ov.eligible} students`} />
          <StatCard label="Not started / in progress" value={`${ov.notStarted} / ${ov.draft}`} icon="ri-edit-line" hint={`${ov.overdue} overdue`} />
          <StatCard label="Waiting for marking" value={ov.submitted} icon="ri-inbox-line" hint={`${ov.returned} returned for reassessment`} />
          <StatCard label="Final" value={ov.final} icon="ri-check-double-line" hint={`${ov.reassessmentsOpen} reassessment request${ov.reassessmentsOpen === 1 ? "" : "s"} waiting`} />
        </div>
      ) : <SkeletonLines lines={3} />}
      <div>
        <h3 className="mb-2 font-heading text-base font-semibold text-foreground-950">Pending marking</h3>
        {ov && ov.pendingMarking.length === 0 ? <p className="text-sm text-foreground-600">Nothing is waiting for an assessor.</p> : null}
        {ov && ov.pendingMarking.length ? <ul className="divide-y divide-background-100 rounded-md border border-background-200">{ov.pendingMarking.map((p) => <li key={p.attemptId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"><button type="button" className="min-w-0 flex-1 text-left" onClick={() => setAttempt(p.attemptId)}><span className="block font-medium text-foreground-900">{p.studentName} · {p.assessmentTitle}</span><span className="block text-xs text-foreground-600">{p.batchName} · attempt {p.attemptNo} · submitted {fmtDateTime(p.submittedAt)}</span></button><Badge tone={p.state === "marking" ? "accent" : "warn"}>{STATE_LABEL[p.state] ?? p.state}</Badge></li>)}</ul> : null}
      </div>
      <ReassessmentRequests onChanged={() => void load()} />
      {attempt ? <AttemptDrawer attemptId={attempt} onClose={() => setAttempt(null)} onChanged={() => void load()} /> : null}
    </div>
  );
}

function ReassessmentRequests({ onChanged }: { onChanged: () => void }) {
  const { push } = useToast();
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => { void asmAdmin<AuditRow[]>("audit_list", { targetType: "reassessment", limit: 50 }).then((r) => setRows(r.filter((x) => x.action === "reassessment_request"))).catch(() => setRows([])); }, []);
  if (!rows.length) return null;
  const decide = async (id: string, approve: boolean) => { try { await asmAdmin("reassessment_decide", { id, approve }); push(approve ? "Reassessment approved." : "Request declined."); setRows((r) => r.filter((x) => x.targetId !== id)); onChanged(); } catch (e) { push(fail(e), "error"); } };
  return (
    <div>
      <h3 className="mb-2 font-heading text-base font-semibold text-foreground-950">Reassessment requests from students</h3>
      <ul className="divide-y divide-background-100 rounded-md border border-background-200">{rows.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"><span className="min-w-0 flex-1 text-foreground-800">Request {r.targetId.slice(0, 8)} · {fmtDateTime(r.at)}</span><Button size="sm" onClick={() => void decide(r.targetId, true)}>Approve</Button><Button size="sm" variant="outline" onClick={() => void decide(r.targetId, false)}>Decline</Button></li>)}</ul>
    </div>
  );
}

function Outcomes() {
  const [rows, setRows] = useState<OutcomeRow[] | null>(null); const [error, setError] = useState("");
  const [studentId, setStudentId] = useState(""); const [progress, setProgress] = useState<Progress | null>(null); const [attempt, setAttempt] = useState<string | null>(null);
  useEffect(() => { void asmAdmin<OutcomeRow[]>("outcomes_list").then(setRows).catch((e) => setError(fail(e))); }, []);
  useEffect(() => { if (!studentId) { setProgress(null); return; } void asmAdmin<Progress>("student_progress", { studentId }).then(setProgress).catch((e) => setError(fail(e))); }, [studentId]);
  return (
    <div className="space-y-4">
      {error ? <ErrorNote text={error} /> : null}
      <div className="flex flex-wrap items-center gap-2"><TextInput className="max-w-sm" placeholder="Student id (from the student page) for a progress view" value={studentId} onChange={(e) => setStudentId(e.target.value.trim())} />{rows ? <Button size="sm" variant="outline" icon="ri-download-2-line" onClick={() => downloadCsv("unit-outcomes.csv", rows.map((r) => ({ student: r.studentName, unit: `${r.unitCode} ${r.unitName}`, outcome: OUTCOME_LABEL[r.outcome], signedBy: r.signedName, role: r.signedRole, signedAt: r.signedAt, current: r.current, notes: r.notes })))}>Export CSV</Button> : null}</div>
      {progress ? <ProgressList progress={progress} onOpenAttempt={setAttempt} /> : null}
      <h3 className="font-heading text-base font-semibold text-foreground-950">Signed unit outcomes (immutable history)</h3>
      {rows === null ? <SkeletonLines lines={4} /> : rows.length === 0 ? <p className="text-sm text-foreground-600">No unit outcome has been signed yet.</p> : (
        <ul className="divide-y divide-background-100 rounded-md border border-background-200">{rows.map((r) => <li key={r.id} className={`flex flex-wrap items-center gap-3 px-3 py-2 text-sm ${r.current ? "" : "opacity-60"}`}><Link to={`/admin/students/${r.studentId}`} className="font-medium text-foreground-900 hover:text-primary-700">{r.studentName}</Link><span className="min-w-0 flex-1 truncate text-foreground-700">{r.unitCode} {r.unitName}</span><Badge tone={r.outcome === "C" ? "success" : "warn"}>{OUTCOME_LABEL[r.outcome]}</Badge><span className="text-xs text-foreground-600">{r.signedName} ({r.signedRole}) · {fmtDateTime(r.signedAt)}{r.current ? "" : " · superseded"}</span></li>)}</ul>
      )}
      {attempt ? <AttemptDrawer attemptId={attempt} onClose={() => setAttempt(null)} /> : null}
    </div>
  );
}

function Bank() {
  const { push } = useToast();
  const [rows, setRows] = useState<BankRow[] | null>(null); const [q, setQ] = useState(""); const [error, setError] = useState("");
  const load = useCallback(() => asmAdmin<BankRow[]>("bank_list", { q: q || undefined }).then(setRows).catch((e) => setError(fail(e))), [q]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><TextInput className="max-w-xs" placeholder="Search title or tag" value={q} onChange={(e) => setQ(e.target.value)} /><span className="text-xs text-foreground-600">Questions are saved here from the builder ("Save to question bank") and inserted with "From bank". Every save is a new version.</span></div>
      {error ? <ErrorNote text={error} /> : null}
      {rows === null ? <SkeletonLines lines={4} /> : rows.length === 0 ? <Empty icon="ri-archive-line" title="The bank is empty" text="Select a question in any assessment's builder and choose Save to question bank." /> : (
        <ul className="divide-y divide-background-100 rounded-md border border-background-200">{rows.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"><span className="min-w-0 flex-1"><span className="block truncate font-medium text-foreground-900">{r.title}</span><span className="block text-xs text-foreground-600">{questionType(r.type)?.label ?? r.type} · v{r.versionNo} · {r.tags.join(", ")} · {fmtDateTime(r.updatedAt)}</span></span><Button size="sm" variant="ghost" icon="ri-archive-line" onClick={() => window.confirm("Archive this bank question?") && asmAdmin("bank_archive", { id: r.id }).then(() => { push("Archived."); void load(); }).catch((e) => setError(fail(e)))}>Archive</Button></li>)}</ul>
      )}
    </div>
  );
}

function AdminCalendar() {
  const [batches, setBatches] = useState<BatchOption[]>([]); const [batchId, setBatchId] = useState("");
  useEffect(() => { void asmAdmin<BatchOption[]>("batch_list").then(setBatches).catch(() => setBatches([])); }, []);
  return <div className="space-y-3"><Select className="w-auto" value={batchId} onChange={(e) => setBatchId(e.target.value)}><option value="">All batches (assessment events only)</option>{batches.map((b) => <option key={b.id} value={b.id}>{b.courseName} · {b.intake} · {b.name}</option>)}</Select><CalendarView batchId={batchId || null} /></div>;
}

function Reports() {
  const [batches, setBatches] = useState<BatchOption[]>([]); const [assessments, setAssessments] = useState<AssessmentRow[]>([]);
  const [kind, setKind] = useState<"cohort" | "assessment">("cohort"); const [batchId, setBatchId] = useState(""); const [assessmentId, setAssessmentId] = useState("");
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null); const [error, setError] = useState("");
  useEffect(() => { void asmAdmin<BatchOption[]>("batch_list", { includeInactive: true }).then(setBatches).catch(() => setBatches([])); void asmAdmin<AssessmentRow[]>("assessment_list", { includeArchived: true }).then(setAssessments).catch(() => setAssessments([])); }, []);
  const run = async () => { setError(""); try { setRows(await asmAdmin<Record<string, unknown>[]>("report", { kind, batchId: batchId || undefined, assessmentId: assessmentId || undefined })); } catch (e) { setError(fail(e)); } };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Report"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="cohort">Cohort: every student × assessment of a batch</option><option value="assessment">Assessment: per batch counts</option></Select></Field>
        {kind === "cohort" ? <Field label="Batch"><Select value={batchId} onChange={(e) => setBatchId(e.target.value)}><option value="">Choose…</option>{batches.map((b) => <option key={b.id} value={b.id}>{b.courseName} · {b.intake} · {b.name}</option>)}</Select></Field> : null}
        <Field label="Assessment"><Select value={assessmentId} onChange={(e) => setAssessmentId(e.target.value)}><option value="">{kind === "cohort" ? "All" : "Choose…"}</option>{assessments.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</Select></Field>
        <Button icon="ri-play-line" disabled={(kind === "cohort" && !batchId) || (kind === "assessment" && !assessmentId)} onClick={() => void run()}>Run</Button>
        {rows?.length ? <Button variant="outline" icon="ri-download-2-line" onClick={() => downloadCsv(`${kind}-report.csv`, rows)}>Export CSV</Button> : null}
      </div>
      {error ? <ErrorNote text={error} /> : null}
      {rows ? rows.length === 0 ? <p className="text-sm text-foreground-600">No rows.</p> : (
        <div className="overflow-x-auto rounded-md border border-background-200"><table className="min-w-full text-xs"><thead><tr className="bg-background-100">{Object.keys(rows[0]).map((k) => <th key={k} className="p-2 text-left font-medium text-foreground-700">{k}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i} className="border-t border-background-100">{Object.keys(rows[0]).map((k) => <td key={k} className="p-2 text-foreground-900">{r[k] === null || r[k] === undefined ? "" : typeof r[k] === "object" ? JSON.stringify(r[k]) : String(r[k])}</td>)}</tr>)}</tbody></table></div>
      ) : null}
    </div>
  );
}

function SettingsTab() {
  const { push } = useToast();
  const [s, setS] = useState<Settings | null>(null); const [error, setError] = useState("");
  useEffect(() => { void asmAdmin<Settings>("settings_get").then(setS).catch((e) => setError(fail(e))); }, []);
  if (error) return <ErrorNote text={error} />;
  if (!s) return <SkeletonLines lines={5} />;
  const save = async () => { try { setS(await asmAdmin<Settings>("settings_save", { maxAttempts: s.max_attempts, reassessmentDays: s.reassessment_days, lateSubmission: s.late_submission, rollupRule: s.rollup_rule, dueSoonDays: s.due_soon_days, requireTrainerRole: s.require_trainer_role, declarationText: s.declaration_text, instructions: s.instructions, evidenceMaxMb: s.evidence_max_mb, evidenceAllowedTypes: s.evidence_allowed_types })); push("Settings saved."); } catch (e) { setError(fail(e)); } };
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-foreground-700">Institution-wide rules; an assessment may override attempts, the reassessment window and the late rule. Attempt counts and windows are configuration, not a compliance ruling: confirm them against the Standards for RTOs.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Maximum attempts"><TextInput type="number" min={1} max={10} value={s.max_attempts} onChange={(e) => setS({ ...s, max_attempts: Number(e.target.value) })} /></Field>
        <Field label="Reassessment window (days)"><TextInput type="number" min={1} max={90} value={s.reassessment_days} onChange={(e) => setS({ ...s, reassessment_days: Number(e.target.value) })} /></Field>
        <Field label="Due-soon reminder (days before)"><TextInput type="number" min={1} max={30} value={s.due_soon_days} onChange={(e) => setS({ ...s, due_soon_days: Number(e.target.value) })} /></Field>
        <Field label="Late submissions"><Select value={s.late_submission} onChange={(e) => setS({ ...s, late_submission: e.target.value as Settings["late_submission"] })}><option value="allow">Allow (flagged as late)</option><option value="block">Block after the late date</option></Select></Field>
        <Field label="Task rollup suggestion"><Select value={s.rollup_rule} onChange={(e) => setS({ ...s, rollup_rule: e.target.value as Settings["rollup_rule"] })}><option value="all_satisfactory">All questions S → task S (suggestion only)</option><option value="assessor_only">No suggestion; the assessor decides</option></Select></Field>
        <Field label="Who may mark and sign off"><Select value={s.require_trainer_role ? "role" : "any"} onChange={(e) => setS({ ...s, require_trainer_role: e.target.value === "role" })}><option value="role">Batch trainers with the Trainer role, named assessors, admins</option><option value="any">Any active batch trainer, named assessors, admins</option></Select></Field>
        <Field label="Evidence file limit (MB)"><TextInput type="number" min={1} max={200} value={s.evidence_max_mb} onChange={(e) => setS({ ...s, evidence_max_mb: Number(e.target.value) })} /></Field>
      </div>
      <Field label="Student declaration (shown and signed at submission; its hash is kept with every submission)"><TextArea rows={4} value={s.declaration_text} onChange={(e) => setS({ ...s, declaration_text: e.target.value })} /></Field>
      <Field label="Instructions shown on every assessment"><TextArea rows={3} value={s.instructions} onChange={(e) => setS({ ...s, instructions: e.target.value })} /></Field>
      <Field label="Allowed evidence types (MIME, one per line)"><TextArea rows={4} value={s.evidence_allowed_types.join("\n")} onChange={(e) => setS({ ...s, evidence_allowed_types: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} /></Field>
      <Button icon="ri-save-line" onClick={() => void save()}>Save settings</Button>
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState<AuditRow[] | null>(null); const [error, setError] = useState("");
  useEffect(() => { void asmAdmin<AuditRow[]>("audit_list", { limit: 200 }).then(setRows).catch((e) => setError(fail(e))); }, []);
  if (error) return <ErrorNote text={error} />;
  if (!rows) return <SkeletonLines lines={6} />;
  return (
    <div className="space-y-2">
      <div className="flex justify-end"><Button size="sm" variant="outline" icon="ri-download-2-line" onClick={() => downloadCsv("assessment-audit.csv", rows.map((r) => ({ at: r.at, role: r.role, actor: r.actor, action: r.action, targetType: r.targetType, targetId: r.targetId, detail: r.detail })))}>Export CSV</Button></div>
      <ul className="divide-y divide-background-100 rounded-md border border-background-200 text-xs">{rows.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5"><span className="text-foreground-500">{fmtDateTime(r.at)}</span><Badge tone="muted">{r.role}</Badge><span className="font-medium text-foreground-900">{r.action}</span><span className="text-foreground-600">{r.targetType} {r.targetId.slice(0, 8)}</span><span className="min-w-0 flex-1 truncate text-foreground-500" title={JSON.stringify(r.detail)}>{JSON.stringify(r.detail)}</span></li>)}</ul>
    </div>
  );
}
