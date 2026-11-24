/**
 * ASM-WORKBOOK item 6: the workbook's results sheet on screen. One table per task (Attempt 1-3 at least: Satisfactory / Not
 * Satisfactory, date, assessor, feedback), then the overall result per attempt. Read-only: the marks are made in MarkingView.
 */
import { buildResultsSheet, SHEET_LABEL, type AttemptHistory, type SheetCell } from "@/lib/assessment/resultsSheet";
import { fmtDate } from "@/lib/assessment/api";
import type { Definition } from "@/lib/assessment/types";

function ResultPill({ c }: { c: SheetCell }) {
  if (c.empty) return <span className="text-foreground-400">—</span>;
  if (!c.result) return <span className="text-foreground-500">{c.decided ? "Not recorded" : "Not marked yet"}</span>;
  const tone = c.result === "S" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {SHEET_LABEL[c.result]}{c.decided ? null : <span className="font-normal">(in marking)</span>}
    </span>
  );
}

function SheetTable({ cells, caption }: { cells: SheetCell[]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-background-200 text-xs font-semibold uppercase tracking-wide text-foreground-500">
            <th className="px-2 py-1.5">Attempt</th><th className="px-2 py-1.5">Result</th><th className="px-2 py-1.5">Date</th><th className="px-2 py-1.5">Assessor</th><th className="px-2 py-1.5">Feedback</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => (
            <tr key={c.attemptNo} className="border-b border-background-100 align-top">
              <td className="whitespace-nowrap px-2 py-1.5 font-medium text-foreground-900">{c.attemptNo === 1 ? "First" : c.attemptNo === 2 ? "Second" : c.attemptNo === 3 ? "Third" : `Attempt ${c.attemptNo}`}</td>
              <td className="px-2 py-1.5"><ResultPill c={c} /></td>
              <td className="whitespace-nowrap px-2 py-1.5 text-foreground-700">{c.date ? fmtDate(c.date) : "—"}</td>
              <td className="px-2 py-1.5 text-foreground-700">{c.assessor || (c.empty || !c.result ? "—" : "")}</td>
              <td className="px-2 py-1.5 whitespace-pre-wrap text-foreground-800">{c.feedback || (c.empty ? "" : "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ResultsSheet({ definition, history, maxAttempts = 3, audience = "staff" }: {
  definition: Definition;
  history: AttemptHistory;
  maxAttempts?: number;
  /** "student": no note about missing assessor names. */
  audience?: "staff" | "student";
}) {
  const sheet = buildResultsSheet(definition, history, maxAttempts);
  return (
    <section className="space-y-4 rounded-card border border-background-200 bg-background-50 p-4" aria-labelledby="results-sheet-title" data-testid="results-sheet">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="results-sheet-title" className="font-heading text-base font-semibold text-foreground-950">Results sheet</h3>
        {history.student?.name ? <p className="text-xs text-foreground-600">{history.student.name}{history.student.ref ? ` · Student ID ${history.student.ref}` : ""}</p> : null}
      </div>
      {sheet.rows.map((r) => (
        <div key={r.taskId}>
          <p className="mb-1 text-sm font-semibold text-foreground-900">Assessment Task {r.number} – {r.title}</p>
          <SheetTable cells={r.cells} caption={`Task ${r.number} results by attempt`} />
        </div>
      ))}
      <div>
        <p className="mb-1 text-sm font-semibold text-foreground-900">Overall result</p>
        <SheetTable cells={sheet.overall} caption="Overall result by attempt" />
      </div>
      {!history.complete && audience === "staff" ? <p className="text-xs text-foreground-500">Assessor names and earlier attempts appear here once the results-sheet database update (asm_attempt_history) is released; this shows what this page has loaded.</p> : null}
    </section>
  );
}
