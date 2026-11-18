import { useMemo, useRef, useState, type ReactNode } from "react";
import WizardShell, { WIZARD_PRIMARY_CLASS, WizardBackButton, WizardNotice } from "@/components/shared/wizard/WizardShell";
import WizardStepper from "@/components/shared/wizard/WizardStepper";
import { FieldError, WIZARD_INPUT, WizardLabel, WizardTextField } from "@/components/shared/wizard/fields";
import SignaturePad from "@/components/signing/SignaturePad";
import { pictureToPng } from "@/components/signing/signatureImage";
import { fieldGroup, signingAction, signWithRetry, type SigningView } from "@/lib/signingApi";
import { abrFactLines, checkApplicationAnswers, F04_TITLES, printAcn, type AbrFacts } from "../../../supabase/functions/_shared/validation/abr";
import { AU_STATES } from "../../../supabase/functions/_shared/validation/person";
import { composeRegistrationNumber, F04_DECLARATION_INTRO, F04_DECLARATIONS } from "../../../supabase/functions/_shared/agent-onboarding";

/*
 * The Agent Application Form (F04) as a step-by-step wizard (owner brief 2026-11-19), built from the shared wizard frame (WizardShell,
 * WizardStepper, the wizard fields) used by the student and staff wizards. Only the F04 uses it; the F05 referee checks and the P06 agreement
 * keep the document signing page. The answers fill the same F04 template fields (same keys), so the signed PDF, the stored answers and the
 * referee checks sent after signing do not change. Steps: Company, Contact, Agent details, References, Declaration; then a confirmation.
 * Every check here is repeated by the server (document-signing core.ts and the database) before anything is signed.
 */

type Answers = Record<string, string>;
type Field = SigningView["fields"][number];
/** What "Save and continue later" keeps on the server. */
export interface F04Draft { answers: Answers; acn: string; marn: string; declarations: Record<string, boolean>; step: number }

const STEPS = [
  { id: "company", short: "Company", icon: "ri-building-line", title: "Company", text: "Your business as the government register knows it. Check it and add what is missing." },
  { id: "contact", short: "Contact", icon: "ri-contacts-line", title: "Contact details", text: "Who we deal with, and your office address." },
  { id: "agent", short: "Agent details", icon: "ri-briefcase-line", title: "Agent details", text: "About your agency and how you recruit students." },
  { id: "references", short: "References", icon: "ri-team-line", title: "References", text: "Two references. Each referee is emailed a short form to complete after you submit." },
  { id: "declaration", short: "Declaration", icon: "ri-quill-pen-line", title: "Declaration", text: "Read and tick each statement, then sign." },
] as const;

