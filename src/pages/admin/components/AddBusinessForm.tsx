import { normalizeAbn, validateAbn, type AgencyAbnDetails } from "../../../../supabase/functions/_shared/validation/abn";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { parseStoredPhone, validateStoredPhone } from "../../../../supabase/functions/_shared/validation/identifiers";
import { Button, Card, Field, TextInput } from "@/pages/admin/components/ui";
import { EMPTY_AGENCY_FORM, suggestAgencyCode, validateAgencyForm, type AgencyFormErrors, type AgencyFormState } from "@/pages/admin/lib/agencyForm";
import { createBusiness } from "@/pages/admin/lib/businessData";
import { validateName } from "@/pages/agency/lib/userValidation";
import { findAgencyByAbn, invokePortalUsers } from "@/pages/agency/lib/portalData";
import EmailField from "@/components/identity/EmailField";
import { isEmailTakenError } from "@/lib/identity/email";

type Errors = AgencyFormErrors & { form?: string };

export interface CreatedBusiness {
  agencyId: string;
  businessId: string | null;
  name: string;
  /** What happened, for a toast. */
  message: string;
}


/** Keeps only digits (at most 11) and groups them as an ABN is written: 12 345 678 901. */
function formatAbnInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  return [digits.slice(0, 2), digits.slice(2, 5), digits.slice(5, 8), digits.slice(8, 11)].filter(Boolean).join(" ");
}

