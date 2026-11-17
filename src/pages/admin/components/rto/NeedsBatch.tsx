// Course wizard > Intakes: students whose offer is accepted but who are not in a batch yet. Nothing to click: placement is automatic and retries by itself
// (every 15 minutes, and as soon as the course's usual classes are saved). This only explains why they are waiting.
import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

interface Waiting { studentId: string; name: string; courseId: string; courseName: string }

export default function NeedsBatch({ courseId }: { courseId: string; canEnrol?: boolean; onPlaced?: () => void }) {
  const [list, setList] = useState<Waiting[]>([]);
  useEffect(() => {
    let live = true;
    void supabase.rpc("rto_placement_waiting").then(({ data }) => { if (live) setList(((data ?? []) as Waiting[]).filter((s) => s.courseId === courseId)); });
    return () => { live = false; };
  }, [courseId]);
  if (!list.length) return null;
  return (
    <div className="mb-4 rounded-card border border-amber-300 bg-amber-50 p-4" data-testid="needs-batch" role="status">
      <p className="text-sm font-medium text-amber-900">{list.length} student{list.length === 1 ? "" : "s"} with an accepted offer {list.length === 1 ? "is" : "are"} waiting for a batch</p>
      <p className="mt-1 text-sm text-amber-900">{list.map((s) => s.name).join(", ")}</p>
      <p className="mt-2 text-xs text-amber-900">They are placed automatically as soon as a batch can be opened. Set the course&apos;s usual classes below (days, times, room) and it happens by itself.</p>
    </div>
  );
}
