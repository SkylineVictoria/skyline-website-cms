import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Badge, Button, Field, Select, TextInput } from "@/pages/admin/components/ui";
import WizardDocumentStep from "@/pages/agency/components/WizardDocumentStep";
import { STAFF_WIZARD_STEPS, type PendingUpload, type WizardDoc, type WizardExtractionState } from "@/pages/agency/lib/wizardConfig";
import {
  getMyStaffApplication, removeStaffDocument, requestStaffExtraction, saveStaffDraft, setStaffCitizenship, staffDocumentUrl, submitStaffApplication, uploadOnboardingDocument, uploadStaffDocument,
  type OnboardingCategory, type StaffDocCategory, type StaffDocument, type StaffMe,
} from "@/lib/staffApi";
import { STAFF_STATUS_LABEL, submitProblems, type StaffRole } from "@/lib/staffStatus";
import { JOB_APPLICATION_STATUS_LABEL } from "@/lib/jobs";

/** Same shape as a student's wizard document, so the student's document screen is reused as it is. */
const EXTRACTION: Record<StaffDocument["extractionStatus"], WizardExtractionState> = { pending: "queued", processing: "processing", done: "done", no_fields: "empty", failed: "failed", unavailable: "empty" };
const toWizardDoc = (d: StaffDocument): WizardDoc => ({ id: d.id, category: d.category, filename: d.filename, fileSize: d.fileSize, storagePath: d.storagePath, extraction: EXTRACTION[d.extractionStatus], error: d.extractionError ?? undefined, extracted: d.extracted });

type Tab = "details" | "documents" | "role" | "review";
const TABS: Array<{ id: Tab; label: string }> = [{ id: "details", label: "Personal details" }, { id: "documents", label: "Documents" }, { id: "role", label: "Requested role" }, { id: "review", label: "Review and submit" }];
const ROLE_TEXT: Record<StaffRole, { title: string; text: string }> = {
  admin: { title: "Admin", text: "Manage the website, applications and people. An administrator must confirm this." },
  trainer: { title: "Trainer", text: "Deliver training. This does not give access to the admin console." },
};

type SaveState = "idle" | "saving" | "saved" | "error";
const DEBOUNCE_MS = 1000;

function Frame({ email, children, onSignOut }: { email?: string; children: ReactNode; onSignOut: () => void }) {
  return (
    <div className="min-h-screen bg-background-100">
      <header className="border-b border-background-200 bg-background-50">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-5 py-3">
          <p className="font-heading text-sm font-bold text-foreground-950">Skyline staff application</p>
          <div className="flex items-center gap-3 text-xs text-foreground-600">
            {email ? <span className="hidden sm:inline">{email}</span> : null}
            <button type="button" onClick={onSignOut} className="cursor-pointer font-semibold text-primary-700 hover:text-primary-800">Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">{children}</main>
    </div>
  );
}

