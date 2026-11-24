/**
 * UI-SELECT (owner, 2026-11-24): the one dropdown of the app, used instead of the browser's own <select>.
 *
 * It is a drop-in for <select>: the same props and the same <option> / <optgroup> children. The real <select> stays in the page,
 * invisible, holding the options and the value, so everything that worked with a <select> keeps working: onChange handlers read
 * e.target.value (and e.target.selectedOptions for `multiple`), forms read it through FormData / `name`, `required` is checked by the
 * browser, refs reach the <select>, and listeners on native change / input events still fire. What the user sees and uses is the
 * trigger button and a list opened in a portal (never clipped inside dialogs, flipped up when there is no room below):
 *   - a search box at the top (only when there are more than SEARCH_FROM options) filtering on the option's text (code and name);
 *   - "CODE — Name" options shown as the code in bold and the name muted, truncated with the full text on hover;
 *   - <optgroup> labels as group headings; data-icon / data-description on an <option> add an icon and a short description;
 *   - the selected option ticked, the active one in a soft brand tint, a thin theme-coloured scrollbar shown on hover;
 *   - keyboard: arrows, Home / End, Enter, Escape, Tab, typing to search; Delete / Backspace clears an optional field;
 *   - an empty state ("No units match") and a clear button when the field is optional (it has an empty option and is not required).
 */
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SelectHTMLAttributes, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

/** The search box is shown from this many options. */
const SEARCH_FROM = 8;
const ROW_PX = 36;
const MAX_ROWS = 8;

export interface SearchableSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Shown when the search finds nothing, e.g. "No units match". */
  noMatchText?: string;
  searchPlaceholder?: string;
  /** Classes for the trigger when no className is given. */
  "data-testid"?: string;
}

interface Opt {
  index: number;
  value: string;
  text: string;
  disabled: boolean;
  group: string | null;
  icon?: string;
  description?: string;
}

/** "CPCCPD3025 — Match specific paint colours" -> code + name; anything else is one label. */
function splitCodeName(text: string): { code: string | null; name: string } {
  const m = text.match(/^([A-Z][A-Z0-9]*\d[A-Z0-9.]*)\s*(?:[—–·:-]\s*|\s+)(.+)$/);
  return m && m[1].length >= 4 ? { code: m[1], name: m[2].trim() } : { code: null, name: text };
}

const normal = (s: string) => s.toLocaleLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

function readOptions(select: HTMLSelectElement): Opt[] {
  const list: Opt[] = [];
  Array.from(select.options).forEach((o, index) => {
    if (o.hidden) return;
    const group = o.parentElement instanceof HTMLOptGroupElement ? o.parentElement : null;
    list.push({ index, value: o.value, text: (o.label || o.text).replace(/\s+/g, " ").trim(), disabled: o.disabled || Boolean(group?.disabled), group: group?.label ?? null, icon: o.dataset.icon, description: o.dataset.description });
  });
  return list;
}

/** The event props a <select> may be given that belong to the trigger; they are called with the hidden <select> as target. */
const TRIGGER_EVENTS = ["onBlur", "onFocus", "onKeyDown", "onKeyUp", "onClick", "onMouseDown", "onPointerDown"] as const;

