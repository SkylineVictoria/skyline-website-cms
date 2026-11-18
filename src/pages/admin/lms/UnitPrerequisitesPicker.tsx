import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

type Unit = { id?: string; code: string; name: string; isActive: boolean };
export type PrereqMap = Record<string, { id: string; code: string }[]>;

/**
 * A unit's prerequisites (units of the same course taught first). Those read from Training.gov.au are ticked and locked; staff add
 * or remove their own. RTO Managers save (unit_prerequisites_set); a unit cannot require one that already requires it.
 */
export default function UnitPrerequisitesPicker({ unitId, courseUnits, needs, canEdit, onSaved }: {
  unitId: string; courseUnits: Unit[]; needs: PrereqMap; canEdit: boolean; onSaved: (map: PrereqMap) => void;
}) {
  const [manual, setManual] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setManual(null); setMessage(""); setError("");
    supabase.from("cms_course_units").select("prerequisite_ids").eq("id", unitId).maybeSingle().then(({ data, error: e }) => {
      if (!live) return;
      const ids = e ? [] : ((data as { prerequisite_ids?: string[] } | null)?.prerequisite_ids ?? []);
      setManual(ids); setPicked(new Set(ids));
      if (e) setError("Choosing prerequisites needs the database update (migration 20261118223147).");
    });
    return () => { live = false; };
  }, [unitId]);
  const all = useMemo(() => new Set((needs[unitId] ?? []).map((n) => n.id)), [needs, unitId]);
  // Read from Training.gov.au: in the combined list but not picked by hand.
  const fromTga = useMemo(() => new Set([...all].filter((id) => !(manual ?? []).includes(id))), [all, manual]);
  const others = courseUnits.filter((u) => u.id && u.id !== unitId && u.isActive);
  const changed = manual !== null && (manual.length !== picked.size || manual.some((id) => !picked.has(id)));

  const save = async () => {
    setBusy(true); setError(""); setMessage("");
    const { data, error: e } = await supabase.rpc("unit_prerequisites_set", { p_unit: unitId, p_ids: [...picked] });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setManual([...picked]); setMessage("Prerequisites saved.");
    onSaved((data ?? {}) as PrereqMap);
  };

  return (
    <div className="space-y-2 border-t border-background-200 pt-4">
      <h3 className="font-heading text-sm font-bold uppercase tracking-wide text-foreground-500">Prerequisites</h3>
      <p className="text-xs text-foreground-600">Units a student must do first. They are taught earlier in every intake, and a student who has not done them takes this unit later.</p>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}
      {message ? <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">{message}</p> : null}
      {manual === null ? <p className="text-xs text-foreground-500">Loading…</p> : !others.length ? <p className="text-xs text-foreground-500">This course has no other active units.</p> : (
        <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-background-200 p-2">
          {others.map((u) => {
            const locked = fromTga.has(u.id as string);
            const checked = locked || picked.has(u.id as string);
            return (
              <li key={u.id}>
                <label className={`flex items-start gap-2 rounded px-1.5 py-1 text-sm ${locked ? "text-foreground-600" : "hover:bg-background-100"}`}>
                  <input type="checkbox" className="mt-0.5" disabled={!canEdit || locked || busy} checked={checked}
                    onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(u.id as string); else n.delete(u.id as string); return n; })} />
                  <span><span className="font-semibold">{u.code}</span> {u.name}{locked ? <span className="ml-1 rounded-full bg-background-200 px-1.5 py-0.5 text-[10px] font-semibold text-foreground-600">Training.gov.au</span> : null}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && changed ? <div className="flex justify-end"><button type="button" disabled={busy} onClick={() => void save()} className="rounded-md bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save prerequisites"}</button></div> : null}
    </div>
  );
}
