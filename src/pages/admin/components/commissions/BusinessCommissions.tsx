import { useCallback, useEffect, useMemo, useState } from "react";
import { qualificationLabel } from "@/lib/qualification";
import { Button, Card, ConfirmDialog, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import { formatMoney } from "@/lib/signingApi";

/**
 * AVETMISS-UI (2026-11-25): Agencies › {business} › Commissions (admins only; RLS agent_commissions_admin = cms_is_admin). Benefits
 * paid to the business's agents: who, for which student / enrolment, the kind of benefit, the amount and GST (stored in cents), when
 * it was paid and the external reference. Totals for the chosen period; add, edit and delete.
 */
type Benefit = "monetary_direct" | "monetary_indirect" | "non_monetary";
const BENEFITS: Array<{ value: Benefit; label: string }> = [
  { value: "monetary_direct", label: "Monetary (direct)" },
  { value: "monetary_indirect", label: "Monetary (indirect)" },
  { value: "non_monetary", label: "Non-monetary" },
];
const benefitLabel = (v: string) => BENEFITS.find((b) => b.value === v)?.label ?? v;

interface Commission {
  id: string; agency_id: string; agent_id: string | null; student_id: string | null; intake_enrolment_id: string | null; benefit_type: Benefit;
  description: string | null; amount_cents: number; gst_cents: number; paid_on: string; external_reference: string | null; source: string;
}
interface Option { id: string; label: string }
type Period = "month" | "quarter" | "fy" | "all";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** [from, to) for the period, in local dates; the Australian financial year runs 1 July to 30 June. */
function periodRange(p: Period): { from?: string; to?: string; label: string } {
  const t = new Date();
  if (p === "month") return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(new Date(t.getFullYear(), t.getMonth() + 1, 1)), label: "this month" };
  if (p === "quarter") { const q = Math.floor(t.getMonth() / 3) * 3; return { from: iso(new Date(t.getFullYear(), q, 1)), to: iso(new Date(t.getFullYear(), q + 3, 1)), label: "this quarter" }; }
  if (p === "fy") { const y = t.getMonth() >= 6 ? t.getFullYear() : t.getFullYear() - 1; return { from: `${y}-07-01`, to: `${y + 1}-07-01`, label: `FY ${y}-${String(y + 1).slice(2)}` }; }
  return { label: "all time" };
}
const dollars = (cents: number) => (cents / 100).toFixed(2);
const toCents = (value: string): number | null => { const v = value.replace(/[$,\s]/g, ""); if (!/^\d+(\.\d{1,2})?$/.test(v)) return null; return Math.round(Number(v) * 100); };
const dateText = (v: string) => new Date(`${v}T00:00:00`).toLocaleDateString("en-AU", { dateStyle: "medium" });

interface Draft { id?: string; agentId: string; studentId: string; enrolmentId: string; benefit: Benefit; description: string; amount: string; gst: string; paidOn: string; reference: string }
const blank = (): Draft => ({ agentId: "", studentId: "", enrolmentId: "", benefit: "monetary_direct", description: "", amount: "", gst: "0.00", paidOn: iso(new Date()), reference: "" });

