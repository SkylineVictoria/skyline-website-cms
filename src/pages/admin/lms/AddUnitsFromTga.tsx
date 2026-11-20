// Add Unit: pick core and elective units from the course's current Training.gov.au release, or add an elective from
// outside the qualification by its code. The selection is checked against the official packaging rules (the same check
// the server runs before saving), and a unit's prerequisites can be read from training.gov.au.
import { useEffect, useMemo, useRef, useState } from "react";
import { ruleText } from "@/lib/businessRules";
import { Button, Modal } from "@/pages/admin/components/ui";
import { invokeTga } from "@/pages/admin/lib/tga";
import type { RtoCourse, RtoUnit } from "@/pages/admin/lib/rto";
import { autoPickElectives, checkElectives, groupSizes, parseElectiveRules, type ElectiveUnit } from "../../../../supabase/functions/tga-course-import/packaging";

interface TgaUnit { code: string; name: string; nominalHours: number | null; groups: string[]; hasPrerequisites: boolean | null }
interface Release {
  code: string; name: string; releaseNumber: string; core: TgaUnit[]; electives: TgaUnit[]; groups: Record<string, string>;
  requiredElectives: number | null; packagingRules: string; specialisations: { code: string; title: string; core: number; elective: number }[];
}
interface AddResult { removed?: number; added: number; activated: number; alreadyOn: number; detailsSynced: number; elementsAdded: number; detailsFailed: number; imported?: number; rulesComplete?: boolean }
interface UnitLookup {
  code: string; title: string; usage: string; current: boolean; packageCode: string; packageTitle: string;
  nominalHours: number | null; prerequisites: string | null; prerequisiteCodes: string[]; detailsRead: boolean;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await invokeTga<T>(body);
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
  // Electives on the course that staff unticked: switched off when the change is saved (to change a unit for another).
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  // How the electives of a course without any are chosen (owner, 2026-11-20): asked first. "ai" = the system reads the units and
  // picks electives that meet every rule (behind the loader); "manual" = empty boxes, staff tick them, nothing is checked or
  // added by itself while ticking (the server still checks the packaging rules when the units are saved).
  const [mode, setMode] = useState<"ai" | "manual" | null>(null);
  const manualMode = mode === "manual";
  const onCourse = useMemo(() => new Map(units.map(unit => [unit.code.trim().toUpperCase(), unit])), [units]);
  const active = (code: string) => onCourse.get(code.toUpperCase())?.isActive === true && !removing.has(code.toUpperCase());
  const onCourseNow = (code: string) => onCourse.get(code.toUpperCase())?.isActive === true;

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
  const rules = useMemo(() => release ? parseElectiveRules(release.packagingRules, release.requiredElectives, Object.keys(release.groups), groupSizes(release.electives)) : null, [release]);
  // The electives the course will have: those active on it now plus the ones ticked or typed here.
  const check = useMemo(() => {
    if (!rules) return null;
    const electives = new Map<string, ElectiveUnit>();
    const add = (code: string) => {
      const listed = official.get(code.toUpperCase());
      if (!listed) electives.set(code.toUpperCase(), { code, groups: null });
      else if (!listed.core) electives.set(code.toUpperCase(), { code, groups: listed.unit.groups });
    };
    units.filter(unit => unit.isActive && unit.unitType !== "core" && !removing.has(unit.code.trim().toUpperCase())).forEach(unit => add(unit.code.trim()));
    chosen.forEach(add);
    imported.forEach(unit => add(unit.code));
    return checkElectives(rules, [...electives.values()]);
  }, [rules, official, units, chosen, imported, removing]);
  const selected = (code: string) => active(code) || chosen.has(code) || imported.some(unit => unit.code === code.toUpperCase());

