import { useEffect, useState } from "react";
import { Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { rto } from "@/pages/admin/lib/rto";

/** Users › edit: grant or remove the RTO Manager permission (courses, units, fees, intakes, schedules, batches). Admins and RTO Managers only. */
export default function RtoManagerToggle({ userId }: { userId: string }) {
  const { push } = useToast();
  const [state, setState] = useState<{ rtoManager: boolean; canManage: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    rto<{ rtoManager: boolean; canManage: boolean } | null>("rto_role_get", { userId }).then((s) => { if (live) setState(s); }).catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, [userId]);
  if (!state || !state.canManage) return null;
  const change = async (value: boolean) => {
    setBusy(true);
    try { setState(await rto("set_rto_manager", { userId, value })); push(value ? "RTO Manager permission granted." : "RTO Manager permission removed."); }
    catch (e) { push(e instanceof Error ? e.message : "Not changed.", "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-md border border-background-200 p-3">
      <Toggle checked={state.rtoManager} disabled={busy} onChange={(v) => void change(v)} label="RTO Manager" />
      <p className="mt-1 text-xs text-foreground-500">Edits courses, units, fees, intakes, schedules, batches and classrooms. Saved straight away.</p>
    </div>
  );
}
