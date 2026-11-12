import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import SegmentedControl from "@/components/shared/application-form/SegmentedControl";
import Toast from "@/components/shared/application-form/Toast";
import { useToast } from "@/components/shared/application-form/useToast";
import ActionDrawer, { ConfirmDialog } from "@/components/shared/application-status/ActionDrawer";
import { badgeColors, refreshApplicationStatuses } from "@/lib/applicationStatuses";

/**
 * Settings › Application statuses (admins; the database's RLS allows only admins to write): the statuses (label, colour, order,
 * active, final), the transitions from each status (label, target, icon, primary, reason, roles, active; the automatic ones locked)
 * and the reasons offered per status ("Other" last). Every change is audited (History) and reaches every open page at once.
 */
interface StatusRow { value: string; label: string; sort: number; color: string; is_final: boolean; is_active: boolean; legacy: boolean; hint: string; tone: string }
interface TransitionRow {
  from_status: string; action_key: string; to_status: string | null; actor: string; label: string; kind: string; note: string; tone: string; sort: number;
  is_active: boolean; is_automatic: boolean; is_primary: boolean; requires_reason: boolean; allowed_roles: string[]; icon: string;
}
interface ReasonRow { id: string; status: string; label: string; sort: number; is_other: boolean; is_active: boolean }
interface HistoryRow { id: number; rowKey: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; by: string; at: string }
type Tab = "statuses" | "transitions" | "reasons";
const TABLE: Record<Tab, string> = { statuses: "application_statuses", transitions: "application_status_transitions", reasons: "status_reasons" };
/** The roles the app has (cms_users.role, tenant_memberships.role) that can review applications. */
const STAFF_ROLES = [{ value: "Admin", label: "Admin" }, { value: "tenant_admin", label: "Tenant admin" }, { value: "staff", label: "Staff (tenant)" }];
const INPUT = "h-8 w-full rounded-md border border-background-300 bg-background-50 px-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40 disabled:opacity-60";
const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "s_$1").slice(0, 40);

