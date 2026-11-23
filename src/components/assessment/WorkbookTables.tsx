/**
 * ASM-WORKBOOK items 3 and 7 on screen, drawn from the shared layout (src/lib/assessment/workbookLayout.ts) that "Export as workbook
 * PDF" prints: the workbook's two-column tables with tick boxes, the student / trainer / qualification details, and Appendix A –
 * Reasonable Adjustments. Used by the student's assessment page, the wizard's Review step and the trainer's view.
 */
import type { ReactNode } from "react";
import type { Question } from "@/lib/assessment/types";
import { adjustmentLayout, detailRows, qualificationRows, type LayoutCell, type WorkbookDetails } from "@/lib/assessment/workbookLayout";

/** A workbook tick box ("☐ Yes"), drawn, not a font glyph. */
export function TickBox({ on = false }: { on?: boolean }) {
  return (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center border border-foreground-700 align-[-2px] text-[10px] leading-none text-foreground-900" aria-hidden="true">{on ? "✓" : ""}</span>
  );
}

const cellView = (c: LayoutCell, placeholder?: string): ReactNode => {
  if (typeof c !== "string") {
    return <span className="flex flex-wrap items-center gap-x-4 gap-y-1">{c.ticks.map(([label, on], i) => <span key={`${label}-${i}`} className="inline-flex items-center gap-1.5"><TickBox on={on} />{label ? <span>{label}</span> : <span className="sr-only">{on ? "Applied" : "Not applied"}</span>}</span>)}</span>;
  }
  return c ? <span className="whitespace-pre-wrap break-words">{c}</span> : placeholder ? <span className="italic text-foreground-400">{placeholder}</span> : <span className="block h-4" />;
};

/** The workbook's label / value table (label column shaded). */
export function WorkbookTable({ rows, head, testId, placeholder, compact = false }: {
  rows: [string, LayoutCell][];
  /** A header row (e.g. "Reasonable adjustment strategy | Applied"); then the rows are plain, not labelled. */
  head?: [string, string];
  testId?: string;
  /** Shown in an empty value cell (the review: "Filled in for each student"). */
  placeholder?: string;
  compact?: boolean;
}) {
  const pad = compact ? "px-2 py-1" : "px-2 py-1.5";
  return (
    <table className="w-full border-collapse text-[12px] text-foreground-900" data-testid={testId}>
      {head ? <thead><tr><th className={`border border-foreground-400 bg-background-100 ${pad} text-left font-semibold`}>{head[0]}</th><th className={`w-24 border border-foreground-400 bg-background-100 ${pad} text-left font-semibold`}>{head[1]}</th></tr></thead> : null}
      <tbody>{rows.map(([label, value], i) => (
        <tr key={`${label}-${i}`}>
          {head ? <td className={`border border-foreground-400 ${pad}`}>{label}</td> : <th scope="row" className={`w-[30%] border border-foreground-400 bg-background-100 ${pad} text-left align-top font-semibold`}>{label}</th>}
          <td className={`border border-foreground-400 ${pad} align-top`}>{cellView(value, placeholder)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

/** Cover sections 1 and 2: the student and trainer details, then the qualification and unit (item 3). */
export function DetailsTables({ details, placeholder, testId }: { details: WorkbookDetails; placeholder?: string; testId?: string }) {
  return (
    <div className="space-y-3" data-testid={testId}>
      <div>
        <h3 className="mb-1.5 text-sm font-bold text-foreground-950">1. Student and trainer details</h3>
        <WorkbookTable rows={detailRows(details)} placeholder={placeholder} testId={testId ? `${testId}-people` : undefined} />
      </div>
      <div>
        <h3 className="mb-1.5 text-sm font-bold text-foreground-950">2. Qualification and unit of competency</h3>
        <WorkbookTable rows={qualificationRows(details.qualification, details.unit)} placeholder={placeholder} testId={testId ? `${testId}-qualification` : undefined} />
      </div>
    </div>
  );
}

/** Appendix A – Reasonable Adjustments as the workbook lays it out (item 7): facts, the strategy matrix, the assessor's sign-off. */
export function AdjustmentSheet({ q, value, note }: { q: Question; value: unknown; note?: ReactNode }) {
  const lay = adjustmentLayout(q, value, (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" }));
  return (
    <div className="space-y-2" data-testid="adjustment-sheet">
      {note}
      {lay.intro ? <p className="whitespace-pre-wrap text-xs text-foreground-600">{lay.intro}</p> : null}
      <WorkbookTable rows={lay.facts} compact />
      {lay.strategies.length ? <WorkbookTable head={["Reasonable adjustment strategy", "Applied"]} rows={lay.strategies.map(([text, on]) => [text, { ticks: [["", on]] }])} compact /> : null}
      {lay.declaration ? <p className="text-xs text-foreground-600">{lay.declaration}</p> : null}
      <WorkbookTable rows={lay.sign} compact />
    </div>
  );
}
