import { useEffect, type ReactNode } from "react";
import SharedStatusBadge from "@/components/shared/application-status/StatusBadge";

export function PortalLoading({ label = "Loading\u2026" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-background-200 bg-background-50 px-4 py-6 text-sm text-foreground-600" aria-live="polite">
      <i className="ri-loader-4-line animate-spin text-lg text-primary-600" aria-hidden="true" />
      {label}
    </div>
  );
}

export function PortalError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary-200 bg-primary-50 px-4 py-4 text-sm text-primary-900 sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-center gap-2">
        <i className="ri-error-warning-line text-base" aria-hidden="true" />
        {message ?? "Something went wrong loading this page."}
      </span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer whitespace-nowrap rounded-md border border-primary-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-primary-700 hover:bg-primary-100"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function PortalEmpty({
  icon = "ri-inbox-line",
  title,
  message,
  action,
}: {
  icon?: string;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-background-300 bg-background-50 px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-background-100 text-xl text-foreground-500">
        <i className={icon} aria-hidden="true" />
      </span>
      <p className="font-heading text-sm font-semibold text-foreground-900">{title}</p>
      {message ? <p className="max-w-md text-sm text-foreground-500">{message}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** An application status (labels and colours from the database's catalogue). */
export function StatusBadge({ status }: { status: string }) {
  return <SharedStatusBadge status={status} />;
}

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow ? (
          <p className="font-label text-xs font-semibold uppercase tracking-wide text-primary-600">{eyebrow}</p>
        ) : null}
        <h1 className="mt-1 font-heading text-2xl font-bold text-foreground-950 md:text-3xl">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground-600">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function PhaseScaffold({ icon, title, note }: { icon: string; title: string; note: string }) {
  return (
    <PortalEmpty
      icon={icon}
      title={title}
      message={note}
    />
  );
}

/** A permanent (reference) agency — never removed by automated routines. */
export function PermanentBadge() {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-secondary-100 px-2.5 py-1 text-xs font-semibold text-secondary-900">
      <i className="ri-shield-star-line" aria-hidden="true" />
      Permanent
    </span>
  );
}

/** Lightweight accessible modal used for edit / confirm dialogs. */
export function PortalModal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground-950/40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card border border-background-200 bg-background-50 p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-heading text-lg font-bold text-foreground-950">{title}</h2>
            {description ? <p className="mt-1.5 text-sm text-foreground-600">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-500 transition-colors hover:bg-background-100 hover:text-foreground-800"
          >
            <i className="ri-close-line text-lg" aria-hidden="true" />
          </button>
        </div>
        {children ? <div className="mt-5">{children}</div> : null}
        {footer ? <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{footer}</div> : null}
      </div>
    </div>
  );
}