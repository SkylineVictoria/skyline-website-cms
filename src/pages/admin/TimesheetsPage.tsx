import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AdminError, AdminLoading, PageHeader } from "@/pages/admin/components/ui";
import TimesheetTable from "@/pages/admin/components/hrms/TimesheetTable";
import { myTeam, type MyTeam } from "@/lib/hrmsApi";

/** Staff > Timesheets: every employee's hours per pay period, corrections, approvals and the period lock (HR). */
export default function TimesheetsPage() {
  const [params] = useSearchParams();
  const [team, setTeam] = useState<MyTeam | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setError(""); setTeam(await myTeam()); } catch (e) { setError(e instanceof Error ? e.message : "The timesheets could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div>
      <PageHeader breadcrumb="Staff" title="Timesheets" description="Hours worked, breaks, leave and public holidays per pay period. The manager or HR approves each timesheet; HR locks the period, which accrues leave, and exports it to Xero." />
      {error ? <AdminError message={error} onRetry={() => void load()} /> : !team ? <AdminLoading label="Loading timesheets…" /> : <TimesheetTable team={team} admin initialPeriodId={params.get("period") ?? undefined} />}
    </div>
  );
}
