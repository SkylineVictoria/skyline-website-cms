import { avetmissOptions, type AvetmissCodes } from "@/lib/avetmissCodes";

import { type PriorEducationRow } from "./avetmissValues";

/** AVETMISS-UI (2026-11-25): the disability types and prior education inputs (values in ./avetmissValues). */
const BOX = "w-full rounded-md border border-background-300 bg-background-50 px-2.5 py-1.5 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none";

export function DisabilityTypesInput({ codes, value, onChange, idPrefix = "avetmiss-disability" }: {
  codes: AvetmissCodes; value: string[]; onChange: (next: string[]) => void; idPrefix?: string;
}) {
  const options = avetmissOptions(codes, "disability_type");
  if (!options.length) return <p className="text-xs text-foreground-500">Loading the disability types…</p>;
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" data-testid="avetmiss-disability-types">
      {options.map((o) => (
        <label key={o.code} htmlFor={`${idPrefix}-${o.code}`} className="flex items-start gap-2 text-sm text-foreground-800">
          <input id={`${idPrefix}-${o.code}`} type="checkbox" className="mt-0.5 h-4 w-4 accent-primary-500" checked={value.includes(o.code)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.code] : value.filter((c) => c !== o.code))} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function PriorEducationInput({ codes, rows, onChange }: { codes: AvetmissCodes; rows: PriorEducationRow[]; onChange: (next: PriorEducationRow[]) => void }) {
  const set = (i: number, patch: Partial<PriorEducationRow>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2" data-testid="avetmiss-prior-education">
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 rounded-md border border-background-200 p-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <select aria-label="Qualification level" className={BOX} value={row.code} onChange={(e) => set(i, { code: e.target.value })}>
            <option value="">Level</option>
            {avetmissOptions(codes, "prior_education", row.code).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
          <select aria-label="Where it was completed" className={BOX} value={row.recognition} onChange={(e) => set(i, { recognition: e.target.value })}>
            <option value="">Completed in</option>
            {avetmissOptions(codes, "prior_education_recognition", row.recognition).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
          <input aria-label="Qualification name" className={BOX} maxLength={200} placeholder="Qualification name (optional)" value={row.name} onChange={(e) => set(i, { name: e.target.value })} />
          <button type="button" className="cursor-pointer rounded-md px-2 text-sm text-foreground-600 hover:bg-background-100 hover:text-red-700" aria-label="Remove this qualification"
            onClick={() => onChange(rows.filter((_, n) => n !== i))}><i className="ri-delete-bin-line" aria-hidden="true" /></button>
        </div>
      ))}
      <button type="button" className="cursor-pointer text-sm font-semibold text-primary-700 hover:underline" onClick={() => onChange([...rows, { code: "", recognition: "", name: "" }])}
        data-testid="avetmiss-prior-education-add"><i className="ri-add-line" aria-hidden="true" /> Add a qualification</button>
    </div>
  );
}
