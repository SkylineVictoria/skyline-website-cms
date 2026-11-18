// Sync with training.gov.au: every qualification on the site's RTO scope (Settings > RTO code) is matched to its CMS course
// by qualification code. One missing qualification is picked at a time: it is created as a draft course with its core units
// through the tga-course-import function, and the new course wizard opens on it (Add units with every unit of the
// qualification, then hours, start date and term breaks, first intake, batch).
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { invokeTga } from "@/pages/admin/lib/tga";
import type { RtoCourse } from "@/pages/admin/lib/rto";

interface ScopeItem { code: string; title: string; status: string; endDate: string; current: boolean }
interface Scope { rto: string; source: string; items: ScopeItem[] }
const norm = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();

/** training.gov.au answers from Australia only, so the function runs in Sydney whoever calls it. The region goes in the
 *  URL (forceFunctionRegion), not the x-region header, which the function's CORS rules do not allow. */
async function tga<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await invokeTga<T>(body);
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
  const [selected, setSelected] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    let live = true;
    setScope(null); setResults({}); setSelected(""); setError(""); setLoading(true);
    tga<Scope>({ action: "scope" })
      .then(s => { if (live) setScope(s); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : "Could not read the scope from Training.gov.au."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open]);

  const rows = useMemo(() => (scope?.items ?? []).map(item => ({ item, existing: courses.find(c => norm(c.code) === item.code) ?? null })), [scope, courses]);
  const shown = rows.filter(r => showOld || r.item.current);

  /** Create the picked course with its core units, then run the new course wizard on it. */
  async function run() {
    const item = rows.find(r => r.item.code === selected && !r.existing)?.item;
    if (!item || running) return;
    setRunning(true); setError(""); setResults({ [item.code]: "Working…" });
    try {
      const out = await tga<{ courseId: string; coreUnits: number; electives: number }>({ action: "create_core", code: item.code });
      setResults({ [item.code]: `Draft course created with ${out.coreUnits} core unit${out.coreUnits === 1 ? "" : "s"}.` });
      setRunning(false);
      // The wizard reloads the list on the new course itself; onDone would reload on the old one.
      if (onAddUnits) onAddUnits(out.courseId); else onDone();
    } catch (e) {
      setResults({ [item.code]: `Failed: ${e instanceof Error ? e.message : "error"}` });
      setRunning(false);
    }
  }

  const missing = rows.filter(r => r.item.current && !r.existing).length;

  return <Modal open={open} title={`Sync courses from Training.gov.au${scope ? ` · RTO ${scope.rto}` : ""}`} width="max-w-5xl" onClose={() => { if (!running) onClose(); }}
    footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showOld} disabled={running} onChange={e => setShowOld(e.target.checked)} />Show qualifications no longer on scope</label>
      <div className="flex gap-2">
        <Button variant="outline" disabled={running} onClick={onClose}>Cancel</Button>
        <Button disabled={running || loading || !selected} onClick={() => void run()}
          title="Creates the course from Training.gov.au, then opens the new course wizard on it">{running ? "Importing…" : selected ? `Import ${selected} and start the wizard` : "Pick one qualification"}</Button>
      </div>
    </div>}>
    {loading ? <p className="text-sm text-foreground-500">Reading SLIT's scope of registration from Training.gov.au…</p> : null}
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {scope ? <div className="space-y-3 text-sm">
      <p className="text-foreground-600">{scope.items.filter(i => i.current).length} qualifications are on the scope of RTO {scope.rto}; {missing} {missing === 1 ? "is" : "are"} not in the CMS yet.
        Pick <strong>one</strong> to import: it is created with its units from Training.gov.au and the new course wizard opens on it (units, hours, start date and term breaks, first intake, batch).</p>
      <table className="w-full text-left">
        <thead><tr className="border-b border-background-200 text-xs text-foreground-500">
          <th className="py-2 pr-2" /><th className="py-2 pr-2">Code</th><th className="py-2 pr-2">Qualification</th><th className="py-2 pr-2">On scope until</th><th className="py-2">In the CMS</th></tr></thead>
        <tbody>{shown.map(({ item, existing }) => <tr key={item.code} className={"border-b border-background-100 align-top " + (item.current ? "" : "text-foreground-400")}>
          <td className="py-2 pr-2"><input type="radio" name="tga-sync-course" aria-label={`Import ${item.code}`} disabled={running || !!existing}
            checked={selected === item.code} onChange={() => setSelected(item.code)} /></td>
          <td className="py-2 pr-2 font-semibold">{item.code}</td>
          <td className="py-2 pr-2">{item.title}</td>
          <td className="py-2 pr-2">{item.endDate || "—"}</td>
          <td className="py-2">{results[item.code] ?? (existing ? <span className="text-emerald-700">Already in the CMS</span> : <span className="text-foreground-600">Create a draft course</span>)}
</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
  </Modal>;
}
