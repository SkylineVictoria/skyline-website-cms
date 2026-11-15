import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import type { RtoUnit } from "@/pages/admin/lib/rto";

interface Qualification {
  code: string;
  name: string;
  status: string;
}

interface Unit {
  code: string;
  name: string;
  groups: string[];
  nominalHours: number | null;
  hoursSource: string | null;
}

interface Review extends Qualification {
  aqf: string;
  description: string;
  entryRequirements: string;
  packagingRules: string;
  packageCode: string;
  packageName: string;
  releaseNumber: string;
  releaseDate: string;
  core: Unit[];
  electives: Unit[];
  groups: Record<string, string>;
  minimumGroup: { group: string; count: number } | null;
  requiredElectives: number | null;
  canValidate: boolean;
  requiresElectiveAttestation: boolean;
  revision: string;
}

const actionClass = "rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50";
const secondaryClass = "rounded-lg border border-background-300 px-4 py-2.5 text-sm font-semibold disabled:opacity-50";

async function request<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("tga-course-import", { body });
  if (error) {
    const detail = error.context instanceof Response
      ? await error.context.json().catch(() => null) : null;
    throw new Error(typeof detail?.error === "string" ? detail.error : "Could not contact the Training.gov.au import service.");
  }
  return data as T;
}

export default function TrainingGovCourseImport({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: (courseId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Qualification[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function run(label: string, action: () => Promise<void>) {
    setError("");
    setBusy(label);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Course import failed.");
    } finally {
      setBusy("");
    }
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setResults(null);
    void run("Searching Training.gov.au…", async () => {
      setResults(await request<Qualification[]>({ action: "search", query }));
    });
  }

  function open(code: string) {
    void run("Loading qualification details…", async () => {
      setReview(await request<Review>({ action: "details", code }));
      setSelectedCodes([]);
      setAttested(false);
    });
  }

  const chosenUnits = review ? [...review.core, ...review.electives.filter(unit => selectedCodes.includes(unit.code))] : [];
  const knownHours = chosenUnits.filter(unit => unit.nominalHours !== null);
  const hoursTotal = knownHours.reduce((sum, unit) => sum + (unit.nominalHours ?? 0), 0);
  const minimum = review?.minimumGroup;
  const groupSelected = minimum ? review.electives.filter(unit =>
    unit.groups.includes(minimum.group) && selectedCodes.includes(unit.code)).length : 0;
  const canSave = !review ? false : review.canValidate
    ? selectedCodes.length === review.requiredElectives && (!minimum || groupSelected >= minimum.count) && (!review.requiresElectiveAttestation || attested)
    // Rules not checked automatically: the user confirms them; electives must be chosen when the release lists any.
    : attested && (!review.electives.length || selectedCodes.length > 0);

  function save() {
    if (!review || !canSave || busy) return;
    void run("Saving course…", async () => {
      const result = await request<{ courseId: string }>({
        action: "save", code: review.code, revision: review.revision, electives: selectedCodes, attested,
      });
      onSaved(result.courseId);
    });
  }

  return <section className="space-y-5 rounded-2xl border border-background-200 bg-background-50 p-4 shadow-sm sm:p-5"
    aria-labelledby="import-qualification-heading">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="import-qualification-heading" className="font-heading text-xl font-bold">Import from Training.gov.au</h2>
      <button type="button" className={secondaryClass} onClick={onClose} disabled={Boolean(busy)}>Close</button>
    </div>
    {busy && <p role="status" className="text-sm text-foreground-600">{busy}</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {!review ? <>
      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 basis-56 text-sm font-medium">
          Qualification code or name
          <input value={query} autoFocus maxLength={120} disabled={Boolean(busy)}
            onChange={event => { setQuery(event.target.value); setResults(null); setError(""); }}
            placeholder="e.g. BSB50120 or Diploma of Business"
            className="mt-1 block w-full rounded-lg border border-background-300 bg-transparent p-2.5" />
        </label>
        <button type="submit" className={actionClass} disabled={Boolean(busy) || query.trim().length < 2}>Search</button>
      </form>
      {results && <div className="max-h-80 space-y-2 overflow-auto" aria-label="Search results">
        {results.length === 0 && <p className="text-sm text-foreground-600">No qualifications matched your search.</p>}
        {results.map(item => <button type="button" key={item.code} disabled={Boolean(busy)}
          onClick={() => open(item.code)} className="block w-full rounded-lg border border-background-200 p-3 text-left hover:border-primary-500 disabled:opacity-50">
          <strong>{item.code}</strong> {item.name}
          {item.status && <span className="ml-2 text-xs text-foreground-600">{item.status}</span>}
        </button>)}
      </div>}
    </> : <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-heading text-lg font-bold">{review.code} {review.name}</h3>
        <a href={`https://training.gov.au/training/details/${encodeURIComponent(review.code)}`} target="_blank" rel="noreferrer"
          className="text-sm text-primary-700 underline">View on Training.gov.au</a>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {Object.entries({
          "AQF level": review.aqf, "Training package": [review.packageCode, review.packageName].filter(Boolean).join(" · "),
          "National status": review.status, "Release": [review.releaseNumber, review.releaseDate].filter(Boolean).join(" · "),
          "Description": review.description, "Entry requirements": review.entryRequirements,
        }).filter(([, value]) => value).map(([label, value]) =>
          <div key={label}><dt className="font-semibold">{label}</dt><dd className="whitespace-pre-line text-foreground-700">{value}</dd></div>)}
      </dl>
      <details className="rounded-lg border border-background-200 p-3">
        <summary className="cursor-pointer text-sm font-semibold">Official packaging rules</summary>
        <p className="mt-2 max-h-72 overflow-auto whitespace-pre-line text-sm">{review.packagingRules}</p>
      </details>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-background-200 p-3">
          <h4 className="mb-2 text-sm font-semibold">Core units ({review.core.length})</h4>
          <ul className="space-y-2 text-sm">
            {review.core.map(unit => <li key={unit.code}><strong>{unit.code}</strong> {unit.name} <span className="text-foreground-600">· {unit.nominalHours === null ? "Hours unavailable" : `${unit.nominalHours} nominal hrs (NCVER)`}</span></li>)}
          </ul>
        </div>
        <fieldset disabled={Boolean(busy)} className="min-w-0 rounded-lg border border-background-200 p-3">
          <legend className="px-1 text-sm font-semibold">Electives ({selectedCodes.length}{review.requiredElectives !== null ? ` of ${review.requiredElectives}` : ""})</legend>
          {minimum && <p className="mb-2 text-sm text-foreground-700">Group {minimum.group} · {groupSelected} selected, {minimum.count} required</p>}
          <div className="max-h-80 space-y-1 overflow-auto">
            {review.electives.map(unit => <label key={unit.code} className="flex gap-2 rounded p-2 text-sm hover:bg-background-100">
              <input type="checkbox" className="mt-1 shrink-0 self-start" checked={selectedCodes.includes(unit.code)}
                disabled={review.canValidate && review.requiredElectives !== null && !selectedCodes.includes(unit.code) && selectedCodes.length >= review.requiredElectives}
                onChange={event => {
                  setAttested(false);
                  setSelectedCodes(previous => event.target.checked ? [...previous, unit.code] : previous.filter(code => code !== unit.code));
                }} />
              <span><strong>{unit.code}</strong> {unit.name} <span className="text-foreground-600">· {unit.nominalHours === null ? "Hours unavailable" : `${unit.nominalHours} nominal hrs (NCVER)`}</span>
                {unit.groups.length > 0 && <span className="mt-0.5 block text-xs text-foreground-600">
                  {unit.groups.map(group => `${group} · ${review.groups[group]}`).join(" / ")}
                </span>}
              </span>
            </label>)}
          </div>
        </fieldset>
      </div>
      {review.requiredElectives !== null && <p role="status" className="text-sm font-semibold" aria-live="polite">
        Electives selected: {selectedCodes.length} / {review.requiredElectives}
        {selectedCodes.length !== review.requiredElectives && (review.canValidate
          ? ` — select exactly ${review.requiredElectives} electives to save.`
          : ` — the first rule lists ${review.requiredElectives}; follow the packaging rules for your specialisation.`)}
      </p>}
      <p className="text-sm" role="status">Known nominal hours: <strong>{hoursTotal} hrs</strong> across {knownHours.length} of {chosenUnits.length} selected units{knownHours.length !== chosenUnits.length ? " (partial total; missing hours are not counted)" : ""}. Source: NCVER national reporting dataset; confirm Victorian funded hours separately.</p>
      {!review.canValidate && <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        <p role="status">This release’s packaging rules (for example specialisations or group minimums) can’t be checked automatically. Check your elective choice against the packaging rules above, then confirm to save.</p>
        <label className="flex gap-2">
          <input type="checkbox" checked={attested} disabled={Boolean(busy)} onChange={event => setAttested(event.target.checked)} />
          <span>I have checked the core and selected elective units against the official packaging rules for this qualification (including any specialisation).</span>
        </label>
      </div>}
      {review.canValidate && review.requiresElectiveAttestation && <label className="flex gap-2 text-sm">
        <input type="checkbox" checked={attested} disabled={Boolean(busy)} onChange={event => setAttested(event.target.checked)} />
        <span>I confirm the selected electives meet the relevance, AQF alignment and vocational outcome requirements in the packaging rules.</span>
      </label>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={secondaryClass} disabled={Boolean(busy)} onClick={() => { setReview(null); setError(""); }}>Back to results</button>
        <button type="button" className={actionClass} disabled={!canSave || Boolean(busy)} onClick={save}>Save Course</button>
      </div>
    </>}
  </section>;
}


interface SavedDetails {
  tga_training_package_code: string | null;
  tga_national_status: string | null;
  tga_release_number: string;
  tga_release_date: string | null;
  tga_packaging_rules: string | null;
  full_description: string;
  entry_requirements: string;
}

export function SavedTrainingGovDetails({ courseId, units }: { courseId: string; units: RtoUnit[] }) {
  const [details, setDetails] = useState<SavedDetails | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void supabase.from("cms_courses")
      .select("tga_training_package_code,tga_national_status,tga_release_number,tga_release_date,tga_packaging_rules,full_description,entry_requirements")
      .eq("id", courseId).not("tga_release_number", "is", null)
      .abortSignal(controller.signal).maybeSingle<SavedDetails>()
      .then(({ data, error }) => {
        if (!controller.signal.aborted && !error) setDetails(data);
      });
    return () => controller.abort();
  }, [courseId]);

  if (!details) return null;
  return <details className="mt-5 rounded-lg border border-background-200 p-3 text-sm">
    <summary className="cursor-pointer font-semibold">Training.gov.au release and imported units</summary>
    <dl className="mt-3 grid gap-2 sm:grid-cols-2">
      {Object.entries({
        "Package code": details.tga_training_package_code, "National status": details.tga_national_status,
        "Release": details.tga_release_number, "Release date": details.tga_release_date,
        "Description": details.full_description, "Entry requirements": details.entry_requirements,
      }).filter(([, value]) => value).map(([label, value]) =>
        <div key={label}><dt className="font-semibold">{label}</dt><dd className="whitespace-pre-line">{value}</dd></div>)}
    </dl>
    <ul className="my-3 space-y-1">
      {units.map(unit => <li key={unit.id ?? unit.code}>
        <strong>{unit.code}</strong> {unit.name} · {unit.unitType === "core" ? "Core" : "Elective"}
      </li>)}
    </ul>
    {details.tga_packaging_rules && <details>
      <summary className="cursor-pointer font-semibold">Official packaging rules</summary>
      <p className="mt-2 max-h-72 overflow-auto whitespace-pre-line">{details.tga_packaging_rules}</p>
    </details>}
  </details>;
}
