// CRICOS register details of a course: fetch by CRICOS course code, review and edit every field, save explicitly.
// Read-only mode shows the same sections. Training.gov.au data (units, packaging rules) is a separate panel.
import { useEffect, useMemo, useState } from "react";
import { Button, Card, Modal, TextInput, Toggle } from "@/pages/admin/components/ui";
import {
  ALL_FIELDS, CODE_FIELD, CODE_PATTERN, CRICOS_SECTIONS, LOCATION_FIELDS, LOCATIONS_KEY, diffWithLookup, display, editedFields,
  emptyFields, emptyLocation, labelOf, loadCricos, lookupCricos, saveCricos,
  type CricosField, type CricosLocation, type CricosLookup, type CricosRecord, type CricosValue, type DiffRow,
} from "@/pages/admin/lib/cricos";

const blankRecord = (): CricosRecord => ({ fields: emptyFields(), locations: [], snapshot: null, fetchedAt: null, edited: [] });
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "";
const hasData = (record: CricosRecord) => !!record.fetchedAt || ALL_FIELDS.some(field => record.fields[field.key] !== null) || record.locations.length > 0;

function EditedBadge({ onReset, disabled }: { onReset: () => void; disabled?: boolean }) {
  return <span className="ml-2 inline-flex items-center gap-1 align-middle">
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">edited</span>
    <button type="button" disabled={disabled} onClick={onReset} title="Reset to the value last fetched from CRICOS"
      className="text-[11px] font-semibold text-primary-600 underline disabled:opacity-50">reset to CRICOS value</button>
  </span>;
}

function Input({ field, value, onChange, disabled }: { field: CricosField; value: CricosValue; onChange: (value: CricosValue) => void; disabled: boolean }) {
  if (field.kind === "boolean") return <div className="pt-1"><Toggle disabled={disabled} checked={value === true} onChange={onChange} label={value === true ? "Yes" : value === false ? "No" : "Not set"} /></div>;
  if (field.kind === "number") return <TextInput type="number" inputMode="decimal" step="any" disabled={disabled} value={value === null ? "" : String(value)}
    onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
  return <TextInput disabled={disabled} value={value === null ? "" : String(value)} onChange={e => onChange(e.target.value === "" ? null : e.target.value)} />;
}

