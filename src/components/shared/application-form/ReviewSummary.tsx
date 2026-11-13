import { useState, type ReactNode } from "react";

export interface ReviewStep {
  /** The step's index in the form (what Edit opens). */
  index: number;
  title: string;
  /** What still needs doing on the step; empty when it is complete. */
  issues: string[];
  rows: Array<{ key: string; label: string; value: string; note?: ReactNode }>;
}

export interface ReviewGroup { key: string; title: string; steps: ReviewStep[] }

/** One missing or invalid item: Fix scrolls to the exact field and puts the cursor in it. */
export interface ReviewIssue { key: string; step: string; text: string; onJump: () => void }

/**
 * Review & submit: "13 of 14 complete", every missing or invalid item first (each a link to its field), then the steps grouped by
 * stage, one row each (✓ / ⚠, Edit), opening to a tight label / value grid. What follows (declaration, Submit) is the caller's.
 */
export default function ReviewSummary({ groups, issues = [], meta, readOnly, onEdit, children }: {
  groups: readonly ReviewGroup[];
  issues?: readonly ReviewIssue[];
  meta?: string;
  readOnly?: boolean;
  onEdit: (index: number) => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (index: number) => setOpen((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  const steps = groups.flatMap((group) => group.steps);
  const complete = steps.filter((step) => step.issues.length === 0).length;

  return (
    <div className="rounded-xl border border-background-200 bg-background-50 p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-heading text-lg font-semibold text-foreground-950">Review &amp; submit</h3>
        <p className="text-sm text-foreground-600" data-testid="review-complete">
          <span className="font-semibold text-foreground-950">{complete} of {steps.length}</span> complete
        </p>
      </div>
      {meta ? <p className="mt-0.5 truncate text-xs text-foreground-500">{meta}</p> : null}

      {issues.length ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3" data-testid="review-issues">
          <p className="flex items-center gap-1.5 text-sm font-medium text-amber-900">
            <i className="ri-error-warning-line text-base leading-none" aria-hidden="true" />
            {issues.length === 1 ? "1 item needs attention before you can submit" : `${issues.length} items need attention before you can submit`}
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {issues.map((issue) => (
              <li key={issue.key}>
                <button type="button" onClick={issue.onJump} className="group inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left text-label text-amber-950 transition-colors hover:bg-amber-100">
                  <span className="truncate"><span className="text-amber-800">{issue.step}:</span> {issue.text}</span>
                  <i className="ri-arrow-right-line text-sm leading-none text-amber-700 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {groups.map((group) => (
        <section key={group.key} className="mt-4" aria-label={group.title}>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-500">{group.title}</p>
          <ul className="divide-y divide-background-200 border-y border-background-200" aria-label="Steps">
            {group.steps.map((step) => {
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
                            <div key={row.key} className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 text-label leading-5">
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
        </section>
      ))}
      {children}
    </div>
  );
}
