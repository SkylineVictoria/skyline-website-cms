import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/**
 * AVETMISS-UI (2026-11-25): a unit's NCVER fields on Courses › Units › Settings: field of education (6 digits) and the VET flag
 * (default on). Saved straight to cms_course_units (staff have write access), separately from the unit list save.
 */
export default function UnitAvetmissFields({ unitId, canEdit }: { unitId: string; canEdit: boolean }) {
  const [foe, setFoe] = useState("");
  const [vet, setVet] = useState(true);
  const [saved, setSaved] = useState<{ foe: string; vet: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    setSaved(null); setMessage(null);
    void supabase.from("cms_course_units").select("field_of_education_code, vet_flag").eq("id", unitId).maybeSingle().then(({ data, error }) => {
      if (!live) return;
      if (error) { setMessage({ tone: "error", text: error.message }); return; }
      const row = data as { field_of_education_code: string | null; vet_flag: boolean | null } | null;
      const next = { foe: row?.field_of_education_code ?? "", vet: row?.vet_flag ?? true };
      setFoe(next.foe); setVet(next.vet); setSaved(next);
    });
    return () => { live = false; };
  }, [unitId]);

  const problem = foe && !/^[0-9]{6}$/.test(foe) ? "The field of education code is 6 digits." : null;
  const dirty = saved !== null && (foe !== saved.foe || vet !== saved.vet);
  const save = async () => {
    if (problem || !dirty) return;
    setBusy(true); setMessage(null);
    const { error } = await supabase.from("cms_course_units").update({ field_of_education_code: foe || null, vet_flag: vet }).eq("id", unitId);
    setBusy(false);
    if (error) { setMessage({ tone: "error", text: error.message }); return; }
    setSaved({ foe, vet }); setMessage({ tone: "ok", text: "AVETMISS details saved." });
  };

  return (
    <div className="space-y-3 border-t border-background-200 pt-4" data-testid="unit-avetmiss">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-bold uppercase tracking-wide text-foreground-500">AVETMISS</h3>
        {saved && !saved.foe ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Field of education missing</span> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-foreground-800">Field of education code
          <input disabled={!canEdit || saved === null} inputMode="numeric" maxLength={6} placeholder="e.g. 040399" value={foe}
            onChange={(e) => setFoe(e.target.value.replace(/\D/g, ""))} aria-invalid={Boolean(problem)} data-testid="unit-foe"
            className="mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm disabled:opacity-60" />
          {problem ? <span className="mt-1 block text-xs text-red-700" role="alert">{problem}</span> : <span className="mt-1 block text-xs text-foreground-500">6 digits (ASCED).</span>}
        </label>
        <label className="flex items-center gap-2 self-center text-sm font-medium text-foreground-800">
          <input type="checkbox" disabled={!canEdit || saved === null} checked={vet} onChange={(e) => setVet(e.target.checked)} data-testid="unit-vet-flag" />
          VET unit (reported as vocational)
        </label>
      </div>
      {canEdit ? <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !dirty || Boolean(problem)} onClick={() => void save()} data-testid="unit-avetmiss-save"
          className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving…" : "Save AVETMISS details"}</button>
        {message ? <span role={message.tone === "error" ? "alert" : "status"} className={"text-sm " + (message.tone === "error" ? "text-red-700" : "text-emerald-800")}>{message.text}</span> : null}
      </div> : null}
    </div>
  );
}