export default function BusinessCommissions({ agencyId }: { agencyId: string }) {
  const [rows, setRows] = useState<Commission[] | null>(null);
  const [agents, setAgents] = useState<Option[]>([]);
  const [students, setStudents] = useState<Option[]>([]);
  const [enrolments, setEnrolments] = useState<Option[]>([]);
  const [period, setPeriod] = useState<Period>("fy");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Commission | null>(null);

  const load = useCallback(async () => {
    setError("");
    const [c, a, s] = await Promise.all([
      supabase.from("agent_commissions").select("id, agency_id, agent_id, student_id, intake_enrolment_id, benefit_type, description, amount_cents, gst_cents, paid_on, external_reference, source")
        .eq("agency_id", agencyId).order("paid_on", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("agents").select("id, full_name").eq("business_id", agencyId).order("full_name"),
      supabase.from("enrollment_students").select("id, full_name, student_number").eq("agency_id", agencyId).order("full_name"),
    ]);
    if (c.error) { setError(c.error.message); setRows([]); return; }
    setRows((c.data ?? []) as Commission[]);
    setAgents(((a.data ?? []) as { id: string; full_name: string | null }[]).map((x) => ({ id: x.id, label: x.full_name || "Agent" })));
    setStudents(((s.data ?? []) as { id: string; full_name: string | null; student_number: string | null }[]).map((x) => ({ id: x.id, label: [x.full_name || "Student", x.student_number].filter(Boolean).join(" · ") })));
  }, [agencyId]);
  useEffect(() => { void load(); }, [load]);

  // The enrolments of the chosen student (intake enrolments with their intake and course), for the optional Enrolment field.
  const studentId = draft?.studentId ?? "";
  useEffect(() => {
    if (!studentId) { setEnrolments([]); return; }
    let live = true;
    void supabase.from("intake_enrolments").select("id, status, course_intakes(name, label, start_date, cms_courses(code))").eq("student_id", studentId).then(({ data }) => {
      if (!live) return;
      type Row = { id: string; status: string; course_intakes: { name: string | null; label: string | null; start_date: string | null; cms_courses: { code: string } | null } | null };
      setEnrolments(((data ?? []) as unknown as Row[]).map((e) => ({ id: e.id, label: [e.course_intakes?.cms_courses?.code, e.course_intakes?.name || e.course_intakes?.label || e.course_intakes?.start_date, `Qualification ${qualificationLabel(e.status)}`].filter(Boolean).join(" · ") })));
    });
    return () => { live = false; };
  }, [studentId]);

  const range = periodRange(period);
  const shown = useMemo(() => (rows ?? []).filter((r) => (!range.from || r.paid_on >= range.from) && (!range.to || r.paid_on < range.to)), [rows, range.from, range.to]);
  const totals = useMemo(() => shown.reduce((t, r) => ({ amount: t.amount + r.amount_cents, gst: t.gst + r.gst_cents }), { amount: 0, gst: 0 }), [shown]);
  const nameOf = (list: Option[], id: string | null) => (id ? list.find((o) => o.id === id)?.label ?? "—" : "—");

  const edit = (r: Commission) => {
    setFormError("");
    setDraft({ id: r.id, agentId: r.agent_id ?? "", studentId: r.student_id ?? "", enrolmentId: r.intake_enrolment_id ?? "", benefit: r.benefit_type, description: r.description ?? "",
      amount: dollars(r.amount_cents), gst: dollars(r.gst_cents), paidOn: r.paid_on, reference: r.external_reference ?? "" });
  };
  const save = async () => {
    if (!draft) return;
    const amount = toCents(draft.amount); const gst = toCents(draft.gst || "0");
    if (amount === null) { setFormError("Enter the amount in dollars, for example 1250.00."); return; }
    if (gst === null) { setFormError("Enter the GST in dollars, for example 125.00 (0 when there is none)."); return; }
    if (!draft.paidOn) { setFormError("Enter the date it was paid."); return; }
    if (draft.description.length > 500) { setFormError("Keep the description under 500 characters."); return; }
    const record = {
      agent_id: draft.agentId || null, student_id: draft.studentId || null, intake_enrolment_id: draft.enrolmentId || null, benefit_type: draft.benefit,
      description: draft.description.trim() || null, amount_cents: amount, gst_cents: gst, paid_on: draft.paidOn, external_reference: draft.reference.trim() || null,
      updated_at: new Date().toISOString(),
    };
    setSaving(true); setFormError("");
    const res = draft.id ? await supabase.from("agent_commissions").update(record).eq("id", draft.id) : await supabase.from("agent_commissions").insert({ ...record, agency_id: agencyId });
    setSaving(false);
    if (res.error) { setFormError(res.error.message); return; }
    setDraft(null); await load();
  };
  const remove = async () => {
    if (!deleting) return;
    setSaving(true);
    const { error: e } = await supabase.from("agent_commissions").delete().eq("id", deleting.id);
    setSaving(false);
    if (e) { setError(e.message); setDeleting(null); return; }
    setDeleting(null); await load();
  };

  return <div className="space-y-4" data-testid="business-commissions">
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Period"><Select value={period} onChange={(e) => setPeriod(e.target.value as Period)} data-testid="commissions-period">
        <option value="month">This month</option><option value="quarter">This quarter</option><option value="fy">This financial year</option><option value="all">All time</option></Select></Field>
      <span className="flex-1" />
      <Button icon="ri-add-line" onClick={() => { setFormError(""); setDraft(blank()); }} data-testid="commission-add">Add commission</Button>
    </div>
    {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
    <div className="grid gap-3 sm:grid-cols-3" data-testid="commissions-totals">
      {[["Amount", totals.amount], ["GST", totals.gst], ["Total", totals.amount + totals.gst]].map(([label, cents]) => (
        <Card key={label as string} className="p-4"><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label} · {range.label}</p>
          <p className="mt-1 font-heading text-2xl font-bold tabular-nums text-foreground-950">{formatMoney(cents as number, "AUD")}</p></Card>))}
    </div>
    {!rows ? <p role="status" className="text-sm text-foreground-600">Loading commissions…</p>
      : !shown.length ? <p className="rounded-lg border border-dashed border-background-300 p-6 text-center text-sm text-foreground-600">No commissions {range.label === "all time" ? "recorded yet" : `paid ${range.label}`}.</p>
      : <div className="overflow-x-auto rounded-md border border-background-300"><table className="w-full min-w-[820px] text-left text-sm" data-testid="commissions-table">
        <thead className="bg-background-100 text-xs text-foreground-600"><tr>
          <th className="px-3 py-2">Paid on</th><th className="px-3">Agent</th><th className="px-3">Student</th><th className="px-3">Benefit</th><th className="px-3">Description</th>
          <th className="px-3 text-right">Amount</th><th className="px-3 text-right">GST</th><th className="px-3">Reference</th><th className="px-3" /></tr></thead>
        <tbody>{shown.map((r) => <tr key={r.id} className="border-t border-background-200" data-testid="commission-row">
          <td className="px-3 py-2 whitespace-nowrap">{dateText(r.paid_on)}</td>
          <td className="px-3">{nameOf(agents, r.agent_id)}</td>
          <td className="px-3">{nameOf(students, r.student_id)}</td>
          <td className="px-3 whitespace-nowrap">{benefitLabel(r.benefit_type)}</td>
          <td className="px-3">{r.description ?? "—"}</td>
          <td className="px-3 text-right tabular-nums">{formatMoney(r.amount_cents, "AUD")}</td>
          <td className="px-3 text-right tabular-nums">{formatMoney(r.gst_cents, "AUD")}</td>
          <td className="px-3">{r.external_reference ?? "—"}{r.source !== "manual" ? <span className="ml-1 text-xs text-foreground-500">({r.source})</span> : null}</td>
          <td className="px-3 whitespace-nowrap text-right"><Button size="sm" variant="ghost" onClick={() => edit(r)}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} data-testid="commission-delete">Delete</Button></td>
        </tr>)}</tbody></table></div>}

    <Modal open={draft !== null} title={draft?.id ? "Edit commission" : "Add commission"} onClose={() => setDraft(null)}
      footer={<><Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button><Button disabled={saving} onClick={() => void save()} data-testid="commission-save">{saving ? "Saving…" : "Save"}</Button></>}>
      {draft ? <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Agent"><Select value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}><option value="">Not linked to an agent</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select></Field>
        <Field label="Student"><Select value={draft.studentId} onChange={(e) => setDraft({ ...draft, studentId: e.target.value, enrolmentId: "" })}><option value="">Not linked to a student</option>{students.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Field>
        <Field label="Enrolment" hint={draft.studentId && !enrolments.length ? "This student has no intake enrolment yet." : undefined}><Select value={draft.enrolmentId} disabled={!draft.studentId} onChange={(e) => setDraft({ ...draft, enrolmentId: e.target.value })}>
          <option value="">Not linked to an enrolment</option>{enrolments.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
        <Field label="Benefit type" required><Select value={draft.benefit} onChange={(e) => setDraft({ ...draft, benefit: e.target.value as Benefit })}>{BENEFITS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</Select></Field>
        <Field label="Amount (AUD, excl. GST)" required><TextInput inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} placeholder="0.00" data-testid="commission-amount" /></Field>
        <Field label="GST (AUD)"><TextInput inputMode="decimal" value={draft.gst} onChange={(e) => setDraft({ ...draft, gst: e.target.value })} placeholder="0.00" /></Field>
        <Field label="Paid on" required><TextInput type="date" value={draft.paidOn} onChange={(e) => setDraft({ ...draft, paidOn: e.target.value })} /></Field>
        <Field label="External reference" hint="Invoice or Xero number"><TextInput value={draft.reference} maxLength={200} onChange={(e) => setDraft({ ...draft, reference: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Description"><TextArea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field></div>
        {formError ? <p role="alert" className="sm:col-span-2 text-sm text-primary-800">{formError}</p> : null}
      </div> : null}
    </Modal>
    <ConfirmDialog open={deleting !== null} title="Delete this commission?" message={deleting ? `${formatMoney(deleting.amount_cents + deleting.gst_cents, "AUD")} paid on ${dateText(deleting.paid_on)} will be removed. This cannot be undone.` : ""}
      confirmLabel={saving ? "Deleting…" : "Delete"} onConfirm={() => void remove()} onCancel={() => setDeleting(null)} />
  </div>;
}
