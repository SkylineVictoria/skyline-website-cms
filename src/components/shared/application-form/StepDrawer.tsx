import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type StepState = "done" | "current" | "pending" | "issue";

export interface NavSection { index: number; key: string; title: string; state: StepState }

export interface NavStage {
  key: string;
  title: string;
  state: StepState;
  sections: NavSection[];
  /** The final, unnumbered page (Review & submit). */
  final?: boolean;
}

/**
 * Every stage with its steps nested underneath (✓ done, ● current, ○ pending, ⚠ needs details); a stage or a step is one click
 * away. A slide-over from the right (360px) on desktop, a full-height sheet from the bottom on phones. Escape or the backdrop closes it.
 */
export default function StepDrawer({ stages, current, onSelectStage, onSelectSection, onClose }: {
  stages: readonly NavStage[];
  current: number;
  onSelectStage: (index: number) => void;
  onSelectSection: (index: number) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const sections = stages.flatMap((stage) => stage.sections);
  const done = sections.filter((section) => section.state === "done").length;

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
            <p className="text-xs text-foreground-500">{done} of {sections.length} sections complete</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 transition-colors hover:bg-background-100 hover:text-foreground-900">
            <i className="ri-close-line text-base" aria-hidden="true" />
          </button>
        </div>
        <ol className="flex-1 overflow-y-auto p-2">
          {stages.map((stage, index) => {
            const active = index === current;
            return (
              <li key={stage.key} className="mb-1">
                <button
                  type="button"
                  aria-current={active ? "step" : undefined}
                  onClick={() => { onClose(); onSelectStage(index); }}
                  className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${active ? "bg-primary-50 text-foreground-950" : "text-foreground-800 hover:bg-background-100"}`}
                >
                  <StepMark state={active ? "current" : stage.state} final={stage.final} />
                  <span className="min-w-0 flex-1 truncate">{stage.final ? stage.title : `${index + 1}. ${stage.title}`}</span>
                </button>
                {stage.sections.length ? (
                  <ul className="mb-1 ml-5 border-l border-background-200 pl-2">
                    {stage.sections.map((section) => (
                      <li key={section.key}>
                        <button
                          type="button"
                          onClick={() => { onClose(); onSelectSection(section.index); }}
                          className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-label text-foreground-700 transition-colors hover:bg-background-100"
                        >
                          <StepMark state={section.state} small />
                          <span className="min-w-0 flex-1 truncate">{section.title}</span>
                          <span className="sr-only">{section.state === "done" ? "(done)" : section.state === "issue" ? "(needs details)" : "(not done)"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>,
    document.body,
  );
}

function StepMark({ state, final, small }: { state: StepState; final?: boolean; small?: boolean }) {
  const base = `flex ${small ? "h-4 w-4 text-sm" : "h-5 w-5 text-base"} shrink-0 items-center justify-center leading-none`;
  if (final) return <i className={`ri-file-list-3-line ${base} ${state === "current" ? "text-primary-600" : "text-foreground-500"}`} aria-hidden="true" />;
  if (state === "current") return <span className={base} aria-hidden="true"><span className="h-2.5 w-2.5 rounded-full bg-primary-500" /></span>;
  if (state === "done") return <i className={`ri-check-line ${base} text-emerald-700`} aria-hidden="true" />;
  if (state === "issue") return <i className={`ri-error-warning-line ${base} text-amber-600`} aria-hidden="true" />;
  return <span className={base} aria-hidden="true"><span className="h-2.5 w-2.5 rounded-full border border-foreground-400" /></span>;
}
