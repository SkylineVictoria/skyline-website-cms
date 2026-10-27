import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Accessible modal: role=dialog + aria-modal, labelled title, focus moves in / is trapped / returns to the trigger, Esc and backdrop close unless busy. */
export function Dialog({ open, title, description, busy = false, onClose, children, footer }: {
  open: boolean; title: string; description?: string; busy?: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  busyRef.current = busy;
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const trigger = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    // First editable field if there is one, otherwise the first control.
    (node?.querySelector<HTMLElement>("input:not([readonly]):not([disabled]),select:not([disabled])") ?? focusables()[0] ?? node)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (!busyRef.current) { event.stopPropagation(); closeRef.current(); } return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1], active = document.activeElement;
      if (event.shiftKey && (active === first || !node?.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !node?.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); trigger?.focus?.(); };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground-950/40" onClick={() => { if (!busy) onClose(); }} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} tabIndex={-1}
        className="relative z-10 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card border border-background-200 bg-background-50 p-6 shadow-xl focus:outline-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="font-heading text-lg font-bold text-foreground-950">{title}</h2>
            {description ? <p id={descId} className="mt-1.5 text-sm text-foreground-600">{description}</p> : null}
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close dialog"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-50">
            <i className="ri-close-line text-lg" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-5">{children}</div>
        {footer ? <div className="mt-6 flex flex-wrap justify-end gap-3">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Auto-dismissing success message, announced politely. */
// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with the dialog it serves
export function useToast(): { toast: ReactNode; show: (message: string) => void } {
  const [message, setMessage] = useState("");
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const show = (next: string) => {
    setMessage(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(""), 5000);
  };
  const toast = (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[90]" role="status" aria-live="polite">
      {message ? (
        <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-secondary-200 bg-secondary-50 px-4 py-3 text-sm text-secondary-900 shadow-lg">
          <i className="ri-checkbox-circle-line" aria-hidden="true" />{message}
        </div>
      ) : null}
    </div>
  );
  return { toast, show };
}
