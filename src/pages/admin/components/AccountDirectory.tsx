import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "@/pages/admin/components/ui";
import { assignLicence, fetchDirectory, refreshMicrosoft365, removeLicences, useMicrosoft365, type DirectoryPage, type DirectoryRow, type DirectoryType } from "@/pages/admin/lib/microsoft365";

/*
 * Email Management > Account directory (owner 2026-11-21): the tenant's Microsoft 365 users, read live through student-office365
 * `directory` (never Graph from the browser), with who each one is in Skyline, and licence actions limited to the two Skyline
 * licences. Remove licence (one row or several selected) says plainly what the person loses; the server refuses the administrator's
 * own account, admin-role accounts and shared mailboxes. Every action is in Audit Logs.
 */
const panel = "rounded-xl border border-background-200 bg-white p-5 sm:p-6";
const field = "w-full rounded-lg border border-background-300 bg-white px-3 py-2.5 text-sm text-foreground-900 focus:outline-none focus:ring-2 focus:ring-primary-500";
const button = "rounded-lg border border-background-300 px-4 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100 disabled:opacity-50";
const TYPE_LABEL: Record<DirectoryType, string> = { student: "Student", employee: "Employee", trainer: "Trainer", agent: "Agent", not_linked: "Not linked", shared: "Shared" };
const PERSON_PATH = { student: "/admin/students/", employee: "/admin/staff/", trainer: "/admin/staff/", agent: "/admin/agents/" } as const;
export const REMOVE_WARNING = "They lose Outlook and Office apps. Their mailbox is kept for 30 days; reassigning a licence within 30 days restores it. After that it's permanently deleted.";

