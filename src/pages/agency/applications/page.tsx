import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import {
  listApplications,
  listAssignableAgents,
  type AgentOption,
  type ApplicationListRow,
} from "@/pages/agency/lib/portalApplications";
import ApplicationsTable from "@/pages/agency/components/ApplicationsTable";
import { PageHeading } from "@/pages/agency/components/PortalUI";

export default function PortalApplicationsPage() {
  const { role, agency } = usePortalAuth();
  const [rows, setRows] = useState<ApplicationListRow[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = [] as ApplicationListRow[];
      setRows(data);
      if (role === "agency_admin") {
        setAgents(await listAssignableAgents(agency?.id));
      } else {
        setAgents([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load your applications.");
    } finally {
      setLoading(false);
    }
  }, [role, agency?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isAgentOnly = role === "agent";

  return (
    <div>
      <PageHeading
        eyebrow="Applications"
        title="Student applications"
        description={
          isAgentOnly
            ? "Applications assigned to you. You only ever see your own students — never another agent's."
            : `Every application belonging to ${agency?.name ?? "your agency"}, with filtering by agent, course, intake and status.`
        }
        action={
          <Link
            to="/agency/applications/new"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
          >
            <i className="ri-add-line" aria-hidden="true" />
            + New Application
          </Link>
        }
      />

      <div className="mt-6">
        <ApplicationsTable remote
          rows={rows}
          loading={loading}
          error={error}
          onRetry={() => void load()}
          agents={isAgentOnly ? undefined : agents.map((a) => ({ id: a.profileId, name: a.fullName }))}
          emptyAction={
            <Link
              to="/agency/applications/new"
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
            >
              <i className="ri-add-line" aria-hidden="true" />
              + New Application
            </Link>
          }
        />
      </div>
    </div>
  );
}
