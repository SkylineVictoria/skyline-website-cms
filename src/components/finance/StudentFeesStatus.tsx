import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { Drawer } from "@/pages/admin/components/rto/shared";
import { downloadCsv } from "@/pages/admin/lib/assessments";
import { formatMoney } from "@/lib/signingApi";
import { STUDENT_FEES_STATUS, financeStudentFees, type StudentFeesPage, type StudentFeesRow, type StudentFeesStatus } from "@/pages/admin/lib/invoices";
import StudentFeesPanel from "./StudentFeesPanel";

const PAGE_SIZE = 25;
const day = (value: string | null) => (value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { dateStyle: "medium" }) : "—");
const money = (cents: number | null | undefined) => formatMoney(cents ?? 0, "AUD");

/**
 * Finance › Invoices › By student (FEES-BY-STUDENT, owner 2026-11-28): one line per student with their invoice status: invoices, total,
 * paid, owing, overdue, next due and last payment, overdue students first. A line opens the student's invoices (pay, edit, void there).
 */
export default function StudentFeesStatusView() {
  const [status, setStatus] = useState<StudentFeesStatus | "">("");
  const [search, setSearch] = useState(""); const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StudentFeesPage | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<StudentFeesRow | null>(null);
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { setData(await financeStudentFees({ status: status || undefined, q: q || undefined, page, pageSize: PAGE_SIZE })); }
    catch (e) { setError(e instanceof Error ? (e.message === "Admins only" ? "Only administrators can see invoices." : e.message) : "The students' fees could not be loaded."); }
    finally { setBusy(false); }
  }, [status, q, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const exportCsv = async () => {
    setBusy(true);
    try {
      const rows: Record<string, unknown>[] = [];
      for (let p = 1; p <= 40; p++) {
        const chunk = await financeStudentFees({ status: status || undefined, q: q || undefined, page: p, pageSize: 200 });
        for (const r of chunk.rows) rows.push({ student: r.studentName, student_number: r.studentNumber ?? "", email: r.email ?? "", courses: r.courses.join(" "),
          invoices: r.invoices, total: (r.totalCents / 100).toFixed(2), paid: (r.paidCents / 100).toFixed(2), owing: (r.balanceCents / 100).toFixed(2),
          overdue: (r.overdueCents / 100).toFixed(2), next_due: r.nextDueDate ?? "", next_due_amount: r.nextDueCents == null ? "" : (r.nextDueCents / 100).toFixed(2),
          last_payment: r.lastPaymentAt?.slice(0, 10) ?? "", status: STUDENT_FEES_STATUS[r.status].label });
        if (chunk.rows.length < 200 || rows.length >= chunk.total) break;
      }
      if (rows.length) downloadCsv(`student-fees-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } catch (e) { setError(e instanceof Error ? e.message : "The export failed."); } finally { setBusy(false); }
  };
  const s = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const pick = (next: StudentFeesStatus | "") => { setStatus(next); setPage(1); };
  return <div className="space-y-4" data-testid="student-fees-status">
    {error ? <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p> : null}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {([["overdue", "Overdue", s ? `${s.overdue} student${s.overdue === 1 ? "" : "s"}` : "…", s ? `${money(s.overdueCents)} past due` : ""],
        ["owing", "Owing (not yet due)", s ? `${s.owing} student${s.owing === 1 ? "" : "s"}` : "…", s ? `${money(s.balanceCents - s.overdueCents)} still to pay` : ""],
        ["paid", "Paid up", s ? `${s.paid} student${s.paid === 1 ? "" : "s"}` : "…", "nothing owing"],
        ["", "All students", s ? `${s.students}` : "…", s ? `${money(s.balanceCents)} owing in total` : ""]] as const)
        .map(([key, label, value, hint]) => <button key={label} type="button" onClick={() => pick(key)} aria-pressed={status === key}
          className={`rounded-lg border p-4 text-left ${status === key ? "border-primary-600 bg-primary-50" : "border-background-300 bg-background-50 hover:bg-background-100"}`}>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</p><p className="mt-1 text-2xl font-bold text-foreground-950">{value}</p><p className="text-xs text-foreground-500">{hint}</p>
        </button>)}
    </div>
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-background-300 bg-background-50 p-3">
      <Field label="Status"><Select value={status} onChange={(e) => pick(e.target.value as StudentFeesStatus | "")} data-testid="student-fees-filter">
        <option value="">All</option>{(Object.keys(STUDENT_FEES_STATUS) as StudentFeesStatus[]).map((k) => <option key={k} value={k}>{STUDENT_FEES_STATUS[k].label}</option>)}</Select></Field>
      <Field label="Search"><TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Student, student number, invoice or course" data-testid="student-fees-search" /></Field>
      <span className="flex-1" />
      <Button variant="outline" disabled={busy} onClick={() => void load()}>Refresh</Button>
      <Button variant="outline" icon="ri-download-2-line" disabled={busy || !data?.total} onClick={() => void exportCsv()}>Export CSV</Button>
    </div>
    {!data ? <p role="status">Loading students…</p> : !data.rows.length ? <p className="rounded-lg border border-dashed border-background-300 p-6 text-center text-sm text-foreground-600">No students with invoices match these filters.</p>
      : <div className="overflow-x-auto rounded-md border border-background-300"><table className="w-full min-w-[960px] text-left text-sm" data-testid="student-fees-table">
        <thead className="bg-background-100 text-xs text-foreground-600"><tr><th className="px-3 py-2">Student</th><th className="px-3">Course</th><th className="px-3 text-right">Invoices</th>
          <th className="px-3 text-right">Total</th><th className="px-3 text-right">Paid</th><th className="px-3 text-right">Owing</th><th className="px-3 text-right">Overdue</th>
          <th className="px-3">Next due</th><th className="px-3">Last payment</th><th className="px-3">Status</th></tr></thead>
        <tbody>{data.rows.map((r) => <tr key={r.studentId} className="cursor-pointer border-t border-background-200 hover:bg-background-100" onClick={() => setOpen(r)} data-testid="student-fees-row">
          <td className="px-3 py-2 font-medium">{r.studentName}{r.studentNumber ? <span className="block text-xs text-foreground-500">{r.studentNumber}</span> : null}</td>
          <td className="px-3">{r.courses.length ? r.courses.join(", ") : "—"}</td>
          <td className="px-3 text-right">{r.invoices}</td>
          <td className="px-3 text-right">{money(r.totalCents)}</td><td className="px-3 text-right">{money(r.paidCents)}</td>
          <td className={`px-3 text-right ${r.balanceCents > 0 ? "font-semibold" : ""}`}>{money(r.balanceCents)}</td>
          <td className={`px-3 text-right ${r.overdueCents > 0 ? "font-semibold text-red-700" : ""}`}>{r.overdueCents > 0 ? `${money(r.overdueCents)} (${r.overdueInvoices})` : "—"}</td>
          <td className="px-3 whitespace-nowrap">{r.nextDueDate ? <>{day(r.nextDueDate)}<span className="block text-xs text-foreground-500">{money(r.nextDueCents)}</span></> : "—"}</td>
          <td className="px-3 whitespace-nowrap">{day(r.lastPaymentAt)}</td>
          <td className="px-3"><Badge tone={STUDENT_FEES_STATUS[r.status].tone}>{STUDENT_FEES_STATUS[r.status].label}</Badge></td></tr>)}</tbody></table></div>}
    {data && data.total > data.pageSize ? <div className="flex items-center justify-between text-sm"><span>{data.total} students · page {data.page} of {pages}</span>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={busy || page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button></div></div> : null}
    <Drawer open={Boolean(open)} title={open ? `${open.studentName} · invoices` : "Invoices"} onClose={() => { setOpen(null); void load(); }}>
      {open ? <StudentFeesPanel studentId={open.studentId} /> : null}
    </Drawer>
  </div>;
}
