import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Badge, Button, Field, Modal, PageHeader, SectionTabs, Select, StatCard, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { Empty, SkeletonLines } from "@/pages/admin/components/rto/overlay";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import CalendarView from "@/components/assessment/CalendarView";
import ProgressList, { type Progress } from "@/components/assessment/ProgressList";
import { fmtDateTime, OUTCOME_LABEL, STATE_LABEL } from "@/lib/assessment/api";
import { asmAdmin, downloadCsv, type AssessmentRow, type AuditRow, type BankRow, type BatchOption, type OutcomeRow, type Overview, type Settings, attemptsRange } from "@/pages/admin/lib/assessments";
import { rto, type CourseDetail, type RtoCourse } from "@/pages/admin/lib/rto";
import AttemptDrawer from "./panels/AttemptDrawer";
import NewAssessmentDialog from "./NewAssessmentDialog";
import SearchableSelect from "@/components/ui/SearchableSelect";

const TABS = [
  { id: "library", label: "Library", icon: "ri-book-2-line" }, { id: "submissions", label: "Submissions", icon: "ri-inbox-line" }, { id: "outcomes", label: "Outcomes", icon: "ri-award-line" },
  { id: "calendar", label: "Calendar", icon: "ri-calendar-2-line" }, { id: "reports", label: "Reports", icon: "ri-bar-chart-2-line" },
  { id: "settings", label: "Settings", icon: "ri-settings-3-line" }, { id: "audit", label: "Audit", icon: "ri-history-line" },
];
const fail = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Master Data › Assessments: the library, the submissions overview, outcomes, the calendar, reports, settings and the audit log. */
export default function AssessmentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "library";
  const [me, setMe] = useState<{ assessmentAdmin: boolean } | null>(null);
  useEffect(() => { void asmAdmin<{ assessmentAdmin: boolean }>("me").then(setMe).catch(() => setMe({ assessmentAdmin: false })); }, []);
  return (
    <div>
      <PageHeader breadcrumb="Master Data" title="Assessments" description="Each assessment is its unit's workbook PDF: students answer on it, trainers mark on it, and the stamped workbook is the record." />
      {me && !me.assessmentAdmin ? <ErrorNote text="Only an Admin or an RTO Manager can manage assessments." /> : null}
      <SectionTabs tabs={TABS} active={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === "library" ? <Library /> : null}
      {tab === "submissions" ? <Submissions /> : null}
      {tab === "outcomes" ? <Outcomes /> : null}
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
        <Select className="w-auto min-w-[16rem]" aria-label="Course" data-testid="library-course-filter" noMatchText="No courses match" value={courseId} onChange={(e) => setCourseId(e.target.value)}><option value="">All courses</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
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
      {creating ? <NewAssessmentDialog courses={courses} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); navigate(`/admin/assessments/${id}?tab=pdf`); }} /> : null}
    </div>
  );
}

