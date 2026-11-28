import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { FEE_TYPES, financeOptions, financePaymentStudents, type FeeType, type FinanceOptions, type PaymentStudent } from "@/pages/admin/lib/finance";
import { financeInvoicePayment, financeInvoiceSave, type Invoice } from "@/pages/admin/lib/invoices";
import { formatMoney } from "@/lib/signingApi";

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toCents = (value: string): number | null => { const v = value.replace(/[$,\s]/g, ""); if (!/^\d+(\.\d{1,2})?$/.test(v)) return null; return Math.round(Number(v) * 100); };
type Line = { description: string; feeType: FeeType; quantity: string; amount: string };
const blank = (): Line => ({ description: "", feeType: "tuition", quantity: "1", amount: "" });

/** New or edit a Skyline invoice (FEES-MANUAL): student, course, number (blank = next INV number), dates and items. */
export function InvoiceEditorModal({ open, invoice, studentId, onClose, onSaved }: { open: boolean; invoice?: Invoice | null; studentId?: string; onClose: () => void; onSaved: () => void }) {
  const [students, setStudents] = useState<PaymentStudent[]>([]); const [options, setOptions] = useState<FinanceOptions | null>(null);
  const [student, setStudent] = useState(""); const [course, setCourse] = useState(""); const [number, setNumber] = useState("");
  const [date, setDate] = useState(today()); const [due, setDue] = useState(""); const [description, setDescription] = useState("");
  const [lines, setLines] = useState<Line[]>([blank()]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    void financePaymentStudents().then(setStudents).catch(() => setStudents([]));
    void financeOptions().then(setOptions).catch(() => setOptions(null));
    setStudent(invoice?.studentId ?? studentId ?? ""); setCourse(invoice?.courseId ?? ""); setNumber(invoice?.number ?? "");
    setDate(invoice?.date?.slice(0, 10) ?? today()); setDue(invoice?.dueDate?.slice(0, 10) ?? ""); setDescription(invoice?.description ?? "");
    setLines(invoice?.items.length ? invoice.items.map((i) => ({ description: i.description, feeType: i.feeType, quantity: String(i.quantity), amount: ((i.unitCents ?? i.totalCents) / 100).toFixed(2) })) : [blank()]);
    setError("");
  }, [open, invoice, studentId]);
  const set = (n: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const total = lines.reduce((sum, l) => sum + (toCents(l.amount) ?? 0) * (Number(l.quantity) || 0), 0);
  const save = async () => {
    if (!student) { setError("Choose the student."); return; }
    const items = [];
    for (const [n, l] of lines.entries()) {
      const cents = toCents(l.amount); const qty = Number(l.quantity);
      if (!l.description.trim()) { setError(`Item ${n + 1}: enter what it is for.`); return; }
      if (cents === null || !(qty > 0)) { setError(`Item ${n + 1}: enter a quantity and an amount in dollars.`); return; }
      items.push({ description: l.description.trim(), feeType: l.feeType, quantity: qty, unitCents: cents });
    }
    setBusy(true); setError("");
    try {
      await financeInvoiceSave({ id: invoice?.id, studentId: student, courseId: course || null, number: number.trim() || null, date, dueDate: due || null, description: description.trim() || null, items });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "The invoice could not be saved."); } finally { setBusy(false); }
  };
  return <Modal open={open} title={invoice ? `Edit invoice ${invoice.number ?? ""}` : "New invoice"} onClose={onClose}
    footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="invoice-save">{busy ? "Saving…" : "Save invoice"}</Button></>}>
    <div className="grid gap-3 sm:grid-cols-2" data-testid="invoice-form">
      <div className="sm:col-span-2"><Field label="Student" required><Select value={student} onChange={(e) => setStudent(e.target.value)} data-testid="invoice-student"><option value="">Choose…</option>
        {students.map((s) => <option key={s.id} value={s.id}>{[s.name, s.studentNumber, s.email].filter(Boolean).join(" · ")}</option>)}</Select></Field></div>
      <div className="sm:col-span-2"><Field label="Course"><Select value={course} onChange={(e) => setCourse(e.target.value)}><option value="">Not linked</option>{options?.courses.map((c) => <option key={c.id} value={c.id}>{c.code} {c.title}</option>)}</Select></Field></div>
      <Field label="Invoice number" hint="Blank: the next number (INV-year-00001)"><TextInput value={number} maxLength={60} onChange={(e) => setNumber(e.target.value)} /></Field>
      <Field label="Description"><TextInput value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Tuition instalment 2" /></Field>
      <Field label="Invoice date" required><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Due date"><TextInput type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <div className="sm:col-span-2 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Items</p>
        {lines.map((l, n) => <div key={n} className="grid grid-cols-12 gap-2" data-testid="invoice-line">
          <div className="col-span-5"><TextInput value={l.description} maxLength={300} onChange={(e) => set(n, { description: e.target.value })} placeholder="Item" aria-label={`Item ${n + 1}`} /></div>
          <div className="col-span-3"><Select value={l.feeType} onChange={(e) => set(n, { feeType: e.target.value as FeeType })} aria-label="Fee type">{FEE_TYPES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select></div>
          <div className="col-span-1"><TextInput inputMode="decimal" value={l.quantity} onChange={(e) => set(n, { quantity: e.target.value })} aria-label="Quantity" /></div>
          <div className="col-span-2"><TextInput inputMode="decimal" value={l.amount} onChange={(e) => set(n, { amount: e.target.value })} placeholder="0.00" aria-label="Amount (AUD)" /></div>
          <div className="col-span-1"><Button variant="outline" size="sm" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, i) => i !== n))} aria-label="Remove item">×</Button></div>
        </div>)}
        <div className="flex items-center justify-between"><Button variant="outline" size="sm" icon="ri-add-line" onClick={() => setLines((ls) => [...ls, blank()])}>Add item</Button>
          <span className="text-sm font-semibold">Total {formatMoney(total, "AUD")}</span></div>
      </div>
      {error ? <p role="alert" className="sm:col-span-2 text-sm text-primary-800">{error}</p> : null}
    </div>
  </Modal>;
}

