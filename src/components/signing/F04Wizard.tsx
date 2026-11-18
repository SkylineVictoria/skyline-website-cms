import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import WizardShell, { WIZARD_PRIMARY_CLASS, WizardBackButton, WizardNotice } from "@/components/shared/wizard/WizardShell";
import WizardStepper from "@/components/shared/wizard/WizardStepper";
import { FieldError, WIZARD_INPUT, WizardLabel, WizardTextField } from "@/components/shared/wizard/fields";
import AddressAutocomplete, { type AddressPick } from "@/components/shared/application-form/AddressAutocomplete";
import { PhoneInput } from "@/components/feature/applicationInputs";
import SignaturePad from "@/components/signing/SignaturePad";
import { fieldGroup, signingAction, signingAddressSearch, signWithRetry, type SigningView } from "@/lib/signingApi";
import { abrDateWords, checkApplicationAnswers, F04_TITLES, printAcn, YEAR_BEFORE_ABN_HINT, yearMayPredateAbn, type AbrFacts } from "../../../supabase/functions/_shared/validation/abr";
import { AU_STATES } from "../../../supabase/functions/_shared/validation/person";
import { formatPhone } from "../../../supabase/functions/_shared/validation/identifiers";
import { F04_ATTACHMENTS, F04_DECLARATION_INTRO, F04_DECLARATIONS, OMARA_REGISTER_URL, printAbn, type F04AttachmentKind } from "../../../supabase/functions/_shared/agent-onboarding";
import { allDeclarations, COMPANY_KEYS, COMPANY_LABEL, COUNTRIES, declarationsState, F04_STEPS as STEPS, f04Problems, f04Values, initialF04, isAustralia, keyOf, NUMBERS, POSITIONS, QUESTIONS, readChips, readChoice,
  REF_PARTS, REVIEW_STEP, SERVICES, TRADING_SAME_HINT, writeChips, writeChoice, yesNo, type F04Draft } from "./f04WizardLogic";

/*
 * The Agent Application Form (F04) as a short step-by-step wizard (owner briefs 2026-11-19; round 3 "less typing, nicer finish"), built
 * from the shared wizard frame (WizardShell, WizardStepper, the wizard fields) used by the student and staff wizards. Only the F04 uses it;
 * the F05 referee checks and the P06 agreement keep the document signing page. The answers fill the same F04 template fields (same keys),
 * so the signed PDF, the stored answers and the referee checks sent after signing do not change. Five steps: Business (the register's
 * values to confirm, MARN), Contact (title, position chips, office address by search), Agency (Yes / No toggles, chips, numbers),
 * References, Review & sign (every answer with an Edit link, "I agree to all", signature). The draft saves itself on every step change and
 * after typing pauses. Rules in f04WizardLogic.ts; every check is repeated by the server (document-signing core.ts and the database).
 */

export type { F04Draft };
type Attachments = Partial<Record<F04AttachmentKind, { name: string; size: number; at?: string }>>;
/** Autosave: after this pause in typing, and at most once in this many milliseconds (the link allows 60 calls in 10 minutes). */
const AUTOSAVE_PAUSE = 4000, AUTOSAVE_GAP = 30000;
const SCRIPT_FONT = "font-['Dancing_Script',cursive]";

function YesNo({ id, label, value, error, onChange, required, children }: { id: string; label: string; value: string; error?: string; onChange: (v: "YES" | "NO") => void; required: boolean; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-background-200 px-3 py-2.5" data-testid={`f04-q-${id}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground-800" id={`${id}-label`}>{label}{required ? <span className="text-primary-600"> *</span> : null}</p>
        <div role="radiogroup" aria-labelledby={`${id}-label`} aria-invalid={Boolean(error)} className="inline-flex shrink-0 overflow-hidden rounded-md border border-background-300">
          {(["YES", "NO"] as const).map((answer) => (
            <button key={answer} type="button" role="radio" aria-checked={value === answer} onClick={() => onChange(answer)} data-testid={`f04-${id}-${answer.toLowerCase()}`}
              className={`min-w-12 cursor-pointer px-3 py-1.5 text-xs font-semibold transition-colors ${value === answer ? "bg-primary-500 text-background-50" : "bg-background-50 text-foreground-700 hover:bg-background-100"}`}>
              {answer === "YES" ? "Yes" : "No"}
            </button>
          ))}
        </div>
      </div>
      <FieldError text={error} />
      {children ? <div className="mt-2.5">{children}</div> : null}
    </div>
  );
}

function TextArea({ id, label, value, error, required, onChange, rows = 2 }: { id: string; label: string; value: string; error?: string; required: boolean; onChange: (v: string) => void; rows?: number }) {
  return (
    <div>
      <WizardLabel htmlFor={id} required={required}>{label}</WizardLabel>
      <textarea id={id} value={value} rows={rows} maxLength={500} aria-invalid={Boolean(error)} className={WIZARD_INPUT} data-testid={`f04-${id}`} onChange={(e) => onChange(e.target.value)} />
      <FieldError text={error} />
    </div>
  );
}

const chipClass = (on: boolean) => `cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100"}`;

