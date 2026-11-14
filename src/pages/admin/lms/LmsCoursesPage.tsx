import { useCallback, useEffect, useMemo, useState } from "react";
import NewIntakeDrawer from "@/pages/admin/components/rto/NewIntakeDrawer";
import IntakeSheet from "@/pages/admin/components/rto/IntakeSheet";
import { rto, type CourseDetail, type IntakeDetail, type RtoCourse, type RtoIntake } from "@/pages/admin/lib/rto";

type Tab = "units" | "intakes" | "overview";
type UnitFilter = "all" | "core" | "elective";
const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const icon = (name: string) => <i className={name + " text-xl text-primary-600"} aria-hidden="true" />;

/** LMS-only delivery workspace. Reads authoritative course and intake records; never edits course master data. */
export default function LmsCoursesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [intakes, setIntakes] = useState<RtoIntake[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [query, setQuery] = useState("");
  const [campus, setCampus] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [tab, setTab] = useState<Tab>("units");
  const [unitFilter, setUnitFilter] = useState<UnitFilter>("all");
  const [createIntake, setCreateIntake] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [activeIntakeId, setActiveIntakeId] = useState("");
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cs, is, role] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        rto<RtoIntake[]>("intake_list"),
        rto<{ rtoManager: boolean }>("me"),
      ]);
      setCourses(cs); setIntakes(is); setCanEdit(role.rtoManager); setError("");
      setSelectedId(previous => cs.some(c => c.id === previous) ? previous : (cs[0]?.id ?? ""));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load courses."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
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
  }, [selectedId]);

  const campuses = useMemo(() => Array.from(new Set(courses.map(c => c.campus).filter((x): x is string => !!x))).sort(), [courses]);
  const visible = useMemo(() => courses.filter(c =>
    (!activeOnly || c.isActive) && (!campus || c.campus === campus) &&
    (c.label + " " + c.code).toLowerCase().includes(query.trim().toLowerCase())
  ), [courses, query, campus, activeOnly]);
  const selected = courses.find(c => c.id === selectedId);
  const runs = intakes.filter(i => i.courseId === selectedId);
  const units = detail?.units ?? [];
  const filteredUnits = units.filter(u => unitFilter === "all" || u.unitType === unitFilter);
  const count = (type: UnitFilter) => type === "all" ? units.length : units.filter(u => u.unitType === type).length;
  const nominalHours = units.reduce((sum, u) => sum + (u.nominalHours ?? 0), 0);

  return <div className="mx-auto max-w-[1500px] space-y-6 pb-12">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm font-semibold text-foreground-500">LMS <span className="mx-2">/</span> Courses</p>
        <h1 className="mt-3 font-heading text-3xl font-bold text-foreground-950">Courses</h1>
        <p className="mt-1 text-sm text-foreground-600">Manage course delivery, units, intakes and batches.</p>
      </div>
      <label className="flex items-center gap-2 rounded-xl border border-background-200 bg-background-50 px-3 py-2 text-sm">
        {icon("ri-map-pin-line")}<span className="sr-only">Campus</span>
        <select className="max-w-48 bg-transparent outline-none" value={campus} onChange={e => setCampus(e.target.value)}>
          <option value="">All Campuses</option>{campuses.map(x => <option key={x} value={x}>{x}</option>)}
        </select>
      </label>
    </header>
    {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error} <button className="ml-3 underline" onClick={() => void load()}>Retry</button></div> : null}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,0.95fr)_minmax(0,2.25fr)]">
      <section className={card + " p-4"}>
        <div className="flex gap-2">
          <label className="relative min-w-0 flex-1"><span className="sr-only">Search courses</span>
            <i className="ri-search-line absolute left-3 top-3 text-foreground-500" aria-hidden="true" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search courses (code or name)" className="w-full rounded-lg border border-background-300 bg-background-50 py-2.5 pl-9 pr-2 text-sm" />
          </label>
          <button type="button" title={activeOnly ? "Show all courses" : "Show active courses"} aria-pressed={activeOnly} onClick={() => setActiveOnly(v => !v)}
            className={"rounded-lg border px-3 " + (activeOnly ? "border-primary-500 bg-primary-50" : "border-background-300")}>{icon("ri-filter-3-line")}</button>
        </div>
        <p className="my-4 text-sm font-semibold text-foreground-700">{visible.length} course{visible.length === 1 ? "" : "s"}</p>
        <div className="max-h-[690px] space-y-2 overflow-auto">
          {loading ? <p className="p-3 text-sm text-foreground-500">Loading courses…</p> : visible.length === 0 ? <p className="p-3 text-sm text-foreground-500">No matching courses.</p> : visible.map(c =>
            <button key={c.id} type="button" aria-pressed={selectedId === c.id} onClick={() => { setSelectedId(c.id); setTab("units"); setUnitFilter("all"); }}
              className={"flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:border-primary-500 " + (selectedId === c.id ? "border-primary-400 bg-primary-50" : "border-background-200 bg-background-50")}>
              <span className="rounded-lg bg-background-100 p-2">{icon("ri-graduation-cap-line")}</span>
              <span className="min-w-0 flex-1"><span className="block font-semibold text-foreground-950">{c.code}</span>
                <span className="mt-1 block text-sm text-foreground-600">{c.name}</span></span>
              <span className={"rounded-full px-2 py-1 text-xs font-semibold " + (c.isActive ? "bg-green-100 text-green-800" : "bg-background-200 text-foreground-600")}>{c.isActive ? "Active" : "Inactive"}</span>
            </button>)}
        </div>
      </section>
      <section className={card + " min-w-0 p-5"}>
        {!selected ? <p className="py-20 text-center text-foreground-500">{loading ? "Loading…" : "Select a course to view its delivery."}</p> : <>
          <div className="flex flex-wrap items-start gap-4">
            <span className="rounded-xl bg-primary-50 p-4">{icon("ri-graduation-cap-line")}</span>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-xl font-bold text-foreground-950">{selected.code} – {selected.name}</h2>
              <span className={"rounded-full px-3 py-1 text-xs font-semibold " + (selected.isActive ? "bg-green-100 text-green-800" : "bg-background-200 text-foreground-600")}>{selected.isActive ? "Active" : "Inactive"}</span>
            </div><p className="mt-1 text-sm text-foreground-600">{selected.cricos ? "CRICOS: " + selected.cricos : "CRICOS not specified"}</p></div>
            {canEdit ? <button type="button" onClick={() => setCreateIntake(true)} className="rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-700">+ Create Intake</button> : null}
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Duration", value: selected.duration || "—", iconName: "ri-calendar-line" },
              { label: "Delivery Mode", value: selected.mode || "—", iconName: "ri-stack-line" },
              { label: "Campus", value: selected.campus || "Not specified", iconName: "ri-map-pin-line" },
              { label: "Nominal Hours", value: detailLoading ? "…" : detail ? nominalHours.toLocaleString() : "—", iconName: "ri-time-line" },
            ].map(item => <div key={item.label} className="flex items-center gap-3 rounded-xl border border-background-200 bg-background-50 p-3">
              <span className="rounded-lg bg-primary-50 p-2">{icon(item.iconName)}</span><div className="min-w-0">
                <p className="text-xs text-foreground-500">{item.label}</p><p className="font-semibold text-foreground-950">{item.value}</p>
              </div>
            </div>)}
          </div>
          <div role="tablist" aria-label="Course delivery sections" className="mt-7 flex flex-wrap gap-6 border-b border-background-200">
            {([{ id: "units", label: "Units", glyph: "ri-list-check-2" }, { id: "intakes", label: "Intakes & Batches", glyph: "ri-group-line" }, { id: "overview", label: "Overview", glyph: "ri-information-line" }] as const).map(t =>
              <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
                className={"flex items-center gap-2 border-b-2 px-1 py-3 text-sm font-semibold " + (tab === t.id ? "border-primary-600 text-primary-600" : "border-transparent text-foreground-600")}>
                <i className={t.glyph} aria-hidden="true" />{t.label}</button>)}
          </div>
          {tab === "units" ? <div role="tabpanel" className="pt-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="font-heading text-lg font-bold">Course Units ({units.length})</h3>
              <div className="flex flex-wrap gap-2">{(["all", "core", "elective"] as const).map(f =>
                <button key={f} type="button" aria-pressed={unitFilter === f} onClick={() => setUnitFilter(f)}
                  className={"rounded-lg border px-3 py-1.5 text-sm " + (unitFilter === f ? "border-primary-600 bg-primary-600 font-semibold text-white" : "border-background-300")}>
                  {f === "all" ? "All" : f === "core" ? "Core" : "Elective"} ({count(f)})</button>)}</div>
            </div>
            {detailError ? <p role="alert" className="text-sm text-red-700">{detailError}</p> : detailLoading ? <p className="py-8 text-center text-foreground-500">Loading units…</p> : !detail ? <p className="py-8 text-center text-foreground-500">Course units unavailable.</p> : filteredUnits.length ? <div className="overflow-x-auto rounded-xl border border-background-200">
              <table className="w-full min-w-[530px] text-left text-sm"><thead className="bg-background-100 text-foreground-700"><tr>
                <th className="px-4 py-3 font-semibold">Unit Code</th><th className="px-4 py-3 font-semibold">Unit Name</th><th className="px-4 py-3 font-semibold">Type</th><th className="px-4 py-3 font-semibold">Nominal Hours</th>
              </tr></thead><tbody className="divide-y divide-background-200">{filteredUnits.map((u, i) =>
                <tr key={u.id ?? u.code + i} className="hover:bg-background-100"><td className="px-4 py-3 font-semibold">{u.code}</td>
                  <td className="px-4 py-3">{u.name}</td><td className="px-4 py-3"><span className={"rounded-md px-2 py-1 text-xs font-semibold " + (u.unitType === "core" ? "bg-blue-100 text-blue-800" : "bg-violet-100 text-violet-800")}>{u.unitType === "core" ? "Core" : "Elective"}</span></td>
                  <td className="px-4 py-3">{u.nominalHours ?? "—"}</td></tr>)}</tbody></table>
            </div> : <p className="py-8 text-center text-foreground-500">No units match this filter.</p>}
          </div> : null}
          {tab === "intakes" ? <div role="tabpanel" className="pt-5">
            <div className="mb-4 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-background-100 p-4"><p className="text-xs text-foreground-500">Intakes</p><p className="text-2xl font-bold">{runs.length}</p></div>
              <div className="rounded-xl bg-background-100 p-4"><p className="text-xs text-foreground-500">Batches</p><p className="text-2xl font-bold">{runs.reduce((sum, i) => sum + (i.batchList?.length ?? i.batches), 0)}</p></div></div>
            {runs.length ? <div className="divide-y divide-background-200">{runs.map(i => <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div><p className="font-semibold">{i.name}</p><p className="mt-1 text-xs text-foreground-500">{i.startDate} – {i.endDate ?? "TBC"} · {i.batchList?.length ?? i.batches} batches · {i.enrolled} enrolled · {i.status}</p></div>
              <button type="button" className="rounded-lg border border-primary-400 px-3 py-2 text-sm font-semibold text-primary-600" onClick={() => setActiveIntakeId(i.id)}>Manage batches</button>
            </div>)}</div> : <p className="py-8 text-center text-foreground-500">No intakes yet. Create an intake to start delivery.</p>}
          </div> : null}
          {tab === "overview" ? <div role="tabpanel" className="grid gap-4 pt-5 sm:grid-cols-2">
            {[["Course code", selected.code], ["Course name", selected.name], ["CRICOS", selected.cricos || "—"], ["Duration", selected.duration || "—"], ["Delivery mode", selected.mode || "—"], ["Campus", selected.campus || "—"], ["Training package", selected.trainingPackage || "—"], ["Category", selected.category || "—"]].map(([label, value]) =>
              <div key={label} className="rounded-xl bg-background-100 p-4"><p className="text-xs text-foreground-500">{label}</p><p className="mt-1 font-semibold">{value}</p></div>)}
          </div> : null}
        </>}
      </section>
    </div>
    {activeIntakeId ? <IntakeSheet key={activeIntakeId} intakeId={activeIntakeId} canEdit={canEdit} canEnrol={canEdit} startTab="batches" onClose={() => setActiveIntakeId("")} onChanged={() => void load()} onDuplicate={() => { setActiveIntakeId(""); void load(); }} onDelete={() => { setActiveIntakeId(""); void load(); }} /> : null}
    <NewIntakeDrawer open={createIntake && canEdit} onClose={() => setCreateIntake(false)} courses={courses.map(c => ({ id: c.id, label: c.label }))} courseId={selectedId || undefined}
      onCreated={(result: IntakeDetail, addBatch: boolean) => { setCreateIntake(false); setSelectedId(result.intake.courseId); setTab("intakes"); if (addBatch) setActiveIntakeId(result.intake.id); void load(); }} />
  </div>;
}
