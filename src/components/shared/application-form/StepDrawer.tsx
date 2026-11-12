import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type StepState = "done" | "current" | "pending" | "issue";

export interface NavStep {
  key: string;
  title: string;
  state: StepState;
  /** A final, unnumbered entry (Review & submit). */
  final?: boolean;
}

/**
 * Every step with its status (✓ done, ● current, ○ pending, ⚠ needs attention); a click jumps there. A slide-over from the right
 * (360px) on desktop, a full-height sheet from the bottom on phones. Escape or a click on the backdrop closes it.
 */
export default function StepDrawer({ steps, current, onSelect, onClose }: {
  steps: readonly NavStep[];
  current: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const numbered = steps.filter((step) => !step.final).length;
  const done = steps.filter((step) => !step.final && step.state === "done").length;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLButtonElement>('[aria-current="step"]')?.focus();
    return () => { document.removeEventListener("keydown", onKey); opener?.focus?.(); };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[85]" role="presentation">
      <div className="drawer-backdrop absolute inset-0 bg-foreground-950/30" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="All steps"
        className="drawer-panel absolute inset-x-0 bottom-0 top-0 flex flex-col bg-background-50 sm:left-auto sm:w-[360px] sm:border-l sm:border-background-200 sm:shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-background-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-foreground-950">All steps</p>
            <p className="text-xs text-foreground-500">{done} of {numbered} complete</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 transition-colors hover:bg-background-100 hover:text-foreground-900">
            <i className="ri-close-line text-base" aria-hidden="true" />
          </button>
        </div>
        <ol className="flex-1 overflow-y-auto p-2">
          {steps.map((step, index) => {
            const active = index === current;
            return (
              <li key={step.key}>
                <button
                  type="button"
                  aria-current={active ? "step" : undefined}
                  onClick={() => { onClose(); onSelect(index); }}
                  className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${active ? "bg-primary-50 font-medium text-foreground-950" : "text-foreground-700 hover:bg-background-100"}`}
                >
                  <StepMark step={step} active={active} />
                  <span className="min-w-0 flex-1 truncate">{step.final ? step.title : `${index + 1}. ${step.title}`}</span>
                  <span className="sr-only">{active ? "(current)" : step.state === "done" ? "(done)" : step.state === "issue" ? "(needs attention)" : "(not done)"}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>,
    document.body,
  );
}

function StepMark({ step, active }: { step: NavStep; active: boolean }) {
  const base = "flex h-5 w-5 shrink-0 items-center justify-center text-base leading-none";
  if (step.final) return <i className={`ri-file-list-3-line ${base} ${active ? "text-primary-600" : "text-foreground-500"}`} aria-hidden="true" />;
  if (active) return <span className={base} aria-hidden="true"><span className="h-2.5 w-2.5 rounded-full bg-primary-500" /></span>;
  if (step.state === "done") return <i className={`ri-check-line ${base} text-emerald-700`} aria-hidden="true" />;
  if (step.state === "issue") return <i className={`ri-error-warning-line ${base} text-amber-600`} aria-hidden="true" />;
  return <span className={base} aria-hidden="true"><span className="h-2.5 w-2.5 rounded-full border border-foreground-400" /></span>;
}
