import { useCallback, useState, type ReactNode } from "react";
import EmailField from "@/components/identity/EmailField";
import { normalizeEmail, type EmailAvailability, type EmailFieldContext } from "@/lib/identity/email";
import { findStudentByEmail, type StudentMatch } from "@/pages/agency/lib/portalApplications";
import { validateEmail } from "@/pages/agency/lib/userValidation";
import ContactLinkFields from "@/components/shared/ContactLinkFields";
import { textableMobile } from "@/lib/textableMobile";

export interface StudentDraft {
  email: string;
  invite: boolean;
  /** CONTACT-LINKS: the student's mobile (E.164, "" when none), saved on the application; the invitation also goes by text when sendText. */
  mobile?: string;
  sendText?: boolean;
}

export default function StudentDetailsStep({ initial, busy, error, onContinue, cancel, context = "portal", emailError }: {
  initial?: StudentDraft;
  busy: boolean;
  error?: string;
  onContinue: (draft: StudentDraft, existing: StudentMatch | null) => void;
  cancel?: ReactNode;
  context?: EmailFieldContext;
  emailError?: unknown;
}) {
  const [email, setEmail] = useState(initial?.email ?? "");
  const [invite, setInvite] = useState<boolean | undefined>(initial?.invite);
  const [mobile, setMobile] = useState(initial?.mobile ?? "");
  const [sendText, setSendText] = useState(initial?.sendText ?? true);
  const [checking, setChecking] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [problem, setProblem] = useState("");
  const [reuse, setReuse] = useState<{ id: string; fullName: string; email: string } | null>(null);
  const check = useCallback(async (value: string): Promise<EmailAvailability> => {
    const result = await findStudentByEmail(value);
    setReuse(result.status === "student" ? { ...result, email: value } : null);
    return result.status === "taken" ? { available: false, message: "A student with this email already exists." } : { available: true, message: null };
  }, []);

  return (
    <form noValidate onSubmit={async (event) => {
      event.preventDefault();
      if (busy || checking || blocking) return;
      const address = normalizeEmail(email);
      const issue = validateEmail(address);
      if (issue || invite === undefined) {
        setProblem(issue || "Choose who will fill out the application.");
        return;
      }
      if (mobile && !textableMobile(mobile)) { setProblem("Check the mobile number, or leave it empty."); return; }
      setChecking(true);
      setProblem("");
      try {
        const result = await findStudentByEmail(address);
        if (result.status === "taken") {
          setProblem("A student with this email already exists.");
          return;
        }
        onContinue({ email: address, invite, mobile: textableMobile(mobile) ? mobile : "", sendText: invite && sendText && textableMobile(mobile) }, result.status === "student" ? {
          id: result.id, name: result.fullName, email: address, phone: "", businessId: "", businessName: "",
          agentId: null, agentName: "", dateOfBirth: null, passportNumber: "", applications: 0,
          emailMatch: true, phoneMatch: false, passportMatch: false,
        } : null);
      } catch {
        setProblem("We could not check this email address. Try again.");
      } finally {
        setChecking(false);
      }
    }}>
      <label htmlFor="student-email" className="mb-1.5 block text-sm font-medium">Student email address</label>
      <EmailField id="student-email" name="email" required maxLength={254} autoFocus
        value={email} onChange={(value) => { setEmail(value); setProblem(""); }} kind="student"
        context={context} serverError={emailError} checker={check}
        onStatusChange={(_status, blocked) => setBlocking(blocked)} />
      {reuse?.email === normalizeEmail(email) && reuse ? <p className="mt-2 text-sm">Existing student record{reuse.fullName ? ` for ${reuse.fullName}` : ""}. Continue to use this record.</p> : null}
      <fieldset className="mt-5 space-y-2" disabled={busy || checking}>
        <legend className="mb-2 text-sm font-medium">Do you want the student to fill out the application?</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="invite" checked={invite === true} onChange={() => { setInvite(true); setProblem(""); }} /> Yes</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="invite" checked={invite === false} onChange={() => { setInvite(false); setProblem(""); }} /> No</label>
      </fieldset>
      <div className="mt-5">
        <ContactLinkFields id="student" mobile={mobile} onMobile={(value) => { setMobile(value); setProblem(""); }} locked={busy || checking} who="the student"
          sendText={invite === true ? sendText : undefined} onSendText={invite === true ? setSendText : undefined} />
      </div>
      {error || problem ? <p role="alert" className="mt-4 text-sm text-red-800">{error || problem}</p> : null}
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        {cancel}
        <button type="submit" disabled={busy || checking || blocking}
          className="rounded-md bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {busy || checking ? "Saving…" : invite === true ? "Save and send invitation" : "Continue"}
        </button>
      </div>
    </form>
  );
}
