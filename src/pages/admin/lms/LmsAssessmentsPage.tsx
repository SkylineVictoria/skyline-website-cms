import { useCallback, useEffect, useMemo, useState } from "react";
import { rto, type RtoCourse } from "@/pages/admin/lib/rto";
import { asmAdmin, type AssessmentRow } from "@/pages/admin/lib/assessments";
import { CreateDialog } from "@/pages/admin/assessments/AssessmentsPage";

/** LMS assessment library; reuses the existing assessment RPC and create form. */
export default function LmsAssessmentsPage() {
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [rows, setRows] = useState<AssessmentRow[]>([]);
  const [courseId, setCourseId] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [cs, assessments] = await Promise.all([rto<RtoCourse[]>("course_list"), asmAdmin<AssessmentRow[]>("assessment_list", { includeArchived: false })]);
      setCourses(cs); setRows(assessments); setError("");
    } catch(e) { setError(e instanceof Error ? e.message : "Unable to load assessments."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const shown = useMemo(() => rows.filter(r => (!courseId || r.courseId === courseId) && (r.title + " " + r.courseName + " " + (r.unitCode ?? "")).toLowerCase().includes(query.toLowerCase())), [rows, courseId, query]);
  return <div className="mx-auto max-w-6xl space-y-5 pb-10">
    <header><p className="text-xs font-semibold uppercase text-foreground-500">Learning Management</p><h1 className="mt-1 font-heading text-3xl font-bold">Assessments & results</h1><p className="mt-2 text-sm text-foreground-600">Find learning assessments by course and unit. Uses the existing assessment library and records.</p></header>
    {error ? <p role="alert" className="rounded-lg border border-red-200 p-3 text-red-700">{error}<button className="ml-3 underline" onClick={() => void load()}>Retry</button></p> : null}
    <div className="flex flex-wrap gap-3">
      <input aria-label="Search assessments" className="min-w-48 flex-1 rounded-lg border border-background-300 p-2" placeholder="Search assessment or unit" value={query} onChange={e => setQuery(e.target.value)} />
      <select aria-label="Filter assessments by course" className="rounded-lg border border-background-300 p-2" value={courseId} onChange={e => setCourseId(e.target.value)}><option value="">All courses</option>{courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      <button type="button" onClick={() => setCreating(true)} className="rounded-lg bg-primary-500 px-4 py-2 font-semibold text-background-50">+ New assessment</button>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">{shown.map(a => <article key={a.id} className="rounded-xl border border-background-200 bg-background-50 p-4">
      <p className="text-xs font-semibold uppercase text-foreground-500">{a.courseName}{a.unitCode ? " · " + a.unitCode : ""}</p><h2 className="mt-2 font-semibold">{a.title}</h2>
      <p className="mt-2 text-sm text-foreground-600">{a.currentVersionNo ? `Version ${a.currentVersionNo} · ${a.currentVersionStatus ?? "Draft"}` : "Not published"} · {a.assignments} assignments</p>
    </article>)}</div>
    {!shown.length ? <p className="text-sm text-foreground-500">No assessments match these filters.</p> : null}
    {creating ? <CreateDialog courses={courses} templates={rows.filter(r => r.isTemplate || !!r.currentVersionNo)} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} /> : null}
  </div>;
}
