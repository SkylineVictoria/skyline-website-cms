import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Field, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import { Drawer } from "@/pages/admin/components/rto/shared";
import { downloadCsv } from "@/pages/admin/lib/assessments";
import { formatMoney } from "@/lib/signingApi";
import { INVOICE_STATUS, financeInvoices, type Invoice, type InvoicePage, type InvoiceStatus } from "@/pages/admin/lib/invoices";
import { InvoiceCard } from "@/components/finance/StudentFeesPanel";

const PAGE_SIZE = 25;
const day = (value: string | null) => (value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { dateStyle: "medium" }) : "—");

/** Finance › Invoices (AXCELERATE-FEES): every student invoice with what is paid and owing; overdue ones first to chase. Admins. */
export default function InvoicesPage() {
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const [search, setSearch] = useState(""); const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<InvoicePage | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Invoice | null>(null);
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { setData(await financeInvoices({ status: status || undefined, q: q || undefined, page, pageSize: PAGE_SIZE })); }
    catch (e) { setError(e instanceof Error ? (e.message === "Admins only" ? "Only administrators can see invoices." : e.message) : "The invoices could not be loaded."); }
    finally { setBusy(false); }
  }, [status, q, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const exportCsv = async () => {
    setBusy(true);
    try {
      const rows: Record<string, unknown>[] = [];
      for (let p = 1; p <= 40; p++) {
        const chunk = await financeInvoices({ status: status || undefined, q: q || undefined, page: p, pageSize: 200 });
        for (const r of chunk.rows) rows.push({ invoice: r.number ?? "", date: r.date ?? "", due: r.dueDate ?? "", student: r.studentName, student_number: r.studentNumber ?? "",
          course: [r.courseCode, r.courseTitle].filter(Boolean).join(" "), total: (r.totalCents / 100).toFixed(2), paid: (r.paidCents / 100).toFixed(2),
          credited: (r.creditedCents / 100).toFixed(2), balance: (r.balanceCents / 100).toFixed(2), status: INVOICE_STATUS[r.status].label, source: r.source });
        if (chunk.rows.length < 200 || rows.length >= chunk.total) break;
      }
      if (rows.length) downloadCsv(`invoices-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } catch (e) { setError(e instanceof Error ? e.message : "The export failed."); } finally { setBusy(false); }
  };
  const s = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return <div className="space-y-5" data-testid="finance-invoices">
    <PageHeader title="Invoices" description="Student invoices with their items and payments, and what is still owing. Invoices from aXcelerate are kept equal to aXcelerate by Refresh from aXcelerate." />
    {error ? <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p> : null}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[["Invoiced", s ? formatMoney(s.totalCents, "AUD") : "…", `${s?.invoices ?? "…"} invoices`], ["Paid", s ? formatMoney(s.paidCents, "AUD") : "…", "received"],
        ["Owing", s ? formatMoney(s.balanceCents, "AUD") : "…", "balance of all invoices"], ["Overdue", s ? String(s.overdue) : "…", "invoices past their due date"]]
        .map(([label, value, hint]) => <div key={label} className="rounded-lg border border-background-300 bg-background-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</p><p className="mt-1 text-2xl font-bold text-foreground-950">{value}</p><p className="text-xs text-foreground-500">{hint}</p></div>)}
    </div>
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-background-300 bg-background-50 p-3">
      <Field label="Status"><Select value={status} onChange={(e) => { setStatus(e.target.value as InvoiceStatus | ""); setPage(1); }} data-testid="invoices-status">
        <option value="">All</option>{(Object.keys(INVOICE_STATUS) as InvoiceStatus[]).map((k) => <option key={k} value={k}>{INVOICE_STATUS[k].label}</option>)}</Select></Field>
      <Field label="Search"><TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Student, invoice number or course" data-testid="invoices-search" /></Field>
      <span className="flex-1" />
      <Button variant="outline" disabled={busy} onClick={() => void load()}>Refresh</Button>
      <Button variant="outline" icon="ri-download-2-line" disabled={busy || !data?.total} onClick={() => void exportCsv()}>Export CSV</Button>
    </div>
    {!data ? <p role="status">Loading invoices…</p> : !data.rows.length ? <p className="rounded-lg border border-dashed border-background-300 p-6 text-center text-sm text-foreground-600">No invoices match these filters.</p>
      : <div className="overflow-x-auto rounded-md border border-background-300"><table className="w-full min-w-[900px] text-left text-sm" data-testid="invoices-table">
        <thead className="bg-background-100 text-xs text-foreground-600"><tr><th className="px-3 py-2">Invoice</th><th className="px-3">Date</th><th className="px-3">Due</th><th className="px-3">Student</th><th className="px-3">Course</th>
          <th className="px-3 text-right">Total</th><th className="px-3 text-right">Paid</th><th className="px-3 text-right">Balance</th><th className="px-3">Status</th></tr></thead>
        <tbody>{data.rows.map((r) => <tr key={r.id} className="cursor-pointer border-t border-background-200 hover:bg-background-100" onClick={() => setOpen(r)} data-testid="invoices-row">
          <td className="px-3 py-2 font-medium">{r.number || "—"}{r.source === "axcelerate" ? <span className="block text-xs text-foreground-500">aXcelerate</span> : null}</td>
          <td className="px-3 whitespace-nowrap">{day(r.date)}</td><td className="px-3 whitespace-nowrap">{day(r.dueDate)}</td>
          <td className="px-3">{r.studentName}{r.studentNumber ? <span className="block text-xs text-foreground-500">{r.studentNumber}</span> : null}</td>
          <td className="px-3">{r.courseCode ?? "—"}</td>
          <td className="px-3 text-right">{formatMoney(r.totalCents, "AUD")}</td><td className="px-3 text-right">{formatMoney(r.paidCents, "AUD")}</td>
          <td className={`px-3 text-right ${r.balanceCents ? "font-semibold text-red-700" : ""}`}>{formatMoney(r.balanceCents, "AUD")}</td>
          <td className="px-3"><Badge tone={INVOICE_STATUS[r.status].tone}>{INVOICE_STATUS[r.status].label}</Badge></td></tr>)}</tbody></table></div>}
    {data && data.total > data.pageSize ? <div className="flex items-center justify-between text-sm"><span>{data.total} invoices · page {data.page} of {pages}</span>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={busy || page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button></div></div> : null}
    <Drawer open={Boolean(open)} title={open ? `Invoice ${open.number ?? ""}` : "Invoice"} onClose={() => setOpen(null)}>
      {open ? <InvoiceCard invoice={open} showStudent /> : null}
    </Drawer>
  </div>;
}
