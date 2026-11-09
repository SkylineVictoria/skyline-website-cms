import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { DocumentChecklist, DocumentWizard, type DocumentAdapter, type WizardDocument } from "@/pages/agency/components/DocumentWizard";
import WorkspaceShell from "@/pages/agency/components/WorkspaceShell";
import { STAFF_WIZARD_STEPS, type WizardExtractionState } from "@/pages/agency/lib/wizardConfig";
import {
  getMyStaffApplication, removeStaffDocument, requestStaffExtraction, saveStaffDraft, setStaffCitizenship, setStaffDocumentExpiry, staffDocumentUrl,
  submitStaffApplication, uploadStaffDocument, type StaffDocument, type StaffMe,
} from "@/lib/staffApi";
import { STAFF_STATUS_LABEL, staffDocKinds, submitProblems, type StaffDocCategory, type StaffRole } from "@/lib/staffStatus";

/** Reading states in the shape the shared document screens use. */
const EXTRACTION: Record<StaffDocument["extractionStatus"], WizardExtractionState> = { pending: "queued", processing: "processing", done: "done", no_fields: "empty", failed: "failed", unavailable: "empty" };

type Tab = "details" | "documents" | "review";
const TABS: Array<{ id: Tab; label: string }> = [{ id: "details", label: "Personal details" }, { id: "documents", label: "Documents" }, { id: "review", label: "Review & submit" }];
const ROLE_TEXT: Record<StaffRole, { title: string; text: string }> = {
  admin: { title: "Admin", text: "Manage the website, applications and people. An administrator must confirm this." },
  trainer: { title: "Trainer", text: "Deliver training. This does not give access to the admin console." },
};
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";

type SaveState = "idle" | "saving" | "saved" | "error";
const DEBOUNCE_MS = 1000;

/** The staff workspace uses the same shell as the student portal. */
function Frame({ me, children, onSignOut }: { me?: StaffMe | null; children: ReactNode; onSignOut: () => void }) {
  const name = me ? [me.profile.first_name, me.profile.last_name].filter(Boolean).join(" ") : "";
  const isActiveAdmin = me?.profile.status === "active" && me.role === "admin";
  return (
    <WorkspaceShell
      portalLabel="Staff Portal"
      workspaceName={me?.profile.status === "active" ? "Staff workspace" : "My staff application"}
      roleLabel={me?.role && me.profile.status === "active" ? ROLE_TEXT[me.role].title : "Applicant"}
      nav={[{ to: "/staff", label: "My application", icon: "ri-file-user-line", end: true }]}
      sidebarFooter={isActiveAdmin ? (
        <Link to="/admin" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-foreground-700 transition-colors hover:bg-background-100">
          <i className="ri-shield-keyhole-line text-lg" aria-hidden="true" />
          Website CMS
        </Link>
      ) : null}
      displayName={name || me?.profile.email || "Staff"}
      email={me?.profile.email}
      onSignOut={onSignOut}
    >
      <div className="mx-auto max-w-4xl">{children}</div>
    </WorkspaceShell>
  );
}

/** The applicant's workspace: personal details, documents with expiry dates, review and submit; then the checklist and decisions. */
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
  const reading = me?.documents.some((d) => (d.extractionStatus === "pending" && ["Passport", "Visa", "English", "Driving Licence"].includes(d.category)) || d.extractionStatus === "processing") ?? false;
  useEffect(() => {
    if (!reading) { polls.current = 0; return; }
    if (polls.current >= 40) return;
    const timer = window.setTimeout(() => { polls.current += 1; void getMyStaffApplication().then((next) => next && setMe(next), () => undefined); }, 3000);
    return () => window.clearTimeout(timer);
  }, [reading, me]);

  const signOut = () => { void supabase.auth.signOut().then(() => navigate("/login", { replace: true })); };

  if (signedOut) return <Navigate to="/login?next=%2Fstaff" replace />;
  if (loadError) return <Frame onSignOut={signOut}><p role="alert" className={ALERT}>{loadError}</p></Frame>;
  if (me === undefined) return <Frame onSignOut={signOut}><p className="text-sm text-foreground-600" role="status">Loading your application…</p></Frame>;
  if (me === null) return <Navigate to="/staff/apply" replace />;

  return (
    <Frame me={me} onSignOut={signOut}>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-2xl font-bold text-foreground-950">{me.profile.first_name ? `Welcome, ${me.profile.first_name}` : "Your staff application"}</h1>
        <span data-testid="staff-status" className="rounded-full bg-secondary-100 px-3 py-1 text-xs font-semibold text-foreground-900">{STAFF_STATUS_LABEL[me.profile.status]}</span>
      </div>
      {me.profile.status === "invited" ? <DraftWizard me={me} uid={uid} onChange={setMe} /> : (
        <>
          <StatusPanel me={me} />
          <section className="mt-6 rounded-card border border-background-200 bg-background-50 p-5" aria-label="Document checklist">
            <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Document checklist</h2>
            <StaffChecklist me={me} uid={uid} onChange={setMe} canReupload={me.profile.status === "documents_submitted"} />
          </section>
        </>
      )}
      <Timeline me={me} />
    </Frame>
  );
}

