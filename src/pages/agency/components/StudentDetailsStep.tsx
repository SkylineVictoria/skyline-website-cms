import { useCallback, useRef, useState, type ReactNode } from "react";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { Button, Modal } from "@/pages/admin/components/ui";
import { validateEmail } from "@/pages/agency/lib/userValidation";
import { findStudentByEmail, findStudents, type StudentEmailLookup, type StudentMatch } from "@/pages/agency/lib/portalApplications";
import EmailField from "@/components/identity/EmailField";
import { EMAIL_TAKEN_MESSAGE, normalizeEmail, type EmailAvailability, type EmailFieldContext } from "@/lib/identity/email";
import { parseStoredPhone, validateStoredPhone } from "../../../../supabase/functions/_shared/validation/identifiers";

/** What the first step collects. Name, date of birth and passport come from the passport upload in the wizard. */
export interface StudentDraft {
  fullName: string;
  email: string;
  mobile: string;
  dateOfBirth: string;
  passportNumber: string;
  /** Asked only by Students > Add student (no passport yet); the passport replaces them when read. */
  firstName?: string;
  lastName?: string;
  /** Email the student a sign-in invitation once their record is created (administrators only). */
  invite?: boolean;
}

const EMPTY: StudentDraft = { fullName: "", email: "", mobile: "", dateOfBirth: "", passportNumber: "" };
const INPUT = "w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";

/**
 * The student a new application is for: only their email and mobile, both unique. A student already on record with either
 * stops the step with a message; nothing is created. With `allowStudentWithoutApplication` (New application), one student
 * found by email or mobile is shown in a popup; once confirmed, the application continues for that student.
 *
 * The email (find_student_by_email, 20261113230000; email unique within the student role):
 *   free    -> a new student and the application, as before (an agent's or staff member's email is fine);
 *   student -> one the caller may start an application for: "A student with this email already exists: <name>" and
 *              "Add application to this student" (reuse it; never a second student). Add student refuses it instead;
 *   taken   -> another student the caller cannot see: the generic "already in use" message, Next disabled.
 */
