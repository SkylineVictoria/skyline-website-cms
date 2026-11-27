import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "./ActionDrawer";
import OfferLetterDrawer, { type OfferApplication } from "./OfferLetterDrawer";
import { FinalBadge, StatusConfigError } from "./StatusBadge";
import { CoeVoeDrawer, EnrolDialog, ReasonDialog, type StatusResult } from "./StatusDialogs";
import EnrolMailboxDialog from "./EnrolMailboxDialog";
import ActivateInIntakeDialog from "./ActivateInIntakeDialog";
import { FORM_LABEL } from "@/components/shared/application-form/Field";
import type { ToastAction } from "@/components/shared/application-form/useToast";
import { getAllowedActions, statusInfo, useApplicationStatuses, type StatusAction } from "@/lib/applicationStatuses";
import { changeApplicationStatus, revertApplicationStatus } from "@/pages/agency/lib/portalApplications";
import { CcAgent } from "./CcAgent";
import { sendCc, useCcDefault } from "@/lib/ccAgent";
import { prepareOfferResend } from "@/lib/offerSigningLayout";

type Variant = "menu" | "row";
/** The statuses before CoE / VoE issued: "Mark as enrolled" shows there, disabled. */
const BEFORE_COE = ["draft", "submitted", "under_review", "action_required", "offer_issued", "offer_accepted"];
const enrolLaterItem = (action: StatusAction) => (
  <div key="enrol-later" role="menuitem" aria-disabled="true" title="Issue the CoE/VoE first" data-testid="enrol-disabled" data-action={action.action}
    className="flex w-full cursor-not-allowed items-start gap-2 px-3 py-2 text-left text-sm text-foreground-400">
    <i className={`${action.icon || "ri-graduation-cap-line"} text-base leading-none`} aria-hidden="true" />
    <span>{action.label}<span className="block text-xs">Issue the CoE/VoE first</span></span>
  </div>
);

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
  // MENU-PHONE (owner 2026-11-27): under 640px the menu is a bottom sheet; above, a dropdown kept inside the viewport.
  const [sheet, setSheet] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
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
  // QUALIFICATION (owner 2026-11-27): an application becomes Active by itself when its Qualification moves to In Progress, so no
  // action moves it to Active by hand (the database refuses it too: application_active_guard).
  const actions = getAllowedActions(workflow, application.status).filter((a) => a.to !== "active");
  const primary = variant === "row" ? actions.find((a) => a.primary) : undefined;
  // "Set to <status>" moves (20261123151517, Admins): any status by hand, listed apart under "Change status to".
  const isManual = (a: StatusAction) => a.action.startsWith("set_");
  const listed = (primary ? actions.filter((a) => a !== primary) : actions).filter((a) => !isManual(a));
  const manual = actions.filter(isManual).filter((a) => a !== primary);
  // "Mark as enrolled" before CoE / VoE issued (owner 2026-11-21): shown disabled with the reason, for whoever may enrol (the database
  // refuses it too: application_enrolled_guard).
  const enrolAction = getAllowedActions(workflow, "coe_issued").find((a) => a.kind === "enrol");
  const enrolLater = enrolAction && BEFORE_COE.includes(application.status) ? enrolAction : null;
  const [mailbox, setMailbox] = useState(false);
  const dialogApp = { id: application.id, reference: application.reference, studentName: application.studentName };

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    // The page scrolling moves the button away from a dropdown; scrolling inside the menu or the sheet does not close it.
    const reflow = (event: Event) => { if (!sheet && !menuRef.current?.contains(event.target as Node)) setOpen(false); };
    const resize = () => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", reflow, true);
    window.addEventListener("resize", resize);
    // The sheet holds the page still behind it.
    const overflow = document.body.style.overflow;
    if (sheet) document.body.style.overflow = "hidden";
    menuRef.current?.querySelector<HTMLButtonElement>("button[role=menuitem]")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("mousedown", close); document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", reflow, true); window.removeEventListener("resize", resize);
      document.body.style.overflow = overflow;
    };
  }, [open, sheet]);

  // The dropdown is measured once shown, then placed inside the viewport: below the button, or above it when there is no room
  // below (flip), and shifted left / right so it never leaves the screen.
  useLayoutEffect(() => {
    if (!open || sheet) { setPos(null); return; }
    const button = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!button || !menu) return;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 4, edge = 8;
    const maxHeight = vh - edge * 2;
    const height = Math.min(menu.scrollHeight, maxHeight);
    const width = menu.offsetWidth;
    let top = button.bottom + gap;
    if (top + height > vh - edge) top = button.top - gap - height >= edge ? button.top - gap - height : Math.max(edge, vh - edge - height);
    let left = align === "right" ? button.right - width : button.left;
    left = Math.max(edge, Math.min(left, vw - edge - width));
    setPos({ top, left, maxHeight });
  }, [open, sheet, align]);

  if (workflow.error) return <StatusConfigError compact />;
  if (!workflow.ready) return <span className="inline-block h-8 w-20 animate-pulse rounded-lg bg-background-100" aria-label="Loading actions" />;
  if (!actions.length) {
    return statusInfo(workflow, application.status).final ? <FinalBadge />
      : <span className="cursor-default px-2 text-sm text-foreground-400" title="No action available for your role" aria-label="No action available for your role" data-testid="no-action">—</span>;
  }

  const toggle = () => {
    setSheet(window.matchMedia("(max-width: 639px)").matches);
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

  // The options, the same in the sheet (phones) and the dropdown.
  const menuBody = (
    <>
          {listed.map((action, index) => <span key={action.action}>
            {enrolLater && action.tone === "danger" && (index === 0 || listed[index - 1].tone !== "danger") ? enrolLaterItem(enrolLater) : null}
            {item(action, index, listed)}</span>)}
          {enrolLater && !listed.some((a) => a.tone === "danger") ? enrolLaterItem(enrolLater) : null}
          {manual.length ? <div className={listed.length ? "mt-1 border-t border-background-200 pt-1" : ""} data-testid="change-status">
            <p className="px-3 pb-0.5 pt-1 text-2xs font-semibold uppercase tracking-wide text-foreground-500">Change status to</p>
            <div>{manual.map((action) => (
              <button key={action.action} type="button" role="menuitem" onClick={() => choose(action)} data-action={action.action}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground-800 transition-colors hover:bg-background-100 focus:bg-background-100 focus:outline-none">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: action.to ? statusInfo(workflow, action.to).color ?? "#64748b" : "#64748b" }} aria-hidden="true" />
                {action.to ? statusInfo(workflow, action.to).label : action.label.replace(/^Set to /, "")}
              </button>))}</div>
          </div> : null}
    </>
  );
  const sizeClass = size === "md" ? "h-9 px-3 text-sm" : "h-8 px-2.5 text-xs";
  const isEnrol = (a: StatusAction | null) => a?.kind === "enrol";
  // ACTIVE-NEEDS-INTAKE (20261123221517): any move to Active asks for the intake and the unit start first.
  const isActivate = (a: StatusAction | null) => a?.to === "active" && a.kind === "status" && !a.requiresReason;
  return (
    <span className="inline-flex items-center gap-1">
      {primary ? (
        <button type="button" onClick={() => choose(primary)} title={primary.label} aria-label={primary.label} data-testid="primary-action" data-action={primary.action}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-primary-200 bg-primary-50 text-primary-700 transition-colors hover:bg-primary-100">
          <i className={`${primary.icon || "ri-arrow-right-line"} text-base leading-none`} aria-hidden="true" />
        </button>
      ) : null}
      {listed.length || manual.length ? (
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
      {open ? createPortal(sheet ? (
        <div className="fixed inset-0 z-[86] flex flex-col justify-end" data-testid="take-action-sheet">
          <div className="absolute inset-0 bg-foreground-950/40" aria-hidden="true" onClick={() => setOpen(false)} />
          <div ref={menuRef} role="menu" aria-label="Take action" data-testid="take-action-menu"
            className="modal-in relative flex max-h-[85vh] w-full flex-col rounded-t-2xl border-t border-background-200 bg-background-50 shadow-2xl"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
            <div className="flex shrink-0 items-center justify-between border-b border-background-200 px-4 py-3">
              <h2 className="font-heading text-base font-semibold text-foreground-950">Take action</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100">
                <i className="ri-close-line text-xl" aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 [&_[role=menuitem]]:min-h-[44px] [&_[role=menuitem]]:px-4 [&_[role=menuitem]]:text-[15px]">{menuBody}</div>
            <div className="shrink-0 border-t border-background-200 p-3">
              <button type="button" onClick={() => setOpen(false)} data-testid="take-action-cancel"
                className="h-11 w-full cursor-pointer rounded-lg border border-background-300 bg-background-50 text-sm font-semibold text-foreground-800 hover:bg-background-100">Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <div ref={menuRef} role="menu" aria-label="Actions" data-testid="take-action-menu"
          style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden" }}
          className="fade-in z-[86] min-w-[13rem] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-background-200 bg-background-50 py-1 shadow-lg">
          {menuBody}
        </div>
      ), document.body) : null}

      {active?.kind === "offer_letter" ? (
        <OfferLetterDrawer application={application} reviewIssues={reviewIssues} onClose={close}
          onSent={() => { const to = active.to; setActive(null); if (to) onStatus?.(to); onResult?.("Offer letter sent.", true); onDone?.(); }} />
      ) : null}
      {/* // rule-policy: technical qualification-brief 2026-11-27 owner (QUALIFICATION-BRIEF): fixed Qualification decisions (reasons from the list, dates, links, documents, one-step CoE); no configurable value. */}
      {active?.kind === "coe" ? <CoeVoeDrawer application={dialogApp} action={active} onClose={close} onDone={(result) => { changed(result); if (result.status === "enrolled") setMailbox(true); }} /> : null}
      {active && active.kind === "status" && active.requiresReason ? <ReasonDialog application={dialogApp} action={active} onClose={close} onDone={changed} /> : null}
      {isEnrol(active) && active ? <EnrolDialog application={dialogApp} action={active} onClose={close} onDone={(result) => { changed(result); setMailbox(true); }} /> : null}
      {mailbox ? <EnrolMailboxDialog applicationId={application.id} studentId={application.studentId} studentName={application.studentName} reference={application.reference}
        onClose={() => setMailbox(false)} /> : null}
      {isActivate(active) && active ? <ActivateInIntakeDialog application={dialogApp} action={active} onClose={close} onDone={changed} /> : null}
      {active && !["offer_letter", "coe"].includes(active.kind) && !(active.kind === "status" && active.requiresReason) && !isEnrol(active) && !isActivate(active) ? (
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
