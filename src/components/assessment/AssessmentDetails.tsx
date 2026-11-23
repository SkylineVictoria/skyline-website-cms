/**
 * ASM-WORKBOOK item 3: the workbook's "Student and trainer details" and "Qualification and unit of competency", filled in by the
 * system on the student's assessment page (never typed by the student). From asm_attempt_history when the database has it, else
 * from what the page already knows (the workbook's qualification / unit, the assignment's unit).
 */
import type { AttemptHistory } from "@/lib/assessment/resultsSheet";
import type { Definition } from "@/lib/assessment/types";

export default function AssessmentDetails({ history, definition, unit }: {
  history: AttemptHistory | null;
  definition: Definition;
  /** The assignment's unit (assessment_open), when the history has none. */
  unit?: { code: string | null; name: string | null } | null;
}) {
  const q = history?.assessment?.qualification ?? definition.source?.qualification ?? null;
  const u = history?.assessment?.unit ?? definition.source?.unit ?? (unit?.code ? { code: unit.code, name: unit.name ?? "" } : null);
  const rows: [string, string][] = [
    ["Student Full Name", history?.student?.name ?? ""],
    ["Student ID", history?.student?.ref ?? ""],
    ["Student Email", history?.student?.email ?? ""],
    ["Trainer Full Name", history?.trainers.join(", ") ?? ""],
    ["Qualification", q ? `${q.code} ${q.name}`.trim() : ""],
    ["Unit of competency", u ? `${u.code} ${u.name}`.trim() : ""],
  ];
  return (
    <section className="mt-4 rounded-card border border-background-200 bg-background-50 p-4" aria-labelledby="asm-details-title" data-testid="assessment-details">
      <h2 id="asm-details-title" className="font-heading text-base font-semibold text-foreground-950">Student, trainer and unit details</h2>
      <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2"><dt className="w-36 shrink-0 text-foreground-500">{k}</dt><dd className="min-w-0 break-words font-medium text-foreground-900">{v || "—"}</dd></div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-foreground-500">Filled in from your enrolment. Tell your trainer if anything is wrong.</p>
    </section>
  );
}