  const toggle = (code: string, on: boolean) => {
    setChosen(s => {
      const next = new Set(s);
      // A unit and its prerequisites go together (owner, 2026-11-20): ticking a unit adds its prerequisites by itself (below);
      // unticking a unit also unticks the picked units that need it.
      if (on) next.add(code);
      else {
        const drop = new Set([code.toUpperCase()]);
        for (let grew = true; grew;) {
          grew = false;
          for (const c of next) {
            const found = lookups[c.toUpperCase()];
            if (!drop.has(c.toUpperCase()) && found && !("error" in found) && found.prerequisiteCodes.some(x => drop.has(x.toUpperCase()))) { drop.add(c.toUpperCase()); grew = true; }
          }
        }
        for (const c of [...next]) if (drop.has(c.toUpperCase())) next.delete(c);
        setImported(list => list.filter(unit => !unit.prerequisiteCodes.some(x => drop.has(x.toUpperCase()))));
      }
      return next;
    });
    // Prerequisites are read only for the units picked, and only the missing ones are shown.
    if (on) lookup(code);
  };
  const electives = (release?.electives ?? []).filter(unit => !filter.trim() || (unit.code + " " + unit.name).toLowerCase().includes(filter.trim().toLowerCase()));
  const hours = [...(release?.core ?? []), ...(release?.electives ?? [])].filter(unit => chosen.has(unit.code)).reduce((sum, unit) => sum + (unit.nominalHours ?? 0), 0)
    + imported.reduce((sum, unit) => sum + (unit.nominalHours ?? 0), 0);
  const count = chosen.size + imported.length;
  const electiveTotal = units.filter(unit => unit.isActive && unit.unitType !== "core" && !removing.has(unit.code.trim().toUpperCase())).length
    + [...chosen].filter(code => official.get(code.toUpperCase())?.core === false).length + imported.length;
  const changes = count + removing.size;
  // Untick / tick again an elective that is already on the course.
  const toggleOnCourse = (code: string, keep: boolean) => setRemoving(s => {
    const next = new Set(s); if (keep) next.delete(code.toUpperCase()); else next.add(code.toUpperCase()); return next;
  });
  // A unit on the course that another unit staying on it needs cannot be removed.
  const neededBy = (code: string) => units.filter(unit => unit.isActive && !removing.has(unit.code.trim().toUpperCase()) && unit.code.trim().toUpperCase() !== code.toUpperCase())
    .filter(unit => { const found = lookups[unit.code.trim().toUpperCase()]; return !!found && !("error" in found) && found.prerequisiteCodes.some(item => item.toUpperCase() === code.toUpperCase()); })
    .map(unit => unit.code.trim());
  const needsAttest = (rules?.unchecked.length ?? 0) > 0;
  // Read the prerequisites of every listed unit (owner, 2026-11-19: the release's "has prerequisites" flag is often missing),
  // eight at a time, so each row names them.
  useEffect(() => {
    if (!release) return;
    let live = true;
    const queue = [...release.electives, ...release.core].map(unit => unit.code.toUpperCase()).filter(code => lookups[code] === undefined);
    setLookups(all => ({ ...all, ...Object.fromEntries(queue.map(code => [code, null])) }));
    const worker = async () => {
      while (live && queue.length) {
        const key = queue.shift()!;
        try { const data = await call<UnitLookup>({ action: "unit_lookup", code: key }); if (live) setLookups(all => ({ ...all, [key]: data })); }
        catch (e) { if (live) setLookups(all => ({ ...all, [key]: { error: e instanceof Error ? e.message : "Could not read the unit." } })); }
      }
    };
    void Promise.all(Array.from({ length: 8 }, worker));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per release
  }, [release]);
  // Units are added only when the course then meets every packaging rule (owner, 2026-11-19): a broken or unfinished rule blocks.
  const removeBlocked = [...removing].flatMap(code => neededBy(code).map(other => `${code} is needed by ${other}`));
  const blocked = !release || !changes || removeBlocked.length > 0 || (needsAttest && !attested)
    || (!manualMode && (check?.ok === false || (check !== null && !check.complete)));


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
      const out = await call<AddResult>({ action: "add_units", courseId: course.id, codes: [...chosen], imported: imported.map(unit => unit.code), remove: [...removing], attested });
      onDone();
      // In the course wizard the next step opens by itself once every rule is met.
      if (nextStep && out.rulesComplete !== false) { nextStep.onClick(); return; }
      setResult(out);
    } catch (e) { setError(e instanceof Error ? e.message : "The units could not be added."); }
    finally { setBusy(false); }
  }

  // What the picked units still need: prerequisites that are neither on the course nor picked.
  const missingPrereqs = [
    ...[...chosen].map(code => { const found = lookups[code.toUpperCase()]; return { unit: code, needs: found && !("error" in found) ? found.prerequisiteCodes.filter(item => !selected(item)) : [] }; }),
    ...imported.map(unit => ({ unit: unit.code, needs: unit.prerequisiteCodes.filter(item => !selected(item)) })),
  ].filter(item => item.needs.length);
  const readingPrereqs = [...chosen].some(code => lookups[code.toUpperCase()] === null);
  // The missing prerequisites are added by themselves: ticked when the qualification lists them, else read from
  // training.gov.au and added as an outside unit (each code once; their own prerequisites follow the same way).
  const autoAdding = useRef(new Set<string>());
  const [autoError, setAutoError] = useState("");
  const missingKey = missingPrereqs.flatMap(item => item.needs).map(code => code.toUpperCase()).sort().join(",");
  useEffect(() => {
    if (!missingKey || manualMode) return;
    for (const code of new Set(missingKey.split(","))) {
      const listed = official.get(code);
      if (listed) { toggle(listed.unit.code, true); continue; }
      if (autoAdding.current.has(code)) continue;
      autoAdding.current.add(code);
      void call<UnitLookup>({ action: "unit_lookup", code })
        .then(found => { setImported(list => (list.some(unit => unit.code === found.code) ? list : [...list, found])); setLookups(all => ({ ...all, [found.code]: found })); })
        .catch(e => setAutoError(`${code} could not be added by itself (${e instanceof Error ? e.message : "not found"}): add it under "Add an elective from outside this qualification".`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the missing prerequisite codes
  }, [missingKey, manualMode]);
  // Default electives (owner, 2026-11-20: "system select units so user can't go wrong"): once every listed elective's
  // prerequisites are read, electives that meet every packaging rule are ticked, units without prerequisites first. Staff
  // can change any of them; "Pick for me" picks again from scratch.
  const [autoNote, setAutoNote] = useState("");
  const autoDone = useRef(false);
  const lookupsReady = !!release && [...release.electives, ...release.core].every(unit => { const found = lookups[unit.code.toUpperCase()]; return found !== undefined && found !== null; });
  const lookupsDone = release ? [...release.electives, ...release.core].filter(unit => { const found = lookups[unit.code.toUpperCase()]; return found !== undefined && found !== null; }).length : 0;
  const lookupsTotal = release ? release.electives.length + release.core.length : 0;
  // While the system reads the units and picks the electives, the screen is locked (owner, 2026-11-20: "run a loader so the
  // user doesn't play with it"). A course that already has electives is not picked for, so it is not locked.
  const coursePicked = units.some(unit => unit.isActive && unit.unitType !== "core") || imported.length > 0;
  // Business rule (lms.elective_automatic_selection_order): "Do not …" turns automatic picking off; then no question, staff tick.
  const autoAllowed = !ruleText("lms.elective_automatic_selection_order", "Pick automatically").startsWith("Do not");
  // The question comes first, only for a course with no electives yet (the same courses the system would pick for).
  const choosing = autoAllowed && !!release && !coursePicked && mode === null && !autoDone.current;
  const picking = autoAllowed && !!release && !coursePicked && !autoDone.current && mode === "ai";
  const chooseMode = (next: "ai" | "manual") => {
    if (next === "manual") {
      autoDone.current = true;
      setAutoNote("Manual selection: tick the electives you want. The packaging rules are checked when you save.");
    }
    setMode(next);
  };
  const pickDefaults = (fresh: boolean) => {
    if (!release || !rules) return;
    const keep = new Set(fresh ? [...chosen].filter(code => official.get(code.toUpperCase())?.core) : chosen);
    const isSelected = (code: string) => active(code) || keep.has(code) || keep.has(code.toUpperCase()) || imported.some(unit => unit.code === code.toUpperCase());
    const current: ElectiveUnit[] = [
      ...units.filter(unit => unit.isActive && unit.unitType !== "core" && !removing.has(unit.code.trim().toUpperCase())).map(unit => ({ code: unit.code.trim(), groups: official.get(unit.code.trim().toUpperCase())?.unit.groups ?? null })),
      ...[...keep].filter(code => official.get(code.toUpperCase()) && !official.get(code.toUpperCase())!.core).map(code => ({ code, groups: official.get(code.toUpperCase())!.unit.groups })),
      ...imported.map(unit => ({ code: unit.code, groups: null })),
    ];
    const candidates = release.electives.map(unit => { const found = lookups[unit.code.toUpperCase()]; return { code: unit.code, groups: unit.groups, prerequisites: found && !("error" in found) ? found.prerequisiteCodes : [] }; });
    const picks = autoPickElectives(rules, candidates, current, isSelected);
    if (!picks) { setAutoNote(rules.required ? `Tick ${rules.required} electives: the system could not pick a set that meets every rule.` : "Tick the electives for this course."); if (fresh) setChosen(keep); return; }
    setChosen(new Set([...keep, ...picks]));
    picks.forEach(code => lookup(code));
    setAutoNote(picks.length ? `${picks.length} elective${picks.length === 1 ? "" : "s"} picked for you to meet the rules. Change any of them if you like.` : "");
  };
  useEffect(() => {
    if (autoDone.current || mode !== "ai" || !lookupsReady || !rules || !release) return;
    autoDone.current = true;
    const hasElectives = units.some(unit => unit.isActive && unit.unitType !== "core") || [...chosen].some(code => official.get(code.toUpperCase())?.core === false) || imported.length > 0;
    if (!hasElectives && !ruleText("lms.elective_automatic_selection_order", "Pick automatically").startsWith("Do not")) pickDefaults(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the prerequisites are read
  }, [lookupsReady, rules, release, mode]);
  // Why Add is grey, in words (owner, 2026-11-19: the button was grey with no reason).
  const addBlockedWhy = busy ? "" : !release ? "Reading the qualification…"
    : choosing ? "Choose how to select the electives."
    : manualMode ? (!changes ? "Tick the electives to add." : removeBlocked.length ? `${removeBlocked[0]}.`
      : needsAttest && !attested ? "Tick the confirmation above: part of the rules could not be checked automatically." : "")
    : !changes ? (check?.complete ? "Nothing new to add: the course already meets every packaging rule." : "Tick the electives to add.")
    : removeBlocked.length ? `${removeBlocked[0]}.`
    : check?.ok === false ? "Packaging rules not followed: see the red line above."
    : check && !check.complete ? "Select units until every packaging rule is met."
    : needsAttest && !attested ? "Tick the confirmation above: part of the rules could not be checked automatically."
    : readingPrereqs || (!autoDone.current && !lookupsReady) ? "Reading the units…"
    : missingPrereqs.length ? (autoError || `Adding the prerequisites: ${missingPrereqs[0].unit} needs ${missingPrereqs[0].needs.join(", ")}…`) : "";

  // A unit cannot be added without its prerequisites (they must be on the course or picked too).
  const prereqBlocked = !manualMode && (missingPrereqs.length > 0 || readingPrereqs);
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
    const found = lookups[unit.code.toUpperCase()];
    if (found === undefined || found === null) return null;
    if ("error" in found) return unit.hasPrerequisites ? <span className="block text-xs text-amber-800">Has prerequisites (could not read them)</span> : null;
    if (!found.prerequisiteCodes.length) return null;
    return <span className="mt-0.5 block text-xs text-foreground-600"><i className="ri-git-merge-line mr-1" aria-hidden="true" />Comes with {found.prerequisiteCodes.map((code, i) =>
      <span key={code} title={prereqName(code, found.prerequisites)}>{i ? ", " : ""}<b>{code}</b>{selected(code) ? " ✓" : ""}</span>)}</span>;
  };
  const row = (unit: TgaUnit) => {
    const on = active(unit.code);
    const was = onCourseNow(unit.code);
    const core = official.get(unit.code.toUpperCase())?.core === true;
    const leaving = was && !on;
    return <div key={unit.code} className={"rounded px-2 py-1.5 text-sm " + (leaving ? "bg-red-50" : on && core ? "opacity-70" : "hover:bg-background-100")}>
      <div className="flex items-start gap-2">
        <label className="flex min-w-0 flex-1 items-start gap-2">
          <input type="checkbox" className="mt-1" disabled={(was && core) || busy} checked={on || chosen.has(unit.code)}
            title={was && !core ? "Untick to take this elective off the course" : undefined}
            onChange={e => was ? toggleOnCourse(unit.code, e.target.checked) : toggle(unit.code, e.target.checked)} />
          <span className="min-w-0 flex-1"><span className="font-semibold text-foreground-950">{unit.code}</span> <span className="text-foreground-800">{unit.name}</span>
            <span className="block text-xs text-foreground-500">{[unit.nominalHours !== null ? `${unit.nominalHours} h` : "",
              unit.groups.length ? unit.groups.map(group => (group === "GEN" ? "General" : `Group ${group}`)).join(", ") : "", leaving ? "will be removed from the course" : on ? "on the course" : ""].filter(Boolean).join(" · ")}</span>
            {leaving && neededBy(unit.code).length ? <span className="block text-xs font-semibold text-red-700">Needed first by {neededBy(unit.code).join(", ")}: it cannot be removed while they stay.</span> : null}
            {prereqLine(unit)}</span>
        </label>
      </div>
    </div>;
  };

  return <Modal open keepOpen={!!stepLabel} title={`${stepLabel ? stepLabel + " · " : ""}Add units · ${course.code}`} width="max-w-4xl" onClose={() => { if (!busy) onClose(); }}
    footer={result ? <div className="flex justify-end gap-2">{nextStep && result.rulesComplete !== false
        ? <Button icon="ri-calendar-event-line" onClick={nextStep.onClick}>{nextStep.label}</Button>
        : <Button onClick={onClose}>Close</Button>}</div>
      : <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-foreground-600">{count} selected{hours ? ` · ${hours} nominal hours` : ""}
          {addBlockedWhy ? <span className="ml-2 font-semibold text-amber-800">{addBlockedWhy}</span> : null}</span>
        <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          {/* Back here from a later step with the units already added: go on without changes. */}
          {nextStep && units.length && !count && !removing.size && !picking && !choosing ? <Button variant="outline" disabled={busy} onClick={nextStep.onClick}>{nextStep.label} (no changes)</Button> : null}
          <Button disabled={busy || choosing || picking || blocked || prereqBlocked} title={prereqBlocked ? "Add the prerequisites of the units you picked first" : undefined} onClick={() => void add()}>{busy ? "Adding… (fetching unit content)" : removing.size ? `Save changes (${count ? `add ${count}, ` : ""}remove ${removing.size})` : `Add ${count} unit${count === 1 ? "" : "s"}${nextStep ? " and continue" : ""}`}</Button></div>
      </div>}>
    {error ? <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {result ? <div className="space-y-1 text-sm text-foreground-800">
      <p className="font-semibold text-green-700">{result.removed ? "Units changed" : "Units added"} on {course.code}.</p>
      <p>{result.added} added, {result.activated} switched back on{result.removed ? `, ${result.removed} removed` : ""}{result.alreadyOn ? `, ${result.alreadyOn} were already on the course` : ""}.</p>
      {result.removed ? <p className="text-amber-800">Removed units keep their content and students' results. If the course has a master timetable, open it and save it so the intakes use the new units.</p> : null}
      <p>Training.gov.au content saved for {result.detailsSynced} units; elements, criteria and evidence for {result.elementsAdded}.</p>
      {result.rulesComplete === false ? <p className="text-amber-700">The electives on the course do not yet meet every packaging rule. Add the remaining units when ready.</p> : null}
      {result.detailsFailed ? <p className="text-amber-700">{result.detailsFailed} units could not be read from training.gov.au; use Sync on the course later.</p> : null}
    </div> : !release && !error ? <p className="text-sm text-foreground-500">Reading {course.code} from Training.gov.au…</p> : release ? <div className="relative space-y-4">
      {choosing ? <div role="dialog" aria-label="How to select the electives" className="absolute inset-0 z-20 flex min-h-[320px] flex-col items-center justify-start gap-4 rounded-lg bg-background-50/95 px-4 pt-12 text-center backdrop-blur-sm">
        <p className="font-heading text-lg font-bold text-foreground-950">How do you want to select the elective units?</p>
        <p className="max-w-md text-sm text-foreground-600">Core units are added either way.{rules?.required ? ` ${release.code} needs ${rules.required} electives.` : ""}</p>
        <div className="grid w-full max-w-xl gap-3 sm:grid-cols-2">
          <button type="button" onClick={() => chooseMode("ai")} className="rounded-lg border-2 border-primary-300 bg-primary-50 p-4 text-left hover:border-primary-500">
            <span className="flex items-center gap-2 font-semibold text-foreground-950"><i className="ri-sparkling-2-line text-primary-600" aria-hidden="true" />Let AI select them</span>
            <span className="mt-1 block text-xs text-foreground-600">The system reads every unit and its prerequisites, then picks electives that meet the packaging rules. You can change them.</span>
          </button>
          <button type="button" onClick={() => chooseMode("manual")} className="rounded-lg border-2 border-background-300 bg-background-50 p-4 text-left hover:border-primary-500">
            <span className="flex items-center gap-2 font-semibold text-foreground-950"><i className="ri-checkbox-multiple-line text-primary-600" aria-hidden="true" />Select them manually</span>
            <span className="mt-1 block text-xs text-foreground-600">Empty boxes: you tick every elective yourself. Nothing is picked or added for you; the packaging rules are checked when you save.</span>
          </button>
        </div>
      </div> : null}
      {picking ? <div role="status" aria-live="polite" className="absolute inset-0 z-20 flex min-h-[320px] flex-col items-center justify-start gap-3 rounded-lg bg-background-50/95 pt-16 text-center backdrop-blur-sm">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-100 text-primary-600"><i className="ri-sparkling-2-line animate-pulse text-3xl" aria-hidden="true" /></span>
        <p className="font-heading text-lg font-bold text-foreground-950">Selecting the units for you…</p>
        <p className="max-w-md text-sm text-foreground-600">Reading every unit and its prerequisites from training.gov.au, then picking electives that meet the packaging rules{rules?.required ? ` (${rules.required} electives)` : ""}. Please wait.</p>
        <div className="h-2 w-64 overflow-hidden rounded-full bg-background-200"><div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${lookupsTotal ? Math.round((lookupsDone / lookupsTotal) * 100) : 5}%` }} /></div>
        <p className="text-xs text-foreground-500">{lookupsDone} of {lookupsTotal} units read</p>
      </div> : null}
      <p className="text-sm text-foreground-600">{release.name} · release {release.releaseNumber}.
        {release.specialisations.length ? ` Specialisations: ${release.specialisations.map(item => `${item.title} ${item.elective}`).join(", ")}.` : ""}</p>

      <section aria-label="Your selection" className={"sticky top-0 z-10 space-y-1.5 rounded-lg border p-3 shadow-sm " + (brokenRules.length ? "border-red-300 bg-red-50" : check?.complete && !missingPrereqs.length ? "border-green-300 bg-green-50" : "border-amber-300 bg-amber-50")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground-950">
            {rules?.required ? `${electiveTotal} of ${rules.required} electives` : `${count} unit${count === 1 ? "" : "s"} picked`}{hours ? ` · ${hours} h` : ""}
            {rules?.outsideMax ? <span className="font-normal text-foreground-600"> · up to {rules.outsideMax} may be from outside this qualification</span> : null}</p>
          {lookupsReady && !manualMode ? <Button size="sm" variant="outline" icon="ri-magic-line" disabled={busy} onClick={() => pickDefaults(true)}>Pick for me</Button> : null}
        </div>
        {!lookupsReady && !autoDone.current ? <p className="text-sm text-foreground-600"><i className="ri-loader-4-line mr-1 animate-spin" aria-hidden="true" />Reading the units and their prerequisites, then picking electives that meet the rules…</p>
          : brokenRules.length ? brokenRules.map(line => <p key={line.label} role="alert" className="text-sm font-semibold text-red-700"><i className="ri-close-circle-line mr-1" aria-hidden="true" />{line.label}: {line.detail}</p>)
          : check?.complete && !missingPrereqs.length ? <p className="text-sm text-green-800"><i className="ri-checkbox-circle-line mr-1" aria-hidden="true" />Meets every packaging rule{check.stream ? ` (${check.stream})` : ""}. Prerequisites are included.</p>
          : <p className="text-sm text-amber-900"><i className="ri-time-line mr-1" aria-hidden="true" />{missingPrereqs.length && !manualMode ? autoError || "Adding the prerequisites…" : pendingRules.map(line => `${line.label}: ${line.detail}`).join(" · ") || "Tick the electives to add."}</p>}
        {autoNote && !brokenRules.length ? <p role="status" className="text-xs text-foreground-700">{autoNote}</p> : null}
        {needsAttest && rules ? <div className="text-sm text-amber-900">
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={attested} disabled={busy} onChange={e => setAttested(e.target.checked)} />
            <span>I have checked the rules the system cannot read (<details className="inline"><summary className="inline cursor-pointer underline">show them</summary><ul className="ml-4 list-disc text-xs">{rules.unchecked.map(line => <li key={line}>{line}</li>)}</ul></details>).</span></label>
        </div> : null}
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Electives ({release.electives.length})</h4>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter electives" aria-label="Filter electives" className="w-56 rounded-lg border border-background-300 bg-background-50 px-2 py-1 text-sm" />
        </div>
        <div className="max-h-[45vh] overflow-auto rounded-lg border border-background-200 p-1">{electives.length ? [...electives].sort((x, y) => Number(selected(y.code)) - Number(selected(x.code))).map(row) : <p className="p-2 text-sm text-foreground-500">No matching electives.</p>}</div>
      </section>

      <details>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-foreground-500">Core units ({release.core.length}, all required: added automatically)</summary>
        <ul className="mt-2 divide-y divide-background-200 rounded-lg border border-background-200">{release.core.map(unit => <li key={unit.code} className="px-3 py-1.5 text-sm">
          <span className="font-semibold text-foreground-950">{unit.code}</span> <span className="text-foreground-800">{unit.name}</span>
          <span className="block text-xs text-foreground-500">{[unit.nominalHours !== null ? `${unit.nominalHours} h` : "", onCourseNow(unit.code) ? "Required · on the course" : "Required · added with the units"].filter(Boolean).join(" · ")}</span>
          {prereqLine(unit)}</li>)}</ul>
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
