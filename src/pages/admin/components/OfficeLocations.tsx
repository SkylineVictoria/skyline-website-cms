import { useCallback, useEffect, useState } from "react";
import { Button, Card, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { searchGooglePlaces } from "@/lib/signingApi";
import { supabase } from "@/pages/admin/lib/supabase";
import { placeAddressLine, type PlaceDetails } from "../../../../supabase/functions/_shared/google-places";
import { EMPTY_OFFICE, officeFromPlace, officeLine, saveOffices, STATES, type OfficeLocation } from "@/pages/admin/lib/offices";

/**
 * Head office and branches (owner, 2026-11-24: "Aussizz Group has multiple locations, so allow adding the main headquarters and branches
 * too with Google Maps"). An office is found on Google Maps (any text: name, branch, suburb or street; up to five places to pick from) or
 * typed by hand, and stays editable. Saved on the business by agency_offices_set (20261124101517); the head office is the one printed on
 * the application form.
 */
/** Search Google Maps by any text and pick one of up to five places. */
export function MapsSearchBox({ initialQuery = "", onPick, onCancel, disabled, id = "maps-search" }: {
  initialQuery?: string; onPick: (place: PlaceDetails) => void; onCancel?: () => void; disabled?: boolean; id?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<PlaceDetails[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const run = async () => {
    const q = query.trim();
    if (q.length < 3 || busy) return;
    setBusy(true); setMessage(""); setResults([]);
    try {
      const r = await searchGooglePlaces(q);
      if (r.ok && r.places?.length) setResults(r.places);
      else setMessage(r.message || "Nothing found on Google Maps for that.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Google Maps search failed. Try again.");
    } finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-sky-200 bg-white p-3" data-testid="places-search">
      <div className="flex flex-wrap gap-2">
        <label htmlFor={id} className="sr-only">Search Google Maps</label>
        <div className="min-w-[14rem] flex-1">
          <TextInput id={id} autoFocus disabled={disabled || busy} value={query} maxLength={200} placeholder="Business name, branch, suburb or street"
            onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void run(); } }} />
        </div>
        <Button type="button" icon="ri-search-line" disabled={disabled || busy || query.trim().length < 3} onClick={() => void run()}>{busy ? "Searching…" : "Search"}</Button>
        {onCancel ? <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button> : null}
      </div>
      <p className="mt-1 text-xs text-foreground-500">Add the branch or suburb, e.g. "Aussizz Melbourne", or type a street address.</p>
      {message ? <p role="status" className="mt-2 text-sm text-amber-800">{message}</p> : null}
      {results.length ? <ul className="mt-2 divide-y divide-background-200 rounded-lg border border-background-200">
        {results.map(p => <li key={p.placeId || p.name} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="font-semibold text-foreground-900">{p.name}</p>
            <p className="text-xs text-foreground-600">{p.formattedAddress || placeAddressLine(p)}{p.phone ? ` · ${p.phone}` : ""}</p>
            {p.mapsUri ? <a href={p.mapsUri} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">Open in Google Maps</a> : null}
          </div>
          <Button type="button" variant="secondary" disabled={disabled} onClick={() => onPick(p)} data-testid="places-pick">Use this</Button>
        </li>)}
      </ul> : null}
    </div>
  );
}

/** One office's editable fields (label only for branches). */
export function OfficeFields({ office, onChange, disabled, withLabel }: { office: OfficeLocation; onChange: (o: OfficeLocation) => void; disabled?: boolean; withLabel?: boolean }) {
  const set = (key: keyof OfficeLocation, value: string) => onChange({ ...office, [key]: value });
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {withLabel ? <Field label="Branch name"><TextInput disabled={disabled} maxLength={80} placeholder="e.g. Melbourne branch" value={office.label ?? ""} onChange={e => set("label", e.target.value)} /></Field> : null}
      <Field label="Street address"><TextInput disabled={disabled} maxLength={200} value={office.street} onChange={e => set("street", e.target.value)} /></Field>
      <Field label="Suburb"><TextInput disabled={disabled} maxLength={100} value={office.suburb} onChange={e => set("suburb", e.target.value)} /></Field>
      <Field label="State">
        <Select disabled={disabled} value={office.state} onChange={e => set("state", e.target.value)}>
          <option value="">—</option>{STATES.map(st => <option key={st} value={st}>{st}</option>)}
        </Select>
      </Field>
      <Field label="Postcode"><TextInput disabled={disabled} inputMode="numeric" maxLength={4} value={office.postcode} onChange={e => set("postcode", e.target.value.replace(/\D/g, "").slice(0, 4))} /></Field>
      <Field label="Phone"><TextInput disabled={disabled} inputMode="tel" maxLength={40} value={office.phone ?? ""} onChange={e => set("phone", e.target.value)} /></Field>
      {withLabel ? null : <Field label="Website"><TextInput disabled={disabled} inputMode="url" maxLength={300} value={office.website ?? ""} onChange={e => set("website", e.target.value)} /></Field>}
    </div>
  );
}

