import { useEffect, useState } from "react";
import { Card } from "@/pages/admin/components/ui";
import ProgressList, { type Progress } from "@/components/assessment/ProgressList";
import { asmAdmin } from "@/pages/admin/lib/assessments";
import AttemptDrawer from "./AttemptDrawer";

/** Student page: competency progress across the units of their batches. */
export default function StudentProgressPanel({ studentId }: { studentId: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState<string | null>(null);
  useEffect(() => { void asmAdmin<Progress>("student_progress", { studentId }).then(setProgress).catch((e) => setError(e instanceof Error ? e.message : "Not loaded.")); }, [studentId]);
  return (
    <Card className="p-5">
      <h2 className="mb-3 font-heading text-[15px] font-semibold text-foreground-900">Assessments and competency</h2>
      {error ? <p className="text-sm text-foreground-600">{error.includes("Only an Admin") ? "Assessment progress is visible to Admins and RTO Managers." : error}</p> : progress ? <ProgressList progress={progress} onOpenAttempt={setAttempt} /> : <p className="text-sm text-foreground-600">Loading…</p>}
      {attempt ? <AttemptDrawer attemptId={attempt} onClose={() => setAttempt(null)} /> : null}
    </Card>
  );
}
