import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import BreakDatePicker from "@/pages/admin/components/rto/BreakDatePicker";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import IntakeCalendar from "./IntakeCalendar";
import { generateClassSessions, listBreaks, loadIntakeLoads, LOAD_HOURS, rto, setIntakeLoad, shortDate, todayIso, type StudyLoad, type AcademicBreak, type IntakeDetail, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const longDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Intakes per course. Every intake is active (status "open"); RTO Managers change its start date or delete it. */
export default function LmsIntakesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [breaks, setBreaks] = useState<AcademicBreak[]>([]);
  const [courseId, setCourseId] = useState("");
  const [courseSearch, setCourseSearch] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [start, setStart] = useState("");
  const [loads, setLoads] = useState<Record<string, StudyLoad>>({});
  const [studyLoad, setStudyLoad] = useState<StudyLoad>("coe");
  const [creating, setCreating] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [cs, is, me] = await Promise.all([rto<RtoCourse[]>("course_list"), rto<RtoIntake[]>("intake_list"), rto<{ rtoManager: boolean }>("me")]);
      setCourses(cs); setIntakes(is); setCanEdit(me.rtoManager); setLoadError("");
      setLoads(await loadIntakeLoads());
      setCourseId(prev => cs.some(c => c.id === prev) ? prev : (cs[0]?.id ?? ""));
    } catch (e) { setLoadError(e instanceof Error ? e.message : "Unable to load intakes."); }
  }, []);
  useEffect(() => { void load(); listBreaks().then(setBreaks).catch(() => undefined); }, [load]);
  useEffect(() => {
    setDetail(null); setProblem("");
    if (!selectedId) return;
    let active = true;
    rto<IntakeDetail>("intake_get", { intakeId: selectedId })
      .then(d => { if (active) { setDetail(d); setStart(d.intake.startDate); } })
      .catch(e => { if (active) setProblem(e instanceof Error ? e.message : "Unable to load the intake."); });
    return () => { active = false; };
  }, [selectedId]);

  useEffect(() => { if (detail) setStudyLoad(loads[detail.intake.id] ?? "coe"); }, [detail, loads]);
  const chooseCourse = (id: string) => { setCourseId(id); setSelectedId(""); setNotice(""); };
  const selectedCourse = courses.find(c => c.id === courseId);
  const courseIntakes = useMemo(() => intakes.filter(i => i.courseId === courseId), [intakes, courseId]);
  const filtered = courseIntakes.filter(i => (i.name + " " + i.startDate).toLowerCase().includes(search.toLowerCase()));
  const taken = useMemo(() => new Set(courseIntakes.filter(i => i.id !== selectedId).map(i => i.startDate)), [courseIntakes, selectedId]);
  const courseBreaks = breaks.filter(b => !b.courseId || b.courseId === (detail?.intake.courseId ?? courseId));
  const inBreak = courseBreaks.find(b => start >= b.startDate && start <= b.endDate);
  const close = () => { setSelectedId(""); setProblem(""); };

  const save = async () => {
    if (!detail || !canEdit || busy || !start || inBreak || taken.has(start)) return;
    setBusy(true); setProblem("");
    const moved = start !== detail.intake.startDate;
    const loadChanged = studyLoad !== (loads[detail.intake.id] ?? "coe");
    try {
      let updated = await rto<IntakeDetail>("intake_save", { id: detail.intake.id, status: "open", ...(moved ? { startDate: start, generate: true } : {}) });
      if (loadChanged) { await setIntakeLoad(detail.intake.id, studyLoad); updated = await rto<IntakeDetail>("intake_get", { intakeId: detail.intake.id }); }
      // A new start date moves the unit timeline, so the batches' dated classes are planned again.
      if (moved || loadChanged) for (const b of updated.batches) if ((b.sessions ?? []).length) await generateClassSessions(b.id).catch(() => null);
      setIntakes(prev => prev.map(i => i.id === updated.intake.id ? { ...i, ...updated.intake } : i));
      setNotice(`${updated.intake.name} saved.`); close(); void load();
    } catch (e) { setProblem(e instanceof Error ? e.message : "The intake was not saved."); }
    finally { setBusy(false); }
  };
  const remove = async (i: Pick<RtoIntake, "id" | "name">) => {
    if (!canEdit || busy || !window.confirm(`Delete the intake ${i.name}? Its batches and timeline are deleted too.`)) return;
    setBusy(true); setProblem(""); setNotice("");
    try {
      await rto("intake_delete", { intakeId: i.id });
      setIntakes(prev => prev.filter(x => x.id !== i.id));
      setNotice(`${i.name} deleted.`); if (selectedId === i.id) close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "The intake was not deleted.";
      if (selectedId === i.id) setProblem(msg); else setNotice(msg);
    } finally { setBusy(false); }
  };

  const visibleCourses = courses.filter(c => (c.code + " " + c.name).toLowerCase().includes(courseSearch.toLowerCase()));
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Intakes</h1>
        <p className="text-sm text-foreground-500">Intakes for each course. Every intake is active.</p>
      </div>
      {canEdit && selectedCourse ? <button type="button" onClick={() => setCreating(true)} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">Add intake</button> : null}
    </header>
    {loadError ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}<button onClick={() => void load()} className="ml-3 underline">Retry</button></div> : null}
    {notice && !selectedId ? <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</p> : null}
    <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className={card + " p-3"}>
        <label className="relative block"><span className="sr-only">Search courses</span>
          <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
          <input className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" aria-label="Search courses" placeholder="Search course" value={courseSearch} onChange={e => setCourseSearch(e.target.value)} />
        </label>
        <div className="mt-3 max-h-[70vh] space-y-1 overflow-auto">{visibleCourses.length === 0 ? <p className="p-3 text-sm text-foreground-500">No matching courses.</p> : visibleCourses.map(c => {
          const count = intakes.filter(i => i.courseId === c.id).length;
          return <button type="button" key={c.id} aria-pressed={courseId === c.id} onClick={() => chooseCourse(c.id)}
            className={"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors " + (courseId === c.id ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100")}>
            <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (c.isActive ? "bg-green-500" : "bg-background-300")} title={c.isActive ? "Active" : "Inactive"} />
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-foreground-950">{c.code}</span>
              <span className="block truncate text-xs text-foreground-600">{c.name}</span></span>
            <span className="shrink-0 text-xs text-foreground-500" title={count + " intakes"}>{count}</span>
          </button>;
        })}</div>
      </aside>
      <section className={card + " min-w-0 p-5"}>
        {!selectedCourse ? <p className="py-10 text-center text-sm text-foreground-500">Select a course.</p> : <>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{selectedCourse.code}</p>
            <h2 className="font-heading text-xl font-bold text-foreground-950">{selectedCourse.name}</h2>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="relative min-w-48 flex-1"><span className="sr-only">Search intakes</span>
              <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
              <input className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" aria-label="Search intakes" placeholder="Search intakes" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
            <span className="text-xs text-foreground-500">{filtered.length} intake{filtered.length === 1 ? "" : "s"}</span>
          </div>
          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
            <thead><tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">
              {["Intake", "Students", "Start date", "End date", ""].map(x => <th key={x || "actions"} className="px-3 py-2">{x}</th>)}</tr></thead>
            <tbody>{filtered.map(i => <tr key={i.id} className={"border-b border-background-100 " + (selectedId === i.id ? "bg-primary-50" : "hover:bg-background-100")}>
              <td className="px-3 py-2 font-semibold text-foreground-950">{i.name}</td>
              <td className="px-3 py-2"><span className="rounded-full bg-background-200 px-2 py-0.5 text-xs font-semibold">{(loads[i.id] ?? "coe") === "voe" ? "VoE · 40 h" : "CoE · 20 h"}</span></td>
              <td className="px-3 py-2">{shortDate(i.startDate)}</td>
              <td className="px-3 py-2">{shortDate(i.endDate)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right">
                <button type="button" onClick={() => { setNotice(""); setSelectedId(i.id); }} className="inline-flex items-center gap-1 rounded-lg border border-background-300 px-2.5 py-1 text-xs font-semibold text-foreground-800 hover:bg-background-100">
                  <i className={(canEdit ? "ri-pencil-line" : "ri-eye-line") + " text-sm"} aria-hidden="true" />{canEdit ? "Edit" : "View"}</button>
                {canEdit ? <button type="button" disabled={busy} onClick={() => void remove(i)} className="ml-2 inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
                  <i className="ri-delete-bin-line text-sm" aria-hidden="true" />Delete</button> : null}
              </td>
            </tr>)}</tbody>
          </table>{!filtered.length ? <p className="py-10 text-center text-sm text-foreground-500">No intakes for this course yet.</p> : null}</div>
        </>}
      </section>
    </div>
    {selectedId ? <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={close}>
      <section role="dialog" aria-modal="true" aria-label="Edit intake" className="flex h-full w-full max-w-4xl flex-col bg-background-50 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-background-200 p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{canEdit ? "Edit intake" : "Intake"}</p>
            <h2 className="font-heading text-xl font-bold text-foreground-950">{detail?.intake.name ?? "…"}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={close} className="rounded-lg p-1.5 text-foreground-600 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {!detail ? <p className="py-10 text-center text-sm text-foreground-500">{problem || "Loading intake…"}</p> : <div className="space-y-4">
            <Link to="/admin/lms/courses" className="block truncate text-sm text-primary-700 underline">{detail.intake.courseCode} — {detail.intake.courseName}</Link>
            <dl className="grid grid-cols-2 rounded-lg border border-background-200 divide-x divide-background-200">
              {([["Start", shortDate(detail.intake.startDate)], ["End", shortDate(detail.intake.endDate)]] as [string, string][]).map(([label, value]) => <div key={label} className="px-3 py-2">
                <dt className="text-xs text-foreground-500">{label}</dt><dd className="truncate text-sm font-semibold text-foreground-950">{value}</dd>
              </div>)}
            </dl>
            <IntakeCalendar detail={detail} />
            {canEdit ? <div className="space-y-1">
              <p className="text-sm font-medium text-foreground-800">Students on</p>
              <div className="grid max-w-md grid-cols-2 gap-2" role="radiogroup" aria-label="CoE or VoE">
                {(["coe", "voe"] as const).map(l => <button key={l} type="button" role="radio" aria-checked={studyLoad === l} onClick={() => setStudyLoad(l)}
                  className={`rounded-lg border-2 px-3 py-2 text-left text-sm ${studyLoad === l ? "border-primary-600 bg-primary-50 font-semibold text-primary-900" : "border-background-300 hover:border-primary-400"}`}>
                  <span className="block font-bold">{l === "coe" ? "CoE" : "VoE"}</span><span className="block text-xs text-foreground-600">{LOAD_HOURS[l]} hours a week</span></button>)}
              </div>
              {studyLoad !== (loads[detail.intake.id] ?? "coe") ? <p className="text-xs text-foreground-600">Saving lays the unit timeline out again at {LOAD_HOURS[studyLoad]} hours a week and moves the batches' classes.</p> : null}
            </div> : null}
            {canEdit ? <div className="space-y-2">
              <p className="text-sm font-medium text-foreground-800">Start date</p>
              <p className="text-sm font-semibold text-foreground-900">{start ? longDate(start) : "Pick a day"}</p>
              <BreakDatePicker value={start} onChange={setStart} breaks={courseBreaks} taken={taken} takenLabel="Another intake starts" today={todayIso()} />
              {start !== detail.intake.startDate ? <p className="text-xs text-foreground-600">Saving a new start date lays the unit timeline out again and moves the batches' classes.</p> : null}
            </div> : null}
            {problem ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{problem}</p> : null}
          </div>}
        </div>
        {detail && canEdit ? <div className="flex items-center justify-between gap-2 border-t border-background-200 p-4">
          <button type="button" disabled={busy} onClick={() => void remove(detail.intake)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
            <i className="ri-delete-bin-line" aria-hidden="true" />Delete intake</button>
          <div className="flex gap-2">
            <button type="button" className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100" onClick={close}>Cancel</button>
            <button type="button" disabled={busy || !start || !!inBreak || taken.has(start)} onClick={() => void save()} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
          </div>
        </div> : null}
      </section></div> : null}
    <NewIntakeDrawer open={creating && canEdit} onClose={() => setCreating(false)} courses={courses.map(c => ({ id: c.id, label: c.label }))} courseId={courseId || undefined}
      onCreated={(created: IntakeDetail) => { setCreating(false); setCourseId(created.intake.courseId); setNotice(`${created.intake.name} added.`); void load(); }} />
  </div>;
}
