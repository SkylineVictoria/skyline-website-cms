import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A right-side drawer for an action that needs input (an offer letter, a reason): the same slide-over as the form's All steps
 * (StepDrawer), wider (440px), a full-height sheet on phones; Escape or the backdrop closes it unless it is busy.
 */
export default function ActionDrawer({ title, subtitle, busy, onClose, footer, children, testId, wide = false }: {
  title: string;
  subtitle?: ReactNode;
  busy?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
  testId?: string;
  /** Room for a document beside the controls (the offer letter preview). */
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busyRef.current) closeRef.current(); };
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("textarea, input:not([type=hidden]), select, button[data-autofocus]")?.focus();
    return () => { document.removeEventListener("keydown", onKey); opener?.focus?.(); };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[88]" role="presentation">
      <div className="drawer-backdrop absolute inset-0 bg-foreground-950/30" aria-hidden="true" onClick={() => { if (!busy) onClose(); }} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}
        className={`drawer-panel absolute inset-x-0 bottom-0 top-0 flex flex-col bg-background-50 sm:left-auto ${wide ? "sm:w-[min(1200px,96vw)]" : "sm:w-[440px]"} sm:border-l sm:border-background-200 sm:shadow-xl`}>
        <div className="flex items-start justify-between gap-3 border-b border-background-200 px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-heading text-base font-semibold text-foreground-950">{title}</h2>
            {subtitle ? <div className="mt-0.5 text-xs text-foreground-500">{subtitle}</div> : null}
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-500 transition-colors hover:bg-background-100 hover:text-foreground-900 disabled:opacity-50">
            <i className="ri-close-line text-base" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-background-200 px-5 py-3">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A small confirm dialog for an action that needs no input beyond an optional note. */
export function ConfirmDialog({ title, body, confirmLabel, tone = "primary", busy, onConfirm, onClose, children }: {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-foreground-950/40 p-4" role="presentation" onClick={() => { if (!busy) onClose(); }}>
      <div role="alertdialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} className="open-in w-full max-w-sm rounded-xl border border-background-200 bg-background-50 p-5 shadow-xl">
        <h2 className="font-heading text-base font-semibold text-foreground-950">{title}</h2>
        {body ? <div className="mt-1.5 text-sm text-foreground-600">{body}</div> : null}
        {children ? <div className="mt-3">{children}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="h-9 cursor-pointer rounded-lg border border-background-300 px-3 text-sm font-medium text-foreground-700 hover:bg-background-100 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={onConfirm} disabled={busy} data-autofocus
            className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-background-50 disabled:opacity-60 ${tone === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-primary-500 hover:bg-primary-600"}`}>
            {busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
