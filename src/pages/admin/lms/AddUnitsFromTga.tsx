// Add Unit: pick core and elective units from the course's current Training.gov.au release. The chosen units are
// added to the course (or switched back on) with their nominal hours and full training.gov.au content.
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import type { RtoCourse, RtoUnit } from "@/pages/admin/lib/rto";

interface TgaUnit { code: string; name: string; nominalHours: number | null; groups: string[]; hasPrerequisites: boolean | null }
interface Release {
  code: string; name: string; releaseNumber: string; core: TgaUnit[]; electives: TgaUnit[]; groups: Record<string, string>;
  requiredElectives: number | null; packagingRules: string; specialisations: { code: string; title: string; core: number; elective: number }[];
}
interface AddResult { added: number; activated: number; alreadyOn: number; detailsSynced: number; elementsAdded: number; detailsFailed: number }

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("tga-course-import", { body });
  if (error || !data) {
    const context = error && "context" in error ? (error as { context: unknown }).context : null;
    const detail = context instanceof Response ? await context.json().catch(() => null) : null;
    throw new Error(typeof detail?.error === "string" ? detail.error : "Could not contact Training.gov.au.");
  }
  return data;
}

export default function AddUnitsFromTga({ course, units, onClose, onDone }: {
  course: RtoCourse; units: RtoUnit[]; onClose: () => void; onDone: () => void;
}) {
  const [release, setRelease] = useState<Release | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AddResult | null>(null);
  const onCourse = useMemo(() => new Map(units.map(unit => [unit.code.trim().toUpperCase(), unit.isActive])), [units]);
  const active = (code: string) => onCourse.get(code.toUpperCase()) === true;

  useEffect(() => {
    let live = true;
    call<Release>({ action: "details", code: course.code.trim().toUpperCase() }).then(data => {
      if (!live) return;
      setRelease(data);
      // Core units are required: tick the ones not yet active on the course.
      setChosen(new Set(data.core.filter(unit => onCourse.get(unit.code.toUpperCase()) !== true).map(unit => unit.code)));
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : "Could not read the qualification."); });
    return () => { live = false; };
  }, [course.code, onCourse]);

  const toggle = (code: string, on: boolean) => setChosen(s => { const next = new Set(s); if (on) next.add(code); else next.delete(code); return next; });
  const electives = (release?.electives ?? []).filter(unit => !filter.trim() || (unit.code + " " + unit.name).toLowerCase().includes(filter.trim().toLowerCase()));
  const activeElectives = (release?.electives ?? []).filter(unit => active(unit.code)).length;
  const hours = [...(release?.core ?? []), ...(release?.electives ?? [])].filter(unit => chosen.has(unit.code)).reduce((sum, unit) => sum + (unit.nominalHours ?? 0), 0);

  async function add() {
    setBusy(true); setError("");
    try {
      setResult(await call<AddResult>({ action: "add_units", courseId: course.id, codes: [...chosen] }));
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "The units could not be added."); }
    finally { setBusy(false); }
  }

  const row = (unit: TgaUnit) => {
    const on = active(unit.code);
    return <label key={unit.code} className={"flex items-start gap-2 rounded px-2 py-1.5 text-sm " + (on ? "opacity-60" : "hover:bg-background-100")}>
      <input type="checkbox" className="mt-1" disabled={on || busy} checked={on || chosen.has(unit.code)} onChange={e => toggle(unit.code, e.target.checked)} />
      <span className="min-w-0 flex-1"><span className="font-semibold text-foreground-950">{unit.code}</span> <span className="text-foreground-800">{unit.name}</span>
        <span className="block text-xs text-foreground-500">{[unit.nominalHours !== null ? `${unit.nominalHours} h` : "hours not published",
          unit.groups.length ? unit.groups.map(group => `Group ${group}`).join(", ") : "", unit.hasPrerequisites ? "has prerequisites" : "", on ? "already on the course" : ""].filter(Boolean).join(" · ")}</span></span>
    </label>;
  };

  return <Modal open title={`Add units · ${course.code}`} width="max-w-4xl" onClose={() => { if (!busy) onClose(); }}
    footer={result ? <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
      : <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-foreground-600">{chosen.size} selected{hours ? ` · ${hours} nominal hours` : ""}</span>
        <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !chosen.size || !release} onClick={() => void add()}>{busy ? "Adding… (fetching unit content)" : `Add ${chosen.size} unit${chosen.size === 1 ? "" : "s"}`}</Button></div>
      </div>}>
    {error ? <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {result ? <div className="space-y-1 text-sm text-foreground-800">
      <p className="font-semibold text-green-700">Units added to {course.code}.</p>
      <p>{result.added} added, {result.activated} switched back on{result.alreadyOn ? `, ${result.alreadyOn} were already on the course` : ""}.</p>
      <p>Training.gov.au content saved for {result.detailsSynced} units; elements, criteria and evidence for {result.elementsAdded}.</p>
      {result.detailsFailed ? <p className="text-amber-700">{result.detailsFailed} units could not be read from training.gov.au; use Sync on the course later.</p> : null}
    </div> : !release && !error ? <p className="text-sm text-foreground-500">Reading {course.code} from Training.gov.au…</p> : release ? <div className="space-y-4">
      <p className="text-sm text-foreground-600">{release.name} · release {release.releaseNumber}.{release.requiredElectives ? ` The packaging rules ask for ${release.requiredElectives} electives` : ""}
        {release.specialisations.length ? ` (specialisations: ${release.specialisations.map(item => `${item.title} ${item.elective}`).join(", ")})` : ""}.
        {` ${activeElectives} elective${activeElectives === 1 ? " is" : "s are"} on the course now.`}</p>
      <section>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-500">Core units ({release.core.length}, all required)</h4>
        <div className="rounded-lg border border-background-200 p-1">{release.core.map(row)}</div>
      </section>
      <section>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Electives ({release.electives.length})</h4>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter electives" className="w-56 rounded-lg border border-background-300 bg-background-50 px-2 py-1 text-sm" />
        </div>
        <div className="max-h-80 overflow-auto rounded-lg border border-background-200 p-1">{electives.length ? electives.map(row) : <p className="p-2 text-sm text-foreground-500">No matching electives.</p>}</div>
      </section>
      {release.packagingRules ? <details><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-foreground-500">Official packaging rules</summary>
        <p className="mt-2 max-h-60 overflow-auto whitespace-pre-line text-sm">{release.packagingRules}</p></details> : null}
    </div> : null}
  </Modal>;
}
