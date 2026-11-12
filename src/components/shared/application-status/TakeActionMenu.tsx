import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "./ActionDrawer";
import OfferLetterDrawer, { type OfferApplication } from "./OfferLetterDrawer";
import { FinalBadge, StatusConfigError } from "./StatusBadge";
import { CoeVoeDrawer, EnrolDialog, ReasonDialog, type StatusResult } from "./StatusDialogs";
import { FORM_LABEL } from "@/components/shared/application-form/Field";
import type { ToastAction } from "@/components/shared/application-form/useToast";
import { getAllowedActions, statusInfo, useApplicationStatuses, type StatusAction } from "@/lib/applicationStatuses";
import { changeApplicationStatus, revertApplicationStatus } from "@/pages/agency/lib/portalApplications";
import { CcAgent } from "./CcAgent";
import { sendCc, useCcDefault } from "@/lib/ccAgent";
import { prepareOfferResend } from "@/lib/offerSigningLayout";

type Variant = "menu" | "row";

/**
 * The staff actions of one application, from the database's transitions for the current status and the user's role
 * (getAllowedActions; the database checks again). `row` (the list): the primary action as an icon button with a tooltip and a "⋯"
 * menu with the rest, Reject / Withdraw in red below a divider. `menu` (the detail page): "Take action ▾" with all of them. Issue
 * offer letter and Issue CoE / VoE open a right-side drawer; Enrol and the moves that need a reason a small dialog; the rest a confirm.
 * After a change the badge updates at once (onStatus) and a toast says so, with Undo for a change made with a reason.
 */