const COMPANY: Array<[string, string]> = [["agent_legal_entity", "Legal entity"], ["agent_trading_name", "Trading name"], ["agent_agency_name", "Agent / agency name"], ["agent_abn", "ABN"], ["agent_year_founded", "Year founded"]];
const CONTACT_TEXT: Array<[string, string, { type?: string; inputMode?: "numeric" | "text"; autoComplete?: string; wide?: boolean }?]> = [
  ["contact_given_name", "Given name", { autoComplete: "given-name" }], ["contact_family_name", "Family name", { autoComplete: "family-name" }],
  ["contact_position", "Position", { autoComplete: "organization-title" }], ["contact_email", "Email", { type: "email", autoComplete: "email" }],
  ["contact_phone", "Phone", { type: "tel", autoComplete: "tel" }], ["agent_website", "Website", { autoComplete: "url" }], ["agent_fax", "Fax", { type: "tel" }],
];
const QUESTIONS: Array<{ key: string; label: string; follow?: { key: string; label: string } }> = [
  { key: "org_chart_attached", label: "Do you have an organisational chart to attach?" },
  { key: "business_profile_attached", label: "Do you have a business profile or strategic plan to attach?" },
  { key: "litigation_involved", label: "Has the company or anyone in it ever been involved in past, pending, threatened or potential litigation, arbitration, administrative actions or other disputes?",
    follow: { key: "litigation_details", label: "Details of the litigation or dispute" } },
  { key: "eatc_completed", label: "Have you or your staff completed the EATC training (PIER Online)?", follow: { key: "eatc_details", label: "Who completed it, and when" } },
  { key: "works_with_sub_agents", label: "Have you worked, or do you work, with sub-agents?", follow: { key: "sub_agent_names", label: "Name of the sub-agent agency" } },
];
const AGENT_TEXT: Array<[string, string, boolean?]> = [
  ["agent_years_as_education_agent", "Years as an education agent"], ["students_recruited_per_year", "Students recruited to Australian institutions each year"],
  ["popular_courses", "Popular courses amongst your students", true], ["slit_promotion_plan", "How you intend to promote SLIT in your office", true],
  ["slit_recruitment_target", "Students you intend to recruit to SLIT each year"], ["staff_count", "Number of staff"], ["services_provided", "Services provided to students", true],
  ["associations", "Associations you are a member of", true], ["number_of_offices", "Number of offices (locations)"],
  ["other_countries_recruited", "Other countries you recruit students to (if any)", true], ["australian_institutions_represented", "Australian institutions you represent (if any)", true],
];
const REF_FIELDS: Array<[string, string, { type?: string }?]> = [["contact_name", "Contact name"], ["organisation", "Organisation"], ["position", "Position"], ["email", "Email", { type: "email" }], ["phone", "Phone", { type: "tel" }], ["address", "Address"]];
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;
const yesNo = (value: string | undefined) => (value ?? "").toUpperCase();

/** The value key of a field (agent_abn_form -> agent_abn; a tick box -> its question). */
const keyOf = (f: Field) => String(f.key ?? "").replace(/_(form|referee)$/, "").replace(/:.*$/, "");

/** The answers the page opens with: the fields' prefilled values, then the register's facts where the field is empty, then the saved draft. */
function initialF04(fields: readonly Field[], facts: Partial<AbrFacts> | null, draft: Partial<F04Draft> | null): F04Draft {
  const answers: Answers = {};
  for (const f of fields) {
    if (!f.key) continue;
    const group = fieldGroup(f.key);
    if (group) { if (f.value === "true") answers[group.key] = group.answer; continue; }
    if (f.type === "text" && f.value) answers[keyOf(f)] = f.value;
  }
  const has = (key: string) => fields.some((f) => keyOf(f) === key);
  const fill = (key: string, value: string | undefined) => { if (value && has(key) && !answers[key]) answers[key] = value; };
  if (facts) {
    fill("agent_legal_entity", facts.entityName); fill("agent_trading_name", facts.entityName); fill("agent_agency_name", facts.entityName);
    fill("agent_year_founded", (facts.statusFrom ?? "").slice(0, 4));
    if (has("agent_gst_registered") && !answers.agent_gst_registered && typeof facts.gstRegistered === "boolean") answers.agent_gst_registered = facts.gstRegistered ? "YES" : "NO";
  }
  // The registration box is composed from the ACN and the MARN; a value typed there earlier is not shown again.
  delete answers.agent_registration_number;
  const base: F04Draft = { answers, acn: facts?.acn ? printAcn(facts.acn) : "", marn: "", declarations: {}, step: 0 };
  if (!draft) return base;
  return { answers: { ...answers, ...(draft.answers ?? {}) }, acn: draft.acn ?? base.acn, marn: draft.marn ?? "", declarations: { ...(draft.declarations ?? {}) }, step: Math.min(Math.max(Number(draft.step) || 0, 0), STEPS.length - 1) };
}

/** The signing values (by field id) the answers give: text by key, a tick box "true" when its answer is chosen. */
function f04Values(fields: readonly Field[], state: F04Draft): Record<string, string> {
  const values: Record<string, string> = {};
  for (const f of fields) {
    if (!f.key) continue;
    const group = fieldGroup(f.key);
    if (group) { values[f.id] = yesNo(state.answers[group.key]) === group.answer ? "true" : "false"; continue; }
    if (f.type !== "text") continue;
    const key = keyOf(f);
    values[f.id] = key === "agent_registration_number" ? composeRegistrationNumber(state.acn, state.marn) : (state.answers[key] ?? "").trim();
  }
  return values;
}