/**
 * The one Add business form, used on Businesses > Add business and wherever a business is added on the way (new
 * application, add student). The administrator enters only the ABN; the government register fills and locks the
 * business details (Edit unlocks them). The business starts inactive with its point of contact recorded; it is activated
 * (and the contact invited) from the business screen once the signed agent agreement is in.
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

  const [form, setForm] = useState<AgencyFormState>(EMPTY_AGENCY_FORM);
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  // The contact's email is also the first administrator's invite email: an agent / portal login with it already is refused.
  const [emailError, setEmailError] = useState<unknown>(null);
  const [emailBlocking, setEmailBlocking] = useState(false);

  // Look the ABN up once it is complete and valid; a newer ABN discards an older response.
  useEffect(() => {
    setDetails(null); setExisting(null); setLookupError(""); setEditing(false);
    if (abnProblem) { setLookupLoading(false); return; }
    let cancelled = false;
    setLookupLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const [result, already] = await Promise.all([
          invokePortalUsers({ action: "lookup_agency_abn", abn }),
          findAgencyByAbn(abn),
        ]);
        if (cancelled) return;
        const business = result.business as AgencyAbnDetails | undefined;
        if (!business || business.abn !== abn || !business.legalName) throw new Error("The lookup returned an unexpected business. Try again.");
        setDetails(business);
        setExisting(already);
        setForm(prev => ({
          ...prev, registrationNumber: abn, name: business.legalName, code: suggestAgencyCode(business.legalName, suffix.current),
          country: "Australia", address: [business.state, business.postcode].filter(Boolean).join(" "), status: "Active",
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

  // Only an ABN the government register shows as active can be added.
  const abnInactive = Boolean(details && details.abn === abn && !/^active/i.test(details.abnStatus.trim()));
  const ready = Boolean(details && details.abn === abn && !existing && !abnInactive);

  const pickExisting = async () => {
    if (!existing || !onUseExisting) return;
    // The business is the agency record, so both ids are the same.
    onUseExisting({ agencyId: existing.id, businessId: existing.id, name: existing.name });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (saving || lookupLoading || emailBlocking) return;
    setEmailError(null);
    if (!ready) { setAbnTouched(true); setErrors({ registrationNumber: abnProblem || (abnInactive ? "This ABN is not active on the government register." : "Look up this ABN successfully before creating the business.") }); return; }
    const checked = validateAgencyForm({ ...form, registrationNumber: abn }, true);
    const next: Errors = { ...checked.errors };
    const contactName = validateName(form.primaryContact);
    if (contactName) next.primaryContact = contactName;
    // The same check as every other phone field: a country code plus a number valid for that country.
    if (!parseStoredPhone(form.phone)?.national) next.phone = "Enter the contact's phone number.";
    else { const phoneProblem = validateStoredPhone(form.phone); if (phoneProblem) next.phone = phoneProblem; else delete next.phone; }
    setErrors(next);
    if (Object.keys(next).some(key => next[key as keyof Errors])) {
      if (next.name || next.code || next.address || next.country) setEditing(true);
      return;
    }
    setSaving(true);
    try {
      // One transaction: the business (inactive until its agent agreement is signed) and its point of contact. Nothing is emailed yet.
      const email = form.businessEmail.trim().toLowerCase();
      const data = await createBusiness({
        name: form.name.trim(), code: form.code.trim(), registration_number: abn, business_email: email,
        phone: checked.phone, address: form.address.trim(), country: form.country.trim(), primary_contact: form.primaryContact.trim(),
      }, email, form.primaryContact.trim());
      const id = String(data.agencyId ?? "");
      if (!id) throw new Error("The business was created but could not be opened. Find it in Businesses.");
      const message = `Business added and waiting for onboarding. Upload or send the agent agreement for signature, then activate it to invite ${email}.`;
      onCreated({ agencyId: id, businessId: id, name: form.name.trim(), message });
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

  return (
    <form onSubmit={submit} noValidate>
      {box(<>
        <div className="max-w-md">
          <Field label="ABN" required hint={errors.registrationNumber || abnShownProblem ? undefined : `Enter the 11-digit ABN to look up the business (${abn.length} of 11 digits).`}>
            {/* Digits only, at most 11, grouped 2-3-3-3 as typed; pasted spaces, dashes and letters are dropped. */}
            <TextInput autoFocus disabled={saving} required inputMode="numeric" autoComplete="off" placeholder="12 345 678 901" value={abnInput}
              aria-invalid={Boolean(errors.registrationNumber || abnShownProblem)}
              onChange={e => { setAbnInput(formatAbnInput(e.target.value)); setErrors(prev => (prev.registrationNumber ? { ...prev, registrationNumber: undefined } : prev)); }}
              onBlur={() => setAbnTouched(true)} />
          </Field>
          {abnShownProblem ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{abnShownProblem}</p> : error("registrationNumber")}
          {abnInactive && details ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">This ABN is {details.abnStatus || "not active"} on the government register, so the business cannot be added.</p> : null}
        </div>
        <div className="mt-3 text-sm" aria-live="polite">
          {lookupLoading ? <p role="status" className="text-foreground-600">Looking up the ABN…</p> : null}
          {lookupError ? <p role="alert" className="text-red-700">{lookupError} <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>Retry lookup</button></p> : null}
          {existing ? (
            <p role="alert" className="text-red-700">
              {existing.name || "A business"} is already added with this ABN.{" "}
              {onUseExisting
                ? <button type="button" className="font-semibold underline" onClick={() => void pickExisting()}>Use this business</button>
                : <Link className="underline" to={`/admin/agencies/${existing.id}`}>Open it</Link>}
            </p>
          ) : null}
        </div>

        {ready && details ? (
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
                {input("address", "Address", "Street address, if known.")}
              </div>
            ) : (
              <dl className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                {lockedRow("Business name", form.name)}
                {lockedRow("Agency code", form.code)}
                {lockedRow("Country", form.country)}
                {lockedRow("Address", form.address)}
                {details.businessNames.length ? lockedRow("Registered business names", details.businessNames.join(", ")) : null}
                {lockedRow("ABN", details.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4"))}
              </dl>
            )}
          </section>
        ) : null}
      </>)}

      {ready ? box(<>
          <h2 className="font-heading text-base font-semibold">Point of contact</h2>
          <p className="mt-1 text-xs text-foreground-500">ABN Lookup does not supply contact details. This person becomes the business&rsquo;s administrator and receives the portal invitation.</p>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            {input("primaryContact", "Name", "The person at the business we deal with.", { required: true, autoComplete: "name" })}
            <div>
              <Field label="Email" hint={errors.businessEmail ? undefined : "Receives the administrator invitation."} required>
                <EmailField disabled={saving} required autoComplete="email" value={form.businessEmail} aria-invalid={Boolean(errors.businessEmail)}
                  onChange={(businessEmail) => patch({ businessEmail })} kind="agent" context="admin" serverError={emailError}
                  onStatusChange={(_status, blocking) => setEmailBlocking(blocking)} />
              </Field>
              {error("businessEmail")}
            </div>
            <div>
              {/* The shared phone control (country code + number, formatted as typed); it writes the E.164 value to a hidden input. */}
              <Field label="Phone" required hint={errors.phone ? undefined : "Choose the country code, then the number, for example 041 234 5678."}>
                <div onInput={(e) => { const target = e.target as HTMLInputElement; if (target.name === "poc_phone") patch({ phone: target.value }); }}>
                  <PhoneInput id="add-business-phone" name="poc_phone" value={form.phone} required locked={saving} placeholder="041 234 5678" />
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
    </form>
  );
}
