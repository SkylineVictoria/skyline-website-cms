import { useEffect, useRef, useState } from "react";
import StatusBadge from "@/components/shared/application-status/StatusBadge";
import TakeActionMenu from "@/components/shared/application-status/TakeActionMenu";
import { ConfirmDialog } from "@/components/shared/application-status/ActionDrawer";
import { actionsFor, statusInfo, useApplicationStatuses } from "@/lib/applicationStatuses";
import { acceptOffer, currentOfferLetter, offerLetterList, openOfferLetter, resubmitApplication, type AgentOption, type ApplicationDetail, type OfferLetter, type StatusHistoryRow } from "@/pages/agency/lib/portalApplications";
import { formatDate } from "@/pages/agency/lib/portalData";
import type { ToastAction } from "@/components/shared/application-form/useToast";

/** The reason the latest Action required was sent with (from the status history). */
const actionRequiredNote = (history: StatusHistoryRow[]) => history.find((row) => row.newStatus === "action_required")?.note ?? "";

/**
 * Staff, at the bottom of Review: the status, what is needed next (from the status catalogue), the outstanding note of an Action
 * required, and the same Take action menu as the list.
 */
export function StaffReviewBar({ application, history, onDone, onResult, reviewIssues = 0 }: {
  application: ApplicationDetail;
  history: StatusHistoryRow[];
  onDone: () => void;
  onResult: (message: string, ok: boolean, action?: ToastAction) => void;
  /** Review problems still open: Issue offer letter needs an override note while there are any. */
  reviewIssues?: number;
}) {
  const workflow = useApplicationStatuses();
  const [status, setStatus] = useState(application.status);
  const [previous, setPrevious] = useState(application.status);
  if (previous !== application.status) { setPrevious(application.status); setStatus(application.status); }
  const info = statusInfo(workflow, status);
  const note = status === "action_required" ? actionRequiredNote(history) : "";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="staff-review-bar">
      <StatusBadge status={status} size="sm" />
      <span className="min-w-0 truncate text-xs text-foreground-600" data-testid="status-hint">
        <span className="font-medium text-foreground-800">{info.label}</span>{info.hint ? <> &middot; {info.hint}</> : null}
        {note ? <> &middot; Asked: {note}</> : null}
      </span>
      <span className="ml-auto">
        <TakeActionMenu align="right" size="md" onStatus={setStatus} onDone={onDone} onResult={onResult} reviewIssues={reviewIssues}
          application={{ id: application.id, status, reference: application.reference, studentName: application.studentName, studentId: application.studentId,
            course: application.courses[0] ? { title: application.courses[0].title, code: application.courses[0].code } : null, intake: application.intake }} />
      </span>
    </div>
  );
}

/**
 * The student or agent: an issued offer letter to view and accept (a confirmation, no signature), or an Action required to fix
 * and resubmit, with what was asked. Nothing for other statuses.
 */
export function ApplicantStatusBanner({ application, history, onChanged }: { application: ApplicationDetail; history: StatusHistoryRow[]; onChanged: () => void }) {
  const workflow = useApplicationStatuses();
  const actions = actionsFor(workflow, application.status, "applicant");
  const accept = actions.find((x) => x.kind === "accept_offer");
  const resubmit = actions.find((x) => x.kind === "resubmit");
  const [letter, setLetter] = useState<OfferLetter | null>(null);
  const [confirming, setConfirming] = useState<"accept" | "resubmit" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!accept) return;
    void currentOfferLetter(application.id).then(setLetter, () => setLetter(null));
  }, [accept, application.id]);
  if (!accept && !resubmit) return null;

  const run = async () => {
    setBusy(true); setError("");
    try {
      if (confirming === "accept") await acceptOffer(application.id);
      else await resubmitApplication(application.id);
      setConfirming(null);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "That could not be done."); }
    finally { setBusy(false); }
  };

  return (
    <div className={`mt-4 rounded-xl border p-4 ${accept ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/70"}`} data-testid={accept ? "offer-banner" : "action-required-banner"}>
      {accept ? (
        <div className="flex flex-wrap items-center gap-3">
          <i className="ri-mail-star-line text-xl leading-none text-emerald-700" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground-950">Your offer letter is ready</p>
            <p className="text-xs text-foreground-600">{letter ? <>Issued {formatDate(letter.issuedAt)}{letter.message ? <> &middot; {letter.message}</> : null}</> : "Read the letter, then accept the offer to continue."}</p>
          </div>
          {letter ? (
            <button type="button" onClick={() => void openOfferLetter(letter.id).catch((e: Error) => setError(e.message))}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-background-300 bg-background-50 px-3 text-sm font-medium text-foreground-800 hover:bg-background-100">
              <i className="ri-file-pdf-2-line" aria-hidden="true" />View letter
            </button>
          ) : null}
          <button type="button" onClick={() => setConfirming("accept")} data-testid="accept-offer"
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600">
            <i className="ri-check-line" aria-hidden="true" />{accept.label}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <i className="ri-error-warning-line text-xl leading-none text-amber-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground-950">This application needs action</p>
            <p className="text-xs text-foreground-700" data-testid="action-required-note">{actionRequiredNote(history) || "Correct the application, then resubmit it."}</p>
          </div>
          <button type="button" onClick={() => setConfirming("resubmit")} data-testid="resubmit-application"
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600">
            <i className="ri-send-plane-line" aria-hidden="true" />{resubmit!.label}
          </button>
        </div>
      )}
      {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
      {confirming ? (
        <ConfirmDialog busy={busy} onClose={() => setConfirming(null)} onConfirm={() => void run()}
          title={confirming === "accept" ? "Accept the offer?" : "Resubmit the application?"}
          confirmLabel={confirming === "accept" ? "Accept offer" : "Resubmit"}
          body={confirming === "accept" ? "This confirms the offer is accepted. The time is recorded and the institution is told." : "SLIT admissions is told the corrections are done and reviews the application again."} />
      ) : null}
    </div>
  );
}

