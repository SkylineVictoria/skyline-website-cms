import { useCallback, useState, type ReactNode } from "react";
import StepDrawer, { type NavStage } from "./StepDrawer";

const SMALL_BUTTON = "inline-flex h-8 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg px-3 text-label font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50";

export interface FooterPrimary {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  testId?: string;
}

/**
 * The frame of a staged form: a slim top bar with the stages as clickable segments (✓ done, current, ⚠ needs details; a compact
 * "Stage 2 of 4" bar on phones), the overall %, the save status and All steps (StepDrawer, with every step nested under its stage);
 * an optional soft notice; the stage's cards; one sticky footer (Previous | Save draft | Next) below them. Stages and steps come
 * from the caller's config.
 */
export default function StepShell({ stages, current, percent, status, notice, onSelectStage, onSelectSection, onPrevious, previousDisabled, onSaveDraft, message, primary, children }: {
  stages: readonly NavStage[];
  /** Index into stages. */
  current: number;
  percent: number;
  /** Small muted save status ("Saved 10:42"). */
  status?: ReactNode;
  /** A soft, non-blocking line under the bar (what an earlier stage still needs). */
  notice?: ReactNode;
  onSelectStage: (index: number) => void;
  onSelectSection: (index: number) => void;
  onPrevious?: () => void;
  previousDisabled?: boolean;
  onSaveDraft?: () => void;
  /** A short line about the stage (what still needs details); it never stops Next. */
  message?: ReactNode;
  primary?: FooterPrimary | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const numbered = stages.filter((stage) => !stage.final).length;
  const here = stages[current];

  return (
    <>
      <div className="mb-2" data-testid="form-step-nav">
        <div className="flex items-center gap-2">
          {/* Phones: one compact line. */}
          <p className="min-w-0 flex-1 truncate text-sm sm:hidden" data-testid="stage-compact">
            {here?.final ? <span className="font-semibold text-foreground-950">{here.title}</span> : (
              <>
                <span className="text-foreground-500">Stage {current + 1} of {numbered}</span>
                <span className="mx-1.5 text-foreground-300" aria-hidden="true">&middot;</span>
                <span className="font-semibold text-foreground-950">{here?.title}</span>
              </>
            )}
          </p>
          {/* Wider screens: the stages as segments. */}
          <nav aria-label="Stages" className="hidden min-w-0 flex-1 sm:block">
            <ol className="flex items-center gap-1 rounded-lg border border-background-200 bg-background-100 p-0.5">
              {stages.map((stage, index) => {
                const active = index === current;
                return (
                  <li key={stage.key} className={stage.final ? "shrink-0" : "min-w-0 flex-1"}>
                    <button
                      type="button"
                      aria-current={active ? "step" : undefined}
                      onClick={() => onSelectStage(index)}
                      className={`flex h-8 w-full min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-label transition-colors duration-150 ${active ? "bg-background-50 font-medium text-primary-700 shadow-sm ring-1 ring-background-200" : "text-foreground-600 hover:bg-background-50/70 hover:text-foreground-900"}`}
                    >
                      {stage.state === "done" && !active ? <i className="ri-check-line text-base leading-none text-emerald-700" aria-label="done" />
                        : stage.state === "issue" && !active ? <i className="ri-error-warning-line text-base leading-none text-amber-600" aria-label="needs details" />
                          : stage.final ? <i className="ri-file-list-3-line text-base leading-none" aria-hidden="true" />
                            : <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-semibold ${active ? "bg-primary-500 text-background-50" : "bg-background-200 text-foreground-600"}`} aria-hidden="true">{index + 1}</span>}
                      <span className="truncate">{stage.title}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <span className="hidden shrink-0 text-xs font-medium text-foreground-700 sm:inline" data-testid="overall-percent">{percent}%</span>
          {status ? <span className="hidden shrink-0 text-xs text-foreground-500 lg:inline-flex" data-testid="save-status">{status}</span> : null}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-background-300 bg-background-50 px-2.5 text-xs font-medium text-foreground-700 transition-colors duration-150 hover:bg-background-100"
          >
            <i className="ri-list-check text-base leading-none" aria-hidden="true" />
            All steps
          </button>
        </div>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-background-200" role="progressbar" aria-label="Application progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full rounded-full bg-primary-500 transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
        {status ? <p className="mt-1 text-xs text-foreground-500 lg:hidden"><span className="sm:hidden">{percent}% &middot; </span>{status}</p> : null}
      </div>
      {notice ? <div className="fade-in mb-3">{notice}</div> : null}

      {children}

      <div className="sticky bottom-0 z-30 mt-2 border-t border-background-200 bg-background-50/85 px-1 py-2 backdrop-blur-md" data-testid="form-footer">
        <div className="flex flex-wrap items-center gap-2">
          {onPrevious ? (
            <button type="button" onClick={onPrevious} disabled={previousDisabled} className={`${SMALL_BUTTON} border border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100`}>
              <i className="ri-arrow-left-line text-base leading-none" aria-hidden="true" />
              Previous
            </button>
          ) : null}
          {message ? <div className="order-first min-w-0 basis-full sm:order-none sm:basis-auto sm:flex-1">{message}</div> : null}
          <div className={message ? "flex-1 sm:hidden" : "flex-1"} />
          {onSaveDraft ? (
            <button type="button" onClick={onSaveDraft} className={`${SMALL_BUTTON} px-2 text-foreground-600 hover:bg-background-100 hover:text-foreground-900`}>
              Save draft
            </button>
          ) : null}
          {primary ? (
            <button type="button" onClick={primary.onClick} disabled={primary.disabled || primary.busy} data-testid={primary.testId} className={`${SMALL_BUTTON} bg-primary-500 text-background-50 hover:bg-primary-600 focus-visible:ring-2 focus-visible:ring-primary-400/60`}>
              {primary.busy ? (
                <>
                  <i className="ri-loader-4-line animate-spin text-base leading-none" aria-hidden="true" />
                  {primary.busyLabel ?? primary.label}
                </>
              ) : (
                <>
                  {primary.label}
                  {primary.icon ? <i className={`${primary.icon} text-base leading-none`} aria-hidden="true" /> : null}
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>

      {open ? <StepDrawer stages={stages} current={current} onSelectStage={onSelectStage} onSelectSection={onSelectSection} onClose={close} /> : null}
    </>
  );
}

/** The footer's short, soft line about the stage ("2 sections still need details"); Next still moves on. */
export function FooterMessage({ children }: { children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-amber-800" role="status" data-step-missing="true">
      <i className="ri-error-warning-line text-base leading-none" aria-hidden="true" />
      <span className="min-w-0 truncate" title={typeof children === "string" ? children : undefined}>{children}</span>
    </p>
  );
}
