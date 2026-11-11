import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge, Button, Card, Field, Modal, PageHeader, SectionTabs, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import LeaveApprovals from "@/pages/admin/components/hrms/LeaveApprovals";
import OptionalHolidayApprovals from "@/pages/admin/components/hrms/OptionalHolidayApprovals";
import {
  adminAddLeave, adjustLeave, leaveBalances, listLeaveTypes, myTeam, saveLeavePolicy, saveLeaveType,
  type LeaveBalances, type LeavePolicy, type LeaveType, type MyTeam,
} from "@/lib/hrmsApi";
import { fmtDate, hoursLabel } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
const METHOD_LABEL: Record<LeaveType["accrualMethod"], string> = { progressive: "Accrued progressively", long_service: "Long service", entitlement: "Entitlement per 12 months", per_occasion: "Per occasion", none: "Not tracked" };
const TABS = [{ id: "approvals", label: "Approvals", icon: "ri-check-double-line" }, { id: "add", label: "Enter leave", icon: "ri-add-line" }, { id: "balances", label: "Balances", icon: "ri-scales-3-line" }, { id: "types", label: "Types & policies", icon: "ri-settings-3-line" }];

/** Staff > Leave: approvals, HR-entered leave, balances and adjustments, and the leave types with their effective-dated policies. */
export default function LeaveAdminPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "approvals";
  const [team, setTeam] = useState<MyTeam | null>(null);
  const [types, setTypes] = useState<LeaveType[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(async () => {
    try { setError(""); const [t, ty] = await Promise.all([myTeam(), listLeaveTypes()]); setTeam(t); setTypes(ty); }
    catch (e) { setError(e instanceof Error ? e.message : "Leave could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <PageHeader breadcrumb="HRMS" title="Leave" description="Requests are approved by the person's manager or HR, never by the person themselves. Balances come from the ledger: accruals when a period is locked, leave taken, and HR adjustments." />
      <SectionTabs tabs={TABS} active={tab} onChange={(id) => setParams(id === "approvals" ? {} : { tab: id })} />
      {error ? <p role="alert" className={`mb-4 ${ALERT}`}>{error}</p> : null}
      {tab === "approvals" ? <>
        <LeaveApprovals refreshKey={refresh} />
        <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-foreground-600">Optional holidays</h2>
        <OptionalHolidayApprovals refreshKey={refresh} />
      </> : null}
      {tab === "add" && team && types ? <AddLeave team={team} types={types} onAdded={() => setRefresh((n) => n + 1)} /> : null}
      {tab === "balances" && team && types ? <Balances team={team} types={types} /> : null}
      {tab === "types" && types ? <TypesAdmin types={types} onChanged={(t) => setTypes(t)} /> : null}
    </div>
  );
}

function AddLeave({ team, types, onAdded }: { team: MyTeam; types: LeaveType[]; onAdded: () => void }) {
  const [form, setForm] = useState({ profileId: "", leaveTypeId: types.find((t) => t.isActive)?.id ?? "", startDate: "", endDate: "", unit: "days" as "days" | "hours", quantity: "", note: "" });
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await adminAddLeave(form.profileId, { leaveTypeId: form.leaveTypeId, startDate: form.startDate, endDate: form.endDate || form.startDate, unit: form.unit, quantity: form.quantity ? Number(form.quantity) : null, note: form.note });
      setNotice(`${r.personName}: ${r.leaveTypeName} ${fmtDate(r.startDate)}${r.endDate !== r.startDate ? ` – ${fmtDate(r.endDate)}` : ""} (${hoursLabel(r.hours)}) entered and approved.`);
      patch({ startDate: "", endDate: "", quantity: "", note: "" }); onAdded();
    } catch (e) { setError(e instanceof Error ? e.message : "The leave could not be entered."); }
    finally { setBusy(false); }
  };
  return (
    <Card className="p-5" >
      <div data-testid="leave-add">
      <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Enter leave for an employee</h2>
      <p className="mb-3 text-sm text-foreground-600">Entered by HR, approved at once. Your own leave goes through your manager.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Employee" required><Select value={form.profileId} onChange={(e) => patch({ profileId: e.target.value })} data-testid="leave-add-person">
          <option value="">Choose…</option>{team.reports.filter((r) => r.status === "active").map((r) => <option key={r.profileId} value={r.profileId}>{r.name}{r.jobTitle ? ` · ${r.jobTitle}` : ""}</option>)}
        </Select></Field>
        <Field label="Leave type" required><Select value={form.leaveTypeId} onChange={(e) => patch({ leaveTypeId: e.target.value })} data-testid="leave-add-type">
          {types.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select></Field>
        <Field label="Unit"><Select value={form.unit} onChange={(e) => patch({ unit: e.target.value as "days" | "hours" })}><option value="days">Days</option><option value="hours">Hours</option></Select></Field>
        <Field label="First day" required><TextInput type="date" value={form.startDate} onChange={(e) => patch({ startDate: e.target.value })} data-testid="leave-add-start" /></Field>
        <Field label="Last day"><TextInput type="date" value={form.endDate} onChange={(e) => patch({ endDate: e.target.value })} data-testid="leave-add-end" /></Field>
        <Field label={form.unit === "days" ? "Days (blank = all work days in the range)" : "Hours"}><TextInput type="number" step="0.25" min="0" value={form.quantity} onChange={(e) => patch({ quantity: e.target.value })} data-testid="leave-add-quantity" /></Field>
      </div>
      <div className="mt-3"><Field label="Note"><TextArea rows={2} maxLength={1000} value={form.note} onChange={(e) => patch({ note: e.target.value })} /></Field></div>
      {error ? <p role="alert" className={`mt-3 ${ALERT}`} data-testid="leave-add-error">{error}</p> : null}
      {notice ? <p role="status" className={`mt-3 ${NOTICE}`} data-testid="leave-add-notice">{notice}</p> : null}
      <div className="mt-3"><Button disabled={busy || !form.profileId || !form.startDate} onClick={() => void save()} data-testid="leave-add-save">{busy ? "Saving…" : "Enter leave"}</Button></div>
      </div>
    </Card>
  );
}

function Balances({ team, types }: { team: MyTeam; types: LeaveType[] }) {
  const [profileId, setProfileId] = useState(team.reports.find((r) => r.status === "active")?.profileId ?? "");
  const [data, setData] = useState<LeaveBalances | null>(null);
  const [error, setError] = useState("");
  const [adjust, setAdjust] = useState<{ leaveTypeId: string; hours: string; reason: string; kind: "adjustment" | "opening" } | null>(null);
  const [busy, setBusy] = useState(false); const [dialogError, setDialogError] = useState("");
  const load = useCallback(async () => {
    if (!profileId) { setData(null); return; }
    try { setError(""); setData(await leaveBalances(profileId)); } catch (e) { setError(e instanceof Error ? e.message : "The balances could not be loaded."); }
  }, [profileId]);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!adjust) return;
    setBusy(true); setDialogError("");
    try { setData(await adjustLeave(profileId, adjust.leaveTypeId, Number(adjust.hours), adjust.reason, adjust.kind)); setAdjust(null); }
    catch (e) { setDialogError(e instanceof Error ? e.message : "The balance could not be adjusted."); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-4" data-testid="leave-balances-admin">
      <Card className="p-4"><Field label="Employee"><Select value={profileId} onChange={(e) => setProfileId(e.target.value)} data-testid="leave-balances-person">
        {team.reports.filter((r) => r.status === "active").map((r) => <option key={r.profileId} value={r.profileId}>{r.name}</option>)}
      </Select></Field></Card>
      {error ? <p role="alert" className={ALERT}>{error}</p> : null}
      {data ? <BalanceTable data={data} onAdjust={(leaveTypeId) => { setAdjust({ leaveTypeId, hours: "", reason: "", kind: "adjustment" }); setDialogError(""); }} /> : null}
      <Modal open={adjust !== null} title="Adjust a balance" onClose={() => setAdjust(null)}
        footer={<><Button variant="outline" onClick={() => setAdjust(null)}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="leave-adjust-save">Save</Button></>}>
        {adjust ? (
          <div className="space-y-3" data-testid="leave-adjust-dialog">
            <Field label="Leave type"><Select value={adjust.leaveTypeId} onChange={(e) => setAdjust({ ...adjust, leaveTypeId: e.target.value })}>
              {types.filter((t) => t.requiresBalance).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select></Field>
            <Field label="Entry"><Select value={adjust.kind} onChange={(e) => setAdjust({ ...adjust, kind: e.target.value as "adjustment" | "opening" })}><option value="adjustment">Adjustment</option><option value="opening">Opening balance</option></Select></Field>
            <Field label="Hours (negative to deduct)" required><TextInput type="number" step="0.25" value={adjust.hours} onChange={(e) => setAdjust({ ...adjust, hours: e.target.value })} data-testid="leave-adjust-hours" /></Field>
            <Field label="Reason" required><TextArea rows={2} maxLength={500} value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} data-testid="leave-adjust-reason" /></Field>
            {dialogError ? <p role="alert" className={ALERT}>{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export function BalanceTable({ data, onAdjust }: { data: LeaveBalances; onAdjust?: (leaveTypeId: string) => void }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm" data-testid="leave-balance-table">
        <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr>
          <th className="px-3 py-2">Leave type</th><th className="px-3 py-2 text-right">Balance</th><th className="px-3 py-2 text-right">Available</th><th className="px-3 py-2 text-right">Pending</th><th className="px-3 py-2">Rule</th>{onAdjust ? <th className="px-3 py-2" /> : null}
        </tr></thead>
        <tbody className="divide-y divide-background-200">
          {data.balances.map((b) => (
            <tr key={b.leaveTypeId} data-testid={`leave-balance-${b.code}`}>
              <td className="px-3 py-2 font-medium text-foreground-900">{b.name}{b.isPaid ? "" : <span className="ml-1 text-xs text-foreground-500">(unpaid)</span>}</td>
              <td className="px-3 py-2 text-right">{b.requiresBalance ? hoursLabel(b.balanceHours) : <span className="text-foreground-400">—</span>}</td>
              <td className="px-3 py-2 text-right">{b.availableHours === null ? <span className="text-foreground-400">no limit</span> : hoursLabel(b.availableHours)}</td>
              <td className="px-3 py-2 text-right">{Number(b.pendingHours) ? hoursLabel(b.pendingHours) : ""}</td>
              <td className="px-3 py-2 text-xs text-foreground-600">{METHOD_LABEL[b.accrualMethod]}{b.accrualMethod === "long_service" && b.qualifyingYears !== null ? ` · ${Number(b.serviceYears ?? 0).toFixed(1)} of ${b.qualifyingYears} years` : ""}</td>
              {onAdjust ? <td className="px-3 py-2 text-right">{b.requiresBalance ? <Button size="sm" variant="outline" onClick={() => onAdjust(b.leaveTypeId)} data-testid={`leave-adjust-${b.code}`}>Adjust</Button> : null}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {data.ledger.length ? (
        <div className="border-t border-background-200 p-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-600">Ledger</h3>
          <ul className="space-y-0.5 text-xs text-foreground-700">
            {data.ledger.slice(0, 30).map((l) => <li key={l.id}>{fmtDate(l.effectiveDate)} · {l.leaveTypeName} · {l.entryKind} {Number(l.hours) > 0 ? "+" : ""}{Number(l.hours).toFixed(2)} h{l.reason ? ` · ${l.reason}` : ""}</li>)}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function TypesAdmin({ types, onChanged }: { types: LeaveType[]; onChanged: (types: LeaveType[]) => void }) {
  const [editing, setEditing] = useState<Partial<LeaveType> & { id: string | null } | null>(null);
  const [policy, setPolicy] = useState<{ typeId: string; form: Partial<Record<keyof LeavePolicy, string>> } | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const reload = async () => onChanged(await listLeaveTypes());
  const saveType = async () => {
    if (!editing) return;
    setBusy(true); setError("");
    try { await saveLeaveType(editing.id, { code: editing.code, name: editing.name, description: editing.description, isPaid: editing.isPaid, requiresBalance: editing.requiresBalance, accrualMethod: editing.accrualMethod, sortOrder: editing.sortOrder, isActive: editing.isActive }); await reload(); setEditing(null); }
    catch (e) { setError(e instanceof Error ? e.message : "The leave type could not be saved."); }
    finally { setBusy(false); }
  };
  const savePolicy = async () => {
    if (!policy) return;
    setBusy(true); setError("");
    const f = policy.form; const num = (v?: string) => (v === undefined || v === "" ? null : Number(v));
    try {
      await saveLeavePolicy(policy.typeId, { effectiveFrom: f.effectiveFrom || undefined, hoursPerYear: num(f.hoursPerYear), daysPerYear: num(f.daysPerYear), daysPerOccasion: num(f.daysPerOccasion), paidDaysPerOccasion: num(f.paidDaysPerOccasion), accrualFraction: num(f.accrualFraction), qualifyingYears: num(f.qualifyingYears), note: f.note ?? "" });
      await reload(); setPolicy(null);
    } catch (e) { setError(e instanceof Error ? e.message : "The policy could not be saved."); }
    finally { setBusy(false); }
  };
  const openPolicy = (t: LeaveType) => setPolicy({ typeId: t.id, form: { effectiveFrom: new Date().toISOString().slice(0, 10), hoursPerYear: t.policy?.hoursPerYear?.toString() ?? "", daysPerYear: t.policy?.daysPerYear?.toString() ?? "", daysPerOccasion: t.policy?.daysPerOccasion?.toString() ?? "", paidDaysPerOccasion: t.policy?.paidDaysPerOccasion?.toString() ?? "", accrualFraction: t.policy?.accrualFraction?.toString() ?? "", qualifyingYears: t.policy?.qualifyingYears?.toString() ?? "", note: "" } });
  const editingType = editing;
  return (
    <div className="space-y-4" data-testid="leave-types">
      <div className="flex justify-end"><Button size="sm" onClick={() => setEditing({ id: null, name: "", code: "", description: "", isPaid: true, requiresBalance: false, accrualMethod: "none", sortOrder: 100, isActive: true })} data-testid="leave-type-new">New leave type</Button></div>
      {error ? <p role="alert" className={ALERT}>{error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {types.map((t) => (
          <Card key={t.id} className="p-4"><div data-testid={`leave-type-${t.code}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><h3 className="font-heading text-base font-bold text-foreground-950">{t.name} {t.isActive ? null : <Badge tone="muted">Inactive</Badge>}</h3><p className="text-xs text-foreground-600">{t.description}</p></div>
              <span className="flex gap-1"><Button size="sm" variant="outline" onClick={() => setEditing({ ...t })}>Edit</Button><Button size="sm" variant="outline" onClick={() => openPolicy(t)} data-testid={`leave-policy-new-${t.code}`}>New policy version</Button></span>
            </div>
            <p className="mt-2 text-xs text-foreground-600">{t.isPaid ? "Paid" : "Unpaid"} · {METHOD_LABEL[t.accrualMethod]}{t.requiresBalance ? " · drawn from the balance" : ""}</p>
            <ul className="mt-2 space-y-1 text-xs text-foreground-700">
              {(t.policies ?? []).map((p) => (
                <li key={p.id} className={p.id === t.policy?.id ? "font-semibold" : ""}>
                  From {fmtDate(p.effectiveFrom)}{p.effectiveTo ? ` to ${fmtDate(p.effectiveTo)}` : ""}:
                  {p.hoursPerYear !== null ? ` ${p.hoursPerYear} h/year` : ""}{p.daysPerYear !== null ? ` ${p.daysPerYear} days/12 months` : ""}{p.daysPerOccasion !== null ? ` ${p.daysPerOccasion} days/occasion` : ""}
                  {p.paidDaysPerOccasion !== null ? ` first ${p.paidDaysPerOccasion} days paid` : ""}{p.accrualFraction !== null ? ` ${p.accrualFraction} of ordinary hours` : ""}{p.qualifyingYears !== null ? ` after ${p.qualifyingYears} years` : ""}
                  {p.note ? ` · ${p.note}` : ""}
                </li>
              ))}
            </ul>
          </div></Card>
        ))}
      </div>
      <Modal open={editingType !== null} title={editingType?.id ? "Edit leave type" : "New leave type"} onClose={() => setEditing(null)}
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy} onClick={() => void saveType()} data-testid="leave-type-save">Save</Button></>}>
        {editingType ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required><TextInput value={editingType.name ?? ""} onChange={(e) => setEditing({ ...editingType, name: e.target.value })} data-testid="leave-type-name" /></Field>
            <Field label="Code" hint="Letters, digits, underscores; fixed once created."><TextInput value={editingType.code ?? ""} disabled={Boolean(editingType.id)} onChange={(e) => setEditing({ ...editingType, code: e.target.value })} /></Field>
            <Field label="Accrual method"><Select value={editingType.accrualMethod ?? "none"} onChange={(e) => setEditing({ ...editingType, accrualMethod: e.target.value as LeaveType["accrualMethod"] })}>
              {(Object.keys(METHOD_LABEL) as LeaveType["accrualMethod"][]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
            </Select></Field>
            <Field label="Sort order"><TextInput type="number" value={editingType.sortOrder ?? 100} onChange={(e) => setEditing({ ...editingType, sortOrder: Number(e.target.value) })} /></Field>
            <div className="sm:col-span-2"><Field label="Description"><TextArea rows={2} value={editingType.description ?? ""} onChange={(e) => setEditing({ ...editingType, description: e.target.value })} /></Field></div>
            <Toggle label="Paid leave" checked={editingType.isPaid ?? true} onChange={(v) => setEditing({ ...editingType, isPaid: v })} />
            <Toggle label="Drawn from a balance" checked={editingType.requiresBalance ?? false} onChange={(v) => setEditing({ ...editingType, requiresBalance: v })} />
            <Toggle label="Active" checked={editingType.isActive ?? true} onChange={(v) => setEditing({ ...editingType, isActive: v })} />
          </div>
        ) : null}
      </Modal>
      <Modal open={policy !== null} title="New policy version" onClose={() => setPolicy(null)}
        footer={<><Button variant="outline" onClick={() => setPolicy(null)}>Cancel</Button><Button disabled={busy} onClick={() => void savePolicy()} data-testid="leave-policy-save">Save version</Button></>}>
        {policy ? (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="leave-policy-dialog">
            <Field label="Effective from" required><TextInput type="date" value={policy.form.effectiveFrom ?? ""} onChange={(e) => setPolicy({ ...policy, form: { ...policy.form, effectiveFrom: e.target.value } })} /></Field>
            <Field label="Hours per year (progressive)"><TextInput type="number" step="0.01" value={policy.form.hoursPerYear ?? ""} onChange={(e) => setPolicy({ ...policy, form: { ...policy.form, hoursPerYear: e.target.value } })} /></Field>
            <Field label="Days per 12 months (entitlement)"><TextInput type="number" step="0.5" value={policy.form.daysPerYear ?? ""} onChange={(e) => setPolicy({ ...policy, form: { ...policy.form, daysPerYear: e.target.value } })} /></Field>
            <Field label="Days per occasion"><TextInput type="number" step="0.5" value={policy.form.daysPerOccasion ?? ""} onChange={(e) => setPolicy({ ...policy, form: { ...policy.form, daysPerOccasion: e.target.value } })} /></Field>
            <Field label="Paid days per occasion"><TextInput type="number" step="0.5" value={policy.form.paidDaysPerOccasion ?? ""} onChange={(e) => setPolicy({ ...policy, form: { ...policy.form, paidDaysPerOccasion: e.target.value } })} /></Field>
            <Field label="Accrual fraction (long service)"><TextInput type="number" step="0.000001" value={policy.form.accrualFraction ?? ""} onChange={(e) => setPolicy({ ...policy, form: { ...policy.form, accrualFraction: e.target.value } })} /></Field>
            <Field label="Qualifying years"><TextInput type="number" step="0.5" value={policy.form.qualifyingYears ?? ""} onChange={(e) => setPolicy({ ...policy, form: { ...policy.form, qualifyingYears: e.target.value } })} /></Field>
            <div className="sm:col-span-2"><Field label="Note"><TextInput value={policy.form.note ?? ""} onChange={(e) => setPolicy({ ...policy, form: { ...policy.form, note: e.target.value } })} /></Field></div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
