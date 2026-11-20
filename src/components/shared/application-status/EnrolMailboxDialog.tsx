import { useState } from "react";
import ActionDrawer from "./ActionDrawer";
import { CreateEmailForm } from "@/pages/admin/components/CreateEmailSection";
import { logApplicationMailbox } from "@/pages/admin/lib/microsoft365";

/**
 * After "Mark as enrolled" (2026-11-21, owner): offers the student's Microsoft 365 mailbox with Email Management's own Create Email form
 * (Student, the CRM student profile linked to this application pre-selected and locked, the student licence, verified domains only,
 * the same checklist). The enrolment is already saved: nothing here can undo it. Skip for now (or closing without a mailbox) is logged on
 * the application; created / failed are logged by student-office365. Skipped and failed ones are listed in Email Management > Email
 * Accounts > Enrolled, no mailbox yet.
 */
export default function EnrolMailboxDialog({ applicationId, studentId, studentName, reference, onClose }: {
  applicationId: string;
  studentId: string | null;
  studentName: string;
  reference?: string;
  onClose: () => void;
}) {
  const [created, setCreated] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [closing, setClosing] = useState(false);

  const close = async () => {
    if (closing) return;
    // Nothing created and no failure already logged: the mailbox was skipped (best effort; enrolment is saved either way).
    if (!created && !failed && studentId) {
      setClosing(true);
      await logApplicationMailbox(applicationId, "skipped", { reason: "Skipped after Mark as enrolled" }).catch(() => undefined);
    }
    onClose();
  };

  return (
    <ActionDrawer wide title="Student email account" testId="enrol-mailbox-dialog" busy={closing} onClose={() => void close()}
      subtitle={<>{studentName || "The student"}{reference ? ` · ${reference}` : ""} is enrolled.</>}
      footer={<>
        <span className="mr-auto text-xs text-foreground-500">The enrolment is saved. Any mailbox not made now is listed in Email Management &gt; Email Accounts.</span>
        <button type="button" onClick={() => void close()} disabled={closing} data-testid="enrol-mailbox-close"
          className={created ? "h-9 cursor-pointer rounded-lg bg-primary-500 px-4 text-sm font-semibold text-white hover:bg-primary-600 disabled:opacity-60"
            : "h-9 cursor-pointer rounded-lg border border-background-300 px-4 text-sm font-medium text-foreground-800 hover:bg-background-100 disabled:opacity-60"}>
          {created ? "Done" : closing ? "Closing…" : "Skip for now"}
        </button>
      </>}>
      {studentId ? <>
        <p className="mb-4 text-sm text-foreground-700">Create their Microsoft 365 mailbox now, or skip and do it later. If anything below is not ready, skip: the enrolment is not affected.</p>
        <CreateEmailForm initialKind="student" personId={studentId} personQuery={studentName.slice(0, 80)} locked applicationId={applicationId}
          onCreated={(email) => setCreated(email)} onFailed={() => setFailed(true)} />
      </> : <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="enrol-mailbox-no-student">
        This application has no student profile linked, so no mailbox can be made from here. Link the student, then use Email Management &gt; Create Email.</p>}
    </ActionDrawer>
  );
}