/** The problems of one step (field key -> message). Required fields come from the form's own fields; follow-ups only when their answer is Yes. */
function f04Problems(step: number, fields: readonly Field[], state: F04Draft): Record<string, string> {
  const p: Record<string, string> = {};
  const a = state.answers;
  const field = (key: string) => fields.find((f) => keyOf(f) === key);
  const required = (key: string) => fields.some((f) => keyOf(f) === key && f.required);
  const need = (key: string, message: string) => { if (field(key) && required(key) && !(a[key] ?? "").trim()) p[key] = message; };
  if (step === 0) {
    for (const [key, label] of COMPANY) need(key, `Enter the ${label.toLowerCase()}.`);
    if ((a.agent_abn ?? "").trim() && (a.agent_abn ?? "").replace(/\s/g, "").length !== 11) p.agent_abn = "The ABN has 11 digits.";
    if (state.acn.trim() && !/^\d{9}$/.test(state.acn.replace(/\s/g, ""))) p.acn = "The ACN has 9 digits.";
    if (state.marn.trim() && !/^\d{1,10}$/.test(state.marn.replace(/\s/g, ""))) p.marn = "The MARN is a number: digits only.";
    if ((a.agent_year_founded ?? "").trim() && !/^\d{4}$/.test((a.agent_year_founded ?? "").trim())) p.agent_year_founded = "Enter the year as four digits, for example 2015.";
  }
  if (step === 1) {
    for (const [key, label] of CONTACT_TEXT) need(key, `Enter the ${label.toLowerCase()}.`);
    need("office_street_address", "Enter the street address."); need("office_country", "Enter the country.");
    if ((a.contact_email ?? "").trim() && !EMAIL.test((a.contact_email ?? "").trim())) p.contact_email = "Enter a valid email address.";
    const title = checkApplicationAnswers({ contact_title: a.contact_title ?? "" });
    if (title.error) p.contact_title = title.error;
  }
  if (step === 2) {
    for (const q of QUESTIONS) {
      const asked = fields.some((f) => fieldGroup(f.key)?.key === q.key);
      if (asked && fields.some((f) => fieldGroup(f.key)?.key === q.key && f.required) && !["YES", "NO"].includes(yesNo(a[q.key]))) p[q.key] = "Choose Yes or No.";
      if (q.follow && q.key !== "eatc_completed" && yesNo(a[q.key]) === "YES" && field(q.follow.key) && !(a[q.follow.key] ?? "").trim()) p[q.follow.key] = `Enter the ${q.follow.label.toLowerCase()}.`;
    }
    for (const [key, label] of AGENT_TEXT) need(key, `Enter the ${label.toLowerCase()}.`);
  }
  if (step === 3) {
    for (const n of [1, 2]) {
      for (const [part, label] of REF_FIELDS) need(`ref${n}_${part}`, `Enter reference ${n}'s ${label.toLowerCase()}.`);
      const email = (a[`ref${n}_email`] ?? "").trim();
      if (email && !EMAIL.test(email)) p[`ref${n}_email`] = "Enter a valid email address.";
    }
    const checked = checkApplicationAnswers({ ref1_email: a.ref1_email ?? "", ref2_email: a.ref2_email ?? "" });
    if (checked.error) p.ref2_email = checked.error;
  }
  if (step === 4) {
    for (const d of F04_DECLARATIONS) if (state.declarations[d.key] !== true) p[`declaration_${d.key}`] = "Tick this statement to continue.";
    need("declarant_name", "Enter your full name."); need("declarant_role", "Enter your role.");
    if ((a.declarant_name ?? "").trim().length < 2) p.declarant_name = "Enter your full name.";
  }
  return p;
}

