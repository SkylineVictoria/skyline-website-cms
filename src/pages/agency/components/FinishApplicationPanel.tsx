import { useCallback, useEffect, useState } from "react";
import { Button } from "@/pages/admin/components/ui";
import { getWizardSummary, sendApplicationInvitation, type WizardSummary } from "@/pages/agency/lib/portalApplications";
import { WIZARD_STEPS, WIZARD_QUESTIONS } from "@/pages/agency/lib/wizardConfig";
import { validateEmail } from "@/pages/agency/lib/userValidation";
import { AgentHandoffPanel, StudentHandoffNotice } from "@/pages/agency/components/ApplicationHandoff";
import { useHandoff } from "@/pages/agency/lib/handoff";

export default function FinishApplicationPanel({ id, email, onContinue, canInvite }: {
  id: string;
  email: string;
  onContinue: () => void;
  canInvite: boolean;
}) {
  const [summary, setSummary] = useState<WizardSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [recipient, setRecipient] = useState(email);
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
      await sendApplicationInvitation(id, recipient.trim().toLowerCase() === email.trim().toLowerCase() ? undefined : recipient);
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
      {canInvite && handoff?.state === "change_requested" ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="handoff-change-note">
        The student asked for a change: “{handoff.changeNote}”. Make the change, then send it to the student again.</p> : null}
      {!open ? (
        <Button onClick={() => { if (canInvite) setOpen(true); else onContinue(); }}>{canInvite ? "Continue or send to student" : handoff?.state === "with_student" ? "Review and sign" : "Continue application"}</Button>
      ) : (
        <div className="space-y-3">
          {correcting || validateEmail(recipient) ? <label className="block space-y-1 text-sm">
            <span>Student email address</span>
            <input value={recipient} onChange={(event) => setRecipient(event.target.value)} type="email" maxLength={254}
              className="block w-full max-w-sm rounded-md border border-background-300 px-3 py-2" />
          </label> : null}
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