export function Submissions() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState<string | null>(null);
  const [batches, setBatches] = useState<BatchOption[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [unitCode, setUnitCode] = useState("");
  const [assessment, setAssessment] = useState("");
  const [studentQuery, setStudentQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState(["", ""]);
  const [page, setPage] = useState(1);
  // An intake is the class group: its id is the id the API still calls batchId.
  const batchId = intakeId;
  const load = useCallback(() => asmAdmin<Overview>("overview", { batchId: batchId || undefined }).then(v => { setOv(v); setError(""); }).catch((e) => setError(fail(e))), [batchId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void asmAdmin<BatchOption[]>("batch_list", { includeInactive: true }).then(setBatches).catch(e => setError(fail(e))); }, []);
  const courses = useMemo(() => Array.from(new Map(batches.map(b => [b.courseId, { id: b.courseId, name: b.courseName }])).values()), [batches]);
  const intakes = useMemo(() => Array.from(new Map(batches.filter(b => b.courseId === courseId).map(b => [b.intakeId, { id: b.intakeId, name: b.intake }])).values()), [batches, courseId]);
  useEffect(() => { setCourseId(old => courses.some(c => c.id === old) ? old : courses[0]?.id ?? ""); }, [courses]);
  useEffect(() => { setIntakeId(old => intakes.some(i => i.id === old) ? old : intakes[0]?.id ?? ""); }, [intakes]);
  const pending = ov?.pendingMarking ?? [];
  const units = Array.from(new Set(pending.map(p => p.unitCode).filter((x): x is string => !!x)));
  const assessmentTitles = Array.from(new Set(pending.filter(p => !unitCode || p.unitCode === unitCode).map(p => p.assessmentTitle)));
  const filtered = pending.filter(p => (!unitCode || p.unitCode === unitCode) && (!assessment || p.assessmentTitle === assessment) && (statusFilter === "all" || p.state === statusFilter) && (p.studentName + " " + p.assessmentTitle).toLowerCase().includes(studentQuery.toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 8));
  const visible = filtered.slice((Math.min(page,pageCount)-1)*8,Math.min(page,pageCount)*8);
  useEffect(() => { setPage(1); }, [batchId, unitCode, assessment, studentQuery, statusFilter]);
  const panel = "min-w-0 rounded-xl border border-background-200 bg-background-50 p-3";
  const input = "w-full rounded-lg border border-background-300 bg-background-50 p-2 text-sm";
  const option = (selected: boolean) => `w-full rounded-lg border px-3 py-3 text-left text-sm ${selected ? "border-primary-500 bg-primary-50 font-semibold" : "border-background-200 hover:bg-background-100"}`;
  return <div className="space-y-4">
    {error ? <ErrorNote text={error} /> : null}
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(170px,1fr)_minmax(170px,0.9fr)_minmax(420px,2.6fr)]">
      <section className={panel}><h3 className="mb-3 font-semibold">1. Course</h3>
        <input aria-label="Search courses" placeholder="Search courses…" className={input+" mb-3"} value={search[0]} onChange={e=>setSearch(v=>[e.target.value,v[1]])}/>
        <div className="space-y-2">{courses.filter(c=>c.name.toLowerCase().includes(search[0].toLowerCase())).map(c=><button type="button" key={c.id} className={option(courseId===c.id)} onClick={()=>setCourseId(c.id)}>{c.name}</button>)}</div>
      </section>
      <section className={panel}><h3 className="mb-3 font-semibold">2. Intake</h3>
        <input aria-label="Search intakes" placeholder="Search intakes…" className={input+" mb-3"} value={search[1]} onChange={e=>setSearch(v=>[v[0],e.target.value])}/>
        <div className="space-y-2">{intakes.filter(i=>i.name.toLowerCase().includes(search[1].toLowerCase())).map(i=><button type="button" key={i.id} className={option(intakeId===i.id)} onClick={()=>setIntakeId(i.id)}>{i.name}</button>)}</div>
      </section>
      <section className={panel}>
        <h3 className="mb-3 font-semibold">3. Submissions</h3>
        {!batchId?<p className="text-sm text-foreground-500">Select an intake to view submissions.</p>:<>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs font-semibold">Unit<SearchableSelect className={input+" mt-1"} value={unitCode} onChange={e=>{setUnitCode(e.target.value);setAssessment("");}}><option value="">All units with pending marking</option>{units.map(u=><option key={u} value={u}>{u}</option>)}</SearchableSelect></label>
            <label className="text-xs font-semibold">Assessment<SearchableSelect className={input+" mt-1"} value={assessment} onChange={e=>setAssessment(e.target.value)}><option value="">All assessments</option>{assessmentTitles.map(t=><option key={t} value={t}>{t}</option>)}</SearchableSelect></label>
          </div>
          {ov?<div className="my-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[[ov.eligible,"Eligible"],[ov.submitted,"Submitted"],[ov.notStarted+ov.draft,"Not started / Draft"],[ov.overdue,"Overdue"]].map(([value,label])=><div key={label} className="rounded-lg border border-background-200 p-3"><p className="text-xl font-bold">{value}</p><p className="text-xs text-foreground-600">{label}</p></div>)}
          </div>:<SkeletonLines lines={2}/>}
          <p className="mb-3 text-xs text-foreground-500">The table shows submissions awaiting marking. Full submission history remains in the existing assessment workflow.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input aria-label="Search student submissions" placeholder="Search student…" className={input} value={studentQuery} onChange={e=>setStudentQuery(e.target.value)}/>
            <SearchableSelect aria-label="Submission status" className={input} value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="all">All pending states</option><option value="submitted">Submitted</option><option value="marking">Marking</option></SearchableSelect>
          </div>
          <div className="mt-3 overflow-x-auto rounded-lg border border-background-200">
            <table className="w-full min-w-[460px] text-left text-sm"><thead className="bg-background-100 text-xs"><tr><th className="p-2">Student</th><th className="p-2">Assessment</th><th className="p-2">Attempt</th><th className="p-2">Status</th><th className="p-2">Action</th></tr></thead><tbody className="divide-y divide-background-100">{visible.map(p=><tr key={p.attemptId}><td className="p-2 font-medium">{p.studentName}</td><td className="p-2">{p.assessmentTitle}<p className="text-xs text-foreground-500">{p.unitCode||""}</p></td><td className="p-2">{p.attemptNo}</td><td className="p-2"><Badge tone={p.state==="marking"?"accent":"warn"}>{STATE_LABEL[p.state]??p.state}</Badge></td><td className="p-2"><button type="button" className="font-semibold text-primary-600 underline" onClick={()=>setAttempt(p.attemptId)}>Review</button></td></tr>)}</tbody></table>
            {!visible.length&&<p className="p-4 text-sm text-foreground-500">No submissions waiting for marking.</p>}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs"><span>Showing {visible.length} of {filtered.length} pending submissions</span><div className="flex gap-2"><button type="button" disabled={page<=1} className="rounded border px-2 py-1 disabled:opacity-40" onClick={()=>setPage(v=>v-1)}>Previous</button><span className="py-1">{Math.min(page,pageCount)} / {pageCount}</span><button type="button" disabled={page>=pageCount} className="rounded border px-2 py-1 disabled:opacity-40" onClick={()=>setPage(v=>v+1)}>Next</button></div></div>
          <div className="mt-4"><ReassessmentRequests onChanged={()=>void load()}/></div>
        </>}
      </section>
    </div>
    {attempt?<AttemptDrawer attemptId={attempt} onClose={()=>setAttempt(null)} onChanged={()=>void load()}/>:null}
  </div>;
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

function AdminCalendar() {
  const [batches, setBatches] = useState<BatchOption[]>([]); const [batchId, setBatchId] = useState("");
  useEffect(() => { void asmAdmin<BatchOption[]>("batch_list").then(setBatches).catch(() => setBatches([])); }, []);
  return <div className="space-y-3"><Select className="w-auto" value={batchId} onChange={(e) => setBatchId(e.target.value)}><option value="">All intakes (assessment events only)</option>{batches.map((b) => <option key={b.id} value={b.id}>{b.courseName} · {b.name}</option>)}</Select><CalendarView batchId={batchId || null} /></div>;
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
        <Field label="Report"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="cohort">Cohort: every student × assessment of an intake</option><option value="assessment">Assessment: counts per intake</option></Select></Field>
        {kind === "cohort" ? <Field label="Intake"><Select value={batchId} onChange={(e) => setBatchId(e.target.value)}><option value="">Choose…</option>{batches.map((b) => <option key={b.id} value={b.id}>{b.courseName} · {b.name}</option>)}</Select></Field> : null}
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
  const save = async () => { try { setS(await asmAdmin<Settings>("settings_save", { instructions: s.instructions })); push("Settings saved."); } catch (e) { setError(fail(e)); } };
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-foreground-700">Institution-wide rules; an assessment may override attempts, the reassessment window and the late rule. Attempt counts and windows are configuration, not a compliance ruling: confirm them against the Standards for RTOs.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Maximum attempts"><TextInput type="number" readOnly disabled min={attemptsRange().minimum} max={attemptsRange().maximum} value={s.max_attempts} /></Field>
        <Field label="Reassessment window (days)"><TextInput type="number" readOnly disabled value={s.reassessment_days} /></Field>
        <Field label="Due-soon reminder (days before)"><TextInput type="number" readOnly disabled value={s.due_soon_days} /></Field>
        <Field label="Late submissions"><Select value={s.late_submission} disabled onChange={() => undefined}><option value="allow">Allow (flagged as late)</option><option value="block">Block after the late date</option></Select></Field>
        <Field label="Task rollup suggestion"><Select value={s.rollup_rule} disabled onChange={() => undefined}><option value="all_satisfactory">All questions S → task S (suggestion only)</option><option value="assessor_only">No suggestion; the assessor decides</option></Select></Field>
        <Field label="Who may mark and sign off"><Select value={s.require_trainer_role ? "role" : "any"} disabled onChange={() => undefined}><option value="role">Intake trainers with the Trainer role, named assessors, admins</option><option value="any">Any active intake trainer, named assessors, admins</option></Select></Field>
        <Field label="Evidence file limit (MB)"><TextInput type="number" readOnly disabled value={s.evidence_max_mb} /></Field>
      </div>
      <p className="text-xs text-foreground-600"><i className="ri-lock-line mr-1" aria-hidden="true" />Maximum attempts, reassessment window, due-soon reminder, late submissions, task rollup, who may mark, the student declaration, the evidence file limit and the allowed evidence types: set in <Link className="underline" to="/admin/business-rules">Administration › Business Rules</Link>.</p>
      <Field label="Student declaration (shown and signed at submission; its hash is kept with every submission)"><TextArea rows={4} readOnly disabled value={s.declaration_text} /></Field>
      <Field label="Instructions shown on every assessment"><TextArea rows={3} value={s.instructions} onChange={(e) => setS({ ...s, instructions: e.target.value })} /></Field>
      <Field label="Allowed evidence types (MIME, one per line)"><TextArea rows={4} readOnly disabled value={s.evidence_allowed_types.join("\n")} /></Field>
      <Button icon="ri-save-line" onClick={() => void save()}>Save instructions</Button>
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
