import { useCallback, useEffect, useState } from "react";
import { AdminError, AdminLoading, Badge, Button, Card, ConfirmDialog, Field, Modal, PageHeader, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import {
  addHolidays, deleteHoliday, holidaySyncStatus, holidaySyncWarning, importHolidays, listHolidays, listOptionalRules, saveHoliday, saveOptionalRule, syncHolidaysNow,
  type Holiday, type HolidaySyncStatus, type NewHolidayInput, type OptionalRule,
} from "@/lib/hrmsApi";
import { downloadHolidayTemplate, readHolidayFile, type HolidayImportResult } from "@/lib/holidayImport";
import { fmtDate, fmtDateTime } from "@/lib/hrTime";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
type HolidayForm = { id: string | null; date: string; name: string; isOptional: boolean; status: "review" | "confirmed"; note: string };
type NewEntry = { key: number; name: string; startDate: string; endDate: string; isOptional: boolean; note: string };
const SOURCE_LABEL: Record<string, string> = { api: "API", manual: "Manual", import: "Import", seed: "Seeded" };
const SYNC_SOURCE_LABEL: Record<string, string> = { "data.gov.au": "data.gov.au", nager: "Nager.Date" };

/** Staff > Public holidays (Victoria): synced weekly from the official sources (data.gov.au, then Nager.Date), plus optional holidays and hand entries. */
export default function PublicHolidaysPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [type, setType] = useState<"" | "public" | "optional">("");
  const [rows, setRows] = useState<Holiday[] | null>(null);
  const [sync, setSync] = useState<HolidaySyncStatus | null>(null);
  const [rules, setRules] = useState<OptionalRule[] | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<HolidayForm | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);
  const [dialogError, setDialogError] = useState(""); const [busy, setBusy] = useState("");
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try { setError(""); setRows(await listHolidays(`${year}-01-01`, `${year}-12-31`)); }
    catch (e) { setError(e instanceof Error ? e.message : "The public holidays could not be loaded."); }
  }, [year]);
  const loadSide = useCallback(async () => {
    const [s, r] = await Promise.allSettled([holidaySyncStatus(), listOptionalRules()]);
    if (s.status === "fulfilled") setSync(s.value);
    if (r.status === "fulfilled") setRules(r.value);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSide(); }, [loadSide]);

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
    catch (e) { setError(e instanceof Error ? e.message : "The holiday could not be deleted."); setDeleting(null); }
    finally { setBusy(""); }
  };
  const syncNow = async () => {
    setBusy("sync"); setError(""); setNotice("");
    try {
      const run = await syncHolidaysNow();
      const sources = Object.entries(run.sources ?? {}).map(([y, s]) => `${y} from ${SYNC_SOURCE_LABEL[s] ?? s}`).join(", ");
      setNotice(run.status === "ok"
        ? `Synced ${sources}: ${run.inserted} added, ${run.updated} updated, ${run.unchanged} unchanged${run.demoted ? `, ${run.demoted} put back to review` : ""}${run.keptManual ? `, ${run.keptManual} hand-entered kept` : ""}.`
        : `The sync could not read the holiday sources: ${run.error}. Nothing was changed.`);
      await Promise.all([load(), loadSide()]);
    } catch (e) { setError(e instanceof Error ? e.message : "The holidays could not be synced."); await loadSide(); }
    finally { setBusy(""); }
  };

  const shown = (rows ?? []).filter((h) => !type || h.type === type);
  const reviewCount = rows?.filter((r) => r.status === "review").length ?? 0;
  const warning = holidaySyncWarning(sync);
  const lastOk = sync?.lastOk;
  return (
    <div>
      <PageHeader breadcrumb="HRMS" title="Public holidays" description="Victorian public holidays are synced every week from data.gov.au (Nager.Date when it has no list for the year) and confirmed automatically; what HR adds, imports or edits by hand is never changed by the sync. Full-time and part-time staff are paid their ordinary hours for a confirmed public holiday on one of their usual work days. Optional holidays are picked by each employee in My HR, up to the yearly allowance below, and approved like leave."
        actions={<>
          <Select value={year} onChange={(e) => setYear(Number(e.target.value))} data-testid="holiday-year">{[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}</Select>
          <Select value={type} onChange={(e) => setType(e.target.value as "" | "public" | "optional")} data-testid="holiday-type-filter"><option value="">All types</option><option value="public">Public</option><option value="optional">Optional</option></Select>
          {reviewCount ? <Button variant="outline" disabled={busy === "all"} onClick={() => void confirmAll()} data-testid="holiday-confirm-all">Confirm all {reviewCount}</Button> : null}
          <Button variant="outline" icon="ri-refresh-line" disabled={busy === "sync"} onClick={() => void syncNow()} data-testid="holiday-sync-now">{busy === "sync" ? "Syncing…" : "Sync now"}</Button>
          <Button variant="outline" icon="ri-file-excel-2-line" onClick={() => setImporting(true)} data-testid="holiday-import">Import from Excel</Button>
          <Button onClick={() => setAdding(true)} data-testid="holiday-new">Add holidays</Button>
        </>} />
      <p className="mb-3 text-sm text-foreground-600" data-testid="holiday-sync-status">
        {lastOk ? <>Last synced {fmtDateTime(lastOk.startedAt)} ({Object.entries(lastOk.sources).map(([y, s]) => `${y}: ${SYNC_SOURCE_LABEL[s] ?? s}`).join(", ")}; {lastOk.trigger === "cron" ? "weekly job" : "Sync now"}).</> : "Not synced yet."}
        {sync?.cronActive ? " The weekly job runs on Mondays." : ""}
      </p>
      {warning ? <p role="alert" className={`mb-4 ${ALERT}`} data-testid="holiday-sync-warning">{warning}</p> : null}
      {error ? <p role="alert" className={`mb-4 ${ALERT}`}>{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`} data-testid="holiday-notice">{notice}</p> : null}
      {error && !rows ? <AdminError message={error} onRetry={() => void load()} /> : !rows ? <AdminLoading label="Loading holidays…" /> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[840px] text-left text-sm" data-testid="holiday-table">
            <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Holiday</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Note</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" /></tr></thead>
            <tbody className="divide-y divide-background-200">
              {shown.map((h) => (
                <tr key={h.id} data-testid={`holiday-${h.date}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(h.date)}</td>
                  <td className="px-3 py-2 font-medium text-foreground-900">{h.name}</td>
                  <td className="px-3 py-2"><Badge tone={h.isOptional ? "secondary" : "muted"}>{h.isOptional ? "Optional" : "Public"}</Badge></td>
                  <td className="px-3 py-2 text-xs text-foreground-600" data-testid={`holiday-source-${h.date}`}>{SOURCE_LABEL[h.source] ?? h.source}{h.source === "api" && h.syncSource ? ` (${SYNC_SOURCE_LABEL[h.syncSource] ?? h.syncSource})` : ""}</td>
                  <td className="px-3 py-2 text-xs text-foreground-600">{h.note}</td>
                  <td className="px-3 py-2"><Badge tone={h.status === "confirmed" ? "success" : "warn"}>{h.status === "confirmed" ? "Confirmed" : "Review"}</Badge></td>
                  <td className="px-3 py-2 text-right"><span className="flex flex-wrap justify-end gap-1">
                    {h.status === "review" ? <Button size="sm" disabled={busy === h.id} onClick={() => void confirm(h)} data-testid={`holiday-confirm-${h.date}`}>Confirm</Button> : null}
                    <Button size="sm" variant="outline" onClick={() => { setEditing({ id: h.id, date: h.date, name: h.name, isOptional: h.isOptional, status: h.status, note: h.note }); setDialogError(""); }}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(h)} data-testid={`holiday-delete-${h.date}`}>Delete</Button>
                  </span></td>
                </tr>
              ))}
              {!shown.length ? <tr><td colSpan={7} className="px-3 py-4 text-sm text-foreground-600">No {type ? `${type} ` : ""}holidays listed for {year}.</td></tr> : null}
            </tbody>
          </table>
        </Card>
      )}
      <OptionalRules rules={rules} onSaved={(r) => { setRules((prev) => (prev ?? []).map((x) => (x.year === r.year ? { ...x, ...r, isSet: true } : x))); setNotice(`Optional holidays for ${r.year}: ${r.allowance} per employee, ${r.isPaid ? "paid" : "unpaid"}.`); }} />
      <Modal open={editing !== null} title="Edit holiday" onClose={() => setEditing(null)}
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy === "save"} onClick={() => void save()} data-testid="holiday-save">Save</Button></>}>
        {editing ? (
          <div className="space-y-3" data-testid="holiday-dialog">
            <Field label="Date" required><TextInput type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} data-testid="holiday-date" /></Field>
            <Field label="Name" required><TextInput value={editing.name} maxLength={120} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="holiday-name" /></Field>
            <Field label="Note"><TextInput value={editing.note} maxLength={500} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field>
            <Field label="Status"><Select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as "review" | "confirmed" })} data-testid="holiday-status"><option value="review">Review</option><option value="confirmed">Confirmed</option></Select></Field>
            <Toggle label="Optional (each employee chooses whether to take it)" checked={editing.isOptional} onChange={(v) => setEditing({ ...editing, isOptional: v })} />
            <p className="text-xs text-foreground-500">A holiday edited here is kept as a manual entry: the weekly sync will not change it again.</p>
            {dialogError ? <p role="alert" className={ALERT}>{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
      {adding ? <AddHolidaysDialog year={year} onClose={() => setAdding(false)}
        onDone={(message, addedYear) => { setAdding(false); setNotice(message); setError(""); if (addedYear && addedYear !== year) setYear(addedYear); else void load(); void loadSide(); }} /> : null}
      {importing ? <HolidayImportDialog year={year} onClose={() => setImporting(false)}
        onDone={(message, importedYear) => { setImporting(false); setNotice(message); setError(""); if (importedYear && importedYear !== year) setYear(importedYear); else void load(); }} /> : null}
      <ConfirmDialog open={deleting !== null} title="Delete holiday" message={deleting ? `Remove ${deleting.name} on ${fmtDate(deleting.date)}? Timesheets stop counting it.${deleting.source === "api" ? " The weekly sync will add it back if the official list still has it." : ""}` : ""} confirmLabel="Delete" onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />
    </div>
  );
}