function YesNoToggle({ id, label, value, error, onChange, required }: { id: string; label: string; value: string; error?: string; onChange: (v: "YES" | "NO") => void; required: boolean }) {
  return (
    <fieldset className="rounded-lg border border-background-200 p-3 sm:p-4" data-testid={`f04-q-${id}`}>
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-medium text-foreground-800" id={`${id}-label`}>{label}{required ? <span className="text-primary-600"> *</span> : null}</p>
        <div role="radiogroup" aria-labelledby={`${id}-label`} aria-invalid={Boolean(error)} className="inline-flex shrink-0 overflow-hidden rounded-md border border-background-300">
          {(["YES", "NO"] as const).map((answer) => (
            <button key={answer} type="button" role="radio" aria-checked={value === answer} onClick={() => onChange(answer)} data-testid={`f04-${id}-${answer.toLowerCase()}`}
              className={`min-w-16 cursor-pointer px-4 py-2 text-sm font-semibold transition-colors ${value === answer ? "bg-primary-500 text-background-50" : "bg-background-50 text-foreground-700 hover:bg-background-100"}`}>
              {answer === "YES" ? "Yes" : "No"}
            </button>
          ))}
        </div>
      </div>
      <FieldError text={error} />
    </fieldset>
  );
}

function TextArea({ id, label, value, error, required, onChange }: { id: string; label: string; value: string; error?: string; required: boolean; onChange: (v: string) => void }) {
  return (
    <div>
      <WizardLabel htmlFor={id} required={required}>{label}</WizardLabel>
      <textarea id={id} value={value} rows={2} maxLength={500} aria-invalid={Boolean(error)} className={WIZARD_INPUT} data-testid={`f04-${id}`} onChange={(e) => onChange(e.target.value)} />
      <FieldError text={error} />
    </div>
  );
}

