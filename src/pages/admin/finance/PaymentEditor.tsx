import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { FEE_TYPES, financePaymentSave, financePaymentStudents, type FeeType, type FinanceOptions, type FinancePaymentRow, type PaymentStudent } from "@/pages/admin/lib/finance";

/**
 * AVETMISS-UI (2026-11-25): Finance › Payments editing (admins; finance_payment_save). Every payment: fee type, student, course and
 * external reference. A manual payment (taken outside Stripe) also: what it was for and a refund (amount and date). "Add payment"
 * records a manual payment as paid.
 */
const pad = (n: number) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toCents = (value: string): number | null => { const v = value.replace(/[$,\s]/g, ""); if (!/^\d+(\.\d{1,2})?$/.test(v)) return null; return Math.round(Number(v) * 100); };
const dollars = (cents: number | null | undefined) => (cents ? (cents / 100).toFixed(2) : "");
/** A local date as the start of that day in the browser's time zone (sent as an ISO timestamp). */
const dayStart = (date: string) => new Date(`${date}T00:00:00`).toISOString();
const dayOf = (iso: string | null | undefined) => { if (!iso) return ""; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

let studentsCache: Promise<PaymentStudent[]> | null = null;
function useStudents(): PaymentStudent[] {
  const [list, setList] = useState<PaymentStudent[]>([]);
  useEffect(() => { studentsCache ??= financePaymentStudents().catch(() => { studentsCache = null; return []; }); void studentsCache.then(setList); }, []);
  return list;
}
const studentLabel = (s: PaymentStudent) => [s.name, s.studentNumber, s.email].filter(Boolean).join(" · ");

/** The editable fields in the payment drawer. */
export function PaymentEditFields({ row, options, onSaved }: { row: FinancePaymentRow; options: FinanceOptions | null; onSaved: () => void }) {
  const students = useStudents();
  const manual = row.source === "manual";
  const [feeType, setFeeType] = useState<string>(row.fee_type ?? "");
  const [studentId, setStudentId] = useState(row.student_id ?? "");
  const [courseId, setCourseId] = useState(row.course_id ?? "");
  const [reference, setReference] = useState(row.external_reference ?? "");
  const [description, setDescription] = useState(row.description);
  const [refund, setRefund] = useState(dollars(row.amount_refunded_cents));
  const [refundedAt, setRefundedAt] = useState(dayOf(row.refunded_at));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const save = async () => {
    setMessage(null);
    const data: Parameters<typeof financePaymentSave>[0] = { id: row.id, feeType: (feeType || null) as FeeType | null, studentId: studentId || null, courseId: courseId || null, externalReference: reference.trim() || null };
    if (manual) {
      if (!description.trim()) { setMessage({ tone: "error", text: "Enter what the payment is for." }); return; }
      data.description = description.trim();
      const cents = refund.trim() ? toCents(refund) : 0;
      if (cents === null) { setMessage({ tone: "error", text: "Enter the refund in dollars, for example 50.00 (empty when there is none)." }); return; }
      if (cents > 0 && !refundedAt) { setMessage({ tone: "error", text: "Enter the refund date." }); return; }
      data.refundCents = cents; data.refundedAt = cents > 0 ? dayStart(refundedAt) : null;
    }
    setBusy(true);
    try { await financePaymentSave(data); setMessage({ tone: "ok", text: "Saved." }); onSaved(); }
    catch (e) { setMessage({ tone: "error", text: e instanceof Error ? e.message : "The payment could not be saved." }); }
    finally { setBusy(false); }
  };

  return <div className="space-y-3 rounded-lg border border-background-300 bg-background-100 p-3" data-testid="finance-payment-edit">
    <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Edit payment</p>
    <Field label="Fee type"><Select value={feeType} onChange={(e) => setFeeType(e.target.value)} data-testid="finance-edit-fee-type"><option value="">Not set</option>{FEE_TYPES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select></Field>
    <Field label="Student"><Select value={studentId} onChange={(e) => setStudentId(e.target.value)}><option value="">Not linked</option>{students.map((s) => <option key={s.id} value={s.id}>{studentLabel(s)}</option>)}</Select></Field>
    <Field label="Course"><Select value={courseId} onChange={(e) => setCourseId(e.target.value)}><option value="">Not linked</option>{options?.courses.map((c) => <option key={c.id} value={c.id}>{c.code} {c.title}</option>)}</Select></Field>
    <Field label="External reference" hint="Bank, receipt or Xero reference"><TextInput value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} /></Field>
    {manual ? <>
      <Field label="What it was for" required><TextInput value={description} maxLength={250} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Refund (AUD)" hint="Empty or 0 when nothing was refunded"><TextInput inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="0.00" data-testid="finance-edit-refund" /></Field>
        <Field label="Refund date"><TextInput type="date" value={refundedAt} onChange={(e) => setRefundedAt(e.target.value)} /></Field>
      </div>
    </> : <p className="text-xs text-foreground-500">Refunds of {row.source === "xero" ? "Xero" : "Stripe"} payments are recorded automatically from {row.source === "xero" ? "Xero" : "Stripe"}.</p>}
    <div className="flex items-center gap-3">
      <Button size="sm" disabled={busy} onClick={() => void save()} data-testid="finance-edit-save">{busy ? "Saving…" : "Save changes"}</Button>
      {message ? <span role={message.tone === "error" ? "alert" : "status"} className={`text-sm ${message.tone === "ok" ? "text-emerald-800" : "text-primary-800"}`}>{message.text}</span> : null}
    </div>
  </div>;
}

/** "Add payment": a payment taken outside Stripe, recorded as paid (source manual). */
export function AddPaymentModal({ open, options, onClose, onSaved }: { open: boolean; options: FinanceOptions | null; onClose: () => void; onSaved: () => void }) {
  const students = useStudents();
  const [studentId, setStudentId] = useState(""); const [courseId, setCourseId] = useState(""); const [feeType, setFeeType] = useState<string>("tuition");
  const [amount, setAmount] = useState(""); const [paidOn, setPaidOn] = useState(today()); const [description, setDescription] = useState(""); const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { if (open) { setStudentId(""); setCourseId(""); setFeeType("tuition"); setAmount(""); setPaidOn(today()); setDescription(""); setReference(""); setError(""); } }, [open]);
  const save = async () => {
    const cents = toCents(amount);
    if (cents === null || cents < 50) { setError("Enter the amount paid in dollars (at least 0.50)."); return; }
    if (!paidOn) { setError("Enter the date it was paid."); return; }
    if (!description.trim()) { setError("Enter what the payment is for."); return; }
    setBusy(true); setError("");
    try {
      await financePaymentSave({ studentId: studentId || null, courseId: courseId || null, feeType: (feeType || null) as FeeType | null, amountCents: cents, paidAt: dayStart(paidOn),
        description: description.trim(), externalReference: reference.trim() || null });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "The payment could not be added."); }
    finally { setBusy(false); }
  };
  return <Modal open={open} title="Add payment" onClose={onClose}
    footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="finance-add-save">{busy ? "Adding…" : "Add payment"}</Button></>}>
    <div className="grid gap-3 sm:grid-cols-2" data-testid="finance-add-form">
      <p className="sm:col-span-2 text-sm text-foreground-600">For a payment taken outside Stripe (bank transfer, cash, card at the desk). It is recorded as paid.</p>
      <div className="sm:col-span-2"><Field label="Student"><Select value={studentId} onChange={(e) => setStudentId(e.target.value)} data-testid="finance-add-student"><option value="">Not linked</option>{students.map((s) => <option key={s.id} value={s.id}>{studentLabel(s)}</option>)}</Select></Field></div>
      <div className="sm:col-span-2"><Field label="Course"><Select value={courseId} onChange={(e) => setCourseId(e.target.value)}><option value="">Not linked</option>{options?.courses.map((c) => <option key={c.id} value={c.id}>{c.code} {c.title}</option>)}</Select></Field></div>
      <Field label="Fee type" required><Select value={feeType} onChange={(e) => setFeeType(e.target.value)}>{FEE_TYPES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select></Field>
      <Field label="Amount paid (AUD)" required><TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-testid="finance-add-amount" /></Field>
      <Field label="Date paid" required><TextInput type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
      <Field label="Reference" hint="Bank, receipt or Xero reference"><TextInput value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="What it was for" required><TextInput value={description} maxLength={250} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Tuition instalment 2" data-testid="finance-add-description" /></Field></div>
      {error ? <p role="alert" className="sm:col-span-2 text-sm text-primary-800">{error}</p> : null}
    </div>
  </Modal>;
}
