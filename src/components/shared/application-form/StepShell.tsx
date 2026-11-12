import { useCallback, useState, type ReactNode } from "react";
import StepDrawer, { type NavStep } from "./StepDrawer";

const SMALL_BUTTON = "inline-flex h-8 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50";

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
 * The frame of a multi-step form: a slim top bar ("Step 2 of 14 · Address", a thin progress bar, the save status and All steps,
 * which opens StepDrawer), the step cards, and one sticky footer (Previous | Save draft | Next) below them. Steps and their names
 * come from the caller's step config.
 */
export default function StepShell({ steps, current, percent, status, onSelect, onPrevious, previousDisabled, onSaveDraft, message, primary, children }: {
  steps: readonly NavStep[];
  /** Index into steps. */
  current: number;
  percent: number;
  /** Small muted save status ("Saved 10:42"). */
  status?: ReactNode;
  onSelect: (index: number) => void;
  onPrevious?: () => void;
  previousDisabled?: boolean;
  onSaveDraft?: () => void;
  /** A short line explaining why the step cannot be left yet. */
  message?: ReactNode;
  primary?: FooterPrimary | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const numbered = steps.filter((step) => !step.final).length;
  const here = steps[current];

  return (
    <>
      <div className="mb-2" data-testid="form-step-nav">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-sm text-foreground-700">
            {here?.final ? (
              <span className="font-semibold text-foreground-950">{here.title}</span>
            ) : (
              <>
                <span className="text-foreground-500">Step {current + 1} of {numbered}</span>
                <span className="mx-1.5 text-foreground-300" aria-hidden="true">&middot;</span>
                <span className="font-semibold text-foreground-950">{here?.title}</span>
              </>
            )}
          </p>
          {status ? <span className="hidden shrink-0 text-xs text-foreground-500 sm:inline-flex" data-testid="save-status">{status}</span> : null}
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
        {status ? <p className="mt-1 text-xs text-foreground-500 sm:hidden">{status}</p> : null}
      </div>

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

      {open ? <StepDrawer steps={steps} current={current} onSelect={onSelect} onClose={close} /> : null}
    </>
  );
}

/** The footer's short "why not yet" line. */
export function FooterMessage({ children }: { children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-red-700" role="alert" data-step-missing="true">
      <i className="ri-error-warning-line text-base leading-none" aria-hidden="true" />
      <span className="min-w-0 truncate" title={typeof children === "string" ? children : undefined}>{children}</span>
    </p>
  );
}
