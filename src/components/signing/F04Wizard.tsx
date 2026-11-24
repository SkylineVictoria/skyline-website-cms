import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import WizardShell, { WIZARD_PRIMARY_CLASS, WizardBackButton, WizardNotice } from "@/components/shared/wizard/WizardShell";
import WizardStepper from "@/components/shared/wizard/WizardStepper";
import { FieldError, WIZARD_INPUT, WizardLabel, WizardTextField } from "@/components/shared/wizard/fields";
import AddressAutocomplete, { type AddressPick } from "@/components/shared/application-form/AddressAutocomplete";
import { PhoneInput } from "@/components/feature/applicationInputs";
import SignaturePad from "@/components/signing/SignaturePad";
import SigningDone, { type NextStep } from "@/components/signing/SigningDone";
import { softBreak } from "@/components/signing/softBreak";
import { formatSignedAt } from "@/lib/signedTime";
import { ruleNumber, ruleText } from "@/lib/businessRules";
import { fieldGroup, signingAction, signingAddressSearch, signWithRetry, type SigningView } from "@/lib/signingApi";
import { abrDateWords, checkApplicationAnswers, F04_TITLES, printAcn, YEAR_BEFORE_ABN_HINT, yearMayPredateAbn, type AbrFacts } from "../../../supabase/functions/_shared/validation/abr";
import { AU_STATES } from "../../../supabase/functions/_shared/validation/person";
import { formatPhone } from "../../../supabase/functions/_shared/validation/identifiers";
import { commissionText, correctionFlagged, F04_ATTACHMENTS, F04_DECLARATION_INTRO, F04_DECLARATIONS, OMARA_REGISTER_URL, printAbn, WITNESS_NAME_KEY, type F04AttachmentKind } from "../../../supabase/functions/_shared/agent-onboarding";
import { allDeclarations, COMPANY_KEYS, COMPANY_LABEL, COUNTRIES, declarationsState, F04_STEP, F04_STEPS as STEPS, f04Problems, f04Values, initialF04, reviewChanges, stepOfKey, visibleSteps, type F04Mode, isAustralia, keyOf, NUMBERS, POSITIONS, QUESTIONS, readChips, readChoice, choiceUnnamed, correctionDraft, correctionScope, withSignedAnswers,
  REF_PARTS, REVIEW_STEP, SERVICES, TRADING_SAME_HINT, writeChips, writeChoice, yesNo, type F04Draft } from "./f04WizardLogic";
import { commissionSuggested } from "@/pages/agency/lib/admissionsRules";
import SearchableSelect from "@/components/ui/SearchableSelect";

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
/**
 * The SLIT witness's typed name as a signature picture (owner 2026-11-24: "just type his name and we will use it"), only after staff
 * confirm the witness agreed to it. Drawn in the same script font as typed signatures, dark blue on transparent, like a drawn one.
 */
async function typedSignaturePng(name: string): Promise<string> {
  try { await document.fonts.load("64px 'Dancing Script'"); } catch { /* the cursive fallback is used */ }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = "64px 'Dancing Script', cursive";
  const width = Math.ceil(ctx.measureText(name).width) + 40;
  canvas.width = Math.max(200, width); canvas.height = 110;
  const draw = canvas.getContext("2d")!;
  draw.font = "64px 'Dancing Script', cursive"; draw.fillStyle = "#0d1a4d"; draw.textBaseline = "middle";
  draw.fillText(name, 20, 58);
  return canvas.toDataURL("image/png");
}

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

/**
 * A reference's email (2026-11-21): one line that grows and wraps at any point, so a long address is always fully visible in the box
 * (an input would scroll it out of sight). Enter never adds a line; pasted line breaks are dropped.
 */
function EmailBox({ id, name, label, value, error, required, onChange }: { id: string; name: string; label: string; value: string; error?: string; required: boolean; onChange: (v: string) => void }) {
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const t = box.current; if (!t) return; t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; }, [value]);
  return (
    <div>
      <WizardLabel htmlFor={id} required={required}>{label}</WizardLabel>
      <textarea ref={box} id={id} name={name} rows={1} value={value} maxLength={320} inputMode="email" autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={Boolean(error)}
        className={`${WIZARD_INPUT} resize-none overflow-hidden [overflow-wrap:anywhere]`} data-testid={id}
        onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ""))} />
      <FieldError text={error} />
    </div>
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
          <i className="ri-attachment-2 text-primary-600" aria-hidden="true" /><span className="min-w-0 break-words font-medium text-foreground-900">{softBreak(file.name)}</span>
          <span className="text-xs text-foreground-500">{Math.max(1, Math.round(file.size / 1024))} KB</span>
          <button type="button" disabled={busy} onClick={() => void remove()} className="cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline disabled:opacity-50">Remove</button>
        </div>
      ) : (
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100 ${busy ? "opacity-50" : ""}`}>
          <i className="ri-upload-2-line" aria-hidden="true" />{busy ? "Uploading…" : `Upload the ${F04_ATTACHMENTS[kind].toLowerCase()} (PDF, PNG or JPEG, up to ${Math.min(5, ruleNumber("agents.agent_application_attachment_cap_mib", 5))} MB)`}
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

/** Admin-review mode (CMS): the flags, the message and the three actions live with the container (F04ReviewDialog). */
export interface F04ReviewControls {
  flags: Record<string, string>; onFlags: (flags: Record<string, string>) => void;
  message: string; onMessage: (message: string) => void;
  /** The referee's reply (F05), read-only beside the References step. */
  refereePanel: (position: 1 | 2) => ReactNode;
  busy: "" | "save" | "back" | "approve";
  /** Why Approve / Send back are not available yet (e.g. a referee has not replied), or null. */
  blocked: string | null;
  /** 2026-11-20: shown, never blocking (e.g. referees that have not replied). */
  warning?: string | null;
  onSave: (changes: Record<string, string>, after: F04Draft) => Promise<boolean>;
  onSendBack: () => void;
  onApprove: () => void;
  onClose: () => void;
  /** 2026-11-20: one line per referee in the summary (sent / completed / not completed) with Resend. */
  refereeStatus?: (position: 1 | 2) => ReactNode;
  /** 2026-11-20: the agreement signed with the form, shown as a card in the summary. */
  agreement?: F04ReviewAgreement | null;
}

/** A signature shown in the review: a drawn picture (PNG data URL), or the typed name in the signing script. */
export interface F04ReviewSignature { name: string; image: string | null; signedAt?: string | null }
/** The agreement (P06) signed with the form: terms, the SLIT witness, the agency's witness, the agency admin's signature. */
export interface F04ReviewAgreement {
  commencementDate: string | null; expiryDate: string | null; territory: string; commissionPercent: number | string | null;
  slitWitness: F04ReviewSignature | null; agencyWitness: F04ReviewSignature | null; agencySignature: F04ReviewSignature | null;
  /** 2026-11-21: GST on the commission and SLIT's signatory (signed when SLIT sent the application). */
  commissionGst?: string | null; slitSignatory?: SlitSignatoryView | null;
}
/** SLIT's signatory block as shown (read-only): organisation, signature (picture or typed name), name, position, date. */
export interface SlitSignatoryView { organisation: string; name: string; position: string; image: string | null; typed: string | null; signedOn: string | null }

/** SLIT's signatory block on the agreement (2026-11-21), read-only: the same block in the pre-send preview, on the signing page and in the review. */
export function SlitSignatoryBlock({ s, testId, note }: { s: SlitSignatoryView; testId: string; note?: string }) {
  const day = s.signedOn ? String(s.signedOn).slice(0, 10).split("-").reverse().join("/") : "—";
  return <div className="min-w-0 rounded-md border border-background-200 bg-background-50 p-3 text-sm" data-testid={testId}>
    <p className="text-xs text-foreground-500">Signed for and on behalf of</p>
    <p className="break-words font-semibold text-foreground-900" data-testid={`${testId}-organisation`}>{s.organisation}</p>
    <div className="mt-2 min-h-12" data-testid={`${testId}-signature`}>
      {s.image ? <img src={s.image} alt={`SLIT signature: ${s.name}`} className="max-h-16 max-w-full rounded border border-background-300 bg-white p-1" />
        : s.typed ? <p className={`text-2xl leading-tight text-[#0d1a4d] ${SCRIPT_FONT}`}>{s.typed}</p>
        : <p className="text-foreground-500">Signature not added yet</p>}
    </div>
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-3">
      <div className="min-w-0"><dt className="text-xs text-foreground-500">Name</dt><dd className="break-words text-foreground-900" data-testid={`${testId}-name`}>{s.name || "—"}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-foreground-500">Position</dt><dd className="break-words text-foreground-900" data-testid={`${testId}-position`}>{s.position || "—"}</dd></div>
      <div className="min-w-0"><dt className="text-xs text-foreground-500">Date</dt><dd className="text-foreground-900" data-testid={`${testId}-date`}>{day}</dd></div>
    </dl>
    {note ? <p className="mt-2 text-xs text-foreground-500">{note}</p> : null}
  </div>;
}
/** The GST choice for the commission: radio buttons, so it is never left ambiguous (SLIT staff only, in Prepare application). */
const GST_OPTIONS = [["exclusive", "GST exclusive"], ["inclusive", "GST inclusive"]] as const;

