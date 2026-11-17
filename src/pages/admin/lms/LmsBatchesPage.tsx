import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { asmAdmin, type AssessmentRow, type AssignmentRow } from "@/pages/admin/lib/assessments";
import { fmtDate, fromLocalInput, toLocalInput } from "@/lib/assessment/api";
import StudentPicker from "@/pages/admin/components/rto/StudentPicker";
import UnitDocumentsPanel from "./UnitDocumentsPanel";
import { useToast } from "@/pages/admin/components/toastContext";
import BatchTimingDrawer from "@/pages/admin/components/rto/BatchTimingDrawer";
import { supabase } from "@/pages/admin/lib/supabase";
import { rto, rtoFlow, type BatchPageData, type BatchStudent, type RtoCourse, type RtoIntake, type CourseDetail, type IntakeDetail, type StaffOption } from "@/pages/admin/lib/rto";

/** One Batches screen: pick course > intake > batch, then manage its students, unit dates and unit trainers, batch trainers and
 * assessments. Backed by the existing RTO, CRM enrolment and HRMS trainer APIs (formerly two screens: Batches and Batch Allocation). */
const shortDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const unitCount = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;
/** One line on a rolling-batch student: where they joined or came from, where they continue, and when they finish. */
function pathNote(s: BatchStudent): string {
  const p = s.path;
  if (!p || s.status === "withdrawn" || (!p.carryOver && !p.skipped && !p.next && !p.owed)) return "";
  const parts: string[] = [];
  if (p.carryOver) parts.push(`Continuing${p.from ? ` from ${p.from.intake} · ${p.from.batch}` : ""}: ${unitCount(p.unitIds.length)} here from ${shortDate(s.enrolledOn)}`);
  else if (p.skipped) parts.push(`Joined at ${p.joinedAt ?? "a later unit"}: ${unitCount(p.unitIds.length)} here`);
  if (p.next) parts.push(`continues in ${p.next.intake} · ${p.next.batch} (${unitCount(p.next.units)}, from ${shortDate(p.next.startDate)})`);
  if (p.owed) parts.push(`${unitCount(p.owed)} waiting for the next intake`);
  else if (p.finishDate) parts.push(`finishes ${shortDate(p.finishDate)}`);
  return parts.join(" · ");
}

