import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/pages/admin/components/ui";
import { PhoneInput } from "@/components/feature/applicationInputs";
import AddressFields from "@/components/shared/wizard/AddressFields";
import AddressSearch, { type AddressPick } from "@/components/shared/wizard/AddressSearch";
import { DocumentChecklist, DocumentWizard, type DocumentAdapter, type WizardDocument } from "@/components/shared/wizard/DocumentWizard";
import EmergencyContactFields from "@/components/shared/wizard/EmergencyContactFields";
import { FieldError, WIZARD_INPUT, WizardLabel, WizardTextField } from "@/components/shared/wizard/fields";
import { EditSectionButton, ReviewCard, ReviewMissing } from "@/components/shared/wizard/ReviewParts";
import WizardShell, { WIZARD_PRIMARY_CLASS, WizardBackButton, WizardNotice } from "@/components/shared/wizard/WizardShell";
import WizardStepper from "@/components/shared/wizard/WizardStepper";
import { STAFF_WIZARD_STEPS, type WizardExtractionState } from "@/pages/agency/lib/wizardConfig";
import type { StaffDocument } from "@/lib/staffApi";
import { FieldError as SaveError, LinkInvalidError, onboarding, takeLinkToken, type OnboardingView } from "@/lib/staffOnboardingApi";
import { STAFF_WIZARD, detailsOf, isBeingRead, licenceGaveAddress, prefillNote, stepComplete, stepFields, taxSuperRows, wizardProblems, type PrefillField, type StaffWizardStepId } from "@/lib/staffOnboardingWizard";
import { STAFF_DOC_LABEL, staffDocKinds, todayIso, type StaffDocCategory } from "@/lib/staffStatus";
import { formatPhone } from "../../../supabase/functions/_shared/validation/identifiers";
import { JOB_TYPE_LABEL, PAY_TYPE_LABEL } from "../../../supabase/functions/_shared/hr-template";
import { bankProblems, bsbBank, dateOfBirthRange, formatBsb, type Address, type BankDetails, type BankProblems } from "../../../supabase/functions/_shared/validation/person";
import {
  SUPER_CHOICE, SUPER_CHOICE_LABEL, TAX_RESIDENCY, TAX_RESIDENCY_LABEL, normalizeStaffField, staffFieldProblem, staffProblems, superFundNeeded,
  type StaffDetails, type StaffField, type StaffTextField,
} from "../../../supabase/functions/_shared/validation/staff-onboarding";

/**
 * /staff/onboard#t=<token>: a new staff member's onboarding wizard, opened from the emailed link. No login; the link is the
 * credential and the staff-onboarding function re-checks it on every call. A "documents" link runs the wizard until Submit; a
 * "reupload" link only replaces the documents an administrator rejected; a used link is read-only.
 * The page sends no Referer (meta tag here; the host also sends Referrer-Policy: no-referrer).
 *
 * The wizard is built from the SAME components as the student "Add New Form" wizard (src/components/shared/wizard: the shell, the
 * step pills, the upload screen, the phone field, the emergency contact, the review cards) and checks what is typed with the
 * SAME rules (supabase/functions/_shared/validation), which the function and the database repeat:
 *   1 Documents: upload first (drag and drop, phone camera); which ones are required follows the citizenship answer.
 *   2 Check details: what the documents told us, each with where it came from; anything unread or not matching is marked.
 *   3 Personal details: mobile, address (unless the licence gave it) and an emergency contact.
 *   4 Bank details: saved encrypted; shown back masked. Never kept in the browser.
 *   5 Tax and super: the declaration answers and the super choice only (owner's option A); the tax file number is never asked
 *     for here, the person gives it through Xero.
 *   6 Review and submit: everything on one page with an Edit button per section; Submit only when nothing is missing.
 * Details save by themselves a moment after typing; only valid values are sent.
 */

const EXTRACTION: Record<StaffDocument["extractionStatus"], WizardExtractionState> = { pending: "queued", processing: "processing", done: "done", no_fields: "empty", failed: "failed", unavailable: "empty" };
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
type SaveState = "idle" | "saving" | "saved" | "error";
const DEBOUNCE_MS = 1000;
const STEP_KEY = "skyline.staff-wizard-step";

function useNoReferrer() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background-100 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">{children}</div>
    </div>
  );
}

export default function StaffOnboardingPage() {
  useNoReferrer();
  const [token] = useState(() => takeLinkToken("onboard"));
  const [view, setView] = useState<OnboardingView | null>(null);
  const [invalid, setInvalid] = useState(!token);
  const [error, setError] = useState("");

  const handle = useCallback((e: unknown) => {
    if (e instanceof LinkInvalidError) { setInvalid(true); return; }
    setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
  }, []);

  useEffect(() => { if (token) void onboarding.open(token).then(setView, handle); }, [token, handle]);

  // While a document is being read, look again every few seconds (at most two minutes).
  const polls = useRef(0);
  const reading = view?.documents.some(isBeingRead) ?? false;
  useEffect(() => {
    if (!reading || !token) { polls.current = 0; return; }
    if (polls.current >= 40) return;
    const timer = window.setTimeout(() => { polls.current += 1; void onboarding.open(token).then(setView, () => undefined); }, 3000);
    return () => window.clearTimeout(timer);
  }, [reading, view, token]);

  if (invalid) {
    return (
      <Shell>
        <section className="rounded-card border border-background-200 bg-background-50 p-6" data-testid="staff-link-invalid">
          <h1 className="font-heading text-xl font-bold text-foreground-950">This link cannot be used</h1>
          <p className="mt-2 text-sm text-foreground-700">The link has expired, was replaced by a newer one, or is not valid. Please contact us and we will send you a new link.</p>
        </section>
      </Shell>
    );
  }
  if (!view) return <Shell>{error ? <p role="alert" className={ALERT}>{error}</p> : <p className="text-sm text-foreground-600" role="status">Opening your application…</p>}</Shell>;

  if (!view.readOnly && view.mode !== "reupload") {
    return (
      <Shell>
        {error ? <p role="alert" className={`mb-3 ${ALERT}`}>{error}</p> : null}
        <Wizard view={view} token={token!} onChange={setView} onError={handle} />
      </Shell>
    );
  }
  const name = [view.profile.first_name, view.profile.last_name].filter(Boolean).join(" ");
  return (
    <Shell>
      <h1 className="font-heading text-2xl font-bold text-foreground-950">{name ? `Welcome, ${view.profile.first_name}` : "Your staff application"}</h1>
      <p className="mt-1 text-sm text-foreground-600">{view.readOnly ? "Thank you. This is what you sent us." : `This private link works until ${new Date(view.expiresAt).toLocaleDateString()}.`}</p>
      {error ? <p role="alert" className={`mt-3 ${ALERT}`}>{error}</p> : null}
      <div className="mt-6">
        {view.readOnly ? <Submitted view={view} token={token!} onChange={setView} onError={handle} /> : <Reupload view={view} token={token!} onChange={setView} onError={handle} />}
      </div>
    </Shell>
  );
}