/* ----------------------------------------------------------------- after submit: status and messages */

const STATUS_TEXT: Record<string, string> = {
  submitted: "Your application is with an administrator. Your requested role gives no access until they activate your account.",
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
      {me.role ? <p className="mt-2 text-sm text-foreground-700">Role: <strong>{ROLE_TEXT[me.role].title}</strong>{status === "active" ? "" : " (effective once your account is active)"}</p> : null}
      {status === "active" && me.role === "admin" ? <p className="mt-3"><Link to="/admin" className="font-semibold text-primary-700 hover:underline">Open the admin console</Link></p> : null}
      {status === "rejected" && me.application.review_note ? <p className="mt-2 rounded-md bg-background-100 px-3 py-2 text-sm text-foreground-800"><strong>Note from the administrator:</strong> {me.application.review_note}</p> : null}
      {me.summary.rejected > 0 && status === "documents_submitted" ? <p className={`mt-3 ${ALERT}`} role="status">An administrator asked you to replace {me.summary.rejected === 1 ? "a document" : `${me.summary.rejected} documents`}. See the note below and upload a new file.</p> : null}
    </section>
  );
}

function Timeline({ me }: { me: StaffMe }) {
  const items = me.events.filter((e) => e.note || e.to !== "applied");
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

/* ----------------------------------------------------------------- documents: the shared DocumentWizard with a staff adapter */

const toWizardDocument = (d: StaffDocument): WizardDocument => ({
  id: d.id, category: d.category, filename: d.filename, fileSize: d.fileSize, storagePath: d.storagePath,
  extraction: EXTRACTION[d.extractionStatus], error: d.extractionError ?? undefined, extracted: d.extracted,
  expiryDate: d.expiryDate, status: d.status, reviewNote: d.reviewNote,
});

/** Where staff documents live: the private staff-documents bucket and the hr_* functions. Every call ends with fresh data. */
function staffAdapter(uid: string, onChange: (m: StaffMe) => void): DocumentAdapter {
  const reload = async () => { const next = await getMyStaffApplication(); if (next) onChange(next); };
  return {
    upload: async (kind, file, expiryDate, replaces) => { await uploadStaffDocument(uid, kind.category as StaffDocCategory, file, expiryDate, replaces); await reload(); },
    remove: async (doc) => { await removeStaffDocument(doc.id); await reload(); },
    signedUrl: (doc) => staffDocumentUrl(doc.storagePath),
    setExpiry: async (doc, expiryDate) => { onChange(await setStaffDocumentExpiry(doc.id, expiryDate)); },
    extract: async (doc) => { await requestStaffExtraction(doc.id); await reload(); },
  };
}

function StaffChecklist({ me, uid, onChange, canReupload }: { me: StaffMe; uid: string; onChange: (m: StaffMe) => void; canReupload: boolean }) {
  return <DocumentChecklist kinds={staffDocKinds(me.profile.is_australian_citizen, me.documents)} documents={me.documents.map(toWizardDocument)}
    adapter={staffAdapter(uid, onChange)} canReupload={canReupload} testIdPrefix="staff" />;
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

function Choice({ selected, onClick, title, text, testId }: { selected: boolean; onClick: () => void; title: string; text?: string; testId: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} data-testid={testId} onClick={onClick}
      className={`flex w-full cursor-pointer items-start gap-3 rounded-lg border p-3.5 text-left ${selected ? "border-primary-500 bg-primary-50 ring-1 ring-primary-500" : "border-background-300 bg-background-50 hover:border-primary-300"}`}>
      <span><span className="block font-heading text-sm font-bold text-foreground-950">{title}</span>{text ? <span className="block text-xs text-foreground-600">{text}</span> : null}</span>
    </button>
  );
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
  const quick = (call: Promise<StaffMe>) => { void call.then(onChange, (e: unknown) => setSaveError(e instanceof Error ? e.message : "Could not save.")); };

  const citizen = me.profile.is_australian_citizen;
  const problems = submitProblems({
    firstName: values.first_name ?? "", lastName: values.last_name ?? "", dateOfBirth: values.date_of_birth || null, addressStreet: values.address_street ?? "", addressCountry: values.address_country ?? "",
    emergencyName: values.emergency_name ?? "", emergencyRelationship: values.emergency_relationship ?? "", emergencyPhone: values.emergency_phone || null,
    requestedRole: me.application.requested_role, isAustralianCitizen: citizen, documents: me.documents,
  });

  const submit = async () => {
    setSubmitError("");
    if (!(await flush())) return;
    setSubmitting(true);
    try { onChange(await submitStaffApplication()); }
    catch (e) { setSubmitError(e instanceof Error ? e.message : "Your application could not be submitted."); }
    finally { setSubmitting(false); }
  };

  const index = TABS.findIndex((t) => t.id === tab);
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
        {save === "saving" ? "Saving…" : save === "saved" ? "Draft saved" : save === "error" ? "" : "Changes save automatically until you submit."}
      </p>
      {saveError ? <p role="alert" className={`mb-3 ${ALERT}`}>{saveError}</p> : null}

      <section className="mt-4 rounded-card border border-background-200 bg-background-50 p-5">
        {tab === "details" ? (
          <div className="space-y-6">
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
            <div>
              <p className="mb-2 text-[13px] font-medium text-foreground-800">Are you an Australian citizen? <span className="text-primary-600">*</span></p>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Australian citizen">
                <Choice selected={citizen === true} onClick={() => quick(setStaffCitizenship(true))} title="Yes" text="No visa needed." testId="staff-citizen-yes" />
                <Choice selected={citizen === false} onClick={() => quick(setStaffCitizenship(false))} title="No" text="You will upload your visa." testId="staff-citizen-no" />
              </div>
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium text-foreground-800">Role you are applying for <span className="text-primary-600">*</span></p>
              <p className="mb-2 text-xs text-foreground-600">A request only: it gives no access until an administrator activates your account.</p>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Requested role">
                {(Object.keys(ROLE_TEXT) as StaffRole[]).map((role) => (
                  <Choice key={role} selected={me.application.requested_role === role} onClick={() => quick(saveStaffDraft({ requested_role: role }))} title={ROLE_TEXT[role].title} text={ROLE_TEXT[role].text} testId={`staff-role-${role}`} />
                ))}
              </div>
            </div>
            <p className="text-xs text-foreground-500">Upload your passport on the Documents step and we fill in blank details from it. You can change anything.</p>
          </div>
        ) : null}
        {tab === "documents" ? <DocumentsTab me={me} uid={uid} onChange={onChange} /> : null}
        {tab === "review" ? (
          <div className="space-y-5">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {[["Name", [values.first_name, values.middle_name, values.last_name].filter(Boolean).join(" ")], ["Date of birth", values.date_of_birth], ["Email", me.profile.email], ["Mobile", me.profile.phone_e164],
                ["Address", [values.address_street, values.address_line2, values.address_suburb, values.address_state, values.address_postcode, values.address_country].filter(Boolean).join(", ")],
                ["Emergency contact", [values.emergency_name, values.emergency_relationship, values.emergency_phone].filter(Boolean).join(" · ")],
                ["Australian citizen", citizen === null ? "" : citizen ? "Yes" : "No"],
                ["Requested role", me.application.requested_role ? ROLE_TEXT[me.application.requested_role].title : ""]].map(([k, v]) => (
                <div key={k}><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{k}</dt><dd className="text-foreground-900">{v || "—"}</dd></div>
              ))}
            </dl>
            <div>
              <h3 className="mb-2 font-heading text-sm font-bold text-foreground-950">Documents</h3>
              <StaffChecklist me={me} uid={uid} onChange={onChange} canReupload={false} />
            </div>
            {problems.length ? (
              <ul className={`list-disc space-y-1 py-2.5 pl-8 text-[13px] ${ALERT}`} data-testid="staff-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            ) : null}
            {submitError ? <p role="alert" className={ALERT}>{submitError}</p> : null}
            <Button type="button" onClick={() => void submit()} disabled={submitting} data-testid="staff-submit">{submitting ? "Submitting…" : "Submit application"}</Button>
            <p className="text-xs text-foreground-500">After you submit, you cannot edit the application. If an administrator rejects a document, you can upload a new one here.</p>
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

function DocumentsTab({ me, uid, onChange }: { me: StaffMe; uid: string; onChange: (m: StaffMe) => void }) {
  const steps = staffDocKinds(me.profile.is_australian_citizen, me.documents).flatMap((kind) => {
    const step = STAFF_WIZARD_STEPS.find((s) => s.category === kind.category);
    return step ? [{ kind, step }] : [];
  });
  return <DocumentWizard steps={steps} documents={me.documents.map(toWizardDocument)} adapter={staffAdapter(uid, onChange)} testIdPrefix="staff"
    notice={me.profile.is_australian_citizen === null ? "Answer the Australian citizen question on Personal details first: it decides whether a visa and an English test result are needed." : undefined} />;
}
