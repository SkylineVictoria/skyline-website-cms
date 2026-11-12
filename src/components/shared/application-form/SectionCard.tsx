import { useEffect, useState, type ReactNode } from "react";
import InfoTip from "./InfoTip";

/**
 * One step on a stage page: white card, 1px border, 12px radius, 24px padding. Open, it shows the title (with an (i) for longer
 * help), at most one short subtitle, a note and the step's fields. Closed, it is one line: ✓ (or ⚠), the title, a summary of the
 * answers, and Edit. Opening and closing animate the height; the fields stay mounted either way (their values are read from the
 * form), closed ones are inert. A card not on the current stage is hidden, and slides in from the side its stage was reached from.
 */
export default function SectionCard({ id, sectionKey, title, tip, subtitle, note, shown, expanded, complete, summary, direction = "forward", onToggle, children }: {
  id: string;
  /** The step's key (also its URL hash). */
  sectionKey: string;
  title: string;
  tip?: string;
  subtitle?: string;
  note?: ReactNode;
  /** On the current stage (and applicable to this student). */
  shown: boolean;
  expanded: boolean;
  complete: boolean;
  /** The closed card's one line of answers. */
  summary?: string;
  direction?: "forward" | "back";
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  // Visible overflow only once fully open, so dropdowns and focus rings are not cut off, and nothing spills while it animates.
  const [settled, setSettled] = useState(expanded);
  useEffect(() => {
    if (!expanded) { setSettled(false); return undefined; }
    const timer = window.setTimeout(() => setSettled(true), 220);
    return () => window.clearTimeout(timer);
  }, [expanded]);

  return (
    <section
      aria-labelledby={id}
      id={`section-${sectionKey}`}
      data-section={sectionKey}
      data-current-step={shown ? "true" : undefined}
      data-expanded={expanded ? "true" : "false"}
      hidden={!shown}
      className={`scroll-mt-24 rounded-xl border bg-background-50 transition-colors duration-200 ${expanded ? "border-background-200 p-4 sm:p-6" : "border-background-200 px-4 py-3 sm:px-6"} ${shown ? (direction === "back" ? "step-in-back" : "step-in-forward") : ""}`}
    >
      {expanded ? (
        <div className="mb-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
            <div className="flex items-center gap-1.5">
              <h3 id={id} className="font-heading text-lg font-semibold text-foreground-950">{title}</h3>
              {tip ? <InfoTip text={tip} label={`About ${title}`} /> : null}
            </div>
            <div className="flex items-center gap-3">
              {note}
              {complete ? (
                <button type="button" onClick={() => onToggle(false)} className="cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-foreground-600 transition-colors hover:bg-background-100 hover:text-foreground-900">
                  Done<span className="sr-only"> with {title}</span>
                </button>
              ) : null}
            </div>
          </div>
          {subtitle ? <p className="mt-0.5 text-sm text-foreground-500">{subtitle}</p> : null}
        </div>
      ) : (
        <button type="button" onClick={() => onToggle(true)} aria-expanded={false} className="group flex w-full cursor-pointer items-center gap-2.5 text-left">
          {complete
            ? <i className="ri-check-line text-base leading-none text-emerald-700" aria-label="Complete" />
            : <i className="ri-error-warning-line text-base leading-none text-amber-600" aria-label="Needs details" />}
          <h3 id={id} className="shrink-0 text-sm font-semibold text-foreground-950">{title}</h3>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground-500">
            {summary ? <><span aria-hidden="true">&middot; </span>{summary}</> : complete ? null : "Needs details"}
          </span>
          <span className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-foreground-600 transition-colors group-hover:bg-background-100 group-hover:text-foreground-900">
            Edit<span className="sr-only"> {title}</span>
          </span>
        </button>
      )}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className={expanded && settled ? "min-h-0" : "min-h-0 overflow-hidden"} inert={!expanded}>
          {children}
        </div>
      </div>
    </section>
  );
}
