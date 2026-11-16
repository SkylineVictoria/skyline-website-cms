import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { generateClassSessions, loadClassSessions, rto, type RtoIntake } from "@/pages/admin/lib/rto";

interface BreakRow { id: string; label: string; startDate: string; endDate: string }
type Draft = { id: string | null; label: string; startDate: string; endDate: string };

const DAY = 86_400_000;
const parse = (s: string) => new Date(s + "T00:00:00Z");
const fmt = (s: string) => parse(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const days = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / DAY) + 1;
const today = new Date().toISOString().slice(0, 10);
const inputClass = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";

/** Term breaks: no classes are generated on these days. RTO Managers add, change and remove them; other staff can view. */
export default function LmsTermBreaksPage() {
  const [rows, setRows] = useState<BreakRow[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showPast, setShowPast] = useState(false);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("academic_breaks").select("id, label, start_date, end_date").order("start_date");
    if (e) throw new Error(e.message);
    setRows((data ?? []).map((b: { id: string; label: string; start_date: string; end_date: string }) => ({ id: b.id, label: b.label, startDate: b.start_date, endDate: b.end_date })));
  }, []);
  useEffect(() => {
    Promise.all([load(), rto<{ rtoManager: boolean }>("me").then(me => setCanEdit(me.rtoManager))])
      .catch(e => setError(e instanceof Error ? e.message : "Unable to load term breaks"))
      .finally(() => setLoading(false));
  }, [load]);

  const shown = useMemo(() => showPast ? rows : rows.filter(r => r.endDate >= today), [rows, showPast]);
  const pastCount = rows.length - rows.filter(r => r.endDate >= today).length;
  const overlaps = (r: { id: string | null; startDate: string; endDate: string }) =>
    rows.filter(o => o.id !== r.id && o.startDate <= r.endDate && r.startDate <= o.endDate);

  /** Re-plans every batch that has classes from today on, or class times in an intake still running, so they follow the breaks. */
  const replanClasses = async () => {
    const until = new Date(parse(today).getTime() + 399 * DAY).toISOString().slice(0, 10);
    const [upcoming, intakes] = await Promise.all([
      loadClassSessions(null, today, until).catch(() => []),
      rto<RtoIntake[]>("intake_list").catch(() => [] as RtoIntake[]),
    ]);
    const ids = new Set(upcoming.map(s => s.batchId));
    for (const i of intakes) if (!i.endDate || i.endDate >= today) for (const b of i.batchList ?? []) if (b.isActive && b.days.length) ids.add(b.id);
    let done = 0;
    for (const id of ids) { try { await generateClassSessions(id); done += 1; } catch { /* a batch without class times has nothing to plan */ } }
    return done;
  };
  const replanNote = (n: number) => n ? ` Classes updated for ${n} batch${n === 1 ? "" : "es"}.` : "";

  const draftProblem = !draft ? "" : !draft.label.trim() ? "Enter a name."
    : draft.label.trim().length > 80 ? "The name can be at most 80 characters."
    : !draft.startDate || !draft.endDate ? "Enter the first and last day."
    : draft.endDate < draft.startDate ? "The last day must be on or after the first day." : "";
  const draftOverlaps = draft && !draftProblem ? overlaps(draft) : [];

  const save = async () => {
    if (!draft || draftProblem || busy) return;
    setBusy(true); setError(""); setNotice("");
    const values = { label: draft.label.trim(), start_date: draft.startDate, end_date: draft.endDate };
    try {
      const { error: e } = draft.id
        ? await supabase.from("academic_breaks").update(values).eq("id", draft.id)
        : await supabase.from("academic_breaks").insert(values);
      if (e) throw new Error(e.message);
      await load();
      const touchesFuture = values.end_date >= today || rows.some(r => r.id === draft.id && r.endDate >= today);
      const n = touchesFuture ? await replanClasses() : 0;
      setNotice(`${values.label} saved.${replanNote(n)}`);
      setDraft(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save the break"); }
    finally { setBusy(false); }
  };
  const remove = async (r: BreakRow) => {
    if (busy || !window.confirm(`Delete "${r.label}" (${fmt(r.startDate)} – ${fmt(r.endDate)})?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { error: e } = await supabase.from("academic_breaks").delete().eq("id", r.id);
      if (e) throw new Error(e.message);
      await load();
      const n = r.endDate >= today ? await replanClasses() : 0;
      setNotice(`${r.label} deleted.${replanNote(n)}`);
      if (draft?.id === r.id) setDraft(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to delete the break"); }
    finally { setBusy(false); }
  };

  const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
  return <div className="mx-auto max-w-5xl space-y-5 pb-12">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Learning Management</p>
        <h1 className="mt-1 font-heading text-3xl font-bold text-foreground-950">Term breaks</h1>
        <p className="mt-2 text-sm text-foreground-600">No classes are held on these days. When you add, change or delete a break, every running batch's classes move automatically. Public holidays come from HR (confirmed holidays only) and are skipped too.</p>
      </div>
      {canEdit && !draft && <button type="button" onClick={() => { setDraft({ id: null, label: "", startDate: "", endDate: "" }); setNotice(""); }}
        className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700">Add break</button>}
    </div>

    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}

    {draft && <section className={card + " p-5"} aria-label={draft.id ? "Edit break" : "Add break"}>
      <h2 className="font-heading text-lg font-bold text-foreground-950">{draft.id ? "Edit break" : "Add break"}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px_180px]">
        <label className="block text-sm font-medium text-foreground-800">Name
          <input autoFocus maxLength={80} placeholder="e.g. Term 1 break" className={inputClass + " mt-1"} value={draft.label} onChange={e => setDraft(d => d && { ...d, label: e.target.value })} /></label>
        <label className="block text-sm font-medium text-foreground-800">First day
          <input type="date" className={inputClass + " mt-1"} value={draft.startDate} onChange={e => setDraft(d => d && { ...d, startDate: e.target.value, endDate: d.endDate && d.endDate >= e.target.value ? d.endDate : e.target.value })} /></label>
        <label className="block text-sm font-medium text-foreground-800">Last day
          <input type="date" min={draft.startDate || undefined} className={inputClass + " mt-1"} value={draft.endDate} onChange={e => setDraft(d => d && { ...d, endDate: e.target.value })} /></label>
      </div>
      <div className="mt-3 space-y-1 text-sm">
        {draftProblem ? <p className="text-red-700">{draftProblem}</p>
          : <p className="text-foreground-600">{days(draft.startDate, draft.endDate)} days, {fmt(draft.startDate)} – {fmt(draft.endDate)}.</p>}
        {draftOverlaps.length > 0 && <p className="text-amber-800">Overlaps {draftOverlaps.map(o => `${o.label} (${fmt(o.startDate)} – ${fmt(o.endDate)})`).join(", ")}.</p>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => setDraft(null)} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold hover:bg-background-100">Cancel</button>
        <button type="button" disabled={busy || !!draftProblem} onClick={() => void save()}
          className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "Saving and updating classes…" : draft.id ? "Save break" : "Add break"}</button>
      </div>
    </section>}

    <section className={card + " min-w-0 p-5"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-bold text-foreground-950">{showPast ? "All breaks" : "Current and upcoming breaks"}</h2>
        {pastCount > 0 && <label className="flex items-center gap-2 text-sm text-foreground-600">
          <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} />Show {pastCount} past</label>}
      </div>
      {loading ? <p className="py-8 text-center text-sm text-foreground-500">Loading…</p>
      : !shown.length ? <p className="py-8 text-center text-sm text-foreground-500">{canEdit ? "No breaks yet. Add the term breaks for the year." : "No breaks set."}</p>
      : <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
        <thead><tr className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
          <th className="px-2 py-2 font-semibold">Break</th><th className="px-2 py-2 font-semibold">First day</th><th className="px-2 py-2 font-semibold">Last day</th>
          <th className="px-2 py-2 text-right font-semibold">Days</th><th className="px-2 py-2" /></tr></thead>
        <tbody>{shown.map(r => {
          const clash = overlaps(r);
          const now = r.startDate <= today && today <= r.endDate;
          return <tr key={r.id} className={`border-b border-background-100 ${r.endDate < today ? "text-foreground-400" : ""}`}>
            <td className="px-2 py-2 font-semibold text-foreground-900">{r.label}
              {now && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">Now</span>}
              {clash.length > 0 && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800" title={clash.map(o => o.label).join(", ")}>Overlaps</span>}</td>
            <td className="px-2 py-2">{fmt(r.startDate)}</td>
            <td className="px-2 py-2">{fmt(r.endDate)}</td>
            <td className="px-2 py-2 text-right">{days(r.startDate, r.endDate)}</td>
            <td className="px-2 py-2 text-right whitespace-nowrap">{canEdit && <>
              <button type="button" disabled={busy} onClick={() => { setDraft({ ...r }); setNotice(""); }} className="text-xs font-semibold text-primary-700 hover:underline">Edit</button>
              <button type="button" disabled={busy} onClick={() => void remove(r)} className="ml-3 text-xs font-semibold text-red-700 hover:underline">Delete</button></>}</td>
          </tr>;
        })}</tbody>
      </table></div>}
    </section>
  </div>;
}
