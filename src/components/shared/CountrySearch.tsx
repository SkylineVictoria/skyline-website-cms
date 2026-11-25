import { useEffect, useRef, useState } from "react";
import { searchCountries, type CountryRow } from "@/lib/countrySearch";
import { FieldError, WIZARD_INPUT, WizardLabel } from "@/components/shared/wizard/fields";

/**
 * Searchable country combobox over avetmiss_code_search (owner, 2026-11-25): type a few letters, pick a country; the AVETMISS
 * label is the value (the database turns it into the SACC code). Used for country of birth in the wizard and the full form.
 */
export default function CountrySearch({ id, name, label, value, error, onChange, disabled, required, className = WIZARD_INPUT }: {
  id: string;
  /** Name of the visible box (the wizard); leave out when a hidden input carries the value (the full form). */
  name?: string;
  /** Shown above the box; leave out when the page draws its own label for `id`. */
  label?: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CountryRow[]>([]);
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

  const choose = (row: CountryRow) => { onChange(row.label); setQuery(row.label); setOpen(false); };
  const listId = `${id}-list`;

  return (
    <div className="relative">
      {label ? <WizardLabel htmlFor={id} required={required ?? true}>{label}</WizardLabel> : null}
      <input id={id} name={name} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-invalid={Boolean(error)}
        autoComplete="off" className={className} placeholder="Type to search countries" value={query} disabled={disabled}
        onFocus={() => setOpen(true)}
        // The typed text is a search, not an answer: it does not reach a form's change handler.
        onChange={(e) => { e.stopPropagation(); setQuery(e.target.value); setOpen(true); if (value) onChange(""); }}
        onBlur={() => window.setTimeout(() => { setOpen(false); setQuery((q) => (q === value ? q : value)); }, 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, rows.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && open && rows[active]) { e.preventDefault(); choose(rows[active]); }
          else if (e.key === "Escape") { setOpen(false); setQuery(value); }
        }} />
      {open && !disabled ? (
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
      {error ? <FieldError text={error} /> : null}
    </div>
  );
}

/**
 * The country search inside an uncontrolled form (the full application form): a hidden input named `name` holds the value, so the
 * form's save, required check and restore (applyFormValues, which fires input / change) work as with any field. A pick writes the
 * hidden input and fires input / change so the form saves it; `onPicked` lets the page treat it as the user's own edit.
 */
export function FormCountrySearch({ id, name, defaultValue = "", required, locked, className, onPicked }: {
  id: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  locked?: boolean;
  className?: string;
  onPicked?: (value: string) => void;
}) {
  const hidden = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);
  // Values written into the form from outside (restore, a passport read) show in the box.
  useEffect(() => {
    const input = hidden.current;
    if (!input) return undefined;
    const sync = () => setValue(input.value);
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    return () => { input.removeEventListener("input", sync); input.removeEventListener("change", sync); };
  }, []);
  const pick = (next: string) => {
    const input = hidden.current;
    setValue(next);
    if (!input) return;
    input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    onPicked?.(next);
  };
  return (
    <>
      {/* type="text" + hidden (not readOnly) keeps the required check (checkValidity) working, which type="hidden" and readOnly inputs skip. */}
      <input ref={hidden} type="text" hidden tabIndex={-1} aria-hidden="true" name={name} defaultValue={defaultValue} required={required && !locked} data-country-search={id} />
      <CountrySearch id={id} value={value} onChange={pick} disabled={locked} className={className} />
    </>
  );
}
