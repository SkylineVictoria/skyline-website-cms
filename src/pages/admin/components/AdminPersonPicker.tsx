import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TextInput } from "@/pages/admin/components/ui";

/** A person the form can offer (the registered migration agents found for the business). */
export interface PersonSuggestion { fullName: string; email: string; phone: string; marn?: string; note?: string }

/**
 * Full name as a searchable box (owner 2026-11-24): typing lists the people found above (name, email, phone); picking one fills all three.
 * The last option adds the typed name as a new person (the email and phone are then typed below).
 */
export default function AdminPersonPicker({ value, onName, suggestions, onPick, onAddNew, disabled, invalid, id }: {
  value: string; onName: (name: string) => void; suggestions: PersonSuggestion[];
  onPick: (person: PersonSuggestion) => void; onAddNew: (name: string) => void;
  disabled?: boolean; invalid?: boolean; id?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const closeTimer = useRef<number | undefined>(undefined);
  // The list floats on <body> under the box (fixed position), so no card or scroll area can hide it.
  const boxRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => { const r = boxRef.current?.getBoundingClientRect(); if (r) setRect({ left: r.left, top: r.bottom + 4, width: r.width }); };
    place();
    window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);
  const q = value.trim().toLowerCase();
  const matches = useMemo(() => {
    const words = q.split(/\s+/).filter(Boolean);
    return suggestions.filter(s => !words.length || words.every(w => `${s.fullName} ${s.email}`.toLowerCase().includes(w))).slice(0, 8);
  }, [q, suggestions]);
  const exact = suggestions.some(s => s.fullName.trim().toLowerCase() === q);
  const options: Array<{ kind: "person"; person: PersonSuggestion } | { kind: "new" }> = [
    ...matches.map(person => ({ kind: "person" as const, person })),
    ...(q && !exact ? [{ kind: "new" as const }] : []),
  ];
  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    setOpen(false);
    if (o.kind === "person") onPick(o.person); else onAddNew(value.trim());
  };
  return (
    <div className="relative" ref={boxRef}>
      <TextInput id={id} disabled={disabled} required autoComplete="off" value={value} aria-invalid={invalid}
        role="combobox" aria-expanded={open && options.length > 0} aria-controls={listId} aria-autocomplete="list"
        placeholder={suggestions.length ? "Search the agents found above, or type a new name" : "First and last name"}
        onChange={e => { onName(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => { window.clearTimeout(closeTimer.current); setOpen(true); }}
        onBlur={() => { closeTimer.current = window.setTimeout(() => setOpen(false), 150); }}
        onKeyDown={e => {
          if (!open || !options.length) { if (e.key === "ArrowDown") { setOpen(true); e.preventDefault(); } return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(options.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); choose(active); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && options.length && rect ? createPortal(
        <ul id={listId} role="listbox" style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width }}
          className="z-[85] max-h-72 overflow-y-auto rounded-lg border border-background-200 bg-white py-1 shadow-lg" data-testid="admin-person-options">
          {options.map((o, i) => (
            <li key={o.kind === "person" ? `${o.person.marn ?? ""}${o.person.fullName}${o.person.email}` : "new"} role="option" aria-selected={i === active}
              className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-primary-50" : "hover:bg-background-100"}`}
              onMouseDown={e => { e.preventDefault(); choose(i); }} onMouseEnter={() => setActive(i)}>
              {o.kind === "person" ? <>
                <p className="font-semibold text-foreground-900">{o.person.fullName}{o.person.marn ? <span className="font-normal text-foreground-500"> · MARN {o.person.marn}</span> : null}</p>
                <p className="truncate text-xs text-foreground-600">{[o.person.email, o.person.phone].filter(Boolean).join(" · ") || "No email or phone on record"}{o.person.note ? ` · ${o.person.note}` : ""}</p>
              </> : <p className="font-semibold text-primary-700"><i className="ri-user-add-line mr-1" aria-hidden="true" />Add &ldquo;{value.trim()}&rdquo; as a new person</p>}
            </li>
          ))}
        </ul>, document.body
      ) : null}
    </div>
  );
}