/** A multi-select of chips with an "Other" chip that opens a small text box; the value is the printed list ("A, B, other text"). */
function Chips({ id, label, value, options, error, onChange }: { id: string; label: string; value: string; options: readonly string[]; error?: string; onChange: (v: string) => void }) {
  const { picked, other } = readChips(value, options);
  const toggle = (option: string) => onChange(writeChips(picked.includes(option) ? picked.filter((p) => p !== option) : [...picked, option], other, options));
  return (
    <fieldset data-testid={`f04-${id}`}>
      <legend className="mb-1.5 text-label font-medium text-foreground-800">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => <button key={o} type="button" aria-pressed={picked.includes(o)} className={chipClass(picked.includes(o))} onClick={() => toggle(o)}>{o}</button>)}
        <button type="button" aria-pressed={other !== null} className={chipClass(other !== null)} onClick={() => onChange(writeChips(picked, other === null ? "" : null, options))} data-testid={`f04-${id}-other`}>Other</button>
      </div>
      {other !== null ? <input aria-label={`${label}: other`} value={other} maxLength={300} placeholder="Name them, separated by commas" className={`${WIZARD_INPUT} mt-2`} data-testid={`f04-${id}-other-text`}
        onChange={(e) => onChange(writeChips(picked, e.target.value, options))} /> : null}
      <FieldError text={error} />
    </fieldset>
  );
}

/** One choice of chips (the contact's position, the declarant's role): CEO / Director / Manager / Owner, or Other with a small text box. */
function ChoiceChips({ id, label, value, error, required, onChange }: { id: string; label: string; value: string; error?: string; required: boolean; onChange: (v: string) => void }) {
  const { picked, other } = readChoice(value, POSITIONS);
  return (
    <fieldset data-testid={`f04-${id}`} aria-invalid={Boolean(error)}>
      <legend className="mb-1.5 text-label font-medium text-foreground-800">{label}{required ? <span className="text-primary-600"> *</span> : null}</legend>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {POSITIONS.map((o) => <button key={o} type="button" role="radio" aria-checked={picked === o} className={chipClass(picked === o)} onClick={() => onChange(writeChoice(o, null))} data-testid={`f04-${id}-${o.toLowerCase()}`}>{o}</button>)}
        <button type="button" role="radio" aria-checked={other !== null} className={chipClass(other !== null)} onClick={() => onChange(writeChoice(null, other ?? ""))} data-testid={`f04-${id}-other`}>Other</button>
      </div>
      {other !== null ? <input aria-label={`${label}: other`} value={other} maxLength={120} placeholder="Type it" className={`${WIZARD_INPUT} mt-2 sm:max-w-xs`} data-testid={`f04-${id}-other-text`}
        onChange={(e) => onChange(writeChoice(null, e.target.value))} /> : null}
      <FieldError text={error} />
    </fieldset>
  );
}

