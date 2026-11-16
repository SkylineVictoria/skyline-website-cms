import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Field, PageHeader, Select, TextInput } from "@/pages/admin/components/ui";
import { Drawer } from "@/pages/admin/components/rto/shared";
import { downloadCsv } from "@/pages/admin/lib/assessments";
import { financeOptions, financePayments, financeStatus, stripeDashboardUrl, type FinanceFilters, type FinanceOptions, type FinancePage, type FinancePaymentRow } from "@/pages/admin/lib/finance";
import { formatMoney } from "@/lib/signingApi";
import { sendDepositReminder } from "@/pages/agency/lib/portalApplications";

type Preset = "today" | "7d" | "month" | "custom" | "all";
const PAGE_SIZE = 25;
const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A preset as a [from, to) range of local days (the server compares against the paid date, else the created date). */
function presetRange(preset: Preset, custom: { from: string; to: string }): { from?: string; to?: string } {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const plus = (d: Date, days: number) => { const n = new Date(d); n.setDate(n.getDate() + days); return n; };
  if (preset === "today") return { from: isoDay(today), to: isoDay(plus(today, 1)) };
  if (preset === "7d") return { from: isoDay(plus(today, -6)), to: isoDay(plus(today, 1)) };
  if (preset === "month") return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDay(new Date(today.getFullYear(), today.getMonth() + 1, 1)) };
  if (preset === "custom") return { from: custom.from || undefined, to: custom.to ? isoDay(plus(new Date(`${custom.to}T00:00:00`), 1)) : undefined };
  return {};
}
const when = (value: string | null) => (value ? new Date(value).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "");
const TONE = { paid: "success", pending: "warn", failed: "primary", refunded: "muted" } as const;