const SearchableSelect = forwardRef<HTMLSelectElement, SearchableSelectProps>(function SearchableSelect(props, forwarded) {
  const { className, style, id, title, children, value, defaultValue, onChange, onInput, name, required, disabled, multiple, form, autoFocus,
    noMatchText, searchPlaceholder = "Search…", "data-testid": testId, size: _size, ...rest } = props;
  void _size;
  const selectRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwarded, () => selectRef.current as HTMLSelectElement);
  const uid = useId().replace(/:/g, "");
  const listId = `sel-${uid}-list`;

  const [options, setOptions] = useState<Opt[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  /** The chosen option as the <select> shows it (also a hidden placeholder option, which the list leaves out). */
  const [shownChoice, setShownChoice] = useState<{ text: string; value: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null);

  // the hidden <select> is the truth: read its options and selection after every render and on every change
  const sync = useCallback(() => {
    const s = selectRef.current; if (!s) return;
    const next = readOptions(s);
    setOptions((prev) => (prev.length === next.length && prev.every((p, i) => p.value === next[i].value && p.text === next[i].text && p.disabled === next[i].disabled && p.group === next[i].group && p.icon === next[i].icon && p.description === next[i].description) ? prev : next));
    const sel = Array.from(s.selectedOptions).map((o) => o.index);
    setSelected((prev) => (prev.length === sel.length && prev.every((v, i) => v === sel[i]) ? prev : sel));
    const first = s.selectedOptions[0] ?? s.options[0];
    const choice = first ? { text: (first.label || first.text).replace(/\s+/g, " ").trim(), value: first.value } : null;
    setShownChoice((prev) => (prev?.text === choice?.text && prev?.value === choice?.value ? prev : choice));
  }, []);
  useLayoutEffect(() => { sync(); });
  useEffect(() => {
    const s = selectRef.current; if (!s) return undefined;
    s.addEventListener("change", sync); s.addEventListener("input", sync);
    const formEl = s.form; const reset = () => window.setTimeout(sync, 0);
    formEl?.addEventListener("reset", reset);
    return () => { s.removeEventListener("change", sync); s.removeEventListener("input", sync); formEl?.removeEventListener("reset", reset); };
  }, [sync]);

  const enabled = options.filter((o) => !o.disabled);
  const showSearch = enabled.length >= SEARCH_FROM;
  const shown = useMemo(() => {
    const q = normal(query.trim());
    return q ? options.filter((o) => normal(`${o.text} ${o.value} ${o.description ?? ""}`).includes(q)) : options;
  }, [options, query]);
  const current = options.filter((o) => selected.includes(o.index));
  const emptyOption = options.find((o) => o.value === "" && !o.disabled);
  const clearable = !multiple && !required && !disabled && Boolean(emptyOption) && current.length > 0 && current[0].value !== "";
  const label = multiple
    ? (current.length ? (current.length <= 2 ? current.map((o) => o.text).join(", ") : `${current.length} selected`) : "Choose…")
    : shownChoice?.text ?? "";
  const placeholderShown = multiple ? current.length === 0 : !shownChoice || shownChoice.value === "";
  const labelParts = multiple || placeholderShown ? null : splitCodeName(label);

  // pick: set the hidden <select> and send it the events a user's choice sends, so onChange / forms / listeners see a real change
  const commit = (opt: Opt) => {
    const s = selectRef.current; if (!s || opt.disabled) return;
    if (multiple) s.options[opt.index].selected = !s.options[opt.index].selected;
    else if (s.value === opt.value && s.selectedIndex === opt.index) { close(true); return; }
    else s.selectedIndex = opt.index;
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
    if (!multiple) close(true);
  };
  const clear = () => { if (emptyOption) commit(emptyOption); };

  const place = useCallback(() => {
    const t = triggerRef.current; if (!t) return;
    const r = t.getBoundingClientRect();
    const vh = window.innerHeight; const vw = window.innerWidth;
    const want = Math.min(MAX_ROWS * ROW_PX + 8, 320) + (showSearch ? 48 : 0);
    const below = vh - r.bottom - 8; const above = r.top - 8;
    const up = below < Math.min(want, 220) && above > below;
    const room = up ? above : below;
    const width = Math.min(Math.max(r.width, options.some((o) => o.description) ? 340 : 240), vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    setPos({ left, width, maxH: Math.max(120, Math.min(want, room - 4)), ...(up ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }) });
  }, [showSearch, options]);

  const openList = (seed = "") => {
    if (disabled) return;
    setQuery(showSearch ? seed : "");
    const firstSel = shownIndexOf(options, selected[0]);
    setActive(firstSel >= 0 ? firstSel : options.findIndex((o) => !o.disabled));
    place(); setOpen(true);
    if (!showSearch && seed) jumpTo(seed);
  };
  const close = (focusTrigger: boolean) => { setOpen(false); setQuery(""); if (focusTrigger) triggerRef.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const onMove = () => place();
    window.addEventListener("resize", onMove); window.addEventListener("scroll", onMove, true);
    const onDown = (e: MouseEvent) => { const t = e.target as Node; if (!popRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false); };
    document.addEventListener("mousedown", onDown);
    (showSearch ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
    return () => { window.removeEventListener("resize", onMove); window.removeEventListener("scroll", onMove, true); document.removeEventListener("mousedown", onDown); };
  }, [open, place, showSearch]);

  // keep the active row in view and inside the filtered list
  useEffect(() => {
    if (!open) return;
    if (active >= shown.length || (active >= 0 && shown[active]?.disabled)) setActive(shown.findIndex((o) => !o.disabled));
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, shown]);

  const typed = useRef({ text: "", at: 0 });
  const jumpTo = (ch: string) => {
    const now = Date.now(); typed.current = { text: now - typed.current.at < 700 ? typed.current.text + ch : ch, at: now };
    const k = options.findIndex((o) => !o.disabled && normal(o.text).startsWith(normal(typed.current.text)));
    if (k >= 0) setActive(k);
  };
  const move = (delta: number) => {
    if (!shown.length) return;
    let k = active;
    for (let n = 0; n < shown.length; n++) { k = (k + delta + shown.length) % shown.length; if (!shown[k].disabled) break; }
    setActive(k);
  };
  const stop = (e: SyntheticEvent) => { e.stopPropagation(); e.nativeEvent.stopPropagation(); };

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); setActive(shown.findIndex((o) => !o.disabled)); }
    else if (e.key === "End") { e.preventDefault(); for (let k = shown.length - 1; k >= 0; k--) if (!shown[k].disabled) { setActive(k); break; } }
    else if (e.key === "Enter") { e.preventDefault(); const o = shown[active]; if (o) commit(o); }
    else if (e.key === "Escape") { e.preventDefault(); stop(e); close(true); }
    else if (e.key === "Tab") { close(false); }
    else if (!showSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) jumpTo(e.key);
  };

  // the <select>'s own trigger-side handlers (onBlur, onFocus, onKeyDown …) are called with the hidden <select> as the target
  const triggerEvents: Record<string, (e: SyntheticEvent) => void> = {};
  for (const k of TRIGGER_EVENTS) {
    const h = (rest as Record<string, unknown>)[k] as ((e: SyntheticEvent) => void) | undefined;
    delete (rest as Record<string, unknown>)[k];
    if (h) triggerEvents[k] = (e) => { const s = selectRef.current; const proxy = Object.create(e) as SyntheticEvent; Object.defineProperty(proxy, "target", { value: s }); Object.defineProperty(proxy, "currentTarget", { value: s }); h(proxy); };
  }
  const ariaProps: Record<string, unknown> = {}; const selectProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) (k.startsWith("aria-") || k === "tabIndex" ? ariaProps : selectProps)[k] = v;

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    triggerEvents.onKeyDown?.(e);
    if (e.defaultPrevented || disabled) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key) && !open) { e.preventDefault(); openList(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && clearable) { e.preventDefault(); clear(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !open) { e.preventDefault(); openList(e.key); }
  };

  const triggerClass = className?.trim() ? className : "h-10 w-full rounded-lg border border-background-300 bg-background-50 px-3 text-sm text-foreground-900";
  let lastGroup: string | null | undefined;
  const rows: ReactNode[] = [];
  shown.forEach((o, k) => {
    if (o.group !== lastGroup && o.group) rows.push(<li key={`g-${o.group}-${k}`} role="presentation" className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-500">{o.group}</li>);
    lastGroup = o.group;
    const isSel = selected.includes(o.index); const isActive = k === active;
    const { code, name: nm } = splitCodeName(o.text);
    rows.push(
      <li key={`${o.index}`} id={`${listId}-${k}`} role="option" aria-selected={isSel} aria-disabled={o.disabled || undefined} data-row={k} data-value={o.value} data-index={o.index} data-label={o.text} title={o.description ? `${o.text}: ${o.description}` : o.text}
        onMouseMove={() => { if (!o.disabled && active !== k) setActive(k); }} onClick={(e) => { stop(e); commit(o); }}
        className={`mx-1 flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${o.disabled ? "cursor-not-allowed opacity-45" : isActive ? "bg-primary-50 text-foreground-950" : "text-foreground-800"}`}>
        {o.icon ? <i className={`${o.icon} shrink-0 text-base text-primary-600`} aria-hidden="true" /> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{code ? <><strong className="font-semibold text-foreground-950">{code}</strong><span className="text-foreground-500"> · {nm}</span></> : <span className={o.value === "" ? "text-foreground-500" : ""}>{o.text || " "}</span>}</span>
          {o.description ? <span className="block truncate text-xs text-foreground-500">{o.description}</span> : null}
        </span>
        {multiple ? <i className={`${isSel ? "ri-checkbox-fill text-primary-600" : "ri-checkbox-blank-line text-foreground-400"} shrink-0`} aria-hidden="true" />
          : isSel ? <i className="ri-check-line shrink-0 text-base text-primary-600" aria-hidden="true" /> : null}
      </li>,
    );
  });

  const pop = open && pos ? createPortal(
    <div ref={popRef} data-dropdown-portal="" role="presentation"
      style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, zIndex: 1000 } as CSSProperties}
      className="flex flex-col overflow-hidden rounded-lg border border-background-200 bg-background-50 shadow-xl ring-1 ring-foreground-950/5"
      onMouseDown={(e) => { stop(e); if (e.target !== searchRef.current) e.preventDefault(); }} onClick={stop} onKeyDown={(e) => { stop(e); onListKey(e); }}>
      {showSearch ? (
        <div className="border-b border-background-200 p-1.5">
          <div className="flex items-center gap-1.5 rounded-md border border-background-300 bg-background-50 px-2 focus-within:border-primary-400">
            <i className="ri-search-line text-foreground-400" aria-hidden="true" />
            <input ref={searchRef} type="text" role="searchbox" aria-label="Search the options" aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground-900 outline-none placeholder:text-foreground-400" placeholder={searchPlaceholder}
              value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
            {query ? <button type="button" className="cursor-pointer text-foreground-400 hover:text-foreground-700" aria-label="Clear the search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><i className="ri-close-line" aria-hidden="true" /></button> : null}
          </div>
        </div>
      ) : null}
      <ul ref={listRef} id={listId} role="listbox" tabIndex={-1} aria-multiselectable={multiple || undefined} aria-activedescendant={!showSearch && active >= 0 ? `${listId}-${active}` : undefined}
        className="sel-scroll overflow-y-auto overscroll-contain py-1 outline-none" style={{ maxHeight: pos.maxH }}>
        {rows}
      </ul>
      {shown.length === 0 ? <p className="px-3 py-3 text-sm text-foreground-500" role="status">{noMatchText ?? "No options match"}{query ? <> “{query}”</> : null}</p> : null}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button ref={triggerRef} type="button" id={id} title={title ?? (label || undefined)} disabled={disabled} autoFocus={autoFocus} style={style}
        role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-required={required || undefined}
        data-select-trigger="" {...ariaProps} {...triggerEvents} onKeyDown={onTriggerKey}
        onClick={(e) => { triggerEvents.onClick?.(e); if (!e.defaultPrevented) { if (open) close(false); else openList(); } }}
        className={`inline-flex min-w-0 cursor-pointer items-center gap-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60 ${triggerClass}`}>
        <span className={`min-w-0 flex-1 truncate ${placeholderShown ? "text-foreground-500" : ""}`}>{labelParts?.code ? <><strong className="font-semibold">{labelParts.code}</strong><span className="text-foreground-500"> · {labelParts.name}</span></> : label || " "}</span>
        {clearable ? <span role="button" tabIndex={-1} aria-label="Clear" title="Clear" className="-my-1 shrink-0 rounded p-0.5 text-foreground-400 hover:bg-background-200 hover:text-foreground-800"
          onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); clear(); }}><i className="ri-close-line" aria-hidden="true" /></span> : null}
        <i className={`ri-arrow-down-s-line shrink-0 text-base text-foreground-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <select ref={selectRef} aria-hidden="true" tabIndex={-1} data-testid={testId} name={name} required={required} disabled={disabled} multiple={multiple} form={form}
        value={value} defaultValue={defaultValue} onChange={onChange} onInput={onInput} {...selectProps}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none", margin: 0, padding: 0, border: 0 }}>
        {children}
      </select>
      {pop}
    </>
  );
});

function shownIndexOf(options: Opt[], index: number | undefined): number {
  return index === undefined ? -1 : options.findIndex((o) => o.index === index);
}

export default SearchableSelect;
