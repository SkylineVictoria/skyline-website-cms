import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ActionDrawer, { ConfirmDialog } from "./ActionDrawer";
import OfferLetterDrawer, { type OfferApplication } from "./OfferLetterDrawer";
import { FORM_LABEL } from "@/components/shared/application-form/Field";
import { actionsFor, statusInfo, useApplicationStatuses, type StatusAction } from "@/lib/applicationStatuses";
import { resendOfferLetter, sendActionReminder, setApplicationStatus } from "@/pages/agency/lib/portalApplications";

/**
 * "Take action ▾" for one application (staff): only what the database's workflow allows from the current status. Actions that
 * need input (the offer letter, a required reason) open a right-side drawer; simple ones a small confirm dialog. A status change
 * is shown at once (onStatus) and undone if the database refuses it; the outcome is reported through onResult (a toast).
 */
export default function TakeActionMenu({ application, onStatus, onDone, onResult, onCoe, align = "right", size = "sm" }: {
  application: OfferApplication & { status: string };
  /** The status to show now (optimistic), and the previous one again on failure. */
  onStatus?: (status: string) => void;
  /** After a successful action (reload what depends on it). */
  onDone?: () => void;
  onResult?: (message: string, ok: boolean) => void;
  /** Issue CoE / VoE: opens the registration workbench (the CoE / VoE is issued there). */
  onCoe?: () => void;
  align?: "left" | "right";
  size?: "sm" | "md";
}) {
  const workflow = useApplicationStatuses();
  const [open, setOpen] = useState(false);
  // Under the button, or above it when there is no room below (the review bar sits at the bottom of the screen).
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const [active, setActive] = useState<StatusAction | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actions = actionsFor(workflow, application.status, "staff");

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

  if (!workflow.ready) return <span className="inline-block h-8 w-28 animate-pulse rounded-lg bg-background-100" aria-label="Loading actions" />;
  if (!actions.length) return <span className="text-xs text-foreground-400" data-testid="no-action">No action</span>;

  const toggle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const needed = 8 + actions.length * 40;
      const below = window.innerHeight - rect.bottom;
      const left = align === "right" ? rect.right : rect.left;
      setPlace(below < needed && rect.top > below ? { bottom: window.innerHeight - rect.top + 4, left } : { top: rect.bottom + 4, left });
    }
    setOpen((value) => !value);
  };
  const choose = (action: StatusAction) => {
    setOpen(false); setNote(""); setError("");
    if (action.kind === "coe") { onCoe?.(); return; }
    setActive(action);
  };
  const close = () => { if (!busy) { setActive(null); setError(""); } };

  const run = async () => {
    if (!active) return;
    if (active.note === "required" && !note.trim()) { setError("Add a note to continue."); return; }
    const before = application.status;
    setBusy(true); setError("");
    try {
      if (active.kind === "status" && active.to) {
        onStatus?.(active.to);
        try { await setApplicationStatus(application.id, active.to, note.trim()); } catch (e) { onStatus?.(before); throw e; }
        onResult?.(`${application.studentName || "Application"} is now ${statusInfo(workflow, active.to).label}.`, true);
      } else if (active.kind === "resend_offer") {
        await resendOfferLetter(application.id, note.trim());
        onResult?.("The offer letter was sent again.", true);
      } else if (active.kind === "reminder") {
        await sendActionReminder(application.id, note.trim());
        onResult?.("Reminder sent.", true);
      }
      setActive(null);
      onDone?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : "The action could not be completed.";
      setError(message);
      onResult?.(message, false);
    } finally { setBusy(false); }
  };

  const noteField = (required: boolean, placeholder: string) => (
    <div>
      <label htmlFor={`action-note-${application.id}`} className={`${FORM_LABEL} mb-1 block`}>
        {required ? "Reason" : "Note (optional)"}{required ? <span className="ml-0.5 text-red-600" aria-hidden="true">*</span> : null}
      </label>
      <textarea id={`action-note-${application.id}`} rows={required ? 4 : 2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={placeholder}
        className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40" />
    </div>
  );

  const sizeClass = size === "md" ? "h-9 px-3 text-sm" : "h-8 px-2.5 text-xs";
  return (
    <>
      <button ref={buttonRef} type="button" aria-haspopup="menu" aria-expanded={open} onClick={toggle} data-testid="take-action"
        className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border border-background-300 bg-background-50 font-medium text-foreground-800 transition-colors duration-150 hover:bg-background-100 ${sizeClass}`}>
        Take action
        <i className={`ri-arrow-down-s-line text-base leading-none transition-transform duration-150 ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && place ? createPortal(
        <div ref={menuRef} role="menu" aria-label="Actions" data-testid="take-action-menu"
          style={{ position: "fixed", ...(place.bottom !== undefined ? { bottom: place.bottom } : { top: place.top }), ...(align === "right" ? { right: window.innerWidth - place.left } : { left: place.left }) }}
          className="fade-in z-[86] min-w-[13rem] overflow-hidden rounded-lg border border-background-200 bg-background-50 py-1 shadow-lg">
          {actions.map((action, index) => (
            <div key={action.action}>
              {index > 0 && action.tone === "danger" && actions[index - 1].tone !== "danger" ? <div className="my-1 border-t border-background-200" /> : null}
              <button type="button" role="menuitem" onClick={() => choose(action)}
                className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-background-100 focus:bg-background-100 focus:outline-none ${action.tone === "danger" ? "text-red-700" : action.tone === "primary" ? "font-medium text-foreground-950" : "text-foreground-800"}`}>
                {action.label}
                {action.kind === "offer_letter" || action.note === "required" ? <i className="ri-arrow-right-s-line ml-auto text-base leading-none text-foreground-400" aria-hidden="true" /> : null}
              </button>
            </div>
          ))}
        </div>,
        document.body,
      ) : null}

      {active?.kind === "offer_letter" ? (
        <OfferLetterDrawer application={application} onClose={close}
          onSent={() => { const to = active.to; setActive(null); if (to) onStatus?.(to); onResult?.("Offer letter sent.", true); onDone?.(); }} />
      ) : null}
      {active && active.kind !== "offer_letter" && (active.note === "required" || active.kind === "reminder") ? (
        <ActionDrawer title={active.label} subtitle={<>{application.studentName || "Application"}{application.reference ? <> &middot; {application.reference}</> : null}</>}
          busy={busy} onClose={close} testId="action-drawer"
          footer={<>
            <button type="button" onClick={close} disabled={busy} className="h-9 cursor-pointer rounded-lg border border-background-300 px-3 text-sm font-medium text-foreground-700 hover:bg-background-100 disabled:opacity-50">Cancel</button>
            <button type="button" onClick={() => void run()} disabled={busy || (active.note === "required" && !note.trim())} data-testid="action-confirm"
              className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-background-50 disabled:cursor-not-allowed disabled:opacity-60 ${active.tone === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-primary-500 hover:bg-primary-600"}`}>
              {busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : null}{active.label}
            </button>
          </>}>
          <div className="space-y-3">
            <p className="text-sm text-foreground-600">
              {active.kind === "reminder" ? "The student or agent is emailed what this application still needs." :
                active.to === "action_required" ? "The reason is sent to the student or agent, who corrects the application and resubmits it." :
                  active.to === "rejected" ? "The reason is kept in the status history and sent with the status change." :
                    active.to === "offer_accepted" ? "Record how the offer was accepted (for example by email). The note is kept in the status history." :
                      "The note is kept in the status history."}
            </p>
            {noteField(active.note === "required", active.to === "action_required" ? "What needs to be corrected" : active.to === "rejected" ? "Why the application is rejected" : active.to === "offer_accepted" ? "e.g. Accepted by email on 12 November" : "")}
            {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
          </div>
        </ActionDrawer>
      ) : null}
      {active && active.kind !== "offer_letter" && active.note !== "required" && active.kind !== "reminder" ? (
        <ConfirmDialog title={`${active.label}?`} confirmLabel={active.label} tone={active.tone === "danger" ? "danger" : "primary"} busy={busy} onClose={close} onConfirm={() => void run()}
          body={active.kind === "resend_offer" ? "The same offer letter is emailed to the same recipient again." : active.to ? `${application.studentName || "The application"} moves to ${statusInfo(workflow, active.to).label}.` : undefined}>
          {active.note === "optional" ? noteField(false, "") : null}
          {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
