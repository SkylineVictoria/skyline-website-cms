import { normalizeAbn, validateAbn, type AgencyAbnDetails } from "../../../../supabase/functions/_shared/validation/abn";
import type { AbrDetails } from "../../../../supabase/functions/_shared/validation/abr";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { parseStoredPhone, validateStoredPhone } from "../../../../supabase/functions/_shared/validation/identifiers";
import { Button, Card, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import AdminPersonPicker, { type PersonSuggestion } from "@/pages/admin/components/AdminPersonPicker";
import { EMPTY_AGENCY_FORM, suggestAgencyCode, validateAgencyForm, type AgencyFormErrors, type AgencyFormState } from "@/pages/admin/lib/agencyForm";
import { createBusinessWithOnboarding, lookupAbnDetails, type AbnLookupResult, type BusinessAbrInput, type BusinessPlacesInput, type PlacesLookup } from "@/lib/signingApi";
import { placeAddressLine, type PlaceDetails } from "../../../../supabase/functions/_shared/google-places";
import { validateName } from "@/pages/agency/lib/userValidation";
import { findAgencyByAbn, invokePortalUsers } from "@/pages/agency/lib/portalData";
import EmailField from "@/components/identity/EmailField";
import { ruleText } from "@/lib/businessRules";
import { isEmailTakenError } from "@/lib/identity/email";
import OmaraAgentsPanel, { type AgentRecord, type OmaraSelection } from "@/pages/admin/components/OmaraAgentsPanel";
import { omaraLink, type OmaraFacts } from "@/lib/omaraApi";
import { BranchList, MapsSearchBox } from "@/pages/admin/components/OfficeLocations";
import { saveAdminMarn, saveOffices, type OfficeLocation } from "@/pages/admin/lib/offices";

type Errors = AgencyFormErrors & { form?: string; givenName?: string; familyName?: string; legalEntity?: string; tradingName?: string; postcode?: string; override?: string; officePostcode?: string; website?: string };

export interface CreatedBusiness {
  agencyId: string;
  businessId: string | null;
  name: string;
  /** What happened, for a toast. */
  message: string;
}

const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;
/** The register's values as staff confirm (and may edit) them before saving; they prefill the Agent Application Form. */
interface Confirmed { legalEntity: string; tradingName: string; otherName: boolean; gst: "yes" | "no" | ""; state: string; postcode: string; override: boolean; reason: string }
const EMPTY_CONFIRMED: Confirmed = { legalEntity: "", tradingName: "", otherName: false, gst: "", state: "", postcode: "", override: false, reason: "" };
type AbrFailure = Extract<AbnLookupResult, { ok: false }>;
/** The office details from Google Maps (2026-11-24), editable before saving; kept on the business and printed on the application form. */
type Office = Omit<BusinessPlacesInput, "source"> & { matchPercent: number };
const officeFrom = (p: PlaceDetails): Office => ({ street: p.street, suburb: p.suburb, state: p.state, postcode: p.postcode, country: p.country || "Australia", website: p.website,
  phone: p.phone, placeId: p.placeId, mapsUri: p.mapsUri, name: p.name, matchPercent: p.matchPercent });

/** Keeps only digits (at most 11) and groups them as an ABN is written: 12 345 678 901. */
function formatAbnInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  return [digits.slice(0, 2), digits.slice(2, 5), digits.slice(5, 8), digits.slice(8, 11)].filter(Boolean).join(" ");
}

/**
 * The one Add business form, used on Businesses > Add business and wherever a business is added on the way (new
 * application, add student). The administrator enters the ABN; the government register fills the business details.
 *
 * ABN prefill (2026-11-19): when ABN Lookup (the ABR web service) is set up, the register's legal name, business names, GST status and
 * state / postcode are shown to confirm and edit before saving (a business with several registered names picks its trading name); they and
 * the contact's names prefill the Agent Application Form. A cancelled ABN needs a reason to be added; when the register does not answer the
 * business can still be added by hand (the form then goes without the prefill). Not set up: the earlier lookup and form, unchanged.
 */
