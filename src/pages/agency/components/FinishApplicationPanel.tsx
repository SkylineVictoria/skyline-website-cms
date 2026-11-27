import { useCallback, useEffect, useState } from "react";
import { Button } from "@/pages/admin/components/ui";
import { deleteDraftApplication, getWizardSummary, INVITE_SMS_LABEL, sendApplicationInvitation, type WizardSummary } from "@/pages/agency/lib/portalApplications";
import { WIZARD_STEPS, WIZARD_QUESTIONS } from "@/pages/agency/lib/wizardConfig";
import { validateEmail } from "@/pages/agency/lib/userValidation";
import { AgentHandoffPanel, StudentHandoffNotice } from "@/pages/agency/components/ApplicationHandoff";
import { useHandoff } from "@/pages/agency/lib/handoff";

export default function FinishApplicationPanel({ id, email, onContinue, canInvite, onDeleted }: {
  id: string;
  email: string;
  onContinue: () => void;
  canInvite: boolean;
  /** The draft was deleted (agents and SLIT admins; drafts only). */
  onDeleted?: (message: string) => void;
}) {
  const [summary, setSummary] = useState<WizardSummary | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [recipient, setRecipient] = useState(email);
  // INVITE-SMS: the link also goes by text message to the student's mobile (ClickSend), unless unticked.
  const [alsoText, setAlsoText] = useState(true);
  const [sentNote, setSentNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const removeDraft = async () => {
    setDeleting(true); setError("");
    try { await deleteDraftApplication(id); onDeleted?.("Application deleted."); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The application could not be deleted."); setConfirmDelete(false); }
    finally { setDeleting(false); }
  };
  // APPLICATION-STUDENT-SIGNS: the agent fills, then sends it to the student to review and sign (only the student signs).
  const { handoff, reload: reloadHandoff } = useHandoff(id);
  const refresh = useCallback(async () => { setSummary(await getWizardSummary(id)); await reloadHandoff(); }, [id, reloadHandoff]);

  useEffect(() => {
    let active = true;
    getWizardSummary(id).then((value) => { if (active) setSummary(value); })
      .catch((e: unknown) => { if (active) setError(`Application progress could not be loaded${e instanceof Error && e.message ? `: ${e.message}` : "."}`); });
    return () => { active = false; };
  }, [id]);

  const send = async () => {
    if (validateEmail(recipient)) {
      setError("Enter a valid student email address before sending.");
      setCorrecting(true);
      return;
    }
    setSending(true);
    setError("");
    try {
      const sms = await sendApplicationInvitation(id, recipient.trim().toLowerCase() === email.trim().toLowerCase() ? undefined : recipient, alsoText);
      setSentNote(["Sent by email.", INVITE_SMS_LABEL[sms]].filter(Boolean).join(" "));
      setCorrecting(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The invitation could not be sent.");
    } finally {
      await refresh().catch(() => setError("The invitation status could not be refreshed. Check it before resending."));
      setSending(false);
    }
  };

  const lastStep = [...WIZARD_STEPS, ...WIZARD_QUESTIONS].find((step) => step.id === summary?.lastStep)?.title;
  const withStudent = handoff?.state === "with_student" || handoff?.state === "waiting_guardian";
  if (canInvite && withStudent && handoff) return <AgentHandoffPanel applicationId={id} handoff={handoff} onChanged={() => void refresh()} />;
  if (!canInvite && handoff?.state && handoff.state !== "with_student") {
    return <StudentHandoffNotice applicationId={id} handoff={handoff} onChanged={() => void refresh()} />;
  }
  const resend = summary && ["Sent", "Resent", "Accepted", "Expired"].includes(summary.invitationStatus);
  const completion = summary ? Math.max(0, Math.min(100, Number(summary.completion) || 0)) : 0;
  // The agent sends it to the student only once every answer except the student's own declaration and signature is filled.
  // Until migration 20261127200517 runs (no agentComplete, or progress not loading) sending works as before.
  const readyToSend = summary ? summary.agentComplete ?? true : Boolean(error);
  const missing = summary?.agentMissing ?? 0;
  const emailBad = Boolean(validateEmail(recipient));
  const fact = (label: string, value: string) => (
    <div className="min-w-0"><dt className="text-2xs uppercase tracking-wide text-foreground-500">{label}</dt><dd className="truncate text-sm font-medium text-foreground-900">{value}</dd></div>
  );
  return (
    <section className="rounded-card border border-background-200 bg-background-50" data-testid="finish-application">
      <div className="border-b border-background-200 p-5">
        <h2 className="font-heading text-lg font-semibold">{canInvite ? "Application not yet signed" : "Your application"}</h2>
        <p className="mt-1 text-sm text-foreground-700">{canInvite
          ? "Fill in the application, then send it to the student to review and sign. Only the student (and a parent or guardian if they are under 18) can sign and submit it."
          : handoff?.state === "with_student" ? "Your agent has prepared your application. Check it, change what is yours to change, then read and sign the declarations to submit it."
          : "Complete your application, then read and sign the declarations to submit it."}</p>
      </div>

      <div className="space-y-4 p-5">
        <div data-testid="finish-progress">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold text-foreground-900">Progress</p>
            <p className="text-sm font-semibold text-foreground-900">{summary ? `${completion}%` : "…"}</p>
          </div>
          <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-background-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion}>
            <div className={`h-full rounded-full ${readyToSend ? "bg-emerald-500" : "bg-primary-500"}`} style={{ width: `${completion}%` }} />
          </div>
          {canInvite && summary ? (
            <p className={`mt-2 text-sm ${readyToSend ? "text-emerald-800" : "text-amber-900"}`}>
              {readyToSend ? "Everything is filled in. Send it to the student to review and sign."
                : `${missing ? `${missing} answer${missing === 1 ? "" : "s"} still to fill in` : "Some answers are still to fill in"} before it can go to the student.`}
            </p>
          ) : null}
        </div>

        {summary ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md bg-background-100 p-3 sm:grid-cols-4">
            {fact("Status", summary.status)}
            {fact("Last saved", summary.lastSaved ? new Date(summary.lastSaved).toLocaleString() : "—")}
            {fact(lastStep ? "Last step" : "Updated by", (lastStep || summary.updatedBy) || "—")}
            {canInvite ? fact("Sent to student", sending ? "Sending…" : summary.invitationStatus) : fact("Updated by", summary.updatedBy || "—")}
          </dl>
        ) : null}

        {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
        {sentNote ? <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800" data-testid="invite-sent-note">{sentNote}</p> : null}
        {canInvite && handoff?.state === "change_requested" ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="handoff-change-note">
          The student asked for a change: “{handoff.changeNote}”. Make the change, then send it to the student again.</p> : null}

        {canInvite && (emailBad || correcting) ? (
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Student email address</span>
            <input value={recipient} onChange={(event) => setRecipient(event.target.value)} type="email" maxLength={254}
              className="block w-full max-w-sm rounded-md border border-background-300 px-3 py-2" />
          </label>
        ) : null}

        {canInvite && onDeleted && confirmDelete ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" data-testid="delete-draft-confirm">
            <span>Delete this application and its documents? This cannot be undone.</span>
            <Button variant="outline" disabled={deleting} onClick={() => setConfirmDelete(false)}>Keep it</Button>
            <button type="button" disabled={deleting} onClick={() => void removeDraft()}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">{deleting ? "Deleting…" : "Delete application"}</button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-background-200 p-5">
        <Button onClick={onContinue}>{canInvite ? (completion > 0 ? "Continue filling in" : "Start filling in")
          : handoff?.state === "with_student" ? "Review and sign" : "Continue application"}</Button>
        {canInvite ? (
          <>
            <Button variant="outline" disabled={sending || !readyToSend} onClick={() => void send()} data-testid="send-to-student"
              title={readyToSend ? undefined : "Fill in the whole application first"}>
              <i className={resend ? "ri-refresh-line" : "ri-send-plane-line"} aria-hidden="true" />
              {sending ? "Sending…" : resend ? "Resend to student" : "Send to student to review & sign"}
            </Button>
            {readyToSend ? (
              <label className="flex items-center gap-2 text-sm text-foreground-700">
                <input type="checkbox" checked={alsoText} onChange={(event) => setAlsoText(event.target.checked)} className="h-4 w-4" data-testid="invite-also-text" />
                Also send the link by text message to the student's mobile
              </label>
            ) : null}
            {onDeleted && !confirmDelete ? (
              <button type="button" onClick={() => setConfirmDelete(true)} data-testid="delete-draft"
                className="ml-auto inline-flex items-center gap-1.5 text-sm font-semibold text-red-700 hover:underline"><i className="ri-delete-bin-line" aria-hidden="true" /> Delete application</button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
