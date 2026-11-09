import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { DocumentChecklist, DocumentWizard, type DocumentAdapter, type WizardDocument } from "@/pages/agency/components/DocumentWizard";
import { STAFF_WIZARD_STEPS, type WizardExtractionState } from "@/pages/agency/lib/wizardConfig";
import type { StaffDocument } from "@/lib/staffApi";
import { LinkInvalidError, onboarding, takeLinkToken, type OnboardingView } from "@/lib/staffOnboardingApi";
import { staffDocKinds, submitProblems, type StaffDocCategory } from "@/lib/staffStatus";

/**
 * /staff/onboard#t=<token>: a staff applicant's personal details and documents, opened from the emailed link. No login; the link
 * is the credential and the staff-onboarding function re-checks it on every call. A "documents" link edits everything until
 * Submit; a "reupload" link only replaces the documents an administrator rejected; a used link is read-only.
 * The page sends no Referer (meta tag here; the host also sends Referrer-Policy: no-referrer).
 */

const EXTRACTION: Record<StaffDocument["extractionStatus"], WizardExtractionState> = { pending: "queued", processing: "processing", done: "done", no_fields: "empty", failed: "failed", unavailable: "empty" };
const READABLE = new Set(["Passport", "Visa", "English", "Driving Licence"]);
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
type Tab = "details" | "documents" | "review";
const TABS: Array<{ id: Tab; label: string }> = [{ id: "details", label: "Personal details" }, { id: "documents", label: "Documents" }, { id: "review", label: "Review & submit" }];
type SaveState = "idle" | "saving" | "saved" | "error";
const DEBOUNCE_MS = 1000;

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
  const reading = view?.documents.some((d) => (d.extractionStatus === "pending" && READABLE.has(d.category)) || d.extractionStatus === "processing") ?? false;
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

  const name = [view.profile.first_name, view.profile.last_name].filter(Boolean).join(" ");
  return (
    <Shell>
      <h1 className="font-heading text-2xl font-bold text-foreground-950">{name ? `Welcome, ${view.profile.first_name}` : "Your staff application"}</h1>
      <p className="mt-1 text-sm text-foreground-600">{view.readOnly ? "Thank you. This is what you sent us." : `This private link works until ${new Date(view.expiresAt).toLocaleDateString()}. Your changes save as you go.`}</p>
      {error ? <p role="alert" className={`mt-3 ${ALERT}`}>{error}</p> : null}
      <div className="mt-6">
        {view.readOnly ? <Submitted view={view} token={token!} onChange={setView} onError={handle} />
          : view.mode === "reupload" ? <Reupload view={view} token={token!} onChange={setView} onError={handle} />
          : <Wizard view={view} token={token!} onChange={setView} onError={handle} />}
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
    upload: async (kind, file, expiryDate, replaces) => { onChange(await onboarding.upload(token, kind.category as StaffDocCategory, file, expiryDate, replaces)); },
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

/* ----------------------------------------------------------------- details, documents, review */

const FIELDS: Array<{ key: string; label: string; required?: boolean; type?: string; hint?: string }> = [
  { key: "first_name", label: "First name", required: true }, { key: "middle_name", label: "Middle name" }, { key: "last_name", label: "Last name", required: true },
  { key: "date_of_birth", label: "Date of birth", required: true, type: "date" },
  { key: "address_street", label: "Street address", required: true }, { key: "address_line2", label: "Address line 2" },
  { key: "address_suburb", label: "Suburb or city" }, { key: "address_state", label: "State" }, { key: "address_postcode", label: "Postcode" }, { key: "address_country", label: "Country", required: true },
  { key: "emergency_name", label: "Emergency contact name", required: true }, { key: "emergency_relationship", label: "Relationship", required: true },
  { key: "emergency_phone", label: "Emergency contact phone", required: true, type: "tel", hint: "With the country code, for example +61 412 345 678." },
];

function valueOf(view: OnboardingView, key: string): string {
  const p = view.profile as unknown as Record<string, string | null>;
  if (key === "emergency_phone") return p.emergency_phone_e164 ?? "";
  return p[key] ?? "";
}

function Choice({ selected, onClick, title, text, testId }: { selected: boolean; onClick: () => void; title: string; text?: string; testId: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} data-testid={testId} onClick={onClick}
      className={`flex w-full cursor-pointer items-start gap-3 rounded-lg border p-3.5 text-left ${selected ? "border-primary-500 bg-primary-50 ring-1 ring-primary-500" : "border-background-300 bg-background-50 hover:border-primary-300"}`}>
      <span><span className="block font-heading text-sm font-bold text-foreground-950">{title}</span>{text ? <span className="block text-xs text-foreground-600">{text}</span> : null}</span>
    </button>
  );
}

