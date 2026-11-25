import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, Field, PageHeader, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import { avetmissLabel, avetmissOptions, useAvetmissCodes } from "@/lib/avetmissCodes";

/**
 * AVETMISS-UI screen 6 (2026-11-25): LMS › Results. One unit of one intake: every student's AVETMISS outcome (avetmiss_codes
 * 'outcome'), actual start / end dates, predominant delivery mode, the three delivery flags (classroom / online / workplace, default
 * YNN), the delivery location and the RPL / credit transfer evidence (note + file in the private unit-content bucket). Reads and
 * writes go through avetmiss_unit_result_options / avetmiss_unit_results / avetmiss_unit_results_save (lms_unit_students has no
 * browser policies); only the fields sent change, and saving an outcome stamps who recorded it and when. Admins and RTO Managers.
 */

interface UnitOption { unitId: string; code: string; name: string; students: number; recorded: number }
interface IntakeOption { intakeId: string; intakeName: string; startDate: string | null; endDate: string | null; courseId: string; courseCode: string; courseName: string; units: UnitOption[] }
interface ResultRow {
  intakeId: string; unitId: string; studentId: string; name: string; email: string | null; studentNumber: string | null;
  assignedStart: string | null; assignedEnd: string | null; actualStart: string | null; actualEnd: string | null; outcome: string | null;
  deliveryMode: string | null; deliveryIdentifier: string | null; locationId: string | null; evidenceNote: string | null; evidencePath: string | null;
  recordedAt: string | null; recordedBy: string | null;
}
interface Location { id: string; name: string; is_active: boolean }
type Draft = Partial<Pick<ResultRow, "outcome" | "actualStart" | "actualEnd" | "deliveryMode" | "deliveryIdentifier" | "locationId" | "evidenceNote" | "evidencePath">>;