export default function AccountDirectory({ create }: { create: React.ReactNode }) {
  const { status, loading: statusLoading } = useMicrosoft365();
  const [search, setSearch] = useState(""); const [q, setQ] = useState("");
  const [type, setType] = useState(""); const [state, setState] = useState(""); const [page, setPage] = useState(1);
  const [data, setData] = useState<DirectoryPage | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DirectoryRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // Search after a short pause; filters and pages at once.
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 350); return () => clearTimeout(t); }, [search]);
  useEffect(() => {
    if (!status?.connected) return;
    let live = true; setLoading(true); setError("");
    void fetchDirectory({ q, type, status: state, page }).then((d) => { if (live) { setData(d); setSelected(new Set()); } }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : "The accounts could not be loaded."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [q, type, state, page, reload, status?.connected]);
  const refresh = useCallback(() => { setReload((n) => n + 1); void refreshMicrosoft365(); }, []);

  const student = status?.licences.find((l) => l.student) ?? null, staff = status?.licences.find((l) => l.staff) ?? null;
  const freeTotal = (student?.available ?? 0) + (staff?.available ?? 0);
  const cards: Array<[string, string, string, string]> = [
    ["Accounts", data ? String(data.counts.accounts) : "—", "ri-mail-line", data ? "Microsoft 365 users (guests left out)" : statusLoading ? "Checking Microsoft 365…" : "Needs the Microsoft 365 connection"],
    ["Active mailboxes", data ? String(data.counts.activeMailboxes) : "—", "ri-checkbox-circle-line", "Sign-in enabled, with an Exchange licence"],
    ["Licences available", status?.connected ? String(freeTotal) : "—", "ri-key-2-line", status?.connected ? `${student?.available ?? 0} student · ${staff?.available ?? 0} staff free` : "Needs the Microsoft 365 connection"],
  ];

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const removable = useMemo(() => rows.filter((r) => r.canRemove), [rows]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const doRemove = async (list: DirectoryRow[]) => {
    setBusy(true); setNotice(null);
    try {
      const r = await removeLicences(list.map((x) => x.id));
      const refused = r.results.filter((x) => !x.ok);
      setNotice({ tone: refused.length ? "error" : "ok", text: `Licence removed from ${r.removed} account${r.removed === 1 ? "" : "s"}.${refused.length ? ` Not removed: ${refused.map((x) => `${x.upn || x.id} (${x.error})`).join("; ")}.` : ""}` });
    } catch (e) { setNotice({ tone: "error", text: e instanceof Error ? e.message : "The licences could not be removed." }); }
    finally { setBusy(false); setConfirm(null); refresh(); }
  };
  const doAssign = async (row: DirectoryRow) => {
    setBusy(true); setNotice(null); setMenu(null);
    try { const r = await assignLicence(row.id); setNotice({ tone: "ok", text: `${r.licence} assigned to ${r.upn}.` }); }
    catch (e) { setNotice({ tone: "error", text: e instanceof Error ? e.message : "The licence could not be assigned." }); }
    finally { setBusy(false); refresh(); }
  };

  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-3">
      {cards.map(([name, value, icon, note]) => <div key={name} className={panel} data-testid={`email-card-${name.toLowerCase().replace(/\s+/g, "-")}`}>
        <i className={icon + " text-xl text-foreground-500"} aria-hidden="true" /><p className="mt-3 text-sm text-foreground-600">{name}</p><p className="mt-1 text-2xl font-semibold">{value}</p><p className="mt-1 text-xs text-foreground-500">{note}</p>
      </div>)}
    </div>
    <section className={panel}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Account directory</h2>{create}</div>
      <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto_auto]">
        <div className="relative"><label htmlFor="account-search" className="sr-only">Search email accounts</label><i className="ri-search-line absolute left-3 top-3 text-foreground-500" aria-hidden="true" />
          <input id="account-search" className={field + " pl-9"} placeholder="Search by name, email or person type" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="directory-search" /></div>
        <select aria-label="Type" className={field} value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} data-testid="directory-type">
          <option value="">All types (not shared)</option>{(Object.keys(TYPE_LABEL) as DirectoryType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}{data ? ` (${data.counts.byType[t] ?? 0})` : ""}</option>)}</select>
        <select aria-label="Status" className={field} value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} data-testid="directory-status">
          <option value="">Any status</option><option value="enabled">Enabled</option><option value="blocked">Sign-in blocked</option></select>
      </div>
      {data && !data.adminRolesReadable ? <p role="status" className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="directory-admin-roles">
        Removing licences is switched off until Skyline can check which accounts hold an admin role: add the Microsoft Graph application permission <strong>{data.adminRolePermission}</strong> with admin consent.</p> : null}
      {notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={`mb-3 rounded-md border p-3 text-sm ${notice.tone === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`} data-testid="directory-notice">{notice.text}</p> : null}
      {selected.size ? <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-background-200 bg-background-50 p-3 text-sm" data-testid="directory-bulk">
        <span>{selected.size} selected</span>
        <button type="button" className={button + " border-red-200 text-red-700 hover:bg-red-50"} disabled={busy} onClick={() => setConfirm(rows.filter((r) => selected.has(r.id)))} data-testid="directory-bulk-remove">Remove licence</button>
        <button type="button" className="text-foreground-600 underline" onClick={() => setSelected(new Set())}>Clear</button></div> : null}
      {!status?.connected ? <p className="py-10 text-center text-sm text-foreground-600">{statusLoading ? "Checking Microsoft 365…" : "Connect Microsoft 365 to list the accounts."}</p>
        : error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
        : <div className={`overflow-x-auto ${loading ? "opacity-60" : ""}`}><table className="w-full min-w-[760px] text-left text-sm" data-testid="directory-table">
          <thead className="border-b border-background-200 text-foreground-600"><tr>
            <th className="w-8 px-3 py-3"><input type="checkbox" aria-label="Select every account whose licence can be removed" checked={removable.length > 0 && removable.every((r) => selected.has(r.id))} disabled={!removable.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(removable.map((r) => r.id)) : new Set())} /></th>
            {["Person", "Email address", "Type", "Status", "Licence", ""].map((h) => <th key={h || "actions"} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>{!data ? <tr><td colSpan={7} className="py-10 text-center text-foreground-500">Loading accounts…</td></tr>
            : !rows.length ? <tr><td colSpan={7} className="py-10 text-center text-foreground-500">{q || type || state ? "No account matches." : "No accounts."}</td></tr>
            : rows.map((r) => <tr key={r.id} className="border-b border-background-100 align-top" data-testid={`directory-row-${r.id}`}>
              <td className="px-3 py-3"><input type="checkbox" aria-label={`Select ${r.upn}`} disabled={!r.canRemove} title={r.removeBlocked ?? undefined} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
              <td className="px-3 py-3">{r.person ? <Link to={PERSON_PATH[r.person.kind] + r.person.id} className="font-medium text-primary-700 hover:underline">{r.person.name || r.name}</Link>
                : <><span className="font-medium text-foreground-900">{r.name || "—"}</span><span className="block text-xs text-foreground-500">Not in Skyline</span></>}
                {r.self ? <span className="block text-xs text-foreground-500">Your account</span> : null}{r.admin ? <span className="block text-xs text-amber-800">Admin role</span> : null}</td>
              <td className="px-3 py-3 break-all">{r.upn}{r.mail && r.mail !== r.upn ? <span className="block text-xs text-foreground-500">{r.mail}</span> : null}</td>
              <td className="px-3 py-3">{TYPE_LABEL[r.type]}</td>
              <td className="px-3 py-3">{r.enabled ? <span className="text-emerald-700">Enabled</span> : <span className="text-foreground-600">Sign-in blocked</span>}</td>
              <td className="px-3 py-3">{r.licences.filter((l) => l.skyline).map((l) => l.name).join(", ") || "None"}
                {r.licences.some((l) => !l.skyline) ? <span className="block text-xs text-foreground-500">+ {r.licences.filter((l) => !l.skyline).length} other</span> : null}</td>
              <td className="relative px-3 py-3 text-right">
                {/* 2026-11-21: Remove licence is offered only where it is allowed (never your own account, an admin-role account or a shared mailbox). */}
                {r.canRemove || r.assign ? <button type="button" aria-label={`Actions for ${r.upn}`} className="rounded px-2 py-1 text-lg leading-none hover:bg-background-100" onClick={() => setMenu(menu === r.id ? null : r.id)} data-testid={`directory-menu-${r.id}`}>⋯</button> : null}
                {menu === r.id ? <div className="absolute right-3 top-10 z-20 w-56 rounded-lg border border-background-200 bg-white py-1 text-left shadow-lg" role="menu">
                  {r.canRemove ? <button type="button" role="menuitem" disabled={busy}
                    className="block w-full px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-foreground-400" onClick={() => { setMenu(null); setConfirm([r]); }} data-testid={`directory-remove-${r.id}`}>
                    Remove licence</button> : null}
                  {r.assign ? <button type="button" role="menuitem" disabled={busy} className="block w-full px-3 py-2 text-left text-sm hover:bg-background-100" onClick={() => void doAssign(r)} data-testid={`directory-assign-${r.id}`}>Assign licence ({r.assign.name})</button> : null}
                </div> : null}
              </td></tr>)}</tbody></table></div>}
      {data && data.pages > 1 ? <div className="mt-4 flex items-center justify-between text-sm" data-testid="directory-pager">
        <span className="text-foreground-600">{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}</span>
        <span className="flex gap-2"><button type="button" className={button} disabled={data.page <= 1 || loading} onClick={() => setPage(data.page - 1)}>Previous</button>
          <button type="button" className={button} disabled={data.page >= data.pages || loading} onClick={() => setPage(data.page + 1)}>Next</button></span></div>
        : data ? <p className="mt-3 text-xs text-foreground-500">{data.total} account{data.total === 1 ? "" : "s"}</p> : null}
    </section>
    <ConfirmDialog open={!!confirm} title={confirm && confirm.length > 1 ? `Remove the licence from ${confirm.length} accounts?` : `Remove the licence from ${confirm?.[0]?.upn ?? "this account"}?`}
      message={REMOVE_WARNING} confirmLabel={busy ? "Removing…" : "Remove licence"} onConfirm={() => { if (confirm && !busy) void doRemove(confirm); }} onCancel={() => { if (!busy) setConfirm(null); }} />
  </div>;
}