/** The applicant's workspace: draft saving, document upload, status and the administrator's notes. */
export default function StaffWorkspacePage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<StaffMe | null | undefined>(undefined);
  const [uid, setUid] = useState("");
  const [loadError, setLoadError] = useState("");
  const [signedOut, setSignedOut] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getUser();
      if (!data.user) { setSignedOut(true); return; }
      setUid(data.user.id);
      setMe(await getMyStaffApplication());
    } catch (e) { setLoadError(e instanceof Error ? e.message : "We could not load your application."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // While a document is still being read, look again every few seconds (at most two minutes).
  const polls = useRef(0);
  const reading = me?.documents.some((d) => d.extractionStatus === "pending" || d.extractionStatus === "processing") ?? false;
  useEffect(() => {
    if (!reading) { polls.current = 0; return; }
    if (polls.current >= 40) return;
    const timer = window.setTimeout(() => { polls.current += 1; void getMyStaffApplication().then((next) => next && setMe(next), () => undefined); }, 3000);
    return () => window.clearTimeout(timer);
  }, [reading, me]);

  const signOut = () => { void supabase.auth.signOut().then(() => navigate("/login", { replace: true })); };

  if (signedOut) return <Navigate to="/login?next=%2Fstaff" replace />;
  if (loadError) return <Frame onSignOut={signOut}><p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{loadError}</p></Frame>;
  if (me === undefined) return <Frame onSignOut={signOut}><p className="text-sm text-foreground-600" role="status">Loading your application…</p></Frame>;
  if (me === null) return <Navigate to="/staff/apply" replace />;

  return (
    <Frame email={me.profile.email} onSignOut={signOut}>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-2xl font-bold text-foreground-950">{me.profile.first_name ? `Welcome, ${me.profile.first_name}` : "Your staff application"}</h1>
        <span data-testid="staff-status" className="rounded-full bg-secondary-100 px-3 py-1 text-xs font-semibold text-foreground-900">{STAFF_STATUS_LABEL[me.profile.status]}</span>
      </div>
      {me.profile.status === "draft" && me.jobApplications?.some((a) => a.status === "hired") ? (
        <p className="mb-5 rounded-md border border-secondary-300 bg-secondary-50 px-4 py-3 text-sm text-foreground-900" data-testid="hired-banner">
          <strong>Congratulations, you were hired for {me.jobApplications.find((a) => a.status === "hired")?.jobTitle}.</strong> Complete your details below, upload your documents and submit to finish your staff registration.
        </p>
      ) : null}
      {me.profile.status === "draft" ? <DraftWizard me={me} uid={uid} onChange={setMe} /> : <><StatusPanel me={me} />
        {me.requiredCategories && (me.profile.status === "submitted" || me.profile.status === "preboarding") &&
          me.documents.some((d) => d.status === "rejected") ? <section className="mt-4 rounded-card border border-background-200 bg-background-50 p-5">
            <h2 className="mb-3 font-semibold">Replace documents requested by the reviewer</h2>
            <OnboardingDocuments me={me} uid={uid} onChange={setMe} />
          </section> : null}</>}
      <Timeline me={me} />
    </Frame>
  );
}

/* ----------------------------------------------------------------- after submit: status and messages */

const STATUS_TEXT: Record<string, string> = {
  job_applied: "Your job application has been received. Our team will review it and get back to you. If you are hired, you complete your staff registration here with the same login.",
  submitted: "Your application is with an administrator. You will be able to sign in here to see the decision.",
  preboarding: "Your application was approved. An administrator is finishing your onboarding and will activate your account.",
  active: "Your account is active.",
  rejected: "Your application was not approved.",
  inactive: "Your account is inactive. Contact the administrator if this is a mistake.",
};

function StatusPanel({ me }: { me: StaffMe }) {
  const status = me.profile.status;
  return (
    <section className="rounded-card border border-background-200 bg-background-50 p-5" aria-label="Application status">
      <p className="text-sm text-foreground-800">{STATUS_TEXT[status]}</p>
      {me.jobApplications?.length ? (
        <ul className="mt-3 space-y-1.5" data-testid="my-job-applications">
          {me.jobApplications.map((a) => <li key={a.id} className="text-sm text-foreground-700"><strong>{a.jobTitle}</strong> · applied {new Date(a.appliedAt).toLocaleDateString()} · {JOB_APPLICATION_STATUS_LABEL[a.status]}{a.decisionNote ? ` · ${a.decisionNote}` : ""}</li>)}
        </ul>
      ) : null}
      {status === "job_applied" || status === "rejected" ? <p className="mt-3"><Link to="/careers" className="font-semibold text-primary-700 hover:underline">See other openings</Link></p> : null}
      {me.role ? <p className="mt-2 text-sm text-foreground-700">Role: <strong>{ROLE_TEXT[me.role].title}</strong>{me.role === "trainer" ? "" : status === "active" ? "" : " (effective once your account is active)"}</p> : null}
      {status === "active" && me.role === "admin" ? <p className="mt-3"><Link to="/admin" className="font-semibold text-primary-700 hover:underline">Open the admin console</Link></p> : null}
      {status === "rejected" && me.application.review_note ? <p className="mt-2 rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-800"><strong>Note from the administrator:</strong> {me.application.review_note}</p> : null}
    </section>
  );
}

function Timeline({ me }: { me: StaffMe }) {
  const items = me.events.filter((e) => e.note || e.to !== "draft");
  if (!items.length) return null;
  return (
    <section className="mt-8" aria-label="Status history and messages">
      <h2 className="font-heading text-base font-bold text-foreground-950">Status and messages</h2>
      <ol className="mt-3 space-y-2">
        {[...items].reverse().map((e, i) => (
          <li key={`${e.at}-${i}`} className="rounded-md border border-background-200 bg-background-50 px-3 py-2 text-sm">
            <span className="font-semibold text-foreground-900">{STAFF_STATUS_LABEL[e.to]}</span>
            <span className="ml-2 text-xs text-foreground-500">{new Date(e.at).toLocaleString()}{e.actorKind === "admin" ? " · administrator" : ""}</span>
            {e.note ? <p className="mt-0.5 text-foreground-700">{e.note}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ----------------------------------------------------------------- draft wizard */

const FIELDS: Array<{ key: string; label: string; required?: boolean; type?: string; hint?: string }> = [
  { key: "first_name", label: "First name", required: true }, { key: "middle_name", label: "Middle name" }, { key: "last_name", label: "Last name", required: true },
  { key: "date_of_birth", label: "Date of birth", required: true, type: "date" },
  { key: "address_street", label: "Street address", required: true }, { key: "address_line2", label: "Address line 2" },
  { key: "address_suburb", label: "Suburb or city" }, { key: "address_state", label: "State" }, { key: "address_postcode", label: "Postcode" }, { key: "address_country", label: "Country", required: true },
  { key: "emergency_name", label: "Emergency contact name", required: true }, { key: "emergency_relationship", label: "Relationship", required: true },
  { key: "emergency_phone", label: "Emergency contact phone", required: true, type: "tel", hint: "With the country code, for example +61 412 345 678." },
];

function valueOf(me: StaffMe, key: string): string {
  const p = me.profile as unknown as Record<string, string | null>;
  if (key === "emergency_phone") return p.emergency_phone_e164 ?? "";
  return p[key] ?? "";
}

function DraftWizard({ me, uid, onChange }: { me: StaffMe; uid: string; onChange: (m: StaffMe) => void }) {
  const [tab, setTab] = useState<Tab>("details");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, valueOf(me, f.key)])));
  const [save, setSave] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dirty = useRef<Record<string, string | null>>({});
  const timer = useRef<number | undefined>(undefined);
  const meRef = useRef(me);
  meRef.current = me;

  // Reading a document fills EMPTY details on the server: take those in without overwriting what the person is typing.
  const filled = FIELDS.map((f) => valueOf(me, f.key)).join("|");
  useEffect(() => {
    setValues((prev) => {
      const next = { ...prev };
      for (const f of FIELDS) if (!(f.key in dirty.current) && !next[f.key] && valueOf(me, f.key)) next[f.key] = valueOf(me, f.key);
      return next;
    });
  }, [filled, me]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const patch = dirty.current;
    if (!Object.keys(patch).length) return true;
    dirty.current = {};
    setSave("saving"); setSaveError("");
    try { onChange(await saveStaffDraft(patch)); setSave("saved"); return true; }
    catch (e) { dirty.current = { ...patch, ...dirty.current }; setSave("error"); setSaveError(e instanceof Error ? e.message : "Your changes could not be saved."); return false; }
  }, [onChange]);

  const edit = (key: string, value: string | null) => {
    dirty.current = { ...dirty.current, [key]: value };
    setSave("idle");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, DEBOUNCE_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const go = async (next: Tab) => { if (await flush()) setTab(next); };

  const problems = submitProblems({
    firstName: values.first_name ?? "", lastName: values.last_name ?? "", dateOfBirth: values.date_of_birth || null, addressStreet: values.address_street ?? "", addressCountry: values.address_country ?? "",
    emergencyName: values.emergency_name ?? "", emergencyRelationship: values.emergency_relationship ?? "", emergencyPhone: values.emergency_phone || null,
    requestedRole: me.application.requested_role, hasPassport: me.documents.some((d) => d.category === "Passport"),
  });

  if (me.requiredCategories) {
    if (me.profile.is_australian_citizen == null) problems.push("Select your Australian citizenship status.");
    for (const category of me.requiredCategories) {
      if (category !== "Passport" && !me.documents.some((d) => d.category === category)) problems.push(`Upload ${category.toLowerCase()}.`);
    }
  }

  const submit = async () => {
    setSubmitError("");
    if (!(await flush())) return;
    setSubmitting(true);
    try { onChange(await submitStaffApplication()); }
    catch (e) { setSubmitError(e instanceof Error ? e.message : "Your application could not be submitted."); }
    finally { setSubmitting(false); }
  };

  return (
    <div>
      <nav className="flex flex-wrap gap-2" aria-label="Application steps">
        {TABS.map((t, i) => (
          <button key={t.id} type="button" onClick={() => void go(t.id)} aria-current={tab === t.id ? "step" : undefined} data-testid={`staff-tab-${t.id}`}
            className={`cursor-pointer rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${tab === t.id ? "border-primary-500 bg-primary-50 text-primary-800" : "border-background-300 bg-background-50 text-foreground-700 hover:border-primary-300"}`}>
            {i + 1}. {t.label}
          </button>
        ))}
      </nav>
      <p className="mt-2 h-4 text-xs text-foreground-500" role="status" aria-live="polite">
        {save === "saving" ? "Saving…" : save === "saved" ? "Draft saved" : save === "error" ? "" : "Changes save automatically while this is a draft."}
      </p>
      {saveError ? <p role="alert" className="mb-3 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{saveError}</p> : null}

      <section className="mt-4 rounded-card border border-background-200 bg-background-50 p-5">
        {tab === "details" ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email (confirmed)"><TextInput value={me.profile.email} readOnly disabled /></Field>
              <Field label="Mobile"><TextInput value={me.profile.phone_e164} readOnly disabled /></Field>
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} required={f.required} hint={f.hint}>
                  <TextInput type={f.type ?? "text"} value={values[f.key] ?? ""} name={f.key} data-testid={`staff-${f.key}`}
                    onChange={(e) => { setValues((v) => ({ ...v, [f.key]: e.target.value })); edit(f.key, e.target.value); }} />
                </Field>
              ))}
            </div>
            <p className="text-xs text-foreground-500">Upload your passport on the Documents step and we fill in blank details from it. You can change anything.</p>
          </div>
        ) : null}
        {tab === "documents" ? (me.requiredCategories ? <div className="space-y-5">
          <Field label="Are you an Australian citizen?" required><Select value={me.profile.is_australian_citizen == null ? "" : String(me.profile.is_australian_citizen)}
            disabled={save === "saving"} onChange={(e) => {
              const citizen = e.target.value === "true";
              setSave("saving"); setSaveError("");
              void setStaffCitizenship(citizen).then((next) => { onChange(next); setSave("saved"); },
                (e: Error) => { setSave("error"); setSaveError(e.message); });
            }}><option value="" disabled>Select an answer</option><option value="true">Yes</option><option value="false">No</option></Select></Field>
          {me.profile.is_australian_citizen != null ? <OnboardingDocuments me={me} uid={uid} onChange={onChange} /> : null}
        </div> : <DocumentsTab me={me} uid={uid} onChange={onChange} />) : null}
        {tab === "role" ? (
          <div className="space-y-3" role="radiogroup" aria-label="Requested role">
            <p className="text-sm text-foreground-700">Choose the role you are applying for. This is a request only: nothing is granted until an administrator approves it.</p>
            {(Object.keys(ROLE_TEXT) as StaffRole[]).map((role) => {
              const selected = me.application.requested_role === role;
              return (
                <button key={role} type="button" role="radio" aria-checked={selected} data-testid={`staff-role-${role}`}
                  onClick={() => { void saveStaffDraft({ requested_role: role }).then(onChange, (e: unknown) => setSaveError(e instanceof Error ? e.message : "Could not save.")); }}
                  className={`flex w-full cursor-pointer items-start gap-3 rounded-lg border p-4 text-left ${selected ? "border-primary-500 bg-primary-50 ring-1 ring-primary-500" : "border-background-300 bg-background-50 hover:border-primary-300"}`}>
                  <span><span className="block font-heading text-sm font-bold text-foreground-950">{ROLE_TEXT[role].title}</span><span className="block text-xs text-foreground-600">{ROLE_TEXT[role].text}</span></span>
                </button>
              );
            })}
          </div>
        ) : null}
        {tab === "review" ? (
          <div className="space-y-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {[["Name", [values.first_name, values.middle_name, values.last_name].filter(Boolean).join(" ")], ["Date of birth", values.date_of_birth], ["Email", me.profile.email], ["Mobile", me.profile.phone_e164],
                ["Address", [values.address_street, values.address_line2, values.address_suburb, values.address_state, values.address_postcode, values.address_country].filter(Boolean).join(", ")],
                ["Emergency contact", [values.emergency_name, values.emergency_relationship, values.emergency_phone].filter(Boolean).join(" · ")],
                ["Requested role", me.application.requested_role ? ROLE_TEXT[me.application.requested_role].title : ""],
                ["Documents", me.documents.map((d) => d.category).join(", ")]].map(([k, v]) => (
                <div key={k}><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{k}</dt><dd className="text-foreground-900">{v || "—"}</dd></div>
              ))}
            </dl>
            {problems.length ? (
              <ul className="list-disc space-y-1 rounded-md border border-primary-200 bg-primary-50 py-2.5 pl-8 pr-3 text-[13px] text-primary-900" data-testid="staff-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            ) : null}
            {submitError ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{submitError}</p> : null}
            <Button type="button" onClick={() => void submit()} disabled={submitting} data-testid="staff-submit">{submitting ? "Submitting…" : "Submit application"}</Button>
            <p className="text-xs text-foreground-500">After you submit, the reviewer may ask you to replace documents or update your application.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DocumentsTab({ me, uid, onChange }: { me: StaffMe; uid: string; onChange: (m: StaffMe) => void }) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const reload = () => getMyStaffApplication().then((next) => { if (next) onChange(next); }, () => undefined);

  const upload = async (category: StaffDocCategory, file: File, key = `${category}-${Date.now()}-${file.name}`) => {
    setPending((list) => [...list.filter((p) => p.key !== key), { key, category, file }]);
    try { await uploadStaffDocument(me, uid, category, file); setPending((list) => list.filter((p) => p.key !== key)); await reload(); }
    catch (e) { setPending((list) => list.map((p) => (p.key === key ? { ...p, error: e instanceof Error ? e.message : "The upload failed." } : p))); }
  };

  return (
    <div className="space-y-8">
      {STAFF_WIZARD_STEPS.map((step) => (
        <div key={step.category} data-testid={`staff-doc-${step.category.toLowerCase().replace(/\s+/g, "-")}`}>
          <WizardDocumentStep step={step}
            docs={me.documents.filter((d) => d.category === step.category).map(toWizardDoc)}
            pending={pending.filter((p) => p.category === step.category)} dismissed={dismissed}
            onPickFiles={(files) => { const file = files?.[0]; if (file) void upload(step.category as StaffDocCategory, file); }}
            onRetryUpload={(item) => void upload(step.category as StaffDocCategory, item.file, item.key)}
            onDropUpload={(item) => setPending((list) => list.filter((p) => p.key !== item.key))}
            onRetryDoc={(doc) => { void requestStaffExtraction(doc.id).then(reload); }}
            onDismissDoc={(doc) => setDismissed((s) => new Set(s).add(doc.id))}
            onRemoveDoc={async (doc) => { await removeStaffDocument(doc.id); await reload(); }}
            signedUrl={(doc) => staffDocumentUrl(doc.storagePath)} />
        </div>
      ))}
    </div>
  );
}

function OnboardingDocuments({ me, uid, onChange }: { me: StaffMe; uid: string; onChange: (m: StaffMe) => void }) {
  const draft = me.profile.status === "draft";
  return <div className="grid gap-3 sm:grid-cols-2">{me.requiredCategories?.flatMap((category) => {
    const docs = me.documents.filter((d) => d.category === category);
    const shown = draft ? docs : docs.filter((d) => d.status === "rejected");
    return (shown.length ? shown : draft ? [null] : []).map((doc) =>
      <OnboardingFile key={doc?.id ?? category} uid={uid} category={category} doc={doc} onChange={onChange} />);
  })}</div>;
}

function OnboardingFile({ uid, category, doc, onChange }: { uid: string; category: OnboardingCategory; doc: StaffDocument | null; onChange: (m: StaffMe) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [expiry, setExpiry] = useState(doc?.expiryDate ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file || busy) return;
    if (category !== "Academic" && !expiry) { setError("Enter the expiry date."); return; }
    setBusy(true); setError("");
    try {
      await uploadOnboardingDocument(uid, category, file, expiry, doc?.id ?? null);
      const next = await getMyStaffApplication();
      if (next) onChange(next);
      setFile(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 rounded-md border border-background-200 p-3">
    <h3 className="font-semibold">{category}</h3>
    {doc ? <p className="break-words text-sm">{doc.filename} {doc.status ? <Badge>{doc.status}</Badge> : null}</p> : null}
    {doc?.reviewNote ? <p className="text-sm">{doc.reviewNote}</p> : null}
    {category !== "Academic" ? <Field label={`${category} expiry date`} required><TextInput type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field> : null}
    <Field label={doc ? `Replace ${category.toLowerCase()}` : `Choose ${category.toLowerCase()} file`}><input className="block w-full text-sm" type="file"
      accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
    <Button size="sm" disabled={!file || busy} onClick={() => void upload()}>{busy ? "Uploading…" : doc ? "Replace file" : "Upload file"}</Button>
    {error ? <p role="alert" className="text-sm text-primary-700">{error}</p> : null}
  </div>;
}