const WITHDRAWN = "40";
/** Outcomes that need RPL / credit transfer evidence (RPL granted 51, RPL not granted 52, credit transfer 60). */
const EVIDENCE_OUTCOMES = new Set(["51", "52", "60"]);
const FLAGS = [["classroom", "Classroom"], ["online", "Online"], ["workplace", "Workplace"]] as const;
const keyOf = (r: Pick<ResultRow, "studentId">) => r.studentId;
const day = (value: string | null) => (value ? new Date(`${value}T00:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" }) : "—");

/** A database or RPC error in plain words. */
function friendly(message: string): string {
  if (/lms_unit_students_withdrawal_date/.test(message)) return "A withdrawn outcome needs an actual end date.";
  // The lms_unit_students_permanent trigger refuses every update (allocations are permanent), outcome columns included.
  if (/allocations are permanent/i.test(message)) return "Results cannot be saved yet: the database locks unit enrolments against any change. An administrator must allow outcome updates first.";
  if (/lms_unit_students_delivery_mode_identifier_check/.test(message)) return "The delivery flags must be three Y / N values.";
  if (/outcome_code_check/.test(message)) return "That outcome is not a valid AVETMISS outcome.";
  if (/predominant_delivery_mode_check/.test(message)) return "That delivery mode is not a valid AVETMISS code.";
  if (/location_id_fkey/.test(message)) return "That location no longer exists.";
  if (/evidence_note_check/.test(message)) return "The evidence note can be at most 2000 characters.";
  return message;
}

function FlagBoxes({ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean }) {
  const flags = (value && /^[YN]{3}$/.test(value) ? value : "YNN").split("");
  return <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
    {FLAGS.map(([id, label], i) => <label key={id} className="inline-flex items-center gap-1 text-xs text-foreground-800">
      <input type="checkbox" disabled={disabled} checked={flags[i] === "Y"} data-testid={`results-flag-${id}`}
        onChange={(e) => { const next = [...flags]; next[i] = e.target.checked ? "Y" : "N"; onChange(next.join("")); }} /> {label}
    </label>)}
  </span>;
}

export default function LmsResultsPage() {
  const { codes, error: codesError } = useAvetmissCodes();
  const [options, setOptions] = useState<IntakeOption[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [courseId, setCourseId] = useState(""); const [intakeId, setIntakeId] = useState(""); const [unitId, setUnitId] = useState("");
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<Draft & { apply: Record<string, boolean> }>({ apply: {} });
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});

  useEffect(() => {
    void supabase.rpc("avetmiss_unit_result_options").then(({ data, error: e }) => { if (e) setError(friendly(e.message)); setOptions((data ?? []) as IntakeOption[]); });
    void supabase.from("locations").select("id, name, is_active").order("sort").order("name").then(({ data }) => setLocations((data ?? []) as Location[]));
  }, []);

  const courses = useMemo(() => { const seen = new Map<string, { id: string; label: string }>(); for (const o of options ?? []) if (!seen.has(o.courseId)) seen.set(o.courseId, { id: o.courseId, label: `${o.courseCode} ${o.courseName}` }); return [...seen.values()]; }, [options]);
  const intakes = useMemo(() => (options ?? []).filter((o) => o.courseId === courseId), [options, courseId]);
  const intake = intakes.find((i) => i.intakeId === intakeId) ?? null;
  const unit = intake?.units.find((u) => u.unitId === unitId) ?? null;

  const load = useCallback(async () => {
    if (!intakeId || !unitId) { setRows(null); return; }
    setBusy("load"); setError("");
    const { data, error: e } = await supabase.rpc("avetmiss_unit_results", { p_intake: intakeId, p_unit: unitId });
    setBusy("");
    if (e) { setError(friendly(e.message)); return; }
    setRows((data ?? []) as ResultRow[]); setDrafts({}); setSelected(new Set()); setRowError({});
  }, [intakeId, unitId]);
  useEffect(() => { void load(); }, [load]);

  const value = <K extends keyof Draft>(r: ResultRow, k: K): ResultRow[K] => (drafts[keyOf(r)] && k in drafts[keyOf(r)] ? drafts[keyOf(r)][k] as ResultRow[K] : r[k]);
  const edit = (r: ResultRow, patch: Draft) => setDrafts((d) => ({ ...d, [keyOf(r)]: { ...d[keyOf(r)], ...patch } }));
  const dirty = (r: ResultRow) => Object.keys(drafts[keyOf(r)] ?? {}).length > 0;

  const save = async (payload: Array<Record<string, unknown>>, label: string) => {
    setBusy(label); setError(""); setNotice("");
    const { data, error: e } = await supabase.rpc("avetmiss_unit_results_save", { p_rows: payload });
    setBusy("");
    if (e) return friendly(e.message);
    setNotice(`${Number(data) || 0} result${Number(data) === 1 ? "" : "s"} saved.`);
    await load();
    return "";
  };

  const saveRow = async (r: ResultRow) => {
    const d = drafts[keyOf(r)] ?? {};
    const outcome = "outcome" in d ? d.outcome : r.outcome;
    const end = "actualEnd" in d ? d.actualEnd : r.actualEnd;
    if (outcome === WITHDRAWN && !end) { setRowError((x) => ({ ...x, [keyOf(r)]: "A withdrawn outcome needs an actual end date." })); return; }
    const problem = await save([{ intakeId: r.intakeId, unitId: r.unitId, studentId: r.studentId, ...d }], `row-${keyOf(r)}`);
    setRowError((x) => ({ ...x, [keyOf(r)]: problem }));
  };

  const applyBulk = async () => {
    if (!rows) return;
    const patch: Draft = {};
    for (const k of ["outcome", "actualStart", "actualEnd", "deliveryMode", "deliveryIdentifier", "locationId"] as const) if (bulk.apply[k]) (patch as Record<string, unknown>)[k] = bulk[k] ?? "";
    if (!Object.keys(patch).length) { setError("Tick at least one field to set for the selected students."); return; }
    const chosen = rows.filter((r) => selected.has(keyOf(r)));
    const missingEnd = chosen.filter((r) => (patch.outcome ?? r.outcome) === WITHDRAWN && !("actualEnd" in patch ? patch.actualEnd : r.actualEnd));
    if (missingEnd.length) { setError(`A withdrawn outcome needs an actual end date (${missingEnd.map((r) => r.name).join(", ")}). Set an end date too.`); return; }
    const problem = await save(chosen.map((r) => ({ intakeId: r.intakeId, unitId: r.unitId, studentId: r.studentId, ...patch })), "bulk");
    if (problem) setError(problem); else setBulk({ apply: {} });
  };

  const upload = async (r: ResultRow, file: File) => {
    const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "evidence";
    const path = `${r.unitId}/outcome-evidence/${r.studentId}/${crypto.randomUUID()}-${safe}`;
    setBusy(`upload-${keyOf(r)}`); setRowError((x) => ({ ...x, [keyOf(r)]: "" }));
    const { error: e } = await supabase.storage.from("unit-content").upload(path, file, { upsert: false, contentType: file.type || undefined });
    setBusy("");
    if (e) { setRowError((x) => ({ ...x, [keyOf(r)]: `The file could not be uploaded: ${e.message}` })); return; }
    edit(r, { evidencePath: path });
  };
  const viewEvidence = async (path: string) => {
    const { data, error: e } = await supabase.storage.from("unit-content").createSignedUrl(path, 60);
    if (e || !data?.signedUrl) { setError(`The evidence could not be opened: ${e?.message ?? "no link"}`); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const outcomeOptions = (current?: string | null) => avetmissOptions(codes, "outcome", current);
  const modeOptions = (current?: string | null) => avetmissOptions(codes, "predominant_delivery_mode", current);
  const activeLocations = (current?: string | null) => locations.filter((l) => l.is_active || l.id === current);
  const allSelected = !!rows?.length && rows.every((r) => selected.has(keyOf(r)));

  return <div className="space-y-5" data-testid="lms-results">
    <PageHeader title="Results" description="Record each student's AVETMISS outcome for a unit: outcome, actual dates, delivery mode and location, with evidence for RPL and credit transfer." />
    {codesError ? <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">The AVETMISS codes could not be loaded: {codesError}</p> : null}
    {error ? <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700" data-testid="results-error">{error}</p> : null}
    {notice ? <p role="status" className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p> : null}

    {options === null ? <p role="status">Loading…</p> : !options.length
      ? <EmptyState icon="ri-award-line" title="No unit enrolments yet" description="Results appear here once students are placed in an intake and its units. Place students from LMS › Intakes." />
      : <div className="grid gap-3 rounded-lg border border-background-300 bg-background-50 p-3 sm:grid-cols-3" data-testid="results-pickers">
        <Field label="Course"><Select value={courseId} onChange={(e) => { setCourseId(e.target.value); setIntakeId(""); setUnitId(""); }} data-testid="results-course">
          <option value="">Choose a course</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
        <Field label="Intake"><Select value={intakeId} disabled={!courseId} onChange={(e) => { setIntakeId(e.target.value); setUnitId(""); }} data-testid="results-intake">
          <option value="">Choose an intake</option>{intakes.map((i) => <option key={i.intakeId} value={i.intakeId}>{i.intakeName}{i.startDate ? ` (${day(i.startDate)})` : ""}</option>)}</Select></Field>
        <Field label="Unit"><Select value={unitId} disabled={!intake} onChange={(e) => setUnitId(e.target.value)} data-testid="results-unit">
          <option value="">Choose a unit</option>{intake?.units.map((u) => <option key={u.unitId} value={u.unitId}>{u.code} {u.name} ({u.recorded}/{u.students} recorded)</option>)}</Select></Field>
      </div>}

    {unit && rows ? <>
      {selected.size ? <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50 p-3" data-testid="results-bulk">
        <p className="text-sm font-semibold text-foreground-900">Set for {selected.size} selected student{selected.size === 1 ? "" : "s"}: tick what to change.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {([["outcome", "Outcome"], ["actualStart", "Actual start"], ["actualEnd", "Actual end"], ["deliveryMode", "Delivery mode"], ["deliveryIdentifier", "Delivery flags"], ["locationId", "Location"]] as const).map(([k, label]) =>
            <div key={k} className="space-y-1">
              <label className="flex items-center gap-2 text-xs font-medium text-foreground-800"><input type="checkbox" checked={!!bulk.apply[k]} onChange={(e) => setBulk((b) => ({ ...b, apply: { ...b.apply, [k]: e.target.checked } }))} data-testid={`results-bulk-apply-${k}`} /> {label}</label>
              {k === "outcome" ? <Select value={bulk.outcome ?? ""} onChange={(e) => setBulk((b) => ({ ...b, outcome: e.target.value, apply: { ...b.apply, outcome: true } }))}>
                <option value="">No outcome</option>{outcomeOptions().map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select>
                : k === "actualStart" || k === "actualEnd" ? <TextInput type="date" value={bulk[k] ?? ""} onChange={(e) => setBulk((b) => ({ ...b, [k]: e.target.value, apply: { ...b.apply, [k]: true } }))} />
                  : k === "deliveryMode" ? <Select value={bulk.deliveryMode ?? ""} onChange={(e) => setBulk((b) => ({ ...b, deliveryMode: e.target.value, apply: { ...b.apply, deliveryMode: true } }))}>
                    <option value="">Not set</option>{modeOptions().map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select>
                    : k === "deliveryIdentifier" ? <FlagBoxes value={bulk.deliveryIdentifier ?? "YNN"} onChange={(v) => setBulk((b) => ({ ...b, deliveryIdentifier: v, apply: { ...b.apply, deliveryIdentifier: true } }))} />
                      : <Select value={bulk.locationId ?? ""} onChange={(e) => setBulk((b) => ({ ...b, locationId: e.target.value, apply: { ...b.apply, locationId: true } }))}>
                        <option value="">Not set</option>{activeLocations().map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}
            </div>)}
        </div>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy === "bulk"} onClick={() => void applyBulk()} data-testid="results-bulk-save">{busy === "bulk" ? "Saving…" : `Save for ${selected.size}`}</Button>
          <Button size="sm" variant="outline" onClick={() => { setSelected(new Set()); setBulk({ apply: {} }); }}>Clear selection</Button></div>
      </div> : null}

      {!rows.length ? <EmptyState icon="ri-group-line" title="No students in this unit" /> :
        <div className="overflow-x-auto rounded-md border border-background-300"><table className="w-full min-w-[1180px] text-left text-sm" data-testid="results-table">
          <thead className="bg-background-100 text-xs text-foreground-600"><tr>
            <th className="px-3 py-2"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map(keyOf)) : new Set())} /></th>
            <th className="px-3">Student</th><th className="px-3">Planned</th><th className="px-3">Outcome</th><th className="px-3">Actual start</th><th className="px-3">Actual end</th>
            <th className="px-3">Delivery</th><th className="px-3">Location</th><th className="px-3">Evidence</th><th className="px-3"></th></tr></thead>
          <tbody>{rows.map((r) => {
            const k = keyOf(r); const outcome = value(r, "outcome"); const needsEvidence = !!outcome && EVIDENCE_OUTCOMES.has(outcome);
            const evidencePath = value(r, "evidencePath");
            return <tr key={k} className="border-t border-background-200 align-top" data-testid="results-row">
              <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(k)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })} /></td>
              <td className="px-3 py-2"><p className="font-medium text-foreground-900">{r.name}</p><p className="text-xs text-foreground-500">{r.studentNumber ?? "No student number"}</p>
                {r.recordedAt ? <p className="mt-1 text-2xs text-foreground-500">Recorded {new Date(r.recordedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}{r.recordedBy ? ` by ${r.recordedBy}` : ""}</p> : null}</td>
              <td className="px-3 py-2 whitespace-nowrap text-xs text-foreground-600">{day(r.assignedStart)} – {day(r.assignedEnd)}</td>
              <td className="px-3 py-2"><Select value={outcome ?? ""} onChange={(e) => edit(r, { outcome: e.target.value })} data-testid="results-outcome">
                <option value="">No outcome yet</option>{outcomeOptions(outcome).map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select>
                {outcome ? <span className="mt-1 block text-2xs text-foreground-500">Code {outcome}</span> : null}</td>
              <td className="px-3 py-2"><TextInput type="date" value={value(r, "actualStart") ?? ""} onChange={(e) => edit(r, { actualStart: e.target.value })} /></td>
              <td className="px-3 py-2"><TextInput type="date" value={value(r, "actualEnd") ?? ""} onChange={(e) => edit(r, { actualEnd: e.target.value })} data-testid="results-end" />
                {outcome === WITHDRAWN && !value(r, "actualEnd") ? <span className="mt-1 block text-2xs font-medium text-amber-800">Withdrawn needs an end date</span> : null}</td>
              <td className="space-y-1 px-3 py-2"><Select value={value(r, "deliveryMode") ?? ""} onChange={(e) => edit(r, { deliveryMode: e.target.value })}>
                <option value="">Not set</option>{modeOptions(value(r, "deliveryMode")).map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select>
                <FlagBoxes value={value(r, "deliveryIdentifier") ?? "YNN"} onChange={(v) => edit(r, { deliveryIdentifier: v })} /></td>
              <td className="px-3 py-2"><Select value={value(r, "locationId") ?? ""} onChange={(e) => edit(r, { locationId: e.target.value })}>
                <option value="">Not set</option>{activeLocations(value(r, "locationId")).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></td>
              <td className="space-y-1 px-3 py-2">
                {needsEvidence || value(r, "evidenceNote") || evidencePath ? <>
                  <TextArea rows={2} maxLength={2000} placeholder="What the RPL / credit transfer is based on" value={value(r, "evidenceNote") ?? ""} onChange={(e) => edit(r, { evidenceNote: e.target.value })} data-testid="results-evidence-note" />
                  <span className="flex flex-wrap items-center gap-2 text-xs">
                    <label className="cursor-pointer font-medium text-primary-700 hover:underline">{busy === `upload-${k}` ? "Uploading…" : evidencePath ? "Replace file" : "Upload file"}
                      <input type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(r, f); }} /></label>
                    {evidencePath ? <button type="button" className="font-medium text-primary-700 hover:underline" onClick={() => void viewEvidence(evidencePath)}>View</button> : null}
                  </span>
                  {needsEvidence && !value(r, "evidenceNote") && !evidencePath ? <Badge tone="warn">Evidence needed</Badge> : null}
                </> : <span className="text-xs text-foreground-500">Only for RPL / credit transfer</span>}
              </td>
              <td className="px-3 py-2 text-right">
                <Button size="sm" disabled={!dirty(r) || busy === `row-${k}`} onClick={() => void saveRow(r)} data-testid="results-save">{busy === `row-${k}` ? "Saving…" : "Save"}</Button>
                {rowError[k] ? <p role="alert" className="mt-1 max-w-[12rem] text-left text-xs text-red-700">{rowError[k]}</p> : null}
              </td>
            </tr>;
          })}</tbody></table></div>}
      <p className="text-xs text-foreground-500">{rows.length} student{rows.length === 1 ? "" : "s"} · {rows.filter((r) => r.outcome).length} with an outcome · outcome labels: {avetmissLabel(codes, "outcome", WITHDRAWN) || "Withdrawn"} needs an actual end date.</p>
    </> : busy === "load" ? <p role="status">Loading students…</p> : null}
  </div>;
}