export default function LmsBatchesPage() {
  const { push } = useToast();
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [courseId, setCourseId] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [data, setData] = useState<BatchPageData | null>(null);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [picker, setPicker] = useState(false);
  const [courseSearch, setCourseSearch] = useState("");
  const [intakeSearch, setIntakeSearch] = useState("");
  const [batchSearch, setBatchSearch] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [tab, setTab] = useState<"students" | "units" | "trainers" | "assessments">("students");
  const [unitTrainers, setUnitTrainers] = useState<Record<string, string>>({});
  const [savingUnit, setSavingUnit] = useState("");
  const [rtoManager, setRtoManager] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<IntakeDetail | null>(null);
  const [assessmentOptions, setAssessmentOptions] = useState<AssessmentRow[]>([]);
  const [assessmentAssignments, setAssessmentAssignments] = useState<AssignmentRow[]>([]);
  const [assessmentId, setAssessmentId] = useState("");
  const [assessmentMode, setAssessmentMode] = useState<"existing" | "create">("create");
  const [createdDraft, setCreatedDraft] = useState<{ id: string; courseId: string } | null>(null);
  const [assessmentRefresh, setAssessmentRefresh] = useState(0);
  const [assessmentLoading, setAssessmentLoading] = useState(true);
  const [assessmentError, setAssessmentError] = useState("");
  const [newAssessmentTitle, setNewAssessmentTitle] = useState("");
  const [newAssessmentUnit, setNewAssessmentUnit] = useState("");
  const [courseUnits, setCourseUnits] = useState<CourseDetail["units"]>([]);
  const [assessmentFile, setAssessmentFile] = useState<File | null>(null);
  const [availableFrom, setAvailableFrom] = useState(toLocalInput(new Date().toISOString()));
  const [dueAt, setDueAt] = useState(toLocalInput(new Date(Date.now() + 14 * 86400000).toISOString()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list"), rto<{ rtoManager: boolean }>("me")])
      .then(([c, i, me]) => { if (active) { setCourses(c); setIntakes(i); setRtoManager(!!me.rtoManager); setCourseId(c[0]?.id ?? ""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load academic records"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const availableIntakes = useMemo(() => intakes.filter(i => i.courseId === courseId), [intakes, courseId]);
  useEffect(() => { setIntakeId(prev => availableIntakes.some(i => i.id === prev) ? prev : availableIntakes[0]?.id ?? ""); }, [availableIntakes]);
  const selectedIntake = availableIntakes.find(i => i.id === intakeId);
  const batches = useMemo(() => selectedIntake?.batchList ?? [], [selectedIntake]);
  useEffect(() => { setBatchId(prev => batches.some(b => b.id === prev) ? prev : batches[0]?.id ?? ""); }, [batches]);
  const load = useCallback(async () => {
    if (!batchId) { setData(null); return; }
    try { const result = await rtoFlow<BatchPageData>("batch_get", { batchId }); setData(result); setError(""); }
    catch (e) { setData(null); setError(e instanceof Error ? e.message : "Unable to load batch allocations"); }
  }, [batchId]);
  useEffect(() => { setData(null); void load(); }, [load]);
  useEffect(() => {
    setUnitTrainers({});
    if (tab !== "units" || !batchId) return;
    let active = true;
    supabase.rpc("rto_batch_unit_trainers_get", { p_batch_id: batchId }).then(({ data: rows, error: e }) => {
      if (active) { if (e) setError(e.message); else setUnitTrainers((rows ?? {}) as Record<string, string>); }
    });
    return () => { active = false; };
  }, [tab, batchId]);
  const reloadIntakes = async () => { try { setIntakes(await rto<RtoIntake[]>("intake_list")); } catch (e) { setError(e instanceof Error ? e.message : "Unable to reload intakes"); } };
  const setUnitTrainer = async (unitId: string, trainerId: string) => {
    if (!batchId) return;
    setSavingUnit(unitId); setError("");
    try {
      const { error: e } = await supabase.rpc("rto_batch_unit_trainer", { p_batch_id: batchId, p_intake_unit_id: unitId, p_staff_id: trainerId || null });
      if (e) throw e;
      setUnitTrainers(prev => ({ ...prev, [unitId]: trainerId }));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save trainer"); }
    finally { setSavingUnit(""); }
  };
  const saveUnitDates = async (unitId: string, startDate: string, endDate: string) => {
    if (!batchId || !startDate || !endDate || startDate > endDate) { setError("End date must be on or after start date."); return; }
    setSavingUnit(unitId); setError("");
    try { await rtoFlow("batch_override_set", { batchId, intakeUnitId: unitId, startDate, endDate }); await load(); push("Unit dates saved", "success"); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to save unit dates"); }
    finally { setSavingUnit(""); }
  };
  const createBatch = async () => {
    if (!intakeId || !newName.trim()) { setError("Enter a batch name."); return; }
    setBusy(true); setError("");
    try {
      const out = await rtoFlow<IntakeDetail & { batchId: string }>("batch_setup", { batchId: null, intakeId, name: newName.trim(), sessions: [] });
      setAdding(false); setNewName("");
      await reloadIntakes();
      setBatchId(out.batchId);
      push("Batch added", "success");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to create batch"); }
    finally { setBusy(false); }
  };
  const openEditor = async () => {
    if (!intakeId) return;
    try { setEditing(await rto<IntakeDetail>("intake_get", { intakeId })); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to open the batch editor"); }
  };
  useEffect(() => {
    if (tab !== "trainers" || !data?.rtoManager) return;
    let active = true;
    rto<StaffOption[]>("staff_list").then(s => { if (active) setStaff(s); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load trainers"); });
    return () => { active = false; };
  }, [tab, data?.rtoManager]);

  useEffect(() => {
    if (tab !== "assessments" || !courseId || !batchId) return;
    let active = true;
    setAssessmentLoading(true);
    Promise.all([
      asmAdmin<AssessmentRow[]>("assessment_list", { courseId, includeArchived: false }),
      asmAdmin<AssignmentRow[]>("assignment_list", { batchId }),
    ])
      .then(([a, x]) => { if (active) { setAssessmentOptions(a); setAssessmentAssignments(x); } })
      .catch(e => { if (active) setAssessmentError(e instanceof Error ? e.message : "Unable to load assessments"); })
      .finally(() => { if (active) setAssessmentLoading(false); });
    return () => { active = false; };
  }, [tab, courseId, batchId, assessmentRefresh]);
  useEffect(() => {
    let active = true;
    setCourseUnits([]);
    setNewAssessmentUnit("");
    setAssessmentId("");
    setAssessmentError("");
    if (courseId) rto<CourseDetail>("course_get", { courseId })
      .then(detail => { if (active) setCourseUnits(detail.units ?? []); })
      .catch(e => { if (active) setAssessmentError(e instanceof Error ? e.message : "Unable to load course units"); });
    return () => { active = false; };
  }, [courseId]);
  const publishedAssessments = assessmentOptions.filter(a => a.courseId === courseId && a.unitId === newAssessmentUnit && a.currentVersionStatus === "published" && !a.archivedAt);
  const refreshAssessments = () => {
    setAssessmentError("");
    setAssessmentRefresh(value => value + 1);
  };
  const createAssessment = async () => {
    const title = newAssessmentTitle.trim();
    if (!title || !courseUnits.some(unit => unit.id === newAssessmentUnit) || !assessmentFile || busy || !canEdit ||
        !current?.isActive || current.id !== batchId || data?.intake.courseId !== courseId) return;
    setAssessmentError("");
    setCreatedDraft(null);
    setBusy(true);
    try {
      const startsAt = fromLocalInput(availableFrom);
      const deadline = fromLocalInput(dueAt);
      if (!startsAt || !deadline || deadline <= startsAt) throw new Error("Due Date must be after Available From.");
      if (!assessmentFile.name.toLowerCase().endsWith(".json")) throw new Error("Choose a JSON assessment export. PDF, Word and other file types are unsupported.");
      let imported: unknown;
      try { imported = JSON.parse(await assessmentFile.text()); }
      catch { throw new Error("The selected file is not valid JSON."); }
      const template = imported as { definition?: { tasks?: unknown } } | null;
      if (!Array.isArray(template?.definition?.tasks)) {
        throw new Error("Choose a JSON export from the Assessments editor. The file must contain an assessment definition.");
      }
      const result = await asmAdmin<{ id?: string; ok?: boolean; errors?: { message: string }[] }>("assessment_create", {
        courseId, unitId: newAssessmentUnit, title, import: imported,
      });
      if (result.ok === false || !result.id) throw new Error(result.errors?.map(e => e.message).join(" ") || "Unable to create assessment");
      const id = result.id;
      setNewAssessmentTitle("");
      setAssessmentFile(null);
      const published = await asmAdmin<{ ok: boolean; errors?: { message: string }[] }>("version_publish", { assessmentId: id });
      if (!published.ok) {
        setCreatedDraft({ id, courseId });
        refreshAssessments();
        throw new Error("Uploaded as a draft but not published, so it was not assigned: " + (published.errors?.map(e => e.message).join(" ") ?? "") + " Open the draft to fix and publish it.");
      }
      const assigned = await asmAdmin<{ created: number; errors?: { message: string }[] }>("assignment_create", {
        assessmentId: id, batchIds: [batchId], availableFrom: startsAt, dueAt: deadline,
      });
      refreshAssessments();
      if (assigned.errors?.length || !assigned.created) throw new Error("Uploaded and published, but not assigned: " + (assigned.errors?.map(e => e.message).join(" ") || "check assessment eligibility.") + " Assign it under Select Existing Assessment.");
      push("Assessment uploaded and assigned to " + current.name, "success");
    } catch (e) { setAssessmentError(e instanceof Error ? e.message : "Unable to upload assessment"); }
    finally { setBusy(false); }
  };
  const assignAssessment = async () => {
    if (!publishedAssessments.some(a => a.id === assessmentId) || !current?.isActive || current.id !== batchId ||
        data?.intake.courseId !== courseId || !availableFrom || !dueAt || busy || !canEdit || assessmentLoading) return;
    setAssessmentError("");
    setBusy(true);
    try {
      const startsAt = fromLocalInput(availableFrom);
      const deadline = fromLocalInput(dueAt);
      if (!startsAt || !deadline || deadline <= startsAt) throw new Error("Due Date must be after Available From.");
      const result = await asmAdmin<{ created: number; errors?: { message: string }[] }>("assignment_create", {
        assessmentId, batchIds: [batchId], availableFrom: startsAt, dueAt: deadline,
      });
      if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join(" "));
      if (!result.created) throw new Error("No assignment created. Check assessment eligibility.");
      setAssessmentId("");
      refreshAssessments();
      push("Assessment assigned", "success");
    } catch (e) { setAssessmentError(e instanceof Error ? e.message : "Unable to assign assessment"); }
    finally { setBusy(false); }
  };
  const save = async (action: string, payload: Record<string, unknown>, success: string) => {
    setBusy(true);
    try { await rtoFlow(action, payload); await load(); push(success, "success"); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to save allocation"); }
    finally { setBusy(false); }
  };
  const current = data?.batch;
  const students = current?.students.filter(s => s.status === "active" || s.status === "deferred") ?? [];
  const canEnrol = !!data && (data.rtoManager || data.admin);
  const canEdit = !!data?.rtoManager;
  const inputClass = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
  const searchClass = "w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm";
  const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  const sectionHeading = "text-xs font-semibold uppercase tracking-wide text-foreground-500";
  const selectionClass = (selected: boolean) => "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors " + (selected ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100");
  const dot = (on: boolean, title: string) => <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (on ? "bg-green-500" : "bg-background-300")} title={title} />;
  const emptyRow = "px-3 py-2 text-xs text-foreground-500";
  const buttonClass = "rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50";
  const removeClass = "text-xs font-semibold text-red-700 hover:underline disabled:opacity-50";
  const assessmentSourceClass = (selected: boolean) => `inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-semibold transition ${selected ? "border-primary-500 bg-primary-50 text-primary-700" : "border-background-300 text-foreground-600 hover:bg-background-100"}`;
  const searchBox = (label: string, value: string, onChange: (v: string) => void) => <label className="relative block">
    <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
    <input aria-label={label} placeholder={label + "…"} className={searchClass} value={value} onChange={e => onChange(e.target.value)} />
  </label>;
  const dateFields = <>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-xs text-foreground-500">Available From<input type="datetime-local" className={inputClass + " mt-1 min-w-0 text-foreground-950"} value={availableFrom} onChange={e => setAvailableFrom(e.target.value)} /></label>
      <label className="block text-xs text-foreground-500">Due Date<input type="datetime-local" className={inputClass + " mt-1 min-w-0 text-foreground-950"} value={dueAt} onChange={e => setDueAt(e.target.value)} /></label>
    </div>
    <p className="text-xs text-foreground-500">Melbourne time.</p>
  </>;
  const batchAssessments = assessmentAssignments.filter(a => a.batchId === batchId && a.status !== "cancelled");
  const removeStudent = (s: BatchStudent) => {
    if (!window.confirm(`Remove ${s.name} from this batch?`)) return;
    void save("enrolment_set", { enrolmentId: s.enrolmentId, status: "withdrawn" }, "Student removed");
  };
  const visibleStudents = students.filter(s => (s.name + " " + s.email).toLowerCase().includes(studentSearch.toLowerCase()));
  const facts: [string, string][] = current ? [
    ["Intake", data?.intake.name ?? "—"],
    ["Students", current.capacity !== null ? `${students.length} / ${current.capacity}` : String(students.length)],
    ["Trainers", String(current.trainers.length)],
    ["Status", current.isActive ? "Active" : "Inactive"],
  ] : [];
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Batches</h1>
        <p className="text-sm text-foreground-500">Students, unit dates, trainers and assessments for each batch.</p>
      </div>
    </header>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={() => { setError(""); void load(); }}>Retry</button></div>}
    <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className={card + " space-y-4 p-3"}>
        <section aria-label="Course selection">
          {searchBox("Search courses", courseSearch, setCourseSearch)}
          <div className="mt-2 max-h-[40vh] space-y-1 overflow-auto">
            {loading ? <p className={emptyRow}>Loading…</p> : null}
            {courses.filter(c => c.label.toLowerCase().includes(courseSearch.toLowerCase())).map(c => <button key={c.id} type="button" aria-pressed={courseId === c.id} onClick={() => { setCourseId(c.id); setPicker(false); }} className={selectionClass(courseId === c.id)}>
              {dot(c.isActive, c.isActive ? "Active" : "Inactive")}
              <span className="min-w-0"><span className="block text-sm font-semibold text-foreground-950">{c.code}</span>
                <span className="block truncate text-xs text-foreground-600">{c.name}</span></span>
            </button>)}
          </div>
        </section>
        <section aria-label="Intake selection" className="border-t border-background-200 pt-3">
          <h2 className={sectionHeading + " mb-2 px-1"}>Intakes</h2>
          {searchBox("Search intakes", intakeSearch, setIntakeSearch)}
          <div className="mt-2 space-y-1">{availableIntakes.filter(i => i.name.toLowerCase().includes(intakeSearch.toLowerCase())).map(i => <button key={i.id} type="button" aria-pressed={intakeId === i.id} onClick={() => { setIntakeId(i.id); setPicker(false); }} className={selectionClass(intakeId === i.id)}>
            {dot(i.status === "open", i.status)}
            <span className="min-w-0 truncate text-sm font-semibold text-foreground-950">{i.name}</span>
          </button>)}</div>
          {!availableIntakes.length && <p className={emptyRow}>No intakes for this course.</p>}
        </section>
        <section aria-label="Batch selection" className="border-t border-background-200 pt-3">
          <div className="mb-2 flex items-center justify-between gap-2 px-1"><h2 className={sectionHeading}>Batches</h2>
            {rtoManager && intakeId && <button type="button" className="text-xs font-semibold text-primary-700 hover:underline" onClick={() => setAdding(true)}>+ Add</button>}</div>
          {adding && <div className="mb-2 space-y-2 rounded-lg bg-background-100 p-2">
            <label className="block text-xs text-foreground-500">New batch name<input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. G1" className={inputClass + " mt-1"} /></label>
            <div className="flex items-center gap-2"><button type="button" disabled={busy || !newName.trim()} onClick={() => void createBatch()} className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Add batch</button>
              <button type="button" className="text-xs font-semibold text-foreground-600 hover:underline" onClick={() => { setAdding(false); setNewName(""); }}>Cancel</button></div>
          </div>}
          {searchBox("Search batches", batchSearch, setBatchSearch)}
          <div className="mt-2 space-y-1">{batches.filter(b => b.name.toLowerCase().includes(batchSearch.toLowerCase())).map(b => <button key={b.id} type="button" aria-pressed={batchId === b.id} onClick={() => { setBatchId(b.id); setPicker(false); }} className={selectionClass(batchId === b.id)}>
            {dot(b.isActive, b.isActive ? "Active" : "Inactive")}
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground-950">{b.name}</span>
            <span className="text-xs text-foreground-500">{b.enrolled}{b.capacity !== null ? "/" + b.capacity : ""}</span>
          </button>)}</div>
          {!batches.length && <p className={emptyRow}>No batches for this intake.</p>}
        </section>
      </div>
      <section aria-label="Allocation workspace" className={card + " min-w-0 p-5"}>
        {loading ? <p className="py-10 text-center text-sm text-foreground-500">Loading…</p> : !batchId ? <p className="py-10 text-center text-sm text-foreground-500">Select a batch.</p> : !current || data?.batch.id !== batchId ? <p className="py-10 text-center text-sm text-foreground-500">Loading allocations…</p> : <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className={sectionHeading}>Batch</p>
              <h2 className="font-heading text-xl font-bold text-foreground-950">{current.name}</h2>
            </div>
            {canEdit && <button type="button" className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100" onClick={() => void openEditor()}>Edit batch timing</button>}
          </div>
          <dl className="mt-4 grid grid-cols-2 rounded-lg border border-background-200 sm:grid-cols-4 sm:divide-x sm:divide-background-200">
            {facts.map(([label, value]) => <div key={label} className="px-3 py-2">
              <dt className="text-xs text-foreground-500">{label}</dt><dd className="truncate text-sm font-semibold text-foreground-950">{value}</dd>
            </div>)}
          </dl>
          <div className="mt-5 flex gap-5 border-b border-background-200" role="tablist" aria-label="Allocation type">
            {(["students", "units", "trainers", "assessments"] as const).map(t => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={"-mb-px border-b-2 px-1 py-2 text-sm font-semibold " + (tab === t ? "border-primary-600 text-primary-700" : "border-transparent text-foreground-500 hover:text-foreground-800")}>{t === "students" ? `Students (${students.length})` : t === "units" ? `Units & dates (${current.schedule?.length ?? 0})` : t === "trainers" ? `Trainers (${current.trainers.length})` : "Assessments"}</button>)}
          </div>
          <div className="pt-4">
          {tab === "students" ? <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">{searchBox("Search assigned students", studentSearch, setStudentSearch)}</div>
              {canEnrol && current.isActive && <button type="button" className={buttonClass} disabled={busy || (current.capacity !== null && students.length >= current.capacity)} onClick={() => setPicker(true)}>Add students</button>}
            </div>
            {students.length ? <div className="mt-3 max-h-[520px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500"><th className="px-3 py-2">Student</th><th className="hidden px-3 py-2 sm:table-cell">Email</th>{canEnrol && <th className="px-3 py-2"><span className="sr-only">Actions</span></th>}</tr></thead>
                <tbody>{visibleStudents.map(s => <tr key={s.enrolmentId} className="border-b border-background-100 hover:bg-background-100">
                  <td className="px-3 py-2"><Link to={`/admin/students/${s.id}`} className="font-semibold text-primary-700 hover:underline">{s.name}</Link><span className="block truncate text-xs text-foreground-500 sm:hidden">{s.email}</span>{pathNote(s) && <span className="block text-xs text-foreground-600">{pathNote(s)}</span>}</td>
                  <td className="hidden max-w-[260px] truncate px-3 py-2 text-foreground-600 sm:table-cell">{s.email}</td>
                  {canEnrol && <td className="px-3 py-2"><div className="flex items-center justify-end gap-3">
                    <select aria-label={`Move ${s.name}`} className="rounded-lg border border-background-300 bg-background-50 px-2 py-1.5 text-xs" value="" disabled={busy} onChange={ev => { if (ev.target.value) void save("student_move", { enrolmentId: s.enrolmentId, toBatchId: ev.target.value }, "Student transferred"); }}><option value="">Move to…</option>{data.siblings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                    <button type="button" disabled={busy} onClick={() => removeStudent(s)} className={removeClass}>Remove</button>
                  </div></td>}
                </tr>)}</tbody>
              </table>
            </div> : <p className="py-10 text-center text-sm text-foreground-500">No students assigned yet.</p>}
          </> : tab === "units" ? <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">
                  <th className="px-3 py-2">Unit</th><th className="px-3 py-2">Start</th><th className="px-3 py-2">End</th><th className="px-3 py-2">Trainer</th><th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {(current.schedule ?? []).map(u => <UnitAllocationRow key={u.intakeUnitId} unit={u}
                    disabled={!canEdit || busy || !!savingUnit} saving={savingUnit === u.intakeUnitId}
                    trainers={current.trainers} trainerId={unitTrainers[u.intakeUnitId] ?? ""}
                    onTrainerChange={id => void setUnitTrainer(u.intakeUnitId, id)}
                    onSave={(start, end) => void saveUnitDates(u.intakeUnitId, start, end)} />)}
                </tbody>
              </table>
              {!(current.schedule ?? []).length && <p className="py-10 text-center text-sm text-foreground-500">No units in this intake.</p>}
            </div>
            <p className="mt-2 text-xs text-foreground-500">A unit's trainer is chosen from the batch trainers (Trainers tab).</p>
          </> : tab === "trainers" ? <>
            {canEdit && <select aria-label="Assign trainer" className={inputClass + " sm:max-w-sm"} value="" disabled={busy} onChange={ev => { const id = ev.target.value; if (id) void save("batch_trainers_set", { batchId, trainerIds: [...current.trainers.map(t => t.id), id] }, "Trainer assigned"); }}><option value="">Add trainer…</option>{staff.filter(t => !current.trainers.some(a => a.id === t.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
            <ul className="mt-3">{current.trainers.map(t => <li key={t.id} className="flex items-center justify-between gap-2 border-b border-background-100 px-3 py-2 text-sm hover:bg-background-100"><span className="font-semibold text-foreground-950">{t.name}</span>{canEdit && <button type="button" disabled={busy} className={removeClass} onClick={() => void save("batch_trainers_set", { batchId, trainerIds: current.trainers.filter(x => x.id !== t.id).map(x => x.id) }, "Trainer removed")}>Remove</button>}</li>)}</ul>
            {!current.trainers.length && <p className="py-10 text-center text-sm text-foreground-500">No trainers assigned yet.</p>}
          </> : <div className="space-y-6">
            <div className="space-y-4">
              <label className="block text-xs text-foreground-500">Course unit<select className={inputClass + " mt-1 text-foreground-950"} value={newAssessmentUnit} disabled={busy} onChange={e => { setNewAssessmentUnit(e.target.value); setAssessmentId(""); setAssessmentError(""); }}><option value="">Select unit</option>{courseUnits.filter(u => u.id).map(u => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}</select></label>
              {!newAssessmentUnit ? <p className="text-sm text-foreground-500">Select a unit to upload or assign an assessment.</p> : <>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Assessment source">
                <button type="button" aria-pressed={assessmentMode === "create"} className={assessmentSourceClass(assessmentMode === "create")} onClick={() => setAssessmentMode("create")}>
                  <i className="ri-upload-2-line mr-1.5" aria-hidden="true" />Upload New Assessment
                </button>
                <button type="button" aria-pressed={assessmentMode === "existing"} className={assessmentSourceClass(assessmentMode === "existing")} onClick={() => { setAssessmentMode("existing"); refreshAssessments(); }}>
                  <i className="ri-list-check mr-1.5" aria-hidden="true" />Select Existing Assessment
                </button>
              </div>
              {assessmentError && <p role="alert" className="break-words rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{assessmentError}</p>}
              {assessmentMode === "create" ? <div className="space-y-3">
                <fieldset disabled={busy || !canEdit} className="min-w-0 space-y-3">
                  <label className="block text-xs text-foreground-500">Assessment title<input className={inputClass + " mt-1 text-foreground-950"} value={newAssessmentTitle} onChange={e => setNewAssessmentTitle(e.target.value)} placeholder="e.g. A1 — Project" /></label>
                  <div>
                    <label htmlFor="batch-assessment-template" className="block text-xs text-foreground-500">Assessment template (JSON)</label>
                    <input id="batch-assessment-template" type="file" accept=".json,application/json" aria-describedby="batch-assessment-template-help" className={inputClass + " mt-1"} onChange={e => { setAssessmentError(""); setAssessmentFile(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ""; }} />
                    <p id="batch-assessment-template-help" className="mt-1 text-xs text-foreground-500">A JSON export from the Assessments editor. Other formats are unsupported.</p>
                    {assessmentFile && <p className="mt-1 break-all text-sm text-foreground-800" role="status"><i className="ri-file-line mr-1" aria-hidden="true" />{assessmentFile.name}</p>}
                  </div>
                  {dateFields}
                  <button type="button" className={buttonClass} disabled={!newAssessmentTitle.trim() || !newAssessmentUnit || !assessmentFile || !availableFrom || !dueAt || !current.isActive} onClick={() => void createAssessment()}>{busy ? "Uploading…" : "Upload & assign to " + current.name}</button>
                </fieldset>
                {createdDraft?.courseId === courseId ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <Link className="font-semibold underline" to={`/admin/assessments/${createdDraft.id}`} target="_blank" rel="noopener">Open draft to review and publish</Link>
                    <span> (new tab). After publishing, assign it with Select Existing Assessment.</span>
                  </div>
                ) : null}
              </div> : <>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block min-w-0 flex-1 text-xs text-foreground-500">Published assessment
                    <select className={inputClass + " mt-1 text-foreground-950"} value={assessmentId} disabled={assessmentLoading || busy} onChange={e => setAssessmentId(e.target.value)}>
                      <option value="">{assessmentLoading ? "Loading assessments…" : "Select assessment"}</option>
                      {publishedAssessments.map(a => <option key={a.id} value={a.id}>{a.unitCode ? a.unitCode + " — " : ""}{a.title}</option>)}
                    </select>
                  </label>
                  <button type="button" aria-label="Refresh published assessments" title="Refresh published assessments" className="rounded-lg border border-background-300 px-2.5 py-2 text-foreground-700 hover:bg-background-100 disabled:opacity-50" disabled={assessmentLoading || busy} onClick={refreshAssessments}><i className="ri-refresh-line" aria-hidden="true" /></button>
                </div>
                {!assessmentLoading && !assessmentError && !publishedAssessments.length && <p className="text-sm text-foreground-500">No published assessments for this unit. Use Upload New Assessment.</p>}
                <fieldset className="min-w-0 space-y-3" disabled={busy}>
                  {dateFields}
                  <button type="button" className={buttonClass} disabled={!canEdit || assessmentLoading || !publishedAssessments.some(a => a.id === assessmentId) || !availableFrom || !dueAt || !current.isActive} onClick={() => void assignAssessment()}>{busy ? "Assigning…" : "Assign assessment"}</button>
                </fieldset>
              </>}
              </>}
            </div>
            {newAssessmentUnit && <UnitDocumentsPanel batchId={batchId} batchName={current.name} unitId={newAssessmentUnit} students={students} disabled={busy || !current.isActive} />}
            <div>
              <h3 className={sectionHeading}>Assigned assessments</h3>
              {batchAssessments.length ? <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm">
                <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500"><th className="px-3 py-2">Assessment</th><th className="px-3 py-2">Unit</th><th className="px-3 py-2">Due</th><th className="px-3 py-2">Students</th><th className="px-3 py-2">Status</th></tr></thead>
                <tbody>{batchAssessments.map(a => <tr key={a.id} className="border-b border-background-100 hover:bg-background-100">
                  <td className="break-words px-3 py-2 font-semibold text-foreground-950">{a.assessmentTitle}</td>
                  <td className="px-3 py-2 text-foreground-600">{a.unitCode ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-foreground-600">{fmtDate(a.dueAt)}</td>
                  <td className="px-3 py-2 text-foreground-600">{a.eligibleCount}</td>
                  <td className="px-3 py-2"><span className="rounded-full bg-background-200 px-2 py-0.5 text-xs font-semibold text-foreground-600">{a.status}</span></td>
                </tr>)}</tbody>
              </table></div> : (assessmentLoading ? <p className="py-10 text-center text-sm text-foreground-500">Loading assigned assessments…</p> : !assessmentError && <p className="py-10 text-center text-sm text-foreground-500">No assessments assigned yet.</p>)}
            </div>
          </div>}
          </div>
        </>}
      </section>
    </div>
      {editing && canEdit && <BatchTimingDrawer key={`${intakeId}:${batchId}`} intake={editing.intake} batches={editing.batches}
        batch={editing.batches.find(b => b.id === batchId) ?? null}
        onClose={() => setEditing(null)}
        onSaved={out => { setEditing(null); setBatchId(out.batchId); void reloadIntakes(); void load(); push("Batch saved", "success"); }} />}
      {picker && data && current && <StudentPicker courseId={data.intake.courseId} batchId={batchId} rtoManager={canEdit}
        batches={[{ id: batchId, name: current.name, capacity: current.capacity, enrolled: students.length, studentIds: students.map(s => s.id) }]}
        onClose={() => setPicker(false)} onAdded={() => { setPicker(false); void load(); push("Students assigned", "success"); }} />}
  </div>;
}

function UnitAllocationRow({ unit, disabled, saving, trainers, trainerId, onTrainerChange, onSave }: {
  unit: { intakeUnitId: string; code: string; name: string; startDate: string; endDate: string };
  disabled: boolean; saving: boolean; trainers: { id: string; name: string }[]; trainerId: string; onTrainerChange: (id: string) => void; onSave: (start: string, end: string) => void;
}) {
  const [start, setStart] = useState(unit.startDate);
  const [end, setEnd] = useState(unit.endDate);
  useEffect(() => { setStart(unit.startDate); setEnd(unit.endDate); }, [unit.startDate, unit.endDate]);
  const changed = start !== unit.startDate || end !== unit.endDate;
  const field = "rounded-lg border border-background-300 bg-background-50 px-2 py-1.5 text-sm disabled:opacity-60";
  return <tr className="border-b border-background-100 align-middle hover:bg-background-100">
    <td className="max-w-[260px] px-3 py-2"><span className="block font-semibold text-foreground-950">{unit.code}</span><span className="block truncate text-xs text-foreground-600" title={unit.name}>{unit.name}</span></td>
    <td className="px-3 py-2"><label><span className="sr-only">Start date</span><input type="date" value={start} disabled={disabled} onChange={e => setStart(e.target.value)} className={field} /></label></td>
    <td className="px-3 py-2"><label><span className="sr-only">End date</span><input type="date" value={end} disabled={disabled} onChange={e => setEnd(e.target.value)} className={field} /></label></td>
    <td className="px-3 py-2">
      <select aria-label={`Trainer for ${unit.code}`} value={trainerId} disabled={disabled} onChange={e => onTrainerChange(e.target.value)} className={field + " min-w-[150px]"}>
        <option value="">Select trainer…</option>
        {trainers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </td>
    <td className="px-3 py-2 text-right">{changed && <button type="button" disabled={disabled || !start || !end || start > end} onClick={() => onSave(start, end)} className="whitespace-nowrap rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{saving ? "Saving…" : "Save dates"}</button>}</td>
  </tr>;
}