/* ----------------------------------------------------------------- documents through the link */

const toWizardDocument = (d: StaffDocument): WizardDocument => ({
  id: d.id, category: d.category, filename: d.filename, fileSize: d.fileSize, storagePath: d.storagePath,
  extraction: EXTRACTION[d.extractionStatus], error: d.extractionError ?? undefined, extracted: d.extracted,
  expiryDate: d.expiryDate, status: d.status, reviewNote: d.reviewNote,
});

function linkAdapter(token: string, onChange: (v: OnboardingView) => void): DocumentAdapter {
  return {
    upload: async (kind, file, expiryDate, replaces, onProgress) => { onChange(await onboarding.upload(token, kind.category as StaffDocCategory, file, expiryDate, replaces, onProgress)); },
    remove: async (doc) => { onChange(await onboarding.remove(token, doc.id)); },
    signedUrl: (doc) => onboarding.viewUrl(token, doc.id),
    setExpiry: async (doc, expiryDate) => { onChange(await onboarding.setExpiry(token, doc.id, expiryDate)); },
    extract: async (doc) => { onChange(await onboarding.extract(token, doc.id)); },
  };
}

interface Props { view: OnboardingView; token: string; onChange: (v: OnboardingView) => void; onError: (e: unknown) => void }

function Checklist({ view, token, onChange, canReupload }: Omit<Props, "onError"> & { canReupload: boolean }) {
  return <DocumentChecklist kinds={staffDocKinds(view.profile.is_australian_citizen, view.documents)} documents={view.documents.map(toWizardDocument)}
    adapter={linkAdapter(token, onChange)} canReupload={canReupload} testIdPrefix="staff" />;
}

function Submitted({ view, token, onChange }: Props) {
  return (
    <section className="rounded-card border border-background-200 bg-background-50 p-5" data-testid="staff-onboard-submitted">
      <h2 className="font-heading text-base font-bold text-foreground-950">Thank you</h2>
      <p className="mt-1 text-sm text-foreground-700">We have your details and documents. An administrator will review them and contact you by email.</p>
      <h3 className="mb-2 mt-5 font-heading text-sm font-bold text-foreground-950">Your documents</h3>
      <Checklist view={view} token={token} onChange={onChange} canReupload={false} />
    </section>
  );
}

function Reupload({ view, token, onChange, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const rejected = view.documents.filter((d) => d.status === "rejected").length;
  const submit = async () => { setBusy(true); try { onChange(await onboarding.submit(token)); } catch (e) { onError(e); } finally { setBusy(false); } };
  return (
    <section className="rounded-card border border-background-200 bg-background-50 p-5">
      <p className={ALERT} role="status">{rejected ? `Please upload ${rejected === 1 ? "a new file for the document" : `new files for the ${rejected} documents`} marked below. The administrator's note says what to fix.` : "Thank you. Send the new files to us when you are ready."}</p>
      <div className="mt-4"><Checklist view={view} token={token} onChange={onChange} canReupload /></div>
      <Button type="button" className="mt-5" onClick={() => void submit()} disabled={busy || rejected > 0} data-testid="staff-reupload-submit">{busy ? "Sending…" : "Send the new files"}</Button>
    </section>
  );
}

/* ----------------------------------------------------------------- the wizard */

function Choice({ selected, onClick, title, text, testId }: { selected: boolean; onClick: () => void; title: string; text?: string; testId: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} data-testid={testId} onClick={onClick}
      className={`flex w-full cursor-pointer items-start gap-3 rounded-lg border p-3.5 text-left ${selected ? "border-primary-500 bg-primary-50 ring-1 ring-primary-500" : "border-background-300 bg-background-50 hover:border-primary-300"}`}>
      <span><span className="block font-heading text-sm font-bold text-foreground-950">{title}</span>{text ? <span className="block text-xs text-foreground-600">{text}</span> : null}</span>
    </button>
  );
}

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h3 className="font-heading text-base font-semibold text-foreground-950">{title}</h3>
      <p className="mt-1 text-sm text-foreground-600">{subtitle}</p>
    </div>
  );
}

