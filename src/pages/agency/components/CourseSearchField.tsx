import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Props {
  /** Checkbox group name without "[]"; the selection is still saved as the form's checkbox values. */
  name: string;
  /** Every active course, as "CODE - Title" labels. */
  options: string[];
  disabled?: boolean;
  /** Only one course may be chosen: picking another replaces it. */
  single?: boolean;
  /** Labels saved on an old draft that are no longer offered: shown as selected with a hint, never offered in the search. */
  legacy?: string[];
  /** Shown instead of the search box when there is nothing to choose from. */
  emptyMessage?: string;
}

/**
 * Searchable course picker. The real inputs stay hidden checkboxes (one per course), so saving, restoring a draft and
 * the required-field check keep working unchanged; this only replaces the long tick list with a search box and chips.
 */
export default function CourseSearchField({ name, options, disabled, single, legacy = [], emptyMessage = "No active courses are available" }: Props) {
  const current = useMemo(() => options.filter((option) => !legacy.includes(option)), [options, legacy]);
  const boxRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const boxes = useCallback(() => Array.from(boxRef.current?.querySelectorAll<HTMLInputElement>(`input[name="${name}[]"]`) ?? []), [name]);
  const readSelection = useCallback(() => setSelected(boxes().filter((box) => box.checked).map((box) => box.value)), [boxes]);

  // Follow changes made outside this component too (a restored draft writes the checkboxes directly).
  useEffect(() => {
    readSelection();
    const root = boxRef.current;
    if (!root) return undefined;
    root.addEventListener("change", readSelection);
    return () => root.removeEventListener("change", readSelection);
  }, [readSelection, options]);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const setChecked = (value: string, checked: boolean) => {
    const box = boxes().find((item) => item.value === value);
    if (!box || box.checked === checked) return;
    box.checked = checked;
    // Bubbles to the form, which saves the draft and updates progress.
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return current.filter((option) => !selected.includes(option) && words.every((word) => option.toLowerCase().includes(word))).slice(0, 12);
  }, [current, query, selected]);

  const choose = (option: string) => {
    if (single) for (const box of boxes()) if (box.checked && box.value !== option) setChecked(box.value, false);
    setChecked(option, true);
    setQuery("");
    setActive(0);
    setOpen(false);
  };

  return (
    <div
      ref={boxRef}
      className="relative"
      // Close when focus leaves the picker (Tab away, a save or sync moving focus), not only on an outside click.
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    >
      {selected.length ? (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Selected courses">
          {selected.map((option) => (
            <li key={option} data-testid={legacy.includes(option) ? "course-chip-legacy" : "course-chip"} className={`inline-flex max-w-full items-center gap-1.5 rounded-full border py-1 pl-3 pr-1 text-xs font-medium ${legacy.includes(option) ? "border-amber-300 bg-amber-50 text-amber-900" : "border-primary-200 bg-primary-50 text-primary-900"}`}>
              <span className="truncate">{option}</span>
              {legacy.includes(option) ? <span className="shrink-0 text-2xs font-normal">· no longer offered, choose a current course</span> : null}
              {disabled ? null : (
                <button
                  type="button"
                  onClick={() => setChecked(option, false)}
                  aria-label={`Remove ${option}`}
                  className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-primary-700 hover:bg-primary-100"
                >
                  <i className="ri-close-line" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {disabled ? null : (
        <div className="relative">
          <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
          <input
            type="text"
            // No name: the search text itself is never saved.
            autoComplete="off"
            value={query}
            placeholder={!current.length ? emptyMessage : single && selected.length ? "Search to change the course" : "Search courses by code or name, e.g. BSB50120 or Diploma of Business"}
            disabled={!current.length}
            data-testid={`${name}-search`}
            role="combobox"
            aria-expanded={open && matches.length > 0}
            aria-controls={`${name}-results`}
            aria-autocomplete="list"
            onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
            // Open only on a deliberate click, typing or arrow key: focus alone (restored by the browser when the
            // window regains focus, or during a save/sync re-render) must not pop the list open.
            onClick={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((i) => Math.min(matches.length - 1, i + 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              else if (event.key === "Enter") { event.preventDefault(); if (open && matches[active]) choose(matches[active]); }
              else if (event.key === "Escape") setOpen(false);
            }}
            className="w-full rounded-md border border-background-300 bg-background-50 py-2.5 pl-9 pr-3 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40"
          />
          {open && matches.length > 0 ? (
            <ul id={`${name}-results`} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-background-200 bg-background-50 py-1 shadow-lg">
              {matches.map((option, index) => (
                <li key={option} role="option" aria-selected={index === active}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${index === active ? "bg-primary-50" : "hover:bg-background-100"}`}
                  >
                    <i className="ri-book-open-line mt-0.5 text-primary-600" aria-hidden="true" />
                    <span>{option}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {open && query.trim() && !matches.length ? (
            <p className="mt-1 text-xs text-foreground-500">No active course matches “{query.trim()}”.</p>
          ) : null}
          {!current.length ? <p className="mt-1 text-xs text-primary-700" role="alert" data-testid={`${name}-empty`}>{emptyMessage}</p> : null}
        </div>
      )}

      {/* The values the form saves: one checkbox per active course. */}
      <div hidden>
        {options.map((option) => (
          <input key={option} type="checkbox" name={`${name}[]`} value={option} disabled={disabled} tabIndex={-1} aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}
