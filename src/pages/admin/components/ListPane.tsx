// A list column (courses, intakes, ...) on the left of an LMS page that can be folded into a thin rail, so the page's main
// content gets the width. The choice is remembered per page in this browser. On small screens the list is always shown.
import type { ReactNode } from "react";
import type { Pane } from "@/pages/admin/lib/listPane";

/** Wraps the page's list column. Folded: a rail with the list's name and the item chosen in it; a click opens it again. */
export default function ListPane({ pane, label, current, children }: { pane: Pane; label: string; current?: string | null; children: ReactNode }) {
  if (pane.folded) return <>
    <div className="min-w-0 lg:hidden">{children}</div>
    <button type="button" onClick={pane.toggle} aria-label={`Show the ${label.toLowerCase()} list`} title={`Show ${label.toLowerCase()}`}
      className="sticky top-16 hidden min-h-[160px] w-12 flex-col items-center gap-3 rounded-2xl border border-background-200 bg-background-50 py-3 text-foreground-600 shadow-sm transition-colors hover:border-primary-300 hover:text-primary-700 lg:flex">
      <i className="ri-side-bar-line text-lg" aria-hidden="true" />
      <span className="text-xs font-semibold [writing-mode:vertical-rl]">{current ? `${label}: ${current}` : label}</span>
    </button>
  </>;
  return <div className="relative min-w-0">
    {children}
    <button type="button" onClick={pane.toggle} aria-label={`Hide the ${label.toLowerCase()} list`} title={`Hide ${label.toLowerCase()} (more room for the page)`}
      className="absolute -right-3 top-4 z-10 hidden h-6 w-6 items-center justify-center rounded-full border border-background-300 bg-background-50 text-foreground-600 shadow-sm hover:border-primary-400 hover:text-primary-700 lg:flex">
      <i className="ri-arrow-left-s-line" aria-hidden="true" />
    </button>
  </div>;
}