export default function AddBusinessForm({ onCreated, onUseExisting, cancel, inDialog = false }: {
  onCreated: (created: CreatedBusiness) => void;
  /** When given, a business already added with this ABN can be picked instead of only opened. */
  onUseExisting?: (existing: { agencyId: string; businessId: string | null; name: string }) => void;
  cancel: ReactNode;
  inDialog?: boolean;
}) {
  const suffix = useRef(Math.floor(100 + Math.random() * 900));

  const [abnInput, setAbnInput] = useState("");
  const [abnTouched, setAbnTouched] = useState(false);
  const abn = normalizeAbn(abnInput);
  const abnProblem = validateAbn(abn);
  // Shown while typing: a full ABN with wrong check digits; after leaving the field: too few digits.
  const abnShownProblem = abn.length === 11 ? abnProblem : abnTouched && abn.length > 0 ? `An ABN has 11 digits; ${abn.length} entered.` : "";
  const [details, setDetails] = useState<AgencyAbnDetails | null>(null);
  const [existing, setExisting] = useState<{ id: string; name: string } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [retry, setRetry] = useState(0);
  // ABN prefill: "abr" once the ABR service answered as set up, "legacy" when it is not set up (or not deployed yet).
  const [mode, setMode] = useState<"abr" | "legacy" | null>(null);
  const [abr, setAbr] = useState<AbrDetails | null>(null);
  const [abrFailure, setAbrFailure] = useState<AbrFailure | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmed>(EMPTY_CONFIRMED);
  // Full name (owner 2026-11-24): one searchable box; the application form still gets given and family names (last word = family name).
  const [fullName, setFullName] = useState("");
  const nameWords = fullName.trim().split(/\s+/).filter(Boolean);
  const givenName = nameWords.length > 1 ? nameWords.slice(0, -1).join(" ") : (nameWords[0] ?? "");
  const familyName = nameWords.length > 1 ? nameWords[nameWords.length - 1] : "";
  const [omaraAgents, setOmaraAgents] = useState<AgentRecord[]>([]);
  // The PhoneInput keeps its own text: a new key shows a picked person's phone.
  const [phoneKey, setPhoneKey] = useState(0);
  // "This person will be the Admin" popup: on picking / adding a person, and again on Create when the person changed since.
  const [adminAsk, setAdminAsk] = useState<null | { then: "none" | "submit" }>(null);
  const [adminConfirmedFor, setAdminConfirmedFor] = useState("");
  // The picked registered agent's MARN (kept on the business for the application form) and whether the best match was filled in by itself.
  const [adminMarn, setAdminMarn] = useState("");
  const [adminAuto, setAdminAuto] = useState<null | { confidence: number }>(null);
  // Google Maps: the office found for this ABN (null: none / not set up), and a note when it was looked for and not found.
  const [office, setOffice] = useState<Office | null>(null);
  const [officeNote, setOfficeNote] = useState("");
  // Search Google Maps by hand (2026-11-24): another branch / office when the one found is wrong or none was found.
  const [mapsOn, setMapsOn] = useState(false);
  const [mapsOpen, setMapsOpen] = useState(false);
  const [branches, setBranches] = useState<OfficeLocation[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const [headOpen, setHeadOpen] = useState(false);
  // OMARA (2026-11-24): what the register search uses (set once per lookup, so editing the form does not search again) and the agents ticked.
  const [omaraFacts, setOmaraFacts] = useState<OmaraFacts | null>(null);
  const [omaraSel, setOmaraSel] = useState<OmaraSelection>({ marns: [], evidence: {} });

  const [form, setForm] = useState<AgencyFormState>(EMPTY_AGENCY_FORM);
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  // The contact's email is also the first administrator's invite email: an agent / portal login with it already is refused.
  const [emailError, setEmailError] = useState<unknown>(null);
  const [emailBlocking, setEmailBlocking] = useState(false);

  // Look the ABN up once it is complete and valid (Fetch from ABN and leaving the field look it up again); a newer ABN discards an older answer.
  useEffect(() => {
    setDetails(null); setExisting(null); setLookupError(""); setEditing(false); setAbr(null); setAbrFailure(null); setOffice(null); setOfficeNote("");
    setMapsOn(false); setMapsOpen(false); setBranches([]);
    setOmaraFacts(null); setOmaraSel({ marns: [], evidence: {} });
    if (abnProblem) { setLookupLoading(false); return; }
    let cancelled = false;
    setLookupLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        // The ABR service first; a function without it (not deployed yet) or without a GUID answers "not set up": the earlier lookup runs.
        const [abrResult, already] = await Promise.all([lookupAbnDetails(abn).catch(() => null), findAgencyByAbn(abn)]);
        if (cancelled) return;
        // Google Maps beside the ABN lookup: the office address, website and phone (never the key: the function looks it up).
        const places: PlacesLookup | undefined = abrResult?.places;
        const found = places?.ok && places.place ? officeFrom(places.place) : null;
        setOffice(found);
        setMapsOn(Boolean(places?.configured));
        setOfficeNote(places?.configured && !found ? places.message || "Not found on Google Maps: the agency fills in the office address." : "");
        if (abrResult?.configured) {
          setMode("abr");
          setExisting(already);
          if (abrResult.ok) {
            const d = abrResult.details;
            const trading = d.businessNames[0] ?? d.entityName;
            setAbr(d);
            setOmaraFacts({ abn, names: [trading, d.entityName, ...d.businessNames].filter(Boolean), website: found?.website || null,
              postcode: found?.postcode || d.postcode || null, state: found?.state || d.state || null });
            setConfirmed({ legalEntity: d.entityName, tradingName: trading, otherName: false, gst: d.gstRegistered ? "yes" : "no", state: d.state, postcode: d.postcode, override: false, reason: "" });
            setForm(prev => ({ ...prev, registrationNumber: abn, name: trading, code: suggestAgencyCode(trading, suffix.current), country: "Australia",
              address: (found && placeAddressLine(found)) || [d.state, d.postcode].filter(Boolean).join(" "), status: "Active" }));
          } else {
            setAbrFailure(abrResult);
            // The register did not answer: the business can be added by hand, without the prefill.
            if (abrResult.reason === "unavailable") { setForm(prev => ({ ...prev, registrationNumber: abn, country: prev.country || "Australia", status: "Active" })); setEditing(true); }
          }
          setErrors({});
          return;
        }
        setMode("legacy");
        const result = await invokePortalUsers({ action: "lookup_agency_abn", abn });
        if (cancelled) return;
        const business = result.business as AgencyAbnDetails | undefined;
        if (!business || business.abn !== abn || !business.legalName) throw new Error("The lookup returned an unexpected business. Try again.");
        setDetails(business);
        setOmaraFacts({ abn, names: [business.legalName, ...business.businessNames].filter(Boolean), website: found?.website || null,
          postcode: found?.postcode || business.postcode || null, state: found?.state || business.state || null });
        setExisting(already);
        setForm(prev => ({
          ...prev, registrationNumber: abn, name: business.legalName, code: suggestAgencyCode(business.legalName, suffix.current),
          country: "Australia", address: (found && placeAddressLine(found)) || [business.state, business.postcode].filter(Boolean).join(" "), status: "Active",
        }));
        setErrors({});
      } catch (error) {
        if (!cancelled) setLookupError(error instanceof Error ? error.message : "ABN Lookup is unavailable. Try again.");
      } finally {
        if (!cancelled) setLookupLoading(false);
      }
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [abn, abnProblem, retry]);

  const patch = (next: Partial<AgencyFormState>) => setForm(prev => {
    const merged = { ...prev, ...next };
    // The code follows the name until the administrator edits it.
    if (next.name !== undefined && prev.code === suggestAgencyCode(prev.name, suffix.current)) merged.code = next.name.trim() ? suggestAgencyCode(next.name, suffix.current) : "";
    return merged;
  });
  // The trading name is also the agency's name (as staff see it) until that is edited.
  const setTrading = (tradingName: string, otherName = confirmed.otherName) => {
    setConfirmed(prev => ({ ...prev, tradingName, otherName }));
    if (form.name === confirmed.tradingName) patch({ name: tradingName });
  };

  // Legacy (no ABR service): only an ABN the government register shows as active can be added.
  const abnInactive = Boolean(details && details.abn === abn && !/^active/i.test(details.abnStatus.trim()));
  const legacyReady = Boolean(details && details.abn === abn && !existing && !abnInactive);
  // ABR: an active ABN, a cancelled one with a reason, or the register not answering (details typed by hand).
  const abrManual = mode === "abr" && abrFailure?.reason === "unavailable";
  // Business Rules (agents.cancelled_abn_business): a cancelled ABN is added with a reason, or not at all (the server refuses it too).
  const cancelledAllowed = ruleText("agents.cancelled_abn_business", "Allowed with a reason") !== "Not allowed";
  const abrReady = mode === "abr" && !existing && ((abr !== null && abr.abn === abn && (abr.active || (cancelledAllowed && confirmed.override))) || abrManual);
  const ready = mode === "abr" ? abrReady : legacyReady;

  const pickExisting = async () => {
    if (!existing || !onUseExisting) return;
    // The business is the agency record, so both ids are the same.
    onUseExisting({ agencyId: existing.id, businessId: existing.id, name: existing.name });
  };

  const adminKey = `${fullName.trim().toLowerCase()}|${form.businessEmail.trim().toLowerCase()}`;
  const toE164 = (phone: string) => {
    const t = phone.trim();
    if (!t) return "";
    const digits = t.replace(/\D/g, "");
    if (t.startsWith("+")) return `+${digits}`;
    if (digits.startsWith("61")) return `+${digits}`;
    if (digits.startsWith("0")) return `+61${digits.slice(1)}`;
    return "";
  };
  const suggestions: PersonSuggestion[] = omaraAgents.map(a => ({ fullName: a.fullName, email: a.email, phone: a.phone, marn: a.marn,
    note: [`${a.confidence}% match`, [a.suburb, a.state].filter(Boolean).join(" ")].filter(Boolean).join(" · ") }));
  const pickPerson = (person: PersonSuggestion) => {
    setFullName(person.fullName); setAdminMarn(person.marn ?? ""); setAdminAuto(null);
    patch({ businessEmail: person.email || form.businessEmail, phone: toE164(person.phone) || form.phone, ...(mode !== "abr" ? { primaryContact: person.fullName } : {}) });
    setPhoneKey(k => k + 1);
    setAdminAsk({ then: "none" });
  };
  const addNewPerson = (name: string) => {
    setFullName(name); setAdminMarn(""); setAdminAuto(null);
    patch({ businessEmail: "", phone: "", ...(mode !== "abr" ? { primaryContact: name } : {}) });
    setPhoneKey(k => k + 1);
    setAdminAsk({ then: "none" });
  };
  // Fill all we can (owner 2026-11-24: "so we don't need to fill up the form manually"): the best-matching registered agent with an email
  // or phone becomes the suggested Admin, once, only while the contact is still empty; Create still asks to confirm.
  useEffect(() => {
    if (fullName.trim() || form.businessEmail.trim() || adminConfirmedFor) return;
    const best = omaraAgents.find(a => a.likely && (a.email || a.phone));
    if (!best) return;
    setFullName(best.fullName); setAdminMarn(best.marn); setAdminAuto({ confidence: best.confidence });
    patch({ businessEmail: best.email || "", phone: toE164(best.phone), ...(mode !== "abr" ? { primaryContact: best.fullName } : {}) });
    setPhoneKey(k => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [omaraAgents]);
  const confirmAdmin = () => {
    const then = adminAsk?.then;
    setAdminConfirmedFor(adminKey);
    setAdminAsk(null);
    if (then === "submit") window.setTimeout(() => formRef.current?.requestSubmit(), 0);
    else if (!form.businessEmail) window.setTimeout(() => document.getElementById("add-business-email")?.focus(), 0);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (saving || lookupLoading || emailBlocking) return;
    setEmailError(null);
    if (!ready) {
      setAbnTouched(true);
      setErrors({ registrationNumber: abnProblem || (abnInactive ? "This ABN is not active on the government register."
        : mode === "abr" && abr && !abr.active ? (cancelledAllowed ? "This ABN is cancelled: tick Add it anyway and give the reason." : "This ABN is cancelled, and a business with a cancelled ABN cannot be added.") : abrFailure?.message || "Look up this ABN successfully before creating the business.") });
      return;
    }
    const contactName = mode === "abr" ? `${givenName.trim()} ${familyName.trim()}`.trim() : (fullName.trim() || form.primaryContact.trim());
    const checked = validateAgencyForm({ ...form, primaryContact: contactName, registrationNumber: abn }, true);
    const next: Errors = { ...checked.errors };
    if (mode === "abr") {
      if (!givenName.trim()) next.givenName = "Enter the admin's full name.";
      else if (!familyName.trim()) next.givenName = "Enter the first and last name.";
      if (!next.givenName && !next.familyName) { const problem = validateName(contactName); if (problem) next.givenName = problem; }
      if (abr) {
        if (!confirmed.legalEntity.trim()) next.legalEntity = "Enter the legal entity name.";
        if (!confirmed.tradingName.trim()) next.tradingName = "Choose or type the trading name.";
        if (confirmed.postcode && !/^\d{4}$/.test(confirmed.postcode.trim())) next.postcode = "A postcode has 4 digits.";
        if (!abr.active && confirmed.reason.trim().length < 5) next.override = "Say why this business is added although its ABN is cancelled.";
      }
    } else {
      const problem = validateName(fullName.trim() || form.primaryContact);
      if (problem) next.primaryContact = problem;
    }
    // The same check as every other phone field: a country code plus a number valid for that country.
    if (!parseStoredPhone(form.phone)?.national) next.phone = "Enter the contact's phone number.";
    else { const phoneProblem = validateStoredPhone(form.phone); if (phoneProblem) next.phone = phoneProblem; else delete next.phone; }
    if (office?.postcode && !/^\d{4}$/.test(office.postcode.trim())) next.officePostcode = "A postcode has 4 digits.";
    if (office?.website && !/^https?:\/\/\S+$/i.test(office.website.trim())) next.website = "Enter the website starting with https://, or leave it empty.";
    setErrors(next);
    if (Object.keys(next).some(key => next[key as keyof Errors])) {
      if (next.name || next.code || next.address || next.country) setEditing(true);
      return;
    }
    if (adminConfirmedFor !== adminKey) { setAdminAsk({ then: "submit" }); return; }
    setSaving(true);
    try {
      // One call (2026-11-19): the business (onboarding until an administrator activates it) and its point of contact are saved, and the
      // Agent Application Form goes to the contact at once. A missing blank is installed before anything is saved, so a retry adds nothing twice.
      const email = form.businessEmail.trim().toLowerCase();
      const abrInput: BusinessAbrInput | undefined = mode === "abr" && abr ? {
        legalEntity: confirmed.legalEntity.trim(), tradingName: confirmed.tradingName.trim(), gstRegistered: confirmed.gst === "" ? null : confirmed.gst === "yes",
        state: confirmed.state, postcode: confirmed.postcode.trim(), cancelledOverride: abr.active ? undefined : confirmed.reason.trim(), givenName: givenName.trim(), familyName: familyName.trim(),
      } : undefined;
      // The office details from Google Maps as staff left them: the business's address and, on its profile, the F04's office row and website.
      const officeInput: BusinessPlacesInput | undefined = office ? {
        street: office.street.trim(), suburb: office.suburb.trim(), state: office.state.trim(), postcode: office.postcode.trim(), country: office.country.trim(),
        website: office.website.trim(), phone: office.phone.trim(), placeId: office.placeId, mapsUri: office.mapsUri, name: office.name, source: "google",
      } : undefined;
      const address = (officeInput && placeAddressLine(officeInput)) || form.address.trim();
      const data = await createBusinessWithOnboarding({
        agency: {
          name: form.name.trim(), code: form.code.trim(), registration_number: abn, business_email: email,
          phone: checked.phone, address, country: form.country.trim(), primary_contact: contactName,
        },
        contactEmail: email, contactName, ...(abrInput ? { abr: abrInput } : {}), ...(officeInput ? { places: officeInput } : {}),
      });
      const id = String(data.agencyId ?? "");
      if (!id) throw new Error("The business was created but could not be opened. Find it in Businesses.");
      // 2026-11-20: nothing is emailed yet; the business page opens Prepare application (the pre-send step) to fill in and send the form.
      const message = data.warning
        ? `Business added. ${data.warning}`
        : `Business added. Nothing has been emailed yet: prepare the application (details, agreement terms, witness) and send it to ${email}.${data.abrWarning ? ` ${data.abrWarning}` : ""}`;
      // OMARA: the registered migration agents staff ticked are linked to the new business (never added as its agents).
      let omaraNote = "";
      // The Admin picked from the register is always linked, and their MARN kept for the application form.
      const linkMarns = [...new Set([...omaraSel.marns, ...(adminMarn ? [adminMarn] : [])])];
      const linkEvidence = { ...omaraSel.evidence };
      if (adminMarn && !linkEvidence[adminMarn]) {
        const a = omaraAgents.find(x => x.marn === adminMarn);
        if (a) linkEvidence[adminMarn] = { confidence: a.confidence, evidence: [...(a.evidence ?? []), "Business admin agent"] };
      }
      if (adminMarn) { try { await saveAdminMarn(id, adminMarn); } catch { /* staff type it on the application form */ } }
      if (linkMarns.length) {
        try { const n = await omaraLink(id, linkMarns, linkEvidence); omaraNote = ` ${n} registered migration agent${n === 1 ? "" : "s"} linked.`; }
        catch (linkError) { omaraNote = ` The registered migration agents were not linked (${linkError instanceof Error ? linkError.message : "error"}): link them from the business page.`; }
      }
      // Branches: saved on the new business (the head office went with the create call).
      let branchNote = "";
      const filled = branches.filter(b => b.street.trim() || b.suburb.trim());
      if (filled.length) {
        try { await saveOffices(id, null, filled); branchNote = ` ${filled.length} branch${filled.length === 1 ? "" : "es"} saved.`; }
        catch (branchError) { branchNote = ` The branches were not saved (${branchError instanceof Error ? branchError.message : "error"}): add them on the business page.`; }
      }
      onCreated({ agencyId: id, businessId: id, name: form.name.trim(), message: message + omaraNote + branchNote });
    } catch (e) {
      if (isEmailTakenError(e)) { setErrors({}); setEmailError(e); return; }
      const text = e instanceof Error ? e.message : "";
      setErrors({ form: /agencies_abn_unique|duplicate key|already exists/i.test(text) ? text.includes("code") ? "This agency code is already used. Edit the details and choose another code." : "A business with this ABN already exists. Open it from Businesses." : text || "We could not create this business." });
    } finally {
      setSaving(false);
    }
  };

  const error = (key: keyof Errors) => errors[key] ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{errors[key]}</p> : null;
  const input = (key: keyof AgencyFormState, label: string, hint: string, props: { required?: boolean; type?: string; placeholder?: string; autoComplete?: string } = {}) => (
    <div>
      <Field label={label} hint={errors[key] ? undefined : hint} required={props.required}>
        <TextInput disabled={saving} required={props.required} type={props.type} placeholder={props.placeholder} autoComplete={props.autoComplete}
          value={form[key]} aria-invalid={Boolean(errors[key])} onChange={e => patch({ [key]: e.target.value })} />
      </Field>
      {error(key)}
    </div>
  );
  const lockedRow = (label: string, value: string) => (
    <div>
      <dt className="text-xs font-medium text-green-800">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground-900">{value || "—"}</dd>
    </div>
  );
  // On a page each part is a card; inside a dialog the parts are plain sections.
  // A plain function (not a component), so the inputs inside keep their focus between renders.
  const box = (children: ReactNode, className = "") =>
    inDialog ? <section className={className}>{children}</section> : <Card className={`p-5 ${className}`}>{children}</Card>;

  // ABN prefill: what the register says, to confirm and edit before saving.
  const abrPanel = () => abr ? (
    <section className={`mt-4 rounded-lg border p-4 ${abr.active ? "border-green-300 bg-green-50" : "border-amber-300 bg-amber-50"}`} aria-label="Business details from ABN Lookup" data-testid="abr-details">
      <p className={`flex items-center gap-1.5 text-sm font-semibold ${abr.active ? "text-green-900" : "text-amber-900"}`}>
        <i className={abr.active ? "ri-shield-check-line" : "ri-error-warning-line"} aria-hidden="true" />From ABN Lookup: check this is the right business
      </p>
      <p className="mt-0.5 text-xs text-foreground-700">
        ABN {abr.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4")} · {abr.abnStatus}{abr.statusFrom ? ` from ${abr.statusFrom.split("-").reverse().join("/")}` : ""}
        {abr.entityType ? ` · ${abr.entityType}` : ""}{abr.acn ? ` · ACN ${abr.acn}` : ""}
        {" · "}<a href={abr.sourceUrl} target="_blank" rel="noreferrer" className="underline">Government record</a>
      </p>
      {!abr.active ? <div className="mt-3 rounded-md border border-amber-300 bg-white p-3 text-sm" role="alert">
        <p className="font-medium text-amber-900">This ABN is {abr.abnStatus.toLowerCase() || "not active"} on the government register.</p>
        {cancelledAllowed ? <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={confirmed.override} disabled={saving} onChange={e => setConfirmed(prev => ({ ...prev, override: e.target.checked }))} data-testid="abr-override" />Add it anyway</label>
          : <p className="mt-1 text-amber-900" data-testid="abr-cancelled-blocked">A business with a cancelled ABN cannot be added (Business Rules).</p>}
        {cancelledAllowed && confirmed.override ? <Field label="Reason" required hint="Kept on the business's history."><TextArea rows={2} value={confirmed.reason} disabled={saving} maxLength={500} onChange={e => setConfirmed(prev => ({ ...prev, reason: e.target.value }))} /></Field> : null}
        {error("override")}
      </div> : null}
      <p className="mt-3 text-xs text-foreground-600">These values prefill the Agent Application Form. Change any of them if the register is out of date; the contact can also correct them before signing.</p>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Field label="Legal entity name" required hint={errors.legalEntity ? undefined : "The register's entity name."}>
            <TextInput disabled={saving} value={confirmed.legalEntity} onChange={e => setConfirmed(prev => ({ ...prev, legalEntity: e.target.value }))} aria-invalid={Boolean(errors.legalEntity)} />
          </Field>{error("legalEntity")}
        </div>
        <div>
          {abr.businessNames.length > 1 ? (
            <fieldset data-testid="abr-trading-names">
              <legend className="text-label font-medium text-foreground-800">Trading name <span className="text-red-600">*</span></legend>
              <p className="text-xs text-foreground-500">The register lists {abr.businessNames.length} business names; choose the one this business trades as.</p>
              <div className="mt-1 space-y-1">
                {abr.businessNames.map(n => <label key={n} className="flex items-center gap-2 text-sm"><input type="radio" name="abr-trading" disabled={saving} checked={!confirmed.otherName && confirmed.tradingName === n} onChange={() => setTrading(n, false)} />{n}</label>)}
                <label className="flex items-center gap-2 text-sm"><input type="radio" name="abr-trading" disabled={saving} checked={confirmed.otherName} onChange={() => setTrading(confirmed.tradingName, true)} />Another name</label>
                {confirmed.otherName ? <TextInput disabled={saving} value={confirmed.tradingName} onChange={e => setTrading(e.target.value, true)} aria-label="Trading name" /> : null}
              </div>
            </fieldset>
          ) : (
            <Field label="Trading name" required hint={errors.tradingName ? undefined : abr.businessNames.length ? "The registered business name." : "No business name is registered: the entity name is used."}>
              <TextInput disabled={saving} value={confirmed.tradingName} onChange={e => setTrading(e.target.value)} aria-invalid={Boolean(errors.tradingName)} />
            </Field>
          )}
          {error("tradingName")}
        </div>
        <Field label="GST registered">
          <Select disabled={saving} value={confirmed.gst} onChange={e => setConfirmed(prev => ({ ...prev, gst: e.target.value as Confirmed["gst"] }))} data-testid="abr-gst">
            <option value="yes">Yes{abr.gstRegistered && abr.gstFrom ? ` (from ${abr.gstFrom.split("-").reverse().join("/")})` : ""}</option><option value="no">No</option><option value="">Leave for the contact</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Select disabled={saving} value={confirmed.state} onChange={e => setConfirmed(prev => ({ ...prev, state: e.target.value }))}>
              <option value="">—</option>{STATES.map(st => <option key={st} value={st}>{st}</option>)}
            </Select>
          </Field>
          <div>
            <Field label="Postcode"><TextInput disabled={saving} inputMode="numeric" maxLength={4} value={confirmed.postcode} onChange={e => setConfirmed(prev => ({ ...prev, postcode: e.target.value.replace(/\D/g, "").slice(0, 4) }))} aria-invalid={Boolean(errors.postcode)} /></Field>
            {error("postcode")}
          </div>
        </div>
        {input("name", "Agency name", "How the business appears to staff and on applications (the trading name unless changed).", { required: true })}
        {input("code", "Agency code", "A short unique code, for example GPE-001.", { required: true })}
      </div>
    </section>
  ) : null;

  // Google Maps (2026-11-24): the office found for this business, to confirm and edit; a link to the place so staff can check it is the right one.
  const setOfficeField = (key: keyof Office, value: string) => setOffice(prev => (prev ? { ...prev, [key]: value } : prev));
  const officeInputBox = (key: "street" | "suburb" | "postcode" | "country" | "website" | "phone", label: string, props: { inputMode?: "numeric" | "url" | "tel"; maxLength?: number } = {}) => (
    <Field label={label}><TextInput disabled={saving} inputMode={props.inputMode} maxLength={props.maxLength} value={office?.[key] ?? ""} onChange={e => setOfficeField(key, key === "postcode" ? e.target.value.replace(/\D/g, "").slice(0, 4) : e.target.value)} /></Field>
  );
  const mapsHint = form.name || confirmed.tradingName || details?.businessNames?.[0] || details?.legalName || "";
  const pickPlace = (p: PlaceDetails) => {
    setOffice(officeFrom(p)); setOfficeNote(""); setMapsOpen(false);
    if (p.street || p.suburb) setForm(prev => ({ ...prev, address: placeAddressLine(p) || prev.address }));
  };
  const mapsSearch = () => !mapsOn ? null : !mapsOpen ? (
    <Button type="button" variant="secondary" icon="ri-search-line" disabled={saving} onClick={() => setMapsOpen(true)} data-testid="places-search-open">
      {office ? "Change head office with Google Maps" : "Search Google Maps"}
    </Button>
  ) : <div className="mt-3"><MapsSearchBox id="places-search-input" initialQuery={[mapsHint, office?.suburb].filter(Boolean).join(" ")} disabled={saving} used={branches} onPick={pickPlace} onCancel={() => setMapsOpen(false)} /></div>;
  // Branches (2026-11-24): a business with several locations adds each one (Google Maps or by hand); saved on the business after it is created.
  const branchesPanel = () => (abr || details) ? (
    <section className="mt-2 rounded-lg border border-background-200 px-3 py-2" aria-label="Branches" data-testid="add-business-branches">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground-900"><i className="ri-store-2-line text-sky-700" aria-hidden="true" />Branches {branches.length ? `(${branches.length})` : ""}
        <span className="font-normal text-xs text-foreground-500">optional; also on the business page later</span></p>
      <BranchList branches={branches} onChange={setBranches} disabled={saving} searchHint={mapsHint} head={office ? { ...office } : null} />
    </section>
  ) : null;
  // Office suburbs for the registered-agent search (Discover again searches the brand at each office).
  const officePlaces = [...new Set([office?.suburb, ...branches.map(b => b.suburb)].map(p => (p ?? "").trim()).filter(Boolean))];
  const headEditOpen = headOpen || Boolean(errors.officePostcode || errors.website);
  const officePanel = () => office ? (
    <section className="mt-4 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2" aria-label="Office details from Google Maps" data-testid="places-details">
      {/* Compact (owner 2026-11-24): the head office on one line; Edit opens its fields (open by itself when one needs fixing). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <i className="ri-building-line text-sky-800" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate"><span className="font-semibold text-sky-950">Head office</span>
          <span className="text-sky-900"> · {placeAddressLine(office) || office.suburb || "No address yet"}{office.phone ? ` · ${office.phone}` : ""}</span></p>
        {office.mapsUri ? <a href={office.mapsUri} target="_blank" rel="noreferrer" className="text-xs text-sky-800 underline" data-testid="places-link">Open in Google Maps</a> : null}
        <button type="button" disabled={saving} className="text-xs font-semibold text-primary-700 hover:underline" onClick={() => setHeadOpen(v => !v)} aria-expanded={headEditOpen}>{headEditOpen ? "Close" : "Edit"}</button>
        <button type="button" disabled={saving} className="text-xs font-semibold text-red-700 hover:underline" onClick={() => { setOffice(null); if (mapsOn) setMapsOpen(true); }} data-testid="places-discard">Not this business</button>
        {mapsOpen || !mapsOn ? null : <button type="button" disabled={saving} className="text-xs font-semibold text-primary-700 hover:underline" onClick={() => setMapsOpen(true)} data-testid="places-search-open">Change</button>}
      </div>
      {headEditOpen ? <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        {officeInputBox("street", "Street address")}
        {officeInputBox("suburb", "Suburb")}
        <Field label="State">
          <Select disabled={saving} value={office.state} onChange={e => setOfficeField("state", e.target.value)}>
            <option value="">—</option>{STATES.map(st => <option key={st} value={st}>{st}</option>)}
          </Select>
        </Field>
        <div>{officeInputBox("postcode", "Postcode", { inputMode: "numeric", maxLength: 4 })}{error("officePostcode")}</div>
        <div>{officeInputBox("website", "Website", { inputMode: "url" })}{error("website")}</div>
        {officeInputBox("phone", "Business phone", { inputMode: "tel" })}
      </div> : null}
      {mapsOpen ? mapsSearch() : null}
    </section>
  ) : (abr || details) && (officeNote || mapsOn) ? <div className="mt-3 space-y-2">
    {officeNote ? <p className="text-xs text-foreground-500" data-testid="places-note"><i className="ri-map-pin-line" aria-hidden="true" /> {officeNote}</p> : null}
    {mapsSearch()}
  </div> : null;

  return (
    <form ref={formRef} onSubmit={submit} noValidate>
      {box(<>
        <div className="max-w-md">
          <Field label="ABN" required hint={errors.registrationNumber || abnShownProblem ? undefined : `Enter the 11-digit ABN to look up the business (${abn.length} of 11 digits).`}>
            {/* Digits only, at most 11, grouped 2-3-3-3 as typed; pasted spaces, dashes and letters are dropped. */}
            <div className="flex gap-2">
              <TextInput autoFocus disabled={saving} required inputMode="numeric" autoComplete="off" placeholder="12 345 678 901" value={abnInput}
                aria-invalid={Boolean(errors.registrationNumber || abnShownProblem)}
                onChange={e => { setAbnInput(formatAbnInput(e.target.value)); setErrors(prev => (prev.registrationNumber ? { ...prev, registrationNumber: undefined } : prev)); }}
                onBlur={() => { setAbnTouched(true); if (!abnProblem && !lookupLoading && !abr && !details && (lookupError || abrFailure?.reason === "unavailable")) setRetry(n => n + 1); }} />
              <Button type="button" variant="secondary" icon="ri-search-line" disabled={saving || lookupLoading || Boolean(abnProblem)} onClick={() => setRetry(n => n + 1)} data-testid="abn-fetch">Fetch from ABN</Button>
            </div>
          </Field>
          {abnShownProblem ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{abnShownProblem}</p> : error("registrationNumber")}
          {abnInactive && details ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">This ABN is {details.abnStatus || "not active"} on the government register, so the business cannot be added.</p> : null}
        </div>
        <div className="mt-3 text-sm" aria-live="polite">
          {lookupLoading ? <p role="status" className="text-foreground-600">Looking up the ABN…</p> : null}
          {lookupError ? <p role="alert" className="text-red-700">{lookupError} <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>Retry lookup</button></p> : null}
          {abrFailure && abrFailure.reason !== "invalid" ? <p role="alert" className={abrFailure.reason === "unavailable" ? "text-amber-800" : "text-red-700"} data-testid="abr-failure">{abrFailure.message}{" "}
            <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>Try again</button></p> : null}
          {existing ? (
            <p role="alert" className="text-red-700">
              {existing.name || "A business"} is already added with this ABN.{" "}
              {onUseExisting
                ? <button type="button" className="font-semibold underline" onClick={() => void pickExisting()}>Use this business</button>
                : <Link className="underline" to={`/admin/agencies/${existing.id}`}>Open it</Link>}
            </p>
          ) : null}
        </div>

        {mode === "abr" && !existing ? abrPanel() : null}
        {mode === "abr" && !existing && abr ? <>{officePanel()}{branchesPanel()}</> : null}
        {mode === "abr" && !existing && abr && omaraFacts ? <OmaraAgentsPanel mode="select" facts={omaraFacts} disabled={saving} onSelection={setOmaraSel} onFound={setOmaraAgents} places={officePlaces} /> : null}
        {abrManual && !existing ? (
          <section className="mt-4 rounded-lg border border-background-300 bg-background-50 p-4" aria-label="Business details typed by hand">
            <p className="text-sm font-semibold text-foreground-900">Business details (typed by hand)</p>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              {input("name", "Business name", "As it appears to staff and on applications.", { required: true })}
              {input("code", "Agency code", "A short unique code, for example GPE-001.", { required: true })}
              {input("country", "Country", "Where the business is based.")}
              {input("address", "Address", "Street address, if known.")}
            </div>
          </section>
        ) : null}

        {mode !== "abr" && legacyReady && details ? (
          <section className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4" aria-label="Business details from ABN Lookup">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-semibold text-green-900">
                  <i className={editing ? "ri-edit-line" : "ri-lock-line"} aria-hidden="true" />
                  {editing ? "Editing business details" : "Verified from ABN Lookup"}
                </p>
                <p className="mt-0.5 text-xs text-green-800">
                  {details.abnStatus}{details.entityType ? ` · ${details.entityType}` : ""}{details.gstStatus ? ` · GST: ${details.gstStatus}` : ""}
                  {" · "}<a href={details.sourceUrl} target="_blank" rel="noreferrer" className="underline">Government record</a>
                </p>
              </div>
              <Button type="button" variant="secondary" icon={editing ? "ri-lock-line" : "ri-edit-line"} disabled={saving} onClick={() => setEditing(v => !v)}>
                {editing ? "Done" : "Edit"}
              </Button>
            </div>
            {editing ? (
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                {input("name", "Business name", details.businessNames.length ? `Registered names: ${details.businessNames.join(", ")}` : "As it appears to staff and on applications.", { required: true })}
                {input("code", "Agency code", "A short unique code, for example GPE-001.", { required: true })}
                {input("country", "Country", "Where the business is based.")}
                {office ? null : input("address", "Address", "Street address, if known.")}
              </div>
            ) : (
              <dl className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                {lockedRow("Business name", form.name)}
                {lockedRow("Agency code", form.code)}
                {lockedRow("Country", form.country)}
                {office ? null : lockedRow("Address", form.address)}
                {details.businessNames.length ? lockedRow("Registered business names", details.businessNames.join(", ")) : null}
                {lockedRow("ABN", details.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4"))}
              </dl>
            )}
          </section>
        ) : null}
        {mode !== "abr" && legacyReady && details ? <>{officePanel()}{branchesPanel()}</> : null}
        {mode !== "abr" && legacyReady && details && omaraFacts ? <OmaraAgentsPanel mode="select" facts={omaraFacts} disabled={saving} onSelection={setOmaraSel} onFound={setOmaraAgents} places={officePlaces} /> : null}
      </>)}

      {ready ? box(<>
          <h2 className="font-heading text-base font-semibold">Business admin agent (point of contact)</h2>
          <p className="mt-1 text-xs text-foreground-500">ABN Lookup does not supply contact details. This person becomes the business&rsquo;s first agent, as its business admin agent. The email and mobile below are theirs and are saved on their agent record; their sign-in invitation goes to this email once the business is activated.</p>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Field label="Full name" required hint={errors.givenName || errors.primaryContact ? undefined : omaraAgents.length
                ? `Type to search the ${omaraAgents.length} registered agent${omaraAgents.length === 1 ? "" : "s"} found above (fills email and phone), or add a new person.`
                : "First and last name, printed on the application form."}>
                <AdminPersonPicker id="add-business-full-name" value={fullName} suggestions={suggestions} disabled={saving} invalid={Boolean(errors.givenName || errors.primaryContact)}
                  onName={name => { setFullName(name); setAdminAuto(null); if (adminMarn && name.trim().toLowerCase() !== fullName.trim().toLowerCase()) setAdminMarn(""); if (mode !== "abr") patch({ primaryContact: name }); }}
                  onPick={pickPerson} onAddNew={addNewPerson} />
              </Field>{error("givenName")}{error("primaryContact")}
              {adminAuto ? <p className="mt-1 text-xs text-emerald-800" data-testid="admin-autofilled"><i className="ri-magic-line mr-1" aria-hidden="true" />Filled from the best match ({adminAuto.confidence}%) on the register. Check it, or search for someone else.</p> : null}
              {adminMarn ? <p className="mt-1 text-xs text-foreground-600">MARN {adminMarn}: printed on the application form.</p> : null}
            </div>
            <div>
              <Field label="Their email" hint={errors.businessEmail ? undefined : "Their own email. Nothing is emailed when you add the business: you prepare the application next, and it goes to this email only when you press Send. The sign-in link follows after activation."} required>
                <EmailField id="add-business-email" disabled={saving} required autoComplete="email" value={form.businessEmail} aria-invalid={Boolean(errors.businessEmail)}
                  onChange={(businessEmail) => patch({ businessEmail })} kind="agent" context="admin" serverError={emailError}
                  onStatusChange={(_status, blocking) => setEmailBlocking(blocking)} />
              </Field>
              {error("businessEmail")}
            </div>
            <div>
              {/* The shared phone control (country code + number, formatted as typed); it writes the E.164 value to a hidden input. */}
              <Field label="Their mobile" required hint={errors.phone ? undefined : "Their own number, saved on their agent record. Choose the country code, then the number, for example 041 234 5678."}>
                <div onInput={(e) => { const target = e.target as HTMLInputElement; if (target.name === "poc_phone") patch({ phone: target.value }); }}>
                  <PhoneInput key={phoneKey} id="add-business-phone" name="poc_phone" value={form.phone} required locked={saving} placeholder="041 234 5678" />
                </div>
              </Field>
              {error("phone")}
            </div>
          </div>
      </>, inDialog ? "mt-5 border-t border-background-200 pt-4" : "mt-5") : null}

      {errors.form ? <p role="alert" className="mt-4 text-sm font-medium text-red-700">{errors.form}</p> : null}
      <div className={`mt-5 flex items-center gap-3 ${inDialog ? "justify-end" : ""}`}>
        {inDialog ? cancel : null}
        <Button type="submit" icon="ri-save-line" disabled={saving || lookupLoading || !ready || emailBlocking}>{saving ? "Creating…" : "Create business"}</Button>
        {inDialog ? null : cancel}
      </div>
      <Modal open={!!adminAsk} title="This person will be the Admin" onClose={() => setAdminAsk(null)} footer={<div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => { setAdminAsk(null); window.setTimeout(() => document.getElementById("add-business-full-name")?.focus(), 0); }}>Choose someone else</Button>
        <Button type="button" icon="ri-shield-user-line" onClick={confirmAdmin} data-testid="admin-confirm">{adminAsk?.then === "submit" ? "Yes, create the business" : "Yes, make them the Admin"}</Button>
      </div>}>
        <div className="space-y-2 text-sm text-foreground-700">
          <p><strong>{fullName.trim() || "This person"}</strong> will be this business&rsquo;s <strong>Admin</strong> (business admin agent and point of contact).</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>They receive the agent application form when you press Send.</li>
            <li>After the business is activated they get the sign-in invitation and can add the business&rsquo;s other agents.</li>
          </ul>
          {form.businessEmail || form.phone ? <p className="text-xs text-foreground-600">{[form.businessEmail, form.phone].filter(Boolean).join(" · ")}</p>
            : <p className="text-xs text-foreground-600">Add their email and mobile next.</p>}
        </div>
      </Modal>
    </form>
  );
}