function Wizard({ view, token, onChange, onError }: Props) {
  const [tab, setTab] = useState<Tab>("details");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, valueOf(view, f.key)])));
  const [save, setSave] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dirty = useRef<Record<string, string | boolean | null>>({});
  const timer = useRef<number | undefined>(undefined);

  // Reading a document fills EMPTY details on the server: take those in without overwriting what the person is typing.
  const filled = FIELDS.map((f) => valueOf(view, f.key)).join("|");
  useEffect(() => {
    setValues((prev) => {
      const next = { ...prev };
      for (const f of FIELDS) if (!(f.key in dirty.current) && !next[f.key] && valueOf(view, f.key)) next[f.key] = valueOf(view, f.key);
      return next;
    });
  }, [filled, view]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const patch = dirty.current;
    if (!Object.keys(patch).length) return true;
    dirty.current = {};
    setSave("saving"); setSaveError("");
    try { onChange(await onboarding.save(token, patch)); setSave("saved"); return true; }
    catch (e) {
      if (e instanceof LinkInvalidError) { onError(e); return false; }
      dirty.current = { ...patch, ...dirty.current }; setSave("error"); setSaveError(e instanceof Error ? e.message : "Your changes could not be saved."); return false;
    }
  }, [onChange, onError, token]);

  const edit = (key: string, value: string | boolean | null, now = false) => {
    dirty.current = { ...dirty.current, [key]: value };
    setSave("idle");
    window.clearTimeout(timer.current);
    if (now) void flush(); else timer.current = window.setTimeout(() => { void flush(); }, DEBOUNCE_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const go = async (next: Tab) => { if (await flush()) setTab(next); };
  const citizen = view.profile.is_australian_citizen;
  const problems = submitProblems({
    firstName: values.first_name ?? "", lastName: values.last_name ?? "", dateOfBirth: values.date_of_birth || null, addressStreet: values.address_street ?? "", addressCountry: values.address_country ?? "",
    emergencyName: values.emergency_name ?? "", emergencyRelationship: values.emergency_relationship ?? "", emergencyPhone: values.emergency_phone || null,
    isAustralianCitizen: citizen, documents: view.documents,
  });

  const submit = async () => {
    setSubmitError("");
    if (!(await flush())) return;
    setSubmitting(true);
    try { onChange(await onboarding.submit(token)); }
    catch (e) { if (e instanceof LinkInvalidError) onError(e); else setSubmitError(e instanceof Error ? e.message : "Your details could not be sent."); }
    finally { setSubmitting(false); }
  };

  const steps = staffDocKinds(citizen, view.documents).flatMap((kind) => {
    const step = STAFF_WIZARD_STEPS.find((s) => s.category === kind.category);
    return step ? [{ kind, step }] : [];
  });
  const index = TABS.findIndex((t) => t.id === tab);
  return (
    <div>
      <nav className="flex flex-wrap gap-2" aria-label="Steps">
        {TABS.map((t, i) => (
          <button key={t.id} type="button" onClick={() => void go(t.id)} aria-current={tab === t.id ? "step" : undefined} data-testid={`staff-tab-${t.id}`}
            className={`cursor-pointer rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${tab === t.id ? "border-primary-500 bg-primary-50 text-primary-800" : "border-background-300 bg-background-50 text-foreground-700 hover:border-primary-300"}`}>
            {i + 1}. {t.label}
          </button>
        ))}
      </nav>
      <p className="mt-2 h-4 text-xs text-foreground-500" role="status" aria-live="polite">
        {save === "saving" ? "Saving…" : save === "saved" ? "Saved" : save === "error" ? "" : "Changes save automatically until you send them."}
      </p>
      {saveError ? <p role="alert" className={`mb-3 ${ALERT}`}>{saveError}</p> : null}

      <section className="mt-4 rounded-card border border-background-200 bg-background-50 p-5">
        {tab === "details" ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email"><TextInput value={view.profile.email} readOnly disabled /></Field>
              <Field label="Mobile"><TextInput value={view.profile.phone_e164} readOnly disabled /></Field>
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} required={f.required} hint={f.hint}>
                  <TextInput type={f.type ?? "text"} value={values[f.key] ?? ""} name={f.key} data-testid={`staff-${f.key}`}
                    onChange={(e) => { setValues((v) => ({ ...v, [f.key]: e.target.value })); edit(f.key, e.target.value); }} />
                </Field>
              ))}
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium text-foreground-800">Are you an Australian citizen? <span className="text-primary-600">*</span></p>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Australian citizen">
                <Choice selected={citizen === true} onClick={() => edit("is_australian_citizen", true, true)} title="Yes" text="No visa needed." testId="staff-citizen-yes" />
                <Choice selected={citizen === false} onClick={() => edit("is_australian_citizen", false, true)} title="No" text="You will upload your visa." testId="staff-citizen-no" />
              </div>
            </div>
            <p className="text-xs text-foreground-500">Upload your passport on the Documents step and we fill in blank details from it. You can change anything.</p>
          </div>
        ) : null}
        {tab === "documents" ? (
          <DocumentWizard steps={steps} documents={view.documents.map(toWizardDocument)} adapter={linkAdapter(token, onChange)} testIdPrefix="staff"
            notice={citizen === null ? "Answer the Australian citizen question on Personal details first: it decides whether a visa and an English test result are needed." : undefined} />
        ) : null}
        {tab === "review" ? (
          <div className="space-y-5">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {[["Name", [values.first_name, values.middle_name, values.last_name].filter(Boolean).join(" ")], ["Date of birth", values.date_of_birth], ["Email", view.profile.email], ["Mobile", view.profile.phone_e164],
                ["Address", [values.address_street, values.address_line2, values.address_suburb, values.address_state, values.address_postcode, values.address_country].filter(Boolean).join(", ")],
                ["Emergency contact", [values.emergency_name, values.emergency_relationship, values.emergency_phone].filter(Boolean).join(" · ")],
                ["Australian citizen", citizen === null ? "" : citizen ? "Yes" : "No"]].map(([k, v]) => (
                <div key={k}><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{k}</dt><dd className="text-foreground-900">{v || "—"}</dd></div>
              ))}
            </dl>
            <div>
              <h3 className="mb-2 font-heading text-sm font-bold text-foreground-950">Documents</h3>
              <Checklist view={view} token={token} onChange={onChange} canReupload={false} />
            </div>
            {problems.length ? <ul className={`list-disc space-y-1 py-2.5 pl-8 text-[13px] ${ALERT}`} data-testid="staff-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
            {submitError ? <p role="alert" className={ALERT}>{submitError}</p> : null}
            <Button type="button" onClick={() => void submit()} disabled={submitting} data-testid="staff-submit">{submitting ? "Sending…" : "Send my details and documents"}</Button>
            <p className="text-xs text-foreground-500">After you send them you cannot change them. If an administrator needs a document again, we email you a new link.</p>
          </div>
        ) : null}
      </section>
      <div className="mt-4 flex justify-between">
        {index > 0 ? <Button type="button" variant="outline" onClick={() => void go(TABS[index - 1].id)}>Back</Button> : <span />}
        {index < TABS.length - 1 ? <Button type="button" onClick={() => void go(TABS[index + 1].id)} data-testid="staff-next">Continue</Button> : null}
      </div>
    </div>
  );
}
