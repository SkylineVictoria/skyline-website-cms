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
  const [open, setOpen] = useState(false);
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
      .catch(() => { if (active) setError("Application progress could not be loaded."); });
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
  return (
    <section className="space-y-4 rounded-card border border-background-200 bg-background-50 p-5">
      <div>
        <h2 className="font-heading text-lg font-semibold">{canInvite ? "Application not yet signed" : "Your application"}</h2>
        <p className="mt-1 text-sm text-foreground-700">{canInvite
          ? "Fill in as much as you can, then send it to the student to review and sign. Only the student (and a parent or guardian if they are under 18) can sign and submit it."
          : handoff?.state === "with_student" ? "Your agent has prepared your application. Check it, change what is yours to change, then read and sign the declarations to submit it."
          : "Complete your application, then read and sign the declarations to submit it."}</p>
      </div>
      {summary ? (
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-foreground-500">Application status</dt><dd>{summary.status}</dd></div>
          <div><dt className="text-foreground-500">Completion</dt><dd>{summary.completion}%</dd></div>
          <div><dt className="text-foreground-500">Last saved</dt><dd>{summary.lastSaved ? new Date(summary.lastSaved).toLocaleString() : "—"}</dd></div>
          <div><dt className="text-foreground-500">Last step</dt><dd>{lastStep || "—"}</dd></div>
          <div><dt className="text-foreground-500">Last updated by</dt><dd>{summary.updatedBy || "—"}</dd></div>
          {canInvite ? <div><dt className="text-foreground-500">Invitation</dt><dd>{sending ? "Sending" : summary.invitationStatus}</dd></div> : null}
        </dl>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
      {sentNote ? <p role="status" className="text-sm text-emerald-800" data-testid="invite-sent-note">{sentNote}</p> : null}
      {canInvite && handoff?.state === "change_requested" ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="handoff-change-note">
        The student asked for a change: “{handoff.changeNote}”. Make the change, then send it to the student again.</p> : null}
      {canInvite && onDeleted ? (confirmDelete ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" data-testid="delete-draft-confirm">
          <span>Delete this application and its documents? This cannot be undone.</span>
          <Button variant="outline" disabled={deleting} onClick={() => setConfirmDelete(false)}>Keep it</Button>
          <button type="button" disabled={deleting} onClick={() => void removeDraft()}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">{deleting ? "Deleting…" : "Delete application"}</button>
        </div>
      ) : null) : null}
      {!open ? (
        <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => { if (canInvite) setOpen(true); else onContinue(); }}>{canInvite ? "Continue or send to student" : handoff?.state === "with_student" ? "Review and sign" : "Continue application"}</Button>
        {canInvite && onDeleted && !confirmDelete ? (
          <button type="button" onClick={() => setConfirmDelete(true)} data-testid="delete-draft"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-700 hover:underline"><i className="ri-delete-bin-line" aria-hidden="true" /> Delete application</button>
        ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {correcting || validateEmail(recipient) ? <label className="block space-y-1 text-sm">
            <span>Student email address</span>
            <input value={recipient} onChange={(event) => setRecipient(event.target.value)} type="email" maxLength={254}
              className="block w-full max-w-sm rounded-md border border-background-300 px-3 py-2" />
          </label> : null}
          <label className="flex items-center gap-2 text-sm text-foreground-700">
            <input type="checkbox" checked={alsoText} onChange={(event) => setAlsoText(event.target.checked)} className="h-4 w-4" data-testid="invite-also-text" />
            Also send the link by text message to the student's mobile
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onContinue}>Continue filling in</Button>
            {!correcting && !validateEmail(recipient) ? <Button variant="ghost" disabled={sending} onClick={() => setCorrecting(true)}>Correct student email</Button> : null}
            <Button variant="outline" disabled={sending} onClick={() => void send()}>
              {sending ? "Sending…" : resend && handoff?.state === "with_student" ? "Resend link" : "Send to student to review & sign"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
