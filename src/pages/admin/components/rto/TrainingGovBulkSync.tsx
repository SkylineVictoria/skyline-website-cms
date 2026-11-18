// Bulk sync with training.gov.au: every qualification on the site's RTO scope (Settings > RTO code) is matched to its CMS
// course by qualification code, and the missing ones are created as draft courses with their core units through the
// tga-course-import function. Electives are then chosen on each course.
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import type { RtoCourse } from "@/pages/admin/lib/rto";

interface ScopeItem { code: string; title: string; status: string; endDate: string; current: boolean }
interface Scope { rto: string; source: string; items: ScopeItem[] }
const norm = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();

/** training.gov.au answers from Australia only, so the function runs in Sydney whoever calls it. The region goes in the
 *  URL (forceFunctionRegion), not the x-region header, which the function's CORS rules do not allow. */
async function tga<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("tga-course-import?forceFunctionRegion=ap-southeast-2", { body });
  if (error) {
    let message = error.message;
    try { const detail = await (error as { context?: Response }).context?.json(); if (detail?.error) message = detail.error; } catch { /* keep the generic message */ }
    throw new Error(message);
  }
  if (!data) throw new Error("No answer from Training.gov.au.");
  return data;
}

export default function TrainingGovBulkSync({ open, courses, onClose, onDone, onAddUnits }: {
  open: boolean; courses: RtoCourse[]; onClose: () => void; onDone: () => void;
  /** Open a created course on its Units tab with the Add units picker. */
  onAddUnits?: (courseId: string) => void;
}) {
  const [scope, setScope] = useState<Scope | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showOld, setShowOld] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<Record<string, string>>({});
  const [withUnits, setWithUnits] = useState(true);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setScope(null); setResults({}); setCreated({}); setError(""); setLoading(true);
    tga<Scope>({ action: "scope" })
      .then(s => { if (live) setScope(s); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Could not read the scope from Training.gov.au."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open]);

  const rows = useMemo(() => (scope?.items ?? []).map(item => ({ item, existing: courses.find(c => norm(c.code) === item.code) ?? null })), [scope, courses]);
  const shown = rows.filter(r => showOld || r.item.current);
  useEffect(() => { setSelected(new Set(rows.filter(r => r.item.current && !r.existing).map(r => r.item.code))); }, [rows]);

  async function run(addUnits: boolean) {
    setRunning(true); setError(""); setWithUnits(addUnits);
    const made: string[] = [];
    for (const { item } of rows.filter(r => selected.has(r.item.code) && !r.existing)) {
      setResults(r => ({ ...r, [item.code]: "Working…" }));
      try {
        const out = await tga<{ courseId: string; coreUnits: number; electives: number }>({ action: "create_core", code: item.code });
        made.push(out.courseId);
        setCreated(c => ({ ...c, [item.code]: out.courseId }));
        setResults(r => ({ ...r, [item.code]: `Draft course created with ${out.coreUnits} core unit${out.coreUnits === 1 ? "" : "s"}${out.electives ? `; choose its electives on the course` : ""}.` }));
      } catch (e) {
        setResults(r => ({ ...r, [item.code]: `Failed: ${e instanceof Error ? e.message : "error"}` }));
      }
    }
    setRunning(false);
    onDone();
    // One course made with "Create and add units": go straight to choosing its units.
    if (addUnits && made.length === 1 && onAddUnits) onAddUnits(made[0]);
  }

  const toggle = (code: string, on: boolean) => setSelected(s => { const next = new Set(s); if (on) next.add(code); else next.delete(code); return next; });
  const done = Object.keys(results).length > 0 && !running;
  const missing = rows.filter(r => r.item.current && !r.existing).length;

  return <Modal open={open} title={`Sync courses from Training.gov.au${scope ? ` · RTO ${scope.rto}` : ""}`} width="max-w-5xl" onClose={() => { if (!running) onClose(); }}
    footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showOld} disabled={running} onChange={e => setShowOld(e.target.checked)} />Show qualifications no longer on scope</label>
      <div className="flex gap-2">
        <Button variant="outline" disabled={running} onClick={onClose}>{done ? "Close" : "Cancel"}</Button>
        {!done ? <>
          <Button variant="outline" disabled={running || loading || !selected.size} onClick={() => void run(false)}
            title="Creates the courses with their core units only">{running && !withUnits ? "Creating…" : "Create only"}</Button>
          <Button disabled={running || loading || !selected.size} onClick={() => void run(true)}
            title="Creates the courses, then opens Add units to choose their electives">{running && withUnits ? "Creating…" : `Create ${selected.size} course${selected.size === 1 ? "" : "s"} and add units`}</Button>
        </> : null}
      </div>
    </div>}>
    {loading ? <p className="text-sm text-foreground-500">Reading SLIT's scope of registration from Training.gov.au…</p> : null}
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {scope ? <div className="space-y-3 text-sm">
      <p className="text-foreground-600">{scope.items.filter(i => i.current).length} qualifications are on the scope of RTO {scope.rto}; {missing} {missing === 1 ? "is" : "are"} not in the CMS yet.
        Ticked ones are created as draft courses with their core units from Training.gov.au. <strong>Create and add units</strong> then opens Add units to choose the electives (with one course ticked; with several, use Add units on each row); <strong>Create only</strong> leaves the electives for later.</p>
      <table className="w-full text-left">
        <thead><tr className="border-b border-background-200 text-xs text-foreground-500">
          <th className="py-2 pr-2" /><th className="py-2 pr-2">Code</th><th className="py-2 pr-2">Qualification</th><th className="py-2 pr-2">On scope until</th><th className="py-2">In the CMS</th></tr></thead>
        <tbody>{shown.map(({ item, existing }) => <tr key={item.code} className={"border-b border-background-100 align-top " + (item.current ? "" : "text-foreground-400")}>
          <td className="py-2 pr-2"><input type="checkbox" aria-label={`Create ${item.code}`} disabled={running || !!existing}
            checked={selected.has(item.code)} onChange={e => toggle(item.code, e.target.checked)} /></td>
          <td className="py-2 pr-2 font-semibold">{item.code}</td>
          <td className="py-2 pr-2">{item.title}</td>
          <td className="py-2 pr-2">{item.endDate || "—"}</td>
          <td className="py-2">{results[item.code] ?? (existing ? <span className="text-emerald-700">Already in the CMS</span> : <span className="text-foreground-600">Create a draft course</span>)}
            {(created[item.code] ?? existing?.id) && onAddUnits && !running ? <button type="button" className="ml-2 text-xs font-semibold text-primary-700 underline"
              onClick={() => onAddUnits(created[item.code] ?? existing!.id)}>Add units</button> : null}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
  </Modal>;
}
