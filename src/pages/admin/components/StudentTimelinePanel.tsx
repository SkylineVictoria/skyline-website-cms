import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";

type Entry = { at: string; kind: string; title: string; detail: string; application_id: string | null };

const KINDS: Record<string, { label: string; icon: string; tone: string }> = {
  student: { label: "Record", icon: "ri-user-add-line", tone: "bg-background-200 text-foreground-700" },
  application: { label: "Applications", icon: "ri-file-list-3-line", tone: "bg-primary-100 text-primary-800" },
  status: { label: "Applications", icon: "ri-flag-line", tone: "bg-primary-100 text-primary-800" },
  offer: { label: "Offer & payment", icon: "ri-file-paper-2-line", tone: "bg-amber-100 text-amber-800" },
  payment: { label: "Offer & payment", icon: "ri-bank-card-line", tone: "bg-green-100 text-green-800" },
  coe: { label: "Offer & payment", icon: "ri-award-line", tone: "bg-green-100 text-green-800" },
  enrolment: { label: "Study", icon: "ri-group-line", tone: "bg-indigo-100 text-indigo-800" },
  assessment: { label: "Study", icon: "ri-edit-box-line", tone: "bg-indigo-100 text-indigo-800" },
  account: { label: "Study", icon: "ri-mail-settings-line", tone: "bg-indigo-100 text-indigo-800" },
  attendance: { label: "Study", icon: "ri-calendar-check-line", tone: "bg-red-100 text-red-700" },
  certificate: { label: "Study", icon: "ri-award-line", tone: "bg-green-100 text-green-800" },
  message: { label: "Messages", icon: "ri-chat-3-line", tone: "bg-sky-100 text-sky-800" },
  email: { label: "Messages", icon: "ri-mail-line", tone: "bg-sky-100 text-sky-800" },
};
const FILTERS = ["All", "Applications", "Offer & payment", "Study", "Messages"];
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Student page: everything that happened to this student, newest first, in one list. */
export default function StudentTimelinePanel({ studentId }: { studentId: string }) {
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("All");
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    setRows(null); setError("");
    supabase.rpc("admin_student_timeline", { p_student: studentId }).then(({ data, error: e }) => {
      if (!live) return;
      if (e) setError(e.message); else setRows((data ?? []) as Entry[]);
    });
    return () => { live = false; };
  }, [studentId]);
  const shown = useMemo(() => (rows ?? []).filter((r) => filter === "All" || (KINDS[r.kind]?.label ?? "") === filter), [rows, filter]);
  const visible = all ? shown : shown.slice(0, 25);

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-base font-semibold text-foreground-900">Timeline {rows ? <span className="font-normal text-foreground-500">{rows.length}</span> : null}</h2>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); setAll(false); }}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === f ? "bg-primary-600 text-white" : "bg-background-100 text-foreground-700 hover:bg-background-200"}`}>{f}</button>
          ))}
        </div>
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : rows === null ? <p className="text-sm text-foreground-500">Loading timeline…</p>
        : !shown.length ? <p className="text-sm text-foreground-500">Nothing here yet.</p> : (
          <>
            <ol className="relative ml-3 border-l border-background-200">
              {visible.map((r, i) => {
                const k = KINDS[r.kind] ?? KINDS.student;
                return (
                  <li key={`${r.at}-${i}`} className="relative mb-4 ml-6">
                    <span className={`absolute -left-[37px] flex h-6 w-6 items-center justify-center rounded-full text-xs ring-4 ring-background-50 ${k.tone}`}><i className={k.icon} aria-hidden="true" /></span>
                    <p className="text-sm font-semibold text-foreground-900">{r.title}</p>
                    {r.detail ? <p className="line-clamp-2 text-sm text-foreground-600">{r.detail}</p> : null}
                    <p className="text-xs text-foreground-500">{when(r.at)}{r.application_id ? <> · <Link to={`/admin/applications/${r.application_id}`} className="text-primary-700 hover:underline">Open application</Link></> : null}</p>
                  </li>
                );
              })}
            </ol>
            {shown.length > visible.length ? <button type="button" onClick={() => setAll(true)} className="text-sm font-semibold text-primary-700 hover:underline">Show all {shown.length}</button> : null}
          </>
        )}
    </Card>
  );
}