/** The note under a pre-filled field: where the value came from, or what to check. */
function SourceNote({ field, value, documents, onUse }: { field: PrefillField; value: string; documents: StaffDocument[]; onUse?: (suggestion: string) => void }) {
  const note = prefillNote(field, value, documents);
  if (!note) return null;
  if (note.kind === "reading") return <p className="mt-1 flex items-center gap-1.5 text-xs text-foreground-500" data-source={note.kind}><i className="ri-loader-4-line animate-spin" aria-hidden="true" />{note.text}</p>;
  if (note.kind === "match") return <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-accent-800" data-source={note.kind} data-testid={`staff-source-${field}`}><i className="ri-file-shield-2-line" aria-hidden="true" />{note.text}</p>;
  return (
    <div className={`mt-1.5 rounded-md border px-2.5 py-1.5 text-xs ${note.kind === "expired" ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`} role="status" data-source={note.kind} data-testid={`staff-source-${field}`}>
      <p className="flex items-start gap-1.5"><i className="ri-error-warning-line mt-px" aria-hidden="true" />{note.text}</p>
      {note.suggestion && onUse ? (
        <button type="button" onClick={() => onUse(note.suggestion!)} className="mt-1 cursor-pointer font-semibold underline" data-testid={`staff-use-${field}`}>Use what the document shows</button>
      ) : null}
    </div>
  );
}

const readStep = (): number => { try { const n = Number(window.sessionStorage.getItem(STEP_KEY)); return Number.isInteger(n) && n >= 0 && n < STAFF_WIZARD.length ? n : 0; } catch { return 0; } };
const row = (label: string, value: ReactNode) => (
  <div key={label} className="flex justify-between gap-3 text-sm"><dt className="shrink-0 text-foreground-500">{label}</dt><dd className="min-w-0 break-words text-right font-medium text-foreground-900">{value || "—"}</dd></div>
);
const showDate = (iso: string | null | undefined) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString() : "");
const EMPTY_BANK: BankDetails = { accountName: "", bsb: "", accountNumber: "" };

