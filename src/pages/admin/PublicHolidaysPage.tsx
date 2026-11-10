import { useCallback, useEffect, useState } from "react";
import { AdminError, AdminLoading, Badge, Button, Card, ConfirmDialog, Field, Modal, PageHeader, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import { deleteHoliday, importHolidays, listHolidays, saveHoliday, type Holiday } from "@/lib/hrmsApi";
import { downloadHolidayTemplate, readHolidayFile, type HolidayImportResult } from "@/lib/holidayImport";
import { fmtDate } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
type HolidayForm = { id: string | null; date: string; name: string; isOptional: boolean; status: "review" | "confirmed"; note: string };

/** Staff > Public Holidays (Victoria): seeded rows wait at "review" until HR confirms them; only confirmed days are paid. */
export default function PublicHolidaysPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [rows, setRows] = useState<Holiday[] | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<HolidayForm | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);
  const [dialogError, setDialogError] = useState(""); const [busy, setBusy] = useState("");
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try { setError(""); setRows(await listHolidays(`${year}-01-01`, `${year}-12-31`)); }
    catch (e) { setError(e instanceof Error ? e.message : "The public holidays could not be loaded."); }
  }, [year]);
  useEffect(() => { void load(); }, [load]);

  const confirm = async (h: Holiday) => {
    setBusy(h.id); setError("");
    try { await saveHoliday(h.id, { status: "confirmed" }); setNotice(`${h.name} (${fmtDate(h.date)}) confirmed.`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The holiday could not be confirmed."); }
    finally { setBusy(""); }
  };
  const confirmAll = async () => {
    setBusy("all"); setError("");
    try { for (const h of (rows ?? []).filter((r) => r.status === "review")) await saveHoliday(h.id, { status: "confirmed" }); setNotice(`Every ${year} holiday is confirmed.`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The holidays could not be confirmed."); }
    finally { setBusy(""); }
  };
  const save = async () => {
    if (!editing) return;
    setBusy("save"); setDialogError("");
    try { await saveHoliday(editing.id, { date: editing.date, name: editing.name, isOptional: editing.isOptional, status: editing.status, note: editing.note }); setEditing(null); setNotice("The holiday was saved."); await load(); }
    catch (e) { setDialogError(e instanceof Error ? e.message : "The holiday could not be saved."); }
    finally { setBusy(""); }
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy("delete"); setError("");
    try { await deleteHoliday(deleting.id); setNotice(`${deleting.name} removed.`); setDeleting(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "The holiday could not be deleted."); }
    finally { setBusy(""); }
  };

  const reviewCount = rows?.filter((r) => r.status === "review").length ?? 0;
  return (
    <div>
      <PageHeader breadcrumb="HRMS" title="Public holidays" description="Victorian public holidays. Full-time and part-time staff are paid their ordinary hours for a confirmed holiday that falls on one of their usual work days. Seeded dates wait at Review until HR confirms them; the Friday before the AFL Grand Final is added by hand each year."
        actions={<>
          <Select value={year} onChange={(e) => setYear(Number(e.target.value))} data-testid="holiday-year">{[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}</Select>
          {reviewCount ? <Button variant="outline" disabled={busy === "all"} onClick={() => void confirmAll()} data-testid="holiday-confirm-all">Confirm all {reviewCount}</Button> : null}
          <Button variant="outline" icon="ri-file-excel-2-line" onClick={() => setImporting(true)} data-testid="holiday-import">Import from Excel</Button>
          <Button onClick={() => { setEditing({ id: null, date: `${year}-09-25`, name: "Friday before the AFL Grand Final", isOptional: false, status: "review", note: "" }); setDialogError(""); }} data-testid="holiday-new">Add holiday</Button>
        </>} />
      {error ? <p role="alert" className={`mb-4 ${ALERT}`}>{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`} data-testid="holiday-notice">{notice}</p> : null}
      {error && !rows ? <AdminError message={error} onRetry={() => void load()} /> : !rows ? <AdminLoading label="Loading holidays…" /> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="holiday-table">
            <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Holiday</th><th className="px-3 py-2">Note</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y divide-background-200">
              {rows.map((h) => (
                <tr key={h.id} data-testid={`holiday-${h.date}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(h.date)}</td>
                  <td className="px-3 py-2 font-medium text-foreground-900">{h.name}{h.isOptional ? <span className="ml-1 text-xs text-foreground-500">(optional, unpaid)</span> : null}</td>
                  <td className="px-3 py-2 text-xs text-foreground-600">{h.note}</td>
                  <td className="px-3 py-2"><Badge tone={h.status === "confirmed" ? "success" : "warn"}>{h.status === "confirmed" ? "Confirmed" : "Review"}</Badge></td>
                  <td className="px-3 py-2 text-right"><span className="flex flex-wrap justify-end gap-1">
                    {h.status === "review" ? <Button size="sm" disabled={busy === h.id} onClick={() => void confirm(h)} data-testid={`holiday-confirm-${h.date}`}>Confirm</Button> : null}
                    <Button size="sm" variant="outline" onClick={() => { setEditing({ id: h.id, date: h.date, name: h.name, isOptional: h.isOptional, status: h.status, note: h.note }); setDialogError(""); }}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(h)} data-testid={`holiday-delete-${h.date}`}>Delete</Button>
                  </span></td>
                </tr>
              ))}
              {!rows.length ? <tr><td colSpan={5} className="px-3 py-4 text-sm text-foreground-600">No holidays listed for {year}.</td></tr> : null}
            </tbody>
          </table>
        </Card>
      )}
      <Modal open={editing !== null} title={editing?.id ? "Edit holiday" : "Add holiday"} onClose={() => setEditing(null)}
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy === "save"} onClick={() => void save()} data-testid="holiday-save">Save</Button></>}>
        {editing ? (
          <div className="space-y-3" data-testid="holiday-dialog">
            <Field label="Date" required><TextInput type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} data-testid="holiday-date" /></Field>
            <Field label="Name" required><TextInput value={editing.name} maxLength={120} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="holiday-name" /></Field>
            <Field label="Note"><TextInput value={editing.note} maxLength={500} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field>
            <Field label="Status"><Select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as "review" | "confirmed" })} data-testid="holiday-status"><option value="review">Review</option><option value="confirmed">Confirmed</option></Select></Field>
            <Toggle label="Optional (not paid)" checked={editing.isOptional} onChange={(v) => setEditing({ ...editing, isOptional: v })} />
            {dialogError ? <p role="alert" className={ALERT}>{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
      {importing ? <HolidayImportDialog year={year} onClose={() => setImporting(false)}
        onDone={(message, importedYear) => { setImporting(false); setNotice(message); setError(""); if (importedYear && importedYear !== year) setYear(importedYear); else void load(); }} /> : null}
      <ConfirmDialog open={deleting !== null} title="Delete holiday" message={deleting ? `Remove ${deleting.name} on ${fmtDate(deleting.date)}? Timesheets stop counting it.` : ""} confirmLabel="Delete" onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />
    </div>
  );
}

