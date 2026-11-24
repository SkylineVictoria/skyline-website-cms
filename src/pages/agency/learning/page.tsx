import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Completion } from "@/pages/CertificatePage";
import { categoryLabel, downloadResource, listResources, type Resource } from "@/pages/admin/lib/bulkResources";
import { supabase } from "@/pages/admin/lib/supabase";
import { PageHeading, PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import StudyProgress, { type ProgressCourse } from "@/pages/admin/components/StudyProgress";
import StudentPracticePage from "@/pages/agency/practice/page";
import { RateBadge } from "@/pages/admin/lms/AttendanceSummary";
import type { AttendanceCounts } from "@/pages/admin/lms/attendanceRate";

type Item = { id: string; kind: "text" | "link" | "video" | "file"; title: string; body: string; url: string | null; path: string | null; fileName: string | null; sizeBytes: number | null };
type Unit = { unitId: string; code: string; name: string; startDate: string | null; endDate: string | null; items: Item[] };
type Course = { enrolmentId: string; status: string; batchName: string; courseName: string; courseCode: string; intakeStart: string | null; attendance: AttendanceCounts; units: Unit[] };

const KIND_ICON: Record<Item["kind"], string> = { text: "ri-file-text-line", link: "ri-links-line", video: "ri-video-line", file: "ri-attachment-2-line" };
const fmt = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const size = (n: number | null) => (!n ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Student portal > My learning: each enrolled course's units with the learning content staff marked "Show to students", and attendance. */
export default function StudentLearningPage() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState("");
  const [imports, setImports] = useState<Record<string, Resource[]>>({});
  const [open, setOpen] = useState<string | null>(null);
  // From Practice › Learn: open this unit's materials and name the topic being revised.
  const [params, setParams] = useSearchParams();
  // Learn and Practice on one page (owner, 2026-11-23): ?tab=practice shows the AI practice.
  const practiceTab = params.get("tab") === "practice";
  const wantUnit = params.get("unit");
  const wantTopic = params.get("topic");
  useEffect(() => {
    if (!wantUnit || !courses) return;
    const course = courses.find((c) => c.units.some((u) => u.unitId === wantUnit));
    if (!course) return;
    const key = `${course.enrolmentId}:${wantUnit}`;
    setOpen(key);
    window.setTimeout(() => document.getElementById(`unit-${wantUnit}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, [wantUnit, courses]);
  const [certs, setCerts] = useState<Completion[]>([]);
  const [progress, setProgress] = useState<ProgressCourse[]>([]);
  useEffect(() => { void supabase.rpc("student_my_progress").then(({ data }) => { if (data) setProgress(data as ProgressCourse[]); }); }, []);
  useEffect(() => { void supabase.rpc("my_course_completions").then(({ data }) => setCerts((data ?? []) as Completion[])); }, []);
  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc("student_my_learning");
    if (e) { setError(e.message); return; }
    setError("");
    const list = ((data as { courses?: Course[] } | null)?.courses ?? []);
    setCourses(list);
    const today = new Date().toISOString().slice(0, 10);
    const current = list[0]?.units.find((u) => u.startDate && u.endDate && u.startDate <= today && today <= u.endDate) ?? list[0]?.units[0];
    if (current) setOpen((o) => o ?? `${list[0].enrolmentId}:${current.unitId}`);
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!open) return;
    const unitId = open.slice(open.indexOf(":") + 1);
    let active = true;
    void listResources(unitId).then(rows => {
      if (active) setImports(old => ({ ...old, [unitId]: rows.filter(r => r.published_at && r.audience === "student_staff") }));
    }).catch(e => {
      if (active && !/function.*lms_bulk_resources|schema cache/i.test(String(e))) setError("Published resources could not be loaded.");
    });
    return () => { active = false; };
  }, [open]);

  const openFile = async (item: Item) => {
    if (!item.path) return;
    const tab = window.open("", "_blank");
    const { data, error: e } = await supabase.storage.from("unit-content").createSignedUrl(item.path, 300);
    if (e || !data?.signedUrl) { tab?.close(); setError("This file could not be opened. Please try again."); return; }
    if (tab) { tab.opener = null; tab.location.href = data.signedUrl; } else window.location.href = data.signedUrl;
  };

  return (
    <div>
      <PageHeading eyebrow="Learning" title="My learning" description="Learn from your units' notes, files, links and videos, then practise with questions made from them." />
      <div className="mt-4 flex w-fit gap-1 rounded-lg border border-background-200 bg-white p-1" role="tablist" aria-label="Learn or practise">
        {([["learn", "Learn", "ri-book-open-line"], ["practice", "Practice", "ri-focus-3-line"]] as const).map(([id, label, icon]) => {
          const on = (id === "practice") === practiceTab;
          return <button key={id} type="button" role="tab" aria-selected={on}
            onClick={() => { const unit = params.get("unit"); setParams(id === "practice" ? { tab: "practice", ...(unit ? { unit } : {}) } : unit ? { unit } : {}); }}
            className={`inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-semibold ${on ? "bg-primary-600 text-white" : "text-foreground-700 hover:bg-background-100"}`}>
            <i className={icon} aria-hidden="true" />{label}</button>;
        })}
      </div>
      {practiceTab ? <div className="mt-5"><StudentPracticePage embedded /></div> : <>
      {error ? <div className="mt-4"><PortalError message={error} onRetry={() => void load()} /></div> : null}
      {courses === null && !error ? <PortalLoading label="Loading your courses…" /> : null}
      {courses && !courses.length ? <PortalEmpty icon="ri-book-open-line" title="No course yet" message="Once you are enrolled in a class, your units and learning materials appear here." /> : null}
      {progress.length ? (
        <section className="mt-6 rounded-card border border-background-200 bg-background-50 p-4">
          <h2 className="font-heading text-base font-semibold text-foreground-950">My progress</h2>
          <p className="mb-3 text-sm text-foreground-600">How much of your course you have finished and what is left.</p>
          <StudyProgress courses={progress} />
        </section>
      ) : null}
      {certs.length ? (
        <section className="mt-6 rounded-card border border-green-200 bg-green-50 p-4">
          <h2 className="font-heading text-base font-semibold text-green-900">My certificates</h2>
          <ul className="mt-2 space-y-1 text-sm">{certs.map((c) => (
            <li key={c.id}><Link to={`/certificate/${c.id}`} target="_blank" className="font-semibold text-green-800 underline">{c.kind === "certificate" ? "Certificate" : "Statement of attainment"}: {c.courseCode} {c.courseName}</Link> <span className="text-green-900">· No. {c.certificateNo}</span></li>
          ))}</ul>
        </section>
      ) : null}
      <div className="mt-6 space-y-6">
        {(courses ?? []).map((c) => (
          <section key={c.enrolmentId} className="rounded-card border border-background-200 bg-background-50">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-background-200 p-4">
              <div className="min-w-0">
                <h2 className="font-heading text-lg font-semibold text-foreground-950">{c.courseName}</h2>
                <p className="text-xs text-foreground-600">{[c.courseCode, `Class ${c.batchName}`, c.intakeStart ? `Started ${fmt(c.intakeStart)}` : "", c.status !== "active" ? c.status : ""].filter(Boolean).join(" · ")}</p>
              </div>
              <div className="text-right text-xs text-foreground-600">
                <p className="mb-1 font-semibold text-foreground-800">My attendance</p>
                <RateBadge counts={c.attendance} />
                {c.attendance.classes ? <p className="mt-1">{c.attendance.present + c.attendance.late} of {c.attendance.classes - c.attendance.excused} classes</p> : null}
              </div>
            </header>
            {!c.units.length ? <p className="p-4 text-sm text-foreground-500">No units have been set up for this class yet.</p> : (
              <ul className="divide-y divide-background-200">
                {c.units.map((u) => {
                  const key = `${c.enrolmentId}:${u.unitId}`;
                  const isOpen = open === key;
                  return (
                    <li key={key} id={`unit-${u.unitId}`} className={wantUnit === u.unitId ? "bg-primary-50/50" : undefined}>
                      <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-background-100">
                        <span className="min-w-0">
                          <span className="block font-semibold text-foreground-950">{u.code ? `${u.code} ` : ""}{u.name}</span>
                          <span className="block text-xs text-foreground-500">{u.startDate ? `${fmt(u.startDate)} – ${fmt(u.endDate)} · ` : ""}{u.items.length + (imports[u.unitId]?.length ?? 0)} items</span>
                        </span>
                        <i className={isOpen ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line"} aria-hidden="true" />
                      </button>
                      {isOpen ? (
                        <div className="space-y-3 px-4 pb-4">
                          {wantUnit === u.unitId && wantTopic ? <p className="rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-foreground-800">
                            <i className="ri-lightbulb-line mr-1 text-primary-700" aria-hidden="true" />Revising <b>{wantTopic}</b>: read the materials below, then go back to practise.</p> : null}
                          <Link className="inline-flex items-center gap-1 rounded-md border border-primary-200 px-3 py-1.5 text-sm font-semibold text-primary-800 dark:text-primary-300"
                            to={`/agency/learning?tab=practice&unit=${encodeURIComponent(u.unitId)}`}><i className="ri-focus-3-line" aria-hidden="true" />Practise this unit</Link>
                          {(imports[u.unitId] ?? []).map(resource => <div key={resource.id} className="rounded-lg border border-background-200 bg-white p-3">
                            <p className="text-xs text-foreground-600">{categoryLabel(resource.category)}</p>
                            <p className="font-semibold text-foreground-900">{resource.title}</p>
                            <button type="button" className="mt-2 text-sm font-semibold text-primary-700 underline"
                              onClick={() => void downloadResource(resource.path, resource.name).catch(() => setError("This file could not be opened."))}>Open {resource.name}</button>
                          </div>)}
                          {!u.items.length && !imports[u.unitId]?.length ? <p className="text-sm text-foreground-500">Your trainer has not added materials for this unit yet.</p> : u.items.map((it) => (
                            <div key={it.id} className="rounded-lg border border-background-200 bg-white p-3">
                              <p className="flex items-center gap-2 font-semibold text-foreground-900"><i className={KIND_ICON[it.kind]} aria-hidden="true" />{it.title}</p>
                              {it.body ? <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-700">{it.body}</p> : null}
                              {it.kind === "file" && it.path ? (
                                <button type="button" onClick={() => void openFile(it)} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary-700 hover:underline">
                                  <i className="ri-download-2-line" aria-hidden="true" />Open {it.fileName ?? "file"}{it.sizeBytes ? ` (${size(it.sizeBytes)})` : ""}
                                </button>
                              ) : null}
                              {(it.kind === "link" || it.kind === "video") && it.url ? (
                                <a href={it.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary-700 hover:underline">
                                  <i className={it.kind === "video" ? "ri-play-circle-line" : "ri-external-link-line"} aria-hidden="true" />{it.kind === "video" ? "Watch video" : "Open link"}
                                </a>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
      </>}
    </div>
  );
}