/** A Yes answer's upload (organisation chart, business profile): kept with the application on the server, opened by staff. */
function Upload({ token, kind, file, error, onChange }: { token: string; kind: F04AttachmentKind; file: Attachments[F04AttachmentKind]; error?: string; onChange: (file: Attachments[F04AttachmentKind] | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const send = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy(true); setProblem("");
    try { onChange(await signingAction<{ name: string; size: number; at: string }>({ action: "attachment_upload", token, kind }, picked)); }
    catch (e) { setProblem(e instanceof Error ? e.message : "The file could not be uploaded."); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setProblem("");
    try { await signingAction({ action: "attachment_remove", token, kind }); onChange(null); }
    catch (e) { setProblem(e instanceof Error ? e.message : "The file could not be removed."); }
    finally { setBusy(false); }
  };
  return (
    <div data-testid={`f04-attach-${kind}`}>
      {file ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <i className="ri-attachment-2 text-primary-600" aria-hidden="true" /><span className="min-w-0 break-all font-medium text-foreground-900">{file.name}</span>
          <span className="text-xs text-foreground-500">{Math.max(1, Math.round(file.size / 1024))} KB</span>
          <button type="button" disabled={busy} onClick={() => void remove()} className="cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline disabled:opacity-50">Remove</button>
        </div>
      ) : (
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100 ${busy ? "opacity-50" : ""}`}>
          <i className="ri-upload-2-line" aria-hidden="true" />{busy ? "Uploading…" : `Upload the ${F04_ATTACHMENTS[kind].toLowerCase()} (PDF, PNG or JPEG, up to 5 MB)`}
          <input type="file" accept="application/pdf,image/png,image/jpeg" className="sr-only" disabled={busy} onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
      )}
      <FieldError text={problem || error} />
    </div>
  );
}

/** "I agree to all of the above": ticks / unticks every statement; indeterminate while only some are ticked. */
function AgreeAll({ state, onChange }: { state: "all" | "some" | "none"; onChange: (checked: boolean) => void }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = state === "some"; }, [state]);
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border-2 border-primary-300 bg-primary-50 p-3 text-sm font-semibold text-foreground-950" data-testid="f04-agree-all">
      <input ref={box} type="checkbox" className="h-5 w-5 shrink-0 cursor-pointer accent-primary-600" checked={state === "all"} aria-checked={state === "some" ? "mixed" : state === "all"}
        onChange={(e) => onChange(e.target.checked)} data-testid="f04-agree-all-box" />
      I agree to all of the above
    </label>
  );
}

/** One line of an address picked from the search. */
const streetOf = (pick: AddressPick) => [pick.line2, pick.line].filter(Boolean).join(", ");
const searchFor = (token: string) => async (q: string) => signingAddressSearch(token, q);
const Hint = ({ children, testId }: { children: ReactNode; testId?: string }) => <p className="mt-1 flex items-start gap-1 text-xs text-foreground-500" data-testid={testId}><i className="ri-information-line mt-px" aria-hidden="true" />{children}</p>;

export default function F04Wizard({ token, view, codeCheck, onSigned }: {
  token: string; view: SigningView;
  /** The emailed-code check when the request asks for one (rendered on the last step); null when not needed or done. */
  codeCheck: { needed: boolean; session: string | null; render: () => ReactNode };
  onSigned: () => Promise<void> | void;
}) {
  const fields = view.fields;
  const facts = (view.application?.facts ?? null) as Partial<AbrFacts> | null;
  const opening = useMemo(() => initialF04(fields, facts, view.application?.prefill ?? null, (view.application?.draft ?? null) as Partial<F04Draft> | null, view.recipient.name),
    [fields, facts, view.application?.prefill, view.application?.draft, view.recipient.name]);
  const [state, setState] = useState<F04Draft>(opening);
  const [step, setStep] = useState(opening.step);
  const [furthest, setFurthest] = useState(opening.step);
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const [tried, setTried] = useState<Set<number>>(new Set());
  const [attachments, setAttachments] = useState<Attachments>(() => (view.application?.attachments ?? {}) as Attachments);
  // The register's values are shown as text to confirm; Edit turns the same values into inputs. Nothing to show: inputs at once.
  const [editCompany, setEditCompany] = useState(() => !COMPANY_KEYS.some((k) => (opening.answers[k] ?? "").trim()));
  const [editContact, setEditContact] = useState(false);
  const [editAddress, setEditAddress] = useState(() => !(opening.answers.office_street_address ?? "").trim());
  const [manualRef, setManualRef] = useState<Record<number, boolean>>({});
  const [method, setMethod] = useState<"typed" | "drawn">("typed");
  const [picture, setPicture] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "sign">("");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">(view.application?.savedAt ? "saved" : "idle");
  const [notice, setNotice] = useState<{ tone: "info" | "error" | "warn"; text: string } | null>(view.application?.savedAt ? { tone: "info", text: `Welcome back. Your answers saved on ${new Date(view.application.savedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })} are filled in.` } : null);
  const top = useRef<HTMLDivElement>(null);
  const search = useMemo(() => searchFor(token), [token]);
  const has = (key: string) => fields.some((f) => keyOf(f) === key);
  const isRequired = (key: string) => fields.some((f) => keyOf(f) === key && f.required);
  const asks = (question: string) => fields.some((f) => fieldGroup(f.key)?.key === question);
  const a = state.answers;

  // ---------------------------------------------------------------- autosave (step changes, typing pauses) and "Save and continue later"
  const stateRef = useRef(state); stateRef.current = state;
  const stepRef = useRef(step); stepRef.current = step;
  const lastSaved = useRef(JSON.stringify({ ...opening, step: opening.step }));
  const lastSaveAt = useRef(0);
  const closed = useRef(false);
  const persist = useCallback(async (at: number, force = false) => {
    if (closed.current) return true;
    const draft = { ...stateRef.current, step: at };
    const json = JSON.stringify(draft);
    if (!force && json === lastSaved.current) return true;
    setSaved("saving");
    try {
      await signingAction({ action: "draft_save", token, draft });
      lastSaved.current = json; lastSaveAt.current = Date.now(); setSaved("saved");
      return true;
    } catch { setSaved("error"); return false; }
  }, [token]);
  useEffect(() => {
    if (closed.current || JSON.stringify({ ...state, step: stepRef.current }) === lastSaved.current) return;
    const wait = Math.max(AUTOSAVE_PAUSE, lastSaveAt.current + AUTOSAVE_GAP - Date.now());
    const timer = window.setTimeout(() => { void persist(stepRef.current); }, wait);
    return () => window.clearTimeout(timer);
  }, [state, persist]);

  const problems = f04Problems(step, fields, state, attachments);
  const shown = tried.has(step) ? problems : {};
  const allProblems = STEPS.map((_, i) => f04Problems(i, fields, state, attachments));
  const set = (key: string, value: string) => setState((s) => ({ ...s, answers: { ...s.answers, [key]: value } }));
  const setMany = (values: Record<string, string>) => setState((s) => ({ ...s, answers: { ...s.answers, ...values } }));
  const warnings = step === 3 ? checkApplicationAnswers({ ref1_contact_name: a.ref1_contact_name ?? "", ref2_contact_name: a.ref2_contact_name ?? "" }).warnings : [];
  const signatureReady = method === "typed" ? (a.declarant_name ?? "").trim().length >= 2 : !!picture;
  const canSubmit = Object.keys(problems).length === 0 && consent && signatureReady && (!codeCheck.needed || !!codeCheck.session);

  const save = async () => {
    setBusy("save");
    const ok = await persist(step, true);
    setNotice(ok ? { tone: "info", text: "Saved. Use the link in your email to come back and carry on; your answers will be filled in." } : { tone: "error", text: "Your answers could not be saved. Please try again." });
    setBusy("");
  };
  const show = (index: number) => {
    setStep(index); setFurthest((f) => Math.max(f, index)); setNotice(null);
    void persist(index);
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const goTo = (index: number) => {
    // Forward only once the steps before are complete; back always.
    if (index > step) {
      for (let i = step; i < index; i++) if (Object.keys(allProblems[i]).length) { setTried((t) => new Set(t).add(i)); if (i !== step) show(i); return; }
    }
    if (index !== returnTo && index < step) setReturnTo(null);
    show(index);
  };
  /** From the review: open a step, then come straight back. */
  const editStep = (index: number) => { setReturnTo(REVIEW_STEP); show(index); };
  const next = () => {
    setTried((t) => new Set(t).add(step));
    if (Object.keys(problems).length) {
      // A missing value hidden in a summary card opens its inputs.
      if (step === 0) setEditCompany(true);
      if (step === 1) { if (["contact_given_name", "contact_family_name", "contact_email", "contact_phone"].some((k) => problems[k])) setEditContact(true); if (problems.office_street_address || problems.office_country || problems.office_postcode || problems.office_suburb) setEditAddress(true); }
      setNotice({ tone: "error", text: "Some answers are missing or need a fix. They are marked below." }); return;
    }
    const target = returnTo ?? step + 1;
    setReturnTo(null);
    goTo(target);
  };
  const submit = async () => {
    setTried((t) => new Set(t).add(step));
    if (!canSubmit || busy) return;
    setBusy("sign"); setNotice(null);
    try {
      await signWithRetry({ action: "sign", token, name: (a.declarant_name ?? "").trim(), agreed: true, signatureKind: method, signatureImage: method === "typed" ? null : picture,
        values: f04Values(fields, state), documentHash: view.documentHash, codeSession: codeCheck.session,
        application: { acn: state.acn, marn: state.marn.replace(/\s/g, ""), declarations: state.declarations } });
      closed.current = true;
      await onSigned();
    } catch (e) { setNotice({ tone: "error", text: e instanceof Error ? e.message : "The form could not be submitted. Please try again." }); }
    finally { setBusy(""); }
  };
  // Enter moves on (not in a text area, a chip, an open address list or the last step).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.defaultPrevented || e.shiftKey || e.nativeEvent.isComposing || step === REVIEW_STEP || busy) return;
    const t = e.target as HTMLElement;
    if (t.tagName !== "INPUT" || t.getAttribute("role") === "combobox") return;
    if (["checkbox", "radio", "file", "button", "submit"].includes((t as HTMLInputElement).type)) return;
    e.preventDefault(); next();
  };

  const text = (key: string, label: string, options: { type?: string; inputMode?: "numeric" | "text"; autoComplete?: string; maxLength?: number; required?: boolean; placeholder?: string; digits?: boolean; hint?: ReactNode } = {}) =>
    has(key) || key === "office_postcode" ? <WizardTextField key={key} id={`f04-${key}`} name={key} label={label} value={a[key] ?? ""} error={shown[key]} required={options.required ?? isRequired(key)} placeholder={options.placeholder}
      type={options.type} inputMode={options.inputMode} autoComplete={options.autoComplete ?? "off"} maxLength={options.maxLength ?? 500} testId={`f04-${key}`} onChange={(v) => set(key, options.digits ? v.replace(/\D/g, "") : v)}>{options.hint}</WizardTextField> : null;
  const phone = (key: string, label: string) => has(key) ? (
    <div key={key}>
      <WizardLabel htmlFor={`f04-${key}`} required>{label}</WizardLabel>
      <PhoneInput id={`f04-${key}`} name={key} value={a[key] ?? ""} invalid={Boolean(shown[key])} placeholder="041 234 5678" onValueChange={(v) => set(key, v)} />
      <FieldError text={shown[key]} />
    </div>) : null;
  const card = "rounded-lg border border-background-200 bg-background-100/60 p-4";
  const editButton = (onClick: () => void, testId: string, label = "Edit") => (
    <button type="button" onClick={onClick} className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100" data-testid={testId}>
      <i className="ri-edit-line" aria-hidden="true" />{label}</button>);
  const item = (label: string, value: ReactNode, testId?: string, hint?: ReactNode) => <div className="min-w-0"><dt className="text-xs text-foreground-500">{label}</dt><dd className="break-words font-medium text-foreground-900" data-testid={testId}>{value || <span className="font-normal text-foreground-400">Not on the register</span>}</dd>{hint}</div>;
  const gst = yesNo(a.agent_gst_registered);
  const yearHint = yearMayPredateAbn(a.agent_year_founded) ? <Hint testId="f04-year-hint">{YEAR_BEFORE_ABN_HINT}</Hint> : null;
  const sameTrading = !!(a.agent_trading_name ?? "").trim() && (a.agent_trading_name ?? "").trim().toLowerCase() === (a.agent_legal_entity ?? "").trim().toLowerCase();
  const tradingHint = sameTrading ? <Hint testId="f04-trading-hint">{TRADING_SAME_HINT}</Hint> : null;
  const australian = isAustralia(a.office_country);
  const officeLine = [a.office_street_address, [a.office_suburb, australian ? a.office_state : a.office_province, a.office_postcode].filter(Boolean).join(" "), a.office_country].filter((s) => (s ?? "").trim()).join(", ");
  const contactName = [a.contact_title, a.contact_given_name, a.contact_family_name].filter(Boolean).join(" ");

  const review = () => {
    const section = (index: number, rows: Array<[string, ReactNode]>) => (
      <section key={index} className="rounded-lg border border-background-200 p-4" data-testid={`f04-review-${STEPS[index].id}`}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground-900">{STEPS[index].short}</h4>
          <button type="button" onClick={() => editStep(index)} className="cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline" data-testid={`f04-review-edit-${STEPS[index].id}`}>Edit</button>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([label, v]) => <div key={label} className="min-w-0"><dt className="text-xs text-foreground-500">{label}</dt><dd className="break-words text-foreground-900">{v}</dd></div>)}
        </dl>
      </section>);
    const yn = (k: string) => (yesNo(a[k]) === "YES" ? "Yes" : yesNo(a[k]) === "NO" ? "No" : "");
    const ref = (n: number) => [a[`ref${n}_contact_name`], a[`ref${n}_position`], a[`ref${n}_organisation`]].filter((s) => (s ?? "").trim()).join(", ") + ((a[`ref${n}_email`] ?? "").trim() ? ` · ${a[`ref${n}_email`]}` : "") + ((a[`ref${n}_phone`] ?? "").trim() ? ` · ${formatPhone(a[`ref${n}_phone`])}` : "");
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-testid="f04-review">
        {section(0, [["Legal name", a.agent_legal_entity], ["Trading name", a.agent_trading_name], ["ABN", a.agent_abn ? printAbn(a.agent_abn) : ""], ["ACN", state.acn ? printAcn(state.acn) : ""],
          ["Year founded", a.agent_year_founded], ["MARN", state.marn]])}
        {section(1, [["Contact", contactName], ["Position", a.contact_position], ["Email", a.contact_email], ["Phone", a.contact_phone ? formatPhone(a.contact_phone) : ""], ["Office", officeLine], ["Website", a.agent_website]])}
        {section(2, [...QUESTIONS.filter((q) => asks(q.key)).map((q): [string, ReactNode] => [q.short, yn(q.key) + (yesNo(a[q.key]) === "YES" && q.attach && attachments[q.attach] ? ` · ${attachments[q.attach]!.name}` : "")]),
          ["Services", a.services_provided], ["Other countries", a.other_countries_recruited],
          ["Numbers", NUMBERS.filter(([k]) => (a[k] ?? "").trim()).map(([k, label]) => `${label}: ${a[k]}`).join(" · ")]])}
        {section(3, [["Reference 1", ref(1)], ["Reference 2", ref(2)]])}
      </div>
    );
  };

  const body = (() => {
    if (step === 0) {
      const noBox = COMPANY_KEYS.filter((k) => !has(k) && (a[k] ?? "").trim());
      return (
        <div className="space-y-5">
          <section className={card} data-testid="f04-company-summary">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground-900">{a.agent_legal_entity || a.agent_agency_name || "Your business"}</h3>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-foreground-500"><i className="ri-shield-check-line text-primary-600" aria-hidden="true" />From the Australian Business Register
                  {facts?.sourceUrl ? <> · <a href={facts.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">view record</a></> : null}</p>
              </div>
              {editCompany ? editButton(() => setEditCompany(false), "f04-company-done", "Done") : editButton(() => setEditCompany(true), "f04-company-edit")}
            </div>
            {editCompany ? (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="f04-company-inputs">
                {text("agent_legal_entity", "Legal name")}
                {text("agent_abn", "ABN", { inputMode: "numeric", maxLength: 14 })}
                <WizardTextField id="f04-acn" name="acn" label="ACN" required={false} value={printAcn(state.acn)} error={shown.acn} inputMode="numeric" maxLength={11} testId="f04-acn"
                  onChange={(v) => setState((s) => ({ ...s, acn: v.replace(/\D/g, "").slice(0, 9) }))} />
                {text("agent_trading_name", "Trading name", { hint: tradingHint })}
                {text("agent_agency_name", "Agency name")}
                {text("agent_year_founded", "Year founded", { inputMode: "numeric", maxLength: 4, digits: true, hint: yearHint })}
                {has("agent_gst_registered") ? <div className="sm:col-span-2"><YesNo id="agent_gst_registered" label="Registered for GST?" value={gst} required={false} onChange={(v) => set("agent_gst_registered", v)} /></div> : null}
                {noBox.length ? <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:col-span-2" data-testid="f04-company-printed">
                  {noBox.map((k) => item(COMPANY_LABEL[k], k === "agent_abn" ? printAbn(a[k]) : a[k], undefined, <p className="text-xs text-foreground-500">Already printed on your form</p>))}</dl> : null}
              </div>
            ) : (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-3">
                {item("Legal name", a.agent_legal_entity, "f04-summary-legal")}
                {item("ABN", a.agent_abn ? printAbn(a.agent_abn) : "", "f04-summary-abn")}
                {item("ACN", state.acn ? printAcn(state.acn) : "", "f04-summary-acn")}
                {item("Trading name", a.agent_trading_name, "f04-summary-trading", tradingHint)}
                {item("Year founded", a.agent_year_founded, "f04-summary-year", yearHint)}
                {a.agent_agency_name && a.agent_agency_name !== a.agent_trading_name ? item("Agency name", a.agent_agency_name) : null}
              </dl>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-background-200 pt-3 text-xs sm:grid-cols-3" data-testid="f04-abr-facts">
              <div><dt className="text-foreground-500">Entity type</dt><dd className="text-foreground-800">{facts?.entityType || "—"}</dd></div>
              <div><dt className="text-foreground-500">ABN status</dt><dd className="text-foreground-800">{facts?.abnStatus ? `${facts.abnStatus}${facts.statusFrom ? ` from ${abrDateWords(facts.statusFrom)}` : ""}` : "—"}</dd></div>
              <div><dt className="text-foreground-500">GST</dt><dd className="text-foreground-800">{gst === "YES" ? `Registered${facts?.gstRegistered && facts.gstFrom ? ` from ${abrDateWords(facts.gstFrom)}` : ""}` : gst === "NO" ? "Not registered" : "—"}</dd></div>
            </dl>
            {Object.keys(shown).some((k) => COMPANY_KEYS.includes(k as never) || k === "acn") && !editCompany ? <FieldError text="Some details are missing: select Edit." /> : null}
          </section>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <WizardTextField id="f04-marn" name="marn" label="MARA number (MARN), if registered" required={false} value={state.marn} error={shown.marn} inputMode="numeric" maxLength={10} testId="f04-marn"
              onChange={(v) => setState((s) => ({ ...s, marn: v.replace(/\D/g, "") }))}>
              <a href={OMARA_REGISTER_URL} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary-700 underline underline-offset-2" data-testid="f04-omara-link">
                <i className="ri-external-link-line" aria-hidden="true" />Search the OMARA register</a>
            </WizardTextField>
          </div>
        </div>
      );
    }
    if (step === 1) {
      const pick = (p: AddressPick) => { setMany({ office_street_address: streetOf(p), office_suburb: p.suburb, office_state: p.state, office_postcode: p.postcode, office_province: "", office_country: "Australia" }); setEditAddress(false); };
      return (
        <div className="space-y-5">
          <section className={card} data-testid="f04-contact-summary">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-foreground-900">{contactName || "Contact person"}</p>
                <p className="break-words text-foreground-700">{[a.contact_email, a.contact_phone ? formatPhone(a.contact_phone) : ""].filter(Boolean).join(" · ") || "No email or phone yet"}</p>
              </div>
              {editContact ? editButton(() => setEditContact(false), "f04-contact-done", "Done") : editButton(() => setEditContact(true), "f04-contact-edit")}
            </div>
            {editContact ? (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {text("contact_given_name", "Given name", { autoComplete: "given-name" })}
                {text("contact_family_name", "Family name", { autoComplete: "family-name" })}
                {text("contact_email", "Email", { type: "email", autoComplete: "email" })}
                {phone("contact_phone", "Phone")}
              </div>
            ) : ["contact_given_name", "contact_family_name", "contact_email", "contact_phone"].map((k) => shown[k] ? <FieldError key={k} text={shown[k]} /> : null)}
          </section>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {has("contact_title") ? <div>
              <WizardLabel htmlFor="f04-contact_title" required={isRequired("contact_title")}>Title</WizardLabel>
              <select id="f04-contact_title" value={a.contact_title ?? ""} aria-invalid={Boolean(shown.contact_title)} className={WIZARD_INPUT} data-testid="f04-contact_title" onChange={(e) => set("contact_title", e.target.value)}>
                <option value="">Select</option>{F04_TITLES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <FieldError text={shown.contact_title} />
            </div> : null}
            {has("contact_position") ? <div className="sm:col-span-2"><ChoiceChips id="contact_position" label="Position" value={a.contact_position ?? ""} error={shown.contact_position} required={isRequired("contact_position")} onChange={(v) => set("contact_position", v)} /></div> : null}
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-1.5 text-sm font-semibold text-foreground-900">Office address <span className="text-primary-600">*</span></legend>
            <AddressAutocomplete inputId="f04-office-search" label="Find the office address" search={search} onPick={pick} onManual={() => setEditAddress(true)} onUnavailable={() => setEditAddress(true)} />
            {!editAddress && officeLine ? (
              <div className="flex items-start justify-between gap-3 rounded-md border border-background-200 px-3 py-2 text-sm" data-testid="f04-office-summary">
                <span className="min-w-0 break-words text-foreground-900"><i className="ri-map-pin-line mr-1 text-primary-600" aria-hidden="true" />{officeLine}</span>
                <button type="button" onClick={() => setEditAddress(true)} className="shrink-0 cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline" data-testid="f04-office-edit">Edit</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-6" data-testid="f04-office-inputs">
                <div className="sm:col-span-6">{text("office_street_address", "Street address", { autoComplete: "street-address" })}</div>
                <div className="sm:col-span-3">{text("office_suburb", "Suburb or city", { autoComplete: "address-level2", required: false })}</div>
                {australian ? <div className="sm:col-span-1">
                  <WizardLabel htmlFor="f04-office_state" required={false}>State</WizardLabel>
                  <select id="f04-office_state" value={(a.office_state ?? "").toUpperCase()} className={WIZARD_INPUT} data-testid="f04-office_state" onChange={(e) => set("office_state", e.target.value)}>
                    <option value="">—</option>{AU_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div> : <div className="sm:col-span-1">{text("office_province", "Province / region", { required: false })}</div>}
                <div className="sm:col-span-2">{text("office_postcode", "Postcode", { inputMode: australian ? "numeric" : "text", autoComplete: "postal-code", maxLength: 10, required: false })}</div>
                <div className="sm:col-span-6">{text("office_country", "Country", { autoComplete: "country-name" })}</div>
              </div>
            )}
            {!editAddress ? [shown.office_street_address, shown.office_country, shown.office_postcode, shown.office_suburb].map((t, i) => <FieldError key={i} text={t} />) : null}
          </fieldset>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{text("agent_website", "Website", { autoComplete: "url", required: false, placeholder: "https://" })}</div>
        </div>
      );
    }
    if (step === 2) return (
      <div className="space-y-4">
        <div className="space-y-2">
          {QUESTIONS.filter((q) => asks(q.key)).map((q) => {
            const yes = yesNo(a[q.key]) === "YES";
            return (
              <YesNo key={q.key} id={q.key} label={q.label} value={yesNo(a[q.key])} error={shown[q.key]} required={fields.some((f) => fieldGroup(f.key)?.key === q.key && f.required)} onChange={(v) => set(q.key, v)}>
                {yes && q.attach ? <Upload token={token} kind={q.attach} file={attachments[q.attach]} error={shown[`attach_${q.attach}`]} onChange={(file) => setAttachments((x) => { const n = { ...x }; if (file) n[q.attach!] = file; else delete n[q.attach!]; return n; })} /> : null}
                {yes && q.follow && has(q.follow.key) ? (q.follow.long
                  ? <TextArea id={q.follow.key} label={q.follow.label} value={a[q.follow.key] ?? ""} error={shown[q.follow.key]} required={q.follow.required} onChange={(v) => set(q.follow!.key, v)} />
                  : text(q.follow.key, q.follow.label, { required: q.follow.required })) : null}
              </YesNo>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{NUMBERS.filter(([k]) => has(k)).map(([k, label]) => <div key={k}>{text(k, label, { inputMode: "numeric", maxLength: 6, required: false, digits: true })}</div>)}</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {has("services_provided") ? <Chips id="services_provided" label="Services provided to students" value={a.services_provided ?? ""} options={SERVICES} error={shown.services_provided} onChange={(v) => set("services_provided", v)} /> : null}
          {has("other_countries_recruited") ? <Chips id="other_countries_recruited" label="Other countries you recruit students to" value={a.other_countries_recruited ?? ""} options={COUNTRIES} error={shown.other_countries_recruited} onChange={(v) => set("other_countries_recruited", v)} /> : null}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {has("popular_courses") ? <TextArea id="popular_courses" label="Popular courses among your students" value={a.popular_courses ?? ""} error={shown.popular_courses} required={isRequired("popular_courses")} onChange={(v) => set("popular_courses", v)} /> : null}
          {has("slit_promotion_plan") ? <TextArea id="slit_promotion_plan" label="How you will promote SLIT" value={a.slit_promotion_plan ?? ""} error={shown.slit_promotion_plan} required={isRequired("slit_promotion_plan")} onChange={(v) => set("slit_promotion_plan", v)} /> : null}
        </div>
        <details className="rounded-lg border border-background-200 px-3 py-2" data-testid="f04-more" open={Boolean((a.associations ?? "").trim() || (a.australian_institutions_represented ?? "").trim()) || undefined}>
          <summary className="cursor-pointer text-sm font-semibold text-foreground-800">More about your agency (optional)</summary>
          <div className="mt-3 grid grid-cols-1 gap-4 pb-1 sm:grid-cols-2">
            {has("associations") ? <TextArea id="associations" label="Associations you are a member of" value={a.associations ?? ""} required={false} onChange={(v) => set("associations", v)} /> : null}
            {has("australian_institutions_represented") ? <TextArea id="australian_institutions_represented" label="Australian institutions you represent" value={a.australian_institutions_represented ?? ""} required={false} onChange={(v) => set("australian_institutions_represented", v)} /> : null}
          </div>
        </details>
      </div>
    );
    if (step === 3) return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[1, 2].map((n) => {
          const k = (part: string) => `ref${n}_${part}`;
          return (
            <section key={n} className="rounded-lg border border-background-200 p-4" data-testid={`f04-reference-${n}`}>
              <h3 className="mb-3 text-sm font-semibold text-foreground-900">Reference {n}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {REF_PARTS.filter(([part]) => ["contact_name", "organisation", "position", "email"].includes(part)).map(([part, label, must]) => text(k(part), label, { required: must, type: part === "email" ? "email" : undefined }))}
                <div className="sm:col-span-2">{phone(k("phone"), "Phone")}</div>
                {has(k("address")) ? <div className="sm:col-span-2">
                  {manualRef[n] || (a[k("address")] ?? "").trim() ? (
                    <div>
                      {text(k("address"), "Address", { required: false })}
                      <button type="button" onClick={() => { set(k("address"), ""); setManualRef((m) => ({ ...m, [n]: false })); }} className="mt-1 cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline">Search again</button>
                    </div>
                  ) : <AddressAutocomplete inputId={`f04-ref${n}-search`} label="Address (optional)" search={search} onManual={() => setManualRef((m) => ({ ...m, [n]: true }))} onUnavailable={() => setManualRef((m) => ({ ...m, [n]: true }))}
                    onPick={(p) => set(k("address"), [streetOf(p), `${p.suburb} ${p.state} ${p.postcode}`.trim()].filter(Boolean).join(", "))} />}
                </div> : null}
              </div>
            </section>
          );
        })}
        {warnings.map((w) => <p key={w} role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 lg:col-span-2" data-testid="f04-reference-warning">{w}</p>)}
      </div>
    );
    const agreed = declarationsState(state.declarations);
    return (
      <div className="space-y-6">
        {review()}
        <section className="space-y-4 border-t border-background-200 pt-5">
          <h3 className="text-sm font-semibold text-foreground-900">Declaration</h3>
          <p className="text-sm text-foreground-800">{F04_DECLARATION_INTRO}</p>
          <AgreeAll state={agreed} onChange={(checked) => setState((s) => ({ ...s, declarations: allDeclarations(checked) }))} />
          <ul className="space-y-2">
            {F04_DECLARATIONS.map((d) => (
              <li key={d.key}>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-background-200 p-3 text-sm text-foreground-800 hover:bg-background-100/60" data-testid={`f04-declaration-${d.key}`}>
                  <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer" checked={state.declarations[d.key] === true} aria-invalid={Boolean(shown[`declaration_${d.key}`])}
                    onChange={(e) => setState((s) => ({ ...s, declarations: { ...s.declarations, [d.key]: e.target.checked } }))} />
                  <span>{d.text}<span className="text-primary-600"> *</span>
                    {d.link ? <> <a href={d.link.href} target="_blank" rel="noreferrer" className="font-semibold text-primary-700 underline underline-offset-2" onClick={(e) => e.stopPropagation()} data-testid="f04-ethics-link">{d.link.label}</a></> : null}
                    <FieldError text={shown[`declaration_${d.key}`]} /></span>
                </label>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {text("declarant_name", "Your full name", { autoComplete: "name", required: true })}
            <ChoiceChips id="declarant_role" label="Your role" value={a.declarant_role ?? ""} error={shown.declarant_role} required onChange={(v) => set("declarant_role", v)} />
          </div>
          <div>
            <p className="mb-2 text-label font-medium text-foreground-800">Your signature <span className="text-primary-600">*</span></p>
            <div role="tablist" className="mb-3 flex flex-wrap gap-2">{([["typed", "Type"], ["drawn", "Draw"]] as const).map(([id, label]) =>
              <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => { setMethod(id); setPicture(null); }} data-testid={`f04-signature-${id}`}
                className={`cursor-pointer rounded-full border px-4 py-2 text-sm font-medium ${method === id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50"}`}>{label}</button>)}</div>
            {method === "typed" ? <p className={`flex min-h-20 items-center rounded-md border border-background-300 bg-background-50 px-5 py-3 text-4xl text-[#0d1a4d] ${SCRIPT_FONT}`} data-testid="f04-typed-signature">
              {a.declarant_name || <span className="font-sans text-sm text-foreground-400">Your name appears here as your signature</span>}</p> : <SignaturePad onChange={setPicture} />}
          </div>
          <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" data-testid="f04-consent" /><span>{view.consent}<span className="text-primary-600"> *</span></span></label>
          {codeCheck.needed && !codeCheck.session ? codeCheck.render() : null}
        </section>
      </div>
    );
  })();

  const last = step === REVIEW_STEP;
  const savedNote = saved === "saving" ? "Saving…" : saved === "saved" ? "Saved ✓" : saved === "error" ? "Not saved" : "";
  const saveLater = (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <button type="button" onClick={() => void save()} disabled={!!busy} className="cursor-pointer text-sm font-semibold text-primary-700 underline-offset-2 hover:underline disabled:opacity-50" data-testid="f04-save-later">
        {busy === "save" ? "Saving…" : "Save and continue later"}</button>
      {savedNote && busy !== "save" ? <span role="status" aria-live="polite" className={`text-xs ${saved === "error" ? "text-red-700" : "text-foreground-500"}`} data-testid="f04-saved">{savedNote}</span> : null}
    </span>);
  return (
    <div ref={top} className="scroll-mt-4" onKeyDown={onKey}>
      <WizardShell variant="page" stickyFooter icon="ri-file-user-line" title="Agent application form" subtitle={<>For <strong>{view.onboarding?.agencyName ?? "your agency"}</strong> · step {step + 1} of {STEPS.length}: {STEPS[step].text}</>}
        stepper={<div data-testid="f04-stepper"><WizardStepper items={STEPS.map((s, i) => ({ id: s.id, short: s.short, icon: s.icon, done: i < furthest && Object.keys(allProblems[i]).length === 0 }))} current={step} onSelect={goTo} /></div>}
        footerStart={<>
          {step > 0 ? <WizardBackButton onClick={() => goTo(step - 1)} disabled={!!busy} /> : null}
          <span className="hidden sm:inline-flex">{saveLater}</span>
        </>}
        footerEnd={last
          ? <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!canSubmit || !!busy} onClick={() => void submit()} data-testid="f04-submit">{busy === "sign" ? "Submitting…" : "Sign and submit"}<i className="ri-check-line" aria-hidden="true" /></button>
          : <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!!busy} onClick={next} data-testid="f04-next">{returnTo !== null ? "Back to review" : "Next"}<i className="ri-arrow-right-line" aria-hidden="true" /></button>}
        notices={<>
          {notice ? <WizardNotice tone={notice.tone}>{notice.text}</WizardNotice> : null}
          {last && !canSubmit && !busy ? <WizardNotice tone="info">{Object.keys(problems).length ? "Tick every statement and give your name and role." : !signatureReady ? "Add your signature." : !consent ? "Tick the agreement to sign electronically." : "Confirm the emailed code."}</WizardNotice> : null}
        </>}>
        <h3 className="mb-4 font-heading text-base font-semibold text-foreground-950">{STEPS[step].title}</h3>
        {body}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-500">
          <p><span className="text-primary-600">*</span> required</p>
          <span className="sm:hidden">{saveLater}</span>
        </div>
      </WizardShell>
    </div>
  );
}