/** Import holidays from an Excel (.xlsx) or CSV file: download the template, fill it in, choose it, check the preview, import. */
function HolidayImportDialog({ year, onClose, onDone }: { year: number; onClose: () => void; onDone: (message: string, year?: number) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<HolidayImportResult | null>(null);
  const [status, setStatus] = useState<"review" | "confirmed">("review");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const choose = async (next: File | null) => {
    setFile(next); setParsed(null); setError("");
    if (next) setParsed(await readHolidayFile(next));
  };
  const template = async () => {
    try { await downloadHolidayTemplate(year); } catch { setError("The template could not be created. Please try again."); }
  };
  const run = async () => {
    if (!parsed?.rows.length || parsed.problems.length) return;
    setBusy(true); setError("");
    try {
      const r = await importHolidays(parsed.rows, status);
      const years = [...new Set(parsed.rows.map((h) => Number(h.date.slice(0, 4))))];
      onDone(`Imported ${r.inserted} new and updated ${r.updated} existing holiday${r.inserted + r.updated === 1 ? "" : "s"}${status === "review" ? " (at Review: confirm them to pay them)" : ""}.`, years.includes(year) ? undefined : years[0]);
    } catch (e) { setError(e instanceof Error ? e.message : "The holidays could not be imported."); }
    finally { setBusy(false); }
  };

  const ok = Boolean(parsed && parsed.rows.length && !parsed.problems.length);
  return (
    <Modal open title="Import public holidays" width="max-w-2xl" onClose={() => { if (!busy) onClose(); }}
      footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={!ok || busy} onClick={() => void run()} data-testid="holiday-import-confirm">{busy ? "Importing…" : ok ? `Import ${parsed!.rows.length} holiday${parsed!.rows.length === 1 ? "" : "s"}` : "Import"}</Button></>}>
      <div className="space-y-4" data-testid="holiday-import-dialog">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground-700">
          <li>Download the template, or use your own sheet with the headings <strong>Date</strong> and <strong>Holiday</strong> (optional: Optional, State, Note).</li>
          <li>One holiday per row. Dates as DD/MM/YYYY, YYYY-MM-DD or an Excel date. Optional is Yes or No. A blank State means VIC.</li>
          <li>Choose the file below, check the preview, then import. The same date and name updates the existing holiday.</li>
        </ol>
        <Button variant="outline" size="sm" icon="ri-download-2-line" onClick={() => void template()} data-testid="holiday-template">Download Excel template</Button>
        <Field label="Excel or CSV file" required>
          <input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" disabled={busy}
            onChange={(e) => void choose(e.target.files?.[0] ?? null)} data-testid="holiday-import-file"
            className="block w-full text-sm text-foreground-700 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-primary-800" />
        </Field>
        {file && !parsed ? <p role="status" className="text-sm">Reading {file.name}…</p> : null}
        {parsed?.problems.length ? (
          <div role="alert" className={ALERT} data-testid="holiday-import-problems">
            <p className="font-semibold">Nothing can be imported until these are fixed in the file:</p>
            <ul className="mt-1 list-disc pl-5">{parsed.problems.slice(0, 15).map((p) => <li key={p}>{p}</li>)}</ul>
            {parsed.problems.length > 15 ? <p className="mt-1">…and {parsed.problems.length - 15} more.</p> : null}
          </div>
        ) : null}
        {parsed?.rows.length ? (
          <div>
            <p className="mb-2 text-sm text-foreground-700">{parsed.rows.length} holiday{parsed.rows.length === 1 ? "" : "s"} found{parsed.rows.length > 8 ? " (first 8 shown)" : ""}:</p>
            <Card className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="holiday-import-preview">
                <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Holiday</th><th className="px-3 py-2">Optional</th><th className="px-3 py-2">State</th></tr></thead>
                <tbody className="divide-y divide-background-200">{parsed.rows.slice(0, 8).map((h) => (
                  <tr key={`${h.state ?? ""}${h.date}${h.name}`}><td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(h.date)}</td><td className="px-3 py-1.5">{h.name}</td><td className="px-3 py-1.5">{h.isOptional ? "Yes" : "No"}</td><td className="px-3 py-1.5">{h.state ?? "VIC"}</td></tr>
                ))}</tbody>
              </table>
            </Card>
          </div>
        ) : null}
        <Field label="Import them as">
          <Select value={status} onChange={(e) => setStatus(e.target.value as "review" | "confirmed")} disabled={busy} data-testid="holiday-import-status">
            <option value="review">Review (confirm each one later)</option>
            <option value="confirmed">Confirmed (paid straight away)</option>
          </Select>
        </Field>
        {error ? <p role="alert" className={ALERT}>{error}</p> : null}
      </div>
    </Modal>
  );
}
