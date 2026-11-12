import type { ReactNode } from "react";
import InfoTip from "./InfoTip";

/**
 * One step's content in one card: white, 1px border, 12px radius, 24px padding; the title with an (i) for longer help, at most one
 * short muted subtitle, and an optional note. Every step's card stays mounted (its inputs keep their values); only the open one
 * is shown, sliding in from the side it was reached from.
 */
export default function SectionCard({ id, title, tip, subtitle, note, open, hidden, direction = "forward", children }: {
  id: string;
  title: ReactNode;
  tip?: string;
  subtitle?: string;
  note?: ReactNode;
  /** The step being shown. */
  open: boolean;
  /** Hidden even when open (a step whose condition is not met). */
  hidden?: boolean;
  direction?: "forward" | "back";
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      data-current-step={open ? "true" : undefined}
      hidden={!open || hidden}
      className={`rounded-xl border border-background-200 bg-background-50 p-4 sm:p-6 ${open ? (direction === "back" ? "step-in-back" : "step-in-forward") : ""}`}
    >
      <div className="mb-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
          <div className="flex items-center gap-1.5">
            <h3 id={id} className="font-heading text-lg font-semibold text-foreground-950">{title}</h3>
            {tip ? <InfoTip text={tip} label={typeof title === "string" ? `About ${title}` : "About this step"} /> : null}
          </div>
          {note}
        </div>
        {subtitle ? <p className="mt-0.5 text-sm text-foreground-500">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}
