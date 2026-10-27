import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { STATUS_META, formatDate } from "@/pages/agency/lib/portalData";
import { isEditableApplicationStatus, nextStatusOptions } from "@/pages/agency/lib/applicationAccess";
import {
  assignApplicationAgent,
  deleteApplicationDocument,
  getApplication,
  getDocumentSignedUrl,
  listApplicationDocuments,
  listAssignableAgents,
  listStatusHistory,
  queueDocumentExtraction,
  setApplicationStatus,
  type AgentOption,
  type ApplicationDetail,
  type DocumentRow,
  type StatusHistoryRow,
} from "@/pages/agency/lib/portalApplications";
import ApplicationWorkspace from "@/pages/agency/components/ApplicationWorkspace";
import ApplicationWizard from "@/pages/agency/components/ApplicationWizard";
import ApplicationMessages from "@/pages/agency/components/ApplicationMessages";
import { PortalEmpty, PortalError, PortalLoading, StatusBadge } from "@/pages/agency/components/PortalUI";

import { portalScopeCacheKey } from "@/lib/portalScope";

type Tab = "overview" | "form" | "documents" | "history" | "messages";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "ri-dashboard-line" },
  { id: "form", label: "Application form", icon: "ri-file-edit-line" },
  { id: "documents", label: "Documents", icon: "ri-folder-3-line" },
  { id: "history", label: "Status history", icon: "ri-history-line" },
  { id: "messages", label: "Messages", icon: "ri-chat-3-line" },
];

function wizardOpenKey(applicationId: string): string {
  return `slit-portal-wizard-open:${portalScopeCacheKey()}:${applicationId}`;
}

function wasWizardOpen(applicationId: string): boolean {
  try { return window.sessionStorage.getItem(wizardOpenKey(applicationId)) === "1"; } catch { return false; }
}

