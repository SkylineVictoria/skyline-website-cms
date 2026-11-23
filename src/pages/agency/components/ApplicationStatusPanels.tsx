import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import StatusBadge from "@/components/shared/application-status/StatusBadge";
import TakeActionMenu from "@/components/shared/application-status/TakeActionMenu";
import { ConfirmDialog } from "@/components/shared/application-status/ActionDrawer";
import { actionsFor, statusInfo, useApplicationStatuses } from "@/lib/applicationStatuses";
import { acceptOffer, currentOfferLetter, offerAcceptanceLine, offerDepositState, offerLetterList, offerPaymentState, openOfferLetter, sendDepositReminder, setDepositAutoRemind, openOfferLetterFile, resubmitApplication, type AgentOption, type ApplicationDetail, type OfferLetter, type StatusHistoryRow } from "@/pages/agency/lib/portalApplications";
import { formatDate } from "@/pages/agency/lib/portalData";
import { depositReminderText, portalOfferAcceptAllowed } from "@/pages/agency/lib/admissionsRules";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import type { ToastAction } from "@/components/shared/application-form/useToast";
import SearchableSelect from "@/components/ui/SearchableSelect";

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
        {/* The badge already names the status: here only what comes next. */}
        <span className="font-medium text-foreground-800">{info.hint || info.label}</span>
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
  const navigate = useNavigate();
  const workflow = useApplicationStatuses();
  const actions = actionsFor(workflow, application.status, "applicant");
  const accept = actions.find((x) => x.kind === "accept_offer");
  const resubmit = actions.find((x) => x.kind === "resubmit");
  // Business Rules admissions.offer_accept_in_portal / admissions.offer_accept_portal_roles: whether this person may press
  // Accept offer here (the database checks it again). Without it the letter is still shown; it is accepted by signing it.
  const { role } = usePortalAuth();
  const mayAccept = portalOfferAcceptAllowed(role);
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
            {(() => { const pay = offerPaymentState(letter?.payment); return pay ? <p className="mt-0.5 text-xs" data-testid="offer-card-payment"><span className={pay.tone === "paid" ? "text-emerald-800" : pay.tone === "failed" ? "text-red-800" : "text-amber-900"}>Initial deposit: {pay.label}</span>{pay.tone !== "paid" ? <span className="text-foreground-500"> · paid by card on the signing page after signing</span> : null}</p> : null; })()}
          </div>
          {letter ? (
            <button type="button" onClick={() => void openOfferLetter(letter.id).catch((e: Error) => setError(e.message))}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-background-300 bg-background-50 px-3 text-sm font-medium text-foreground-800 hover:bg-background-100">
              <i className="ri-file-pdf-2-line" aria-hidden="true" />View letter
            </button>
          ) : null}
          {mayAccept ? (
            <button type="button" onClick={() => setConfirming("accept")} data-testid="accept-offer"
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600">
              <i className="ri-check-line" aria-hidden="true" />{accept.label}
            </button>
          ) : <p className="w-full text-xs text-foreground-600" data-testid="accept-offer-by-signing">The offer is accepted by signing the letter from the email it came with.</p>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <i className="ri-error-warning-line text-xl leading-none text-amber-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground-950">This application needs action</p>
            <p className="text-xs text-foreground-700" data-testid="action-required-note">{actionRequiredNote(history) || "Correct the application, then resubmit it."}</p>
          </div>
          {/* Resubmitting checks the form first: the button opens Review, where Resubmit application is. */}
          <button type="button" onClick={() => navigate({ search: "?stage=review" })} data-testid="resubmit-application"
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600">
            <i className="ri-send-plane-line" aria-hidden="true" />Review &amp; resubmit
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
          <SearchableSelect id="assign-agent" value={choice} onChange={(e) => setChoice(e.target.value)}
            className="h-9 w-full rounded-lg border border-background-300 bg-background-50 px-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40">
            <option value="">Unassigned</option>
            {agents.map((agent) => <option key={agent.profileId} value={agent.profileId}>{agent.fullName}</option>)}
          </SearchableSelect>
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

/** Where the student's online signing stands (the link they were emailed). */
const signingState = (signing: { status: string; expiresAt: string | null; viewedAt: string | null }) =>
  signing.status === "viewed" ? "Opened by the student" : signing.status === "expired" ? "Signing link expired" : signing.status === "void" ? "Signing link closed"
    : signing.status === "draft" ? "Signing link being sent" : `Sent to sign${signing.expiresAt ? ` · until ${formatDate(signing.expiresAt)}` : ""}`;

/**
 * OFFER-DEPOSIT: the latest letter's acceptance and initial deposit on the application page, for staff, agents and the student:
 * "Offer accepted: Yes · Deposit: Pending / Paid (date) / Not required". Staff and the agent send a payment reminder (the student's
 * personal link again; one per finance.deposit_manual_reminder_cooldown hours (24) unless confirmed), see "Last reminder sent <date> (n sent)", and staff switch the automatic
 * reminders (every finance.deposit_automatic_reminder_interval days, at most finance.deposit_automatic_reminder_cap) on per offer.
 */
export function OfferDepositCard({ applicationId, canRemind, canConfigure, refreshKey }: { applicationId: string; canRemind: boolean; canConfigure: boolean; refreshKey?: unknown }) {
  const [letter, setLetter] = useState<OfferLetter | null>(null);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const load = () => currentOfferLetter(applicationId).then(setLetter, () => setLetter(null));
  useEffect(() => { void load(); }, [applicationId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!letter || !letter.payment || offerDepositState(letter.payment).tone === "none") return null;
  const deposit = offerDepositState(letter.payment);
  const count = letter.payment.reminder_count ?? 0; const last = letter.payment.last_reminder_at ?? null;
  const remind = async (force: boolean) => {
    setBusy(true); setNote(null); setConfirmForce(false);
    try { const r = await sendDepositReminder(applicationId, force); setNote({ tone: "ok", text: `Reminder emailed to the student (${r.reminderCount} sent).` }); await load(); }
    catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "P0024" || /less than \d+ hours?/i.test(err.message)) setConfirmForce(true); else setNote({ tone: "warn", text: err.message || "The reminder could not be sent." });
    } finally { setBusy(false); }
  };
  const toggleAuto = async (on: boolean) => {
    setBusy(true); setNote(null);
    try { await setDepositAutoRemind(applicationId, on); await load(); } catch (e) { setNote({ tone: "warn", text: e instanceof Error ? e.message : "The setting could not be saved." }); } finally { setBusy(false); }
  };
  return (
    <section className={`mt-4 rounded-xl border p-4 ${deposit.tone === "paid" ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60"}`} data-testid="offer-deposit-card" data-deposit={deposit.tone}>
      <div className="flex flex-wrap items-center gap-3">
        <i className={`${deposit.tone === "paid" ? "ri-checkbox-circle-line text-emerald-700" : "ri-bank-card-line text-amber-800"} text-xl leading-none`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground-950" data-testid="offer-deposit-line">{offerAcceptanceLine(letter)}</p>
          <p className="text-xs text-foreground-600">
            {deposit.tone === "paid" ? <>Initial deposit received{letter.payment.receipt_url ? <> &middot; <a href={letter.payment.receipt_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">Stripe receipt</a></> : null}</>
              : letter.acceptedAt ? "The student pays by card from the link in their offer email (the same link opens the payment page now)." : "Paid by card on the signing page once the student has signed."}
            {count > 0 ? <span data-testid="offer-deposit-reminders"> &middot; Last reminder sent {last ? formatDate(last) : ""} ({count} sent)</span> : null}
          </p>
          {note ? <p role={note.tone === "warn" ? "alert" : "status"} className={`mt-1 text-xs font-medium ${note.tone === "ok" ? "text-emerald-800" : "text-red-700"}`} data-testid="offer-deposit-note">{note.text}</p> : null}
        </div>
        {deposit.tone !== "paid" && canRemind ? (
          <button type="button" disabled={busy} onClick={() => void remind(false)} data-testid="send-deposit-reminder"
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-background-300 bg-background-50 px-3 text-sm font-medium text-foreground-800 hover:bg-background-100 disabled:opacity-50">
            <i className="ri-mail-send-line" aria-hidden="true" />{busy ? "Please wait…" : "Send payment reminder"}
          </button>
        ) : null}
        {deposit.tone !== "paid" && canConfigure ? (
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground-800">
            <input type="checkbox" className="h-4 w-4" checked={!!letter.payment.autoRemind} disabled={busy} onChange={(e) => void toggleAuto(e.target.checked)} data-testid="deposit-auto-remind" />
            Auto-remind every {depositReminderText().everyDays} days (max {depositReminderText().cap})
          </label>
        ) : null}
      </div>
      {confirmForce ? (
        <ConfirmDialog busy={busy} onClose={() => setConfirmForce(false)} onConfirm={() => void remind(true)} title="Send another reminder?" confirmLabel="Send anyway"
          body={`A reminder was sent less than ${depositReminderText().cooldownHours} hours ago${last ? ` (${formatDate(last)})` : ""}. Send another one now?`} />
      ) : null}
    </section>
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
            <span data-testid="offer-letter-state" className={`rounded-full px-2 py-0.5 text-2xs font-medium ${letter.acceptedAt ? "bg-emerald-50 text-emerald-800" : "bg-background-100 text-foreground-600"}`}>
              {letter.acceptedAt ? `${letter.acceptedVia === "signing" || letter.acceptedVia === "signing_and_payment" ? "Signed online" : "Accepted"} ${formatDate(letter.acceptedAt)}` : letter.signing ? signingState(letter.signing) : "Awaiting acceptance"}</span>
            {/* OFFER-DEPOSIT: "Offer accepted: Yes · Deposit: Pending / Paid (date) / Not required" */}
            {(() => { const dep = offerDepositState(letter.payment); return <span data-testid="offer-letter-deposit" data-deposit={dep.tone} className={`rounded-full px-2 py-0.5 text-2xs font-medium ${dep.tone === "paid" ? "bg-emerald-50 text-emerald-800" : dep.tone === "failed" ? "bg-red-50 text-red-800" : dep.tone === "pending" ? "bg-amber-50 text-amber-900" : "bg-background-100 text-foreground-600"}`}>{offerAcceptanceLine(letter)}{letter.payment?.livemode === false && dep.tone !== "none" ? " (test)" : ""}</span>; })()}
            {letter.payment?.receipt_url ? <a href={letter.payment.receipt_url} target="_blank" rel="noreferrer" className="text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">Receipt</a> : null}
            {letter.prepaidMore ? <span className="text-xs text-foreground-500">Pays more than the pre-paid fee: {letter.prepaidMore}</span> : null}
            <button type="button" onClick={() => void openOfferLetter(letter.id).catch((e: Error) => setError(e.message))} className="cursor-pointer text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">View</button>
            {letter.hasSigned ? <button type="button" data-testid="offer-letter-signed" onClick={() => void openOfferLetterFile(letter.id, "signed").catch((e: Error) => setError(e.message))} className="cursor-pointer text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">Signed copy</button> : null}
            {letter.hasPaymentCopy ? <button type="button" data-testid="offer-letter-payment-copy" onClick={() => void openOfferLetterFile(letter.id, "payment_confirmed").catch((e: Error) => setError(e.message))} className="cursor-pointer text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">Payment-confirmed copy</button> : null}
          </li>
        ))}
      </ul>
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </section>
  );
}