export default function TakeActionMenu({ application, onStatus, onDone, onResult, variant = "menu", align = "right", size = "sm", reviewIssues = 0 }: {
  application: OfferApplication & { status: string };
  /** The status to show now; the previous one again after Undo. */
  onStatus?: (status: string) => void;
  /** After a successful action (reload what depends on it). */
  onDone?: () => void;
  onResult?: (message: string, ok: boolean, action?: ToastAction) => void;
  variant?: Variant;
  align?: "left" | "right";
  size?: "sm" | "md";
  /** Review problems still open (validation errors): Issue offer letter then needs an override note. */
  reviewIssues?: number;
}) {
  const workflow = useApplicationStatuses();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const [active, setActive] = useState<StatusAction | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Resend offer letter: the agent's copy too (on by default).
  const [ccWanted, setCcWanted] = useState(false);
  const cc = useCcDefault(application.id, ccWanted);
  const [ccOn, setCcOn] = useState(true);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actions = getAllowedActions(workflow, application.status);
  const primary = variant === "row" ? actions.find((a) => a.primary) : undefined;
  const listed = primary ? actions.filter((a) => a !== primary) : actions;
  const dialogApp = { id: application.id, reference: application.reference, studentName: application.studentName };

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const reflow = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", reflow, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", onKey); window.removeEventListener("scroll", reflow, true); };
  }, [open]);

  if (workflow.error) return <StatusConfigError compact />;
  if (!workflow.ready) return <span className="inline-block h-8 w-20 animate-pulse rounded-lg bg-background-100" aria-label="Loading actions" />;
  if (!actions.length) {
    return statusInfo(workflow, application.status).final ? <FinalBadge />
      : <span className="cursor-default px-2 text-sm text-foreground-400" title="No action available for your role" aria-label="No action available for your role" data-testid="no-action">—</span>;
  }

  const toggle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const needed = 8 + listed.length * 40;
      const below = window.innerHeight - rect.bottom;
      const left = align === "right" ? rect.right : rect.left;
      setPlace(below < needed && rect.top > below ? { bottom: window.innerHeight - rect.top + 4, left } : { top: rect.bottom + 4, left });
    }
    setOpen((value) => !value);
  };
  const choose = (action: StatusAction) => { setOpen(false); setNote(""); setError(""); if (action.kind === "resend_offer") setCcWanted(true); setActive(action); };
  const close = () => { if (!busy) { setActive(null); setError(""); } };

  /** After a change: the badge at once, a toast, Undo when the database allows it. */
  const changed = (result: StatusResult) => {
    const from = application.status;
    setActive(null);
    onStatus?.(result.status);
    const undo: ToastAction | undefined = result.undoable ? {
      label: "Undo",
      onClick: () => void revertApplicationStatus(application.id).then((back) => { onStatus?.(back.status); onResult?.(`Undone: ${application.studentName || "the application"} is ${back.label} again.`, true); onDone?.(); },
        (e: Error) => onResult?.(e.message, false)),
    } : undefined;
    onResult?.(`${application.studentName || "Application"} is now ${result.label}.`, true, undo);
    void from;
    onDone?.();
  };

  // Confirm (no reason): Send reminder, Resend offer letter, any other move without a reason.
  const runSimple = async () => {
    if (!active) return;
    setBusy(true); setError("");
    try {
      if (active.kind === "resend_offer") await prepareOfferResend(application.id);
      const result = await changeApplicationStatus(application.id, active.action, { note: note.trim() });
      if (active.kind === "reminder") { onResult?.("Reminder sent.", true); setActive(null); onDone?.(); }
      else if (active.kind === "resend_offer") {
        if (ccOn) await sendCc(application.id, "offer_letter_issued", cc);
        onResult?.("The offer letter was sent again.", true); setActive(null); onDone?.();
      }
      else changed(result);
    } catch (e) { setError(e instanceof Error ? e.message : "The action could not be completed."); }
    finally { setBusy(false); }
  };

  const item = (action: StatusAction, index: number, list: StatusAction[]) => (
    <div key={action.action}>
      {index > 0 && action.tone === "danger" && list[index - 1].tone !== "danger" ? <div className="my-1 border-t border-background-200" /> : null}
      <button type="button" role="menuitem" onClick={() => choose(action)} data-action={action.action}
        className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-background-100 focus:bg-background-100 focus:outline-none ${action.tone === "danger" ? "text-red-700" : action.primary ? "font-medium text-foreground-950" : "text-foreground-800"}`}>
        {action.icon ? <i className={`${action.icon} text-base leading-none ${action.tone === "danger" ? "text-red-600" : "text-foreground-500"}`} aria-hidden="true" /> : null}
        {action.label}
      </button>
    </div>
  );

  const sizeClass = size === "md" ? "h-9 px-3 text-sm" : "h-8 px-2.5 text-xs";
  const isEnrol = (a: StatusAction | null) => a?.kind === "enrol";
  return (
    <span className="inline-flex items-center gap-1">
      {primary ? (
        <button type="button" onClick={() => choose(primary)} title={primary.label} aria-label={primary.label} data-testid="primary-action" data-action={primary.action}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-primary-200 bg-primary-50 text-primary-700 transition-colors hover:bg-primary-100">
          <i className={`${primary.icon || "ri-arrow-right-line"} text-base leading-none`} aria-hidden="true" />
        </button>
      ) : null}
      {listed.length ? (
        variant === "row" ? (
          <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} onClick={toggle} data-testid="take-action" title="More actions" aria-label="More actions"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-foreground-600 transition-colors hover:bg-background-100 hover:text-foreground-900">
            <i className="ri-more-fill text-lg leading-none" aria-hidden="true" />
          </button>
        ) : (
          <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} onClick={toggle} data-testid="take-action"
            className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border border-background-300 bg-background-50 font-medium text-foreground-800 transition-colors duration-150 hover:bg-background-100 ${sizeClass}`}>
            Take action
            <i className={`ri-arrow-down-s-line text-base leading-none transition-transform duration-150 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
        )
      ) : null}
      {open && place ? createPortal(
        <div ref={menuRef} role="menu" aria-label="Actions" data-testid="take-action-menu"
          style={{ position: "fixed", ...(place.bottom !== undefined ? { bottom: place.bottom } : { top: place.top }), ...(align === "right" ? { right: window.innerWidth - place.left } : { left: place.left }) }}
          className="fade-in z-[86] min-w-[13rem] overflow-hidden rounded-lg border border-background-200 bg-background-50 py-1 shadow-lg">
          {listed.map((action, index) => item(action, index, listed))}
        </div>,
        document.body,
      ) : null}

      {active?.kind === "offer_letter" ? (
        <OfferLetterDrawer application={application} reviewIssues={reviewIssues} onClose={close}
          onSent={() => { const to = active.to; setActive(null); if (to) onStatus?.(to); onResult?.("Offer letter sent.", true); onDone?.(); }} />
      ) : null}
      {active?.kind === "coe" ? <CoeVoeDrawer application={dialogApp} action={active} onClose={close} onDone={changed} /> : null}
      {active && active.kind === "status" && active.requiresReason ? <ReasonDialog application={dialogApp} action={active} onClose={close} onDone={changed} /> : null}
      {isEnrol(active) && active ? <EnrolDialog application={dialogApp} action={active} onClose={close} onDone={changed} /> : null}
      {active && !["offer_letter", "coe"].includes(active.kind) && !(active.kind === "status" && active.requiresReason) && !isEnrol(active) ? (
        <ConfirmDialog title={`${active.label}?`} confirmLabel={active.label} tone={active.tone === "danger" ? "danger" : "primary"} busy={busy} onClose={close} onConfirm={() => void runSimple()}
          body={active.kind === "resend_offer" ? "The same offer letter is emailed again, with a new link for the student to review and sign it. Earlier links stop working." : active.kind === "reminder" ? "The student or agent is emailed what this application still needs."
            : active.to ? `${application.studentName || "The application"} moves to ${statusInfo(workflow, active.to).label}.` : undefined}>
          {active.note !== "none" ? (
            <div className="mt-2">
              <label htmlFor={`action-note-${application.id}`} className={`${FORM_LABEL} mb-1 block`}>Note (optional)</label>
              <textarea id={`action-note-${application.id}`} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40" />
            </div>
          ) : null}
          {active.kind === "resend_offer" ? <CcAgent cc={cc} on={ccOn} onChange={setCcOn} /> : null}
          {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
        </ConfirmDialog>
      ) : null}
    </span>
  );
}