/** The tick drawn once after signing (no motion when the reader asks for less: index.css). */
function SuccessTick() {
  return (
    <svg viewBox="0 0 52 52" className="f04-tick-pop h-16 w-16 text-primary-600" aria-hidden="true" data-testid="f04-success-tick">
      <circle className="f04-tick-circle" cx="26" cy="26" r="24" fill="none" stroke="currentColor" strokeWidth="3" />
      <path className="f04-tick-check" d="M15 27 l7 7 l15 -16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** After submit: a tick, what happens next, and the signed application to download. */
export function F04Done({ view, justSigned }: { view: SigningView; justSigned: boolean }) {
  const steps: Array<[string, string]> = [["ri-mail-send-line", "We've emailed your 2 referees"], ["ri-search-eye-line", "SLIT reviews"], ["ri-file-text-line", "You'll receive the agent agreement"]];
  return (
    <WizardShell variant="page" icon="ri-checkbox-circle-line" title="Application submitted" subtitle={view.onboarding?.agencyName ? `Agent application for ${view.onboarding.agencyName}` : "Agent application"}
      stepper={null} footerStart={null}
      footerEnd={<a href={view.url} download className={WIZARD_PRIMARY_CLASS} data-testid="f04-download"><i className="ri-download-line" aria-hidden="true" />Download signed PDF</a>}>
      <div role="status" className="flex flex-col items-center gap-3 py-2 text-center text-sm text-foreground-800" data-testid={justSigned ? "f04-submitted" : "f04-already-submitted"}>
        <SuccessTick />
        <p className="text-base font-semibold text-foreground-950">{justSigned ? "Thank you. Your application has been submitted." : "This application has been signed and submitted."}</p>
        {view.signedAt ? <p className="text-xs text-foreground-500">Signed {new Date(view.signedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}</p> : null}
      </div>
      <section className="mt-5" data-testid="f04-next-steps">
        <h3 className="mb-3 text-center text-sm font-semibold text-foreground-900">What happens next</h3>
        <ol className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-center">
          {steps.map(([icon, label], i) => (
            <li key={label} className="flex items-center gap-2 sm:contents">
              <span className="flex flex-1 items-center gap-2 rounded-lg border border-background-200 bg-background-100/60 px-3 py-2 text-sm text-foreground-900 sm:flex-none">
                <i className={`${icon} text-primary-600`} aria-hidden="true" />{label}</span>
              {i < steps.length - 1 ? <i className="ri-arrow-right-line hidden text-foreground-400 sm:inline" aria-hidden="true" /> : null}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-center text-xs text-foreground-500">The download link works for a few minutes; reload this page for a new one.</p>
      </section>
    </WizardShell>
  );
}
