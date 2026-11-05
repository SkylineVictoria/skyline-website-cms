import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { ApplyQuestion } from "@/pages/login/CompleteSignUp";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { PhoneInput } from "@/components/feature/applicationInputs";
import QuickSignIn from "@/pages/login/QuickSignIn";
import AgentBusinessStep, { type ChosenBusiness } from "@/pages/login/AgentBusinessStep";
import ContactConflictPopup from "@/pages/login/ContactConflictPopup";
import { isContactConflict } from "@/lib/enrolForm";
import { rememberSignUpBusiness } from "@/lib/authProviders";
import {
  EMPTY_AGENT_ENROL, EMPTY_STUDENT_ENROL, abnProblem, formatAbn, validateAgentEnrol, validateStudentEnrol,
  type AgentEnrolForm, type EnrolErrors, type EnrolKind, type StudentEnrolForm,
} from "@/lib/enrolForm";
import { enrolAgent, enrolStudent, lookupAbn, type AbnDetails, type EnrolResult } from "@/lib/selfEnrol";
import { requestStaffCode, verifyStaffCode } from "@/lib/staffApi";
import { toE164 } from "@/lib/staffPhone";

type Step = 1 | 2 | 3;

/**
 * "Enroll now" on the sign-in page: who you are (step 1), your details (step 2), what happens next (step 3).
 * A student is enrolled at once and emailed a password link; an agent's business waits for SLIT's review; staff are
 * invite-only and are pointed back to their invitation email. Nothing here grants access: the password link and the
 * review are what let someone in.
 */
export default function EnrolWizard({ initialKind, onSignIn, onSignedIn }: { initialKind: EnrolKind | null; onSignIn: () => void; onSignedIn: (userId: string) => void }) {
  const [kind, setKind] = useState<EnrolKind>(initialKind ?? "student");
  // Everyone starts on "Who are you enrolling as?"; a link from the Enrol Now page only pre-selects Student or Agent.
  const [step, setStep] = useState<Step>(1);
  const [result, setResult] = useState<EnrolResult | null>(null);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => { top.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [step]);

  const done = (r: EnrolResult) => { setResult(r); setStep(3); };

  return (
    <div ref={top}>
      {step === 1 ? <KindStep kind={kind} onChange={setKind} onContinue={() => setStep(2)} onSignIn={onSignIn} /> : null}
      {step === 2 && kind === "student" ? <StudentStep onBack={() => setStep(1)} onDone={done} onSignedIn={onSignedIn} /> : null}
      {step === 2 && kind === "agent" ? <AgentStep onBack={() => setStep(1)} onDone={done} onSignedIn={onSignedIn} /> : null}
      {step === 2 && kind === "staff" ? <StaffStep onBack={() => setStep(1)} /> : null}
      {step === 3 && result ? <DoneStep result={result} onSignIn={onSignIn} /> : null}
    </div>
  );
}

