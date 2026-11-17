import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { PageHeading, PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
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
  const [open, setOpen] = useState<string | null>(null);
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

  const openFile = async (item: Item) => {
    if (!item.path) return;
    const tab = window.open("", "_blank");
    const { data, error: e } = await supabase.storage.from("unit-content").createSignedUrl(item.path, 300);
    if (e || !data?.signedUrl) { tab?.close(); setError("This file could not be opened. Please try again."); return; }
    if (tab) { tab.opener = null; tab.location.href = data.signedUrl; } else window.location.href = data.signedUrl;
  };

  return (
    <div>
      <PageHeading eyebrow="Learning" title="My learning" description="Notes, files, links and videos for each unit of your course, and your attendance." />
      {error ? <div className="mt-4"><PortalError message={error} onRetry={() => void load()} /></div> : null}
      {courses === null && !error ? <PortalLoading label="Loading your courses…" /> : null}
      {courses && !courses.length ? <PortalEmpty icon="ri-book-open-line" title="No course yet" message="Once you are enrolled in a class, your units and learning materials appear here." /> : null}
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
                    <li key={key}>
                      <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-background-100">
                        <span className="min-w-0">
                          <span className="block font-semibold text-foreground-950">{u.code ? `${u.code} ` : ""}{u.name}</span>
                          <span className="block text-xs text-foreground-500">{u.startDate ? `${fmt(u.startDate)} – ${fmt(u.endDate)} · ` : ""}{u.items.length} item{u.items.length === 1 ? "" : "s"}</span>
                        </span>
                        <i className={isOpen ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line"} aria-hidden="true" />
                      </button>
                      {isOpen ? (
                        <div className="space-y-3 px-4 pb-4">
                          {!u.items.length ? <p className="text-sm text-foreground-500">Your trainer has not added materials for this unit yet.</p> : u.items.map((it) => (
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
    </div>
  );
}