function Wizard({ view, token, onChange, onError }: Props) {
  const [step, setStep] = useState(readStep);
  const [details, setDetails] = useState<StaffDetails>(() => detailsOf(view.profile as unknown as Record<string, unknown>));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [bank, setBank] = useState<BankDetails>(EMPTY_BANK);
  const [bankErrors, setBankErrors] = useState<BankProblems>({});
  const [changingBank, setChangingBank] = useState(false);
  const [savingBank, setSavingBank] = useState(false);
  const [expiryError, setExpiryError] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const latest = useRef(details);
  const dirty = useRef(new Set<StaffField>());
  const timer = useRef<number | undefined>(undefined);
  const top = useRef<HTMLDivElement>(null);

  const current = STAFF_WIZARD[step];
  const citizen = details.is_australian_citizen;
  const documents = view.documents;
  const problems = useMemo(() => wizardProblems(details, documents, Boolean(view.bank)), [details, documents, view.bank]);
  // The address sits with the other pre-filled details when an Australian licence gave it; otherwise it is typed on Personal details.
  const addressFromLicence = licenceGaveAddress(documents);

  useEffect(() => { try { window.sessionStorage.setItem(STEP_KEY, String(step)); } catch { /* storage unavailable */ } }, [step]);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [step]);

  // Reading a document fills EMPTY details on the server: take those in without overwriting what the person is typing.
  const served = useMemo(() => detailsOf(view.profile as unknown as Record<string, unknown>), [view.profile]);
  useEffect(() => {
    setDetails((prev) => {
      let next = prev;
      for (const key of Object.keys(served) as StaffField[]) {
        if (key === "is_australian_citizen" || dirty.current.has(key)) continue;
        if (!prev[key] && served[key]) next = { ...next, [key]: served[key] };
      }
      latest.current = next;
      return next;
    });
  }, [served]);

  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    const fields = [...dirty.current];
    if (!fields.length) return true;
    dirty.current = new Set();
    const now = latest.current;
    const patch: Record<string, string | boolean | null> = {};
    for (const field of fields) patch[field] = field === "is_australian_citizen" ? now.is_australian_citizen : normalizeStaffField(field as StaffTextField, now);
    setSave("saving"); setSaveError("");
    try { onChange(await onboarding.save(token, patch)); setSave("saved"); return true; }
    catch (e) {
      if (e instanceof LinkInvalidError) { onError(e); return false; }
      const field = e instanceof SaveError ? e.field : undefined;
      const message = e instanceof Error ? e.message : "Your changes could not be saved.";
      // A refused field is shown on that field and not sent again until it is changed; the rest is kept for the next save.
      for (const other of fields) if (other !== field) dirty.current.add(other);
      if (field) setErrors((prev) => ({ ...prev, [field]: message })); else setSaveError(message);
      setSave("error");
      return false;
    }
  }, [onChange, onError, token]);

  /** A change to one field: checked at once (as a draft), and saved a moment later when it is valid. */
  const edit = useCallback((field: StaffField, value: string | boolean | null, now = false) => {
    const next = { ...latest.current, [field]: value } as StaffDetails;
    latest.current = next;
    setDetails(next);
    const problem = staffFieldProblem(field, next, false);
    setErrors((prev) => ({ ...prev, [field]: problem }));
    setSave("idle");
    window.clearTimeout(timer.current);
    if (problem) { dirty.current.delete(field); return; }
    dirty.current.add(field);
    if (now) void flush(); else timer.current = window.setTimeout(() => { void flush(); }, DEBOUNCE_MS);
  }, [flush]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Australia is assumed until the person says otherwise (staff work in Australia); it is saved like any other answer.
  useEffect(() => { if (current.id === "personal" && !latest.current.address_country) edit("address_country", "Australia"); }, [current.id, edit]);

  const indexOf = (id: StaffWizardStepId) => STAFF_WIZARD.findIndex((s) => s.id === id);

  /** Everything this step needs, shown on its fields. True when the step may be left forwards. */
  const checkStep = (id: StaffWizardStepId): boolean => {
    if (id === "documents" || id === "prefill" || id === "personal" || id === "tax") {
      const fields = stepFields(id, addressFromLicence);
      const found = staffProblems(latest.current, fields, true);
      setErrors((prev) => { const next = { ...prev }; for (const field of fields) next[field] = ""; for (const p of found) next[p.field] = p.message; return next; });
      const others = wizardProblems(latest.current, documents, Boolean(view.bank)).filter((p) => p.step === id && !p.field);
      setNotice(others[0]?.text ?? "");
      return found.length === 0 && others.length === 0;
    }
    return true;
  };

  const saveBank = async (): Promise<boolean> => {
    if (view.bank && !changingBank) return true;
    const found = bankProblems(bank);
    setBankErrors(found);
    if (Object.keys(found).length) return false;
    setSavingBank(true); setSaveError("");
    try {
      onChange(await onboarding.saveBank(token, { ...bank, bankName: bsbBank(bank.bsb) }));
      // The numbers are not kept in the page once they are saved; they come back masked.
      setBank(EMPTY_BANK); setChangingBank(false);
      return true;
    } catch (e) {
      if (e instanceof LinkInvalidError) { onError(e); return false; }
      const field = e instanceof SaveError ? e.field : undefined;
      const message = e instanceof Error ? e.message : "Your bank details could not be saved.";
      if (field === "accountName" || field === "bsb" || field === "accountNumber") setBankErrors({ [field]: message }); else setSaveError(message);
      return false;
    } finally { setSavingBank(false); }
  };

  const goTo = async (index: number) => {
    const target = Math.max(0, Math.min(index, STAFF_WIZARD.length - 1));
    setNotice("");
    if (!(await flush())) return;
    if (target <= step) { setStep(target); return; }
    // Forwards: every step on the way must be complete (its problems are shown where the person is stopped).
    for (let i = step; i < target; i += 1) {
      const id = STAFF_WIZARD[i].id;
      if (id === "bank" ? !(await saveBank()) : !checkStep(id)) { setStep(i); return; }
    }
    setStep(target);
  };

  const submit = async () => {
    setSubmitError("");
    if (!(await flush())) return;
    setSubmitting(true);
    try { onChange(await onboarding.submit(token)); try { window.sessionStorage.removeItem(STEP_KEY); } catch { /* storage unavailable */ } }
    catch (e) { if (e instanceof LinkInvalidError) onError(e); else setSubmitError(e instanceof Error ? e.message : "Your details could not be sent."); }
    finally { setSubmitting(false); }
  };

  const setDocumentExpiry = async (doc: StaffDocument, value: string) => {
    const key = doc.category;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1990) return; // still being typed
    if (value < todayIso()) { setExpiryError((prev) => ({ ...prev, [key]: `This ${STAFF_DOC_LABEL[doc.category as StaffDocCategory]?.toLowerCase() ?? "document"} has expired. Upload a current one.` })); return; }
    try { onChange(await onboarding.setExpiry(token, doc.id, value)); setExpiryError((prev) => ({ ...prev, [key]: "" })); setNotice(""); }
    catch (e) { if (e instanceof LinkInvalidError) onError(e); else setExpiryError((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : "The date could not be saved." })); }
  };

  /* ------------------------------------------------------------- pieces */

  const kinds = staffDocKinds(citizen, documents);
  const docSteps = kinds.flatMap((kind) => {
    const found = STAFF_WIZARD_STEPS.find((s) => s.category === kind.category);
    return found ? [{ kind, step: { ...found, subtitle: kind.required ? `Required. ${found.subtitle}` : found.subtitle } }] : [];
  });
  const requiredKinds = kinds.filter((k) => k.required);
  const uploadedRequired = requiredKinds.filter((k) => documents.some((d) => d.category === k.category)).length;

  const field = (name: StaffTextField, label: string, props: { required?: boolean; maxLength?: number; upper?: boolean; type?: string; min?: string; max?: string; placeholder?: string; source?: boolean } = {}) => (
    <WizardTextField id={`staff-${name}`} name={name} label={label} value={details[name]} error={errors[name]} required={props.required ?? true} maxLength={props.maxLength ?? 100}
      upper={props.upper} type={props.type} min={props.min} max={props.max} placeholder={props.placeholder} testId={`staff-${name}`} onChange={(value) => edit(name, value)}>
      {props.source ? <SourceNote field={name as PrefillField} value={details[name]} documents={documents} onUse={(suggestion) => edit(name, suggestion)} /> : null}
    </WizardTextField>
  );

  const expiryField = (doc: StaffDocument, required: boolean) => {
    const category = doc.category as StaffDocCategory;
    const sourced = category === "Passport" || category === "Visa";
    return (
      <div key={doc.id}>
        <WizardLabel htmlFor={`staff-expiry-${doc.id}`} required={required}>{`${STAFF_DOC_LABEL[category]} expiry date`}</WizardLabel>
        <input id={`staff-expiry-${doc.id}`} type="date" min={todayIso()} defaultValue={doc.expiryDate ?? ""} key={doc.expiryDate ?? "none"} aria-invalid={Boolean(expiryError[category])}
          className={WIZARD_INPUT} data-testid={`staff-expiry-${category.toLowerCase().replace(/\s+/g, "-")}`} onChange={(e) => void setDocumentExpiry(doc, e.target.value)} />
        {sourced ? <SourceNote field={`expiry:${category}` as PrefillField} value={doc.expiryDate ?? ""} documents={documents} onUse={(suggestion) => void setDocumentExpiry(doc, suggestion)} />
          : !doc.expiryDate && required ? <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900" role="status" data-source="unread">We do not read this date automatically. Type the date shown on the document.</p> : null}
        <FieldError text={expiryError[category]} />
      </div>
    );
  };

  const address: Address = { street: details.address_street, line2: details.address_line2, suburb: details.address_suburb, state: details.address_state, postcode: details.address_postcode, country: details.address_country };
  // Picking a search result fills the whole address (the same lookup as the student form); the fields below stay editable,
  // and are simply typed when the search is unavailable.
  const pickAddress = (pick: AddressPick) => {
    edit("address_street", pick.line); edit("address_line2", pick.line2); edit("address_suburb", pick.suburb);
    edit("address_country", "Australia"); edit("address_state", pick.state); edit("address_postcode", pick.postcode);
  };
  const addressBlock = (
    <div>
      <p className="mb-2 font-heading text-sm font-semibold text-foreground-950">Home address</p>
      <div className="mb-4" data-testid="staff-address-search">
        <AddressSearch search={(q, signal) => onboarding.addressSearch(token, q, signal)} onPick={pickAddress} />
      </div>
      <AddressFields idPrefix="staff-address-" testIdPrefix="staff-" value={address}
        errors={{ street: errors.address_street, line2: errors.address_line2, suburb: errors.address_suburb, state: errors.address_state, postcode: errors.address_postcode, country: errors.address_country }}
        onChange={(key, value) => edit(`address_${key}` as StaffField, value)} />
      {addressFromLicence ? <div className="mt-2"><SourceNote field="address_street" value={details.address_street} documents={documents} onUse={(suggestion) => edit("address_street", suggestion)} /></div> : null}
    </div>
  );

  const body = () => {
    if (current.id === "documents") {
      return (
        <div className="space-y-6">
          <StepHeading title={current.title} subtitle={current.subtitle} />
          <div>
            <p className="mb-2 text-[13px] font-medium text-foreground-800">Are you an Australian citizen? <span className="text-primary-600">*</span></p>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Australian citizen">
              <Choice selected={citizen === true} onClick={() => edit("is_australian_citizen", true, true)} title="Yes" text="No visa or English test needed." testId="staff-citizen-yes" />
              <Choice selected={citizen === false} onClick={() => edit("is_australian_citizen", false, true)} title="No" text="You will also upload your visa and English test result." testId="staff-citizen-no" />
            </div>
            <FieldError text={errors.is_australian_citizen} />
          </div>
          <p className="rounded-md border border-background-200 bg-background-100 px-3 py-2 text-[13px] text-foreground-800" role="status" data-testid="staff-required-summary">
            {citizen === null ? "Answer the question above: it decides whether a visa and an English test result are needed. " : ""}
            <strong>Required for you:</strong> {requiredKinds.map((k) => k.label).join(", ")} ({uploadedRequired} of {requiredKinds.length} uploaded).
            {kinds.some((k) => !k.required) ? <> <strong>Optional:</strong> {kinds.filter((k) => !k.required).map((k) => k.label).join(", ")}.</> : null}
          </p>
          <DocumentWizard steps={docSteps} documents={documents.map(toWizardDocument)} adapter={linkAdapter(token, onChange)} testIdPrefix="staff" askExpiry={false} dropzone camera />
        </div>
      );
    }
    if (current.id === "prefill") {
      const range = dateOfBirthRange();
      const visaShown = citizen !== true || documents.some((d) => d.category === "Visa");
      const dated = documents.filter((d) => kinds.some((k) => k.category === d.category && k.expiry !== "none"));
      const stillReading = documents.filter(isBeingRead);
      return (
        <div className="space-y-6">
          <StepHeading title={current.title} subtitle={current.subtitle} />
          {stillReading.length ? <p className="flex items-center gap-2 rounded-md border border-background-200 bg-background-100 px-3 py-2 text-[13px] text-foreground-800" role="status"><i className="ri-loader-4-line animate-spin text-primary-600" aria-hidden="true" />Reading {stillReading.length === 1 ? "a document" : `${stillReading.length} documents`}. Details appear here as they are read; you can also type them.</p> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {field("first_name", "First name", { source: true })}
            {field("middle_name", "Middle name", { required: false, source: true })}
            {field("last_name", "Last name", { source: true })}
            {field("date_of_birth", "Date of birth", { type: "date", min: range.min, max: range.max, source: true })}
            {field("nationality", "Nationality", { source: true })}
            {field("passport_number", "Passport number", { upper: true, maxLength: 12, source: true })}
            {dated.filter((d) => d.category === "Passport").map((d) => expiryField(d, true))}
          </div>
          {visaShown ? (
            <div>
              <p className="mb-2 font-heading text-sm font-semibold text-foreground-950">Visa</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {field("visa_subclass", "Visa type or subclass", { required: citizen === false, placeholder: "e.g. 485", source: true })}
                {dated.filter((d) => d.category === "Visa").map((d) => expiryField(d, true))}
                <div className="sm:col-span-2">
                  <WizardLabel htmlFor="staff-visa_conditions" required={false}>Work conditions</WizardLabel>
                  <textarea id="staff-visa_conditions" name="visa_conditions" rows={2} maxLength={500} value={details.visa_conditions} aria-invalid={Boolean(errors.visa_conditions)} className={WIZARD_INPUT}
                    placeholder="e.g. 8105 (work limitation), or No work limitation" data-testid="staff-visa_conditions" onChange={(e) => edit("visa_conditions", e.target.value)} />
                  {!details.visa_conditions.trim() && documents.some((d) => d.category === "Visa") ? <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900" role="status" data-source="unread">We do not read work conditions automatically. Copy them from your visa grant notice or VEVO record.</p> : null}
                  <FieldError text={errors.visa_conditions} />
                </div>
              </div>
            </div>
          ) : null}
          {dated.some((d) => d.category !== "Passport" && d.category !== "Visa") ? (
            <div>
              <p className="mb-2 font-heading text-sm font-semibold text-foreground-950">Other document dates</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {dated.filter((d) => d.category !== "Passport" && d.category !== "Visa").map((d) => expiryField(d, kinds.find((k) => k.category === d.category)?.expiry === "required"))}
              </div>
            </div>
          ) : null}
          {addressFromLicence ? addressBlock : null}
        </div>
      );
    }
    if (current.id === "personal") {
      const phoneInput = (event: FormEvent<HTMLFormElement>) => {
        const target = event.target as HTMLInputElement;
        // The shared phone field keeps its value (E.164) in its own named input and announces each change with an input event.
        if (target.name === "phone" || target.name === "emergency_phone") edit(target.name, target.value);
      };
      return (
        <form className="space-y-6" noValidate onSubmit={(event) => event.preventDefault()} onInput={phoneInput}>
          <StepHeading title={current.title} subtitle={current.subtitle} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <WizardLabel htmlFor="staff-phone">Mobile</WizardLabel>
              <PhoneInput id="staff-phone" name="phone" value={details.phone} required placeholder="041 234 5678" />
              <FieldError text={errors.phone} />
            </div>
            <div>
              <p className="mb-1.5 block text-[13px] font-medium text-foreground-800">Email</p>
              <p className="rounded-md border border-background-200 bg-background-100 px-3.5 py-2.5 text-sm text-foreground-700" data-testid="staff-email">{view.profile.email}</p>
              <p className="mt-1 text-xs text-foreground-500">To change your email, contact us.</p>
            </div>
          </div>
          {addressFromLicence ? null : addressBlock}
          <div>
            <p className="mb-2 font-heading text-sm font-semibold text-foreground-950">Emergency contact</p>
            <EmergencyContactFields idPrefix="staff-" testIdPrefix="staff-" who="you" names={{ name: "emergency_name", phone: "emergency_phone", relationship: "emergency_relationship" }}
              values={{ name: details.emergency_name, phone: details.emergency_phone, relationship: details.emergency_relationship }}
              errors={{ name: errors.emergency_name, phone: errors.emergency_phone, relationship: errors.emergency_relationship }}
              onChange={(key, value) => edit(key === "name" ? "emergency_name" : "emergency_relationship", value)} />
          </div>
        </form>
      );
    }
    if (current.id === "bank") {
      const bankName = bsbBank(bank.bsb);
      const check = (key: keyof BankDetails) => setBankErrors((prev) => ({ ...prev, [key]: bankProblems(bank)[key] }));
      return (
        <div className="space-y-5">
          <StepHeading title={current.title} subtitle={current.subtitle} />
          <p className="flex items-start gap-2 rounded-md border border-background-200 bg-background-100 px-3 py-2 text-[13px] text-foreground-800">
            <i className="ri-lock-2-line mt-0.5 text-primary-600" aria-hidden="true" />
            Your bank details are stored encrypted. Only you (through this private link) and Skyline administrators can see them, and every time an administrator opens them it is recorded.
          </p>
          {view.bank && !changingBank ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3" data-testid="staff-bank-saved">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-900"><i className="ri-checkbox-circle-fill text-emerald-600" aria-hidden="true" />Bank details saved</p>
              <dl className="mt-2 space-y-1">
                {row("Account name", view.bank.accountName)}
                {row("BSB", view.bank.bsb)}
                {row("Account number", view.bank.accountNumber)}
                {view.bank.bankName ? row("Bank", view.bank.bankName) : null}
              </dl>
              <button type="button" onClick={() => { setChangingBank(true); setBank(EMPTY_BANK); setBankErrors({}); }} className="mt-2 cursor-pointer text-sm font-semibold text-primary-700 underline" data-testid="staff-bank-change">Change bank details</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <WizardTextField id="staff-bank-accountName" name="bank-account-name" label="Account name" value={bank.accountName} error={bankErrors.accountName} maxLength={100}
                  placeholder="As shown on the bank account" testId="staff-bank-accountName" onChange={(value) => setBank((b) => ({ ...b, accountName: value }))} onBlur={() => check("accountName")} />
              </div>
              <WizardTextField id="staff-bank-bsb" name="bank-bsb" label="BSB" value={bank.bsb} error={bankErrors.bsb} maxLength={7} inputMode="numeric" placeholder="062-000" testId="staff-bank-bsb"
                onChange={(value) => setBank((b) => ({ ...b, bsb: value.replace(/[^\d\s-]/g, "") }))} onBlur={() => { setBank((b) => ({ ...b, bsb: formatBsb(b.bsb) })); check("bsb"); }}>
                {bankName ? <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-accent-800" data-testid="staff-bank-name"><i className="ri-bank-line" aria-hidden="true" />{bankName}</p> : null}
              </WizardTextField>
              <WizardTextField id="staff-bank-accountNumber" name="bank-account-number" label="Account number" value={bank.accountNumber} error={bankErrors.accountNumber} maxLength={12} inputMode="numeric"
                placeholder="12345678" testId="staff-bank-accountNumber" onChange={(value) => setBank((b) => ({ ...b, accountNumber: value.replace(/[^\d\s-]/g, "") }))} onBlur={() => check("accountNumber")} />
              {view.bank ? <button type="button" onClick={() => { setChangingBank(false); setBank(EMPTY_BANK); setBankErrors({}); }} className="cursor-pointer justify-self-start text-sm font-semibold text-primary-700 underline sm:col-span-2">Keep the saved bank details</button> : null}
            </div>
          )}
        </div>
      );
    }
    if (current.id === "tax") {
      const pick = (name: StaffTextField, value: string) => edit(name, value, true);
      // Changing how super is paid also clears the fund details that no longer apply, in one save.
      const pickSuper = (value: string) => {
        const cleared = value === "default" ? { super_fund_name: "", super_fund_abn: "", super_usi: "", super_member_number: "" } : value === "smsf" ? { super_usi: "", super_member_number: "" } : {};
        const next = { ...latest.current, super_choice: value, ...cleared } as StaffDetails;
        latest.current = next;
        setDetails(next);
        setErrors((prev) => ({ ...prev, super_choice: "", super_fund_name: "", super_fund_abn: "", super_usi: "", super_member_number: "" }));
        for (const name of ["super_choice", ...Object.keys(cleared)] as StaffField[]) dirty.current.add(name);
        void flush();
      };
      const yesNo = (name: "tax_free_threshold" | "study_loan", label: string, hint: string) => (
        <div>
          <p className="mb-1 text-[13px] font-medium text-foreground-800">{label} <span className="text-primary-600">*</span></p>
          <p className="mb-2 text-xs text-foreground-600">{hint}</p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={label}>
            <Choice selected={details[name] === "yes"} onClick={() => pick(name, "yes")} title="Yes" testId={`staff-${name}-yes`} />
            <Choice selected={details[name] === "no"} onClick={() => pick(name, "no")} title="No" testId={`staff-${name}-no`} />
          </div>
          <FieldError text={errors[name]} />
        </div>
      );
      const RESIDENCY_HINT: Record<string, string> = { resident: "Most people who live in Australia.", foreign: "You live outside Australia for tax purposes.", whm: "On a 417 or 462 visa." };
      const SUPER_HINT: Record<string, string> = { default: "We pay your super into Skyline's default fund. You can change this later.", own: "An APRA-regulated fund or retirement savings account. Have your member number handy.", smsf: "Your own self-managed fund." };
      return (
        <div className="space-y-6">
          <StepHeading title={current.title} subtitle={current.subtitle} />
          <p className="flex items-start gap-2 rounded-md border border-background-200 bg-background-100 px-3 py-2 text-[13px] text-foreground-800" data-testid="staff-tax-note">
            <i className="ri-shield-check-line mt-0.5 text-primary-600" aria-hidden="true" />
            We do not ask for your tax file number (TFN) here. Xero, our payroll system, will ask you for it securely once you start. The answers below go on your tax and super declarations.
          </p>
          <div className="space-y-5">
            <p className="font-heading text-sm font-semibold text-foreground-950">Tax</p>
            <div>
              <p className="mb-2 text-[13px] font-medium text-foreground-800">Your residency status for tax purposes <span className="text-primary-600">*</span></p>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Residency status for tax purposes">
                {TAX_RESIDENCY.map((value) => <Choice key={value} selected={details.tax_residency === value} onClick={() => pick("tax_residency", value)} title={TAX_RESIDENCY_LABEL[value]} text={RESIDENCY_HINT[value]} testId={`staff-tax_residency-${value}`} />)}
              </div>
              <FieldError text={errors.tax_residency} />
            </div>
            {details.tax_residency === "resident" ? yesNo("tax_free_threshold", "Do you want to claim the tax-free threshold from Skyline?", "Claim it from one employer only, usually the one that pays you the most.") : null}
            {yesNo("study_loan", "Do you have a study or training support loan?", "For example HELP, VSL, SSL, AASL or TSL. Answer yes if any is still owing.")}
          </div>
          <div className="space-y-4">
            <p className="font-heading text-sm font-semibold text-foreground-950">Superannuation</p>
            <div>
              <p className="mb-2 text-[13px] font-medium text-foreground-800">Where should your super go? <span className="text-primary-600">*</span></p>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Super fund">
                {SUPER_CHOICE.map((value) => <Choice key={value} selected={details.super_choice === value} onClick={() => pickSuper(value)} title={SUPER_CHOICE_LABEL[value]} text={SUPER_HINT[value]} testId={`staff-super_choice-${value}`} />)}
              </div>
              <FieldError text={errors.super_choice} />
            </div>
            {superFundNeeded(details.super_choice) ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="staff-super-fund">
                {field("super_fund_name", "Fund name", { placeholder: "e.g. AustralianSuper" })}
                {field("super_fund_abn", "Fund ABN", { maxLength: 14, placeholder: "11 digits" })}
                {details.super_choice === "own" ? field("super_usi", "Unique Superannuation Identifier (USI)", { required: false, maxLength: 20, upper: true, placeholder: "On your fund's website or statement" }) : null}
                {details.super_choice === "own" ? field("super_member_number", "Member number", { maxLength: 30 }) : null}
                {details.super_choice === "smsf" ? <p className="text-xs text-foreground-600 sm:col-span-2">We will ask you separately for the fund's electronic service address and bank account.</p> : null}
              </div>
            ) : null}
          </div>
        </div>
      );
    }
    // Review and submit
    const edits = (id: StaffWizardStepId, label: string) => <EditSectionButton label={label} onClick={() => void goTo(indexOf(id))} />;
    const passport = documents.find((d) => d.category === "Passport");
    const visa = documents.find((d) => d.category === "Visa");
    return (
      <div className="space-y-5">
        <StepHeading title={current.title} subtitle={current.subtitle} />
        <div data-testid="staff-problems"><ReviewMissing items={problems.map((p) => ({ text: p.text, onOpen: () => void goTo(indexOf(p.step)) }))} /></div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ReviewCard icon="ri-user-line" title="Your details" edit={edits("prefill", "Your details")}>
            <dl className="mt-3 space-y-2">
              {row("Name", [details.first_name, details.middle_name, details.last_name].filter(Boolean).join(" "))}
              {row("Date of birth", showDate(details.date_of_birth))}
              {row("Nationality", details.nationality)}
              {row("Australian citizen", citizen === null ? "" : citizen ? "Yes" : "No")}
              {row("Passport number", details.passport_number)}
              {row("Passport expiry", showDate(passport?.expiryDate))}
              {citizen === false || visa ? row("Visa", [details.visa_subclass, visa?.expiryDate ? `until ${showDate(visa.expiryDate)}` : ""].filter(Boolean).join(", ")) : null}
              {details.visa_conditions.trim() ? row("Work conditions", details.visa_conditions) : null}
            </dl>
          </ReviewCard>
          <ReviewCard icon="ri-home-4-line" title="Contact and address" edit={edits(addressFromLicence ? "prefill" : "personal", "Contact and address")}>
            <dl className="mt-3 space-y-2">
              {row("Mobile", formatPhone(details.phone))}
              {row("Email", view.profile.email)}
              {row("Address", [details.address_street, details.address_line2, details.address_suburb, details.address_state, details.address_postcode, details.address_country].filter(Boolean).join(", "))}
            </dl>
          </ReviewCard>
          <ReviewCard icon="ri-phone-line" title="Emergency contact" edit={edits("personal", "Emergency contact")}>
            <dl className="mt-3 space-y-2">
              {row("Name", details.emergency_name)}
              {row("Relationship", details.emergency_relationship)}
              {row("Phone", formatPhone(details.emergency_phone))}
            </dl>
          </ReviewCard>
          <ReviewCard icon="ri-bank-line" title="Bank details" edit={edits("bank", "Bank details")}>
            <dl className="mt-3 space-y-2" data-testid="staff-review-bank">
              {view.bank ? <>{row("Account name", view.bank.accountName)}{row("BSB", view.bank.bsb)}{row("Account number", view.bank.accountNumber)}</> : row("Bank details", "Not entered yet")}
            </dl>
          </ReviewCard>
          <ReviewCard icon="ri-government-line" title="Tax and super" edit={edits("tax", "Tax and super")}>
            <dl className="mt-3 space-y-2" data-testid="staff-review-tax">
              {taxSuperRows(details).map(([label, value]) => row(label, value))}
            </dl>
          </ReviewCard>
          {view.employment ? (
            <ReviewCard icon="ri-briefcase-line" title="Your role (as recorded by HR)">
              <dl className="mt-3 space-y-2" data-testid="staff-review-role">
                {row("Job title", view.employment.jobTitle)}
                {row("Work location", view.employment.workLocation)}
                {row("Job type", view.employment.employmentType ? JOB_TYPE_LABEL[view.employment.employmentType] ?? "" : "")}
                {row("Pay type", view.employment.payType ? PAY_TYPE_LABEL[view.employment.payType] : "")}
                {row("Start date", showDate(view.employment.joiningDate))}
              </dl>
            </ReviewCard>
          ) : null}
        </div>
        <ReviewCard icon="ri-file-list-3-line" title="Documents" edit={edits("documents", "Documents")}>
          <div className="mt-3"><Checklist view={view} token={token} onChange={onChange} canReupload={false} /></div>
        </ReviewCard>
        {submitError ? <p role="alert" className={ALERT}>{submitError}</p> : null}
        <p className="text-xs text-foreground-500">After you send them you cannot change them. If an administrator needs a document again, we email you a new link.</p>
      </div>
    );
  };

  const isLast = step === STAFF_WIZARD.length - 1;
  const name = view.profile.first_name;
  return (
    <div ref={top}>
      <WizardShell variant="page" icon="ri-shield-user-line"
        title={name ? `Welcome, ${name}` : "Your staff onboarding"}
        subtitle={`This private link works until ${new Date(view.expiresAt).toLocaleDateString()}. Your changes save as you go.`}
        stepper={<div data-testid="staff-stepper"><WizardStepper items={STAFF_WIZARD.map((s) => ({ id: s.id, short: s.short, icon: s.icon, done: stepComplete(s.id, problems) }))} current={step} onSelect={(index) => void goTo(index)} /></div>}
        footerStart={
          <>
            {step > 0 ? <WizardBackButton onClick={() => void goTo(step - 1)} disabled={submitting} /> : null}
            <span className="text-xs text-foreground-500" role="status" aria-live="polite" data-testid="staff-save-state">
              {save === "saving" ? "Saving…" : save === "saved" ? "Saved" : save === "error" ? "Not saved" : ""}
            </span>
          </>
        }
        footerEnd={
          isLast ? (
            <button type="button" onClick={() => void submit()} disabled={submitting || problems.length > 0} className={WIZARD_PRIMARY_CLASS} data-testid="staff-submit">
              {submitting ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Sending&hellip;</> : <>Send my details and documents <i className="ri-send-plane-line" aria-hidden="true" /></>}
            </button>
          ) : (
            <button type="button" onClick={() => void goTo(step + 1)} disabled={savingBank} className={WIZARD_PRIMARY_CLASS} data-testid="staff-next">
              {savingBank ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> Saving&hellip;</> : <>Continue <i className="ri-arrow-right-line" aria-hidden="true" /></>}
            </button>
          )
        }
        notices={
          <>
            {notice ? <div data-testid="staff-step-notice"><WizardNotice tone="info">{notice}</WizardNotice></div> : null}
            {saveError ? <div data-testid="staff-save-error"><WizardNotice tone="error">{saveError}</WizardNotice></div> : null}
          </>
        }
      >
        <div data-testid={`staff-step-${current.id}`}>{body()}</div>
      </WizardShell>
    </div>
  );
}
