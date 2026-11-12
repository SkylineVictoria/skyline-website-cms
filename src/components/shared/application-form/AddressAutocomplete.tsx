import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/pages/admin/lib/supabase";

/** One Australian address as the address-search Edge Function (Geoscape) returns it. */
export interface AddressPick { line: string; line2: string; suburb: string; state: string; postcode: string }

const MIN_QUERY = 4;
const DEBOUNCE_MS = 300;
const LIST_MAX = 280;

export type AddressLookup = { kind: "ok"; suggestions: AddressPick[] } | { kind: "unavailable" };
/** How a search is made. The default asks the address-search function with the signed-in person's session. */
export type AddressSearchFn = (q: string, signal: AbortSignal) => Promise<AddressLookup>;

/**
 * Called directly rather than through the shared client: that client adds an x-tenant-domain header which the
 * address-search function's CORS rules do not allow. The caller's session token still authorises the request.
 */
async function lookup(q: string, signal: AbortSignal): Promise<AddressLookup> {
  const url = import.meta.env.VITE_PUBLIC_SUPABASE_URL as string;
  const anon = import.meta.env.VITE_PUBLIC_SUPABASE_ANON_KEY as string;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!url || !anon || !token) return { kind: "unavailable" };
  const response = await fetch(`${url}/functions/v1/address-search`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${token}`, apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ q }),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; suggestions?: AddressPick[] } | null;
  if (!response.ok || !body?.ok || !Array.isArray(body.suggestions)) return { kind: "unavailable" };
  return { kind: "ok", suggestions: body.suggestions };
}

const format = (pick: AddressPick) => [pick.line2, pick.line, `${pick.suburb} ${pick.state} ${pick.postcode}`].filter(Boolean).join(", ");

/** The result text with the words typed so far in bold. */
function highlight(text: string, query: string): ReactNode {
  const words = query.trim().split(/\s+/).filter((word) => word.length > 0).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return text;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "ig"));
  return parts.map((part, index) => (index % 2 === 1 ? <strong key={index} className="font-semibold text-foreground-950">{part}</strong> : part));
}

type Status = "idle" | "searching" | "empty" | "unavailable";

/**
 * Search box for an Australian address: picking a result fills street, line 2, suburb, state and postcode. Used by the student
 * application form (signed in: the address-search function) and by staff onboarding (no login: `search` asks the
 * staff-onboarding function with the private link). Both reach the same Geoscape lookup on the server; the key never
 * reaches the browser. When the lookup fails the box says so (with Retry) and the address is typed by hand.
 *
 * Typing is debounced (300ms); an older request is cancelled and a late answer to an older query is ignored. The suggestions open
 * in a layer of their own (above the sticky footer and any card), under the box or above it when there is no room below; the
 * previous results stay, dimmed, while new ones load. ↑ / ↓ move, Enter picks, Escape closes.
 */
export default function AddressAutocomplete({ disabled, onPick, onUnavailable, onManual, search = lookup }: {
  disabled?: boolean;
  onPick: (pick: AddressPick) => void;
  onUnavailable?: () => void;
  /** When given, "No matches" offers "Enter address manually". */
  onManual?: () => void;
  search?: AddressSearchFn;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressPick[]>([]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [active, setActive] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  // Held in refs so a new callback from the parent never restarts a search.
  const unavailableRef = useRef(onUnavailable);
  useEffect(() => { unavailableRef.current = onUnavailable; }, [onUnavailable]);
  const searchRef = useRef(search);
  useEffect(() => { searchRef.current = search; }, [search]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) { setResults([]); setStatus("idle"); return undefined; }
    const controller = new AbortController();
    const mine = ++sequence.current;
    const timer = window.setTimeout(() => {
      setStatus("searching");
      searchRef.current(q, controller.signal)
        .then((result) => {
          if (mine !== sequence.current) return;
          if (result.kind === "unavailable") { setResults([]); setStatus("unavailable"); unavailableRef.current?.(); return; }
          setResults(result.suggestions);
          setActive(result.suggestions.length ? 0 : -1);
          setStatus(result.suggestions.length ? "idle" : "empty");
        })
        .catch((error) => {
          if (mine !== sequence.current || (error as Error)?.name === "AbortError") return;
          setResults([]); setStatus("unavailable"); unavailableRef.current?.();
        });
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, attempt]);

  const showList = open && query.trim().length >= MIN_QUERY && (results.length > 0 || status === "searching" || status === "empty");

  // Placed against the box, in the viewport: below it, or above when the room below is too small.
  const reposition = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    // The sticky footer covers the bottom of the window: count it as no room.
    const footer = document.querySelector<HTMLElement>("[data-testid=form-footer]")?.getBoundingClientRect();
    const roomBelow = footer && footer.top > rect.bottom ? Math.min(below, footer.top - rect.bottom - 8) : below;
    const up = roomBelow < Math.min(LIST_MAX, 160) && above > roomBelow;
    const maxHeight = Math.max(120, Math.min(LIST_MAX, up ? above : roomBelow));
    setPlace(up
      ? { position: "fixed", left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4, maxHeight }
      : { position: "fixed", left: rect.left, width: rect.width, top: rect.bottom + 4, maxHeight });
  }, []);
  useLayoutEffect(() => {
    if (!showList) return undefined;
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => { window.removeEventListener("scroll", reposition, true); window.removeEventListener("resize", reposition); };
  }, [showList, reposition, results.length, status]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!boxRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (pick: AddressPick) => {
    onPick(pick);
    setQuery("");
    setResults([]);
    setActive(-1);
    setStatus("idle");
    setOpen(false);
  };

  const firstLoad = status === "searching" && results.length === 0;
  const refreshing = status === "searching" && results.length > 0;

  return (
    <div ref={boxRef} className="relative md:col-span-2">
      <label htmlFor="address-search" className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-foreground-500">
        Search address
      </label>
      <div className="relative">
        <i className="ri-search-line pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base leading-none text-foreground-400" aria-hidden="true" />
        <input
          ref={inputRef}
          id="address-search"
          // No name: the search text is never saved with the application.
          type="text"
          autoComplete="off"
          disabled={disabled}
          value={query}
          placeholder="Start typing the street address, e.g. 12 Smith St Melbourne"
          role="combobox"
          aria-expanded={showList}
          aria-controls="address-search-results"
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `address-option-${active}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setOpen(false); return; }
            if (!results.length) return;
            if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((i) => Math.min(results.length - 1, i + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (event.key === "Enter" && open && active >= 0) { event.preventDefault(); choose(results[active]); }
          }}
          className="w-full rounded-md border border-background-300 bg-background-50 py-2.5 pl-9 pr-9 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40"
        />
        {status === "searching" ? <i className="ri-loader-4-line pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-base leading-none text-foreground-400" aria-hidden="true" /> : null}
      </div>
      {showList && place ? createPortal(
        <div
          ref={listRef}
          style={place}
          className="fade-in z-[95] flex flex-col overflow-hidden rounded-lg border border-background-200 bg-background-50 shadow-lg"
        >
          <ul id="address-search-results" role="listbox" aria-label="Address suggestions" aria-busy={status === "searching"}
            className={`min-h-0 flex-1 overflow-y-auto py-1 transition-opacity duration-150 ${refreshing ? "opacity-60" : ""}`}>
            {firstLoad
              ? [0, 1, 2].map((row) => (
                <li key={row} aria-hidden="true" className="flex items-center gap-2 px-3 py-2.5">
                  <span className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-background-200" />
                  <span className="h-3 animate-pulse rounded bg-background-200" style={{ width: `${[72, 58, 64][row]}%` }} />
                </li>
              ))
              : results.map((pick, index) => (
                <li key={format(pick)} id={`address-option-${index}`} role="option" aria-selected={index === active} data-index={index}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(pick)}
                    className={`flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left text-sm text-foreground-700 transition-colors duration-100 ${index === active ? "bg-primary-50" : "hover:bg-background-100"}`}
                  >
                    <i className={`ri-map-pin-line mt-0.5 text-base leading-none ${index === active ? "text-primary-600" : "text-foreground-400"}`} aria-hidden="true" />
                    <span>{highlight(format(pick), query)}</span>
                  </button>
                </li>
              ))}
            {status === "empty" && results.length === 0 ? (
              <li className="px-3 py-2.5 text-sm text-foreground-600">
                No matches.{" "}
                {onManual ? (
                  <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { setOpen(false); onManual(); }}
                    className="cursor-pointer font-medium text-foreground-900 underline underline-offset-2 hover:text-primary-700">
                    Enter address manually
                  </button>
                ) : "Keep typing, or try a shorter search."}
              </li>
            ) : null}
          </ul>
        </div>,
        document.body,
      ) : null}
      <p className="mt-1 min-h-4 text-xs text-foreground-500">
        {status === "unavailable" ? (
          <span className="text-red-700">
            Address search is unavailable right now.{" "}
            <button type="button" onClick={() => { setOpen(true); setAttempt((n) => n + 1); }} className="cursor-pointer font-medium underline underline-offset-2">Retry</button>
          </span>
        ) : "Pick a result to fill in the address."}
      </p>
    </div>
  );
}
