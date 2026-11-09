import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import TimesheetTable from "@/pages/admin/components/hrms/TimesheetTable";
import LeaveApprovals from "@/pages/admin/components/hrms/LeaveApprovals";
import { myTeam, type MyTeam } from "@/lib/hrmsApi";

/**
 * /staff/team/timesheets and /staff/team/leave: a manager's view of their direct reports (the same tables HR uses; the
 * server scopes every row to the manager's reports). Outside the admin shell, so it works for managers without CMS access.
 */
function TeamShell({ title, kind, children }: { title: string; kind: "timesheets" | "leave"; children: (team: MyTeam) => ReactNode }) {
  const [team, setTeam] = useState<MyTeam | null | undefined>(undefined);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { setSignedOut(true); return; }
      try { setTeam(await myTeam()); } catch (e) { setError(e instanceof Error ? e.message : "Your team could not be loaded."); setTeam(null); }
    });
  }, []);
  if (signedOut) return <Navigate to={`/login?next=${encodeURIComponent(`/staff/team/${kind}`)}`} replace />;
  const allowed = team ? team.isAdmin || team.isManager : false;
  return (
    <div className="min-h-screen bg-background-100 px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-foreground-500"><Link to="/staff" className="hover:underline">My HR</Link> / Team</p>
            <h1 className="font-heading text-2xl font-bold text-foreground-950">{title}</h1>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            <Link to="/staff/team/timesheets" className={`rounded-full border px-3 py-1 ${kind === "timesheets" ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700"}`} data-testid="team-nav-timesheets">Team timesheets</Link>
            <Link to="/staff/team/leave" className={`rounded-full border px-3 py-1 ${kind === "leave" ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700"}`} data-testid="team-nav-leave">Leave approvals{team?.pendingLeave ? ` (${team.pendingLeave})` : ""}</Link>
          </nav>
        </div>
        {error ? <p role="alert" className="mt-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
        {team === undefined && !error ? <p className="mt-4 text-sm text-foreground-600" role="status">Loading…</p> : null}
        {team && !allowed ? <p className="mt-4 text-sm text-foreground-700" data-testid="team-none">Nobody reports to you, so there is nothing to approve here.</p> : null}
        {team && allowed ? <div className="mt-6">{children(team)}</div> : null}
      </div>
    </div>
  );
}

export function TeamTimesheetsPage() {
  return <TeamShell title="Team timesheets" kind="timesheets">{(team) => <TimesheetTable team={team} admin={team.isAdmin} />}</TeamShell>;
}
export function TeamLeavePage() {
  return <TeamShell title="Leave approvals" kind="leave">{() => <LeaveApprovals />}</TeamShell>;
}