/** Branches: each found on Google Maps or typed, editable, removable. */
export function BranchList({ branches, onChange, disabled, searchHint = "" }: {
  branches: OfficeLocation[]; onChange: (b: OfficeLocation[]) => void; disabled?: boolean; searchHint?: string;
}) {
  const [adding, setAdding] = useState(false);
  const update = (i: number, o: OfficeLocation) => onChange(branches.map((b, j) => (j === i ? o : b)));
  const full = branches.length >= 30;
  return (
    <div className="space-y-3" data-testid="branches">
      {branches.map((b, i) => (
        <div key={i} className="rounded-lg border border-background-200 bg-background-50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground-900"><i className="ri-store-2-line mr-1 text-sky-700" aria-hidden="true" />{b.label || b.name || `Branch ${i + 1}`}</p>
            <span className="flex items-center gap-3">
              {b.mapsUri ? <a href={b.mapsUri} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">Open in Google Maps</a> : null}
              <button type="button" disabled={disabled} className="text-xs font-semibold text-red-700 hover:underline disabled:opacity-50" onClick={() => onChange(branches.filter((_, j) => j !== i))}>Remove</button>
            </span>
          </div>
          <OfficeFields office={b} onChange={o => update(i, o)} disabled={disabled} withLabel />
        </div>
      ))}
      {adding ? <MapsSearchBox id="branch-search" initialQuery={searchHint} disabled={disabled} onCancel={() => setAdding(false)}
        onPick={p => { onChange([...branches, officeFromPlace(p, p.suburb ? `${p.suburb} branch` : "")]); setAdding(false); }} /> : null}
      {adding || full ? null : <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" icon="ri-map-pin-add-line" disabled={disabled} onClick={() => setAdding(true)} data-testid="branch-add-maps">Add branch from Google Maps</Button>
        <Button type="button" variant="secondary" icon="ri-add-line" disabled={disabled} onClick={() => onChange([...branches, { ...EMPTY_OFFICE }])}>Add branch by hand</Button>
      </div>}
      {full ? <p className="text-xs text-foreground-500">A business can have up to 30 branches.</p> : null}
    </div>
  );
}

const withDefaults = (o: Partial<OfficeLocation> | null | undefined): OfficeLocation => ({ ...EMPTY_OFFICE, ...(o ?? {}) });

/** Business page: Offices card (head office + branches), Edit to change either with Google Maps or by hand. */
export function BusinessOfficesCard({ agencyId, businessName }: { agencyId: string; businessName: string }) {
  const [head, setHead] = useState<OfficeLocation | null>(null);
  const [branches, setBranches] = useState<OfficeLocation[]>([]);
  const [editing, setEditing] = useState(false);
  const [draftHead, setDraftHead] = useState<OfficeLocation>(EMPTY_OFFICE);
  const [draftBranches, setDraftBranches] = useState<OfficeLocation[]>([]);
  const [headSearch, setHeadSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc("agency_offices_get", { p_agency: agencyId });
    if (e) { setError(e.message); setLoaded(true); return; }
    const r = data as { head: Partial<OfficeLocation>; branches: OfficeLocation[] };
    setHead(r.head && (r.head.street || r.head.suburb) ? withDefaults(r.head) : null);
    setBranches((r.branches ?? []).map(withDefaults));
    setLoaded(true);
  }, [agencyId]);
  useEffect(() => { void load(); }, [load]);
  const startEdit = () => { setDraftHead(head ?? { ...EMPTY_OFFICE }); setDraftBranches(branches); setHeadSearch(false); setError(""); setEditing(true); };
  const save = async () => {
    setBusy(true); setError("");
    try {
      const headChanged = JSON.stringify(draftHead) !== JSON.stringify(head ?? EMPTY_OFFICE) && (draftHead.street.trim() || draftHead.suburb.trim());
      const r = await saveOffices(agencyId, headChanged ? draftHead : null, draftBranches);
      setHead(r.head && (r.head.street || r.head.suburb) ? withDefaults(r.head) : null);
      setBranches((r.branches ?? []).map(withDefaults));
      setEditing(false);
    } catch (e) { setError(e instanceof Error ? e.message : "The offices could not be saved."); }
    finally { setBusy(false); }
  };
  const officeView = (o: OfficeLocation, title: string, key: string) => (
    <li key={key} className="flex items-start justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="font-semibold text-foreground-900">{title}</p>
        <p className="text-foreground-700">{officeLine(o) || "—"}{o.phone ? ` · ${o.phone}` : ""}</p>
      </div>
      {o.mapsUri ? <a href={o.mapsUri} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-sky-700 underline">Open in Google Maps</a> : null}
    </li>
  );
  return (
    <Card className="mt-6 p-5" aria-label="Offices">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 font-heading text-base font-semibold text-foreground-950"><i className="ri-map-pin-line text-sky-700" aria-hidden="true" />Offices</h2>
          <p className="text-xs text-foreground-600">Head office (printed on the application form) and branches.</p>
        </div>
        {editing || !loaded ? null : <Button type="button" variant="secondary" icon="ri-edit-line" onClick={startEdit} data-testid="offices-edit">Edit offices</Button>}
      </div>
      {!editing ? (loaded ? <ul className="mt-3 divide-y divide-background-200">
        {head ? officeView(head, "Head office", "head") : <li className="py-2 text-sm text-foreground-500">No head office yet.</li>}
        {branches.map((b, i) => officeView(b, b.label || b.name || `Branch ${i + 1}`, `b${i}`))}
      </ul> : <p className="mt-3 text-sm text-foreground-500">Loading…</p>) : (
        <div className="mt-4 space-y-5">
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground-900">Head office</h3>
              {headSearch ? null : <Button type="button" variant="secondary" icon="ri-search-line" disabled={busy} onClick={() => setHeadSearch(true)}>Change with Google Maps</Button>}
            </div>
            {headSearch ? <div className="mb-3"><MapsSearchBox id="head-search" initialQuery={businessName} disabled={busy} onCancel={() => setHeadSearch(false)}
              onPick={p => { setDraftHead(officeFromPlace(p)); setHeadSearch(false); }} /></div> : null}
            <OfficeFields office={draftHead} onChange={setDraftHead} disabled={busy} />
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground-900">Branches</h3>
            <BranchList branches={draftBranches} onChange={setDraftBranches} disabled={busy} searchHint={businessName} />
          </section>
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="button" icon="ri-save-line" disabled={busy} onClick={() => void save()} data-testid="offices-save">{busy ? "Saving…" : "Save offices"}</Button>
          </div>
        </div>
      )}
      {error && !editing ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
    </Card>
  );
}
