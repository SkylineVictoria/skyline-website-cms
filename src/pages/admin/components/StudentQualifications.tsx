import { useEffect, useState } from "react";
import { Card } from "@/pages/admin/components/ui";
import { ListMessage } from "@/pages/admin/components/ListControls";
import QualificationsTable from "@/pages/admin/components/QualificationsTable";
import { listQualifications, type QualificationRow } from "@/lib/qualification";

/** Student page › Qualification tab: each course the student is enrolled in (course, intake, status, dates). */
export default function StudentQualifications({ studentId }: { studentId: string }) {
  const [rows, setRows] = useState<QualificationRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    listQualifications({ studentId }).then((data) => { if (live) setRows(data); }, (e) => { if (live) { setRows([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [studentId]);
  return (
    <div data-testid="student-qualifications"><Card>
      <h2 className="border-b border-background-200 px-4 py-3 font-heading text-base font-semibold text-foreground-900">Qualification <span className="font-normal text-foreground-500">{rows?.length ?? ""}</span></h2>
      {error ? <p className="p-4 text-sm text-red-700" role="alert">{error}</p>
        : rows === null ? <p className="p-4 text-sm text-foreground-500">Loading…</p>
        : rows.length ? <QualificationsTable rows={rows} showStudent={false} />
        : <ListMessage icon="ri-graduation-cap-line" title="No Qualification" text="This student is not enrolled in a course yet. A Qualification is created when an application is marked Enrolled, or by Re-add to intake." />}
    </Card></div>
  );
}
