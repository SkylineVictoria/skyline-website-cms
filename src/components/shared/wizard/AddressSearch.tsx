import { useEffect, useRef, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/** One Australian address as the address-search Edge Function (Geoscape) returns it. */
export interface AddressPick { line: string; line2: string; suburb: string; state: string; postcode: string }

const MIN_QUERY = 4;
const DEBOUNCE_MS = 300;

export type AddressLookup = { kind: "ok"; suggestions: AddressPick[] } | { kind: "unavailable" };
type Lookup = AddressLookup;
/** How a search is made. The default asks the address-search function with the signed-in person's session. */
export type AddressSearchFn = (q: string, signal: AbortSignal) => Promise<AddressLookup>;

/**
 * Called directly rather than through the shared client: that client adds an x-tenant-domain header which the
 * address-search function's CORS rules do not allow. The caller's session token still authorises the request.
 */
async function lookup(q: string, signal: AbortSignal): Promise<Lookup> {
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

/**
 * Search box above the street field: picking a result fills street, line 2, suburb, state and postcode. Used by the student
 * application form (signed in: the address-search function) and by staff onboarding (no login: `search` asks the
 * staff-onboarding function with the private link). Both reach the same Geoscape lookup on the server; the key never
 * reaches the browser. When the lookup fails the box says so and the address is typed by hand.
 */
export default function AddressSearch({ disabled, onPick, onUnavailable, search = lookup }: { disabled?: boolean; onPick: (pick: AddressPick) => void; onUnavailable?: () => void; search?: AddressSearchFn }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressPick[]>([]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "searching" | "empty" | "unavailable">("idle");
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  // Held in a ref so a new callback from the parent never restarts a search.
  const unavailableRef = useRef(onUnavailable);
  useEffect(() => { unavailableRef.current = onUnavailable; }, [onUnavailable]);
  const searchRef = useRef(search);
  useEffect(() => { searchRef.current = search; }, [search]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) { setResults([]); setStatus("idle"); return undefined; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus("searching");
      searchRef.current(q, controller.signal)
        .then((result) => {
          if (result.kind === "unavailable") { setResults([]); setStatus("unavailable"); unavailableRef.current?.(); return; }
          setResults(result.suggestions);
          setActive(-1);
          setStatus(result.suggestions.length ? "idle" : "empty");
        })
        .catch((error) => { if ((error as Error)?.name !== "AbortError") { setResults([]); setStatus("unavailable"); unavailableRef.current?.(); } });
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const choose = (pick: AddressPick) => {
    onPick(pick);
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative md:col-span-2">
      <label htmlFor="address-search" className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-700">
        Search address
      </label>
      <div className="relative">
        <i className="ri-search-line absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
        <input
          id="address-search"
          // No name: the search text is never saved with the application.
          type="text"
          autoComplete="off"
          disabled={disabled}
          value={query}
          placeholder="Start typing the street address, e.g. 12 Smith St Melbourne"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="address-search-results"
          aria-autocomplete="list"
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (!results.length) return;
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
            else if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(results[active]); }
            else if (event.key === "Escape") setOpen(false);
          }}
          className="w-full rounded-md border border-background-300 bg-background-50 py-2.5 pl-9 pr-9 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40"
        />
        {status === "searching" ? <i className="ri-loader-4-line absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-foreground-400" aria-hidden="true" /> : null}
      </div>
      {open && results.length > 0 ? (
        <ul id="address-search-results" role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-background-200 bg-background-50 py-1 shadow-lg">
          {results.map((pick, index) => (
            <li key={format(pick)} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(pick)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm ${index === active ? "bg-primary-50" : "hover:bg-background-100"}`}
              >
                <i className="ri-map-pin-line mt-0.5 text-primary-600" aria-hidden="true" />
                <span>{format(pick)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 text-xs text-foreground-500">
        {status === "empty"
          ? "No matching address found. Keep typing, or try a shorter search."
          : status === "unavailable"
            ? "Address search is unavailable right now."
            : "Pick a result to fill in the address."}
      </p>
    </div>
  );
}
