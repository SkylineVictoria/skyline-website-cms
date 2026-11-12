import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_CLASS, STATUS_LABEL, listTickets, type TicketRow } from "@/lib/supportTickets";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "active", label: "Active" }, { value: "", label: "All" }, { value: "resolved", label: "Resolved" }, { value: "closed", label: "Closed" },
];

/** Ticket list for both the portal (own / agency tickets) and the CMS (all tickets, with scope filter). */
export default function TicketList({ linkTo, handler = false, reloadKey = 0 }: { linkTo: (id: string) => string; handler?: boolean; reloadKey?: number }) {
  const [status, setStatus] = useState("active");
  const [scope, setScope] = useState<"all" | "mine" | "unassigned">("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const r = await listTickets({ status, search: query, scope: handler ? scope : "all", limit: 100 });
      setRows(r.rows); setTotal(r.total); setState("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load the tickets."); setState("error");
    }
  }, [status, query, scope, handler]);
  useEffect(() => { void load(); }, [load, reloadKey]);

  return (
    <section className="rounded-lg border border-background-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-background-200 p-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <button key={f.label} type="button" onClick={() => setStatus(f.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${status === f.value ? "bg-foreground-900 text-white" : "text-foreground-700 hover:bg-background-100"}`}>
              {f.label}
            </button>
          ))}
        </div>
        {handler ? (
          <select aria-label="Assigned" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className="rounded-md border border-background-300 px-2 py-1.5 text-sm">
            <option value="all">Everyone&apos;s</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option>
          </select>
        ) : null}
        <form className="ml-auto flex min-w-[200px] flex-1 sm:flex-none" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
          <input aria-label="Search tickets" placeholder="Search ref, subject, name" value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-background-300 px-3 py-1.5 text-sm" />
        </form>
      </div>
      {state === "loading" ? <p className="p-5 text-sm text-foreground-600">Loading tickets&hellip;</p>
        : state === "error" ? <p role="alert" className="p-5 text-sm text-red-700">{error} <button type="button" className="underline" onClick={() => void load()}>Retry</button></p>
        : rows.length === 0 ? <p className="p-8 text-center text-sm text-foreground-600">No tickets here.</p>
        : (
          <ul className="divide-y divide-background-200">
            {rows.map((t) => (
              <li key={t.id}>
                <Link to={linkTo(t.id)} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 hover:bg-background-50">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      {t.unread ? <span className="h-2 w-2 rounded-full bg-primary-600" aria-label="New activity" /> : null}
                      <span className="font-mono text-xs text-foreground-500">{t.ref}</span>
                      <span className={`truncate font-semibold ${t.unread ? "text-foreground-950" : "text-foreground-800"}`}>{t.subject}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-foreground-600">
                      {CATEGORY_LABEL[t.category]} &middot; {t.requesterName}{t.requesterRole === "student" ? " (student)" : t.agencyName ? ` (${t.agencyName})` : ""}
                      {t.studentName && t.requesterRole !== "student" ? <> &middot; about {t.studentName}</> : null}
                      {handler && t.assignedName ? <> &middot; {t.assignedName}</> : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    {t.priority === "high" || t.priority === "urgent" ? <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-800">{PRIORITY_LABEL[t.priority]}</span> : null}
                    <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_CLASS[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                    <span className="text-foreground-500">{new Date(t.lastMessageAt).toLocaleDateString()}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      {state === "ready" && total > rows.length ? <p className="border-t border-background-200 p-3 text-xs text-foreground-500">Showing {rows.length} of {total}. Search to narrow down.</p> : null}
    </section>
  );
}
