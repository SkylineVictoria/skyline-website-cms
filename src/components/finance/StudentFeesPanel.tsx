import { useEffect, useState } from "react";
import { Badge, Card } from "@/pages/admin/components/ui";
import { formatMoney } from "@/lib/signingApi";
import { feeTypeLabel } from "@/pages/admin/lib/finance";
import { INVOICE_STATUS, studentInvoices, type Invoice, type InvoiceTotals } from "@/pages/admin/lib/invoices";

const day = (value: string | null) => (value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { dateStyle: "medium" }) : "—");

/** One invoice: number, dates, status, items and payments. Used by the student's Fees tab and Finance › Invoices. */
export function InvoiceCard({ invoice, showStudent = false }: { invoice: Invoice; showStudent?: boolean }) {
  const s = INVOICE_STATUS[invoice.status];
  return <Card className="p-4" data-testid="invoice-card">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="font-heading text-[15px] font-semibold text-foreground-900">Invoice {invoice.number || "(no number)"} <Badge tone={s.tone}>{s.label}</Badge>
          {invoice.source === "axcelerate" ? <span className="ml-2 text-xs font-normal text-foreground-500">from aXcelerate</span> : null}</p>
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
  </Card>;
}

/** The student page's Fees tab: every invoice of the student with totals (admins). */
export default function StudentFeesPanel({ studentId }: { studentId: string }) {
  const [data, setData] = useState<{ invoices: Invoice[]; totals: InvoiceTotals } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    studentInvoices(studentId).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The fees could not be loaded."); });
    return () => { live = false; };
  }, [studentId]);
  if (error) return <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error === "Admins only" ? "Only administrators can see a student's fees." : error}</p>;
  if (!data) return <p role="status" className="text-sm text-foreground-600">Loading fees…</p>;
  const t = data.totals;
  return <div className="space-y-4" data-testid="student-fees">
    <div className="grid gap-3 sm:grid-cols-4">
      {[["Invoiced", t.totalCents], ["Paid", t.paidCents], ["Balance", t.balanceCents], ["Overdue", t.overdueCents]].map(([label, cents]) =>
        <div key={label as string} className="rounded-lg border border-background-300 bg-background-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</p>
          <p className={`mt-1 text-xl font-bold ${label === "Overdue" && (cents as number) > 0 ? "text-red-700" : "text-foreground-950"}`}>{formatMoney(cents as number, "AUD")}</p></div>)}
    </div>
    {data.invoices.length ? data.invoices.map((i) => <InvoiceCard key={i.id} invoice={i} />)
      : <p className="rounded-lg border border-dashed border-background-300 p-6 text-center text-sm text-foreground-600">No invoices yet. Invoices come from aXcelerate with Refresh from aXcelerate.</p>}
  </div>;
}
