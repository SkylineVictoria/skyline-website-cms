import { useCallback, useEffect, useMemo, useState } from "react";
import { rto, type CourseDetail, type RtoCourse } from "@/pages/admin/lib/rto";
import { CourseFacts } from "@/pages/admin/components/rto/CourseSteps";

type Tab = "overview";
const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const icon = (name: string) => <i className={name + " text-xl text-primary-600"} aria-hidden="true" />;

/** LMS course information workspace. Reads authoritative course records only; children manage their own records. */
export default function LmsCoursesPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<CourseDetail | null>(null);
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cs, me] = await Promise.all([
        rto<RtoCourse[]>("course_list"),
        rto<{rtoManager:boolean}>("me"),
      ]);
      setCourses(cs); setCanEdit(me.rtoManager); setError("");
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
  const campuses = useMemo(() => Array.from(new Set(courses.map(c => c.campus).filter((x): x is string => !!x))).sort(), [courses]);
  const visible = useMemo(() => courses.filter(c =>
    (!activeOnly || c.isActive) && (!campus || c.campus === campus) &&
    (c.label + " " + c.code).toLowerCase().includes(query.trim().toLowerCase())
  ), [courses, query, campus, activeOnly]);
  const selected = courses.find(c => c.id === selectedId);
  const units = detail?.units ?? [];
  const nominalHours = units.reduce((sum, u) => sum + (u.nominalHours ?? 0), 0);

  return <div className="mx-auto max-w-[1500px] space-y-6 pb-12">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm font-semibold text-foreground-500">LMS <span className="mx-2">/</span> Courses</p>
        <h1 className="mt-3 font-heading text-3xl font-bold text-foreground-950">Courses</h1>
        <p className="mt-1 text-sm text-foreground-600">View and edit course information and qualification details. Units are managed separately.</p>
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
            <button key={c.id} type="button" aria-pressed={selectedId === c.id} onClick={() => { setSelectedId(c.id); setTab("overview"); setSavedAt(""); }}
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
          <div className="mt-3 text-right text-xs text-foreground-500" role="status">{saving ? "Saving changes…" : savedAt ? "Saved " + savedAt : canEdit ? "Changes autosave" : "Read only"}</div>
          <div role="tablist" aria-label="Course sections" className="mt-7 flex flex-wrap gap-6 border-b border-background-200">
            {([{ id: "overview", label: "Overview", glyph: "ri-information-line" }] as const).map(t =>
              <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
                className={"flex items-center gap-2 border-b-2 px-1 py-3 text-sm font-semibold " + (tab === t.id ? "border-primary-600 text-primary-600" : "border-transparent text-foreground-600")}>
                <i className={t.glyph} aria-hidden="true" />{t.label}</button>)}
          </div>
          {tab === "overview" && canEdit && detail ? <div role="tabpanel" className="pt-5"><CourseFacts key={selectedId} course={detail.course} readOnly={false} busy={saving} autosave onSave={data => void save("course_save", data)} /></div> : null}
          {tab === "overview" && !canEdit ? <div role="tabpanel" className="grid gap-4 pt-5 sm:grid-cols-2">
            {[["Course code", selected.code], ["Course name", selected.name], ["CRICOS", selected.cricos || "—"], ["Duration", selected.duration || "—"], ["Delivery mode", selected.mode || "—"], ["Campus", selected.campus || "—"], ["Training package", selected.trainingPackage || "—"], ["Category", selected.category || "—"]].map(([label, value]) =>
              <div key={label} className="rounded-xl bg-background-100 p-4"><p className="text-xs text-foreground-500">{label}</p><p className="mt-1 font-semibold">{value}</p></div>)}
          </div> : null}
        </>}
      </section>
    </div>
  </div>;
}