/** Finance › Payments: every Stripe payment (the offer letters' initial deposits today) with who paid it, for what, and where it stands. */
export default function PaymentsPage() {
  const [preset, setPreset] = useState<Preset>("month");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [status, setStatus] = useState(""); const [courseId, setCourseId] = useState(""); const [agencyId, setAgencyId] = useState(""); const [q, setQ] = useState("");
  const [sort, setSort] = useState<NonNullable<FinanceFilters["sort"]>>("date"); const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FinancePage | null>(null);
  const [options, setOptions] = useState<FinanceOptions | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<FinancePaymentRow | null>(null);
  const [search, setSearch] = useState("");
  /** OFFER-DEPOSIT: Send reminder on a pending deposit; one per 24 hours unless confirmed (P0024). */
  const [reminding, setReminding] = useState<string | null>(null); const [forceFor, setForceFor] = useState<FinancePaymentRow | null>(null);
  const [reminderNote, setReminderNote] = useState<{ id: string; text: string; tone: "ok" | "warn" } | null>(null);
  const remind = async (row: FinancePaymentRow, force: boolean) => {
    if (!row.application_id) return;
    setReminding(row.id); setReminderNote(null); setForceFor(null);
    try { const r = await sendDepositReminder(row.application_id, force); setReminderNote({ id: row.id, tone: "ok", text: `Reminder sent (${r.reminderCount})` }); await load(); }
    catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "P0024" || /less than 24 hours/i.test(err.message)) setForceFor(row); else setReminderNote({ id: row.id, tone: "warn", text: err.message || "The reminder could not be sent." });
    } finally { setReminding(null); }
  };
  const filters = useMemo<FinanceFilters>(() => ({ ...presetRange(preset, custom), status: status || undefined, courseId: courseId || undefined, agencyId: agencyId || undefined, q: q || undefined, sort, dir, page, pageSize: PAGE_SIZE }),
    [preset, custom, status, courseId, agencyId, q, sort, dir, page]);
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { setData(await financePayments(filters)); } catch (e) { setError(e instanceof Error ? e.message : "The payments could not be loaded."); } finally { setBusy(false); }
  }, [filters]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void financeOptions().then(setOptions).catch(() => setOptions({ courses: [], agencies: [], statuses: [] })); }, []);
  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const sortBy = (key: NonNullable<FinanceFilters["sort"]>) => { if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc")); else { setSort(key); setDir(key === "date" || key === "amount" ? "desc" : "asc"); } setPage(1); };
  const arrow = (key: string) => (sort === key ? <i className={dir === "asc" ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line"} aria-hidden="true" /> : null);

  /** Every row of the current filters (page by page, up to the server's cap), as a CSV download. */
  const exportCsv = async () => {
    setBusy(true); setError("");
    try {
      const rows: Record<string, unknown>[] = [];
      for (let p = 1; p <= 40; p++) {
        const chunk = await financePayments({ ...filters, page: p, pageSize: 500 });
        for (const r of chunk.rows) rows.push({ date_paid: r.paid_at ?? "", created: r.created_at, student: r.student_name, student_email: r.student_email, application: r.application_reference ?? "",
          course: [r.course_code, r.course_title].filter(Boolean).join(" "), agency: r.agency_name ?? "", amount: (r.amount_cents / 100).toFixed(2), amount_paid: r.amount_paid_cents != null ? (r.amount_paid_cents / 100).toFixed(2) : "",
          currency: r.currency.toUpperCase(), purpose: r.description, status: financeStatus(r.status).label, mode: r.livemode === false ? "test" : r.livemode ? "live" : "", stripe_payment: r.stripe_payment_intent_id ?? "",
          receipt: r.receipt_url ?? "", signing_reference: r.request_reference ?? "", failure: r.failure_reason ?? "" });
        if (chunk.rows.length < 500 || rows.length >= chunk.total) break;
      }
      if (!rows.length) { setError("Nothing to export for these filters."); return; }
      downloadCsv(`payments-${isoDay(new Date())}.csv`, rows);
    } catch (e) { setError(e instanceof Error ? e.message : "The export failed."); } finally { setBusy(false); }
  };

  const summary = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return <div className="space-y-5" data-testid="finance-payments">
    <PageHeader title="Payments" description="Stripe payments received through Skyline: the initial deposits paid with signed offer letters, and any other payment taken on a signing request." />
    {error ? <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p> : null}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="finance-summary">
      {[["Total collected", summary ? formatMoney(summary.collectedCents - summary.refundedCents, "AUD") : "…", summary?.refundedCents ? `${formatMoney(summary.refundedCents, "AUD")} refunded` : "paid, less refunds"],
        ["Paid", summary ? String(summary.paid) : "…", "payments"], ["Pending", summary ? String(summary.pending) : "…", "awaiting the student"], ["Failed", summary ? String(summary.failed) : "…", "declined or abandoned"]]
        .map(([label, value, hint]) => <div key={label} className="rounded-lg border border-background-300 bg-background-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</p><p className="mt-1 text-2xl font-bold text-foreground-950">{value}</p><p className="text-xs text-foreground-500">{hint}</p></div>)}
    </div>
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-background-300 bg-background-50 p-3" data-testid="finance-filters">
      <Field label="Period"><Select value={preset} onChange={(e) => { setPreset(e.target.value as Preset); setPage(1); }} data-testid="finance-period">
        <option value="today">Today</option><option value="7d">Last 7 days</option><option value="month">This month</option><option value="custom">Custom</option><option value="all">All time</option></Select></Field>
      {preset === "custom" ? <>
        <Field label="From"><TextInput type="date" value={custom.from} onChange={(e) => { setCustom({ ...custom, from: e.target.value }); setPage(1); }} /></Field>
        <Field label="To"><TextInput type="date" value={custom.to} onChange={(e) => { setCustom({ ...custom, to: e.target.value }); setPage(1); }} /></Field>
      </> : null}
      <Field label="Status"><Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} data-testid="finance-status"><option value="">All</option><option value="paid">Paid</option><option value="pending">Pending</option><option value="failed">Failed</option><option value="refunded">Refunded</option></Select></Field>
      <Field label="Course"><Select value={courseId} onChange={(e) => { setCourseId(e.target.value); setPage(1); }}><option value="">All courses</option>{options?.courses.map((c) => <option key={c.id} value={c.id}>{c.code} {c.title}</option>)}</Select></Field>
      <Field label="Agency"><Select value={agencyId} onChange={(e) => { setAgencyId(e.target.value); setPage(1); }}><option value="">All agencies</option>{options?.agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      <Field label="Search"><TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Student, email or reference" data-testid="finance-search" /></Field>
      <span className="flex-1" />
      <Button variant="outline" disabled={busy} onClick={() => void load()}>Refresh</Button>
      <Button variant="outline" icon="ri-download-2-line" disabled={busy || !data?.total} onClick={() => void exportCsv()} data-testid="finance-export">Export CSV</Button>
    </div>
    {!data ? <p role="status">Loading payments…</p> : !data.rows.length ? <p className="rounded-lg border border-dashed border-background-300 p-6 text-center text-sm text-foreground-600">No payments match these filters.</p>
      : <div className="overflow-x-auto rounded-md border border-background-300"><table className="w-full min-w-[960px] text-left text-sm" data-testid="finance-table">
        <thead className="bg-background-100 text-xs text-foreground-600"><tr>
          <th className="px-3 py-2"><button type="button" className="font-semibold" onClick={() => sortBy("date")}>Date paid {arrow("date")}</button></th>
          <th className="px-3"><button type="button" className="font-semibold" onClick={() => sortBy("student")}>Student {arrow("student")}</button></th>
          <th className="px-3">Application</th><th className="px-3">Course</th><th className="px-3">Agency</th>
          <th className="px-3 text-right"><button type="button" className="font-semibold" onClick={() => sortBy("amount")}>Amount {arrow("amount")}</button></th>
          <th className="px-3">Purpose</th>
          <th className="px-3"><button type="button" className="font-semibold" onClick={() => sortBy("status")}>Status {arrow("status")}</button></th>
          <th className="px-3">Stripe</th><th className="px-3">Receipt</th><th className="px-3">Reminders</th></tr></thead>
        <tbody>{data.rows.map((r) => { const s = financeStatus(r.status); const dash = stripeDashboardUrl(r); return <tr key={r.id} className="cursor-pointer border-t border-background-200 hover:bg-background-100" onClick={() => setOpen(r)} data-testid="finance-row">
          <td className="px-3 py-2 whitespace-nowrap">{r.paid_at ? when(r.paid_at) : <span className="text-foreground-500">not paid · created {when(r.created_at)}</span>}</td>
          <td className="px-3"><p className="font-medium text-foreground-900">{r.student_name || "—"}</p><p className="text-xs text-foreground-500">{r.student_email}</p></td>
          <td className="px-3">{r.application_id ? <Link to={`/admin/applications/${r.application_id}`} onClick={(e) => e.stopPropagation()} className="text-primary-700 hover:underline">{r.application_reference || "Application"}</Link> : <span className="text-foreground-500">{r.request_reference ?? "—"}</span>}</td>
          <td className="px-3">{r.course_code ? <><b className="text-foreground-900">{r.course_code}</b> <span className="text-foreground-700">{r.course_title}</span></> : "—"}</td>
          <td className="px-3">{r.agency_name ?? "—"}</td>
          <td className="px-3 text-right whitespace-nowrap">{formatMoney(r.status === "paid" && r.amount_paid_cents != null ? r.amount_paid_cents : r.amount_cents, r.currency)}{r.amount_refunded_cents ? <span className="block text-xs text-foreground-500">−{formatMoney(r.amount_refunded_cents, r.currency)} refunded</span> : null}</td>
          <td className="px-3">{r.description}</td>
          <td className="px-3"><Badge tone={TONE[s.tone]}>{s.label}</Badge>{r.livemode === false ? <span className="ml-1 rounded border border-amber-300 bg-amber-50 px-1 text-2xs font-semibold uppercase text-amber-900">Test</span> : null}</td>
          <td className="px-3">{dash ? <a href={dash} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-primary-700 hover:underline">{r.stripe_payment_intent_id}</a> : <span className="text-xs text-foreground-500">—</span>}</td>
          <td className="px-3">{r.receipt_url ? <a href={r.receipt_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-primary-700 hover:underline">Receipt</a> : <span className="text-xs text-foreground-500">—</span>}</td>
          <td className="px-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
            {["pending", "open", "failed"].includes(r.status) && r.application_id && r.offer_letter_id
              ? <span className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={reminding === r.id} onClick={() => void remind(r, false)} data-testid="finance-send-reminder">{reminding === r.id ? "Sending…" : "Send reminder"}</Button>
                <span className="text-xs text-foreground-500" data-testid="finance-reminder-count">{r.reminder_count ? `${r.reminder_count} sent${r.last_reminder_at ? ` · last ${when(r.last_reminder_at)}` : ""}` : "none sent"}{r.deposit_auto_remind ? " · auto" : ""}</span>
                {reminderNote?.id === r.id ? <span className={`text-xs font-medium ${reminderNote.tone === "ok" ? "text-emerald-800" : "text-red-700"}`} role="status">{reminderNote.text}</span> : null}</span>
              : <span className="text-xs text-foreground-500">{r.reminder_count ? `${r.reminder_count} sent` : "—"}</span>}
          </td>
        </tr>; })}</tbody></table></div>}
    {forceFor ? <div role="dialog" aria-label="Send another reminder?" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="finance-reminder-confirm">
      A reminder for {forceFor.student_name || "this student"} was sent less than 24 hours ago{forceFor.last_reminder_at ? ` (${when(forceFor.last_reminder_at)})` : ""}. Send another one now?
      <span className="ml-3 inline-flex gap-2"><Button size="sm" onClick={() => void remind(forceFor, true)}>Send anyway</Button><Button size="sm" variant="outline" onClick={() => setForceFor(null)}>Cancel</Button></span>
    </div> : null}
    {data && data.total > data.pageSize ? <div className="flex items-center justify-between text-sm"><span>{data.total} payments · page {data.page} of {pages}</span>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={busy || page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button></div></div> : data ? <p className="text-xs text-foreground-500">{data.total} payment{data.total === 1 ? "" : "s"}</p> : null}
    <Drawer open={Boolean(open)} title={open ? `${formatMoney(open.amount_cents, open.currency)} · ${open.description}` : "Payment"} onClose={() => setOpen(null)}>
      {open ? <dl className="space-y-3 text-sm" data-testid="finance-payment-detail">
        {([["Status", <><Badge tone={TONE[financeStatus(open.status).tone]}>{financeStatus(open.status).label}</Badge>{open.livemode === false ? " · Stripe test mode" : ""}</>],
          ["Student", `${open.student_name || "—"}${open.student_email ? ` · ${open.student_email}` : ""}`],
          ["Application", open.application_id ? <Link to={`/admin/applications/${open.application_id}`} className="text-primary-700 underline">{open.application_reference || "Open the application"}</Link> : "—"],
          ["Course", open.course_code ? `${open.course_code} ${open.course_title ?? ""}` : "—"], ["Agency", open.agency_name ?? "—"],
          ["Amount", `${formatMoney(open.amount_cents, open.currency)}${open.amount_paid_cents != null && open.amount_paid_cents !== open.amount_cents ? ` (paid ${formatMoney(open.amount_paid_cents, open.currency)})` : ""}${open.amount_refunded_cents ? ` · ${formatMoney(open.amount_refunded_cents, open.currency)} refunded` : ""}`],
          ["Paid", open.paid_at ? when(open.paid_at) : "Not paid"], ["Created", when(open.created_at)], ["Payer email", open.payer_email ?? "—"],
          ["Signing request", open.request_reference ? `${open.request_reference} · ${open.request_title ?? ""} (${open.request_state ?? ""})` : "—"],
          ["Offer", open.offer_letter_id ? `Offer accepted: ${open.offer_accepted_at ? `Yes (${when(open.offer_accepted_at)})` : "No"} · Deposit: ${open.deposit_paid_at ? `Paid (${when(open.deposit_paid_at)})` : open.status === "paid" ? "Paid" : "Pending"}` : "—"],
          ["Reminders", open.offer_letter_id ? `${open.reminder_count ?? 0} sent${open.last_reminder_at ? ` · last ${when(open.last_reminder_at)}` : ""}${open.deposit_auto_remind ? " · automatic reminders on" : ""}` : "—"],
          ["Stripe", stripeDashboardUrl(open) ? <a href={stripeDashboardUrl(open)!} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary-700 underline">{open.stripe_payment_intent_id}</a> : "—"],
          ["Receipt", open.receipt_url ? <a href={open.receipt_url} target="_blank" rel="noreferrer" className="text-primary-700 underline">Open the Stripe receipt</a> : "—"],
          ["Failure", open.failure_reason ?? "—"]] as Array<[string, React.ReactNode]>).map(([k, v]) => <div key={k}><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{k}</dt><dd className="mt-0.5">{v}</dd></div>)}
      </dl> : null}
    </Drawer>
  </div>;
}
