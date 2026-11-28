import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "@/pages/admin/components/ui";
import { InvoiceEditorModal, InvoicePaymentModal } from "@/components/finance/InvoiceEditor";
import { financeInvoiceSave } from "@/pages/admin/lib/invoices";
import { formatMoney } from "@/lib/signingApi";
import { feeTypeLabel } from "@/pages/admin/lib/finance";
import { INVOICE_STATUS, studentInvoices, type Invoice, type InvoiceTotals } from "@/pages/admin/lib/invoices";

const day = (value: string | null) => (value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { dateStyle: "medium" }) : "—");

/** One invoice: number, dates, status, items and payments. Used by the student's Fees tab and Finance › Invoices. */
export function InvoiceCard({ invoice, showStudent = false, onChanged }: { invoice: Invoice; showStudent?: boolean; onChanged?: () => void }) {
  const s = INVOICE_STATUS[invoice.status];
  const [editing, setEditing] = useState(false); const [paying, setPaying] = useState(false); const [error, setError] = useState("");
  const toggleVoid = async () => {
    setError("");
    try { await financeInvoiceSave({ id: invoice.id, void: invoice.status !== "void" }); onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "The invoice could not be changed."); }
  };
  return <Card className="p-4" data-testid="invoice-card">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="font-heading text-[15px] font-semibold text-foreground-900">Invoice {invoice.number || "(no number)"} <Badge tone={s.tone}>{s.label}</Badge>
          {invoice.source === "axcelerate" ? <span className="ml-2 text-xs font-normal text-foreground-500">from aXcelerate</span> : null}</p>
        {invoice.description ? <p className="text-sm text-foreground-700">{invoice.description}</p> : null}
        <p className="text-sm text-foreground-600">{[showStudent ? `${invoice.studentName}${invoice.studentNumber ? ` (${invoice.studentNumber})` : ""}` : "", invoice.courseCode ? `${invoice.courseCode} ${invoice.courseTitle ?? ""}` : "",
          `Issued ${day(invoice.date)}`, invoice.dueDate ? `due ${day(invoice.dueDate)}` : ""].filter(Boolean).join(" · ")}</p>
      </div>
      <dl className="grid grid-cols-3 gap-4 text-right text-sm">
        <div><dt className="text-xs text-foreground-500">Total</dt><dd className="font-semibold">{formatMoney(invoice.totalCents, "AUD")}</dd></div>
        <div><dt className="text-xs text-foreground-500">Paid</dt><dd className="font-semibold text-emerald-800">{formatMoney(invoice.paidCents, "AUD")}</dd></div>
        <div><dt className="text-xs text-foreground-500">Balance</dt><dd className={`font-semibold ${invoice.balanceCents ? "text-red-700" : ""}`}>{formatMoney(invoice.balanceCents, "AUD")}</dd></div>
      </dl>
    </div>
    {invoice.items.length ? <table className="mt-3 w-full text-sm"><thead className="text-xs text-foreground-500"><tr><th className="py-1 text-left">Item</th><th className="text-left">Fee type</th><th className="text-right">Qty</th><th className="text-right">Amount</th></tr></thead>
      <tbody>{invoice.items.map((i, n) => <tr key={n} className="border-t border-background-200"><td className="py-1">{i.description}</td><td>{feeTypeLabel(i.feeType)}</td><td className="text-right">{i.quantity}</td><td className="text-right">{formatMoney(i.totalCents, "AUD")}</td></tr>)}</tbody></table> : null}
    {invoice.creditedCents ? <p className="mt-2 text-sm text-foreground-600">Credited: {formatMoney(invoice.creditedCents, "AUD")}</p> : null}
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Payments</p>
      {invoice.payments.length ? <ul className="mt-1 space-y-1 text-sm">{invoice.payments.map((p) => <li key={p.id} className="flex flex-wrap justify-between gap-2">
        <span>{day(p.paidAt)} · {p.description}</span><span className="font-medium">{formatMoney(p.amountCents, "AUD")}{p.refundedCents ? ` (−${formatMoney(p.refundedCents, "AUD")} refunded)` : ""}</span></li>)}</ul>
        : <p className="text-sm text-foreground-500">No payments.</p>}
    </div>
    {invoice.source === "manual" && onChanged ? <div className="mt-3 flex flex-wrap gap-2" data-testid="invoice-actions">
      {invoice.status !== "void" && invoice.balanceCents > 0 ? <Button size="sm" icon="ri-bank-card-line" onClick={() => setPaying(true)} data-testid="invoice-record-payment">Record payment</Button> : null}
      {invoice.status !== "void" ? <Button size="sm" variant="outline" icon="ri-edit-line" onClick={() => setEditing(true)}>Edit</Button> : null}
      <Button size="sm" variant="outline" onClick={() => void toggleVoid()}>{invoice.status === "void" ? "Restore" : "Void"}</Button>
    </div> : invoice.source === "axcelerate" ? <p className="mt-3 text-xs text-foreground-500">Read only: change it or record payments in aXcelerate; Refresh from aXcelerate brings them.</p> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
    {onChanged ? <><InvoiceEditorModal open={editing} invoice={invoice} onClose={() => setEditing(false)} onSaved={onChanged} />
      <InvoicePaymentModal open={paying} invoice={invoice} onClose={() => setPaying(false)} onSaved={onChanged} /></> : null}
  </Card>;
}

/** The student page's Fees tab: every invoice of the student with totals (admins). */
export default function StudentFeesPanel({ studentId }: { studentId: string }) {
  const [data, setData] = useState<{ invoices: Invoice[]; totals: InvoiceTotals } | null>(null);
  const [error, setError] = useState(""); const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    studentInvoices(studentId).then(setData).catch((e) => setError(e instanceof Error ? e.message : "The fees could not be loaded."));
  }, [studentId]);
  useEffect(() => { load(); }, [load]);
  if (error) return <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error === "Admins only" ? "Only administrators can see a student's fees." : error}</p>;
  if (!data) return <p role="status" className="text-sm text-foreground-600">Loading fees…</p>;
  const t = data.totals;
  return <div className="space-y-4" data-testid="student-fees">
    <div className="flex justify-end"><Button icon="ri-add-line" onClick={() => setAdding(true)} data-testid="student-fees-new-invoice">New invoice</Button></div>
    <InvoiceEditorModal open={adding} studentId={studentId} onClose={() => setAdding(false)} onSaved={load} />
    <div className="grid gap-3 sm:grid-cols-4">
      {[["Invoiced", t.totalCents], ["Paid", t.paidCents], ["Balance", t.balanceCents], ["Overdue", t.overdueCents]].map(([label, cents]) =>
        <div key={label as string} className="rounded-lg border border-background-300 bg-background-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</p>
          <p className={`mt-1 text-xl font-bold ${label === "Overdue" && (cents as number) > 0 ? "text-red-700" : "text-foreground-950"}`}>{formatMoney(cents as number, "AUD")}</p></div>)}
    </div>
    {data.invoices.length ? data.invoices.map((i) => <InvoiceCard key={`${i.id}:${i.paidCents}:${i.status}:${i.totalCents}`} invoice={i} onChanged={load} />)
      : <p className="rounded-lg border border-dashed border-background-300 p-6 text-center text-sm text-foreground-600">No invoices yet. Add one with New invoice, or bring them from aXcelerate with Refresh from aXcelerate.</p>}
  </div>;
}
