import { useState, type ReactNode } from "react";
import ContactLinkFields from "@/components/shared/ContactLinkFields";
import { textableMobile } from "@/lib/textableMobile";
import StudentPicker, { type PickerRole } from "@/pages/agency/components/StudentPicker";
import type { StudentPick } from "@/pages/agency/lib/portalApplications";

export interface StudentDraft {
  student: StudentPick;
  invite: boolean;
  /** CONTACT-LINKS: the student's mobile (E.164, "" when none), saved on the application; the invitation also goes by text when sendText. */
  mobile?: string;
  sendText?: boolean;
}

/**
 * New application, first step (STUDENT-PICKER, owner 2026-11-27): pick the student (or add one from the picker's last row), then
 * choose who fills out the application and the mobile for the text message (prefilled from the student). Continue needs a student.
 */
export default function StudentDetailsStep({ initial, busy, error, onContinue, cancel, role, agency, profileId }: {
  initial?: StudentDraft;
  busy: boolean;
  error?: string;
  onContinue: (draft: StudentDraft) => void;
  cancel?: ReactNode;
  role: PickerRole;
  agency: { id: string; name: string } | null;
  profileId: string | null;
}) {
  const [student, setStudent] = useState<StudentPick | null>(initial?.student ?? null);
  const [invite, setInvite] = useState<boolean | undefined>(initial?.invite);
  const [mobile, setMobile] = useState(initial?.mobile ?? initial?.student.phone ?? "");
  const [sendText, setSendText] = useState(initial?.sendText ?? true);
  const [problem, setProblem] = useState("");

  const pick = (next: StudentPick | null) => {
    setStudent(next);
    setProblem("");
    // The mobile for the text message comes from the student chosen.
    setMobile(next && textableMobile(next.phone) ? next.phone : "");
  };

  return (
    <form noValidate data-testid="student-step" onSubmit={(event) => {
      event.preventDefault();
      if (busy || !student) return;
      if (invite === undefined) { setProblem("Choose who will fill out the application."); return; }
      if (mobile && !textableMobile(mobile)) { setProblem("Check the mobile number, or leave it empty."); return; }
      if (invite && !student.email) { setProblem("The student has no email address on record. Add it on the student's page first."); return; }
      onContinue({ student, invite, mobile: textableMobile(mobile) ? mobile : "", sendText: invite && sendText && textableMobile(mobile) });
    }}>
      <StudentPicker value={student} onChange={pick} role={role} agency={agency} profileId={profileId} disabled={busy} />
      <fieldset className="mt-5 space-y-2" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">Do you want the student to fill out the application?</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="invite" checked={invite === true} onChange={() => { setInvite(true); setProblem(""); }} /> Yes</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="invite" checked={invite === false} onChange={() => { setInvite(false); setProblem(""); }} /> No</label>
      </fieldset>
      {/* Keyed by the student: the phone box takes the picked student's mobile when it is drawn. */}
      <div className="mt-5" key={student?.id ?? "no-student"}>
        <ContactLinkFields id="student" mobile={mobile} onMobile={(value) => { setMobile(value); setProblem(""); }} locked={busy} who="the student"
          sendText={invite === true ? sendText : undefined} onSendText={invite === true ? setSendText : undefined} />
      </div>
      {error || problem ? <p role="alert" className="mt-4 text-sm text-red-800">{error || problem}</p> : null}
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        {cancel}
        <button type="submit" disabled={busy || !student} data-testid="student-continue"
          className="rounded-md bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {busy ? "Saving…" : invite === true ? "Save and send invitation" : "Continue"}
        </button>
      </div>
      {!student ? <p className="mt-2 text-right text-xs text-foreground-500">Choose a student to continue.</p> : null}
    </form>
  );
}
