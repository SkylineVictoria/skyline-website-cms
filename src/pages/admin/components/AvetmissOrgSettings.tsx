import { useEffect, useState } from "react";
import { Button, Card, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { supabase } from "@/pages/admin/lib/supabase";
import { avetmissOptions, useAvetmissCodes } from "@/lib/avetmissCodes";
import { lookupAbnDetails } from "@/lib/signingApi";
import { invokePortalUsers } from "@/pages/agency/lib/portalData";
import type { AgencyAbnDetails } from "../../../../supabase/functions/_shared/validation/abn";

/**
 * AVETMISS-UI (2026-11-25): Settings › Organisation › AVETMISS / NCVER. The training organisation details the NCVER files carry
 * (cms_settings.avetmiss_*), saved on their own (not through the website settings draft). Admins only; the same limits as the
 * database checks, empty boxes saved as nothing. ABN-AUTOFILL (2026-11-25, owner): the ABN (cms_settings.abn) is looked up on the
 * government register (document-signing agent_onboarding_abn_lookup, the same lookup as Add business) and Google Maps beside it: the
 * legal name, address, suburb, postcode, state and phone found are filled into the boxes; nothing is saved until Save.
 */
const KEYS = ["avetmiss_toid", "avetmiss_legal_name", "avetmiss_org_type_code", "avetmiss_address_line1", "avetmiss_address_line2", "avetmiss_suburb",
  "avetmiss_postcode", "avetmiss_state_code", "avetmiss_contact_name", "avetmiss_contact_phone", "avetmiss_contact_email"] as const;
type Key = typeof KEYS[number];
type Values = Record<Key, string>;
const EMPTY = Object.fromEntries(KEYS.map((k) => [k, ""])) as Values;
const MAX: Partial<Record<Key, number>> = { avetmiss_legal_name: 100, avetmiss_address_line1: 50, avetmiss_address_line2: 50, avetmiss_suburb: 50,
  avetmiss_contact_name: 60, avetmiss_contact_phone: 20, avetmiss_contact_email: 80 };

/**
 * ORG-BUSINESS-DETAILS (2026-11-25, owner): everything Look up ABN brings back about SLIT is kept too (cms_settings.org_*, migration
 * 20261125020517): the register (ABR service or the public ABN page) and Google Maps, each editable and saved with the same Save.
 */
const ABR_FIELDS = [
  ["org_entity_name", "Registered entity name"], ["org_acn", "ACN"], ["org_entity_type", "Entity type"], ["org_trading_names", "Business / trading names"],
  ["org_abn_status", "ABN status"], ["org_abn_status_from", "ABN status from"], ["org_gst_status", "GST"], ["org_gst_from", "GST registered from"],
  ["org_register_state", "Register state"], ["org_register_postcode", "Register postcode"], ["org_abr_url", "ABN Lookup page"], ["org_abr_checked_at", "Register checked"],
] as const;
const PLACE_FIELDS = [
  ["org_place_name", "Name on Google Maps"], ["org_place_address", "Full address"], ["org_place_street", "Street"], ["org_place_suburb", "Suburb"],
  ["org_place_state", "State"], ["org_place_postcode", "Postcode"], ["org_place_country", "Country"], ["org_place_website", "Website"],
  ["org_place_phone", "Phone"], ["org_place_phone_international", "Phone (international)"], ["org_place_maps_url", "Google Maps link"],
  ["org_place_business_status", "Business status"], ["org_place_match_percent", "Match %"], ["org_place_id", "Google place ID"], ["org_place_checked_at", "Google Maps checked"],
] as const;
type OrgKey = typeof ABR_FIELDS[number][0] | typeof PLACE_FIELDS[number][0];
const ORG_KEYS = [...ABR_FIELDS, ...PLACE_FIELDS].map(([k]) => k) as OrgKey[];
type OrgValues = Record<OrgKey, string>;
const ORG_EMPTY = Object.fromEntries(ORG_KEYS.map((k) => [k, ""])) as OrgValues;
const ORG_DATE = new Set<OrgKey>(["org_abn_status_from", "org_gst_from"]);
const ORG_READONLY = new Set<OrgKey>(["org_abr_checked_at", "org_place_checked_at", "org_place_id", "org_place_match_percent"]);
const isoDay = (v: string) => (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
const shownTime = (v: string) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : ""; };

/** ABR / Google Maps state abbreviations to AVETMISS state codes. */
const STATE_CODE: Record<string, string> = { NSW: "01", VIC: "02", QLD: "03", SA: "04", WA: "05", TAS: "06", NT: "07", ACT: "08" };
const cut = (v: string, max?: number) => (max ? v.slice(0, max) : v);

function avetmissOrgProblems(v: Values): Partial<Record<Key, string>> {
  const p: Partial<Record<Key, string>> = {};
  if (v.avetmiss_toid && !/^[0-9A-Za-z]{1,10}$/.test(v.avetmiss_toid)) p.avetmiss_toid = "Up to 10 letters or digits.";
  if (v.avetmiss_postcode && !/^[0-9]{4}$/.test(v.avetmiss_postcode)) p.avetmiss_postcode = "4 digits.";
  if (v.avetmiss_contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.avetmiss_contact_email)) p.avetmiss_contact_email = "Enter a valid email.";
  for (const [k, max] of Object.entries(MAX) as [Key, number][]) if (v[k].length > max) p[k] = `At most ${max} characters.`;
  return p;
}