/** The pre-send step (2026-11-20): staff fill the F04 before it goes; the agreement terms, the witness and the buttons live with the dialog. */
export interface F04PrefillControls {
  terms: { commencementDate: string; territory: string; commissionPercent: string; commissionGst: "" | "inclusive" | "exclusive" }; onTerms: (terms: F04PrefillControls["terms"]) => void;
  witness: { name: string; png: string | null }; onWitness: (witness: F04PrefillControls["witness"]) => void;
  /** SLIT's signatory (2026-11-21): the sending admin's name and position, their signature (saved / drawn / typed) and the send date. */
  signatory: { organisation: string; name: string; position: string; savedSignature: string | null; signedOn: string; method: "saved" | "drawn" | "typed"; png: string | null; save: boolean };
  onSignatory: (signatory: F04PrefillControls["signatory"]) => void;
  message: string; onMessage: (message: string) => void;
  busy: "" | "save" | "send"; contact: { name: string; email: string } | null; savedNote: string | null;
  onSaveDraft: (state: F04Draft) => void; onSend: (state: F04Draft) => void; onClose: () => void;
  /** Registered migration agents linked to the business, highest match first (2026-11-24): the MARN starts with the first; any can be picked. */
  linkedAgents?: { fullName: string; marn: string; confidence: number }[];
}
const PREFILL_WITNESS_HINT = "Optional. The SLIT witness's name and signature (drawn, or their typed name once you confirm they agreed) are printed on the agreement's SLIT witness line when you send. Leave it empty and the approver can add the SLIT witness when approving. The agency admin gives their own witness on the form.";

