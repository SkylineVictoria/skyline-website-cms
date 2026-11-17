// Course wizard > Intakes: students allocated to an intake who have no seat in a batch yet (no batch could be made for them), with a Place button.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/pages/admin/components/ui";
import { ErrorNote } from "@/pages/admin/components/rto/shared";
import { rtoPlace, shortDate, type Placed, type UnplacedStudent } from "@/pages/admin/lib/rto";

export default function NeedsBatch({ courseId, canEnrol, onPlaced }: { courseId: string; canEnrol: boolean; onPlaced: () => void }) {
  const [list, setList] = useState<UnplacedStudent[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(() => { void rtoPlace<UnplacedStudent[]>("unplaced").then((all) => setList(all.filter((s) => s.courseId === courseId))).catch(() => setList([])); }, [courseId]);
  useEffect(load, [load]);
  if (!list.length) return null;
  const place = async (s: UnplacedStudent) => {
    setBusy(s.studentId); setError("");
    try { await rtoPlace<Placed>("assign", { studentId: s.studentId, intakeId: s.intakeId }); load(); onPlaced(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not placed."); }
    finally { setBusy(""); }
  };
  return (
    <div className="mb-4 rounded-card border border-amber-300 bg-amber-50 p-4" data-testid="needs-batch" role="status">
      <p className="text-sm font-medium text-amber-900">{list.length} student{list.length === 1 ? "" : "s"} allocated to an intake without a seat in a batch</p>
      <ErrorNote text={error} />
      <ul className="mt-2 divide-y divide-amber-200 text-sm">
        {list.map((s) => (
          <li key={`${s.intakeId}-${s.studentId}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>{s.name} <span className="text-foreground-500">· intake starting {shortDate(s.intakeStart)}</span></span>
            {canEnrol ? <Button size="sm" variant="outline" disabled={busy === s.studentId} onClick={() => void place(s)}>{busy === s.studentId ? "Placing…" : "Place in a batch"}</Button> : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-amber-900">Set the course&apos;s usual classes above so a batch can be opened automatically.</p>
    </div>
  );
}
