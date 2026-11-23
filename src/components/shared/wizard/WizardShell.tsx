import { useEffect, useRef, type ReactNode } from "react";

/**
 * The frame every wizard uses: header (icon, title, one line of text, close), the step pills, the body, the footer and the
 * notices under it. The student "Add New Form" document wizard shows it as a dialog over the page; the staff onboarding wizard
 * (opened from an emailed link, no portal around it) shows the same card on the page itself.
 */

export const WIZARD_PRIMARY_CLASS =
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60";

export default function WizardShell({ variant = "modal", title, subtitle, icon = "ri-magic-line", onClose, closeLabel = "Close", stepper, children, footerStart, footerEnd, notices, overlay, stickyFooter = false, wide = false }: {
  /** "modal": a dialog over the page (students). "page": the same card in the page flow (staff link). */
  variant?: "modal" | "page";
  title: ReactNode;
  subtitle: ReactNode;
  icon?: string;
  onClose?: () => void;
  closeLabel?: string;
  /** The step pills (WizardStepper). */
  stepper: ReactNode;
  children: ReactNode;
  /** Left of the footer: Cancel and Back. */
  footerStart: ReactNode;
  /** Right of the footer: Skip, Next, Finish. */
  footerEnd: ReactNode;
  /** WizardNotice rows shown under the footer. */
  notices?: ReactNode;
  /** WizardLock, while a file uploads or is read. */
  overlay?: ReactNode;
  /** On a phone the footer (Back / Next) stays at the bottom of the screen as one row (the F04 wizard on the page). */
  stickyFooter?: boolean;
  /** A wider card (max-w-5xl) for a step that shows a document page (the assessment wizard's Review step). */
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalIsolation(variant === "modal" ? dialogRef : null);
  const card = (
    <div className={`${variant === "modal" ? "relative my-auto" : "relative mx-auto"} w-full ${wide ? "max-w-5xl" : "max-w-3xl"} rounded-xl border border-background-200 bg-background-50 transition-[max-width] duration-200`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-background-200 p-5 md:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-background-50">
            <i className={`${icon} text-xl`} aria-hidden="true" />
          </span>
          <div>
            <h2 id="wizard-title" className="font-heading text-lg font-bold text-foreground-950">
              {title}
            </h2>
            <p className="mt-0.5 text-sm leading-relaxed text-foreground-600">
              {subtitle}
            </p>
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground-500 transition-colors hover:bg-background-100 hover:text-foreground-800"
          >
            <i className="ri-close-line text-lg" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {stepper}

      {/* Body */}
      <div className={variant === "modal" ? `${wide ? "max-h-[72vh]" : "max-h-[62vh]"} overflow-y-auto p-5 md:p-6` : "p-5 md:p-6"}>{children}</div>

      {/* Footer (none when there is nothing to put in it: a done page) */}
      {footerStart == null && footerEnd == null ? null : <div className={stickyFooter
        ? "sticky bottom-0 z-20 flex flex-row items-center justify-between gap-3 rounded-b-xl border-t border-background-200 bg-background-50/95 px-4 py-3 backdrop-blur sm:static sm:bg-background-50 sm:p-5 md:px-6"
        : "flex flex-col gap-3 border-t border-background-200 p-5 sm:flex-row sm:items-center sm:justify-between md:px-6"} data-testid="wizard-footer">
        <div className="flex items-center gap-3">{footerStart}</div>
        {footerEnd}
      </div>}

      {notices}
      {overlay}
    </div>
  );
  if (variant === "page") return <section aria-labelledby="wizard-title" data-testid="wizard-shell">{card}</section>;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-foreground-950/55 p-3 backdrop-blur-sm sm:items-center sm:p-4"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-title"
    >
      {card}
    </div>
  );
}

/**
 * A modal that really is modal (2026-11-23): while it is open everything else on the page is inert (not focusable, not clickable,
 * hidden from screen readers), so keyboard users cannot Tab into the page behind (on a draft, the full application form with its own
 * upload fields). Elements added later (toasts, dialogs the wizard opens) are not touched. Focus moves into the dialog when it opens
 * and back to where it was when it closes.
 */
function useModalIsolation(ref: { current: HTMLElement | null } | null) {
  useEffect(() => {
    const dialog = ref?.current;
    if (!dialog) return undefined;
    const made: Element[] = [];
    for (let node: Element | null = dialog; node && node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling === node || sibling.hasAttribute("inert") || ["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) continue;
        sibling.setAttribute("inert", "");
        made.push(sibling);
      }
    }
    const before = document.activeElement as HTMLElement | null;
    if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
    return () => {
      made.forEach((element) => element.removeAttribute("inert"));
      if (before && document.contains(before)) before.focus();
    };
  }, [ref]);
}

export function WizardBackButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 px-3.5 py-2 text-sm font-semibold text-foreground-700 transition-colors hover:bg-background-100 disabled:opacity-50"
    >
      <i className="ri-arrow-left-line" aria-hidden="true" />
      Back
    </button>
  );
}

const NOTICE = {
  info: { text: "flex items-start gap-2 text-sm text-foreground-600", icon: "ri-information-line", role: undefined },
  error: { text: "flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800", icon: "ri-error-warning-line", role: "alert" },
  warn: { text: "flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900", icon: "ri-time-line", role: "status" },
} as const;

/** One row under the footer: what is needed to continue (info), a refused file (error) or a slow reading (warn). */
export function WizardNotice({ tone, children }: { tone: keyof typeof NOTICE; children: ReactNode }) {
  const spec = NOTICE[tone];
  return (
    <div className="border-t border-background-200 px-5 py-3 md:px-6">
      <p role={spec.role} className={spec.text}>
        <i className={`${spec.icon} mt-0.5`} aria-hidden="true" />
        {children}
      </p>
    </div>
  );
}

/**
 * Covers the wizard while a file uploads or is read, so nothing else can be clicked. `quiet`: see-through, with the message for
 * screen readers only, because the step shows its own reading panel underneath.
 */
export function WizardLock({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  if (quiet) return <div className="absolute inset-0 z-10 cursor-wait rounded-xl" role="status" aria-live="polite"><span className="sr-only">{children}</span></div>;
  return (
    <div className="absolute inset-0 z-10 flex cursor-wait items-center justify-center rounded-xl bg-background-50/70" role="status" aria-live="polite">
      <span className="flex items-center gap-2 rounded-md border border-background-200 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-800 shadow-sm">
        <i className="ri-loader-4-line animate-spin text-primary-600" aria-hidden="true" />
        {children}
      </span>
    </div>
  );
}