/** Record a payment against a Skyline invoice (a manual payment linked to it). */
export function InvoicePaymentModal({ open, invoice, onClose, onSaved }: { open: boolean; invoice: Invoice | null; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(""); const [paidOn, setPaidOn] = useState(today()); const [method, setMethod] = useState(""); const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { if (open && invoice) { setAmount((invoice.balanceCents / 100).toFixed(2)); setPaidOn(today()); setMethod(""); setReference(""); setError(""); } }, [open, invoice]);
  const save = async () => {
    if (!invoice) return;
    const cents = toCents(amount);
    if (cents === null || cents < 50) { setError("Enter the amount paid in dollars (at least 0.50)."); return; }
    setBusy(true); setError("");
    try { await financeInvoicePayment(invoice.id, { amountCents: cents, paidAt: new Date(`${paidOn}T00:00:00`).toISOString(), method: method.trim(), reference: reference.trim() }); onSaved(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "The payment could not be recorded."); } finally { setBusy(false); }
  };
  return <Modal open={open} title={`Record payment${invoice?.number ? ` · ${invoice.number}` : ""}`} onClose={onClose}
    footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="invoice-payment-save">{busy ? "Saving…" : "Record payment"}</Button></>}>
    <div className="grid gap-3 sm:grid-cols-2" data-testid="invoice-payment-form">
      <p className="sm:col-span-2 text-sm text-foreground-600">Balance {formatMoney(invoice?.balanceCents ?? 0, "AUD")}. The payment is added to Finance › Payments as a manual payment for this invoice.</p>
      <Field label="Amount paid (AUD)" required><TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="invoice-payment-amount" /></Field>
      <Field label="Date paid" required><TextInput type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
      <Field label="Method"><TextInput value={method} maxLength={60} onChange={(e) => setMethod(e.target.value)} placeholder="Bank transfer, card, cash…" /></Field>
      <Field label="Reference"><TextInput value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} /></Field>
      {error ? <p role="alert" className="sm:col-span-2 text-sm text-primary-800">{error}</p> : null}
    </div>
  </Modal>;
}
