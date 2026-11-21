import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ListPane from "@/pages/admin/components/ListPane";
import { paneGrid, useListPane, type Pane } from "@/pages/admin/lib/listPane";
import { courseWeeksLabel, generateClassSessions, HOURS_PER_WEEK, intakeDefaultName, registeredWeeks, loadIntakeLoads, loadUnitHours, rto, rtoFlow, setIntakeLoad, shownHours, type CourseDetail, type IntakeDetail, type RtoCourse, type StudyLoad, type UnitHours } from "@/pages/admin/lib/rto";
import TrainingGovCourseImport, { SavedTrainingGovDetails } from "./TrainingGovCourseImport";
import { CourseFacts } from "@/pages/admin/components/rto/CourseSteps";
import { supabase } from "@/pages/admin/lib/supabase";
import { DangerDialog } from "@/pages/admin/components/ui";
import { invokeTga } from "@/pages/admin/lib/tga";
import CricosCourseSection from "@/pages/admin/components/rto/CricosCourseSection";
import TrainingGovBulkSync from "@/pages/admin/components/rto/TrainingGovBulkSync";
import LmsUnitsPage from "./LmsUnitsPage";
import UnitHoursEditor from "./UnitHoursEditor";
import StartDateBreaksEditor from "./StartDateBreaksEditor";
import MasterTimetableTab from "./MasterTimetableTab";
import AddUnitsFromTga from "./AddUnitsFromTga";
import VoeCalendarEditor, { VoeTab } from "./VoeCalendarEditor";
import WeeklyClassBookingDialog, { type DraftWeek } from "@/pages/admin/components/rto/WeeklyClassBooking";
import { useNavigate, useSearchParams } from "react-router-dom";
import { loadCricos, lookupCricos, saveCricos } from "@/pages/admin/lib/cricos";

type Tab = "overview" | "units" | "master" | "voe" | "prereq" | "coeDaily" | "voeDaily";
const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const icon = (name: string) => <i className={name + " text-xl text-primary-600"} aria-hidden="true" />;

interface SyncResult {
  code: string; filled: string[]; unitsUpdated: number; hoursFilled: number; unitsMatched: number; unitCount: number;
  failedSources: string[];
  coreAdded?: number; electivesAdded?: number; detailsSynced?: number; detailsFailed?: number; elementsAdded?: number; columnsMissing?: boolean;
  cricos: { registered: boolean; providerCode: string; courseCode: string | null } | null;
}
function describeSync(r: SyncResult) {
  const lines = [`Synced ${r.code} with Training.gov.au.`];
  lines.push(r.filled.length ? "Filled: " + r.filled.join(", ") + "." : "No empty course fields needed filling.");
  lines.push(`Units: ${r.unitsMatched} of ${r.unitCount} found in the release, ${r.unitsUpdated} refreshed (prerequisites, usage, groups)` +
    (r.hoursFilled ? `, ${r.hoursFilled} given nominal hours.` : "; units that already had nominal hours were left as they are."));
  const added = (r.coreAdded ?? 0) + (r.electivesAdded ?? 0);
  if (added) lines.push(`Added ${added} missing core unit${added === 1 ? "" : "s"}. Choose electives with Units › Add Unit.`);
  if (r.detailsSynced || r.elementsAdded) lines.push(`Unit content: details refreshed for ${r.detailsSynced ?? 0} active units; elements, criteria and evidence added for ${r.elementsAdded ?? 0}.`);
  if (r.detailsFailed) lines.push(`${r.detailsFailed} units could not be read from training.gov.au; run Sync again later.`);
  if (r.columnsMissing) lines.push("Unit release and application details need the database update (migration 20261115140000).");
  // CRICOS is reported on its own line (see fillCricos), never as a failed source.
  const failed = r.failedSources.filter(source => !source.startsWith("CRICOS"));
  if (failed.length) lines.push("Not reachable: " + failed.join("; "));
  return lines;
}

/** After a sync: fill the CRICOS register entry when the qualification is registered and the course has none yet. */
async function fillCricos(courseId: string, r: SyncResult): Promise<string> {
  if (!r.cricos) return "CRICOS: not checked (set the CRICOS provider code in Settings, or the register did not respond).";
  if (!r.cricos.registered || !r.cricos.courseCode) {
    return `CRICOS: ${r.code} is not registered on CRICOS for provider ${r.cricos.providerCode}, so there is no CRICOS code to fill.`;
  }
  const code = r.cricos.courseCode;
  try {
    const current = await loadCricos(courseId);
    if (current.fetchedAt || current.fields.cricos_course_code) {
      return `CRICOS: registered as ${code}. The course already has CRICOS details; use Edit › Fetch from CRICOS to compare and update them.`;
    }
    const lookup = await lookupCricos(code);
    await saveCricos(courseId, { fields: lookup.fields, locations: lookup.locations, snapshot: lookup.snapshot, fetchedAt: lookup.fetched_at, edited: [] });
    const weeks = lookup.fields.cricos_duration_weeks;
    const detail = await rto<CourseDetail>("course_get", { courseId });
    if (!detail.course.duration?.trim() && typeof weeks === "number") await rto("course_save", { courseId, duration: `${weeks} weeks` });
    return `CRICOS: filled from ${code} (fees, duration, institution, locations).` + (lookup.warnings.length ? " " + lookup.warnings.join(" ") : "");
  } catch (e) {
    return `CRICOS: registered as ${code}, but it could not be filled automatically (${e instanceof Error ? e.message : "error"}). Use Edit › Fetch from CRICOS.`;
  }
}

