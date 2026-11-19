import { useCallback, useEffect, useMemo, useState } from "react";
import F04Wizard from "@/components/signing/F04Wizard";
import { reviewFields } from "@/components/signing/f04WizardLogic";
import { saveApplicationReview, sendApplicationBack, sendRefereeChecks, signingAction, type SigningView } from "@/lib/signingApi";
import { useToast } from "@/pages/admin/components/toastContext";
import { getApplicationReview, REFEREE_LABELS, type ApplicationReview } from "@/pages/admin/lib/agentOnboarding";

/*
 * Review application (owner brief 2026-11-18): the signed Agent Application Form opens in the same F04 wizard the agency admin used, in
 * admin-review mode. Every answer can be edited (Save changes: an audit line per field and a new PDF revision "edited by SLIT staff"),
 * flagged with a note for correction (Send back for correction, with an optional message), or the application approved (Approve and
 * activate agency: the business goes active and the agent agreement follows). The referees' replies sit beside the References step.
 */
export default function F04ReviewDialog({ onboardingId, agencyName, onClose, onDone, onApprove }: {
  onboardingId: string; agencyName: string; onClose: () => void;
  /** Sent back or saved and closed: the panel reloads. */
  onDone: (message: string) => Promise<void> | void;
  /** Approve and activate agency: the panel opens the agreement details (commencement, territory, commission, signatory). */
  onApprove: () => void;
}) {
  const { push } = useToast();
  const [review, setReview] = useState<ApplicationReview | null>(null);
  const [error, setError] = useState("");
  const [flags, setFlags] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "back" | "approve">("");
  const [resending, setResending] = useState("");
  // A new key re-opens the wizard with the saved answers (its "changes" start again from them).
  const [version, setVersion] = useState(0);
  const load = useCallback(async () => {
    try { setReview(await getApplicationReview(onboardingId)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "The application could not be opened."); }
  }, [onboardingId]);
  useEffect(() => { void load(); }, [load]);

  const view = useMemo(() => {
    if (!review) return null;
    return {
      id: review.requestId, reference: "", title: `Agent application: ${agencyName}`, state: "signed", message: null, expiresAt: null, signedAt: review.signedAt, consent: "", documentHash: "", url: "",
      recipient: { id: review.contact.id, name: review.contact.name, email: review.contact.email, state: "signed" },
      fields: reviewFields(review.fields, review.answers), signers: [], onboarding: { id: review.onboardingId, kind: "application", agencyName },
      application: { draft: null, facts: review.facts, savedAt: null, prefill: { agent_acn: review.answers.agent_acn ?? "", agent_marn: review.answers.agent_marn ?? "" }, filled: [], attachments: review.attachments, correction: null },
    } as unknown as SigningView;
  }, [review, agencyName]);

  if (error) return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground-950/55 p-4" role="dialog" aria-modal="true">
    <div className="max-w-md rounded-xl bg-background-50 p-5 text-sm"><p role="alert" className="text-red-700">{error}</p>
      <button type="button" className="mt-3 rounded-md border border-background-300 px-3 py-1.5" onClick={onClose}>Close</button></div></div>;
  if (!review || !view) return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground-950/55" role="status"><span className="rounded-md bg-background-50 px-4 py-2 text-sm">Opening the application…</span></div>;

  // 2026-11-20: referees never block a decision; their status is shown with a warning (approve or send back at any time once signed).
  const waiting = review.referees.filter((r) => r.status !== "received").length;
  const blocked = review.correction ? `A correction (round ${review.correction.round}) is with the agency admin. You can act again once they resubmit.`
    : !["application_signed", "references_pending", "references_received", "resubmitted"].includes(review.stage) ? `This application is ${review.label ?? review.stage.replaceAll("_", " ")}: there is nothing to decide now.` : null;
  const refereeLine = (r: ApplicationReview["referees"][number]) => `Reference ${r.position} (${r.name || r.email}): ${r.status === "received" ? "completed" : r.status === "sent" ? "sent, not completed yet" : r.status === "cancelled" ? "cancelled" : "not sent yet"}`;
  const warning = waiting ? `${waiting} of ${review.referees.length || 2} referee${waiting === 1 ? " has" : "s have"} not replied. You can still approve; a reply that arrives later is kept on the business record. ${review.referees.map(refereeLine).join(" · ")}` : null;
  const refereePanel = (position: 1 | 2) => {
    const ref = review.referees.find((r) => r.position === position);
    if (!ref) return <p className="text-xs text-foreground-500">No referee check yet.</p>;
    const answered = REFEREE_LABELS.filter(([k]) => ref.answers?.[k]);
    return <div className="rounded-md bg-background-100/70 p-2.5 text-xs">
      <p className="font-semibold text-foreground-900">Referee's reply (F05) <span className="font-normal text-foreground-600">· {ref.status === "received" ? `completed ${ref.receivedAt ? new Date(ref.receivedAt).toLocaleDateString() : ""} (${ref.receivedVia === "upload" ? "uploaded by staff" : "signed online"})` : ref.status === "sent" ? "sent, not completed yet" : ref.status === "cancelled" ? "cancelled" : "not sent yet"}</span></p>
      {ref.status !== "received" && ref.status !== "cancelled" ? <button type="button" className="mt-1 cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline disabled:opacity-50" disabled={resending === ref.id}
        onClick={() => void resendReferee(ref)} data-testid={`f04-referee-resend-${position}`}>{resending === ref.id ? "Sending…" : ref.status === "sent" ? "Resend to referee" : "Send referee check"}</button> : null}
      {answered.length ? <dl className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5">{answered.map(([k, label]) => <div key={k} className="flex gap-1"><dt className="text-foreground-500">{label}:</dt><dd className="min-w-0 break-words">{ref.answers[k]}</dd></div>)}</dl>
        : ref.status === "received" ? <p className="mt-1 text-foreground-600">No typed answers (see the signed referee check on the business page).</p> : null}
    </div>;
  };
  // Resend (2026-11-20): a reminder of the open referee check, or the check itself when none went out yet.
  const resendReferee = async (ref: ApplicationReview["referees"][number]) => {
    setResending(ref.id);
    try {
      if (ref.request?.recipientId && ["sent", "viewed", "partial"].includes(ref.request.state)) {
        await signingAction({ action: "resend", id: ref.request.id, recipientId: ref.request.recipientId });
        push(`Referee check sent again to ${ref.email}.`);
      } else {
        const r = await sendRefereeChecks(onboardingId);
        push(r.sent ? `Referee check${r.sent === 1 ? "" : "s"} sent (${r.sent}).` : "Nothing to send: this referee's check is already out or closed.");
      }
      await load();
    } catch (e) { push(e instanceof Error ? e.message : "The referee check could not be sent.", "error"); }
    finally { setResending(""); }
  };
  const save = async (changes: Record<string, string>) => {
    setBusy("save");
    try {
      const r = await saveApplicationReview(onboardingId, changes);
      push(r.warning ?? `${r.changed} change${r.changed === 1 ? "" : "s"} saved${r.revision ? ` · PDF revision ${r.revision.revision} (edited by SLIT staff)` : ""}.`, r.warning ? "error" : undefined);
      await load(); setVersion((v) => v + 1);
      return true;
    } catch (e) { push(e instanceof Error ? e.message : "The changes could not be saved.", "error"); return false; }
    finally { setBusy(""); }
  };
  const sendBack = async () => {
    if (!Object.keys(flags).length || busy) return;
    setBusy("back");
    try {
      const r = await sendApplicationBack({ onboardingId, flags, message: message.trim() || undefined });
      await onDone(r.sent ? `Sent back for correction to ${r.to ?? "the agency admin"} (round ${r.round ?? 1}, reference ${r.reference}).` : r.warning ?? "The correction request was created but not emailed.");
    } catch (e) { push(e instanceof Error ? e.message : "The application could not be sent back.", "error"); }
    finally { setBusy(""); }
  };
  return <F04Wizard key={version} token="" view={view} mode="admin-review" codeCheck={{ needed: false, session: null, render: () => null }} onSigned={() => undefined}
    review={{ flags, onFlags: setFlags, message, onMessage: setMessage, refereePanel, busy, blocked, warning, onSave: (changes) => save(changes), onSendBack: () => void sendBack(), onApprove, onClose }} />;
}