export default function F04Wizard({ token, view, codeCheck, onSigned, mode: modeProp = "agent", review, prefill }: {
  token: string; view: SigningView;
  /** The emailed-code check when the request asks for one (rendered on the last step); null when not needed or done. */
  codeCheck: { needed: boolean; session: string | null; render: () => ReactNode };
  onSigned: () => Promise<void> | void;
  /** agent: the agency admin fills in and signs; admin-review: SLIT staff in the CMS; correction: set by the request itself; admin-prefill: staff before sending. */
  mode?: F04Mode; review?: F04ReviewControls; prefill?: F04PrefillControls;
}) {
  const fields = view.fields;
  const facts = (view.application?.facts ?? null) as Partial<AbrFacts> | null;
  const correction = view.application?.correction ?? null;
  const mode: F04Mode = modeProp === "admin-review" ? "admin-review" : modeProp === "admin-prefill" ? "admin-prefill" : correction ? "correction" : "agent";
  const admin = mode === "admin-review", correcting = mode === "correction", prefilling = mode === "admin-prefill";
  const bestLinkedMarn = prefilling ? prefill?.linkedAgents?.[0]?.marn ?? "" : "";
  const [witnessAgreed, setWitnessAgreed] = useState(false);
  // Staff (review or pre-send) move freely between steps and search addresses with their own session.
  const staff = admin || prefilling;
  const reviewFlags = review?.flags, correctionFlags = correction?.flags;
  const flags = useMemo(() => (admin ? reviewFlags : correctionFlags) ?? {}, [admin, reviewFlags, correctionFlags]);
  const order = useMemo(() => visibleSteps(mode, flags), [mode, flags]);
  // A correction (2026-11-21) opens with every answer as signed; a saved draft brings back only the answers that may change.
  const signedAnswers = correction?.answers ?? null;
  const opening = useMemo(() => {
    const draft = (view.application?.draft ?? null) as Partial<F04Draft> | null;
    const init = initialF04(mode === "correction" ? withSignedAnswers(fields, signedAnswers) : fields, facts, view.application?.prefill ?? null, draft && mode === "correction" ? correctionDraft(draft, flags) : draft,
      view.recipient.name, (mode === "agent" || mode === "admin-prefill") && ruleText("agents.agent_application_yes_no_fallback", "No") === "No");
    // Business Rules (agents.contact_title_default / agents.contact_position_default): a blank Title / Position starts at the rule's
    // choice ("Mr" / "Director" today) when staff prepare the form or the agency fills it; still editable, never over a saved answer.
    if (mode === "agent" || mode === "admin-prefill") {
      const preset: Record<string, string> = {};
      const title = ruleText("agents.contact_title_default", "Mr"), position = ruleText("agents.contact_position_default", "Director");
      if (!(init.answers.contact_title ?? "").trim() && title) preset.contact_title = title;
      if (!(init.answers.contact_position ?? "").trim() && position) preset.contact_position = position;
      if (Object.keys(preset).length) return { ...init, answers: { ...init.answers, ...preset } };
    }
    return init;
  }, [fields, facts, view.application?.prefill, view.application?.draft, view.recipient.name, mode, signedAnswers, flags]);
  // F04 + P06 signed once (2026-11-20): the agreement's terms and the witness (preset by staff, or typed + drawn here).
  const combined = view.onboarding?.combined === true && !staff;
  const terms = view.onboarding?.agreement ?? null;
  const witnessPlan = view.onboarding?.witness ?? null;
  const needWitness = combined && !witnessPlan?.preset;
  // The agent portal password (owner 2026-11-24): chosen here, when the agency admin signs the application and agreement, so after approval
  // they sign in with this email and password. Not on a correction (the account was made at the first signature).
  const needPassword = combined && !correcting;
  const [portalPw, setPortalPw] = useState("");
  const [portalPw2, setPortalPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const passwordProblem = !needPassword ? "" : portalPw.length < 8 ? "Create your portal password (at least 8 characters)."
    : !/[A-Za-z]/.test(portalPw) || !/\d/.test(portalPw) ? "Use letters and at least one number in your password."
    : portalPw !== portalPw2 ? "The two passwords are not the same." : "";
  // Business Rules (agents.agency_witness_on_agreement): the agency's witness may be optional; one given still needs a name and a drawing.
  const witnessOptional = ruleText("agents.agency_witness_on_agreement", "Required") === "Optional";
  const witnessRequired = needWitness && !witnessOptional;
  const rulesF04 = { refereeEmailsDistinct: ruleText("agents.referee_emails_must_differ", "Must be different") !== "May be the same", ownEmails: mode === "agent" || mode === "correction" ? [view.recipient.email] : [] };
  const termYears = Math.max(1, Math.round(ruleNumber("agents.agreement_term_years", 2)));
  const [witnessPng, setWitnessPng] = useState<string | null>(null);
  const [state, setState] = useState<F04Draft>(opening);
  // Prepare the application (2026-11-24): an empty MARN starts with the best-matching linked registered agent, once; staff can change or clear it.
  const marnDefaulted = useRef(false);
  useEffect(() => {
    if (!bestLinkedMarn || marnDefaulted.current) return;
    marnDefaulted.current = true;
    setState((s) => (s.marn ? s : { ...s, marn: bestLinkedMarn }));
  }, [bestLinkedMarn]);
  // What the review opened with: staff changes are the difference from it.
  const [reviewBase, setReviewBase] = useState<F04Draft>(opening);
  const firstStep = mode === "admin-review" ? REVIEW_STEP : order.includes(opening.step) ? opening.step : order[0];
  const [step, setStep] = useState(firstStep);
  const [furthest, setFurthest] = useState(firstStep);
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const [tried, setTried] = useState<Set<number>>(new Set());
  // Fields left at least once (2026-11-21): their errors show at once, before Next.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<Attachments>(() => (view.application?.attachments ?? {}) as Attachments);
  // The register's values are shown as text to confirm; Edit turns the same values into inputs. Nothing to show: inputs at once.
  // Staff and a correction see every answer as an input (each one can be flagged / is marked); the agent gets the confirm cards.
  const [editCompany, setEditCompany] = useState(() => mode !== "agent" || !COMPANY_KEYS.some((k) => (opening.answers[k] ?? "").trim()));
  const [editContact, setEditContact] = useState(mode !== "agent");
  const [editAddress, setEditAddress] = useState(() => mode !== "agent" || !(opening.answers.office_street_address ?? "").trim());
  const [manualRef, setManualRef] = useState<Record<number, boolean>>({});
  const [method, setMethod] = useState<"typed" | "drawn">("typed");
  const [picture, setPicture] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "sign">("");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">(view.application?.savedAt ? "saved" : "idle");
  const [notice, setNotice] = useState<{ tone: "info" | "error" | "warn"; text: string } | null>(view.application?.savedAt ? { tone: "info", text: `Welcome back. Your answers saved on ${new Date(view.application.savedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })} are filled in.` } : null);
  const top = useRef<HTMLDivElement>(null);
  // Staff search with their own session (the address box's default); the link holder searches through document-signing with the token.
  const search = useMemo(() => (staff ? undefined : searchFor(token)), [staff, token]);
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
    // Staff review keeps no draft: Save changes writes the answers themselves.
    if (closed.current || staff) return true;
    // A correction saves only the answers SLIT flagged (the server refuses any other; 2026-11-21).
    const whole = { ...stateRef.current, step: at, stepId: STEPS[at]?.id };
    const draft = correcting ? correctionDraft(whole, flags) : whole;
    const json = JSON.stringify(draft);
    if (!force && json === lastSaved.current) return true;
    setSaved("saving");
    try {
      await signingAction({ action: "draft_save", token, draft });
      lastSaved.current = json; lastSaveAt.current = Date.now(); setSaved("saved");
      return true;
    } catch { setSaved("error"); return false; }
  }, [token, staff, correcting, flags]);
  useEffect(() => {
    if (closed.current || staff || JSON.stringify({ ...state, step: stepRef.current }) === lastSaved.current) return;
    const wait = Math.max(AUTOSAVE_PAUSE, lastSaveAt.current + AUTOSAVE_GAP - Date.now());
    const timer = window.setTimeout(() => { void persist(stepRef.current); }, wait);
    return () => window.clearTimeout(timer);
  }, [state, persist, staff]);

  // A correction checks only the flagged answers (and the declaration): the rest is locked as signed (2026-11-21).
  const scope = (p: Record<string, string>) => correcting ? correctionScope(p, flags) : p;
  const problems = scope(f04Problems(step, fields, state, attachments, rulesF04));
  const shown = tried.has(step) ? problems : Object.fromEntries(Object.entries(problems).filter(([k]) => touched.has(k)));
  // The agency admin's form (2026-11-21): Next / Sign and submit stay disabled until the step is complete, with what is missing beside them.
  const gated = mode === "agent" || mode === "correction";
  const missing = Object.values(problems)[0] ?? "";
  const onBlurField = (e: FocusEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).id ?? "";
    if (!id.startsWith("f04-")) return;
    const key = id.slice(4);
    setTouched((t) => t.has(key) ? t : new Set(t).add(key));
  };
  const allProblems = STEPS.map((_, i) => scope(f04Problems(i, fields, state, attachments, rulesF04)));
  const set = (key: string, value: string) => setState((s) => ({ ...s, answers: { ...s.answers, [key]: value } }));
  const setMany = (values: Record<string, string>) => setState((s) => ({ ...s, answers: { ...s.answers, ...values } }));
  const warnings = step === F04_STEP.references ? checkApplicationAnswers({ ref1_contact_name: a.ref1_contact_name ?? "", ref2_contact_name: a.ref2_contact_name ?? "" }).warnings : [];
  const signatureReady = method === "typed" ? (a.declarant_name ?? "").trim().length >= 2 : !!picture;
  // The witness (2026-11-20): a full name and a drawn signature, unless staff gave the witness before sending.
  const witnessName = (a[WITNESS_NAME_KEY] ?? "").trim();
  const witnessReady = !needWitness || (witnessOptional && !witnessName && !witnessPng) || (witnessName.length >= 2 && !!witnessPng);
  const canSubmit = Object.keys(problems).length === 0 && consent && signatureReady && witnessReady && !passwordProblem && (!codeCheck.needed || !!codeCheck.session);
  const submitHint = canSubmit ? "" : missing || (!signatureReady ? "Add your signature." : !witnessReady ? "Add your witness: their full name and their drawn signature." : passwordProblem ? passwordProblem : !consent ? "Tick the agreement to sign electronically." : "Confirm the emailed code.");

  const save = async () => {
    if (busy === "save") return;
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
    if (!order.includes(index)) return;
    // Forward only once the steps before are complete (staff may move freely); back always.
    if (index > step && !staff) {
      for (const i of order.filter((s) => s >= step && s < index)) if (Object.keys(allProblems[i]).length) { setTried((t) => new Set(t).add(i)); if (i !== step) show(i); return; }
    }
    if (index !== returnTo && index < step) setReturnTo(null);
    show(index);
  };
  const nextOf = (s: number) => order[order.indexOf(s) + 1] ?? REVIEW_STEP;
  const prevOf = (s: number) => order[order.indexOf(s) - 1] ?? s;
  // Staff review: what changed since it opened, saved with an audit line per field (and a new PDF revision).
  const changes = admin ? reviewChanges(fields, reviewBase, state) : {};
  const dirty = Object.keys(changes).length > 0;
  const saveReview = async () => {
    if (!review || !dirty) return true;
    const ok = await review.onSave(changes, state);
    if (ok) setReviewBase(state);
    return ok;
  };
  // ---------------------------------------------------------------- flags (staff) and read-only answers (correction)
  const flagged = (keys: string[]) => keys.some((k) => correctionFlagged(k, flags));
  const setFlag = (key: string, note: string | null) => {
    if (!review) return;
    const next = { ...review.flags };
    if (note === null) delete next[key]; else next[key] = note;
    review.onFlags(next);
  };
  /** One answer's frame: staff get a flag button and a note box; a correction marks flagged answers and locks the others. */
  const frame = (keys: string[], node: ReactNode, label = "this answer") => {
    if (mode === "agent" || prefilling || !node) return node;
    const key = keys[0];
    const on = flagged(keys);
    if (admin) return (
      <div className="relative" key={`frame-${key}`} data-testid={`f04-frame-${key}`}>
        <button type="button" aria-pressed={on} title={on ? "Flagged for correction" : `Flag ${label} for correction`} aria-label={on ? `Remove the correction flag on ${label}` : `Flag ${label} for correction`}
          onClick={() => setFlag(key, on ? null : "")} className={`absolute right-0 top-0 z-10 cursor-pointer rounded p-0.5 text-sm ${on ? "text-amber-600" : "text-foreground-400 hover:text-amber-600"}`} data-testid={`f04-flag-${key}`}>
          <i className={on ? "ri-flag-2-fill" : "ri-flag-2-line"} aria-hidden="true" /></button>
        <div className={on ? "rounded-md ring-2 ring-amber-300 ring-offset-2" : ""}>{node}</div>
        {on ? <input aria-label={`Note for the agency on ${label}`} value={flags[key] ?? ""} maxLength={500} placeholder="What should they correct?" className={`${WIZARD_INPUT} mt-1.5 border-amber-300 bg-amber-50 text-sm`}
          onChange={(e) => setFlag(key, e.target.value)} data-testid={`f04-flag-note-${key}`} /> : null}
      </div>);
    if (on) return (
      <div className="rounded-md bg-amber-50 p-2 ring-2 ring-amber-300" key={`frame-${key}`} data-testid={`f04-flagged-${key}`}>
        {flags[key] ? <p className="mb-1.5 flex items-start gap-1 text-xs font-medium text-amber-900"><i className="ri-flag-2-fill mt-px" aria-hidden="true" />SLIT: {flags[key]}</p>
          : <p className="mb-1.5 text-xs font-medium text-amber-900"><i className="ri-flag-2-fill mr-1" aria-hidden="true" />Please check and correct this answer.</p>}
        {node}
      </div>);
    return <fieldset key={`frame-${key}`} disabled className="min-w-0 opacity-75" data-testid={`f04-locked-${key}`}>{node}</fieldset>;
  };
  /** From the review: open a step, then come straight back. */
  const editStep = (index: number) => { setReturnTo(REVIEW_STEP); show(index); };
  const next = () => {
    setTried((t) => new Set(t).add(step));
    if (Object.keys(problems).length && !prefilling) {
      // A missing value hidden in a summary card opens its inputs.
      if (step === F04_STEP.business) setEditCompany(true);
      if (step === F04_STEP.contact) { if (["contact_given_name", "contact_family_name", "contact_email", "contact_phone"].some((k) => problems[k])) setEditContact(true); if (problems.office_street_address || problems.office_country || problems.office_postcode || problems.office_suburb) setEditAddress(true); }
      setNotice({ tone: "error", text: "Some answers are missing or need a fix. They are marked below." }); return;
    }
    const target = returnTo ?? nextOf(step);
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
        application: { acn: state.acn, marn: state.marn.replace(/\s/g, ""), declarations: state.declarations, ...(needWitness ? { witness: { name: witnessName, png: witnessPng } } : {}),
          ...(needPassword && !passwordProblem ? { account: { password: portalPw } } : {}) } });
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

  const text = (key: string, label: string, options: { type?: string; inputMode?: "numeric" | "text"; autoComplete?: string; maxLength?: number; required?: boolean; placeholder?: string; digits?: boolean; hint?: ReactNode; noFrame?: boolean } = {}) => {
    if (!has(key) && key !== "office_postcode") return null;
    const node = <WizardTextField key={key} id={`f04-${key}`} name={key} label={label} value={a[key] ?? ""} error={shown[key]} required={options.required ?? isRequired(key)} placeholder={options.placeholder}
      type={options.type} inputMode={options.inputMode} autoComplete={options.autoComplete ?? "off"} maxLength={options.maxLength ?? 500} testId={`f04-${key}`} onChange={(v) => set(key, options.digits ? v.replace(/\D/g, "") : v)}>{options.hint}</WizardTextField>;
    return options.noFrame ? node : frame([key], node, label.toLowerCase());
  };
  const phone = (key: string, label: string) => has(key) ? frame([key], (
    <div key={key}>
      <WizardLabel htmlFor={`f04-${key}`} required>{label}</WizardLabel>
      <PhoneInput id={`f04-${key}`} name={key} value={a[key] ?? ""} invalid={Boolean(shown[key])} placeholder="041 234 5678" onValueChange={(v) => set(key, v)} />
      <FieldError text={shown[key]} />
    </div>), label.toLowerCase()) : null;
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

  /** Long values (emails, the office address, web addresses) take the card's full width, so they wrap at "@", "." or "/" rather than mid-word. */
  const WIDE_ROWS = new Set(["Email", "Office", "Website"]);
  const reviewSummary = () => {
    const section = (index: number, rows: Array<[string, ReactNode]>, oneColumn = false) => !order.includes(index) ? null : (
      <section key={index} className="min-w-0 rounded-lg border border-background-200 p-4" data-testid={`f04-review-${STEPS[index].id}`}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-foreground-900">{STEPS[index].short}</h4>
          <button type="button" onClick={() => editStep(index)} className="cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline" data-testid={`f04-review-edit-${STEPS[index].id}`}>Edit</button>
        </div>
        <dl className={`grid grid-cols-1 gap-x-6 text-sm ${oneColumn ? "gap-y-3" : "gap-y-1.5 sm:grid-cols-2"}`}>
          {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([label, v]) => <div key={label} className={`min-w-0 ${WIDE_ROWS.has(label) ? "sm:col-span-2" : ""}`}><dt className="text-xs text-foreground-500">{label}</dt><dd className="break-words text-foreground-900">{v}</dd></div>)}
        </dl>
      </section>);
    const yn = (k: string) => (yesNo(a[k]) === "YES" ? "Yes" : yesNo(a[k]) === "NO" ? "No" : "");
    // One reference per row: name (position, organisation), then the email and the phone on lines of their own; staff see the referee's status.
    const ref = (n: number): ReactNode => {
      const v = (part: string) => (a[`ref${n}_${part}`] ?? "").trim();
      if (!v("contact_name") && !v("email") && !v("phone")) return "";
      const role = [v("position"), v("organisation")].filter(Boolean).join(", ");
      return <div className="space-y-0.5" data-testid={`f04-review-ref-${n}`}>
        <p className="font-medium">{v("contact_name") || "—"}{role ? <span className="font-normal text-foreground-600"> · {role}</span> : null}</p>
        {v("email") ? <p className="text-foreground-800" data-testid={`f04-review-ref-${n}-email`}>{softBreak(v("email"))}</p> : null}
        {v("phone") ? <p className="text-foreground-800">{formatPhone(v("phone"))}</p> : null}
        {admin && review?.refereeStatus ? <div className="pt-1" data-testid={`f04-review-ref-${n}-status`}>{review.refereeStatus(n as 1 | 2)}</div> : null}
      </div>;
    };
    const signatureCell = (label: string, sig: F04ReviewSignature | null, testId: string) => (
      <div className="min-w-0 rounded-md border border-background-200 bg-background-50 p-3" data-testid={testId}>
        <p className="text-xs text-foreground-500">{label}</p>
        {sig ? <>
          <p className="font-medium text-foreground-900">{sig.name || "—"}</p>
          {sig.image ? <img src={sig.image} alt={`${label}: ${sig.name}`} className="mt-1 max-h-16 max-w-full rounded border border-background-300 bg-white p-1" data-testid={`${testId}-image`} />
            : <p className={`mt-1 text-2xl leading-tight text-[#0d1a4d] ${SCRIPT_FONT}`} data-testid={`${testId}-typed`}>{sig.name}</p>}
          {sig.signedAt ? <p className="mt-1 text-xs text-foreground-600" data-testid={`${testId}-date`}>Signed {formatSignedAt(sig.signedAt)}</p> : null}
        </> : <p className="text-sm text-foreground-500">Not given</p>}
      </div>);
    const ag = admin ? review?.agreement ?? null : null;
    const auDay = (iso: string | null | undefined) => iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "—";
    const agreementCard = ag ? (
      <section className="min-w-0 rounded-lg border border-background-200 p-4 lg:col-span-2" data-testid="f04-review-agreement">
        <h4 className="mb-2 text-sm font-semibold text-foreground-900">Agreement (P06)</h4>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
          <div className="min-w-0"><dt className="text-xs text-foreground-500">Commencement</dt><dd className="text-foreground-900" data-testid="f04-review-agreement-commencement">{auDay(ag.commencementDate)}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-foreground-500">Ends</dt><dd className="text-foreground-900">{auDay(ag.expiryDate)}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-foreground-500">Territory</dt><dd className="break-words text-foreground-900">{ag.territory || "—"}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-foreground-500">Commission</dt><dd className="text-foreground-900" data-testid="f04-review-agreement-commission">{commissionText(ag.commissionPercent, ag.commissionGst) || "—"}</dd></div>
        </dl>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {signatureCell("Agency admin's signature", ag.agencySignature, "f04-review-agreement-signature")}
          {signatureCell("Agency's witness", ag.agencyWitness, "f04-review-agreement-agency-witness")}
          {signatureCell("SLIT witness", ag.slitWitness, "f04-review-agreement-slit-witness")}
        </div>
        {ag.slitSignatory ? <div className="mt-3"><SlitSignatoryBlock testId="f04-review-agreement-slit-signatory" s={ag.slitSignatory} /></div> : null}
      </section>) : null;
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-testid="f04-review">
        {section(F04_STEP.business, [["Legal name", a.agent_legal_entity], ["Trading name", a.agent_trading_name], ["ABN", a.agent_abn ? printAbn(a.agent_abn) : ""], ["ACN", state.acn ? printAcn(state.acn) : admin ? "—" : ""],
          ["Year founded", a.agent_year_founded], ["MARN", state.marn]])}
        {section(F04_STEP.references, [["Reference 1", ref(1)], ["Reference 2", ref(2)]], true)}
        {section(F04_STEP.contact, [["Contact", contactName], ["Position", a.contact_position], ["Email", softBreak(a.contact_email)], ["Phone", a.contact_phone ? formatPhone(a.contact_phone) : ""], ["Office", officeLine], ["Website", softBreak(a.agent_website)]])}
        {section(F04_STEP.agency, [...QUESTIONS.filter((q) => asks(q.key)).map((q): [string, ReactNode] => [q.short, yn(q.key) + (yesNo(a[q.key]) === "YES" && q.attach && attachments[q.attach] ? ` · ${attachments[q.attach]!.name}` : "")]),
          ["Services", a.services_provided], ["Other countries", a.other_countries_recruited],
          ["Numbers", NUMBERS.filter(([k]) => (a[k] ?? "").trim()).map(([k, label]) => `${label}: ${a[k]}`).join(" · ")]])}
        {agreementCard}
      </div>
    );
  };

  const body = (() => {
    if (step === F04_STEP.business) {
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
                {frame(["acn"], <WizardTextField id="f04-acn" name="acn" label="ACN" required={false} value={printAcn(state.acn)} error={shown.acn} inputMode="numeric" maxLength={11} testId="f04-acn"
                  onChange={(v) => setState((s) => ({ ...s, acn: v.replace(/\D/g, "").slice(0, 9) }))} />, "the ACN")}
                {text("agent_trading_name", "Trading name", { hint: tradingHint })}
                {text("agent_agency_name", "Agency name")}
                {text("agent_year_founded", "Year founded", { inputMode: "numeric", maxLength: 4, digits: true, hint: yearHint })}
                {has("agent_gst_registered") ? <div className="sm:col-span-2">{frame(["agent_gst_registered"], <YesNo id="agent_gst_registered" label="Registered for GST?" value={gst} required={false} onChange={(v) => set("agent_gst_registered", v)} />, "GST registration")}</div> : null}
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
            {Object.keys(gated ? problems : shown).some((k) => COMPANY_KEYS.includes(k as never) || k === "acn") && !editCompany ? <FieldError text="Some details are missing: select Edit." /> : null}
          </section>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {frame(["marn"], <WizardTextField id="f04-marn" name="marn" label="MARA number (MARN), if registered" required={false} value={state.marn} error={shown.marn} inputMode="numeric" maxLength={10} testId="f04-marn"
              onChange={(v) => setState((s) => ({ ...s, marn: v.replace(/\D/g, "") }))}>
              <a href={OMARA_REGISTER_URL} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary-700 underline underline-offset-2" data-testid="f04-omara-link">
                <i className="ri-external-link-line" aria-hidden="true" />Search the OMARA register</a>
              {prefilling && prefill?.linkedAgents?.length ? <div className="mt-2" data-testid="f04-linked-agents">
                <p className="text-xs text-foreground-600">Registered agents linked to this business (highest match first). Click one to use its MARN:</p>
                <div className="mt-1 flex flex-wrap gap-1.5">{prefill.linkedAgents.map((a) => (
                  <button key={a.marn} type="button" onClick={() => setState((s) => ({ ...s, marn: a.marn }))} aria-pressed={state.marn === a.marn}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${state.marn === a.marn ? "border-primary-500 bg-primary-50 text-primary-800" : "border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100"}`}>
                    {a.fullName} · {a.marn} · {a.confidence}%</button>))}</div>
              </div> : null}
            </WizardTextField>, "the MARN")}
          </div>
        </div>
      );
    }
    if (step === F04_STEP.contact) {
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
            ) : ["contact_given_name", "contact_family_name", "contact_email", "contact_phone"].map((k) => (gated ? problems : shown)[k] ? <FieldError key={k} text={(gated ? problems : shown)[k]} /> : null)}
          </section>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {has("contact_title") ? frame(["contact_title"], <div>
              <WizardLabel htmlFor="f04-contact_title" required={isRequired("contact_title")}>Title</WizardLabel>
              <SearchableSelect id="f04-contact_title" value={a.contact_title ?? ""} aria-invalid={Boolean(shown.contact_title)} className={WIZARD_INPUT} data-testid="f04-contact_title" onChange={(e) => set("contact_title", e.target.value)}>
                <option value="">Select</option>{F04_TITLES.map((t) => <option key={t} value={t}>{t}</option>)}
              </SearchableSelect>
              <FieldError text={shown.contact_title} />
            </div>, "the title") : null}
            {has("contact_position") ? <div className="sm:col-span-2">{frame(["contact_position"], <ChoiceChips id="contact_position" label="Position" value={a.contact_position ?? ""} error={shown.contact_position} required={isRequired("contact_position")} onChange={(v) => set("contact_position", v)} />, "the position")}</div> : null}
          </div>
          {frame(["office_address", "office_street_address", "office_suburb", "office_state", "office_province", "office_country"], <fieldset className="space-y-3">
            <legend className="mb-1.5 text-sm font-semibold text-foreground-900">Office address <span className="text-primary-600">*</span></legend>
            <AddressAutocomplete inputId="f04-office-search" label="Find the office address" search={search} onPick={pick} onManual={() => setEditAddress(true)} onUnavailable={() => setEditAddress(true)} />
            {!editAddress && officeLine ? (
              <div className="flex items-start justify-between gap-3 rounded-md border border-background-200 px-3 py-2 text-sm" data-testid="f04-office-summary">
                <span className="min-w-0 break-words text-foreground-900"><i className="ri-map-pin-line mr-1 text-primary-600" aria-hidden="true" />{officeLine}</span>
                <button type="button" onClick={() => setEditAddress(true)} className="shrink-0 cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline" data-testid="f04-office-edit">Edit</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-6" data-testid="f04-office-inputs">
                <div className="sm:col-span-6">{text("office_street_address", "Street address", { autoComplete: "street-address", noFrame: true })}</div>
                <div className="sm:col-span-3">{text("office_suburb", "Suburb or city", { autoComplete: "address-level2", required: false, noFrame: true })}</div>
                {australian ? <div className="sm:col-span-1">
                  <WizardLabel htmlFor="f04-office_state" required={false}>State</WizardLabel>
                  <SearchableSelect id="f04-office_state" value={(a.office_state ?? "").toUpperCase()} className={WIZARD_INPUT} data-testid="f04-office_state" onChange={(e) => set("office_state", e.target.value)}>
                    <option value="">—</option>{AU_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </SearchableSelect>
                </div> : <div className="sm:col-span-1">{text("office_province", "Province / region", { required: false, noFrame: true })}</div>}
                <div className="sm:col-span-2">{text("office_postcode", "Postcode", { inputMode: australian ? "numeric" : "text", autoComplete: "postal-code", maxLength: 10, required: false, noFrame: true })}</div>
                <div className="sm:col-span-6">{text("office_country", "Country", { autoComplete: "country-name", noFrame: true })}</div>
              </div>
            )}
            {!editAddress ? (() => { const s = gated ? problems : shown; return [s.office_street_address, s.office_country, s.office_postcode, s.office_suburb].map((t, i) => <FieldError key={i} text={t} />); })() : null}
          </fieldset>, "the office address")}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{text("agent_website", "Website", { autoComplete: "url", required: false, placeholder: "https://" })}</div>
        </div>
      );
    }
    if (step === F04_STEP.agency) return (
      <div className="space-y-4">
        <div className="space-y-2">
          {QUESTIONS.filter((q) => asks(q.key)).map((q) => {
            const yes = yesNo(a[q.key]) === "YES";
            return (
              frame([q.key, ...(q.follow ? [q.follow.key] : [])], <YesNo key={q.key} id={q.key} label={q.label} value={yesNo(a[q.key])} error={shown[q.key]} required={fields.some((f) => fieldGroup(f.key)?.key === q.key && f.required)} onChange={(v) => set(q.key, v)}>
                {yes && q.attach ? (staff ? <p className="text-xs text-foreground-600" data-testid={`f04-attach-${q.attach}`}><i className="ri-attachment-2 mr-1" aria-hidden="true" />{prefilling ? "The agency admin uploads the file when filling in the form." : attachments[q.attach]?.name ?? "No file uploaded"}</p>
                  : <Upload token={token} kind={q.attach} file={attachments[q.attach]} error={shown[`attach_${q.attach}`]} onChange={(file) => setAttachments((x) => { const n = { ...x }; if (file) n[q.attach!] = file; else delete n[q.attach!]; return n; })} />) : null}
                {yes && q.follow && has(q.follow.key) ? (q.follow.long
                  ? <TextArea id={q.follow.key} label={q.follow.label} value={a[q.follow.key] ?? ""} error={shown[q.follow.key]} required={q.follow.required} onChange={(v) => set(q.follow!.key, v)} />
                  : text(q.follow.key, q.follow.label, { required: q.follow.required, noFrame: true })) : null}
              </YesNo>, q.short.toLowerCase())
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{NUMBERS.filter(([k]) => has(k)).map(([k, label]) => <div key={k}>{text(k, label, { inputMode: "numeric", maxLength: 6, required: false, digits: true })}</div>)}</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {has("services_provided") ? frame(["services_provided"], <Chips id="services_provided" label="Services provided to students" value={a.services_provided ?? ""} options={SERVICES} error={shown.services_provided} onChange={(v) => set("services_provided", v)} />, "the services") : null}
          {has("other_countries_recruited") ? frame(["other_countries_recruited"], <Chips id="other_countries_recruited" label="Other countries you recruit students to" value={a.other_countries_recruited ?? ""} options={COUNTRIES} error={shown.other_countries_recruited} onChange={(v) => set("other_countries_recruited", v)} />, "the other countries") : null}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {has("popular_courses") ? frame(["popular_courses"], <TextArea id="popular_courses" label="Popular courses among your students" value={a.popular_courses ?? ""} error={shown.popular_courses} required={isRequired("popular_courses")} onChange={(v) => set("popular_courses", v)} />, "the popular courses") : null}
          {has("slit_promotion_plan") ? frame(["slit_promotion_plan"], <TextArea id="slit_promotion_plan" label="How you will promote SLIT" value={a.slit_promotion_plan ?? ""} error={shown.slit_promotion_plan} required={isRequired("slit_promotion_plan")} onChange={(v) => set("slit_promotion_plan", v)} />, "the promotion plan") : null}
        </div>
        <details className="rounded-lg border border-background-200 px-3 py-2" data-testid="f04-more" open={Boolean((a.associations ?? "").trim() || (a.australian_institutions_represented ?? "").trim() || flagged(["associations", "australian_institutions_represented"])) || undefined}>
          <summary className="cursor-pointer text-sm font-semibold text-foreground-800">More about your agency (optional)</summary>
          <div className="mt-3 grid grid-cols-1 gap-4 pb-1 sm:grid-cols-2">
            {has("associations") ? frame(["associations"], <TextArea id="associations" label="Associations you are a member of" value={a.associations ?? ""} required={false} onChange={(v) => set("associations", v)} />, "the associations") : null}
            {has("australian_institutions_represented") ? frame(["australian_institutions_represented"], <TextArea id="australian_institutions_represented" label="Australian institutions you represent" value={a.australian_institutions_represented ?? ""} required={false} onChange={(v) => set("australian_institutions_represented", v)} />, "the institutions") : null}
          </div>
        </details>
      </div>
    );
    if (step === F04_STEP.references) return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[1, 2].map((n) => {
          const k = (part: string) => `ref${n}_${part}`;
          return (
            <section key={n} className="rounded-lg border border-background-200 p-4" data-testid={`f04-reference-${n}`}>
              <h3 className="mb-3 text-sm font-semibold text-foreground-900">Reference {n}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {/* 2026-11-21: Contact name + Organisation, then Position, Email and Phone each on their own full-width row. */}
                {REF_PARTS.filter(([part]) => part === "contact_name" || part === "organisation").map(([part, label, must]) => text(k(part), label, { required: must }))}
                {has(k("position")) ? <div className="sm:col-span-2">{text(k("position"), "Position", { required: REF_PARTS.find(([p]) => p === "position")?.[2] ?? false })}</div> : null}
                {has(k("email")) ? <div className="sm:col-span-2">{frame([k("email")], <EmailBox id={`f04-${k("email")}`} name={k("email")} label="Email" value={a[k("email")] ?? ""} error={shown[k("email")]} required onChange={(v) => set(k("email"), v)} />, `reference ${n}'s email`)}</div> : null}
                <div className="sm:col-span-2">{phone(k("phone"), "Phone")}</div>
                {has(k("address")) ? <div className="sm:col-span-2">{frame([k("address")], <div>
                  {manualRef[n] || (a[k("address")] ?? "").trim() ? (
                    <div>
                      {text(k("address"), "Address", { required: false, noFrame: true })}
                      <button type="button" onClick={() => { set(k("address"), ""); setManualRef((m) => ({ ...m, [n]: false })); }} className="mt-1 cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline">Search again</button>
                    </div>
                  ) : <AddressAutocomplete inputId={`f04-ref${n}-search`} label="Address (optional)" search={search} onManual={() => setManualRef((m) => ({ ...m, [n]: true }))} onUnavailable={() => setManualRef((m) => ({ ...m, [n]: true }))}
                    onPick={(p) => set(k("address"), [streetOf(p), `${p.suburb} ${p.state} ${p.postcode}`.trim()].filter(Boolean).join(", "))} />}
                </div>, `reference ${n}'s address`)}</div> : null}
              </div>
              {admin && review ? <div className="mt-3 border-t border-background-200 pt-3" data-testid={`f04-referee-reply-${n}`}>{review.refereePanel(n as 1 | 2)}</div> : null}
            </section>
          );
        })}
        {warnings.map((w) => <p key={w} role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 lg:col-span-2" data-testid="f04-reference-warning">{w}</p>)}
      </div>
    );
    const agreed = declarationsState(state.declarations);
    const flaggedKeys = Object.keys(flags);
    const auDate = (iso: string | null | undefined) => iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "";
    if (prefilling && prefill) {
      const t = prefill.terms;
      return (
        <div className="space-y-6" data-testid="f04-prefill-review">
          {reviewSummary()}
          <section className="space-y-3 border-t border-background-200 pt-5" data-testid="f04-prefill-agreement">
            <h3 className="text-sm font-semibold text-foreground-900">Education Agent Agreement (P06): the terms</h3>
            <p className="text-sm text-foreground-600">Printed on the agreement the agency admin signs together with this form (one signature on both). You sign it for SLIT below; your signature is printed when you send.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <WizardTextField id="f04-prefill-commencement" name="commencementDate" type="date" label="Commencement date (Item 5)" required value={t.commencementDate} onChange={(v) => prefill.onTerms({ ...t, commencementDate: v })} testId="f04-prefill-commencement" />
              <WizardTextField id="f04-prefill-territory" name="territory" label="Territory (Item 3)" required value={t.territory} maxLength={200} placeholder="e.g. India, Nepal" onChange={(v) => prefill.onTerms({ ...t, territory: v })} testId="f04-prefill-territory" />
              <div className="min-w-0">
                <WizardTextField id="f04-prefill-commission" name="commissionPercent" label="Commission % (Item 4)" required inputMode="text" value={t.commissionPercent} maxLength={6} placeholder={commissionSuggested()} onChange={(v) => prefill.onTerms({ ...t, commissionPercent: v.replace(/[^\d.]/g, "") })} testId="f04-prefill-commission" />
                {/* GST on the commission (2026-11-21): required, SLIT staff only; radio buttons so it is never ambiguous. */}
                <fieldset className="mt-2" data-testid="f04-prefill-gst">
                  <legend className="text-label font-medium text-foreground-800">GST on the commission<span className="text-primary-600"> *</span></legend>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{GST_OPTIONS.map(([value, label]) =>
                    <label key={value} className="flex cursor-pointer items-center gap-2 text-sm"><input type="radio" name="f04-prefill-gst" value={value} checked={t.commissionGst === value}
                      onChange={() => prefill.onTerms({ ...t, commissionGst: value })} className="h-4 w-4" data-testid={`f04-prefill-gst-${value}`} />{label}</label>)}</div>
                  {!t.commissionGst ? <p className="mt-1 text-xs text-amber-800" data-testid="f04-prefill-gst-missing">Choose one before sending.</p> : null}
                </fieldset>
              </div>
            </div>
            {t.commissionPercent ? <p className="text-sm text-foreground-800" data-testid="f04-prefill-commission-text">Commission printed: <strong>{commissionText(t.commissionPercent, t.commissionGst) || "—"}</strong>{t.commissionGst ? "" : " (choose GST inclusive or exclusive)"}</p> : null}
            <p className="text-xs text-foreground-500">The agreement runs {termYears === 1 ? "one year" : `${termYears} years`} from the commencement date.</p>
          </section>
          {(() => {
            const s = prefill.signatory;
            const set = (patch: Partial<F04PrefillControls["signatory"]>) => prefill.onSignatory({ ...s, ...patch });
            const image = s.method === "saved" ? s.savedSignature : s.method === "drawn" ? s.png : null;
            return <section className="space-y-3 border-t border-background-200 pt-5" data-testid="f04-prefill-signatory">
              <h3 className="text-sm font-semibold text-foreground-900">SLIT signatory on the agreement</h3>
              <p className="text-sm text-foreground-600">Signed for {s.organisation}. Printed on the agreement when you send, dated the day you send; the agency admin sees it and cannot change it.</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <WizardTextField id="f04-prefill-signatory-name" name="adminName" label="SLIT signatory name" required value={s.name} maxLength={150} onChange={(v) => set({ name: v })} testId="f04-prefill-signatory-name" />
                {/* 2026-11-21: the same position chips as the agency contact (CEO / Director / Manager / Owner / Other + text); the value is the printed text. */}
                <ChoiceChips id="prefill-signatory-position" label="SLIT signatory position" required value={s.position} error={choiceUnnamed(s.position) ? "Type the position." : undefined} onChange={(v) => set({ position: v })} />
              </div>
              <div>
                <p className="mb-2 text-label font-medium text-foreground-800">SLIT signature<span className="text-primary-600"> *</span></p>
                <div role="tablist" className="mb-3 flex flex-wrap gap-2">{([["saved", "My saved signature"], ["drawn", "Draw"], ["typed", "Type my name"]] as const).filter(([id]) => id !== "saved" || s.savedSignature).map(([id, label]) =>
                  <button key={id} type="button" role="tab" aria-selected={s.method === id} onClick={() => set({ method: id, png: null })} data-testid={`f04-prefill-signature-${id}`}
                    className={`cursor-pointer rounded-full border px-4 py-1.5 text-sm font-medium ${s.method === id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-white"}`}>{label}</button>)}</div>
                {s.method === "drawn" && !s.png ? <div className="space-y-2"><SignaturePad onChange={(png) => set({ png })} />
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.save} onChange={(e) => set({ save: e.target.checked })} className="h-4 w-4" />Save as my signature for next time</label></div> : null}
                {s.method === "drawn" && s.png ? <button type="button" className="mb-2 cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline" onClick={() => set({ png: null })} data-testid="f04-prefill-signature-redraw">Draw again</button> : null}
              </div>
              <SlitSignatoryBlock testId="f04-prefill-signatory-preview" note="Preview: this is how SLIT's block prints on the agreement."
                s={{ organisation: s.organisation, name: s.name.trim(), position: choiceUnnamed(s.position) ? "" : s.position.trim(), image, typed: s.method === "typed" ? s.name.trim() || null : null, signedOn: s.signedOn }} />
            </section>;
          })()}
          <section className="space-y-3 border-t border-background-200 pt-5" data-testid="f04-prefill-witness">
            <h3 className="text-sm font-semibold text-foreground-900">SLIT witness on the agreement (optional)</h3>
            <p className="text-sm text-foreground-600">{PREFILL_WITNESS_HINT}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <WizardTextField id="f04-prefill-witness-name" name="witnessName" label="SLIT witness full name" required={false} value={prefill.witness.name} maxLength={150} onChange={(v) => prefill.onWitness({ ...prefill.witness, name: v })} testId="f04-prefill-witness-name" />
            </div>
            <div>
              <p className="mb-2 text-label font-medium text-foreground-800">SLIT witness signature</p>
              {!prefill.witness.png && prefill.witness.name.trim().length >= 2 ? <div className="mb-3 rounded-md border border-background-200 bg-background-100 p-3" data-testid="f04-prefill-witness-typed">
                <p className={`text-3xl text-[#0d1a4d] ${SCRIPT_FONT}`}>{prefill.witness.name.trim()}</p>
                <label className="mt-2 flex items-start gap-2 text-xs text-foreground-700">
                  <input type="checkbox" className="mt-0.5" checked={witnessAgreed} onChange={(e) => setWitnessAgreed(e.target.checked)} data-testid="f04-prefill-witness-agreed" />
                  <span>{prefill.witness.name.trim()} has agreed to be the SLIT witness on this agreement and to their typed name being used as their signature.</span>
                </label>
                <button type="button" disabled={!witnessAgreed} className="mt-2 cursor-pointer rounded-md bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void typedSignaturePng(prefill.witness.name.trim()).then((png) => prefill.onWitness({ ...prefill.witness, png }))} data-testid="f04-prefill-witness-use-typed">Use the typed name as the signature</button>
                <p className="mt-2 text-2xs text-foreground-500">Or draw the signature below.</p>
              </div> : null}
              {prefill.witness.png ? <div className="flex flex-wrap items-center gap-3">
                <img src={prefill.witness.png} alt="The SLIT witness's drawn signature" className="max-h-20 rounded border border-background-300 bg-white p-1" data-testid="f04-prefill-witness-image" />
                <button type="button" className="cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline" onClick={() => prefill.onWitness({ ...prefill.witness, png: null })} data-testid="f04-prefill-witness-redraw">Draw again</button>
              </div> : <SignaturePad onChange={(png) => prefill.onWitness({ ...prefill.witness, png })} />}
              {(prefill.witness.name.trim() || prefill.witness.png) ? <button type="button" className="mt-2 cursor-pointer text-xs font-semibold text-foreground-600 underline-offset-2 hover:underline" onClick={() => prefill.onWitness({ name: "", png: null })} data-testid="f04-prefill-witness-clear">Clear the SLIT witness</button> : null}
            </div>
          </section>
          <section className="space-y-2 border-t border-background-200 pt-5">
            <WizardLabel htmlFor="f04-prefill-message" required={false}>Message to the point of contact (optional)</WizardLabel>
            <textarea id="f04-prefill-message" rows={3} maxLength={2000} value={prefill.message} onChange={(e) => prefill.onMessage(e.target.value)} className={WIZARD_INPUT} data-testid="f04-prefill-message" placeholder="Goes in the email with the link" />
            <p className="text-xs text-foreground-500">The two references are left empty: the agency admin gives them. Every Yes / No question starts at No; the agency admin can change any answer you filled in.</p>
          </section>
        </div>);
    }
    // F04 + P06 signed once: the agreement's terms, the full agreement to read, and the witness.
    const agreementSection = combined ? (
      <section className="space-y-4 border-t border-background-200 pt-5" data-testid="f04-agreement">
        <h3 className="text-sm font-semibold text-foreground-900">Education Agent Agreement (P06)</h3>
        <p className="text-sm text-foreground-800">Your application and the agent agreement are signed together: <strong>your one signature below signs both documents.</strong> {terms?.slitSignatory
          ? "SLIT has already signed the agreement (below). When your application is approved you receive the completed copy."
          : "SLIT countersigns the agreement when your application is approved and emails you the completed copy."}</p>
        {terms ? <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-background-200 p-4 text-sm sm:grid-cols-4" data-testid="f04-agreement-terms">
          <div><dt className="text-xs text-foreground-500">Commencement (Item 5)</dt><dd className="font-medium text-foreground-900">{auDate(terms.commencementDate)}</dd></div>
          <div><dt className="text-xs text-foreground-500">Ends</dt><dd className="font-medium text-foreground-900">{auDate(terms.expiryDate)}</dd></div>
          <div><dt className="text-xs text-foreground-500">Territory (Item 3)</dt><dd className="font-medium text-foreground-900">{terms.territory || "—"}</dd></div>
          <div><dt className="text-xs text-foreground-500">Commission (Item 4)</dt><dd className="font-medium text-foreground-900" data-testid="f04-agreement-commission">{commissionText(terms.commissionPercent, terms.commissionGst) || "—"}</dd></div>
        </dl> : null}
        {terms?.slitSignatory ? <SlitSignatoryBlock testId="f04-agreement-slit-signatory" s={terms.slitSignatory} note="Signed by SLIT before sending; it cannot be changed here." /> : null}
        {view.url ? <a href={view.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 underline underline-offset-2" data-testid="f04-agreement-read">
          <i className="ri-file-text-line" aria-hidden="true" />Read the full agreement (PDF: the application form, then the agreement)</a> : null}
        <div className="space-y-3 rounded-lg border border-background-200 p-4" data-testid="f04-witness">
          <h4 className="text-sm font-semibold text-foreground-900">Witness to your signature{witnessRequired ? <span className="text-primary-600"> *</span> : needWitness ? <span className="text-xs font-normal text-foreground-500"> (optional)</span> : null}</h4>
          {witnessPlan?.preset ? <div className="flex flex-wrap items-center gap-4 text-sm" data-testid="f04-witness-preset">
            <span><span className="text-xs text-foreground-500">Witness</span><br /><strong>{witnessPlan.name}</strong></span>
            {witnessPlan.image ? <img src={witnessPlan.image} alt="The witness's signature" className="max-h-16 rounded border border-background-300 bg-white p-1" /> : null}
            <span className="text-xs text-foreground-500">Given with your first signature; it stays on the agreement.</span>
          </div> : <>
            <p className="text-sm text-foreground-600">Someone who watches you sign types their full name and draws their signature here. A typed signature is not accepted.</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <WizardTextField id="f04-witness-name" name={WITNESS_NAME_KEY} label="Witness full name" required={witnessRequired} value={a[WITNESS_NAME_KEY] ?? ""} maxLength={150} autoComplete="off"
                error={tried.has(REVIEW_STEP) && !witnessReady && witnessName.length < 2 ? "Enter your witness's full name." : undefined} onChange={(v) => set(WITNESS_NAME_KEY, v)} testId="f04-witness-name" />
            </div>
            <div>
              <p className="mb-2 text-label font-medium text-foreground-800">Witness signature (drawn){witnessRequired ? <span className="text-primary-600"> *</span> : null}</p>
              <SignaturePad onChange={setWitnessPng} />
            </div>
          </>}
        </div>
      </section>) : null;
    if (admin && review) return (
      <div className="space-y-6">
        {reviewSummary()}
        <section className="space-y-3 border-t border-background-200 pt-5" data-testid="f04-review-actions">
          <h3 className="text-sm font-semibold text-foreground-900">Your decision</h3>
          {flaggedKeys.length ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="f04-flag-list">
            <p className="font-medium">{flaggedKeys.length} answer{flaggedKeys.length === 1 ? "" : "s"} flagged for correction</p>
            <ul className="mt-1 list-disc pl-5 text-xs">{flaggedKeys.map((k) => <li key={k}><button type="button" className="cursor-pointer underline underline-offset-2" onClick={() => editStep(stepOfKey(k))}>{k.replaceAll("_", " ")}</button>{flags[k] ? `: ${flags[k]}` : ""}</li>)}</ul>
          </div> : <p className="text-sm text-foreground-600">Flag an answer (the flag next to it) to send the application back for correction, or approve it.</p>}
          <div>
            <WizardLabel htmlFor="f04-review-message" required={false}>Message to the agency (optional)</WizardLabel>
            <textarea id="f04-review-message" rows={3} maxLength={2000} value={review.message} onChange={(e) => review.onMessage(e.target.value)} className={WIZARD_INPUT} data-testid="f04-review-message"
              placeholder="Shown at the top of the corrected form" />
          </div>
          {review.warning ? <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="f04-review-referees-warning"><i className="ri-error-warning-line mr-1" aria-hidden="true" />{review.warning}</p> : null}
          {review.blocked ? <p className="text-sm text-foreground-600" data-testid="f04-review-blocked"><i className="ri-time-line mr-1" aria-hidden="true" />{review.blocked}</p> : null}
          {dirty ? <p className="text-sm text-amber-800">You have unsaved changes: save them first (they are kept as a new PDF revision, edited by SLIT staff).</p> : null}
        </section>
      </div>);
    return (
      <div className="space-y-6">
        {correcting && correction ? <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">Check your corrected answers, then tick the declaration and sign again.</p> : null}
        {reviewSummary()}
        {agreementSection}
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
            <p className="mb-2 text-label font-medium text-foreground-800">Your signature <span className="text-primary-600">*</span>{combined ? <span className="ml-1 font-normal text-foreground-600" data-testid="f04-sign-once">(one signature for the application form and the agent agreement)</span> : null}</p>
            <div role="tablist" className="mb-3 flex flex-wrap gap-2">{([["typed", "Type"], ["drawn", "Draw"]] as const).map(([id, label]) =>
              <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => { setMethod(id); setPicture(null); }} data-testid={`f04-signature-${id}`}
                className={`cursor-pointer rounded-full border px-4 py-2 text-sm font-medium ${method === id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50"}`}>{label}</button>)}</div>
            {method === "typed" ? <p className={`flex min-h-20 items-center rounded-md border border-background-300 bg-background-50 px-5 py-3 text-4xl text-[#0d1a4d] ${SCRIPT_FONT}`} data-testid="f04-typed-signature">
              {a.declarant_name || <span className="font-sans text-sm text-foreground-400">Your name appears here as your signature</span>}</p> : <SignaturePad onChange={setPicture} />}
          </div>
          {needPassword ? <div className="rounded-lg border border-primary-200 bg-primary-50/40 p-4" data-testid="f04-portal-password">
            <p className="text-label font-medium text-foreground-900">Create your agent portal password <span className="text-primary-600">*</span></p>
            <p className="mt-0.5 text-xs text-foreground-600">Once SLIT approves your business, sign in to the agent portal with your email{view.recipient?.email ? ` (${view.recipient.email})` : ""} and this password. If you already have a Skyline portal account, your current password stays.</p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-sm"><span className="mb-1 block text-xs font-semibold text-foreground-700">Password</span>
                <input type={showPw ? "text" : "password"} autoComplete="new-password" value={portalPw} maxLength={72} onChange={(e) => setPortalPw(e.target.value)}
                  className="w-full rounded-md border border-background-300 bg-white px-3 py-2" data-testid="f04-portal-password-1" /></label>
              <label className="block text-sm"><span className="mb-1 block text-xs font-semibold text-foreground-700">Confirm password</span>
                <input type={showPw ? "text" : "password"} autoComplete="new-password" value={portalPw2} maxLength={72} onChange={(e) => setPortalPw2(e.target.value)}
                  className="w-full rounded-md border border-background-300 bg-white px-3 py-2" data-testid="f04-portal-password-2" /></label>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <label className="flex items-center gap-1.5 text-foreground-700"><input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} />Show password</label>
              <span className={passwordProblem && (portalPw || portalPw2) ? "text-amber-800" : "text-foreground-500"}>{passwordProblem && (portalPw || portalPw2) ? passwordProblem : "At least 8 characters, with letters and a number."}</span>
            </div>
          </div> : null}
          <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" data-testid="f04-consent" /><span>{view.consent}<span className="text-primary-600"> *</span></span></label>
          {codeCheck.needed && !codeCheck.session ? codeCheck.render() : null}
        </section>
      </div>
    );
  })();

  const last = step === REVIEW_STEP;
  const stepNumber = order.indexOf(step) + 1;
  const reviewBusy = review?.busy ?? "";
  const changeCount = Object.keys(changes).length;
  const adminSave = admin && review ? (
    <button type="button" className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!dirty || !!reviewBusy} title={dirty ? `${changeCount} unsaved change${changeCount === 1 ? "" : "s"}` : "No unsaved changes"} onClick={() => void saveReview()} data-testid="f04-review-save">
      <i className="ri-save-line" aria-hidden="true" />{reviewBusy === "save" ? "Saving…" : "Save changes"}
      {dirty && reviewBusy !== "save" ? <span className="rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-900" data-testid="f04-review-dirty">{changeCount}</span> : null}</button>) : null;
  const adminButtons = admin && review ? (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <>
        <button type="button" className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-amber-400 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!Object.keys(flags).length || dirty || !!review.blocked || !!reviewBusy} onClick={review.onSendBack} data-testid="f04-review-send-back"><i className="ri-arrow-go-back-line" aria-hidden="true" />{reviewBusy === "back" ? "Sending…" : "Send back for correction"}</button>
        <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!!Object.keys(flags).length || dirty || !!review.blocked || !!reviewBusy} title={Object.keys(flags).length ? "Remove the flags, or send the application back" : undefined}
          onClick={review.onApprove} data-testid="f04-review-approve">{reviewBusy === "approve" ? "Approving…" : "Approve and activate agency"}<i className="ri-check-double-line" aria-hidden="true" /></button>
      </>
    </span>) : null;
  // The pre-send step: Save draft at any step; Send to point of contact on the last one (the dialog checks the terms and the witness).
  const prefillBusy = prefill?.busy ?? "";
  const prefillButtons = prefilling && prefill ? (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <button type="button" className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-background-300 bg-background-50 px-4 py-2 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!!prefillBusy} onClick={() => prefill.onSaveDraft(state)} data-testid="f04-prefill-save"><i className="ri-save-line" aria-hidden="true" />{prefillBusy === "save" ? "Saving…" : "Save draft"}</button>
      {last ? <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!!prefillBusy} onClick={() => prefill.onSend(state)} data-testid="f04-prefill-send">
        {prefillBusy === "send" ? "Sending…" : "Send to point of contact"}<i className="ri-mail-send-line" aria-hidden="true" /></button>
        : <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!!prefillBusy} onClick={next} data-testid="f04-next">{returnTo !== null ? "Back to review" : "Next"}<i className="ri-arrow-right-line" aria-hidden="true" /></button>}
    </span>) : null;
  const savedNote = saved === "saving" ? "Saving…" : saved === "saved" ? "Saved ✓" : saved === "error" ? "Not saved" : "";
  const saveLater = (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <button type="button" onClick={() => void save()} className="cursor-pointer text-sm font-semibold text-primary-700 underline-offset-2 hover:underline" data-testid="f04-save-later">
        {busy === "save" ? "Saving…" : "Save and continue later"}</button>
      {savedNote && busy !== "save" ? <span role="status" aria-live="polite" className={`text-xs ${saved === "error" ? "text-red-700" : "text-foreground-500"}`} data-testid="f04-saved">{savedNote}</span> : null}
    </span>);
  return (
    <div ref={top} className="scroll-mt-4" onKeyDown={onKey} onBlur={onBlurField}>
      <WizardShell variant={staff ? "modal" : "page"} stickyFooter={!staff} icon="ri-file-user-line" title={admin ? "Review application" : prefilling ? "Prepare the application" : correcting ? "Correct your application" : combined ? "Agent application and agreement" : "Agent application form"}
        onClose={admin ? review?.onClose : prefilling ? prefill?.onClose : undefined}
        subtitle={admin ? <>Agent application of <strong>{view.onboarding?.agencyName ?? "the agency"}</strong> · Review the application, then approve or send it back.</> : <>{prefilling ? `To ${prefill?.contact ? `${prefill.contact.name} (${prefill.contact.email})` : "the point of contact"}, for` : "For"} <strong>{view.onboarding?.agencyName ?? "your agency"}</strong> · step {stepNumber} of {order.length}: {STEPS[step].text}</>}
        stepper={<div data-testid="f04-stepper"><WizardStepper items={order.map((i) => ({ id: STEPS[i].id, short: STEPS[i].short, icon: STEPS[i].icon, done: i < furthest && Object.keys(allProblems[i]).length === 0 }))} current={order.indexOf(step)} onSelect={(n) => goTo(order[n])} /></div>}
        footerStart={admin ? adminSave : <>
          {order.indexOf(step) > 0 ? <WizardBackButton onClick={() => goTo(prevOf(step))} disabled={!!busy || !!reviewBusy} />
            // Step 1 of the staff pre-send (owner 2026-11-24: "allow me to go back too"): Back leaves the form for the business page.
            : prefilling && prefill?.onClose ? <WizardBackButton onClick={prefill.onClose} disabled={!!prefill.busy} /> : null}
          {prefilling ? (prefill?.savedNote ? <span className="text-xs text-foreground-500" data-testid="f04-prefill-saved">{prefill.savedNote}</span> : null) : <span className="hidden sm:inline-flex">{saveLater}</span>}
        </>}
        footerEnd={adminButtons ?? prefillButtons ?? <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {(last ? submitHint && !staff : gated && missing) && !busy ? <span className="max-w-[18rem] text-right text-xs text-foreground-600" role="status" aria-live="polite" data-testid="f04-next-hint">
            <i className="ri-information-line mr-1 text-amber-600" aria-hidden="true" />{last ? submitHint : missing}</span> : null}
          {last
          ? <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!canSubmit || !!busy} onClick={() => void submit()} data-testid="f04-submit">{busy === "sign" ? "Submitting…" : "Sign and submit"}<i className="ri-check-line" aria-hidden="true" /></button>
          : <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!!busy || (gated && !!missing)} onClick={next} data-testid="f04-next">{returnTo !== null ? "Back to review" : "Next"}<i className="ri-arrow-right-line" aria-hidden="true" /></button>}</span>}
        notices={<>
          {notice ? <WizardNotice tone={notice.tone}>{notice.text}</WizardNotice> : null}
        </>}>
        {correcting && correction ? <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="f04-correction-banner">
          <p className="font-semibold"><i className="ri-flag-2-fill mr-1" aria-hidden="true" />SLIT has asked you to correct {Object.keys(flags).length} answer{Object.keys(flags).length === 1 ? "" : "s"} (highlighted). Everything else stays as you signed it.</p>
          {correction.message ? <p className="mt-1 whitespace-pre-line" data-testid="f04-correction-message">{correction.message}</p> : null}
        </div> : null}
        {admin && step !== REVIEW_STEP ? <button type="button" onClick={() => { setReturnTo(null); show(REVIEW_STEP); }} className="mb-3 inline-flex cursor-pointer items-center gap-1 text-sm font-semibold text-primary-700 underline-offset-2 hover:underline" data-testid="f04-review-back-summary">
          <i className="ri-arrow-left-line" aria-hidden="true" />Back to Review and decide</button> : null}
        <h3 className="mb-4 font-heading text-base font-semibold text-foreground-950">{admin && step === REVIEW_STEP ? "Review and decide" : prefilling && step === REVIEW_STEP ? "Check and send" : STEPS[step].title}</h3>
        {body}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-500">
          <p><span className="text-primary-600">*</span> required</p>
          {staff ? null : <span className="sm:hidden">{saveLater}</span>}
        </div>
      </WizardShell>
    </div>
  );
}

/** After submit: a tick, what happens next, and the signed application to download (SigningDone, shared by every signing link). */
export function F04Done({ view, justSigned, fetchUrl }: { view: SigningView; justSigned: boolean; fetchUrl: () => Promise<string> }) {
  // 2026-11-20: the agreement was signed with the form; SLIT countersigns it on approval (no second signature).
  const steps: NextStep[] = [["ri-mail-send-line", "We've emailed your 2 referees"], ["ri-search-eye-line", "SLIT reviews"],
    ["ri-file-text-line", view.onboarding?.combined ? "You'll receive the countersigned agreement" : "You'll receive the agent agreement"]];
  return (
    <WizardShell variant="page" icon="ri-checkbox-circle-line" title="Application submitted" subtitle={view.onboarding?.agencyName ? `Agent application for ${view.onboarding.agencyName}` : "Agent application"}
      stepper={null} footerStart={null} footerEnd={null}>
      <SigningDone message={justSigned ? "Thank you. Your application has been submitted." : "This application has been signed and submitted."}
        testId={justSigned ? "f04-submitted" : "f04-already-submitted"} signedAt={view.signedAt} steps={steps} fetchUrl={fetchUrl} downloadTestId="f04-download" />
    </WizardShell>
  );
}
