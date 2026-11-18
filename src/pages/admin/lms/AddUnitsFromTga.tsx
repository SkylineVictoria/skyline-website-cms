// Add Unit: pick core and elective units from the course's current Training.gov.au release, or add an elective from
// outside the qualification by its code. The selection is checked against the official packaging rules (the same check
// the server runs before saving), and a unit's prerequisites can be read from training.gov.au.
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";
import type { RtoCourse, RtoUnit } from "@/pages/admin/lib/rto";
import { checkElectives, parseElectiveRules, type ElectiveUnit } from "../../../../supabase/functions/tga-course-import/packaging";

interface TgaUnit { code: string; name: string; nominalHours: number | null; groups: string[]; hasPrerequisites: boolean | null }
interface Release {
  code: string; name: string; releaseNumber: string; core: TgaUnit[]; electives: TgaUnit[]; groups: Record<string, string>;
  requiredElectives: number | null; packagingRules: string; specialisations: { code: string; title: string; core: number; elective: number }[];
}
interface AddResult { added: number; activated: number; alreadyOn: number; detailsSynced: number; elementsAdded: number; detailsFailed: number; imported?: number; rulesComplete?: boolean }
interface UnitLookup {
  code: string; title: string; usage: string; current: boolean; packageCode: string; packageTitle: string;
  nominalHours: number | null; prerequisites: string | null; prerequisiteCodes: string[]; detailsRead: boolean;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("tga-course-import", { body });
  if (error || !data) {
    const context = error && "context" in error ? (error as { context: unknown }).context : null;
    const detail = context instanceof Response ? await context.json().catch(() => null) : null;
    throw new Error(typeof detail?.error === "string" ? detail.error : "Could not contact Training.gov.au.");
  }
  return data;
}


