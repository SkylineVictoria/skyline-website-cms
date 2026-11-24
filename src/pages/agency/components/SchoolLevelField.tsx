import { useEffect, useLayoutEffect, useRef } from "react";
import type { AppField } from "@/data/applicationForms";
import { DEGREE_LEVELS, schoolLevelFor } from "@/pages/agency/lib/educationLevels";
import SearchableSelect from "@/components/ui/SearchableSelect";


/**
 * "Highest completed school level" with Bachelor's, Master's and PhD added. The choice is saved as highest_education;
 * the reported school_level (the only values submission accepts) is kept in a hidden input that follows it.
 */
export default function SchoolLevelField({ field, id, choice, schoolLevel, locked }: {
  field: AppField;
  id: string;
  choice: string;
  schoolLevel: string;
  locked: boolean;
}) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  // The saved level is written once. Given as defaultValue, React would put it back on every re-render (a hidden
  // input's value is its default value), wiping the level this field sets and leaving the required answer blank.
  const savedLevel = useRef(schoolLevel);
  useLayoutEffect(() => { if (hiddenRef.current) hiddenRef.current.value = savedLevel.current; }, []);

  const sync = () => {
    const select = selectRef.current;
    const hidden = hiddenRef.current;
    if (!select || !hidden || !select.value) return;
    const next = schoolLevelFor(select.value);
    if (hidden.value === next) return;
    hidden.value = next;
    hidden.dispatchEvent(new Event("input", { bubbles: true }));
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
  };

  useEffect(() => {
    const hidden = hiddenRef.current;
    const select = selectRef.current;
    if (!hidden || !select) return undefined;
    // A school level written straight into the hidden input (restored draft) shows in the dropdown when no degree is
    // chosen; with a degree chosen, the hidden level stays "Year 12 or equivalent".
    const follow = () => {
      if (DEGREE_LEVELS.includes(select.value)) { sync(); return; }
      if (select.value !== hidden.value) select.value = hidden.value;
    };
    // Native listeners as well as React's: values applied from documents (even to a locked, disabled dropdown) and
    // drafts saved before the two were kept together must still fill the required school level.
    select.addEventListener("input", sync);
    select.addEventListener("change", sync);
    hidden.addEventListener("input", follow);
    sync();
    return () => {
      select.removeEventListener("input", sync);
      select.removeEventListener("change", sync);
      hidden.removeEventListener("input", follow);
    };
  }, []);

  return (
    <>
      <SearchableSelect
        ref={selectRef}
        id={id}
        name="highest_education"
        disabled={locked}
        defaultValue={choice || schoolLevel}
        className={`w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40${locked ? " bg-background-100 text-foreground-600" : ""}`}
      >
        <option value="" disabled>{field.placeholder ?? "Select"}</option>
        <optgroup label="University">
          {DEGREE_LEVELS.map((option) => <option key={option} value={option}>{option}</option>)}
        </optgroup>
        <optgroup label="School">
          {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
        </optgroup>
      </SearchableSelect>
      <input ref={hiddenRef} type="hidden" name={field.name} />
    </>
  );
}
