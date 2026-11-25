import { useEffect, useRef, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { BORN_IN_PASSPORT_COUNTRY, PASSPORT_COUNTRY_LABEL, pickPassportCountry, type CountryRow as CodeRow } from "@/pages/agency/lib/birthCountry";
import { FieldError, WIZARD_INPUT as INPUT, WIZARD_LABEL as LABEL, WizardLabel as Label } from "@/components/shared/wizard/fields";

/** Countries from avetmiss_codes 'country' matching the text (avetmiss_code_search), without "Not stated". */
async function searchCountries(query: string, limit = 20): Promise<CodeRow[]> {
  const { data, error } = await supabase.rpc("avetmiss_code_search", { p_set: "country", p_query: query, p_limit: limit });
  if (error) throw new Error(error.message);
  return ((data ?? []) as CodeRow[]).filter((row) => row.code !== "@@@@");
}

async function resolvePassportCountry(scanned: string): Promise<string> {
  return scanned.trim() ? pickPassportCountry(scanned, await searchCountries(scanned.trim(), 5)) : "";
}

/**
 * Country of birth on the wizard's Personal details screen (owner, 2026-11-25). When the passport scan gave the issuing country,
 * a required "Were you born in {country}?" question: Yes stores that country's AVETMISS label as birth_country, No shows the
 * searchable country picker (avetmiss_code_search), starting empty. Without a passport country, only the picker.
 */
export default function BirthCountryField({ passportCountry, answers, errors, onChange }: {
  /** The issuing country read from the passport, as scanned. */
  passportCountry: string;
  answers: Record<string, string>;
  errors: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  const label = answers[PASSPORT_COUNTRY_LABEL] ?? "";
  const born = answers[BORN_IN_PASSPORT_COUNTRY] ?? "";
  const value = answers.birth_country ?? "";
  const [resolving, setResolving] = useState(Boolean(passportCountry.trim()));

  useEffect(() => {
    let active = true;
    if (!passportCountry.trim()) { setResolving(false); if (label) onChange(PASSPORT_COUNTRY_LABEL, ""); return; }
    setResolving(true);
    resolvePassportCountry(passportCountry)
      .then((resolved) => { if (active && resolved !== label) onChange(PASSPORT_COUNTRY_LABEL, resolved); })
      .catch(() => { if (active && label) onChange(PASSPORT_COUNTRY_LABEL, ""); })
      .finally(() => { if (active) setResolving(false); });
    return () => { active = false; };
    // Resolved once per passport country.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passportCountry]);

  // A saved country of birth answers the question again when the screen is reopened.
  useEffect(() => {
    if (!label || born || !value) return;
    onChange(BORN_IN_PASSPORT_COUNTRY, value === label ? "Yes" : "No");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, value]);

  if (resolving) return <p className="text-sm text-foreground-600 sm:col-span-2">Checking the passport country…</p>;

  const pick = (answer: "Yes" | "No") => {
    onChange(BORN_IN_PASSPORT_COUNTRY, answer);
    // Yes: the passport country exactly as AVETMISS names it. No: start empty (never the passport country by default).
    if (answer === "Yes") onChange("birth_country", label);
    else if (value === label) onChange("birth_country", "");
  };

  return (
    <div className="space-y-4 sm:col-span-2">
      {label ? (
        <fieldset data-testid="wizard-born-in-passport-country">
          <legend className={LABEL}>Were you born in {label}? <span className="text-primary-600">*</span></legend>
          <div className="flex gap-5 text-sm">
            {(["Yes", "No"] as const).map((option) => (
              <label key={option} className="flex items-start gap-2">
                <input type="radio" name={BORN_IN_PASSPORT_COUNTRY} value={option} checked={born === option} onChange={() => pick(option)} className="mt-0.5" /> {option}
              </label>
            ))}
          </div>
          <FieldError text={errors[BORN_IN_PASSPORT_COUNTRY]} />
        </fieldset>
      ) : null}
      {!label || born === "No" ? (
        <CountrySearch id="wizard-birth_country" label="Country of birth" value={value} error={errors.birth_country} onChange={(next) => onChange("birth_country", next)} />
      ) : null}
    </div>
  );
}

/** Searchable country combobox over avetmiss_code_search; stores the chosen label. */
function CountrySearch({ id, label, value, error, onChange }: { id: string; label: string; value: string; error?: string; onChange: (value: string) => void }) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CodeRow[]>([]);
  const [active, setActive] = useState(0);
  const [loadError, setLoadError] = useState("");
  const seq = useRef(0);

  useEffect(() => { if (!open) setQuery(value); }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const ticket = ++seq.current;
    const timer = window.setTimeout(() => {
      searchCountries(query === value ? "" : query)
        .then((found) => { if (ticket === seq.current) { setRows(found); setActive(0); setLoadError(""); } })
        .catch((e: unknown) => { if (ticket === seq.current) { setRows([]); setLoadError(e instanceof Error ? e.message : "The country list did not load."); } });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, open, value]);

  const choose = (row: CodeRow) => { onChange(row.label); setQuery(row.label); setOpen(false); };
  const listId = `${id}-list`;

  return (
    <div className="relative">
      <Label htmlFor={id}>{label}</Label>
      <input id={id} name="birth_country" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-invalid={Boolean(error)}
        autoComplete="off" className={INPUT} placeholder="Type to search countries" value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); if (value) onChange(""); }}
        onBlur={() => window.setTimeout(() => { setOpen(false); setQuery((q) => (q === value ? q : value)); }, 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, rows.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && open && rows[active]) { e.preventDefault(); choose(rows[active]); }
          else if (e.key === "Escape") { setOpen(false); setQuery(value); }
        }} />
      {open ? (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-background-300 bg-background-50 py-1 text-sm shadow-lg">
          {loadError ? <li className="px-3 py-2 text-red-700">{loadError}</li>
            : rows.length ? rows.map((row, index) => (
              <li key={row.code} role="option" aria-selected={row.label === value}
                className={`cursor-pointer px-3 py-2 ${index === active ? "bg-primary-50" : ""} ${row.label === value ? "font-medium" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); choose(row); }} onMouseEnter={() => setActive(index)}>
                {row.label}
              </li>
            )) : <li className="px-3 py-2 text-foreground-600">No countries match</li>}
        </ul>
      ) : null}
      <FieldError text={error} />
    </div>
  );
}