export default function AddUnitsFromTga({ course, units, onClose, onDone, nextStep, stepLabel }: {
  course: RtoCourse; units: RtoUnit[]; onClose: () => void; onDone: () => void;
  /** Shown once the units are added and every packaging rule is met (a new course: "Create first intake"). */
  nextStep?: { label: string; onClick: () => void };
  /** New course wizard: "Step 2 of 3 · Units" in the title. */
  stepLabel?: string;
}) {
  const [release, setRelease] = useState<Release | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState<UnitLookup[]>([]);
  const [attested, setAttested] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AddResult | null>(null);
  // Units read from training.gov.au (Pre-req button, manual elective): undefined = not asked, null = being read.
  const [lookups, setLookups] = useState<Record<string, UnitLookup | null | { error: string }>>({});
  const [manualCode, setManualCode] = useState("");
  const [manual, setManual] = useState<UnitLookup | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState("");
  const [note, setNote] = useState("");
  const onCourse = useMemo(() => new Map(units.map(unit => [unit.code.trim().toUpperCase(), unit])), [units]);
  const active = (code: string) => onCourse.get(code.toUpperCase())?.isActive === true;

  useEffect(() => {
    let live = true;
    call<Release>({ action: "details", code: course.code.trim().toUpperCase() }).then(data => {
      if (!live) return;
      setRelease(data);
      // Core units are required: tick the ones not yet active on the course.
      setChosen(new Set(data.core.filter(unit => onCourse.get(unit.code.toUpperCase())?.isActive !== true).map(unit => unit.code)));
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : "Could not read the qualification."); });
    return () => { live = false; };
  }, [course.code, onCourse]);

  const official = useMemo(() => new Map<string, { unit: TgaUnit; core: boolean }>([
    ...(release?.core ?? []).map((unit): [string, { unit: TgaUnit; core: boolean }] => [unit.code.toUpperCase(), { unit, core: true }]),
    ...(release?.electives ?? []).map((unit): [string, { unit: TgaUnit; core: boolean }] => [unit.code.toUpperCase(), { unit, core: false }]),
  ]), [release]);
  const rules = useMemo(() => release ? parseElectiveRules(release.packagingRules, release.requiredElectives, Object.keys(release.groups)) : null, [release]);
  // The electives the course will have: those active on it now plus the ones ticked or typed here.
  const check = useMemo(() => {
    if (!rules) return null;
    const electives = new Map<string, ElectiveUnit>();
    const add = (code: string) => {
      const listed = official.get(code.toUpperCase());
      if (!listed) electives.set(code.toUpperCase(), { code, groups: null });
      else if (!listed.core) electives.set(code.toUpperCase(), { code, groups: listed.unit.groups });
    };
    units.filter(unit => unit.isActive && unit.unitType !== "core").forEach(unit => add(unit.code.trim()));
    chosen.forEach(add);
    imported.forEach(unit => add(unit.code));
    return checkElectives(rules, [...electives.values()]);
  }, [rules, official, units, chosen, imported]);
  const selected = (code: string) => active(code) || chosen.has(code) || imported.some(unit => unit.code === code.toUpperCase());

  const toggle = (code: string, on: boolean) => {
    setChosen(s => {
      const next = new Set(s);
      if (on) next.add(code);
      else {
        // Unticking a prerequisite also unticks the picked units that need it (they always go together).
        const drop = [code.toUpperCase()];
        for (let i = 0; i < drop.length; i++) {
          for (const other of [...next]) {
            const found = lookups[other.toUpperCase()];
            if (found && !("error" in found) && found.prerequisiteCodes.some(item => item.toUpperCase() === drop[i]) && !drop.includes(other.toUpperCase())) drop.push(other.toUpperCase());
          }
        }
        for (const item of [...next]) if (drop.includes(item.toUpperCase())) next.delete(item);
        if (drop.length > 1) setNote(`Also unticked ${drop.slice(1).join(", ")}: ${drop.length > 2 ? "they need" : "it needs"} ${code}.`);
      }
      return next;
    });
    // Prerequisites are read only for the units picked, and only the missing ones are shown.
    if (on && official.get(code.toUpperCase())?.unit.hasPrerequisites !== false) lookup(code);
  };
  const electives = (release?.electives ?? []).filter(unit => !filter.trim() || (unit.code + " " + unit.name).toLowerCase().includes(filter.trim().toLowerCase()));
  const hours = [...(release?.core ?? []), ...(release?.electives ?? [])].filter(unit => chosen.has(unit.code)).reduce((sum, unit) => sum + (unit.nominalHours ?? 0), 0)
    + imported.reduce((sum, unit) => sum + (unit.nominalHours ?? 0), 0);
  const count = chosen.size + imported.length;
  const needsAttest = (rules?.unchecked.length ?? 0) > 0;
  // Read the prerequisites of every listed unit Training.gov.au marks as having them, so each row can name them.
  useEffect(() => {
    if (!release) return;
    [...release.core, ...release.electives].filter(unit => unit.hasPrerequisites === true).forEach(unit => lookup(unit.code));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per release
  }, [release]);
  // A picked unit brings its prerequisites with it: those in this qualification are ticked automatically.
  useEffect(() => {
    const add: string[] = [];
    for (const code of chosen) {
      const found = lookups[code.toUpperCase()];
      if (!found || "error" in found) continue;
      for (const need of found.prerequisiteCodes) {
        const key = need.toUpperCase();
        if (!selected(key) && official.has(key) && !add.includes(key)) add.push(key);
      }
    }
    if (!add.length) return;
    add.forEach(key => toggle(official.get(key)!.unit.code, true));
    setNote(`Added the prerequisite${add.length === 1 ? "" : "s"} ${add.join(", ")}: a unit and its prerequisites are added together.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a unit's prerequisites have been read
  }, [lookups, chosen]);
  // Units are added only when the course then meets every packaging rule (owner, 2026-11-19): a broken or unfinished rule blocks.
  const blocked = !release || !count || check?.ok === false || (check !== null && !check.complete) || (needsAttest && !attested);

  function lookup(code: string) {
    const key = code.toUpperCase();
    if (lookups[key] !== undefined) return;
    setLookups(all => ({ ...all, [key]: null }));
    call<UnitLookup>({ action: "unit_lookup", code: key })
      .then(data => setLookups(all => ({ ...all, [key]: data })))
      .catch(e => setLookups(all => ({ ...all, [key]: { error: e instanceof Error ? e.message : "Could not read the unit." } })));
  }
  /** Add a prerequisite to the selection: tick it when the qualification lists it, else add it as an outside unit. */
  function addPrerequisite(code: string) {
    const listed = official.get(code);
    if (listed) { toggle(listed.unit.code, true); return; }
    setManualCode(code); void findManual(code);
  }
  async function findManual(code = manualCode) {
    const key = code.trim().toUpperCase();
    setManual(null); setManualError("");
    if (!/^[A-Z][A-Z0-9]{4,19}$/.test(key)) { setManualError("Enter a unit code, for example BSBWHS411."); return; }
    if (official.get(key)?.core) { setManualError(`${key} is a core unit of this qualification.`); return; }
    if (official.has(key)) { setManualError(`${key} is in this qualification's elective list: tick it there.`); return; }
    if (selected(key)) { setManualError(`${key} is already on the course or selected.`); return; }
    setManualBusy(true);
    try { setManual(await call<UnitLookup>({ action: "unit_lookup", code: key })); }
    catch (e) { setManualError(e instanceof Error ? e.message : "Could not read the unit."); }
    finally { setManualBusy(false); }
  }
  function addManual() {
    if (!manual) return;
    setImported(list => [...list.filter(unit => unit.code !== manual.code), manual]);
    setLookups(all => ({ ...all, [manual.code]: manual }));
    setManual(null); setManualCode("");
  }

  async function add() {
    setBusy(true); setError("");
    try {
      setResult(await call<AddResult>({ action: "add_units", courseId: course.id, codes: [...chosen], imported: imported.map(unit => unit.code), attested }));
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "The units could not be added."); }
    finally { setBusy(false); }
  }

  // What the picked units still need: prerequisites that are neither on the course nor picked.
  const missingPrereqs = [
    ...[...chosen].map(code => { const found = lookups[code.toUpperCase()]; return { unit: code, needs: found && !("error" in found) ? found.prerequisiteCodes.filter(item => !selected(item)) : [] }; }),
    ...imported.map(unit => ({ unit: unit.code, needs: unit.prerequisiteCodes.filter(item => !selected(item)) })),
  ].filter(item => item.needs.length);
  const readingPrereqs = [...chosen].some(code => lookups[code.toUpperCase()] === null);
  // A unit cannot be added without its prerequisites (they must be on the course or picked too).
  const prereqBlocked = missingPrereqs.length > 0 || readingPrereqs;
  const brokenRules = check?.lines.filter(line => line.state === "broken") ?? [];
  const pendingRules = check?.lines.filter(line => line.state === "pending") ?? [];

  /** The unit's prerequisites with their names ("Needs first: CPCCWHS2001 Apply WHS requirements…"), under its name. */
  const prereqName = (code: string, text: string | null) => {
    const key = code.toUpperCase();
    const known = official.get(key)?.unit.name ?? onCourse.get(key)?.name;
    if (known) return known;
    const m = text ? new RegExp(`${key}\\s+([^\\n]+?)(?=\\s+[A-Z]{3,}[A-Z0-9]*\\d{3,}\\b|$|\\.|\\n)`, "i").exec(text) : null;
    return m ? m[1].trim() : "";
  };
  const prereqLine = (unit: TgaUnit) => {
    if (unit.hasPrerequisites === false) return null;
    const found = lookups[unit.code.toUpperCase()];
    if (found === undefined) return unit.hasPrerequisites ? <span className="block text-xs text-amber-800">Has prerequisites</span> : null;
    if (found === null) return <span className="block text-xs text-foreground-500">Reading prerequisites…</span>;
    if ("error" in found) return <span className="block text-xs text-amber-800">Has prerequisites (could not read them)</span>;
    if (!found.prerequisiteCodes.length) return null;
    return <span className="mt-0.5 block text-xs text-amber-900"><i className="ri-git-merge-line mr-1" aria-hidden="true" />Needs first: {found.prerequisiteCodes.map((code, i) =>
      <span key={code}>{i ? "; " : ""}<b>{code}</b>{prereqName(code, found.prerequisites) ? ` ${prereqName(code, found.prerequisites)}` : ""}{selected(code) ? " ✓" : ""}</span>)}</span>;
  };
  const row = (unit: TgaUnit) => {
    const on = active(unit.code);
    return <div key={unit.code} className={"rounded px-2 py-1.5 text-sm " + (on ? "opacity-70" : "hover:bg-background-100")}>
      <div className="flex items-start gap-2">
        <label className="flex min-w-0 flex-1 items-start gap-2">
          <input type="checkbox" className="mt-1" disabled={on || busy} checked={on || chosen.has(unit.code)} onChange={e => toggle(unit.code, e.target.checked)} />
          <span className="min-w-0 flex-1"><span className="font-semibold text-foreground-950">{unit.code}</span> <span className="text-foreground-800">{unit.name}</span>
            <span className="block text-xs text-foreground-500">{[unit.nominalHours !== null ? `${unit.nominalHours} h` : "hours not published",
              unit.groups.length ? unit.groups.map(group => `Group ${group}`).join(", ") : "", on ? "already on the course" : ""].filter(Boolean).join(" · ")}</span>
            {prereqLine(unit)}</span>
        </label>
      </div>
    </div>;
  };

  return <Modal open title={`${stepLabel ? stepLabel + " · " : ""}Add units · ${course.code}`} width="max-w-4xl" onClose={() => { if (!busy) onClose(); }}
    footer={result ? <div className="flex justify-end gap-2">{nextStep && result.rulesComplete !== false
        ? <><Button variant="outline" onClick={onClose}>Later</Button><Button icon="ri-calendar-event-line" onClick={nextStep.onClick}>{nextStep.label}</Button></>
        : <Button onClick={onClose}>Close</Button>}</div>
      : <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-foreground-600">{count} selected{hours ? ` · ${hours} nominal hours` : ""}
          {check?.ok === false ? <span className="ml-2 font-semibold text-red-700">Packaging rules not followed</span>
            : check && !check.complete && count ? <span className="ml-2 font-semibold text-amber-800">Select units until every packaging rule is met</span> : null}</span>
        <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || blocked || prereqBlocked} title={prereqBlocked ? "Add the prerequisites of the units you picked first" : undefined} onClick={() => void add()}>{busy ? "Adding… (fetching unit content)" : `Add ${count} unit${count === 1 ? "" : "s"}`}</Button></div>
      </div>}>
    {error ? <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {result ? <div className="space-y-1 text-sm text-foreground-800">
      <p className="font-semibold text-green-700">Units added to {course.code}.</p>
      <p>{result.added} added, {result.activated} switched back on{result.alreadyOn ? `, ${result.alreadyOn} were already on the course` : ""}.</p>
      <p>Training.gov.au content saved for {result.detailsSynced} units; elements, criteria and evidence for {result.elementsAdded}.</p>
      {result.rulesComplete === false ? <p className="text-amber-700">The electives on the course do not yet meet every packaging rule. Add the remaining units when ready.</p> : null}
      {result.detailsFailed ? <p className="text-amber-700">{result.detailsFailed} units could not be read from training.gov.au; use Sync on the course later.</p> : null}
    </div> : !release && !error ? <p className="text-sm text-foreground-500">Reading {course.code} from Training.gov.au…</p> : release ? <div className="space-y-4">
      <p className="text-sm text-foreground-600">{release.name} · release {release.releaseNumber}.
        {release.specialisations.length ? ` Specialisations: ${release.specialisations.map(item => `${item.title} ${item.elective}`).join(", ")}.` : ""}</p>

      <section aria-label="Your selection" className={"sticky top-0 z-10 space-y-2 rounded-lg border p-3 shadow-sm " + (brokenRules.length ? "border-red-300 bg-red-50" : missingPrereqs.length || pendingRules.length || needsAttest ? "border-amber-300 bg-amber-50" : "border-green-300 bg-green-50")}>
        <p className="text-sm font-semibold text-foreground-950">{count ? `${count} unit${count === 1 ? "" : "s"} picked${hours ? ` · ${hours} nominal hours` : ""}` : "Tick the electives to add."}</p>
        {brokenRules.map(line => <p key={line.label} role="alert" className="text-sm font-semibold text-red-700"><i className="ri-close-circle-line mr-1" aria-hidden="true" />{line.label}: {line.detail}</p>)}
        {!brokenRules.length && pendingRules.map(line => <p key={line.label} className="text-sm text-amber-800"><i className="ri-time-line mr-1" aria-hidden="true" />Still to pick: {line.label} ({line.detail})</p>)}
        {check && !brokenRules.length && !pendingRules.length && count > 0 ? <p className="text-sm text-green-800"><i className="ri-checkbox-circle-line mr-1" aria-hidden="true" />The elective rules are met.</p> : null}
        {missingPrereqs.map(item => <p key={item.unit} className="flex flex-wrap items-center gap-2 text-sm text-amber-900">
          <span><i className="ri-git-merge-line mr-1" aria-hidden="true" /><b>{item.unit}</b> needs</span>
          {item.needs.map(code => <button key={code} type="button" disabled={busy} onClick={() => addPrerequisite(code)}
            className="rounded border border-amber-400 bg-background-50 px-2 py-0.5 text-xs font-semibold text-amber-900 hover:bg-amber-100">Add {code}</button>)}</p>)}
        {readingPrereqs ? <p className="text-xs text-foreground-500">Checking the prerequisites of the units you picked…</p> : null}
        {missingPrereqs.length ? <p role="alert" className="text-sm font-semibold text-amber-900">A unit and its prerequisites are added together: add the prerequisites above (or untick the unit) before adding.</p> : null}
        {note ? <p role="status" className="text-xs text-foreground-700"><i className="ri-information-line mr-1" aria-hidden="true" />{note}</p> : null}
        {needsAttest && rules ? <div className="text-sm text-amber-900">
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={attested} disabled={busy} onChange={e => setAttested(e.target.checked)} />
            <span>I have checked this selection against the official packaging rules (some rules cannot be checked automatically).</span></label>
          <details className="ml-6 text-xs"><summary className="cursor-pointer">Rules to check by hand</summary><ul className="ml-4 list-disc">{rules.unchecked.map(line => <li key={line}>{line}</li>)}</ul></details>
        </div> : null}
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Electives ({release.electives.length})</h4>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter electives" aria-label="Filter electives" className="w-56 rounded-lg border border-background-300 bg-background-50 px-2 py-1 text-sm" />
        </div>
        <div className="max-h-[45vh] overflow-auto rounded-lg border border-background-200 p-1">{electives.length ? electives.map(row) : <p className="p-2 text-sm text-foreground-500">No matching electives.</p>}</div>
      </section>

      <details>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-foreground-500">Core units ({release.core.length}, all required)</summary>
        <div className="mt-2 rounded-lg border border-background-200 p-1">{release.core.map(row)}</div>
      </details>

      <details open={imported.length > 0 || !!manual}>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-foreground-500">Add an elective from outside this qualification{imported.length ? ` (${imported.length} added)` : ""}</summary>
        <div className="mt-2">
        {rules && !rules.outsideMax && !needsAttest
          ? <p className="text-sm text-foreground-600">The packaging rules of {release.code} do not allow units from outside its own lists.</p>
          : <div className="space-y-2 rounded-lg border border-background-200 p-3">
            <p className="text-xs text-foreground-600">{rules?.outsideMax ? `Up to ${rules.outsideMax} allowed: “${rules.outsideText}”.` : "Check the official packaging rules for how many are allowed."} Enter the unit code as on Training.gov.au; only current units can be added.</p>
            <div className="flex flex-wrap items-center gap-2">
              <input value={manualCode} onChange={e => { setManualCode(e.target.value.toUpperCase()); setManual(null); setManualError(""); }}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void findManual(); } }}
                placeholder="Unit code" aria-label="Unit code from outside this qualification" className="w-48 rounded-lg border border-background-300 bg-background-50 px-2 py-1.5 text-sm uppercase" />
              <Button variant="outline" disabled={manualBusy || busy || !manualCode.trim()} onClick={() => void findManual()}>{manualBusy ? "Looking up…" : "Look up"}</Button>
            </div>
            {manualError ? <p role="alert" className="text-sm text-red-700">{manualError}</p> : null}
            {manual ? <div className="rounded-lg border border-background-200 bg-background-50 p-2 text-sm">
              <p><span className="font-semibold text-foreground-950">{manual.code}</span> {manual.title}</p>
              <p className="text-xs text-foreground-500">{[manual.packageCode ? `${manual.packageCode} ${manual.packageTitle}` : "", manual.usage, manual.nominalHours !== null ? `${manual.nominalHours} h` : "hours not published"].filter(Boolean).join(" · ")}</p>
              <div className="mt-1">{manual.prerequisites ? <><p className="text-xs font-semibold text-foreground-700">Prerequisites</p>{prerequisitesOf(manual, selected, addPrerequisite, busy)}</>
                : <p className="text-xs text-foreground-600">{manual.detailsRead ? "No prerequisites listed on Training.gov.au." : "Prerequisites could not be read from Training.gov.au."}</p>}</div>
              {manual.current ? <div className="mt-2"><Button disabled={busy} onClick={addManual}>Add {manual.code} to the selection</Button></div>
                : <p className="mt-1 font-semibold text-red-700">This unit is {manual.usage.toLowerCase() || "not current"} on Training.gov.au and cannot be added.</p>}
            </div> : null}
            {imported.length ? <ul className="space-y-1">{imported.map(unit => <li key={unit.code} className="flex items-start justify-between gap-2 rounded bg-background-100 px-2 py-1.5 text-sm">
              <span className="min-w-0"><span className="font-semibold text-foreground-950">{unit.code}</span> {unit.title}
                <span className="block text-xs text-foreground-500">{[unit.packageCode, unit.nominalHours !== null ? `${unit.nominalHours} h` : "hours not published", "outside unit",
                  unit.prerequisiteCodes.filter(item => !selected(item)).length ? `prerequisites not selected: ${unit.prerequisiteCodes.filter(item => !selected(item)).join(", ")}` : ""].filter(Boolean).join(" · ")}</span></span>
              <button type="button" disabled={busy} onClick={() => setImported(list => list.filter(item => item.code !== unit.code))}
                className="shrink-0 text-xs font-semibold text-red-700 hover:underline">Remove</button></li>)}</ul> : null}
          </div>}
        </div>
      </details>

      {release.packagingRules ? <details><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-foreground-500">Official packaging rules</summary>
        <p className="mt-2 max-h-60 overflow-auto whitespace-pre-line text-sm">{release.packagingRules}</p></details> : null}
    </div> : null}
  </Modal>;
}

/** Prerequisite text of a looked-up unit with the units still missing from the selection. */
function prerequisitesOf(unit: UnitLookup, selected: (code: string) => boolean, add: (code: string) => void, busy: boolean) {
  const missing = unit.prerequisiteCodes.filter(item => !selected(item));
  return <div className="space-y-1 text-xs">
    <p className="whitespace-pre-line text-foreground-800">{unit.prerequisites}</p>
    {missing.length ? <p className="flex flex-wrap items-center gap-2 text-amber-700">Not on the course or selected:
      {missing.map(item => <button key={item} type="button" disabled={busy} onClick={() => add(item)}
        className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800 hover:bg-amber-100">Add {item}</button>)}</p> : null}
  </div>;
}