/** "Agent: Name ✎" in the meta row; the pencil opens a small popover to reassign (agency admins and staff). */
export function AgentMetaEditor({ agentId, agentName, agents, busy, onAssign }: {
  agentId: string | null;
  agentName: string;
  agents: AgentOption[];
  busy: boolean;
  onAssign: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(agentId ?? "");
  const boxRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <span ref={boxRef} className="relative inline-flex items-center gap-1">
      Agent: <span className="font-medium text-foreground-800">{agentName || "Unassigned"}</span>
      <button type="button" aria-label="Change the assigned agent" aria-expanded={open} onClick={() => { setChoice(agentId ?? ""); setOpen((v) => !v); }} data-testid="edit-agent"
        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-foreground-500 hover:bg-background-100 hover:text-foreground-900">
        <i className="ri-pencil-line text-sm leading-none" aria-hidden="true" />
      </button>
      {open ? (
        <span className="fade-in absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-background-200 bg-background-50 p-3 shadow-lg" role="dialog" aria-label="Assigned agent">
          <label htmlFor="assign-agent" className="mb-1 block text-xs font-medium uppercase tracking-wide text-foreground-500">Assigned agent</label>
          <select id="assign-agent" value={choice} onChange={(e) => setChoice(e.target.value)}
            className="h-9 w-full rounded-lg border border-background-300 bg-background-50 px-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40">
            <option value="">Unassigned</option>
            {agents.map((agent) => <option key={agent.profileId} value={agent.profileId}>{agent.fullName}</option>)}
          </select>
          <span className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="h-8 cursor-pointer rounded-lg px-2 text-xs font-medium text-foreground-600 hover:bg-background-100">Cancel</button>
            <button type="button" disabled={busy || choice === (agentId ?? "")} onClick={() => { onAssign(choice); setOpen(false); }}
              className="h-8 cursor-pointer rounded-lg bg-primary-500 px-3 text-xs font-medium text-background-50 hover:bg-primary-600 disabled:opacity-50">Save</button>
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** The application's offer letters (Documents tab). */
export function OfferLettersList({ applicationId, refreshKey }: { applicationId: string; refreshKey?: unknown }) {
  const [letters, setLetters] = useState<Awaited<ReturnType<typeof offerLetterList>>>([]);
  const [error, setError] = useState("");
  useEffect(() => { void offerLetterList(applicationId).then(setLetters, () => setLetters([])); }, [applicationId, refreshKey]);
  if (!letters.length) return null;
  return (
    <section className="mb-4 rounded-xl border border-background-200 bg-background-50 p-4" data-testid="offer-letters">
      <h3 className="text-sm font-semibold text-foreground-950">Offer letters</h3>
      <ul className="mt-2 divide-y divide-background-200">
        {letters.map((letter) => (
          <li key={letter.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <i className="ri-file-pdf-2-line text-base text-foreground-500" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground-900">{letter.fileName}</span>
            <span className="text-xs text-foreground-500">To {letter.recipientKind} {letter.recipientEmail} &middot; {formatDate(letter.issuedAt)}{letter.templateName ? <> &middot; {letter.templateName} v{letter.templateVersion}</> : null}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${letter.acceptedAt ? "bg-emerald-50 text-emerald-800" : "bg-background-100 text-foreground-600"}`}>{letter.acceptedAt ? `Accepted ${formatDate(letter.acceptedAt)}` : "Awaiting acceptance"}</span>
            <button type="button" onClick={() => void openOfferLetter(letter.id).catch((e: Error) => setError(e.message))} className="cursor-pointer text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">View</button>
          </li>
        ))}
      </ul>
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </section>
  );
}