/** Per year: how many optional holidays each employee may take, paid or unpaid. */
function OptionalRules({ rules, onSaved }: { rules: OptionalRule[] | null; onSaved: (rule: OptionalRule) => void }) {
  const [drafts, setDrafts] = useState<Record<number, { allowance: string; isPaid: boolean }>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (rules) setDrafts(Object.fromEntries(rules.map((r) => [r.year, { allowance: String(r.allowance), isPaid: r.isPaid }]))); }, [rules]);
  const save = async (year: number) => {
    const d = drafts[year]; if (!d) return;
    setBusy(year); setError("");
    try { onSaved(await saveOptionalRule(year, { allowance: Number(d.allowance), isPaid: d.isPaid })); }
    catch (e) { setError(e instanceof Error ? e.message : "The setting could not be saved."); }
    finally { setBusy(null); }
  };
  return (
    <Card className="mt-6 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-600">Optional holidays per year</h2>
      <p className="mt-1 text-sm text-foreground-600">Each employee may take this many of the year's optional holidays (Diwali, Eid, Lunar New Year, Christmas Eve, ...), paid or unpaid. Approved days show on the timesheet and in the Xero export; an unpicked optional day is an ordinary work day.</p>
      {error ? <p role="alert" className={`mt-3 ${ALERT}`}>{error}</p> : null}
      {!rules ? <p className="mt-3 text-sm text-foreground-600">Loading…</p> : (
        <table className="mt-3 w-full max-w-3xl text-left text-sm" data-testid="optional-rules">
          <thead className="text-xs uppercase tracking-wide text-foreground-600"><tr><th className="py-1 pr-3">Year</th><th className="py-1 pr-3">Optional holidays listed</th><th className="py-1 pr-3">Each employee may take</th><th className="py-1 pr-3">Paid</th><th className="py-1 pr-3">Picked so far</th><th className="py-1" /></tr></thead>
          <tbody className="divide-y divide-background-200">
            {rules.map((r) => {
              const d = drafts[r.year] ?? { allowance: String(r.allowance), isPaid: r.isPaid };
              const changed = Number(d.allowance) !== r.allowance || d.isPaid !== r.isPaid || !r.isSet;
              return (
                <tr key={r.year} data-testid={`optional-rule-${r.year}`}>
                  <td className="py-2 pr-3 font-medium text-foreground-900">{r.year}</td>
                  <td className="py-2 pr-3">{r.optionalHolidays ?? 0}</td>
                  <td className="py-2 pr-3"><TextInput type="number" min={0} max={30} className="w-24" value={d.allowance} onChange={(e) => setDrafts({ ...drafts, [r.year]: { ...d, allowance: e.target.value } })} data-testid={`optional-allowance-${r.year}`} /></td>
                  <td className="py-2 pr-3"><Toggle label={d.isPaid ? "Paid" : "Unpaid"} checked={d.isPaid} onChange={(v) => setDrafts({ ...drafts, [r.year]: { ...d, isPaid: v } })} /></td>
                  <td className="py-2 pr-3">{r.picked ?? 0}</td>
                  <td className="py-2"><Button size="sm" variant={changed ? "primary" : "outline"} disabled={busy === r.year || d.allowance === ""} onClick={() => void save(r.year)} data-testid={`optional-rule-save-${r.year}`}>{r.isSet ? "Save" : "Set"}</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Add several holidays before saving: each a single day or a range (one row per day), public or optional. */
function AddHolidaysDialog({ year, onClose, onDone }: { year: number; onClose: () => void; onDone: (message: string, year?: number) => void }) {
  let nextKey = 1;
  const blank = (overrides: Partial<NewEntry> = {}): NewEntry => ({ key: nextKey++, name: "", startDate: "", endDate: "", isOptional: true, note: "", ...overrides });
  const [entries, setEntries] = useState<NewEntry[]>([blank()]);
  const [status, setStatus] = useState<"review" | "confirmed">("confirmed");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (key: number, p: Partial<NewEntry>) => setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...p } : e)));
  const days = (e: NewEntry) => (e.startDate && e.endDate && e.endDate >= e.startDate ? Math.round((Date.parse(e.endDate) - Date.parse(e.startDate)) / 86400000) + 1 : e.startDate ? 1 : 0);
  const problems = entries.flatMap((e, i) => {
    const p: string[] = [];
    if (!e.name.trim()) p.push(`Holiday ${i + 1}: enter a name.`);
    if (!e.startDate) p.push(`Holiday ${i + 1}: choose the first day.`);
    if (e.endDate && e.startDate && e.endDate < e.startDate) p.push(`Holiday ${i + 1}: the last day is before the first day.`);
    if (days(e) > 31) p.push(`Holiday ${i + 1}: a range can cover up to 31 days.`);
    return p;
  });
  const total = entries.reduce((n, e) => n + days(e), 0);
  const run = async () => {
    if (problems.length) { setError(problems[0]); return; }
    setBusy(true); setError("");
    try {
      const rows: NewHolidayInput[] = entries.map((e) => ({ name: e.name.trim(), startDate: e.startDate, ...(e.endDate && e.endDate !== e.startDate ? { endDate: e.endDate } : {}), isOptional: e.isOptional, ...(e.note.trim() ? { note: e.note.trim() } : {}), status }));
      const r = await addHolidays(rows);
      const years = [...new Set(rows.map((h) => Number(h.startDate.slice(0, 4))))];
      onDone(`Added ${r.inserted} day${r.inserted === 1 ? "" : "s"}${r.updated ? ` and updated ${r.updated}` : ""}${status === "review" ? " (at Review: confirm them to count them)" : ""}.`, years.includes(year) ? undefined : years[0]);
    } catch (e) { setError(e instanceof Error ? e.message : "The holidays could not be added."); }
    finally { setBusy(false); }
  };
  return (
    <Modal open title="Add holidays" width="max-w-3xl" onClose={() => { if (!busy) onClose(); }}
      footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !entries.length} onClick={() => void run()} data-testid="holiday-add-save">{busy ? "Saving…" : `Save ${total} day${total === 1 ? "" : "s"}`}</Button></>}>
      <div className="space-y-4" data-testid="holiday-add-dialog">
        <p className="text-sm text-foreground-700">Add one or more holidays. A range (first day to last day) makes one entry per day. Public holidays apply to everyone; optional ones are offered to each employee, who picks up to the yearly allowance.</p>
        <div className="space-y-3">
          {entries.map((e, i) => (
            <div key={e.key} className="rounded-md border border-background-200 p-3" data-testid={`holiday-add-entry-${i}`}>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Name" required><TextInput value={e.name} maxLength={120} placeholder="Diwali" onChange={(ev) => patch(e.key, { name: ev.target.value })} data-testid={`holiday-add-name-${i}`} /></Field>
                <Field label="First day" required><TextInput type="date" value={e.startDate} onChange={(ev) => patch(e.key, { startDate: ev.target.value, ...(e.endDate && e.endDate < ev.target.value ? { endDate: "" } : {}) })} data-testid={`holiday-add-start-${i}`} /></Field>
                <Field label="Last day (blank = one day)"><TextInput type="date" value={e.endDate} min={e.startDate || undefined} onChange={(ev) => patch(e.key, { endDate: ev.target.value })} data-testid={`holiday-add-end-${i}`} /></Field>
                <Field label="Type"><Select value={e.isOptional ? "optional" : "public"} onChange={(ev) => patch(e.key, { isOptional: ev.target.value === "optional" })} data-testid={`holiday-add-type-${i}`}><option value="optional">Optional (employee chooses)</option><option value="public">Public (everyone)</option></Select></Field>
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <div className="grow"><Field label="Note"><TextInput value={e.note} maxLength={500} onChange={(ev) => patch(e.key, { note: ev.target.value })} /></Field></div>
                <span className="text-xs text-foreground-500">{days(e) ? `${days(e)} day${days(e) === 1 ? "" : "s"}` : ""}</span>
                {entries.length > 1 ? <Button size="sm" variant="ghost" onClick={() => setEntries((es) => es.filter((x) => x.key !== e.key))} data-testid={`holiday-add-remove-${i}`}>Remove</Button> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Button size="sm" variant="outline" icon="ri-add-line" disabled={entries.length >= 50} onClick={() => setEntries((es) => [...es, blank({ key: Math.max(0, ...es.map((x) => x.key)) + 1 })])} data-testid="holiday-add-another">Add another holiday</Button>
          <Field label="Save them as">
            <Select value={status} onChange={(ev) => setStatus(ev.target.value as "review" | "confirmed")} data-testid="holiday-add-status">
              <option value="confirmed">Confirmed (counts straight away)</option>
              <option value="review">Review (confirm each one later)</option>
            </Select>
          </Field>
        </div>
        {error ? <p role="alert" className={ALERT} data-testid="holiday-add-error">{error}</p> : null}
      </div>
    </Modal>
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
    <Modal open title="Import holidays from Excel" width="max-w-2xl" onClose={() => { if (!busy) onClose(); }}
      footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={!ok || busy} onClick={() => void run()} data-testid="holiday-import-confirm">{busy ? "Importing…" : ok ? `Import ${parsed!.rows.length} holiday${parsed!.rows.length === 1 ? "" : "s"}` : "Import"}</Button></>}>
      <div className="space-y-4" data-testid="holiday-import-dialog">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground-700">
          <li>Download the template, or use your own sheet with the headings <strong>Date</strong> and <strong>Holiday</strong> (optional: Optional, State, Note).</li>
          <li>One holiday per row. Dates as DD/MM/YYYY, YYYY-MM-DD or an Excel date. Optional is Yes (the employee chooses) or No (public, everyone). A blank State means VIC.</li>
          <li>Choose the file below, check the preview, then import. The same date and name updates the existing holiday. Imported rows are kept by the weekly sync (fallback when the official sources are down).</li>
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
                <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-600"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Holiday</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">State</th></tr></thead>
                <tbody className="divide-y divide-background-200">{parsed.rows.slice(0, 8).map((h) => (
                  <tr key={`${h.state ?? ""}${h.date}${h.name}`}><td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(h.date)}</td><td className="px-3 py-1.5">{h.name}</td><td className="px-3 py-1.5">{h.isOptional ? "Optional" : "Public"}</td><td className="px-3 py-1.5">{h.state ?? "VIC"}</td></tr>
                ))}</tbody>
              </table>
            </Card>
          </div>
        ) : null}
        <Field label="Import them as">
          <Select value={status} onChange={(e) => setStatus(e.target.value as "review" | "confirmed")} disabled={busy} data-testid="holiday-import-status">
            <option value="review">Review (confirm each one later)</option>
            <option value="confirmed">Confirmed (counts straight away)</option>
          </Select>
        </Field>
        {error ? <p role="alert" className={ALERT}>{error}</p> : null}
      </div>
    </Modal>
  );
}
