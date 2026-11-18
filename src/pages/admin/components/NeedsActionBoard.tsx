import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";

type Item = { id: string; title: string; detail: string; at?: string | null; to: string };
type Area = { count: number; items: Item[] };
type Today = Record<string, Area>;

const AREAS: { key: string; label: string; icon: string; to: string; tone: string; empty: string }[] = [
  { key: "references", label: "Agent references to review", icon: "ri-shield-check-line", to: "/admin/businesses?status=Onboarding", tone: "text-amber-700 bg-amber-50", empty: "No references waiting for a decision." },
  { key: "applications", label: "Applications to review", icon: "ri-file-list-3-line", to: "/admin/applications", tone: "text-primary-700 bg-primary-50", empty: "No applications waiting." },
  { key: "documents", label: "Documents to check", icon: "ri-file-search-line", to: "/admin/applications", tone: "text-primary-700 bg-primary-50", empty: "No documents waiting." },
  { key: "unsignedOffers", label: "Offers not signed (3+ days)", icon: "ri-quill-pen-line", to: "/admin/applications", tone: "text-amber-700 bg-amber-50", empty: "No offers waiting on students." },
  { key: "unpaidDeposits", label: "Deposits not paid", icon: "ri-bank-card-line", to: "/admin/finance/payments", tone: "text-amber-700 bg-amber-50", empty: "Every signed offer is paid." },
  { key: "lowAttendance", label: "Attendance below 80%", icon: "ri-error-warning-line", to: "/admin/lms/attendance", tone: "text-red-700 bg-red-50", empty: "No one below 80%." },
  { key: "marking", label: "Assessments to mark", icon: "ri-edit-box-line", to: "/admin/lms/assessments", tone: "text-indigo-700 bg-indigo-50", empty: "Nothing waiting for marking." },
  { key: "tickets", label: "Open support tickets", icon: "ri-customer-service-2-line", to: "/admin/tickets", tone: "text-sky-700 bg-sky-50", empty: "No open tickets." },
  { key: "certificatesReady", label: "Ready for a certificate", icon: "ri-award-line", to: "/admin/lms/completion", tone: "text-green-700 bg-green-50", empty: "No one ready yet." },
  { key: "batchesWithoutClasses", label: "Intakes with no class dates", icon: "ri-calendar-close-line", to: "/admin/lms/intakes", tone: "text-red-700 bg-red-50", empty: "Every intake with students has classes." },
  { key: "classesToday", label: "Classes today", icon: "ri-calendar-2-line", to: "/admin/lms/timetable", tone: "text-foreground-700 bg-background-100", empty: "No classes today." },
];
const ago = (iso?: string | null) => {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
};

/** Dashboard: what needs action today (admin_today). Hidden for roles that cannot read it (website editors). */
export default function NeedsActionBoard() {
  const [data, setData] = useState<Today | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    Promise.all([supabase.rpc("admin_today"), supabase.rpc("lms_batches_without_classes")]).then(([today, extra]) => {
      if (!live) return;
      if (today.error) { setData(null); return; }
      setData({ ...(today.data as Today), ...(extra.error || !extra.data ? {} : { batchesWithoutClasses: extra.data as Area }) });
    });
    return () => { live = false; };
  }, []);
  if (data === null) return null;
  const total = data ? AREAS.filter((a) => a.key !== "classesToday").reduce((n, a) => n + (data[a.key]?.count ?? 0), 0) : 0;

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-lg font-semibold text-foreground-950">Needs action today</h2>
        {data ? <p className="text-sm text-foreground-600">{total ? `${total} thing${total === 1 ? "" : "s"} waiting` : "All clear"}</p> : <p className="text-sm text-foreground-500">Loading…</p>}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {AREAS.map((a) => {
          const area = data?.[a.key];
          const count = area?.count ?? 0;
          return (
            <div key={a.key} className="flex flex-col rounded-2xl border border-background-200 bg-background-50 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <span className={`flex h-9 w-9 items-center justify-center rounded-lg text-lg ${a.tone}`}><i className={a.icon} aria-hidden="true" /></span>
                <p className="min-w-0 flex-1 text-sm font-semibold text-foreground-900">{a.label}</p>
                <span className={`text-2xl font-bold tabular-nums ${count && a.key !== "classesToday" && a.key !== "certificatesReady" ? "text-foreground-950" : "text-foreground-500"}`}>{data ? count : "–"}</span>
              </div>
              {data ? (count ? (
                <ul className="mt-3 space-y-1.5">
                  {area!.items.map((it) => (
                    <li key={it.id}>
                      <Link to={it.to} className="block rounded-md px-2 py-1 hover:bg-background-100">
                        <span className="block truncate text-sm font-medium text-foreground-900">{it.title}</span>
                        <span className="block truncate text-xs text-foreground-500">{it.detail}{it.at && a.key !== "classesToday" ? ` · ${ago(it.at)}` : ""}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-3 text-sm text-foreground-500">{a.empty}</p>) : null}
              {data && count > (area?.items.length ?? 0) ? <Link to={a.to} className="mt-auto pt-2 text-sm font-semibold text-primary-700 hover:underline">See all {count}</Link>
                : data && count ? <Link to={a.to} className="mt-auto pt-2 text-sm font-semibold text-primary-700 hover:underline">Open</Link> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