/** LMS course information workspace. Reads authoritative course records only; children manage their own records. */
export default function LmsCoursesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [addingCourse, setAddingCourse] = useState<null | "tga">(null);
  const [selectedId, setSelectedId] = useState("");
  const savedPane = useListPane("courses");
  // The Master timetable is a wide table: on that tab the course list is folded unless it is opened there.
  const [masterList, setMasterList] = useState(false);
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  /** Whether the selected course's master timetable (wizard step 4) is saved; null while unknown. */
  const [masterSaved, setMasterSaved] = useState<boolean | null>(null);
  // Whether the course's VoE weekly calendar is saved (null: not read yet, or not available on this database).
  const [voeSaved, setVoeSaved] = useState<boolean | null>(null);
  const [unitHours, setUnitHours] = useState<Record<string, UnitHours>>({});
  const [query, setQuery] = useState("");
  const [campus, setCampus] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [editing, setEditing] = useState(false);
  const [bulkSync, setBulkSync] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  // New course wizard: 1 course (Add course / Sync), 2 units in the Add units popup (packaging rules met), 3 the units' SLIT
  // hours (required), 4 the master timetable (start date and term breaks: every unit's dates are calculated), 5 its first
  // intake with its class timetable (the week grid, room and trainer). Students are added only through the enrolment wizard.
  // A step closed with X stays waiting (hidden): "Continue setup" on the unfinished course opens it again.
  const [wizard, setWizard] = useState<{ courseId: string; step: "units" | "hours" | "master" | "voe" | "classes"; intakeId?: string; startDate?: string; hidden?: boolean; load?: StudyLoad } | null>(null);
  const navigate = useNavigate();
  // Step 4 to 5 (owner, 2026-11-20: no intake screen): the intake is made by itself on the master timetable's dates, named
  // "Intake N", CoE (changed to VoE in the timetable form), and the weekly timetable opens. Without a saved master the old
  // intake form opens instead.
  // CoE / VoE, chosen first on step 4 and kept for the course's wizard (saved on the intake when it is made).
  const [wizardLoad, setWizardLoad] = useState<{ courseId: string; load: StudyLoad } | null>(null);
  const loadFor = (courseId: string) => (wizardLoad?.courseId === courseId ? wizardLoad.load : null);
  // The intake's name, typed on step 4 (null: the default from CoE / VoE and the start date).
  const [wizardName, setWizardName] = useState<{ courseId: string; name: string | null } | null>(null);
  const nameFor = (courseId: string) => (wizardName?.courseId === courseId ? wizardName.name?.trim() || null : null);
  useEffect(() => {
    if (wizard?.step !== "master" || loadFor(wizard.courseId)) return;
    const courseId = wizard.courseId;
    let live = true;
    void loadIntakeLoads(courseId).then(m => {
      const first = Object.values(m)[0];
      if (live && first) setWizardLoad(w => (w?.courseId === courseId ? w : { courseId, load: first }));
    }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per step 4 of a course
  }, [wizard?.step, wizard?.courseId]);
  // One-time create (owner, 2026-11-21): NO database drafts. The CoE and VoE intakes do not exist during the wizard: the two daily timetables are kept
  // here in the browser and Finish creates both intakes on the master timetable's start date, books their classes and opens them together.
  const [drafts, setDrafts] = useState<{ courseId: string; coe?: DraftWeek; voe?: DraftWeek } | null>(null);
  const [finishing, setFinishing] = useState(false);
  /** Daily timetable of one kind: an existing intake of that kind opens as before (editing); otherwise the draft screen opens. */
  const openClasses = async (courseId: string, load: StudyLoad) => {
    try {
      if (!await acquireLock(courseId)) return; // another manager's wizard session holds the course
      const [course, loads] = await Promise.all([rto<CourseDetail>("course_get", { courseId }), loadIntakeLoads(courseId).catch(() => ({} as Record<string, StudyLoad>))]);
      const open = course.intakes.find(i => i.status !== "closed" && (loads[i.id] ?? "coe") === load);
      if (open) { setWizard({ courseId, step: "classes", intakeId: open.id, load }); return; }
      const { data } = await supabase.rpc("rto_master_timetable", { p_action: "get", p_data: { courseId } });
      const master = data as { saved?: boolean; startDate?: string | null } | null;
      if (!master?.saved || !master.startDate) { setTab("master"); setWizard({ courseId, step: "master" }); return; }
      setWizard({ courseId, step: "classes", startDate: master.startDate, load });
    } catch (e) { setDetailError(e instanceof Error ? e.message : "The intake could not be read."); }
  };
  /** Finish: both intakes are created now, each with its booked week and dated classes; nothing is left behind if a step fails. */
  const finishWizard = async (courseId: string, startDate: string, weeks: { coe?: DraftWeek; voe?: DraftWeek }) => {
    if (finishing) return;
    setFinishing(true);
    const discard = () => supabase.rpc("rto_intake_wizard", { p_action: "discard", p_data: { courseId } });
    try {
      await discard();
      const course = await rto<CourseDetail>("course_get", { courseId });
      const names = course.intakes.map(i => i.customName || i.name);
      let firstId = "";
      for (const load of ["coe", "voe"] as const) {
        const week = weeks[load];
        if (!week) continue;
        const name = intakeDefaultName(course.course.code, load, startDate, names);
        names.push(name);
        const out = await rto<IntakeDetail>("intake_save", { courseId, startDate, status: "open", generate: true, wizard: true, campus: course.course.campus ?? "", name });
        if (load === "voe") await setIntakeLoad(out.intake.id, "voe");
        const setup = await rtoFlow<IntakeDetail & { batchId: string }>("batch_setup", { batchId: null, intakeId: out.intake.id, sessions: week.sessions, capacity: week.capacity, trainerIds: week.trainerIds });
        await generateClassSessions(setup.batchId);
        if (!firstId) firstId = out.intake.id;
      }
      await supabase.rpc("rto_intake_wizard", { p_action: "finish", p_data: { courseId } });
      await releaseLock();
      setDrafts(null); setWizard(null); setReloadKey(k => k + 1);
      if (firstId) navigate(`/admin/lms/intakes#${firstId}`);
    } catch (e) {
      await discard();
      // Shown inside the timetable screen (it is open), which stays so the week can be changed.
      throw new Error(`The intakes were not created: ${e instanceof Error ? e.message : "error"} Change the timetable and finish again; nothing was saved.`);
    } finally { setFinishing(false); setReloadKey(k => k + 1); }
  };
  // Wizard lock: only one manager runs a course's wizard at a time (20261121180000). The page acquires the lock when the
  // wizard opens, pings while it is open and releases it on Finish or when the page closes; a crashed page stops pinging
  // and the lock goes stale after lms.wizard_lock_minutes (15), so another manager can take over.
  const lockRef = useRef<string | null>(null);
  const [lockHeld, setLockHeld] = useState<{ by: string; since: string } | null>(null);
  const acquireLock = async (courseId: string): Promise<boolean> => {
    const { data, error } = await supabase.rpc("rto_wizard_session", { p_action: "acquire", p_data: { courseId } });
    if (error) return true; // the lock function is not on this database yet: the wizard still opens
    const d = data as { ok?: boolean; lockedBy?: string; since?: string } | null;
    if (d?.ok) { lockRef.current = courseId; setLockHeld(null); return true; }
    setLockHeld({ by: d?.lockedBy ?? "another manager", since: d?.since ?? "" });
    return false;
  };
  const releaseLock = async () => {
    const courseId = lockRef.current;
    lockRef.current = null;
    if (courseId) await supabase.rpc("rto_wizard_session", { p_action: "release", p_data: { courseId } }).then(() => undefined, () => undefined);
  };
  useEffect(() => {
    if (!wizard || wizard.hidden) return;
    const courseId = wizard.courseId;
    const t = window.setInterval(() => { void supabase.rpc("rto_wizard_session", { p_action: "ping", p_data: { courseId } }).then(() => undefined, () => undefined); }, 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ping for as long as this wizard screen is open
  }, [wizard?.courseId, wizard?.hidden]);
  // Leaving the page with the wizard open releases the lock (the drafts stay; the wizard resumes from Continue setup).
  useEffect(() => () => { void releaseLock(); }, []);

  // Only the latest load picks the course: an older one finishing later must not switch back (it hid the wizard after Sync).
  const loadSeq = useRef(0);
  const load = useCallback(async (courseId?: string) => {
    const mine = ++loadSeq.current;
    setLoading(true);
    try {
      const [cs, me] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        rto<{rtoManager:boolean}>("me"),
      ]);
      if (mine !== loadSeq.current) return;
      setCourses(cs); setCanEdit(me.rtoManager); setError("");
      setSelectedId(previous => {
        const preferred = courseId ?? previous;
        return cs.some(c => c.id === preferred) ? preferred : (cs[0]?.id ?? "");
      });
    } catch (e) { if (mine === loadSeq.current) setError(e instanceof Error ? e.message : "Could not load courses."); }
    finally { if (mine === loadSeq.current) setLoading(false); }
  }, []);
  const [params, setParams] = useSearchParams();
  useEffect(() => { void load(params.get("course") ?? undefined); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setMasterSaved(null);
    if (!selectedId) return;
    let live = true;
    void supabase.rpc("rto_master_timetable", { p_action: "get", p_data: { courseId: selectedId } })
      .then(({ data }) => { if (live) setMasterSaved(!!(data as { saved?: boolean } | null)?.saved); });
    setVoeSaved(null);
    void supabase.rpc("rto_voe_calendar", { p_action: "get", p_data: { courseId: selectedId } })
      .then(({ data, error }) => { if (live && !error) setVoeSaved(!!(data as { saved?: boolean } | null)?.saved); });
    return () => { live = false; };
  }, [selectedId, reloadKey]);
  // A link such as the dashboard's "Open master timetable" names the course and the tab.
  useEffect(() => {
    const wanted = params.get("tab");
    if (!params.get("course") || !courses.length) return;
    if (wanted === "master" || wanted === "units" || wanted === "voe") setTab(wanted);
    setParams({}, { replace: true });
  }, [courses, params, setParams]);
  useEffect(() => {
    setDetail(null); setDetailError("");
    if (!selectedId) return;
    let current = true;
    setDetailLoading(true);
    rto<CourseDetail>("course_get", { courseId: selectedId })
      .then(result => { if (current) setDetail(result); })
      .catch(e => { if (current) setDetailError(e instanceof Error ? e.message : "Could not load course units."); })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [selectedId, reloadKey]);
  // SLIT hours per unit (accepted, or the nominal hours until accepted) give the course duration.
  useEffect(() => {
    setUnitHours({});
    if (!selectedId) return;
    let current = true;
    loadUnitHours(selectedId)
      .then(list => { if (current) setUnitHours(Object.fromEntries(list.map(h => [h.unitId, h]))); })
      .catch(() => { /* without saved hours the nominal hours are used */ });
    return () => { current = false; };
  }, [selectedId, reloadKey]);

  const save = useCallback(async (action: "course_save" | "units_save", data: Record<string, unknown>) => {
    if (!canEdit || !selectedId || saving) return;
    setSaving(true); setDetailError("");
    try {
      const out = await rto<CourseDetail | RtoCourse>(action, { courseId: selectedId, ...data });
      if ("course" in out) {
        setDetail(out);
        setCourses(previous => previous.map(c => c.id === selectedId ? out.course : c));
      } else {
        setDetail(previous => previous ? { ...previous, course: out } : previous);
        setCourses(previous => previous.map(c => c.id === selectedId ? out : c));
      }
      setSavedAt(new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }));
    } catch (e) { setDetailError(e instanceof Error ? e.message : "Unable to save course."); }
    finally { setSaving(false); }
  }, [canEdit, selectedId, saving]);
  // Deleting a course deletes its intakes too (owner, 2026-11-20: a course and its intakes go together), after a typed warning.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const remove = useCallback(() => { if (canEdit && selectedId && !saving) { setDeleteError(""); setDeleteOpen(true); } }, [canEdit, saving, selectedId]);
  const confirmRemove = useCallback(async () => {
    const course = courses.find(c => c.id === selectedId);
    if (!course) return;
    setSaving(true); setDeleteError("");
    let { error: failed } = await supabase.rpc("rto_course_delete", { p_course_id: course.id, p_force: true });
    // Until COURSE-FORCE-DELETE is applied, a course without intakes still deletes with the older one-argument function.
    if (failed && /schema cache|does not exist/i.test(failed.message)) ({ error: failed } = await supabase.rpc("rto_course_delete", { p_course_id: course.id }));
    setSaving(false);
    if (failed) {
      setDeleteError(/schema cache|does not exist/i.test(failed.message)
        ? "Deleting a course with its intakes needs a database update that is not applied yet (COURSE-FORCE-DELETE). Nothing was deleted."
        : failed.message || "Unable to delete the course.");
      return;
    }
    setDeleteOpen(false); setSavedAt(""); setSelectedId("");
    void load();
  }, [courses, load, selectedId]);
  const sync = useCallback(async () => {
    if (!canEdit || !selectedId || syncing) return;
    setSyncing(true); setDetailError(""); setSyncNote([]);
    const { data, error: syncError } = await invokeTga<SyncResult>({ action: "sync", courseId: selectedId });
    setSyncing(false);
    if (syncError || !data) {
      const detail = syncError && "context" in syncError && syncError.context instanceof Response ? await syncError.context.json().catch(() => null) : null;
      setDetailError(typeof detail?.error === "string" ? detail.error : "Could not sync with Training.gov.au.");
      return;
    }
    setSyncNote([...describeSync(data), await fillCricos(selectedId, data)]);
    setReloadKey(k => k + 1);
    void load(selectedId);
  }, [canEdit, load, selectedId, syncing]);
  const campuses = useMemo(() => Array.from(new Set(courses.map(c => c.campus).filter((x): x is string => !!x))).sort(), [courses]);
  const visible = useMemo(() => courses.filter(c =>
    (!activeOnly || c.isActive) && (!campus || c.campus === campus) &&
    (c.label + " " + c.code).toLowerCase().includes(query.trim().toLowerCase())
  ), [courses, query, campus, activeOnly]);
  const selected = courses.find(c => c.id === selectedId);
  // Inactive units (electives not delivered) do not count toward the course.
  const units = (detail?.units ?? []).filter(unit => unit.isActive);
  const slit = units.map(u => shownHours(u.id ? unitHours[u.id] : undefined, u.nominalHours));
  const slitHours = slit.reduce((sum, h) => sum + (h?.slitHours ?? 0), 0);
  const slitPending = slit.some(h => h && !h.confirmed);
  const slitDuration = detail && slitHours > 0 ? courseWeeksLabel(slitHours) : "";

  const pick = (id: string) => { setSelectedId(id); setTab("overview"); setSavedAt(""); setEditing(false); setSyncNote([]); setMenuOpen(false); };
  /** next: "units" opens Add units (then the first intake), "intake" opens New intake (units already chosen), "none" just shows it. */
  const reloadAfterAdd = (courseId: string, next: "units" | "intake" | "none" = "none") => {
    setAddingCourse(null); setQuery(""); setCampus(""); setActiveOnly(false); setSavedAt(""); setEditing(false); setSyncNote([]);
    setTab(next === "none" ? "overview" : "units"); setWizard(next === "none" ? null : { courseId, step: next === "intake" ? "master" : next });
    setReloadKey(k => k + 1); void load(courseId);
  };
  // A new (inactive) course is finished only through the wizard (owner, 2026-11-20): units, their hours, the master timetable,
  // then an intake with its weekly class times. Until then it cannot be made active, and the course shows where to carry on.
  const classesDone = (detail?.batches ?? []).some(b => b.classDays.length > 0);
  const setupStep: "units" | "hours" | "master" | "classes" | "done" | null = !detail || detail.course.id !== selectedId || masterSaved === null ? null
    : !units.length ? "units" : slit.some(h => !h?.confirmed) ? "hours" : !masterSaved ? "master" : !classesDone ? "classes" : "done";
  const SETUP_TEXT = { units: "Step 2 of 3 · Units", hours: "Step 3 of 3 · Hours", master: "CoE weekly calendar", classes: "CoE and VoE daily timetables" } as const;
  /** Read-only progress: the single Continue setup button above opens the next unfinished screen. */
  const setupSteps = selected ? [
    { key: "master", label: "CoE weekly calendar", done: !!masterSaved },
    { key: "voe", label: "VoE weekly calendar", done: !!voeSaved },
    { key: "coeDaily", label: "CoE daily timetable", done: false },
    { key: "voeDaily", label: "VoE daily timetable", done: false },
  ] : [];
  const continueSetup = () => {
    if (!selected || !setupStep || setupStep === "done") return;
    const courseId = selected.id;
    // Weekly classes: the CoE intake's screen first (then VoE).
    if (setupStep === "classes") { void openClasses(courseId, "coe"); return; }
    void acquireLock(courseId).then(ok => {
      if (!ok) return;
      if (setupStep === "master") setTab("master");
      setWizard({ courseId, step: setupStep });
    }).catch(() => undefined);
  };
  const facts: [string, string][] = selected ? [
    ["Duration", detailLoading ? "…" : slitDuration || "—"], ["Delivery", selected.mode || "—"], ["Campus", selected.campus || "—"],
    ["Units", detail ? String(units.length) : "…"],
    ["SLIT hours", detailLoading ? "…" : detail ? slitHours.toLocaleString() + (slitPending ? " (to review)" : "") : "—"],
  ] : [];
  // The daily timetables sit next to the weekly calendars (owner, 2026-11-21): CoE weekly, VoE weekly, CoE daily, VoE daily.
  const tabs = [{ id: "overview", label: "Overview" }, { id: "units", label: "Units" }, { id: "master", label: "CoE Weekly Calendar" }, { id: "voe", label: "VoE Weekly Calendar" },
    { id: "coeDaily", label: "CoE Daily Timetable" }, { id: "voeDaily", label: "VoE Daily Timetable" }] as const;
  /** The wizard is unfinished until both weekly calendars are saved and the weekly classes are booked. */
  const wizardUnfinished = !!(canEdit && selected && detail && masterSaved !== null && (masterSaved === false || voeSaved === false || !classesDone));
  const menuItem = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-background-100 disabled:opacity-50";

  const pane: Pane = tab === "master" || tab === "voe" || tab === "prereq" || tab === "coeDaily" || tab === "voeDaily" ? { folded: !masterList, toggle: () => setMasterList(v => !v), grid: paneGrid(!masterList) } : savedPane;
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Courses</h1>
        <p className="text-sm text-foreground-500">Qualifications, their CRICOS registration and units.</p>
      </div>
      {canEdit ? <div className="flex items-center gap-2">
        <button type="button" onClick={() => setBulkSync(true)} title="Import one qualification from SLIT's Training.gov.au scope of registration and run the new course wizard on it"
          className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100">Sync from Training.gov.au</button>
        <button type="button" onClick={() => setAddingCourse("tga")} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Add course</button>
      </div> : null}
    </header>

    <TrainingGovBulkSync open={bulkSync && canEdit} courses={courses} onClose={() => setBulkSync(false)}
      onDone={() => { setReloadKey(k => k + 1); void load(selectedId || undefined); }}
      onAddUnits={courseId => { setBulkSync(false); reloadAfterAdd(courseId, "units"); }} />
    {wizard?.step === "units" && !wizard.hidden && canEdit && detail?.course.id === wizard.courseId
      ? <AddUnitsFromTga course={detail.course} units={detail.units} stepLabel="Step 2 of 3 · Units"
        // The course reloads when the popup closes: reloading earlier would close it before its result and next step show.
        // Closing keeps the wizard: the bar at the top of the page opens the step again.
        onClose={() => { setWizard(w => (w ? { ...w, hidden: true } : w)); setReloadKey(k => k + 1); }} onDone={() => undefined}
        nextStep={{ label: "Next: unit hours", onClick: () => { setWizard({ courseId: wizard.courseId, step: "hours" }); setReloadKey(k => k + 1); } }} /> : null}
    {wizard?.step === "hours" && !wizard.hidden && canEdit && selected?.id === wizard.courseId
      ? <UnitHoursEditor course={selected} stepLabel="Step 3 of 3 · Hours" onClose={() => { setWizard(w => (w ? { ...w, hidden: true } : w)); setReloadKey(k => k + 1); }} onSaved={() => undefined}
        // The wizard ends here (owner, 2026-11-21: "the course is finished after step 3"). The CoE and VoE weekly calendars and
        // the weekly classes follow from the course page (Continue setup and the calendar tabs).
        nextStep={{ label: "Finish and save course", onClick: () => { setWizard(null); setTab("overview"); setReloadKey(k => k + 1); } }}
        backStep={{ label: "Back: units", onClick: () => { setWizard({ courseId: wizard.courseId, step: "units" }); setTab("units"); setReloadKey(k => k + 1); } }} /> : null}
    {wizard?.step === "master" && !wizard.hidden && canEdit && selected?.id === wizard.courseId
      ? <StartDateBreaksEditor course={selected} stepLabel="Course setup"
        onStudyLoad={load => setWizardLoad({ courseId: selected.id, load })} registeredWeeks={registeredWeeks(selected.duration)}
        // With an intake already on the course this is the last step: closing ends the wizard.
        onClose={() => { setWizard(w => (w && !detail?.intakes.length ? { ...w, hidden: true } : null)); setReloadKey(k => k + 1); }}
        // VoE weekly calendar next (owner, 2026-11-20), then rooms.
        nextStep={{ label: "Next: VoE weekly calendar", onClick: () => { setWizard({ courseId: wizard.courseId, step: "voe" }); setTab("voe"); } }}
        backStep={{ label: "Back: hours", onClick: () => { setWizard({ courseId: wizard.courseId, step: "hours" }); setReloadKey(k => k + 1); } }} /> : null}
    {wizard?.step === "voe" && !wizard.hidden && canEdit && selected?.id === wizard.courseId
      ? <VoeCalendarEditor course={selected} stepLabel="Course setup"
        onClose={() => { setWizard(w => (w && !detail?.intakes.length ? { ...w, hidden: true } : null)); setReloadKey(k => k + 1); }}
        backStep={{ label: "Back: CoE weekly calendar", onClick: () => { setWizard({ courseId: wizard.courseId, step: "master" }); setTab("master"); setReloadKey(k => k + 1); } }}
        // The last step: the wizard ends; rooms, trainers and class times are set later from the course ("Continue setup").
        // Next: the daily timetables, the CoE intake's weekly classes then the VoE intake's (owner, 2026-11-21); or finish here.
        nextStep={{ label: "Save and next: CoE daily timetable", onClick: () => { setReloadKey(k => k + 1); void openClasses(wizard.courseId, "coe"); } }}
        dailyStep={{ label: "Save and finish", onClick: () => { setWizard(null); setTab("voe"); setReloadKey(k => k + 1); } }} /> : null}
    {/* Last step, in the wizard itself: the intake's class timetable (the same form as Timetable › Create timetable). */}
    {/* Weekly classes, one screen for CoE then one for VoE: kind, room, trainer and times on one row, booked together. */}
    {wizard?.step === "classes" && (wizard.intakeId || wizard.startDate) && canEdit ? <WeeklyClassBookingDialog key={wizard.intakeId ?? `${wizard.courseId}-${wizard.load}`}
      title={`Course setup · ${wizard.load === "voe" ? "VoE" : "CoE"} daily timetable · ${courses.find(c => c.id === wizard.courseId)?.code ?? ""}`}
      intakeId={wizard.intakeId ?? null} draft={wizard.intakeId || !wizard.startDate ? undefined : { startDate: wizard.startDate, initial: wizard.load === "voe" ? (drafts?.courseId === wizard.courseId ? drafts.voe : undefined) : (drafts?.courseId === wizard.courseId ? drafts.coe : undefined), others: wizard.load === "voe" && drafts?.courseId === wizard.courseId ? drafts.coe : undefined, onDraft: (week) => {
        // Nothing is saved yet: the week is kept here; the VoE screen's Finish creates both intakes.
        const next = { ...(drafts?.courseId === wizard.courseId ? drafts : { courseId: wizard.courseId }), [wizard.load === "voe" ? "voe" : "coe"]: week };
        setDrafts(next);
        if (wizard.load === "voe") return finishWizard(wizard.courseId, wizard.startDate as string, next);
        void openClasses(wizard.courseId, "voe");
      } }} courseId={wizard.courseId} load={wizard.load ?? "coe"} canEdit={canEdit}
      saveLabel={wizard.load === "voe" ? "Finish: create the CoE and VoE intakes" : "Next: VoE daily timetable"}
      backLabel={wizard.load === "voe" ? "Back: CoE daily timetable" : "Back: VoE weekly calendar"}
      onBack={() => { if (wizard.load === "voe") void openClasses(wizard.courseId, "coe"); else { setWizard({ courseId: wizard.courseId, step: "voe" }); setTab("voe"); } setReloadKey(k => k + 1); }}
      // Closed before Finish: nothing was created; the course stays unfinished and says so. The lock is released.
      onClose={() => { void releaseLock(); setWizard(null); setReloadKey(k => k + 1); }}
      onSaved={() => {
        setReloadKey(k => k + 1);
        if (wizard.load !== "voe") { void openClasses(wizard.courseId, "voe"); return; }
        const id = wizard.intakeId; void releaseLock(); setWizard(null); if (id) navigate(`/admin/lms/intakes#${id}`);
      }} /> : null}
    {selected ? <DangerDialog open={deleteOpen} title={`Delete ${selected.code}?`} intro={selected.name} busy={saving} error={deleteError}
      items={[
        `${units.length} unit${units.length === 1 ? "" : "s"} with their hours, content and the master timetable`,
        detail?.intakes.length ? `${detail.intakes.length} intake${detail.intakes.length === 1 ? "" : "s"} with their class timetables; students in them wait to be placed in a new intake` : "No intakes",
        "Applications that chose this course lose it, including submitted ones and accepted offers (recorded in the audit log)",
      ]}
      confirmLabel="Yes, delete"
      onCancel={() => setDeleteOpen(false)} onConfirm={() => void confirmRemove()} /> : null}
    {addingCourse === "tga" && canEdit && <TrainingGovCourseImport onClose={() => setAddingCourse(null)} onSaved={reloadAfterAdd} />}
    {error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error} <button className="ml-3 underline" onClick={() => void load()}>Retry</button></div> : null}

    <div className={"grid items-start gap-5 " + pane.grid}>
      <ListPane pane={pane} label="Courses" current={selected?.code}>
      <section className={card + " p-3"}>
        <label className="relative block"><span className="sr-only">Search courses</span>
          <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search code or name" className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" />
        </label>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <button type="button" aria-pressed={activeOnly} onClick={() => setActiveOnly(v => !v)}
            className={"rounded-full border px-2.5 py-1 font-semibold " + (activeOnly ? "border-primary-500 bg-primary-50 text-primary-700" : "border-background-300 text-foreground-600")}>Active only</button>
          {campuses.length ? <select aria-label="Campus" className="rounded-full border border-background-300 bg-transparent px-2 py-1 text-foreground-600" value={campus} onChange={e => setCampus(e.target.value)}>
            <option value="">All campuses</option>{campuses.map(x => <option key={x} value={x}>{x}</option>)}
          </select> : null}
          <span className="ml-auto text-foreground-500">{visible.length} course{visible.length === 1 ? "" : "s"}</span>
        </div>
        <div className="mt-3 max-h-[70vh] space-y-1 overflow-auto">
          {loading ? <p className="p-3 text-sm text-foreground-500">Loading…</p> : visible.length === 0 ? <p className="p-3 text-sm text-foreground-500">No matching courses.</p> : visible.map(c =>
            <button key={c.id} type="button" aria-pressed={selectedId === c.id} onClick={() => pick(c.id)}
              className={"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors " + (selectedId === c.id ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100")}>
              <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (c.isActive ? "bg-green-500" : "bg-background-300")} title={c.isActive ? "Active" : "Inactive"} />
              <span className="min-w-0"><span className="block text-sm font-semibold text-foreground-950">{c.code}</span>
                <span className="block truncate text-xs text-foreground-600">{c.name}</span></span>
            </button>)}
        </div>
      </section>
      </ListPane>

      <section className={card + " min-w-0 p-5"}>
        {!selected ? <p className="py-20 text-center text-foreground-500">{loading ? "Loading…" : "Select a course."}</p> : <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{selected.code}</p>
              <h2 className="font-heading text-xl font-bold text-foreground-950">{selected.name}</h2>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-semibold">
                <span className={"rounded-full px-2 py-0.5 " + (selected.isActive ? "bg-green-100 text-green-800" : "bg-background-200 text-foreground-600")}>{selected.isActive ? "Active" : "Inactive"}</span>
                {selected.status === "Draft" ? <span className="rounded-full bg-background-200 px-2 py-0.5 text-foreground-600" title="Not published on the website">Website draft</span> : null}
                <span className="rounded-full bg-background-200 px-2 py-0.5 text-foreground-600">{selected.cricos ? "CRICOS " + selected.cricos : "No CRICOS code"}</span>
              </div>
            </div>
            {canEdit ? <div className="relative flex items-center gap-2">
              {editing ? <span className="text-xs text-foreground-500" role="status">{saving ? "Saving…" : savedAt ? "Saved " + savedAt : "Changes save automatically"}</span> : null}
              {wizardUnfinished && !editing
                ? <button type="button" onClick={() => { setMenuOpen(false); continueSetup(); }} disabled={!detail}
                  title="Resume the course setup at its next unfinished step"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">
                  <i className="ri-magic-line" aria-hidden="true" />Continue setup</button>
                : <button type="button" onClick={() => { setEditing(v => !v); setMenuOpen(false); }} disabled={!detail}
                  className={"rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 " + (editing ? "bg-primary-600 text-white hover:bg-primary-700" : "border border-background-300 text-foreground-800 hover:bg-background-100")}>
                  {editing ? "Done" : "Edit"}</button>}
              <button type="button" aria-label="More actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}
                className="rounded-lg border border-background-300 px-2.5 py-2 text-foreground-700 hover:bg-background-100"><i className="ri-more-2-fill" aria-hidden="true" /></button>
              {menuOpen ? <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setMenuOpen(false)} /> : null}
              {menuOpen ? <div className="absolute right-0 top-11 z-20 w-64 overflow-hidden rounded-lg border border-background-200 bg-background-50 py-1 shadow-lg">
                <button type="button" className={menuItem} disabled={syncing || saving} onClick={() => { setMenuOpen(false); void sync(); }}>
                  <i className="ri-refresh-line" aria-hidden="true" />Sync with Training.gov.au and CRICOS</button>
                {wizardUnfinished ? <button type="button" className={menuItem} disabled={!detail} onClick={() => { setMenuOpen(false); setEditing(true); }}>
                  <i className="ri-edit-line" aria-hidden="true" />Edit course details</button> : null}
                <button type="button" className={menuItem} disabled={saving || !detail || (!selected.isActive && setupStep !== "done")}
                  title={!selected.isActive && setupStep !== "done" ? "Finish the new course wizard first." : undefined}
                  onClick={() => { setMenuOpen(false); void save("course_save", { isActive: !selected.isActive }); }}>
                  <i className={selected.isActive ? "ri-pause-circle-line" : "ri-play-circle-line"} aria-hidden="true" />Mark as {selected.isActive ? "inactive" : "active"}</button>
                <button type="button" className={menuItem + " text-red-700"} disabled={saving} onClick={() => { setMenuOpen(false); void remove(); }}>
                  <i className="ri-delete-bin-line" aria-hidden="true" />Delete course</button>
              </div> : null}
            </div> : null}
          </div>

          <dl className="mt-4 grid grid-cols-2 rounded-lg border border-background-200 sm:grid-cols-5 sm:divide-x sm:divide-background-200">
            {facts.map(([label, value]) => <div key={label} className="px-3 py-2">
              <dt className="text-xs text-foreground-500">{label}</dt><dd className="truncate text-sm font-semibold text-foreground-950">{value}</dd>
            </div>)}
          </dl>

          {syncing ? <p role="status" className="mt-3 text-sm text-foreground-600">Syncing with Training.gov.au and CRICOS…</p> : null}
          {syncNote.length ? <div role="status" className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            <ul className="space-y-0.5">{syncNote.map(line => <li key={line}>{line}</li>)}</ul>
            <button type="button" aria-label="Dismiss" onClick={() => setSyncNote([])}><i className="ri-close-line" aria-hidden="true" /></button></div> : null}
          {detailError ? <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{detailError}</div> : null}
          {lockHeld ? <div role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            The course wizard is open by <b>{lockHeld.by}</b>{lockHeld.since ? ` since ${new Date(lockHeld.since).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}` : ""}.
            You can view the course but not run its wizard until it is finished or the lock expires (Business Rules › lms.wizard_lock_minutes).</div> : null}
          {selected && !selected.isActive && setupStep && setupStep !== "done" ? <div role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <p><b>Setup not finished: {SETUP_TEXT[setupStep]}.</b> Use <b>Continue setup</b> above. The course can be made active only after the wizard is finished.</p>
            {setupStep === "master" || setupStep === "classes" ? <div aria-label="Course setup progress" className="mt-2 flex flex-wrap items-center gap-1.5">
              {setupSteps.map((st, i) => <span key={st.key} className="inline-flex items-center gap-1.5">
                {i ? <i className="ri-arrow-right-s-line text-amber-700" aria-hidden="true" /> : null}
                <span className={"rounded-full border px-2.5 py-0.5 text-xs font-semibold " + (st.done ? "border-green-300 bg-green-50 text-green-800" : "border-amber-400 bg-background-50 text-amber-950")}>
                  {st.done ? <i className="ri-check-line mr-0.5" aria-hidden="true" /> : null}{st.label}</span></span>)}
            </div> : null}
          </div> : null}

          {editing && canEdit && detail ? <div className="mt-5 space-y-5">
            <CourseFacts key={selectedId + ":" + reloadKey} course={detail.course} readOnly={false} busy={saving} autosave onSave={data => void save("course_save", data)} />
            <CricosCourseSection key={selectedId + ":edit"} courseId={selectedId} onSaved={() => { setReloadKey(k => k + 1); void load(selectedId); }} />
          </div> : <>
            <div role="tablist" aria-label="Course sections" className="mt-5 flex gap-5 border-b border-background-200">
              {tabs.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
                className={"-mb-px border-b-2 px-1 py-2 text-sm font-semibold " + (tab === t.id ? "border-primary-600 text-primary-700" : "border-transparent text-foreground-500 hover:text-foreground-800")}>{t.label}</button>)}
            </div>
            <div role="tabpanel" className="pt-4">
              {tab === "overview" ? <div className="space-y-6"><dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {([["Course name", selected.name + (selected.variantLabel ? ` (${selected.variantLabel})` : "")], ["Course code", selected.code], ["CRICOS code", selected.cricos],
                  ["Category", selected.category], ["Training package", selected.trainingPackage],
                  ["Duration", slitDuration ? `${slitDuration} (${slitHours.toLocaleString()} SLIT hrs ÷ ${HOURS_PER_WEEK} a week)` : ""],
                  ["CRICOS registered duration", selected.duration], ["Delivery mode", selected.mode],
                  ["Campus", selected.campus ?? ""], ["Open intakes", selected.openIntakes ? String(selected.openIntakes) : ""], ["training.gov.au", selected.tgaUrl ?? ""]] as [string, string][])
                  .filter(([, value]) => value && value.trim()).map(([label, value]) => <div key={label}>
                    <dt className="text-xs text-foreground-500">{label}</dt>
                    <dd className="break-words font-medium text-foreground-950">{label === "training.gov.au" ? <a className="text-primary-700 underline" href={value} target="_blank" rel="noreferrer">{value}</a> : value}</dd>
                  </div>)}
              </dl>
              {detail ? <section className="border-t border-background-200 pt-5">
                <h3 className="mb-3 font-heading text-sm font-bold uppercase tracking-wide text-foreground-500">CRICOS</h3>
                <CricosCourseSection key={selectedId + ":view:" + reloadKey} courseId={selectedId} readOnly />
              </section> : null}
              {detail ? <section className="border-t border-background-200 pt-5">
                <h3 className="mb-3 font-heading text-sm font-bold uppercase tracking-wide text-foreground-500">Training.gov.au</h3>
                <SavedTrainingGovDetails key={selectedId + ":" + reloadKey} courseId={selectedId} units={detail.units} />
              </section> : null}
              </div> : null}
              {tab === "units" && selectedId ? <LmsUnitsPage key={selectedId + ":" + reloadKey} embeddedCourseId={selectedId} /> : null}
              {tab === "voe" && selected ? <VoeTab key={selectedId + ":" + reloadKey} course={selected} canEdit={canEdit} /> : null}
              {(tab === "coeDaily" || tab === "voeDaily") && selected ? <div className="space-y-3 rounded-lg border border-background-200 bg-background-50 p-5">
                <h3 className="font-heading text-lg font-bold text-foreground-950">{tab === "coeDaily" ? "CoE" : "VoE"} daily timetable</h3>
                <p className="text-sm text-foreground-600">The week's classes for {tab === "coeDaily" ? "CoE (20 hours a week)" : "VoE (40 hours a week)"} students: day, kind, room, trainer and times. The timetable is saved with the course setup.</p>
                {wizardUnfinished ? <p className="text-sm font-semibold text-amber-800">Use <b>Continue setup</b> above to create or resume this timetable.</p>
                  : <p className="text-sm text-foreground-600">The course setup is finished. Manage this timetable from its intake.</p>}
              </div> : null}
              {tab === "master" && selected ? <MasterTimetableTab key={selectedId + ":" + reloadKey} courseId={selectedId} courseCode={selected.code} /> : null}
            </div>
          </>}
        </>}
      </section>
    </div>
  </div>;
}