export default function StudentDetailsStep({ initial, busy, error, submitLabel = "Next", onContinue, cancel, description, allowStudentWithoutApplication = false, askName = false, offerInvite = false, context = "portal", emailError }: {
  initial?: Partial<StudentDraft>;
  busy: boolean;
  error?: string;
  submitLabel?: string;
  /** The email and mobile typed and, when the student is already on record, that student. */
  onContinue: (draft: StudentDraft, existing: StudentMatch | null) => void;
  cancel?: ReactNode;
  description?: string;
  allowStudentWithoutApplication?: boolean;
  /** Also asks first and last name (both required). */
  askName?: boolean;
  /** Offers to email the student a sign-in invitation (ticked by default). */
  offerInvite?: boolean;
  /** admin = Admin CMS (sees which account holds an email); portal = agency portal. */
  context?: EmailFieldContext;
  /** The error from the last save; an email refusal shows under the email field. */
  emailError?: unknown;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<{ email?: string; mobile?: string; firstName?: string; lastName?: string }>({});
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  // The one student found by email or mobile, waiting for "Yes, this is the student".
  const [found, setFound] = useState<{ draft: StudentDraft; row: StudentMatch } | null>(null);
  const start = { ...EMPTY, ...initial };
  const [email, setEmail] = useState(start.email);
  const [emailBlocking, setEmailBlocking] = useState(false);
  const [lookup, setLookup] = useState<{ email: string; result: StudentEmailLookup } | null>(null);
  const typed = normalizeEmail(email);
  const known = lookup && lookup.email === typed ? lookup.result : null;
  // The student this application can reuse (New application only).
  const reuse = allowStudentWithoutApplication && known?.status === "student" ? known : null;
  const checkEmail = useCallback(async (value: string): Promise<EmailAvailability> => {
    const result = await findStudentByEmail(value);
    setLookup({ email: value, result });
    if (result.status === "taken" || (result.status === "student" && !allowStudentWithoutApplication)) return { available: false, message: EMAIL_TAKEN_MESSAGE };
    return { available: true, message: null };
  }, [allowStudentWithoutApplication]);
  const reuseMatch = (found: { id: string; fullName: string }): StudentMatch => ({
    id: found.id, name: found.fullName, email: typed, phone: "", dateOfBirth: null, passportNumber: "", businessId: "", businessName: "",
    agentId: null, agentName: "", applications: 0, emailMatch: true, phoneMatch: false, passportMatch: false,
  });

  const submit = async () => {
    if (emailBlocking) return;
    const data = new FormData(formRef.current ?? undefined);
    const draft: StudentDraft = { ...EMPTY, email: typed, mobile: String(data.get("mobile") ?? "").trim() };
    // Reuse: the application is for that student; their record (and mobile) stays as it is.
    if (reuse) { onContinue(draft, reuseMatch(reuse)); return; }
    if (offerInvite) draft.invite = data.get("invite") === "on";
    if (askName) {
      draft.firstName = String(data.get("firstName") ?? "").replace(/\s+/g, " ").trim();
      draft.lastName = String(data.get("lastName") ?? "").replace(/\s+/g, " ").trim();
      draft.fullName = [draft.firstName, draft.lastName].filter(Boolean).join(" ");
    }
    const next = {
      firstName: askName && !draft.firstName ? "Enter the student's first name." : undefined,
      lastName: askName && !draft.lastName ? "Enter the student's last name." : undefined,
      email: validateEmail(draft.email) ?? undefined,
      mobile: !draft.mobile.startsWith("+") || !parseStoredPhone(draft.mobile)?.national ? "Enter the student's mobile number." : validateStoredPhone(draft.mobile) || undefined,
    };
    setErrors(next);
    if (next.email || next.mobile || next.firstName || next.lastName) return;
    setChecking(true);
    setCheckError("");
    try {
      // Email and mobile are unique: one student, one application. A match stops here; nothing is created.
      const rows = await findStudents(draft.email, draft.mobile);
      if (rows.length === 0) { onContinue(draft, null); return; }
      const only = rows.length === 1 && !rows[0].taken ? rows[0] : null;
      if (allowStudentWithoutApplication && only) { setFound({ draft, row: only }); return; }
      const byEmail = rows.find((row) => !row.taken && row.emailMatch);
      const byMobile = rows.find((row) => !row.taken && row.phoneMatch);
      // Someone the caller may not see: nothing about them is shown. The email was checked above, so it is the mobile.
      const hidden = rows.some((row) => row.taken);
      const who = (row: StudentMatch) => (row.name ? ` (${row.name}, ${row.businessName})` : ` (${row.businessName})`);
      setErrors({
        email: byEmail ? `A student with this email already exists${who(byEmail)}.` : undefined,
        mobile: byMobile ? `A student with this mobile already exists${who(byMobile)}.` : hidden ? "A student with this mobile already exists." : undefined,
      });
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : "We could not check for an existing student.");
    } finally {
      setChecking(false);
    }
  };

  const waiting = busy || checking || emailBlocking;

  const notThisStudent = () => {
    if (!found) return;
    const { row } = found;
    const who = row.name ? ` (${row.name}, ${row.businessName})` : ` (${row.businessName})`;
    setErrors({
      email: row.emailMatch ? `A student with this email already exists${who}. Enter a different email.` : undefined,
      mobile: row.phoneMatch ? `A student with this mobile already exists${who}. Enter a different mobile.` : undefined,
    });
    setFound(null);
  };


  return (
    <form ref={formRef} noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}
      // A field's error goes as soon as it is edited; both are checked again on Next.
      onInput={(event) => {
        const name = (event.target as HTMLInputElement).name;
        if (name === "email" || name === "mobile" || name === "firstName" || name === "lastName") setErrors((prev) => (prev[name] ? { ...prev, [name]: undefined } : prev));
      }}>
      <h2 className="font-heading text-base font-semibold text-foreground-950">{askName ? "Student details" : "Student contact details"}</h2>
      <p className="mt-1.5 text-sm text-foreground-600">{description ?? (allowStudentWithoutApplication
        ? "Email and mobile only. A student already on record with either is shown so you can confirm it is them. The name and other details are read from the passport you upload next."
        : "Email and mobile only. Each must be new: a student already on record with either cannot be added again. The name and other details are read from the passport you upload next.")}</p>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {askName ? (
          <>
            <div>
              <label htmlFor="student-first-name" className="mb-1.5 block text-label font-medium text-foreground-800">First name <span className="text-primary-600">*</span></label>
              <input id="student-first-name" name="firstName" required autoFocus autoComplete="off" maxLength={100} defaultValue={start.firstName ?? ""} aria-invalid={Boolean(errors.firstName)} className={INPUT} />
              {errors.firstName ? <p className="mt-1 text-xs text-primary-800" role="alert">{errors.firstName}</p> : null}
            </div>
            <div>
              <label htmlFor="student-last-name" className="mb-1.5 block text-label font-medium text-foreground-800">Last name <span className="text-primary-600">*</span></label>
              <input id="student-last-name" name="lastName" required autoComplete="off" maxLength={100} defaultValue={start.lastName ?? ""} aria-invalid={Boolean(errors.lastName)} className={INPUT} />
              {errors.lastName ? <p className="mt-1 text-xs text-primary-800" role="alert">{errors.lastName}</p> : null}
            </div>
          </>
        ) : null}
        <div>
          <label htmlFor="student-email" className="mb-1.5 block text-label font-medium text-foreground-800">Email <span className="text-primary-600">*</span></label>
          <EmailField id="student-email" name="email" required autoFocus={!askName} autoComplete="off" maxLength={254} placeholder="student@example.com"
            value={email} onChange={setEmail} kind="student" context={context} savedEmail={initial?.email || null} serverError={emailError}
            checker={checkEmail} onStatusChange={(_status, blocking) => setEmailBlocking(blocking)} inputClassName={INPUT}
            availableNote={reuse ? (
              <div className="text-foreground-700" data-testid="student-email-reuse">
                <p>A student with this email already exists: <b className="text-foreground-950">{reuse.fullName || "name not read from a passport yet"}</b></p>
                <Button type="button" className="mt-1.5" disabled={busy} onClick={() => onContinue({ ...EMPTY, email: typed }, reuseMatch(reuse))}>Add application to this student</Button>
              </div>
            ) : undefined} />
          {errors.email ? <p className="mt-1 text-xs text-primary-800" role="alert">{errors.email}</p> : null}
        </div>
        <div>
          <label htmlFor="student-mobile" className="mb-1.5 block text-label font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></label>
          <PhoneInput id="student-mobile" name="mobile" value={start.mobile} required={!reuse} locked={Boolean(reuse)} placeholder="041 234 5678" />
          {reuse ? <p className="mt-1 text-xs text-foreground-500">Not needed: the application uses this student&apos;s record.</p> : null}
          {errors.mobile ? <p className="mt-1 text-xs text-primary-800" role="alert">{errors.mobile}</p> : null}
        </div>
      </div>

      <Modal open={Boolean(found)} title="Is this the student?" onClose={notThisStudent}
        footer={<>
          <Button type="button" variant="outline" onClick={notThisStudent}>No, a different student</Button>
          <Button type="button" onClick={() => { if (found) { const next = found; setFound(null); onContinue(next.draft, next.row); } }}>Yes, continue</Button>
        </>}>
        {found ? (
          <div className="text-sm text-foreground-700">
            <p>A student already on record has this {found.row.emailMatch && found.row.phoneMatch ? "email and mobile" : found.row.emailMatch ? "email" : "mobile"}:</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border border-background-200 bg-background-100 px-4 py-3">
              <dt className="text-foreground-500">Name</dt><dd className="font-semibold text-foreground-950">{found.row.name || "Not read from a passport yet"}</dd>
              <dt className="text-foreground-500">Email</dt><dd>{found.row.email || "None"}</dd>
              <dt className="text-foreground-500">Mobile</dt><dd>{found.row.phone || "None"}</dd>
              <dt className="text-foreground-500">Business</dt><dd>{found.row.businessName || "None"}</dd>
              {found.row.agentName ? <><dt className="text-foreground-500">Agent</dt><dd>{found.row.agentName}</dd></> : null}
              <dt className="text-foreground-500">Applications</dt><dd>{found.row.applications}</dd>
            </dl>
            <p className="mt-3">Choose <b>Yes</b> to start a new application for this student. Their record is kept, and the name is updated from the passport you upload next.</p>
          </div>
        ) : null}
      </Modal>

      {offerInvite ? (
        <label className="mt-4 flex items-start gap-2 text-sm text-foreground-800">
          <input type="checkbox" name="invite" className="mt-0.5" defaultChecked={initial?.invite ?? true} />
          <span>Email the student a sign-in invitation so they can see their application, upload documents and fill in the form themselves.</span>
        </label>
      ) : null}

      {error || checkError ? <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error || checkError}</p> : null}

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
        {cancel}
        <button type="submit" disabled={waiting}
          className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60 sm:ml-auto">
          {waiting ? <><i className="ri-loader-4-line animate-spin" aria-hidden="true" /> {checking ? "Checking…" : "Starting…"}</> : <>{submitLabel} <i className="ri-arrow-right-line" aria-hidden="true" /></>}
        </button>
      </div>
    </form>
  );
}