export default function ApplicationDetailPage() {
  const { id = "" } = useParams();
  const { role, profile, agency } = usePortalAuth();

  const [application, setApplication] = useState<ApplicationDetail | null>(null);
  const [history, setHistory] = useState<StatusHistoryRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusNote, setStatusNote] = useState("");
  const [wizardOpen, setWizardOpen] = useState(() => wasWizardOpen(id));
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [documentBusy, setDocumentBusy] = useState("");

  const isSlit = role === "slit_admin";
  const canManageAssignment = role === "agency_admin" || isSlit;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const detail = await getApplication(id);
      if (!detail) {
        setApplication(null);
        setError("This application could not be found, or you do not have access to it.");
        return;
      }
      setApplication(detail);
      const [hist, docs] = await Promise.all([listStatusHistory(id), listApplicationDocuments(id)]);
      setHistory(hist);
      setDocuments(docs);
      if (role === "agency_admin") setAgents(await listAssignableAgents(detail.agencyId));
      else if (isSlit) setAgents(await listAssignableAgents(detail.agencyId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load this application.");
    } finally {
      setLoading(false);
    }
  }, [id, role, isSlit]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAfterSave = useCallback(() => { void getApplication(id, false).then(detail => { if (detail) setApplication(detail); }).catch(e => setActionError(e.message)); }, [id]);

  const openWizard = useCallback(() => {
    try { window.sessionStorage.setItem(wizardOpenKey(id), "1"); } catch { /* session storage unavailable */ }
    setWizardOpen(true);
  }, [id]);

  const closeWizard = useCallback(() => {
    try { window.sessionStorage.removeItem(wizardOpenKey(id)); } catch { /* session storage unavailable */ }
    setWizardOpen(false);
  }, [id]);

  const handleReassign = async (agentProfileId: string) => {
    if (!application) return;
    setBusy(true);
    setActionError("");
    try {
      await assignApplicationAgent(application.id, agentProfileId || null);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "We could not reassign this application.");
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (next: string) => {
    if (!application || !next) return;
    setBusy(true);
    setActionError("");
    try {
      await setApplicationStatus(application.id, next, statusNote);
      setStatusNote("");
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "We could not update the status.");
    } finally {
      setBusy(false);
    }
  };

  const handleDocumentAction = async (doc: DocumentRow, action: "preview" | "retry" | "delete") => {
    setDocumentBusy(`${action}:${doc.id}`);
    setActionError("");
    try {
      if (action === "preview") {
        const signedUrl = await getDocumentSignedUrl(doc.storagePath);
        window.open(signedUrl, "_blank", "noopener,noreferrer");
      } else if (action === "retry") {
        await queueDocumentExtraction(doc.id, true);
        await load();
      } else {
        await deleteApplicationDocument({ id: doc.id, storagePath: doc.storagePath });
        await load();
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "The document action could not be completed.");
    } finally {
      setDocumentBusy("");
    }
  };

  const handleWizardFinish = async () => {
    closeWizard();
    setTab("form");
    setWorkspaceKey((key) => key + 1);
    await load();
  };

  // Do not unmount an open wizard during a background detail refresh. Its
  // document and form state are independently persisted by the wizard/RPCs.
  if (loading && !application) {
    return <PortalLoading label="Loading application\u2026" />;
  }

  if (error || !application) {
    return (
      <div className="space-y-4">
        <PortalError message={error || "Application not found."} onRetry={() => void load()} />
        <Link
          to={isSlit ? "/agency/all-applications" : "/agency/applications"}
          className="inline-flex items-center gap-2 rounded-md border border-background-300 px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:bg-background-100"
        >
          <i className="ri-arrow-left-line" aria-hidden="true" />
          Back to applications
        </Link>
      </div>
    );
  }

  // SLIT administrators are not inherently read-only. Status alone controls
  // whether a record is editable; RLS separately determines who may edit it.
  const readOnly = !isEditableApplicationStatus(application.status);
  const agentName = application.agentName || profile?.fullName || "";
  const agencyName = application.agencyName || agency?.name || "";
  const outstanding =
    ((application.data?.wizard as { outstanding?: string[] } | undefined)?.outstanding ?? []).filter(Boolean);

  return (
    <div>
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Link
            to={isSlit ? "/agency/all-applications" : "/agency/applications"}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground-500 hover:text-primary-600"
          >
            <i className="ri-arrow-left-line" aria-hidden="true" />
            All applications
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="font-heading text-xl font-bold text-foreground-950 md:text-2xl">
              {application.studentName || "New application"}
            </h1>
            <StatusBadge status={application.status} />
            {application.isTest ? (
              <span className="rounded-full bg-accent-100 px-2.5 py-1 text-[10px] font-semibold uppercase text-accent-900">
                Test data
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-500">
            <span className="inline-flex items-center gap-1.5 font-mono font-semibold text-foreground-800">
              <i className="ri-hashtag" aria-hidden="true" />
              {application.reference || "Draft"}
            </span>
            <span>{agencyName}</span>
            <span>Created {formatDate(application.createdAt)}</span>
            <span>Updated {formatDate(application.updatedAt)}</span>
            {application.submittedAt ? <span>Submitted {formatDate(application.submittedAt)}</span> : null}
          </p>
        </div>
        <div className="shrink-0 rounded-card border border-background-200 bg-background-50 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-700">Completion</p>
          <p className="mt-1 font-heading text-2xl font-bold text-foreground-950">{application.completion}%</p>
          <div className="mt-2 h-1.5 w-32 overflow-hidden rounded-full bg-background-200">
            <div className="h-full rounded-full bg-accent-500" style={{ width: `${application.completion}%` }} />
          </div>
        </div>
      </header>

      <nav className="mt-6 flex flex-wrap gap-1.5 border-b border-background-200 pb-px">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-t-md px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === item.id
                ? "border-b-2 border-primary-500 text-primary-700"
                : "text-foreground-600 hover:text-foreground-900"
            }`}
          >
            <i className={item.icon} aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </nav>

      {actionError ? (
        <div className="mt-4">
          <PortalError message={actionError} />
        </div>
      ) : null}

      {outstanding.length > 0 ? (
        <div className="mt-4 rounded-card border border-accent-200 bg-accent-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-accent-900">
            <i className="ri-flag-line" aria-hidden="true" />
            Outstanding requirements from the document wizard
          </p>
          <ul className="mt-2 space-y-1">
            {outstanding.map((item) => (
              <li key={item} className="flex items-start gap-2 text-xs text-accent-900">
                <i className="ri-arrow-right-s-line mt-px" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5">
        {tab === "overview" ? (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
            <section className="rounded-card border border-background-200 bg-background-50 p-5">
              <h2 className="font-heading text-base font-semibold text-foreground-950">Summary</h2>
              <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                {[
                  ["Student", application.studentName || "\u2014"],
                  ["Email", application.studentEmail || "\u2014"],
                  [
                    "Courses",
                    application.courses.length
                      ? application.courses.map((c) => `${c.code}${c.variant ? ` (${c.variant})` : ""}`).join(", ")
                      : "\u2014",
                  ],
                  ["Preferred intake", application.intake || "\u2014"],
                  ["Agency", agencyName || "\u2014"],
                  ["Assigned agent", application.agentName || "Unassigned"],
                  ["Created by", application.createdByName || "\u2014"],
                  ["Submitted by", application.submittedByName || "\u2014"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs uppercase tracking-wide text-foreground-500">{label}</dt>
                    <dd className="mt-1 text-sm font-medium text-foreground-900">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <div className="space-y-5">
              {canManageAssignment ? (
                <section className="rounded-card border border-background-200 bg-background-50 p-5">
                  <h2 className="font-heading text-base font-semibold text-foreground-950">Assignment</h2>
                  <p className="mt-1 text-xs text-foreground-500">
                    Assign to an active agent in this agency, or leave unassigned.
                  </p>
                  <select
                    value={application.agentId ?? ""}
                    disabled={busy}
                    onChange={(event) => void handleReassign(event.target.value)}
                    className="mt-3 w-full rounded-md border border-background-300 bg-background-50 px-3 py-2.5 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40"
                  >
                    <option value="">Unassigned</option>
                    {agents.map((agent) => (
                      <option key={agent.profileId} value={agent.profileId}>
                        {agent.fullName}
                      </option>
                    ))}
                  </select>
                </section>
              ) : null}

              {isSlit ? (
                <section className="rounded-card border border-background-200 bg-background-50 p-5">
                  <h2 className="font-heading text-base font-semibold text-foreground-950">Admissions status</h2>
                  <p className="mt-1 text-xs text-foreground-500">
                    SLIT Admin only. Agency users can never change an admissions decision.
                  </p>
                  <select
                    value=""
                    aria-label="Change status"
                    disabled={busy}
                    onChange={(event) => void handleStatus(event.target.value)}
                    className="mt-3 w-full rounded-md border border-background-300 bg-background-50 px-3 py-2.5 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40"
                  >
                    <option value="">{nextStatusOptions(application.status).length ? "Change status to\u2026" : "No further status changes"}</option>
                    {nextStatusOptions(application.status).map((value) => (
                      <option key={value} value={value}>
                        {STATUS_META[value as keyof typeof STATUS_META]?.label ?? value}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={statusNote}
                    onChange={(event) => setStatusNote(event.target.value)}
                    placeholder="Optional note for the applicant"
                    className="mt-3 w-full rounded-md border border-background-300 bg-background-50 px-3 py-2.5 text-sm text-foreground-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40"
                  />
                </section>
              ) : null}

              {!isSlit ? (
                <section className="rounded-card border border-background-200 bg-background-50 p-5">
                  <h2 className="font-heading text-base font-semibold text-foreground-950">Admissions status</h2>
                  <p className="mt-2 text-sm text-foreground-800">{STATUS_META[application.status as keyof typeof STATUS_META]?.label ?? application.status}</p>
                  <p className="mt-1 text-xs text-foreground-500">Read-only. Status changes are made by SLIT administration.</p>
                </section>
              ) : null}

              {!readOnly ? (
                <section className="rounded-card border border-primary-200 bg-primary-50 p-5">
                  <h2 className="font-heading text-base font-semibold text-primary-900">Next step</h2>
                  <p className="mt-1 text-xs text-primary-900/80">
                    This application is still a draft. Open the application form to continue, save and submit.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setTab("form")}
                      className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 hover:bg-primary-600"
                    >
                      <i className="ri-play-line" aria-hidden="true" />
                      Continue application
                    </button>
                    <button
                      type="button"
                      onClick={openWizard}
                      className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border border-primary-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-primary-700 hover:bg-primary-50"
                    >
                      <i className="ri-magic-line" aria-hidden="true" />
                      Document upload wizard
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        ) : null}

        {tab === "form" ? (
          <ApplicationWorkspace
            key={workspaceKey}
            application={application}
            agentName={agentName}
            agentEmail={profile?.email ?? ""}
            agentPhone={profile?.phone ?? ""}
            agencyName={agencyName}
            readOnly={readOnly}
            onSaved={refreshAfterSave}
          />
        ) : null}

        {tab === "documents" ? (
          documents.length === 0 ? (
            <PortalEmpty
              icon="ri-folder-3-line"
              title="No documents yet"
              message="Upload passport, visa, English, licence and academic documents with the Document upload wizard. They will appear here as soon as they are persisted."
            />
          ) : (
            <div className="overflow-x-auto rounded-card border border-background-200 bg-background-50">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-background-100 text-xs uppercase tracking-wide text-foreground-700">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Category</th>
                    <th className="px-4 py-3 font-semibold">File</th>
                    <th className="px-4 py-3 font-semibold">Review</th>
                    <th className="px-4 py-3 font-semibold">Extraction</th>
                    <th className="px-4 py-3 font-semibold">Added</th>
                    <th className="px-4 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr key={doc.id} className="border-t border-background-200">
                      <td className="px-4 py-3 text-xs font-semibold text-foreground-800">{doc.category}</td>
                      <td className="px-4 py-3 text-xs text-foreground-700">{doc.filename}</td>
                      <td className="px-4 py-3 text-xs text-foreground-700">{doc.reviewState}</td>
                      <td className="px-4 py-3 text-xs text-foreground-700">
                        {String((doc.metadata.extraction as { status?: string } | undefined)?.status ?? "Not requested")}
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground-600">{formatDate(doc.createdAt)}</td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-wrap gap-1.5">
                          <button type="button" onClick={() => void handleDocumentAction(doc, "preview")} disabled={Boolean(documentBusy)} className="rounded border border-background-300 px-2 py-1 font-semibold text-foreground-700 disabled:opacity-50">Preview</button>
                          {!readOnly ? <button type="button" onClick={() => void handleDocumentAction(doc, "retry")} disabled={Boolean(documentBusy)} className="rounded border border-primary-300 px-2 py-1 font-semibold text-primary-800 disabled:opacity-50">{documentBusy === `retry:${doc.id}` ? "Queueing…" : "Extract / retry"}</button> : null}
                          {!readOnly ? <button type="button" onClick={() => void handleDocumentAction(doc, "delete")} disabled={Boolean(documentBusy)} className="rounded border border-primary-300 px-2 py-1 font-semibold text-primary-800 disabled:opacity-50">{documentBusy === `delete:${doc.id}` ? "Deleting…" : "Delete"}</button> : null}
                          {!readOnly ? <button type="button" onClick={openWizard} className="rounded border border-secondary-300 px-2 py-1 font-semibold text-secondary-900">Review</button> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {tab === "history" ? (
          history.length === 0 ? (
            <PortalEmpty
              icon="ri-history-line"
              title="No status changes yet"
              message="Every status transition is recorded here with the actor and timestamp."
            />
          ) : (
            <ol className="space-y-3">
              {history.map((entry) => (
                <li key={entry.id} className="flex gap-3 rounded-card border border-background-200 bg-background-50 p-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary-100 text-secondary-900">
                    <i className="ri-arrow-right-circle-line" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground-950">
                      {entry.previousStatus ? `${entry.previousStatus} \u2192 ` : ""}
                      {entry.newStatus}
                    </p>
                    <p className="mt-0.5 text-xs text-foreground-500">
                      {entry.actorName || "System"} ({entry.actorRole || "system"}) &middot; {formatDate(entry.createdAt)}
                    </p>
                    {entry.note ? <p className="mt-1 text-xs text-foreground-600">{entry.note}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          )
        ) : null}

        {tab === "messages" ? <ApplicationMessages applicationId={id} /> : null}
      </div>

      {wizardOpen ? (
        <ApplicationWizard
          applicationId={application.id}
          agencyName={agencyName}
          onFinish={() => void handleWizardFinish()}
          onCancel={closeWizard}
        />
      ) : null}
    </div>
  );
}
