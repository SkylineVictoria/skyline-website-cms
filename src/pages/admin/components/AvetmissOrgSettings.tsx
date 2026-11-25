import { useEffect, useState } from "react";
import { Button, Card, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { supabase } from "@/pages/admin/lib/supabase";
import { avetmissOptions, useAvetmissCodes } from "@/lib/avetmissCodes";
import { lookupAbnDetails } from "@/lib/signingApi";

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

  useEffect(() => {
    void supabase.from("cms_settings").select(`id, abn, ${KEYS.join(", ")}`).order("id").limit(1).then(({ data, error: e }) => {
      if (e) { setError(e.message); return; }
      const row = ((data as unknown as (Record<string, string | null> & { id: number })[] | null)?.[0] ?? null);
      if (!row) return;
      const next = Object.fromEntries(KEYS.map((k) => [k, row[k] ?? ""])) as Values;
      setRowId(row.id); setValues(next); setSaved(next); setAbn(row.abn ?? ""); setSavedAbn(row.abn ?? "");
    });
  }, []);

  const problems = avetmissOrgProblems(values);
  const abnDigits = abn.replace(/\D/g, "");
  const abnProblem = abn.trim() && abnDigits.length !== 11 ? "An ABN has 11 digits." : "";
  const dirty = KEYS.some((k) => values[k] !== saved[k]) || abn.trim() !== savedAbn.trim();

  const lookUp = async () => {
    if (abnDigits.length !== 11) { setLookupNote("Enter the 11-digit ABN first."); return; }
    setLooking(true); setLookupNote("");
    try {
      const r = await lookupAbnDetails(abnDigits);
      if ("reason" in r) { setLookupNote(r.reason === "not_configured" ? "ABN Lookup is not set up yet (Integrations): fill the details in by hand." : r.message); return; }
      const d = r.details;
      const place = r.places?.ok ? r.places.place : undefined;
      const state = STATE_CODE[(place?.state || d.state || "").toUpperCase()] ?? "";
      const found: Partial<Values> = {
        avetmiss_legal_name: cut(d.entityName, MAX.avetmiss_legal_name),
        avetmiss_address_line1: cut(place?.street ?? "", MAX.avetmiss_address_line1),
        avetmiss_suburb: cut(place?.suburb ?? "", MAX.avetmiss_suburb),
        avetmiss_postcode: (place?.postcode || d.postcode || "").replace(/\D/g, "").slice(0, 4),
        avetmiss_state_code: state,
        avetmiss_contact_phone: cut(place?.phone ?? "", MAX.avetmiss_contact_phone),
      };
      const filled = Object.entries(found).filter(([, v]) => v) as [Key, string][];
      setValues((x) => ({ ...x, ...Object.fromEntries(filled) }));
      setAbn(d.abn || abn);
      const notes = [`${filled.length} detail${filled.length === 1 ? "" : "s"} filled from the ABN register${place ? " and Google Maps" : ""}. Check them, then Save.`];
      if (!d.active) notes.push(`The register shows this ABN as ${d.abnStatus || "not active"}.`);
      if (!place) notes.push(r.places?.configured ? "No office found on Google Maps: enter the street address by hand." : "Google Maps is not connected, so the street address is not filled.");
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
    setBusy(true);
    const patch: Record<string, string | null> = Object.fromEntries(KEYS.map((k) => [k, values[k].trim() || null]));
    if (abn.trim() !== savedAbn.trim()) patch.abn = abn.trim() || null;
    const { error: e } = await supabase.from("cms_settings").update(patch).eq("id", rowId);
    setBusy(false);
    if (e) { push(e.message.includes("check") ? `The database refused a value: ${e.message}` : e.message, "error"); return; }
    const trimmed = Object.fromEntries(KEYS.map((k) => [k, values[k].trim()])) as Values;
    setValues(trimmed); setSaved(trimmed); setAbn(abn.trim()); setSavedAbn(abn.trim()); push("AVETMISS organisation details saved");
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
            <h2 className="font-heading text-base font-semibold text-foreground-950">AVETMISS / NCVER</h2>
            <p className="text-sm text-foreground-500">The training organisation details reported to NCVER. Saved separately from the website settings.</p>
          </div>
          <div className="flex items-center gap-2">
            {missing ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">{missing} missing</span> : null}
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty || rowId === null} data-testid="avetmiss-org-save">{busy ? "Saving…" : "Save AVETMISS details"}</Button>
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
      </div>
    </Card>
  );
}