function Progress({ step }: { step: Step }) {
  return (
    <div className="mt-4 flex gap-1.5" aria-hidden="true">
      {[1, 2, 3].map((n) => <span key={n} className={`h-1 flex-1 rounded-full ${n <= step ? "bg-primary-500" : "bg-background-300"}`} />)}
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">{children}</p>;
}

/* ----------------------------------------------------------------- step 1 */

const KINDS: Array<{ id: EnrolKind; icon: string; title: string; note?: string; text: string }> = [
  { id: "student", icon: "ri-graduation-cap-line", title: "Student", text: "Apply for a course and track your enrolment." },
  { id: "agent", icon: "ri-briefcase-4-line", title: "Agent", note: "Needs approval", text: "Refer and manage students for your agency." },
  { id: "staff", icon: "ri-user-3-line", title: "Staff", note: "Needs approval", text: "Apply for a staff account. An administrator reviews your application." },
];

function KindStep({ kind, onChange, onContinue, onSignIn }: { kind: EnrolKind; onChange: (k: EnrolKind) => void; onContinue: () => void; onSignIn: () => void }) {
  return (
    <div>
      <Eyebrow>Step 1 of 3</Eyebrow>
      <h2 className="mt-1 font-heading text-2xl font-bold text-foreground-950">Who are you enrolling as?</h2>
      <Progress step={1} />
      <div role="radiogroup" aria-label="Account type" className="mt-6 space-y-3">
        {KINDS.map((item) => {
          const selected = item.id === kind;
          return (
            <button key={item.id} type="button" role="radio" aria-checked={selected} onClick={() => onChange(item.id)}
              className={`flex w-full cursor-pointer items-start gap-3 rounded-lg border p-4 text-left transition-colors ${selected ? "border-primary-500 bg-primary-50 ring-1 ring-primary-500" : "border-background-300 bg-background-50 hover:border-primary-300"}`}>
              <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl ${selected ? "bg-primary-500 text-background-50" : "bg-background-100 text-foreground-700"}`}>
                <i className={item.icon} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-heading text-base font-semibold text-foreground-950">{item.title}</span>
                  {item.note ? <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.id === "agent" ? "bg-amber-50 text-amber-900" : "bg-background-200 text-foreground-700"}`}>{item.note}</span> : null}
                </span>
                <span className="mt-0.5 block text-sm text-foreground-600">{item.text}</span>
              </span>
              <span className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${selected ? "border-primary-500" : "border-background-400"}`} aria-hidden="true">
                {selected ? <span className="h-2.5 w-2.5 rounded-full bg-primary-500" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      {kind === "staff" ? (
        <div className="mt-5 rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2.5 text-[13px] text-secondary-900" role="status">
          An administrator reviews every staff application. Already invited? Open the link in the invitation email to set your password, then sign in.
        </div>
      ) : null}
      <Button type="button" className="mt-6 w-full" onClick={onContinue}>Continue</Button>
      <p className="mt-5 text-center text-sm text-foreground-600">
        Already have an account? <button type="button" onClick={onSignIn} className="cursor-pointer font-semibold text-primary-700 hover:text-primary-800">Sign in</button>
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- shared form bits */

function Problem({ text }: { text?: string }) {
  return text ? <span className="mt-1 block text-xs text-primary-700" role="alert">{text}</span> : null;
}

function Agree({ checked, onChange, error }: { checked: boolean; onChange: (v: boolean) => void; error?: string }) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-700">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-background-400 text-primary-600 focus:ring-primary-200" />
        <span>I agree to the <Link to="/forms-policies" target="_blank" rel="noopener" className="font-medium text-primary-700 hover:underline">terms</Link> and <Link to="/forms-policies" target="_blank" rel="noopener" className="font-medium text-primary-700 hover:underline">privacy policy</Link>.</span>
      </label>
      <Problem text={error} />
    </div>
  );
}

function StepHeader({ step, kind, title, onBack }: { step: Step; kind: string; title: string; onBack: () => void }) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <button type="button" onClick={onBack} aria-label="Back" className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-background-300 text-foreground-700 hover:bg-background-100">
          <i className="ri-arrow-left-s-line text-xl" aria-hidden="true" />
        </button>
        <div>
          <Eyebrow>Step {step} of 3 · {kind}</Eyebrow>
          <h2 className="mt-0.5 font-heading text-2xl font-bold text-foreground-950">{title}</h2>
        </div>
      </div>
      <Progress step={step} />
    </div>
  );
}

function FormError({ text }: { text?: string }) {
  return text ? (
    <div className="flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-[13px] text-primary-900" role="alert">
      <i className="ri-error-warning-line mt-0.5 text-base" aria-hidden="true" /><span>{text}</span>
    </div>
  ) : null;
}

/* ----------------------------------------------------------------- step 2: student */

function StudentStep({ onBack, onDone, onSignedIn }: { onBack: () => void; onDone: (r: EnrolResult) => void; onSignedIn: (userId: string) => void }) {
  const [form, setForm] = useState<StudentEnrolForm>(EMPTY_STUDENT_ENROL);
  const [errors, setErrors] = useState<EnrolErrors<StudentEnrolForm>>({});
  const [busy, setBusy] = useState(false);
  const [website, setWebsite] = useState("");
  const [readyUser, setReadyUser] = useState("");
  const navigate = useNavigate();
  const patch = (next: Partial<StudentEnrolForm>) => setForm((prev) => ({ ...prev, ...next }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    // The phone field keeps its value (E.164, with the country code) in a hidden input named "mobile".
    const current = { ...form, mobile: String(new FormData(event.currentTarget).get("mobile") ?? "") };
    setForm(current);
    const checked = validateStudentEnrol(current);
    setErrors(checked);
    if (Object.keys(checked).length) return;
    setBusy(true);
    try {
      const result = await enrolStudent(current, website);
      if (!result.signIn) { onDone(result); return; }
      // A new student: their account is ready, so sign them in and go on to "Do you want to apply at SLIT?".
      const { data, error } = await supabase.auth.signInWithPassword({ email: current.email.trim().toLowerCase(), password: current.password });
      if (error || !data.user) { onDone({ ...result, warning: "Your account is ready. Sign in with your email and password to start your application." }); return; }
      // Takes up the student's waiting invitation, so the portal opens as theirs.
      await supabase.rpc("portal_resolve_access").then(() => undefined, () => undefined);
      setReadyUser(data.user.id);
    }
    catch (e) { setErrors({ form: e instanceof Error ? e.message : "We could not complete your enrolment. Please try again." }); }
    finally { setBusy(false); }
  };

  if (readyUser) {
    return <ApplyQuestion onAnswer={(apply) => { if (apply) navigate("/agency/applications/new", { replace: true }); else onSignedIn(readyUser); }} />;
  }

  return (
    <form onSubmit={submit} noValidate>
      <StepHeader step={2} kind="Student" title="Your details" onBack={onBack} />
      <QuickStart onSignedIn={onSignedIn} intent="student" />
      <div className="mt-6 space-y-4">
        <Field label="Email" required><TextInput type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} placeholder="you@example.com" autoComplete="email" /><Problem text={errors.email} /></Field>
        <div>
          <label htmlFor="enrol-mobile" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></label>
          <PhoneInput id="enrol-mobile" name="mobile" value={form.mobile} required placeholder="041 234 5678" />
          <Problem text={errors.mobile} />
        </div>
        <Field label="Password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters. You sign in with your email and this password.`}>
          <TextInput type="password" value={form.password} onChange={(e) => patch({ password: e.target.value })} autoComplete="new-password" /><Problem text={errors.password} />
        </Field>
        <p className="text-xs text-foreground-500">Your name and other details come from your passport when you apply.</p>
        {/* Honeypot: hidden from people, filled by bots. */}
        <div className="hidden" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label></div>
        <Agree checked={form.agreed} onChange={(agreed) => patch({ agreed })} error={errors.agreed} />
        <FormError text={errors.form} />
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Creating your account…" : "Create student account"}</Button>
      </div>
    </form>
  );
}

/** Google / Facebook / phone above the student form; hidden entirely when none of them is switched on. */
function QuickStart({ onSignedIn, intent }: { onSignedIn: (userId: string) => void; intent: "student" | "agent" }) {
  return (
    <div className="mt-6">
      <QuickSignIn create intent={intent} onSignedIn={onSignedIn} />
      <div className="mt-5 flex items-center gap-3 text-xs text-foreground-500" aria-hidden="true">
        <span className="h-px flex-1 bg-background-300" />or fill in your details<span className="h-px flex-1 bg-background-300" />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- step 2: agent */

function AgentStep({ onBack, onDone, onSignedIn }: { onBack: () => void; onDone: (r: EnrolResult) => void; onSignedIn: (userId: string) => void }) {
  // First the business (ABN Lookup, confirmed by the agent), then how they sign up: Google / Facebook / phone or company email.
  const [business, setBusiness] = useState<ChosenBusiness | null>(null);
  const [conflict, setConflict] = useState("");
  const [form, setForm] = useState<AgentEnrolForm>(EMPTY_AGENT_ENROL);
  const [errors, setErrors] = useState<EnrolErrors<AgentEnrolForm>>({});
  const [busy, setBusy] = useState(false);
  const [website, setWebsite] = useState("");
  const patch = (next: Partial<AgentEnrolForm>) => setForm((prev) => ({ ...prev, ...next }));

  const choose = (chosen: ChosenBusiness) => {
    setBusiness(chosen);
    setForm((prev) => ({ ...prev, abn: formatAbn(chosen.abn), businessName: chosen.businessName }));
    rememberSignUpBusiness({ abn: chosen.abn, businessName: chosen.businessName, looked: Boolean(chosen.details) });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !business) return;
    // The phone field keeps its value (E.164, with the country code) in a hidden input named "phone".
    const current = { ...form, abn: formatAbn(business.abn), businessName: business.businessName, phone: String(new FormData(event.currentTarget).get("phone") ?? "") };
    setForm(current);
    const checked = validateAgentEnrol(current);
    setErrors(checked);
    if (Object.keys(checked).length) return;
    setBusy(true);
    try { const result = await enrolAgent(current, website); rememberSignUpBusiness(null); onDone(result); }
    catch (e) {
      const message = e instanceof Error ? e.message : "We could not submit your application. Please try again.";
      if (isContactConflict(message)) {
        setConflict(message);
        setErrors({ email: /email/i.test(message) ? "Already linked to another company." : undefined, phone: /phone/i.test(message) ? "Already linked to another company." : undefined });
      } else setErrors({ form: message });
    }
    finally { setBusy(false); }
  };

  if (!business) {
    return (
      <div>
        <StepHeader step={2} kind="Agent" title="Let's find your business" onBack={onBack} />
        <div className="mt-5"><AgentBusinessStep initial={null} onChosen={choose} /></div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <StepHeader step={2} kind="Agent" title="Create your agent account" onBack={() => setBusiness(null)} />
      <div className="mt-5 flex items-start justify-between gap-3 rounded-lg border border-background-300 bg-background-50 p-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
            <i className={business.details ? "ri-check-line" : "ri-edit-line"} aria-hidden="true" /> {business.details ? "From ABN Lookup" : "Entered by you"}
          </p>
          <p className="mt-0.5 truncate font-semibold text-foreground-900">{business.businessName}</p>
          <p className="text-xs text-foreground-600">ABN {formatAbn(business.abn)}{business.details?.state ? ` · ${business.details.state} ${business.details.postcode}` : ""}</p>
        </div>
        <button type="button" onClick={() => setBusiness(null)} className="shrink-0 cursor-pointer text-sm font-medium text-primary-700 hover:text-primary-800">Change</button>
      </div>
      <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900" role="status">
        <i className="ri-error-warning-line mt-0.5 text-base" aria-hidden="true" /><span>Agent accounts are reviewed by our team before you can sign in.</span>
      </div>
      <div className="mt-5">
        <QuickSignIn create intent="agent" onSignedIn={onSignedIn} />
        <div className="mt-5 flex items-center gap-3 text-xs text-foreground-500" aria-hidden="true">
          <span className="h-px flex-1 bg-background-300" />or use your company email<span className="h-px flex-1 bg-background-300" />
        </div>
      </div>
      <div className="mt-5 space-y-4">
        <Field label="Contact person" required><TextInput value={form.contactName} onChange={(e) => patch({ contactName: e.target.value })} autoComplete="name" /><Problem text={errors.contactName} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Work email" required><TextInput type="email" value={form.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="email" /><Problem text={errors.email} /></Field>
          <div>
            <label htmlFor="agent-enrol-phone" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Phone <span className="text-primary-600">*</span></label>
            <PhoneInput id="agent-enrol-phone" name="phone" value={form.phone} required placeholder="041 234 5678" />
            <Problem text={errors.phone} />
          </div>
        </div>
        <p className="text-xs text-foreground-500">We email you a link to choose your password. You become the administrator of your agency's workspace once SLIT approves it.</p>
        <div className="hidden" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label></div>
        <Agree checked={form.agreed} onChange={(agreed) => patch({ agreed })} error={errors.agreed} />
        {errors.abn || errors.businessName ? <FormError text={errors.abn || errors.businessName} /> : null}
        <FormError text={errors.form} />
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Submitting…" : "Submit application"}</Button>
      </div>
      <ContactConflictPopup message={conflict} onClose={() => setConflict("")} />
    </form>
  );
}

/* ----------------------------------------------------------------- step 3 */

function DoneStep({ result, onSignIn }: { result: EnrolResult; onSignIn: () => void }) {
  const agent = result.kind === "agent";
  const title = agent ? "Application received" : "Check your email";
  const text = result.existingIdentity
    ? "This email already has a password. Sign in with it and your enrolment is linked to your account automatically."
    : result.warning
      ? result.warning
      : agent
        ? "Your application has been received and our team is looking into it. We will get back to you."
        : "We've sent you a link to choose your password. Open it and set your password; then you can start your application at SLIT.";
  return (
    <div className="text-center">
      <Progress step={3} />
      <span className="mx-auto mt-8 flex h-20 w-20 items-center justify-center rounded-full bg-primary-50 text-4xl text-primary-600">
        <i className={agent ? "ri-time-line" : "ri-mail-check-line"} aria-hidden="true" />
      </span>
      <Eyebrow><span className="mt-5 block">Step 3 of 3</span></Eyebrow>
      <h2 className="mt-1 font-heading text-2xl font-bold text-foreground-950">{title}</h2>
      <p className="mx-auto mt-3 max-w-sm text-sm text-foreground-600">{text}</p>
      <dl className="mt-6 space-y-2 rounded-lg border border-background-200 bg-background-50 p-4 text-left text-sm">
        <div className="flex justify-between gap-3"><dt className="text-foreground-500">Account type</dt><dd className="font-semibold text-foreground-900">{agent ? "Agent" : "Student"}</dd></div>
        {result.businessName ? <div className="flex justify-between gap-3"><dt className="text-foreground-500">Business</dt><dd className="font-semibold text-foreground-900">{result.businessName}</dd></div> : null}
        <div className="flex justify-between gap-3"><dt className="text-foreground-500">Status</dt>
          <dd><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${agent ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-800"}`}>{agent ? "Pending review" : result.emailSent ? "Email sent" : "Ready to sign in"}</span></dd>
        </div>
      </dl>
      <Button type="button" variant="outline" className="mt-6 w-full" onClick={onSignIn}>Back to sign in</Button>
    </div>
  );
}

/* ----------------------------------------------------------------- step 2: staff */

/**
 * Staff apply for an account ("Needs approval", like agents). Email and mobile first: the staff-register function checks them
 * against existing staff, students, agents and admins BEFORE it emails the code, and answers a clash with one neutral message.
 * The code (or the emailed link) verifies the email; /staff/apply then sets the password and starts the draft. No SMS is sent.
 */
function StaffStep({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [website, setWebsite] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<{ email?: string; phone?: string; agreed?: string; code?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const mobile = String(new FormData(event.currentTarget).get("staff-mobile") ?? "");
    setPhone(mobile);
    const next: typeof errors = {};
    if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(email.trim())) next.email = "Enter a valid email address.";
    if (!toE164(mobile)) next.phone = "Enter your mobile number with its country code.";
    if (!agreed) next.agreed = "Please agree to the terms and privacy policy.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try { await requestStaffCode(email.trim().toLowerCase(), toE164(mobile)!, agreed, website); setSent(true); }
    catch (e) {
      const field = (e as { field?: string }).field;
      const message = e instanceof Error ? e.message : "We could not send the email. Please try again.";
      setErrors(field === "email" || field === "phone" ? { [field]: message } : { form: message });
    }
    finally { setBusy(false); }
  };

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6,8}$/.test(code.trim())) { setErrors({ code: "Enter the code from the email." }); return; }
    setBusy(true);
    try { await verifyStaffCode(email, code); navigate("/staff/apply", { replace: true }); }
    catch (e) { setErrors({ code: e instanceof Error ? e.message : "That code is not right." }); }
    finally { setBusy(false); }
  };

  if (sent) {
    return (
      <form onSubmit={verify} noValidate>
        <StepHeader step={3} kind="Staff" title="Check your email" onBack={() => { setSent(false); setCode(""); setErrors({}); }} />
        <div className="mt-6 space-y-4">
          <p className="text-sm text-foreground-700" role="status">We emailed <strong>{email.trim().toLowerCase()}</strong>. Open the link in that email, or type the code it shows. The link and the code work once and expire.</p>
          <Field label="Code from the email"><TextInput inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" /><Problem text={errors.code} /></Field>
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Checking…" : "Verify email"}</Button>
          <button type="button" className="w-full cursor-pointer text-center text-sm font-semibold text-primary-700 hover:text-primary-800" disabled={busy}
            onClick={() => { setBusy(true); void requestStaffCode(email.trim().toLowerCase(), toE164(phone)!, agreed).then(() => setErrors({}), (e) => setErrors({ code: e instanceof Error ? e.message : "We could not send the email." })).finally(() => setBusy(false)); }}>
            Send a new code
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={send} noValidate>
      <StepHeader step={2} kind="Staff" title="Your details" onBack={onBack} />
      <div className="mt-6 space-y-4">
        <Field label="Email" required><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" /><Problem text={errors.email} /></Field>
        <div>
          <label htmlFor="staff-mobile" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></label>
          <PhoneInput id="staff-mobile" name="staff-mobile" value={phone} required placeholder="041 234 5678" />
          <Problem text={errors.phone} />
        </div>
        <p className="text-xs text-foreground-500">We email you a code to confirm your address. Your name, date of birth and documents come next.</p>
        <div className="hidden" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label></div>
        <Agree checked={agreed} onChange={setAgreed} error={errors.agreed} />
        <FormError text={errors.form} />
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Checking…" : "Email me a code"}</Button>
      </div>
    </form>
  );
}