/** CRICOS details for a course. With no courseId it creates a draft course from the fetched data. */
export default function CricosCourseSection({ courseId, readOnly = false, onSaved }: {
  courseId: string | null; readOnly?: boolean; onSaved?: (courseId: string) => void;
}) {
  const [saved, setSaved] = useState<CricosRecord>(blankRecord);
  const [record, setRecord] = useState<CricosRecord>(blankRecord);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(!!courseId);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<{ lookup: CricosLookup; rows: DiffRow[]; take: Record<string, boolean> } | null>(null);

  useEffect(() => {
    let live = true;
    setError(""); setLookupError(""); setWarnings([]); setNotice("");
    if (!courseId) { const blank = blankRecord(); setSaved(blank); setRecord(blank); setCode(""); setLoading(false); return; }
    setLoading(true);
    loadCricos(courseId).then(loaded => {
      if (!live) return;
      setSaved(loaded); setRecord(loaded); setCode(String(loaded.fields.cricos_course_code ?? ""));
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : "Could not load the CRICOS details."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [courseId]);

  const edited = useMemo(() => new Set(editedFields(record.fields, record.locations, record.snapshot)), [record]);
  const dirty = JSON.stringify(record) !== JSON.stringify(saved);
  const busy = fetching || saving || loading;

  const setField = (key: string, value: CricosValue) => setRecord(r => ({ ...r, fields: { ...r.fields, [key]: value } }));
  const resetField = (key: string) => setRecord(r => !r.snapshot ? r : key === LOCATIONS_KEY
    ? { ...r, locations: (r.snapshot.locations ?? []).map(row => ({ ...row })) }
    : { ...r, fields: { ...r.fields, [key]: r.snapshot.fields[key] ?? null } });
  const setLocation = (index: number, key: keyof CricosLocation, value: string) => setRecord(r => ({
    ...r, locations: r.locations.map((row, i) => i === index ? { ...row, [key]: key === "location_name" ? value : value || null } : row),
  }));

  async function fetchCricos() {
    const wanted = code.trim().toUpperCase();
    setCode(wanted); setLookupError(""); setNotice("");
    if (!CODE_PATTERN.test(wanted)) { setLookupError("A CRICOS course code is six digits and a letter, e.g. 112739C."); return; }
    setFetching(true);
    try {
      const lookup = await lookupCricos(wanted);
      setWarnings(lookup.warnings);
      if (!hasData(record)) {
        // First fetch: fill the form. Nothing is saved until Save.
        setRecord({ fields: { ...emptyFields(), ...lookup.fields }, locations: lookup.locations, snapshot: lookup.snapshot, fetchedAt: lookup.fetched_at, edited: [] });
        return;
      }
      const rows = diffWithLookup(record.fields, record.locations, [...edited], lookup);
      if (!rows.length) {
        setRecord(r => ({ ...r, snapshot: lookup.snapshot, fetchedAt: lookup.fetched_at }));
        setNotice("Everything already matches the CRICOS register. Save to record this fetch.");
        return;
      }
      setReview({ lookup, rows, take: Object.fromEntries(rows.map(row => [row.key, !row.edited])) });
    } catch (e) {
      // The form keeps whatever it had (e.g. 999999Z is not on the register).
      setLookupError(e instanceof Error ? e.message : "The CRICOS register could not be read.");
    } finally { setFetching(false); }
  }

  function applyReview() {
    if (!review) return;
    const { lookup, take } = review;
    setRecord(r => {
      const fields = { ...r.fields };
      for (const row of review.rows) if (take[row.key] && row.key !== LOCATIONS_KEY) fields[row.key] = (lookup.fields[row.key] ?? null) as CricosValue;
      const locations = take[LOCATIONS_KEY] ? lookup.locations.map(row => ({ ...row })) : r.locations;
      return { ...r, fields, locations, snapshot: lookup.snapshot, fetchedAt: lookup.fetched_at };
    });
    setReview(null);
    setNotice("CRICOS values applied to the form. Review them and click Save.");
  }

  async function save() {
    setSaving(true); setError(""); setNotice("");
    try {
      const fields = { ...record.fields, cricos_course_code: code.trim().toUpperCase() || null };
      const next = { ...record, fields, edited: editedFields(fields, record.locations, record.snapshot) };
      const id = await saveCricos(courseId, next);
      setRecord(next); setSaved(next);
      setNotice(courseId ? "CRICOS details saved." : "Course created from CRICOS.");
      onSaved?.(id);
    } catch (e) { setError(e instanceof Error ? e.message : "The CRICOS details could not be saved."); }
    finally { setSaving(false); }
  }

  const codeEdited = edited.has(CODE_FIELD.key);
  if (loading) return <p className="text-sm text-foreground-500">Loading CRICOS details…</p>;
  if (readOnly) {
    // Read-only: only filled values; derived Field of Education codes and "No" flags are left out to keep it short.
    if (error) return <p className="text-sm text-foreground-500">{error}</p>;
    if (!hasData(record)) return <p className="text-sm text-foreground-500">No CRICOS details yet. Use Edit › Fetch from CRICOS, or Sync.</p>;
    const shown = (field: CricosField) => {
      const value = record.fields[field.key];
      if (value === null || value === "" || /^cricos_foe\d_\w+_code$/.test(field.key)) return false;
      return !(field.kind === "boolean" && value === false && field.key !== "cricos_has_work_component");
    };
    const badge = (key: string) => edited.has(key) ? <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800">edited</span> : null;
    return <div className="space-y-5 text-sm">
      <p className="text-xs text-foreground-500">CRICOS {display(CODE_FIELD.key, record.fields.cricos_course_code)}{badge(CODE_FIELD.key)}
        {record.fetchedAt ? ` · fetched from the register ${when(record.fetchedAt)}` : ""}</p>
      {CRICOS_SECTIONS.map(section => {
        const fields = section.fields.filter(shown);
        if (!fields.length) return null;
        return <section key={section.title}>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-500">{section.title}</h4>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
            {fields.map(field => <div key={field.key} className={field.wide ? "sm:col-span-2" : ""}>
              <dt className="text-xs text-foreground-500">{field.label}{badge(field.key)}</dt>
              <dd className="font-medium text-foreground-950">{display(field.key, record.fields[field.key])}</dd>
            </div>)}
          </dl>
        </section>;
      })}
      {record.locations.length ? <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-500">Locations{badge(LOCATIONS_KEY)}</h4>
        <ul className="space-y-1">{record.locations.map((row, index) => <li key={index}>
          <span className="font-medium text-foreground-950">{row.location_name}</span>
          <span className="text-foreground-600"> · {[row.address_line_1, row.address_line_2, row.address_line_3, row.address_line_4, row.city, row.state, row.postcode].filter(Boolean).join(", ")}</span>
        </li>)}</ul>
      </section> : null}
    </div>;
  }

  return <Card className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="font-heading text-lg font-semibold text-foreground-950">CRICOS register</h3>
        <p className="text-xs text-foreground-500">{record.fetchedAt ? `Last fetched from CRICOS: ${when(record.fetchedAt)}` : "Not fetched from CRICOS yet."}</p>
      </div>
      {!readOnly ? <div className="flex items-center gap-2 text-xs text-foreground-500">
        {dirty ? <span className="font-semibold text-amber-700">Unsaved changes</span> : null}
        <Button onClick={() => void save()} disabled={busy || !dirty || (!courseId && !record.fetchedAt)}>{saving ? "Saving…" : courseId ? "Save" : "Create course"}</Button>
      </div> : null}
    </div>

    {readOnly ? <p className="mt-4 text-sm"><span className="text-foreground-500">CRICOS course code: </span><span className="font-semibold">{display(CODE_FIELD.key, record.fields.cricos_course_code)}</span></p>
      : <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="block min-w-48">
          <span className="mb-1.5 block text-label font-medium text-foreground-800">{CODE_FIELD.label}{codeEdited ? <EditedBadge onReset={() => { resetField(CODE_FIELD.key); setCode(String(record.snapshot?.fields.cricos_course_code ?? "")); }} disabled={busy} /> : null}</span>
          <TextInput value={code} maxLength={7} placeholder="e.g. 112739C" disabled={busy}
            onChange={e => { const next = e.target.value.toUpperCase(); setCode(next); setField(CODE_FIELD.key, next || null); }}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void fetchCricos(); } }} />
        </label>
        <Button variant="outline" icon={fetching ? "ri-loader-4-line animate-spin" : "ri-download-cloud-2-line"} disabled={busy || !code.trim()} onClick={() => void fetchCricos()}>
          {fetching ? "Fetching…" : "Fetch from CRICOS"}</Button>
      </div>}
    {lookupError ? <p role="alert" className="mt-2 text-sm text-red-700">{lookupError}</p> : null}
    {warnings.length ? <ul className="mt-2 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{warnings.map(w => <li key={w}>⚠ {w}</li>)}</ul> : null}
    {error ? <p role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {notice ? <p role="status" className="mt-2 text-sm text-green-700">{notice}</p> : null}

    {readOnly && !hasData(record) ? <p className="mt-4 text-sm text-foreground-500">No CRICOS details on this course yet. An RTO Manager can fetch them with Edit.</p> : <>
      {CRICOS_SECTIONS.map(section => <section key={section.title} className="mt-6">
        <h4 className="mb-3 border-b border-background-200 pb-1 text-sm font-semibold uppercase tracking-wide text-foreground-600">{section.title}</h4>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {section.fields.map(field => <div key={field.key} className={field.wide ? "sm:col-span-2" : ""}>
            <span className="mb-1.5 block text-label font-medium text-foreground-800">{field.label}
              {!readOnly && edited.has(field.key) ? <EditedBadge onReset={() => resetField(field.key)} disabled={busy} /> : null}
              {readOnly && edited.has(field.key) ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">edited</span> : null}</span>
            {readOnly ? <p className="text-sm font-semibold text-foreground-950">{display(field.key, record.fields[field.key])}</p>
              : <Input field={field} value={record.fields[field.key] ?? null} disabled={busy} onChange={value => setField(field.key, value)} />}
          </div>)}
        </div>
      </section>)}

      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between border-b border-background-200 pb-1">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-foreground-600">Locations
            {!readOnly && edited.has(LOCATIONS_KEY) ? <EditedBadge onReset={() => resetField(LOCATIONS_KEY)} disabled={busy} /> : null}
            {readOnly && edited.has(LOCATIONS_KEY) ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold normal-case text-amber-800">edited</span> : null}</h4>
          {!readOnly ? <Button size="sm" variant="outline" icon="ri-add-line" disabled={busy} onClick={() => setRecord(r => ({ ...r, locations: [...r.locations, emptyLocation()] }))}>Add location</Button> : null}
        </div>
        {record.locations.length === 0 ? <p className="text-sm text-foreground-500">No locations.</p> : <div className="space-y-3">
          {record.locations.map((row, index) => <div key={index} className="rounded-xl border border-background-200 p-3">
            {readOnly ? <p className="text-sm"><span className="font-semibold">{row.location_name}</span>
              {row.location_type ? <span className="text-foreground-500"> · {row.location_type}</span> : null}<br />
              <span className="text-foreground-700">{[row.address_line_1, row.address_line_2, row.address_line_3, row.address_line_4, row.city, row.state, row.postcode].filter(Boolean).join(", ")}</span></p>
              : <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {LOCATION_FIELDS.map(field => <label key={field.key} className="block">
                    <span className="mb-1 block text-xs font-medium text-foreground-700">{field.label}{field.key === "location_name" ? " *" : ""}</span>
                    <TextInput disabled={busy} value={row[field.key] ?? ""} onChange={e => setLocation(index, field.key, e.target.value)} />
                  </label>)}
                </div>
                <div className="mt-2 text-right"><Button size="sm" variant="ghost" icon="ri-delete-bin-line" disabled={busy}
                  onClick={() => setRecord(r => ({ ...r, locations: r.locations.filter((_, i) => i !== index) }))}>Remove</Button></div>
              </>}
          </div>)}
        </div>}
      </section>
    </>}

    <Modal open={!!review} title="Review CRICOS changes" width="max-w-3xl" onClose={() => setReview(null)}
      footer={<div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setReview(null)}>Cancel</Button>
        <Button onClick={applyReview}>Apply selected</Button></div>}>
      {review ? <div className="space-y-3 text-sm">
        <p className="text-foreground-600">{review.rows.length} field{review.rows.length === 1 ? "" : "s"} differ from the CRICOS register. Ticked fields take the CRICOS value; fields you edited are kept unless you tick them. Nothing is saved until you click Save.</p>
        <table className="w-full text-left">
          <thead><tr className="border-b border-background-200 text-xs text-foreground-500">
            <th className="py-2 pr-2">Use CRICOS</th><th className="py-2 pr-2">Field</th><th className="py-2 pr-2">Current</th><th className="py-2">CRICOS</th></tr></thead>
          <tbody>{review.rows.map(row => <tr key={row.key} className="border-b border-background-100 align-top">
            <td className="py-2 pr-2"><input type="checkbox" aria-label={`Use the CRICOS value for ${labelOf(row.key)}`} checked={review.take[row.key]}
              onChange={e => setReview(r => r ? { ...r, take: { ...r.take, [row.key]: e.target.checked } } : r)} /></td>
            <td className="py-2 pr-2 font-medium">{labelOf(row.key)}{row.edited ? <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-800">edited</span> : null}</td>
            <td className="py-2 pr-2">{display(row.key, row.current)}</td>
            <td className="py-2">{display(row.key, row.incoming)}</td>
          </tr>)}</tbody>
        </table>
      </div> : null}
    </Modal>
  </Card>;
}
