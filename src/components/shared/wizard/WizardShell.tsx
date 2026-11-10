import type { ReactNode } from "react";

/**
 * The frame every wizard uses: header (icon, title, one line of text, close), the step pills, the body, the footer and the
 * notices under it. The student "Add New Form" document wizard shows it as a dialog over the page; the staff onboarding wizard
 * (opened from an emailed link, no portal around it) shows the same card on the page itself.
 */

export const WIZARD_PRIMARY_CLASS =
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60";

export default function WizardShell({ variant = "modal", title, subtitle, icon = "ri-magic-line", onClose, closeLabel = "Close", stepper, children, footerStart, footerEnd, notices, overlay }: {
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
}) {
  const card = (
    <div className={variant === "modal" ? "relative my-auto w-full max-w-3xl rounded-xl border border-background-200 bg-background-50" : "relative mx-auto w-full max-w-3xl rounded-xl border border-background-200 bg-background-50"}>
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
      <div className={variant === "modal" ? "max-h-[62vh] overflow-y-auto p-5 md:p-6" : "p-5 md:p-6"}>{children}</div>

      {/* Footer */}
      <div className="flex flex-col gap-3 border-t border-background-200 p-5 sm:flex-row sm:items-center sm:justify-between md:px-6">
        <div className="flex items-center gap-3">{footerStart}</div>
        {footerEnd}
      </div>

      {notices}
      {overlay}
    </div>
  );
  if (variant === "page") return <section aria-labelledby="wizard-title" data-testid="wizard-shell">{card}</section>;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-foreground-950/55 p-3 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-title"
    >
      {card}
    </div>
  );
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

/** Covers the wizard while a file uploads or is read, so nothing else can be clicked. */
export function WizardLock({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 flex cursor-wait items-center justify-center rounded-xl bg-background-50/70" role="status" aria-live="polite">
      <span className="flex items-center gap-2 rounded-md border border-background-200 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-800 shadow-sm">
        <i className="ri-loader-4-line animate-spin text-primary-600" aria-hidden="true" />
        {children}
      </span>
    </div>
  );
}
