import { useState, type ReactNode } from "react";

export interface ReviewStep {
  /** The step's index in the form (what Edit opens). */
  index: number;
  title: string;
  /** What still needs doing on the step; empty when it is complete. */
  issues: string[];
  rows: Array<{ key: string; label: string; value: string; note?: ReactNode }>;
}

/**
 * Review & submit as a compact list: "13 of 14 complete", steps that need something first (⚠, with Fix), then the rest (✓, Edit).
 * Each row opens to the step's answers as a tight label / value grid. What follows (declaration, Submit) is the caller's.
 */
export default function ReviewSummary({ steps, meta, readOnly, onEdit, children }: {
  steps: readonly ReviewStep[];
  meta?: string;
  readOnly?: boolean;
  onEdit: (index: number) => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (index: number) => setOpen((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  const complete = steps.filter((step) => step.issues.length === 0).length;
  const ordered = [...steps.filter((step) => step.issues.length > 0), ...steps.filter((step) => step.issues.length === 0)];

  return (
    <div className="rounded-xl border border-background-200 bg-background-50 p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-heading text-lg font-semibold text-foreground-950">Review &amp; submit</h3>
        <p className="text-sm text-foreground-600" data-testid="review-complete">
          <span className="font-semibold text-foreground-950">{complete} of {steps.length}</span> complete
        </p>
      </div>
      {meta ? <p className="mt-0.5 truncate text-xs text-foreground-500">{meta}</p> : null}

      <ul className="mt-4 divide-y divide-background-200 border-y border-background-200" aria-label="Steps">
        {ordered.map((step) => {
          const expanded = open.has(step.index);
          const ok = step.issues.length === 0;
          return (
            <li key={step.index}>
              <div className="flex items-center gap-2 py-2">
                <button type="button" aria-expanded={expanded} onClick={() => toggle(step.index)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md py-0.5 text-left transition-colors duration-150 hover:text-foreground-950">
                  {ok
                    ? <i className="ri-check-line text-base leading-none text-emerald-700" aria-label="Complete" />
                    : <i className="ri-error-warning-line text-base leading-none text-amber-600" aria-label="Needs attention" />}
                  <span className="min-w-0 truncate text-sm text-foreground-900">{step.title}</span>
                  {!ok ? <span className="hidden shrink-0 text-xs text-amber-700 sm:inline">{step.issues.length} to fix</span> : null}
                  <i className={`ml-auto text-base leading-none text-foreground-400 transition-transform duration-200 ri-arrow-down-s-line ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
                </button>
                {readOnly ? null : (
                  <button type="button" onClick={() => onEdit(step.index)} className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-foreground-600 transition-colors duration-150 hover:bg-background-100 hover:text-foreground-900">
                    {ok ? "Edit" : "Fix"}<span className="sr-only"> {step.title}</span>
                  </button>
                )}
              </div>
              {expanded ? (
                <div className="open-in pb-3 pl-6">
                  {!ok ? (
                    <ul className="mb-2 space-y-0.5 text-xs text-amber-800">
                      {step.issues.map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                  ) : null}
                  {step.rows.length ? (
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                      {step.rows.map((row) => (
                        <div key={row.key} className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 text-[13px] leading-5">
                          <dt className="truncate text-foreground-500" title={row.label}>{row.label}{row.note}</dt>
                          <dd className="break-words text-foreground-900">{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : ok ? <p className="text-xs text-foreground-500">Nothing entered on this step.</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {children}
    </div>
  );
}