function Badge({ label, color }: { label: string; color: string }) {
  return <span className="inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold" style={badgeColors(color) ?? undefined}>{label || "Label"}</span>;
}
function Toggle({ checked, disabled, label, title, onChange, testId }: { checked: boolean; disabled?: boolean; label: string; title?: string; onChange: (value: boolean) => void; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title ?? label} disabled={disabled} onClick={() => onChange(!checked)} data-testid={testId}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-primary-500" : "bg-background-300"}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

export default function ApplicationStatusesPage() {
  const [tab, setTab] = useState<Tab>("statuses");
  const [statuses, setStatuses] = useState<StatusRow[] | null>(null);
  const [transitions, setTransitions] = useState<TransitionRow[]>([]);
  const [reasons, setReasons] = useState<ReasonRow[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StatusRow | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const [s, t, r, u] = await Promise.all([
      supabase.from("application_statuses").select("value,label,sort,color,is_final,is_active,legacy,hint,tone").order("sort"),
      supabase.from("application_status_transitions").select("*").order("sort"),
      supabase.from("status_reasons").select("*").order("sort"),
      supabase.rpc("application_status_usage"),
    ]);
    const failed = s.error ?? t.error ?? r.error ?? u.error;
    if (failed) { setError(failed.message); setStatuses((prev) => prev ?? []); return; }
    setStatuses(s.data as StatusRow[]); setTransitions(t.data as TransitionRow[]); setReasons(r.data as ReasonRow[]); setUsage((u.data ?? {}) as Record<string, number>); setError("");
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** One write, then the page and every open page read the configuration again. Errors show and nothing is assumed saved. */
  const save = async (work: () => PromiseLike<{ error: { message: string } | null }>, done = "Saved.") => {
    const { error: failed } = await work();
    if (failed) { setError(failed.message); toast.show(failed.message); await load(); return false; }
    setError(""); toast.show(done);
    await Promise.all([load(), refreshApplicationStatuses()]);
    return true;
  };
  const updateStatus = (value: string, patch: Partial<StatusRow>, done?: string) => save(() => supabase.from("application_statuses").update(patch).eq("value", value), done);
  const updateTransition = (row: TransitionRow, patch: Partial<TransitionRow>, done?: string) =>
    save(() => supabase.from("application_status_transitions").update(patch).eq("from_status", row.from_status).eq("action_key", row.action_key), done);
  const updateReason = (id: string, patch: Partial<ReasonRow>, done?: string) => save(() => supabase.from("status_reasons").update(patch).eq("id", id), done);

  const labelOf = useMemo(() => new Map((statuses ?? []).map((s) => [s.value, s.label])), [statuses]);
  const openHistory = async () => {
    setHistory([]);
    const { data, error: failed } = await supabase.rpc("status_config_history", { p_table: TABLE[tab], p_limit: 200 });
    if (failed) { setError(failed.message); setHistory(null); return; }
    setHistory(data as HistoryRow[]);
  };

  /* -------------------------------------------------------------- statuses */
  const [newStatus, setNewStatus] = useState({ label: "", color: "#2563eb" });
  const addStatus = async () => {
    const key = slug(newStatus.label);
    if (!key || key.length < 2) { setError("Give the status a label."); return; }
    const sort = Math.max(0, ...(statuses ?? []).map((s) => s.sort)) + 10;
    if (await save(() => supabase.from("application_statuses").insert({ value: key, label: newStatus.label.trim(), sort, color: newStatus.color, tone: "neutral" }), `Status “${newStatus.label.trim()}” added (key ${key}).`)) setNewStatus({ label: "", color: "#2563eb" });
  };
  /** Drag to reorder: every row gets its new place (two steps, as each place is unique). */
  const reorder = async (fromKey: string, toKey: string) => {
    if (!statuses || fromKey === toKey) return;
    const list = [...statuses];
    const from = list.findIndex((s) => s.value === fromKey), to = list.findIndex((s) => s.value === toKey);
    list.splice(to, 0, list.splice(from, 1)[0]);
    setStatuses(list);
    for (const [i, s] of list.entries()) { const { error: failed } = await supabase.from("application_statuses").update({ sort: 100000 + i }).eq("value", s.value); if (failed) { setError(failed.message); await load(); return; } }
    await save(async () => {
      for (const [i, s] of list.entries()) { const { error: failed } = await supabase.from("application_statuses").update({ sort: (i + 1) * 10 }).eq("value", s.value); if (failed) return { error: failed }; }
      return { error: null };
    }, "Order saved.");
  };

  const statusesTab = (
    <div className="space-y-3" data-testid="statuses-tab">
      <div className="overflow-x-auto rounded-lg border border-background-200">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-background-100 text-left text-xs text-foreground-600"><tr>
            <th className="w-8 px-2 py-2" /><th className="px-2 py-2 font-medium">Label</th><th className="px-2 py-2 font-medium">Key</th><th className="px-2 py-2 font-medium">Colour</th>
            <th className="px-2 py-2 font-medium">Badge</th><th className="px-2 py-2 font-medium">Active</th><th className="px-2 py-2 font-medium">Final</th><th className="px-2 py-2 font-medium">In use</th><th />
          </tr></thead>
          <tbody className="divide-y divide-background-200">
            {(statuses ?? []).map((s) => {
              const used = usage[s.value] ?? 0;
              return (
                <tr key={s.value} draggable onDragStart={() => setDrag(s.value)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag) void reorder(drag, s.value); setDrag(null); }}
                  className={drag === s.value ? "opacity-50" : ""} data-testid="status-row" data-key={s.value}>
                  <td className="cursor-grab px-2 text-foreground-400" title="Drag to reorder"><i className="ri-draggable" aria-hidden="true" /></td>
                  <td className="px-2 py-1.5"><input defaultValue={s.label} aria-label={`Label of ${s.value}`} className={INPUT} data-testid="status-label"
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.label) void updateStatus(s.value, { label: v }, `Renamed to “${v}”.`); }} /></td>
                  <td className="px-2 py-1.5"><code className="text-xs text-foreground-600" title="The key cannot change">{s.value}</code>{s.legacy ? <span className="ml-1 text-[10px] text-foreground-400">legacy</span> : null}</td>
                  <td className="px-2 py-1.5"><input type="color" value={s.color} aria-label={`Colour of ${s.label}`} className="h-8 w-10 cursor-pointer rounded border border-background-300"
                    onChange={(e) => setStatuses((list) => (list ?? []).map((x) => (x.value === s.value ? { ...x, color: e.target.value } : x)))}
                    onBlur={(e) => void updateStatus(s.value, { color: e.target.value.toLowerCase() }, "Colour saved.")} /></td>
                  <td className="px-2 py-1.5"><Badge label={s.label} color={s.color} /></td>
                  <td className="px-2 py-1.5"><Toggle checked={s.is_active} label={`Active: ${s.label}`} disabled={s.is_active && used > 0} testId="status-active"
                    title={s.is_active && used > 0 ? `${used} application(s) use it: it cannot be deactivated` : undefined} onChange={(v) => void updateStatus(s.value, { is_active: v })} /></td>
                  <td className="px-2 py-1.5"><input type="checkbox" checked={s.is_final} aria-label={`Final: ${s.label}`} className="h-4 w-4 accent-primary-600" onChange={(e) => void updateStatus(s.value, { is_final: e.target.checked })} /></td>
                  <td className="px-2 py-1.5 text-xs text-foreground-600">{used}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button type="button" disabled={used > 0} title={used > 0 ? `${used} application(s) use it` : "Delete"} onClick={() => setConfirmDelete(s)}
                      className="rounded p-1 text-foreground-500 hover:bg-background-100 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40" aria-label={`Delete ${s.label}`}><i className="ri-delete-bin-line" aria-hidden="true" /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-background-300 p-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-foreground-700">New status
          <input value={newStatus.label} onChange={(e) => setNewStatus({ ...newStatus, label: e.target.value })} placeholder="e.g. Deferred" className={`${INPUT} w-56`} data-testid="new-status-label" />
        </label>
        <span className="pb-1.5 text-xs text-foreground-500">key: <code>{slug(newStatus.label) || "…"}</code></span>
        <input type="color" value={newStatus.color} aria-label="Colour of the new status" onChange={(e) => setNewStatus({ ...newStatus, color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-background-300" />
        <Badge label={newStatus.label} color={newStatus.color} />
        <button type="button" onClick={() => void addStatus()} disabled={!newStatus.label.trim()} data-testid="add-status"
          className="h-8 rounded-md bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600 disabled:opacity-50">Add status</button>
      </div>
    </div>
  );

  /* -------------------------------------------------------------- transitions */
  const [newTransition, setNewTransition] = useState<Record<string, { label: string; to: string }>>({});
  const activeStatuses = (statuses ?? []).filter((s) => s.is_active);
  const setPrimary = async (row: TransitionRow, value: boolean) => {
    if (value) {
      // One primary per status: the current one stops being primary first.
      for (const other of transitions.filter((t) => t.from_status === row.from_status && t.is_primary && t.action_key !== row.action_key && !t.is_automatic)) {
        const { error: failed } = await supabase.from("application_status_transitions").update({ is_primary: false }).eq("from_status", other.from_status).eq("action_key", other.action_key);
        if (failed) { setError(failed.message); return; }
      }
    }
    await updateTransition(row, { is_primary: value, tone: value ? "primary" : row.tone === "primary" ? "neutral" : row.tone }, value ? `“${row.label}” is the primary action.` : "Saved.");
  };
  const addTransition = async (from: string) => {
    const draft = newTransition[from] ?? { label: "", to: "" };
    const key = slug(draft.label);
    if (!key || !draft.to) { setError("Give the action a label and a target status."); return; }
    const sort = Math.max(0, ...transitions.filter((t) => t.from_status === from).map((t) => t.sort)) + 5;
    if (await save(() => supabase.from("application_status_transitions").insert({ from_status: from, action_key: key, to_status: draft.to, actor: "staff", label: draft.label.trim(), kind: "status",
      note: "optional", tone: "neutral", sort, allowed_roles: ["Admin", "tenant_admin", "staff"] }), `Action “${draft.label.trim()}” added.`)) setNewTransition((all) => ({ ...all, [from]: { label: "", to: "" } }));
  };
  const transitionsTab = (
    <div className="space-y-4" data-testid="transitions-tab">
      {activeStatuses.filter((s) => !s.legacy).map((s) => {
        const rows = transitions.filter((t) => t.from_status === s.value).sort((a, b) => a.sort - b.sort);
        const dead = !s.is_final && !rows.some((t) => t.is_active && t.to_status);
        const draft = newTransition[s.value] ?? { label: "", to: "" };
        return (
          <section key={s.value} className="rounded-lg border border-background-200" data-testid="transition-group" data-from={s.value}>
            <header className="flex flex-wrap items-center gap-2 border-b border-background-200 bg-background-100/60 px-3 py-2">
              <span className="text-xs text-foreground-500">From</span><Badge label={s.label} color={s.color} />
              {s.is_final ? <span className="text-xs text-foreground-500">Final: no actions</span> : null}
              {dead ? <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-amber-800" data-testid="dead-end-warning"><i className="ri-error-warning-line" aria-hidden="true" />No outgoing transition: applications in this status get stuck</span> : null}
            </header>
            {rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-wide text-foreground-500"><tr>
                    <th className="px-2 py-1.5 font-medium">Label</th><th className="px-2 py-1.5 font-medium">Target</th><th className="px-2 py-1.5 font-medium">Icon</th><th className="px-2 py-1.5 font-medium">Primary</th>
                    <th className="px-2 py-1.5 font-medium">Reason</th><th className="px-2 py-1.5 font-medium">Allowed roles</th><th className="px-2 py-1.5 font-medium">Active</th>
                  </tr></thead>
                  <tbody className="divide-y divide-background-200">
                    {rows.map((t) => {
                      const locked = t.is_automatic;
                      return (
                        <tr key={t.action_key} data-testid="transition-row" data-action={t.action_key} className={t.is_active ? "" : "opacity-60"}>
                          <td className="px-2 py-1.5">
                            <span className="flex items-center gap-1.5">
                              {locked ? <i className="ri-lock-line text-foreground-400" title="Automatic: happens when the student or agent acts" aria-label="Automatic" /> : null}
                              <input defaultValue={t.label} aria-label={`Label of ${t.action_key}`} disabled={locked} className={INPUT}
                                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.label) void updateTransition(t, { label: v }, `Renamed to “${v}”.`); }} />
                            </span>
                            {locked ? <span className="text-[11px] text-foreground-500">Automatic ({t.kind === "accept_offer" ? "when the offer is accepted" : t.kind === "resubmit" ? "on resubmit" : "by the applicant"})</span> : null}
                          </td>
                          <td className="px-2 py-1.5">
                            {t.to_status === null ? <span className="text-xs text-foreground-500">Keeps the status</span> : (
                              <select value={t.to_status} disabled={locked || t.kind !== "status"} aria-label={`Target of ${t.label}`} className={INPUT}
                                onChange={(e) => void updateTransition(t, { to_status: e.target.value }, "Target saved.")}>
                                {activeStatuses.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                              </select>
                            )}
                          </td>
                          <td className="px-2 py-1.5">
                            <span className="flex items-center gap-1.5"><i className={`${t.icon || "ri-checkbox-blank-circle-line"} text-base text-foreground-600`} aria-hidden="true" />
                              <input defaultValue={t.icon} disabled={locked} aria-label={`Icon of ${t.label}`} placeholder="ri-…" className={`${INPUT} w-36`}
                                onBlur={(e) => { const v = e.target.value.trim(); if (v !== t.icon) void updateTransition(t, { icon: v }, "Icon saved."); }} /></span>
                          </td>
                          <td className="px-2 py-1.5"><input type="radio" name={`primary-${s.value}`} checked={t.is_primary} disabled={locked || !t.is_active} aria-label={`Primary: ${t.label}`}
                            className="h-4 w-4 accent-primary-600" onChange={() => void setPrimary(t, true)} /></td>
                          <td className="px-2 py-1.5"><input type="checkbox" checked={t.requires_reason} disabled={locked || t.kind !== "status"} aria-label={`Requires a reason: ${t.label}`}
                            className="h-4 w-4 accent-primary-600" onChange={(e) => void updateTransition(t, { requires_reason: e.target.checked, note: e.target.checked ? "required" : "optional" })} /></td>
                          <td className="px-2 py-1.5">
                            {locked ? <span className="text-xs text-foreground-600">{t.allowed_roles.join(", ")}</span> : (
                              <span className="flex flex-wrap gap-x-3 gap-y-1">
                                {STAFF_ROLES.map((role) => (
                                  <label key={role.value} className="flex items-center gap-1 text-xs text-foreground-800">
                                    <input type="checkbox" className="h-3.5 w-3.5 accent-primary-600" checked={t.allowed_roles.includes(role.value)}
                                      onChange={(e) => void updateTransition(t, { allowed_roles: e.target.checked ? [...t.allowed_roles, role.value] : t.allowed_roles.filter((r) => r !== role.value) }, "Roles saved.")} />
                                    {role.label}
                                  </label>
                                ))}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5"><Toggle checked={t.is_active} disabled={locked} label={`Active: ${t.label}`} testId="transition-active"
                            onChange={(v) => void updateTransition(t, { is_active: v, ...(v ? {} : { is_primary: false }) }, v ? "Turned on." : "Turned off.")} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="px-3 py-2 text-sm text-foreground-500">No transitions.</p>}
            {!s.is_final ? (
              <div className="flex flex-wrap items-end gap-2 border-t border-dashed border-background-200 px-3 py-2">
                <input value={draft.label} placeholder="New action, e.g. Defer" aria-label={`New action from ${s.label}`} className={`${INPUT} w-52`}
                  onChange={(e) => setNewTransition((all) => ({ ...all, [s.value]: { ...draft, label: e.target.value } }))} />
                <select value={draft.to} aria-label={`Target of the new action from ${s.label}`} className={`${INPUT} w-48`}
                  onChange={(e) => setNewTransition((all) => ({ ...all, [s.value]: { ...draft, to: e.target.value } }))}>
                  <option value="">Target status</option>
                  {activeStatuses.filter((x) => x.value !== s.value).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
                <button type="button" onClick={() => void addTransition(s.value)} disabled={!draft.label.trim() || !draft.to}
                  className="h-8 rounded-md border border-background-300 px-3 text-sm font-medium text-foreground-800 hover:bg-background-100 disabled:opacity-50">Add action</button>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );

  /* -------------------------------------------------------------- reasons */
  const [newReason, setNewReason] = useState<Record<string, string>>({});
  const reasonStatuses = activeStatuses.filter((s) => transitions.some((t) => t.to_status === s.value && t.requires_reason) || reasons.some((r) => r.status === s.value));
  const moveReason = async (status: string, id: string, step: -1 | 1) => {
    const list = reasons.filter((r) => r.status === status && !r.is_other).sort((a, b) => a.sort - b.sort);
    const i = list.findIndex((r) => r.id === id), j = i + step;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await save(async () => {
      for (const [n, r] of list.entries()) { const { error: failed } = await supabase.from("status_reasons").update({ sort: (n + 1) * 10 }).eq("id", r.id); if (failed) return { error: failed }; }
      return { error: null };
    }, "Order saved.");
  };
  const reasonsTab = (
    <div className="grid gap-4 md:grid-cols-2" data-testid="reasons-tab">
      {reasonStatuses.map((s) => {
        const list = reasons.filter((r) => r.status === s.value).sort((a, b) => Number(a.is_other) - Number(b.is_other) || a.sort - b.sort);
        return (
          <section key={s.value} className="rounded-lg border border-background-200" data-testid="reason-group" data-status={s.value}>
            <header className="border-b border-background-200 bg-background-100/60 px-3 py-2"><Badge label={s.label} color={s.color} /></header>
            <ul className="divide-y divide-background-200">
              {list.map((r, i) => (
                <li key={r.id} className={`flex items-center gap-2 px-3 py-1.5 ${r.is_active ? "" : "opacity-60"}`} data-testid="reason-row">
                  <input defaultValue={r.label} aria-label={`Reason ${r.label}`} className={INPUT}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.label) void updateReason(r.id, { label: v }, `Renamed to “${v}”.`); }} />
                  {r.is_other ? <span className="shrink-0 text-[11px] text-foreground-500" title="Always last, with a text field">pinned last</span> : <>
                    <button type="button" disabled={i === 0} onClick={() => void moveReason(s.value, r.id, -1)} aria-label={`Move ${r.label} up`} className="rounded p-1 text-foreground-500 hover:bg-background-100 disabled:opacity-30"><i className="ri-arrow-up-s-line" aria-hidden="true" /></button>
                    <button type="button" disabled={i >= list.filter((x) => !x.is_other).length - 1} onClick={() => void moveReason(s.value, r.id, 1)} aria-label={`Move ${r.label} down`} className="rounded p-1 text-foreground-500 hover:bg-background-100 disabled:opacity-30"><i className="ri-arrow-down-s-line" aria-hidden="true" /></button>
                  </>}
                  <Toggle checked={r.is_active} disabled={r.is_other} label={`Active: ${r.label}`} onChange={(v) => void updateReason(r.id, { is_active: v }, v ? "Reason turned on." : "Reason turned off.")} />
                </li>
              ))}
            </ul>
            <div className="flex gap-2 border-t border-dashed border-background-200 px-3 py-2">
              <input value={newReason[s.value] ?? ""} placeholder="New reason" aria-label={`New reason for ${s.label}`} className={INPUT}
                onChange={(e) => setNewReason((all) => ({ ...all, [s.value]: e.target.value }))} />
              <button type="button" disabled={!(newReason[s.value] ?? "").trim()} className="h-8 shrink-0 rounded-md border border-background-300 px-3 text-sm font-medium hover:bg-background-100 disabled:opacity-50"
                onClick={() => { const label = (newReason[s.value] ?? "").trim(); const sort = Math.max(0, ...list.filter((x) => !x.is_other).map((x) => x.sort)) + 10;
                  void save(() => supabase.from("status_reasons").insert({ status: s.value, label, sort }), `Reason “${label}” added.`).then((ok) => { if (ok) setNewReason((all) => ({ ...all, [s.value]: "" })); }); }}>Add</button>
            </div>
          </section>
        );
      })}
    </div>
  );

  return (
    <div>
      <PageHeader breadcrumb="Settings" title="Application statuses"
        description="The statuses applications go through, what staff can do from each (and who), and the reasons offered. Changes apply at once everywhere." />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="w-full max-w-md"><SegmentedControl<Tab> label="Settings" value={tab} onChange={setTab} testId="status-settings-tabs"
          options={[{ value: "statuses", label: "Statuses", icon: "ri-price-tag-3-line" }, { value: "transitions", label: "Transitions", icon: "ri-git-branch-line" }, { value: "reasons", label: "Reasons", icon: "ri-list-check-2" }]} /></div>
        <button type="button" onClick={() => void openHistory()} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700" data-testid="status-history-link">
          <i className="ri-history-line" aria-hidden="true" />History
        </button>
      </div>
      {error ? <p role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="status-settings-error">{error}</p> : null}
      {statuses === null ? <p className="text-sm text-foreground-600" role="status">Loading…</p> : <div key={tab} className="fade-in">{tab === "statuses" ? statusesTab : tab === "transitions" ? transitionsTab : reasonsTab}</div>}

      {history ? (
        <ActionDrawer title={`History · ${tab === "statuses" ? "Statuses" : tab === "transitions" ? "Transitions" : "Reasons"}`} onClose={() => setHistory(null)} testId="status-history"
          footer={<button type="button" onClick={() => setHistory(null)} className="h-9 rounded-lg border border-background-300 px-3 text-sm font-medium">Close</button>}>
          {history.length === 0 ? <p className="text-sm text-foreground-500">No changes yet.</p> : (
            <ol className="space-y-2.5">
              {history.map((h) => {
                const changes = h.action === "UPDATE" && h.before && h.after ? Object.keys(h.after).filter((k) => JSON.stringify(h.after![k]) !== JSON.stringify(h.before![k])) : [];
                return (
                  <li key={h.id} className="rounded-md border border-background-200 px-3 py-2 text-sm">
                    <p className="font-medium text-foreground-900">{h.action === "INSERT" ? "Added" : h.action === "DELETE" ? "Deleted" : "Changed"} <code className="text-xs">{h.rowKey.includes(":") ? h.rowKey.replace(":", " › ") : labelOf.get(h.rowKey) ?? h.rowKey}</code></p>
                    {changes.length ? <p className="text-xs text-foreground-600">{changes.map((k) => `${k}: ${JSON.stringify(h.before![k])} → ${JSON.stringify(h.after![k])}`).join(" · ")}</p> : null}
                    <p className="text-xs text-foreground-500">{h.by} · {new Date(h.at).toLocaleString()}</p>
                  </li>
                );
              })}
            </ol>
          )}
        </ActionDrawer>
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog title={`Delete “${confirmDelete.label}”?`} confirmLabel="Delete" tone="danger" onClose={() => setConfirmDelete(null)}
          body="Its transitions and reasons go too. Statuses that applications use cannot be deleted."
          onConfirm={() => { const s = confirmDelete; setConfirmDelete(null); void save(async () => {
            const t = await supabase.from("application_status_transitions").delete().or(`from_status.eq.${s.value},to_status.eq.${s.value}`);
            if (t.error) return t;
            return supabase.from("application_statuses").delete().eq("value", s.value);
          }, `“${s.label}” deleted.`); }} />
      ) : null}
      <Toast message={toast.message} onDismiss={toast.dismiss} />
    </div>
  );
}