export default function AvetmissOrgSettings() {
  const { push } = useToast();
  const { codes } = useAvetmissCodes();
  const [rowId, setRowId] = useState<number | null>(null);
  const [values, setValues] = useState<Values>(EMPTY);
  const [saved, setSaved] = useState<Values>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [abn, setAbn] = useState("");
  const [savedAbn, setSavedAbn] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupNote, setLookupNote] = useState("");
  const [org, setOrg] = useState<OrgValues>(ORG_EMPTY);
  const [savedOrg, setSavedOrg] = useState<OrgValues>(ORG_EMPTY);

  useEffect(() => {
    void supabase.from("cms_settings").select(`id, abn, ${KEYS.join(", ")}, ${ORG_KEYS.join(", ")}`).order("id").limit(1).then(({ data, error: e }) => {
      if (e) { setError(e.message); return; }
      const row = ((data as unknown as (Record<string, string | null> & { id: number })[] | null)?.[0] ?? null);
      if (!row) return;
      const next = Object.fromEntries(KEYS.map((k) => [k, row[k] ?? ""])) as Values;
      const nextOrg = Object.fromEntries(ORG_KEYS.map((k) => [k, row[k] == null ? "" : String(row[k])])) as OrgValues;
      setOrg(nextOrg); setSavedOrg(nextOrg);
      setRowId(row.id); setValues(next); setSaved(next); setAbn(row.abn ?? ""); setSavedAbn(row.abn ?? "");
    });
  }, []);

  const problems = avetmissOrgProblems(values);
  const abnDigits = abn.replace(/\D/g, "");
  const abnProblem = abn.trim() && abnDigits.length !== 11 ? "An ABN has 11 digits." : "";
  const dirty = KEYS.some((k) => values[k] !== saved[k]) || abn.trim() !== savedAbn.trim() || ORG_KEYS.some((k) => org[k] !== savedOrg[k]);
  const orgProblem = org.org_acn && !/^\d{9}$/.test(org.org_acn.replace(/\s/g, "")) ? "An ACN has 9 digits." : "";

  const lookUp = async () => {
    if (abnDigits.length !== 11) { setLookupNote("Enter the 11-digit ABN first."); return; }
    setLooking(true); setLookupNote("");
    try {
      const r = await lookupAbnDetails(abnDigits);
      // No ABR GUID on the server: the legal name, state, postcode and status come from the public ABN Lookup page (portal-admin-users
      // lookup_agency_abn, SLIT administrators; the same lookup Add business falls back to).
      let pageDetails: AgencyAbnDetails | null = null;
      let pageError = "";
      if (!("details" in r)) {
        try { pageDetails = ((await invokePortalUsers({ action: "lookup_agency_abn", abn: abnDigits })).business as AgencyAbnDetails | undefined) ?? null; }
        catch (e) { pageError = e instanceof Error ? e.message : "The public ABN page could not be read."; }
      }
      // The register answer (needs the ABR GUID) and Google Maps are separate: without the GUID the function still searches Google Maps
      // (names from the public ABN Lookup page) and returns it beside reason not_configured, so both halves are read independently.
      const d = "details" in r ? { abn: r.details.abn, legalName: r.details.entityName, state: r.details.state, postcode: r.details.postcode, active: r.details.active, abnStatus: r.details.abnStatus }
        : pageDetails ? { abn: pageDetails.abn, legalName: pageDetails.legalName, state: pageDetails.state, postcode: pageDetails.postcode, active: /^active/i.test(pageDetails.abnStatus.trim()), abnStatus: pageDetails.abnStatus }
        : null;
      const places = r.places;
      const place = places?.ok ? places.place : undefined;
      if (!d && !place) { setLookupNote(pageError || ("reason" in r ? r.message : "Nothing found for this ABN.")); return; }
      const state = STATE_CODE[(place?.state || d?.state || "").toUpperCase()] ?? "";
      const found: Partial<Values> = {
        avetmiss_legal_name: cut(d?.legalName ?? "", MAX.avetmiss_legal_name),
        avetmiss_address_line1: cut(place?.street ?? "", MAX.avetmiss_address_line1),
        avetmiss_suburb: cut(place?.suburb ?? "", MAX.avetmiss_suburb),
        avetmiss_postcode: (place?.postcode || d?.postcode || "").replace(/\D/g, "").slice(0, 4),
        avetmiss_state_code: state,
        avetmiss_contact_phone: cut(place?.phone ?? "", MAX.avetmiss_contact_phone),
      };
      const filled = Object.entries(found).filter(([, v]) => v) as [Key, string][];
      setValues((x) => ({ ...x, ...Object.fromEntries(filled) }));
      // Every register and Google Maps field into the Business details boxes (only the parts that answered are replaced).
      const now = new Date().toISOString();
      const reg: Partial<OrgValues> = "details" in r ? {
        org_entity_name: r.details.entityName, org_acn: r.details.acn, org_entity_type: r.details.entityType, org_trading_names: r.details.businessNames.join("; "),
        org_abn_status: r.details.abnStatus, org_abn_status_from: isoDay(r.details.statusFrom), org_gst_status: r.details.gstRegistered ? "Registered for GST" : "Not registered for GST",
        org_gst_from: isoDay(r.details.gstFrom), org_register_state: r.details.state, org_register_postcode: r.details.postcode, org_abr_url: r.details.sourceUrl, org_abr_checked_at: now,
      } : pageDetails ? {
        org_entity_name: pageDetails.legalName, org_acn: pageDetails.acn ?? "", org_entity_type: pageDetails.entityType, org_trading_names: pageDetails.businessNames.join("; "),
        org_abn_status: pageDetails.abnStatus, org_abn_status_from: isoDay(pageDetails.statusFrom ?? ""), org_gst_status: pageDetails.gstStatus, org_gst_from: isoDay(pageDetails.gstFrom ?? ""),
        org_register_state: pageDetails.state, org_register_postcode: pageDetails.postcode, org_abr_url: pageDetails.sourceUrl, org_abr_checked_at: now,
      } : {};
      const gm: Partial<OrgValues> = place ? {
        org_place_name: place.name, org_place_address: place.formattedAddress, org_place_street: place.street, org_place_suburb: place.suburb, org_place_state: place.state,
        org_place_postcode: place.postcode, org_place_country: place.country, org_place_website: place.website, org_place_phone: place.phone,
        org_place_phone_international: place.phoneInternational, org_place_maps_url: place.mapsUri, org_place_business_status: place.businessStatus,
        org_place_match_percent: String(place.matchPercent ?? ""), org_place_id: place.placeId, org_place_checked_at: now,
      } : {};
      setOrg((x) => ({ ...x, ...Object.fromEntries(Object.entries({ ...reg, ...gm }).map(([k, v]) => [k, String(v ?? "")])) }));
      if (d?.abn) setAbn(d.abn);
      const sources = [d ? ("details" in r ? "the ABN register" : "the public ABN page") : "", place ? "Google Maps" : ""].filter(Boolean).join(" and ");
      const notes = [filled.length ? `${filled.length} detail${filled.length === 1 ? "" : "s"} filled from ${sources}${place ? ` (${place.name}, ${place.matchPercent}% match)` : ""}. Check them, then Save.` : "Nothing found to fill."];
      if (d && !d.active) notes.push(`The register shows this ABN as ${d.abnStatus || "not active"}.`);
      if (!d) notes.push(`The legal name could not be read from the public ABN page${pageError ? `: ${pageError}` : ""}.`);
      if (!place) {
        if (!places) notes.push("Google Maps was not searched (switched off in Business Rules, or no business name found for this ABN).");
        else if (!places.configured) notes.push("Google Maps has no key on the server (Integrations › Connections › Google Maps).");
        else notes.push(`Google Maps: ${places.message || "no matching office found"}${places.cached ? " (remembered from an earlier search)" : ""}.`);
      }
      setLookupNote(notes.join(" "));
    } catch (e) {
      setLookupNote(e instanceof Error ? e.message : "The ABN lookup failed.");
    } finally { setLooking(false); }
  };
  const set = (k: Key, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const missing = (["avetmiss_toid", "avetmiss_legal_name", "avetmiss_org_type_code", "avetmiss_address_line1", "avetmiss_suburb", "avetmiss_postcode", "avetmiss_state_code",
    "avetmiss_contact_name", "avetmiss_contact_phone", "avetmiss_contact_email"] as Key[]).filter((k) => !values[k].trim()).length;

  const save = async () => {
    if (rowId === null) { push("The settings row could not be found.", "error"); return; }
    if (abnProblem) { push(abnProblem, "error"); return; }
    if (Object.keys(problems).length) { push("Fix the highlighted AVETMISS fields first.", "error"); return; }
    if (orgProblem) { push(orgProblem, "error"); return; }
    setBusy(true);
    const patch: Record<string, string | null> = Object.fromEntries(KEYS.map((k) => [k, values[k].trim() || null]));
    if (abn.trim() !== savedAbn.trim()) patch.abn = abn.trim() || null;
    for (const k of ORG_KEYS) if (org[k] !== savedOrg[k]) patch[k] = (k === "org_acn" ? org[k].replace(/\s/g, "") : org[k].trim()) || null;
    const { error: e } = await supabase.from("cms_settings").update(patch).eq("id", rowId);
    setBusy(false);
    if (e) { push(e.message.includes("check") ? `The database refused a value: ${e.message}` : e.message, "error"); return; }
    const trimmed = Object.fromEntries(KEYS.map((k) => [k, values[k].trim()])) as Values;
    const orgTrim = Object.fromEntries(ORG_KEYS.map((k) => [k, k === "org_acn" ? org[k].replace(/\s/g, "") : org[k].trim()])) as OrgValues;
    setOrg(orgTrim); setSavedOrg(orgTrim);
    setValues(trimmed); setSaved(trimmed); setAbn(abn.trim()); setSavedAbn(abn.trim()); push("AVETMISS and business details saved");
  };

  const text = (k: Key, label: string, extra: { hint?: string; type?: string; inputMode?: "numeric" } = {}) => (
    <Field label={label} hint={extra.hint}>
      <TextInput value={values[k]} type={extra.type} inputMode={extra.inputMode} maxLength={k === "avetmiss_toid" ? 10 : k === "avetmiss_postcode" ? 4 : MAX[k]}
        onChange={(e) => set(k, e.target.value)} aria-invalid={Boolean(problems[k])} className={problems[k] ? "border-red-400" : ""} data-testid={`avetmiss-${k}`} />
      {problems[k] ? <span className="mt-1 block text-xs text-red-700" role="alert">{problems[k]}</span> : null}
    </Field>
  );

  return (
    <Card className="p-5 xl:col-span-2">
      <div data-testid="avetmiss-org-settings">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-heading text-base font-semibold text-foreground-950">AVETMISS settings</h2>
            <p className="text-sm text-foreground-500">The training organisation details reported to NCVER (AVETMISS). Saved with their own Save button.</p>
          </div>
          <div className="flex items-center gap-2">
            {missing ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">{missing} missing</span> : null}
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty || rowId === null} data-testid="avetmiss-org-save">{busy ? "Saving…" : "Save details"}</Button>
          </div>
        </div>
        {error ? <p role="alert" className="mb-3 text-sm text-red-700">{error}</p> : null}
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="w-full max-w-xs">
            <Field label="ABN" hint="Look it up to fill the details below.">
              <TextInput value={abn} inputMode="numeric" maxLength={14} onChange={(e) => setAbn(e.target.value)} aria-invalid={Boolean(abnProblem)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void lookUp(); } }} className={abnProblem ? "border-red-400" : ""} data-testid="avetmiss-abn" />
              {abnProblem ? <span className="mt-1 block text-xs text-red-700" role="alert">{abnProblem}</span> : null}
            </Field>
          </div>
          <Button size="sm" variant="outline" onClick={() => void lookUp()} disabled={looking || abnDigits.length !== 11} data-testid="avetmiss-abn-lookup">{looking ? "Looking up…" : "Look up ABN"}</Button>
          {lookupNote ? <p className="w-full text-sm text-foreground-600" role="status" data-testid="avetmiss-abn-note">{lookupNote}</p> : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {text("avetmiss_toid", "Training organisation ID (TOID)", { hint: "Up to 10 letters or digits." })}
          {text("avetmiss_legal_name", "Legal name")}
          <Field label="Organisation type">
            <Select value={values.avetmiss_org_type_code} onChange={(e) => set("avetmiss_org_type_code", e.target.value)} data-testid="avetmiss-avetmiss_org_type_code">
              <option value="">Choose</option>
              {avetmissOptions(codes, "org_type", values.avetmiss_org_type_code).map((c) => <option key={c.code} value={c.code}>{c.label} ({c.code})</option>)}
            </Select>
          </Field>
          {text("avetmiss_address_line1", "Address line 1")}
          {text("avetmiss_address_line2", "Address line 2")}
          {text("avetmiss_suburb", "Suburb")}
          {text("avetmiss_postcode", "Postcode", { inputMode: "numeric" })}
          <Field label="State">
            <Select value={values.avetmiss_state_code} onChange={(e) => set("avetmiss_state_code", e.target.value)} data-testid="avetmiss-avetmiss_state_code">
              <option value="">Choose</option>
              {avetmissOptions(codes, "state", values.avetmiss_state_code).map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </Select>
          </Field>
          {text("avetmiss_contact_name", "Contact name")}
          {text("avetmiss_contact_phone", "Contact phone")}
          {text("avetmiss_contact_email", "Contact email", { type: "email" })}
        </div>
        {([["Business details from the ABN register", ABR_FIELDS], ["Business details from Google Maps", PLACE_FIELDS]] as const).map(([title, fields]) => (
          <section key={title} className="mt-6 border-t border-background-200 pt-4" data-testid={title.includes("Google") ? "org-place-fields" : "org-abr-fields"}>
            <h3 className="mb-3 text-sm font-semibold text-foreground-900">{title}</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map(([k, label]) => {
                const key = k as OrgKey;
                const link = (key === "org_place_maps_url" || key === "org_abr_url" || key === "org_place_website") && /^https?:\/\//.test(org[key]);
                return (
                  <Field key={key} label={label}>
                    {key.endsWith("_checked_at") ? <p className="py-2 text-sm text-foreground-700" data-testid={`org-${key}`}>{shownTime(org[key]) || "Not yet"}</p>
                      : <TextInput value={org[key]} type={ORG_DATE.has(key) ? "date" : "text"} readOnly={ORG_READONLY.has(key)} data-testid={`org-${key}`}
                          onChange={(e) => setOrg((x) => ({ ...x, [key]: e.target.value }))}
                          aria-invalid={key === "org_acn" && Boolean(orgProblem)} className={key === "org_acn" && orgProblem ? "border-red-400" : ""} />}
                    {key === "org_acn" && orgProblem ? <span className="mt-1 block text-xs text-red-700" role="alert">{orgProblem}</span> : null}
                    {link ? <a href={org[key]} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-medium text-primary-700 hover:underline">Open</a> : null}
                  </Field>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Card>
  );
}
