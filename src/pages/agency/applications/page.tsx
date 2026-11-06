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
import SubmittedBanner from "@/pages/agency/components/SubmittedBanner";
import { PageHeading } from "@/pages/agency/components/PortalUI";

export default function PortalApplicationsPage() {
  const { role, agency } = usePortalAuth();
  const [rows, setRows] = useState<ApplicationListRow[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // The table loads the rows itself; the "apply at SLIT?" prompt shows only when a student has none.
  const [total, setTotal] = useState<number | null>(null);

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
  const isStudent = role === "student";

  return (
    <div>
      <SubmittedBanner />
      <PageHeading
        eyebrow={isStudent ? "My applications" : "Applications"}
        title={isStudent ? "Your applications" : "Student applications"}
        description={
          isStudent
            ? `Your applications with ${agency?.name ?? "your agency"}. Open one to upload documents and fill in the form, or start a new one.`
            : isAgentOnly
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

      {isStudent && !error && total === 0 ? (
        <div className="mt-6 flex flex-col items-start gap-4 rounded-lg border border-primary-200 bg-primary-50 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-heading text-lg font-bold text-foreground-950">Do you want to apply at SLIT?</h2>
            <p className="mt-1 text-sm text-foreground-700">Start your application: upload your passport and we fill in your details.</p>
          </div>
          <Link to="/agency/applications/new"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600">
            Yes, start my application
          </Link>
        </div>
      ) : null}

      <div className="mt-6">
        <ApplicationsTable remote
          onTotal={setTotal}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={() => void load()}
          agents={isAgentOnly || isStudent ? undefined : agents.map((a) => ({ id: a.profileId, name: a.fullName }))}
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