export default function F04Wizard({ token, view, codeCheck, onSigned }: {
  token: string; view: SigningView;
  /** The emailed-code check when the request asks for one (rendered on the Declaration step); null when not needed or done. */
  codeCheck: { needed: boolean; session: string | null; render: () => ReactNode };
  onSigned: () => Promise<void> | void;
}) {
  const fields = view.fields;
  const facts = (view.application?.facts ?? null) as Partial<AbrFacts> | null;
  const opening = useMemo(() => initialF04(fields, facts, (view.application?.draft ?? null) as Partial<F04Draft> | null), [fields, facts, view.application?.draft]);
  const [state, setState] = useState<F04Draft>(() => ({ ...opening, answers: { declarant_name: opening.answers.declarant_name || view.recipient.name, ...opening.answers } }));
  const [step, setStep] = useState(opening.step);
  const [tried, setTried] = useState<Set<number>>(new Set());
  const [editCompany, setEditCompany] = useState(false);
  const [method, setMethod] = useState<"typed" | "drawn" | "uploaded">("typed");
  const [picture, setPicture] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "sign">("");
  const [notice, setNotice] = useState<{ tone: "info" | "error" | "warn"; text: string } | null>(view.application?.savedAt ? { tone: "info", text: `Welcome back. Your answers saved on ${new Date(view.application.savedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })} are filled in.` } : null);
  const top = useRef<HTMLDivElement>(null);
  // The values the form opened with: shown as the Company summary (with Edit); an empty one is asked for straight away.
  const prefilled = useRef(new Set(Object.entries(opening.answers).filter(([, v]) => v.trim()).map(([k]) => k)));
  const has = (key: string) => fields.some((f) => keyOf(f) === key);
  const isRequired = (key: string) => fields.some((f) => keyOf(f) === key && f.required);
  const asks = (question: string) => fields.some((f) => fieldGroup(f.key)?.key === question);

  const problems = f04Problems(step, fields, state);
  const shown = tried.has(step) ? problems : {};
  const allProblems = STEPS.map((_, i) => f04Problems(i, fields, state));
  const set = (key: string, value: string) => setState((s) => ({ ...s, answers: { ...s.answers, [key]: value } }));
  const warnings = step === 3 ? checkApplicationAnswers({ ref1_contact_name: state.answers.ref1_contact_name ?? "", ref2_contact_name: state.answers.ref2_contact_name ?? "" }).warnings : [];
  const signatureReady = method === "typed" ? (state.answers.declarant_name ?? "").trim().length >= 2 : !!picture;
  const canSubmit = Object.keys(problems).length === 0 && consent && signatureReady && (!codeCheck.needed || !!codeCheck.session);

  const draft = (at = step): F04Draft => ({ ...state, step: at });
  const save = async (quiet: boolean, at = step) => {
    if (!quiet) setBusy("save");
    try {
      await signingAction({ action: "draft_save", token, draft: draft(at) });
      if (!quiet) setNotice({ tone: "info", text: "Saved. Use the link in your email to come back and carry on; your answers will be filled in." });
    } catch (e) { if (!quiet) setNotice({ tone: "error", text: e instanceof Error ? e.message : "Your answers could not be saved." }); }
    finally { if (!quiet) setBusy(""); }
  };
  const goTo = (index: number) => {
    // Forward only once the steps before are complete; back always.
    if (index > step) {
      for (let i = step; i < index; i++) if (Object.keys(allProblems[i]).length) { setTried((t) => new Set(t).add(i)); setStep(i); return; }
    }
    setStep(index); setNotice(null); top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const next = () => {
    setTried((t) => new Set(t).add(step));
    if (Object.keys(problems).length) { setNotice({ tone: "error", text: "Some answers are missing or need a fix. They are marked below." }); return; }
    setNotice(null);
    void save(true, step + 1);
    goTo(step + 1);
  };
  const submit = async () => {
    setTried((t) => new Set(t).add(step));
    if (!canSubmit || busy) return;
    setBusy("sign"); setNotice(null);
    try {
      await signWithRetry({ action: "sign", token, name: (state.answers.declarant_name ?? "").trim(), agreed: true, signatureKind: method, signatureImage: method === "typed" ? null : picture,
        values: f04Values(fields, state), documentHash: view.documentHash, codeSession: codeCheck.session,
        application: { acn: state.acn.replace(/\s/g, ""), marn: state.marn.replace(/\s/g, ""), declarations: state.declarations } });
      await onSigned();
    } catch (e) { setNotice({ tone: "error", text: e instanceof Error ? e.message : "The form could not be submitted. Please try again." }); }
    finally { setBusy(""); }
  };

  const text = (key: string, label: string, options: { type?: string; inputMode?: "numeric" | "text"; autoComplete?: string; maxLength?: number; required?: boolean; children?: ReactNode } = {}) =>
    has(key) ? <WizardTextField key={key} id={`f04-${key}`} name={key} label={label} value={state.answers[key] ?? ""} error={shown[key]} required={options.required ?? isRequired(key)}
      type={options.type} inputMode={options.inputMode} autoComplete={options.autoComplete ?? "off"} maxLength={options.maxLength ?? 500} testId={`f04-${key}`} onChange={(v) => set(key, v)}>{options.children}</WizardTextField> : null;

  const factLines = abrFactLines(facts);
  const summary = COMPANY.filter(([key]) => has(key) && prefilled.current.has(key) && (state.answers[key] ?? "").trim() && !problems[key]);
  const acnPrefilled = !!opening.acn && !problems.acn;
  const gstAnswer = yesNo(state.answers.agent_gst_registered);

  const body = (() => {
    if (step === 0) return (
      <div className="space-y-5">
        {(summary.length || acnPrefilled || factLines.length) && !editCompany ? (
          <section className="rounded-lg border border-background-200 bg-background-100/60 p-4" data-testid="f04-company-summary">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground-900">From the Australian Business Register</h3>
              <button type="button" onClick={() => setEditCompany(true)} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100" data-testid="f04-company-edit">
                <i className="ri-edit-line" aria-hidden="true" />Edit</button>
            </div>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {summary.map(([key, label]) => <div key={key} className="min-w-0"><dt className="text-xs text-foreground-500">{label}</dt><dd className="break-words font-medium text-foreground-900">{state.answers[key]}</dd></div>)}
              {acnPrefilled ? <div className="min-w-0"><dt className="text-xs text-foreground-500">ACN</dt><dd className="font-medium text-foreground-900" data-testid="f04-summary-acn">{state.acn}</dd></div> : null}
              {has("agent_gst_registered") && prefilled.current.has("agent_gst_registered") && gstAnswer ? <div><dt className="text-xs text-foreground-500">GST registered</dt><dd className="font-medium text-foreground-900">{gstAnswer === "YES" ? "Yes" : "No"}</dd></div> : null}
            </dl>
            {factLines.length ? <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-background-200 pt-3 text-xs text-foreground-600 sm:grid-cols-3" data-testid="f04-abr-facts">
              {factLines.map((line) => <div key={line.label}><dt className="text-foreground-500">{line.label}</dt><dd className="text-foreground-800">{line.value}</dd></div>)}
            </dl> : null}
          </section>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {COMPANY.filter(([key]) => editCompany || !summary.some(([k]) => k === key)).map(([key, label]) => text(key, label, key === "agent_year_founded" ? { inputMode: "numeric", maxLength: 4 } : key === "agent_abn" ? { inputMode: "numeric", maxLength: 14 } : {}))}
          {editCompany || !acnPrefilled ? <WizardTextField id="f04-acn" name="acn" label="ACN" required={false} value={state.acn} error={shown.acn} inputMode="numeric" maxLength={11} testId="f04-acn"
            onChange={(v) => setState((s) => ({ ...s, acn: v.replace(/[^\d\s]/g, "") }))} /> : null}
          <WizardTextField id="f04-marn" name="marn" label="MARA number (MARN), if registered" required={false} value={state.marn} error={shown.marn} inputMode="numeric" maxLength={10} testId="f04-marn"
            onChange={(v) => setState((s) => ({ ...s, marn: v.replace(/\D/g, "") }))} />
        </div>
        {has("agent_gst_registered") && (editCompany || !prefilled.current.has("agent_gst_registered") || !gstAnswer) ? (
          <YesNoToggle id="agent_gst_registered" label="Is the business registered for GST?" value={gstAnswer} error={shown.agent_gst_registered} required={false} onChange={(v) => set("agent_gst_registered", v)} />
        ) : null}
      </div>
    );
    if (step === 1) {
      const australian = /^(australia|au)$/i.test((state.answers.office_country ?? "").trim());
      return (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {has("contact_title") ? <div>
              <WizardLabel htmlFor="f04-contact_title" required={isRequired("contact_title")}>Title</WizardLabel>
              <select id="f04-contact_title" value={state.answers.contact_title ?? ""} aria-invalid={Boolean(shown.contact_title)} className={WIZARD_INPUT} data-testid="f04-contact_title" onChange={(e) => set("contact_title", e.target.value)}>
                <option value="">Select</option>{F04_TITLES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <FieldError text={shown.contact_title} />
            </div> : null}
            {CONTACT_TEXT.map(([key, label, o]) => text(key, label, o ?? {}))}
          </div>
          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-foreground-900">Office address</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">{text("office_street_address", "Street address", { autoComplete: "street-address" })}</div>
              {text("office_suburb", "Suburb or city", { autoComplete: "address-level2" })}
              {has("office_state") ? (australian ? <div>
                <WizardLabel htmlFor="f04-office_state" required={isRequired("office_state")}>State or territory</WizardLabel>
                <select id="f04-office_state" value={(state.answers.office_state ?? "").toUpperCase()} className={WIZARD_INPUT} data-testid="f04-office_state" onChange={(e) => set("office_state", e.target.value)}>
                  <option value="">Select</option>{AU_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div> : text("office_state", "State or region")) : null}
              {text("office_province", "Postcode", { inputMode: australian ? "numeric" : "text", autoComplete: "postal-code", maxLength: 20 })}
              {text("office_country", "Country", { autoComplete: "country-name" })}
            </div>
          </fieldset>
        </div>
      );
    }
    if (step === 2) return (
      <div className="space-y-4">
        {QUESTIONS.filter((q) => asks(q.key)).map((q) => (
          <div key={q.key} className="space-y-3">
            <YesNoToggle id={q.key} label={q.label} value={yesNo(state.answers[q.key])} error={shown[q.key]} required={fields.some((f) => fieldGroup(f.key)?.key === q.key && f.required)} onChange={(v) => set(q.key, v)} />
            {q.follow && has(q.follow.key) && yesNo(state.answers[q.key]) === "YES" ? (
              <TextArea id={q.follow.key} label={q.follow.label} value={state.answers[q.follow.key] ?? ""} error={shown[q.follow.key]} required={q.key !== "eatc_completed"} onChange={(v) => set(q.follow!.key, v)} />
            ) : null}
          </div>
        ))}
        <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
          {AGENT_TEXT.filter(([key]) => has(key)).map(([key, label, long]) => long
            ? <div key={key} className="sm:col-span-2"><TextArea id={key} label={label} value={state.answers[key] ?? ""} error={shown[key]} required={isRequired(key)} onChange={(v) => set(key, v)} /></div>
            : text(key, label))}
        </div>
      </div>
    );
    if (step === 3) return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[1, 2].map((n) => (
          <section key={n} className="rounded-lg border border-background-200 p-4" data-testid={`f04-reference-${n}`}>
            <h3 className="mb-3 text-sm font-semibold text-foreground-900">Reference {n}</h3>
            <div className="space-y-4">{REF_FIELDS.map(([part, label, o]) => text(`ref${n}_${part}`, label, { type: o?.type }))}</div>
          </section>
        ))}
        {warnings.map((w) => <p key={w} role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 lg:col-span-2" data-testid="f04-reference-warning">{w}</p>)}
      </div>
    );
    return (
      <div className="space-y-5">
        <p className="text-sm text-foreground-800">{F04_DECLARATION_INTRO}</p>
        <ul className="space-y-3">
          {F04_DECLARATIONS.map((d) => (
            <li key={d.key}>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-background-200 p-3 text-sm text-foreground-800 hover:bg-background-100/60" data-testid={`f04-declaration-${d.key}`}>
                <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer" checked={state.declarations[d.key] === true} aria-invalid={Boolean(shown[`declaration_${d.key}`])}
                  onChange={(e) => setState((s) => ({ ...s, declarations: { ...s.declarations, [d.key]: e.target.checked } }))} />
                <span>{d.text}<span className="text-primary-600"> *</span>
                  {d.link ? <> <a href={d.link.href} target="_blank" rel="noreferrer" className="font-semibold text-primary-700 underline underline-offset-2" onClick={(e) => e.stopPropagation()}>{d.link.label}</a></> : null}
                  <FieldError text={shown[`declaration_${d.key}`]} /></span>
              </label>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {text("declarant_name", "Your full name", { autoComplete: "name", required: true })}
          {text("declarant_role", "Your role", { autoComplete: "organization-title", required: true })}
        </div>
        <div>
          <p className="mb-2 text-label font-medium text-foreground-800">Your signature <span className="text-primary-600">*</span></p>
          <div role="tablist" className="mb-3 flex flex-wrap gap-2">{([["typed", "Type"], ["drawn", "Draw"], ["uploaded", "Upload a picture"]] as const).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => { setMethod(id); setPicture(null); }}
              className={`cursor-pointer rounded-full border px-4 py-2 text-sm font-medium ${method === id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50"}`}>{label}</button>)}</div>
          {method === "typed" ? <p className="min-h-16 rounded-md border border-background-300 bg-background-50 px-4 py-3 text-2xl italic text-[#0d1a4d]" data-testid="f04-typed-signature">{state.answers.declarant_name || "Your name appears here as your signature"}</p> : null}
          {method === "drawn" ? <SignaturePad onChange={setPicture} /> : null}
          {method === "uploaded" ? <div className="space-y-2">
            <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Signature picture" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; void pictureToPng(file).then((png) => setPicture(png)).catch((err: Error) => { setPicture(null); setNotice({ tone: "error", text: err.message }); }); }} />
            {picture ? <img src={`data:image/png;base64,${picture}`} alt="Your signature" className="max-h-24 rounded border border-background-300 bg-background-50 p-1" /> : null}
          </div> : null}
        </div>
        <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" data-testid="f04-consent" /><span>{view.consent}<span className="text-primary-600"> *</span></span></label>
        {codeCheck.needed && !codeCheck.session ? codeCheck.render() : null}
      </div>
    );
  })();

  const last = step === STEPS.length - 1;
  return (
    <div ref={top} className="scroll-mt-4">
      <WizardShell variant="page" icon="ri-file-user-line" title="Agent application form" subtitle={<>For <strong>{view.onboarding?.agencyName ?? "your agency"}</strong> · step {step + 1} of {STEPS.length}: {STEPS[step].text}</>}
        stepper={<div data-testid="f04-stepper"><WizardStepper items={STEPS.map((s, i) => ({ id: s.id, short: s.short, icon: s.icon, done: i < step && Object.keys(allProblems[i]).length === 0 }))} current={step} onSelect={goTo} /></div>}
        footerStart={<>
          {step > 0 ? <WizardBackButton onClick={() => goTo(step - 1)} disabled={!!busy} /> : null}
          <button type="button" onClick={() => void save(false)} disabled={!!busy} className="cursor-pointer whitespace-nowrap text-sm font-semibold text-primary-700 underline-offset-2 hover:underline disabled:opacity-50" data-testid="f04-save-later">
            {busy === "save" ? "Saving…" : "Save and continue later"}</button>
        </>}
        footerEnd={last
          ? <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!canSubmit || !!busy} onClick={() => void submit()} data-testid="f04-submit">{busy === "sign" ? "Submitting…" : "Sign and submit"}<i className="ri-check-line" aria-hidden="true" /></button>
          : <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!!busy} onClick={next} data-testid="f04-next">Next<i className="ri-arrow-right-line" aria-hidden="true" /></button>}
        notices={<>
          {notice ? <WizardNotice tone={notice.tone}>{notice.text}</WizardNotice> : null}
          {last && !canSubmit && !busy ? <WizardNotice tone="info">{Object.keys(problems).length ? "Tick every statement and give your name and role." : !signatureReady ? "Add your signature." : !consent ? "Tick the agreement to sign electronically." : "Confirm the emailed code."}</WizardNotice> : null}
        </>}>
        <h3 className="mb-4 font-heading text-base font-semibold text-foreground-950">{STEPS[step].title}</h3>
        {body}
        <p className="mt-6 text-xs text-foreground-500"><span className="text-primary-600">*</span> required</p>
      </WizardShell>
    </div>
  );
}

/** After submit: the signed application to download. */
export function F04Done({ view, justSigned }: { view: SigningView; justSigned: boolean }) {
  return (
    <WizardShell variant="page" icon="ri-checkbox-circle-line" title="Application submitted" subtitle={view.onboarding?.agencyName ? `Agent application for ${view.onboarding.agencyName}` : "Agent application"}
      stepper={null} footerStart={null}
      footerEnd={<a href={view.url} download className={WIZARD_PRIMARY_CLASS} data-testid="f04-download"><i className="ri-download-line" aria-hidden="true" />Download your signed application (PDF)</a>}>
      <div role="status" className="space-y-2 text-sm text-foreground-800" data-testid={justSigned ? "f04-submitted" : "f04-already-submitted"}>
        <p className="font-semibold text-foreground-950">{justSigned ? "Thank you. Your application has been submitted." : "This application has been signed and submitted."}{view.signedAt ? ` Signed ${new Date(view.signedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}.` : ""}</p>
        <p>We now email each of your two referees a short form. Our team reviews the references and then sends you the agent agreement to sign.</p>
        <p className="text-xs text-foreground-500">The download link works for a few minutes; reload this page for a new one.</p>
      </div>
    </WizardShell>
  );
}
