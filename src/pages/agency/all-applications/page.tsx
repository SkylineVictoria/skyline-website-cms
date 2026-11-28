import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { listAgencies } from "@/pages/agency/lib/portalData";
import {
  listApplications,
  listAssignableAgents,
  type AgentOption,
  type ApplicationListRow,
} from "@/pages/agency/lib/portalApplications";
import ApplicationsTable from "@/pages/agency/components/ApplicationsTable";
import SubmittedBanner from "@/pages/agency/components/SubmittedBanner";
import { cmsPaths, useApplicationPaths } from "@/pages/agency/lib/applicationPaths";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { PageHeading } from "@/pages/agency/components/PortalUI";
import AxcelerateRecordImport from "@/components/axcelerate/AxcelerateRecordImport";

export default function AllApplicationsPage() {
  const paths = useApplicationPaths();
  const { role } = usePortalAuth();
  const [rows, setRows] = useState<ApplicationListRow[]>([]);
  const [agencies, setAgencies] = useState<Array<{ id: string; name: string }>>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Links from the Agents list open with that business and agent already selected (?business=&agent=&status=).
  const [params] = useSearchParams();
  const businessParam = params.get("business") ?? "";
  const agentParam = params.get("agent") ?? "";
  const statusParam = params.get("status") ?? "";
  // The business is the agency record, so the id in the link is the agency id.
  const initialAgencyId = businessParam;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [apps, agencyList, agentList] = await Promise.all([
        Promise.resolve([] as ApplicationListRow[]),
        listAgencies(),
        listAssignableAgents(),
      ]);
      setRows(apps);
      setAgencies(agencyList.map((a) => ({ id: a.id, name: a.name })));
      setAgents(agentList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load applications.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Administrators of the main site manage applications inside the CMS.
  if (paths.area === "portal" && role === "slit_admin" && !requestWebsiteDomain()) return <Navigate to={cmsPaths.list} replace />;

  return (
    <div>
      <SubmittedBanner />
      <PageHeading
        eyebrow="All Applications"
        title="All applications"
        action={<div className="flex flex-wrap items-center gap-2"><AxcelerateRecordImport kind="students" label="Import from aXcelerate" /><Link to={paths.create} className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"><i className="ri-add-line" aria-hidden="true" />+ New Application</Link></div>}
        description="Every application across every agency — search, filter by agency, agent, course, intake and status, and open any application for review."
      />

      <div className="mt-6">
        <ApplicationsTable remote
          key={`${businessParam}|${agentParam}|${statusParam}`}
          initialAgencyId={initialAgencyId}
          initialAgentId={agentParam}
          initialStatus={statusParam}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={() => void load()}
          agencies={agencies}
          agents={agents.map((a) => ({ id: a.profileId, name: `${a.fullName}${a.agencyName ? ` · ${a.agencyName}` : ""}` }))}
          emptyTitle="No applications across any agency yet"
          emptyMessage="Applications created by agencies and agents will appear here for review."
        />
      </div>
    </div>
  );
}
