import FinishApplicationPanel from "@/pages/agency/components/FinishApplicationPanel";
import { AgentHandoffPanel } from "@/pages/agency/components/ApplicationHandoff";
import { HANDOFF_STATE_LABEL } from "@/pages/agency/lib/handoff";
import { useHandoff } from "@/pages/agency/lib/handoff";
import StudentPortalInvite from "@/pages/agency/components/StudentPortalInvite";
import ResponsiveTable from "@/components/ui/ResponsiveTable";
import DocumentPreviewModal from "@/pages/agency/components/DocumentPreviewModal";
import SignedApplicationCard from "@/pages/agency/components/SignedApplicationCard";
import MessagePersonButton from "@/pages/admin/components/MessagePersonButton";
import { useCallback, useEffect, useState } from "react";

import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { formatDate } from "@/pages/agency/lib/portalData";
import { isEditableStatus, statusInfo, useApplicationStatuses } from "@/lib/applicationStatuses";
import StatusBadge from "@/components/shared/application-status/StatusBadge";
import TakeActionMenu from "@/components/shared/application-status/TakeActionMenu";
import Toast from "@/components/shared/application-form/Toast";
import { useToast } from "@/components/shared/application-form/useToast";
import { AgentMetaEditor, ApplicantStatusBanner, OfferDepositCard, OfferLettersList } from "@/pages/agency/components/ApplicationStatusPanels";
import {
  assignApplicationAgent,
  deleteApplicationDocument,
  getApplication,
  needsInitialWizard,
  getDocumentSignedUrl,
  listApplicationDocuments,
  listAssignableAgents,
  listStatusHistory,
  queueDocumentExtraction,
  type AgentOption,
  type ApplicationDetail,
  type DocumentRow,
  type StatusHistoryRow,
} from "@/pages/agency/lib/portalApplications";
import ApplicationWorkspace from "@/pages/agency/components/ApplicationWorkspace";
import NotificationGateBanner from "@/pages/admin/components/NotificationGateBanner";
import NotificationLogTable from "@/pages/admin/components/NotificationLogTable";
import { downloadApplicationPdf, logAdminAccess } from "@/pages/agency/lib/applicationPdf";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { cmsPaths, useApplicationPaths } from "@/pages/agency/lib/applicationPaths";
import ApplicationWizard from "@/pages/agency/components/ApplicationWizard";
import ApplicationMessages from "@/pages/agency/components/ApplicationMessages";
import { PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

import { portalScopeCacheKey } from "@/lib/portalScope";

/** Reports the Review step’s open problems to the page (the header’s Take action asks for an override note while there are any). */
function ReviewIssuesReporter({ count, onCount }: { count: number; onCount: (n: number) => void }) {
  useEffect(() => { onCount(count); }, [count, onCount]);
  return null;
}

type Tab = "form" | "signing" | "documents" | "history" | "messages" | "notifications";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "form", label: "Application form", icon: "ri-file-edit-line" },
  { id: "documents", label: "Documents", icon: "ri-folder-3-line" },
  { id: "history", label: "Status history", icon: "ri-history-line" },
  { id: "messages", label: "Messages", icon: "ri-chat-3-line" },
];

function wizardOpenKey(applicationId: string): string {
  return `slit-portal-wizard-open:${portalScopeCacheKey()}:${applicationId}`;
}

function wasWizardOpen(applicationId: string): boolean {
  try { return window.localStorage.getItem(wizardOpenKey(applicationId)) === "1"; } catch { return false; }
}

/** The document reader's state in plain words (was the raw status, e.g. "unreviewed"). */
const EXTRACTION_LABEL: Record<string, string> = {
  queued: "Waiting to be read", processing: "Being read", unreviewed: "Read", confirmed: "Read and checked",
  rejected: "Read, details not used", no_fields: "Nothing to read", failed: "Could not be read", cancelled: "Cancelled",
};
const extractionLabel = (status: string | undefined) => (status ? EXTRACTION_LABEL[status] ?? status : "Not read");

export default function ApplicationDetailPage() {
  const { id = "" } = useParams();
  const paths = useApplicationPaths();
  const navigate = useNavigate();
  const { role, profile, agency } = usePortalAuth();
  // APPLICATION-STUDENT-SIGNS: who has the application (the database enforces it; this keeps the screens in step).
  const { handoff, loaded: handoffLoaded, reload: reloadHandoff } = useHandoff(id);

  const [application, setApplication] = useState<ApplicationDetail | null>(null);
  const [history, setHistory] = useState<StatusHistoryRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [tab, setTab] = useState<Tab>("form");
  const [reviewIssues, setReviewIssues] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const workflow = useApplicationStatuses();
  const toast = useToast();
  // ?wizard=1 (a student just added from the Students page) opens the document wizard straight away.
  const [searchParams, setSearchParams] = useSearchParams();
  const [wizardOpen, setWizardOpen] = useState(() => wasWizardOpen(id) || searchParams.get("wizard") === "1");
  useEffect(() => {
    if (searchParams.get("wizard") !== "1") return;
    try { window.localStorage.setItem(wizardOpenKey(id), "1"); } catch { /* session storage unavailable */ }
    setWizardOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("wizard");
    setSearchParams(next, { replace: true });
  }, [id, searchParams, setSearchParams]);
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [documentBusy, setDocumentBusy] = useState("");

  const isSlit = role === "slit_admin";
  const canManageAssignment = role === "agency_admin" || isSlit;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const detail = await getApplication(id, false);
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
    try { window.localStorage.setItem(wizardOpenKey(id), "1"); } catch { /* session storage unavailable */ }
    setWizardOpen(true);
  }, [id]);

  const closeWizard = useCallback(() => {
    try { window.localStorage.removeItem(wizardOpenKey(id)); } catch { /* session storage unavailable */ }
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

  // Preview on the page (owner 2026-11-26), not a new tab.
  const [preview, setPreview] = useState<{ doc: DocumentRow; url: string } | null>(null);
  const handleDocumentAction = async (doc: DocumentRow, action: "preview" | "download" | "retry" | "delete") => {
    setDocumentBusy(`${action}:${doc.id}`);
    setActionError("");
    try {
      if (action === "preview" || action === "download") {
        if (isSlit) await logAdminAccess(id, action === "download" ? "document_downloaded" : "document_viewed", { documentId: doc.id, filename: doc.filename, category: doc.category });
        const signedUrl = await getDocumentSignedUrl(doc.storagePath, 300, action === "download" ? doc.filename : undefined);
        if (action === "download") window.location.assign(signedUrl);
        else setPreview({ doc, url: signedUrl });
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
    // Once submitted, it goes to the review queue: staff and agents see it in the applications list, a student in theirs.
    if (application && application.status === "draft") { navigate(paths.list, { replace: true }); return; }
    setTab("form");
    setWorkspaceKey((key) => key + 1);
    await load();
  };

  // Do not unmount an open wizard during a background detail refresh. Its
  // document and form state are independently persisted by the wizard/RPCs.
  // Administrators of the main site manage applications inside the CMS (this also covers links from emails).
  if (paths.area === "portal" && isSlit && !requestWebsiteDomain()) return <Navigate to={cmsPaths.detail(id) + (wizardOpen ? "?wizard=1" : "")} replace />;

  if (loading && !application) {
    return <PortalLoading label="Loading application\u2026" />;
  }

  if (error || !application) {
    return (
      <div className="space-y-4">
        <PortalError message={error || "Application not found."} onRetry={() => void load()} />
        <Link
          to={isSlit && paths.area === "portal" ? "/agency/all-applications" : paths.list}
          className="inline-flex items-center gap-2 rounded-md border border-background-300 px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:bg-background-100"
        >
          <i className="ri-arrow-left-line" aria-hidden="true" />
          Back to applications
        </Link>
      </div>
    );
  }

  // ONE-PAGE (owner 2026-11-26): once the agent has prepared the application and sent it to the student, it opens as one page with
  // every answer (the student checks, edits and signs there); the document wizard is only for a blank application.
  if (needsInitialWizard(application) && !handoffLoaded) return <PortalLoading label="Loading application…" />;
  // A returning student (their details are on record) also gets the one page: course and intake first, then check and sign.
  const returningStudent = role === "student" && Boolean(String((application.data?.values as Record<string, unknown> | undefined)?.first_name ?? "").trim());
  if (needsInitialWizard(application) && !handoff?.state && !returningStudent) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link to={paths.list} className="text-sm font-medium text-primary-700">All applications</Link>
          {application.studentId ? <StudentPortalInvite studentId={application.studentId} studentName={application.studentName} onMessage={(m) => toast.show(m)} /> : null}
        </div>
        <FinishApplicationPanel key={application.id} id={application.id} email={application.studentEmail}
          canInvite={role === "slit_admin" || role === "agency_admin" || role === "agent"} onContinue={openWizard} />
        {wizardOpen ? <ApplicationWizard key={application.id} applicationId={application.id}
          agencyName={application.agencyName || agency?.name || ""}
          onFinish={() => void handleWizardFinish()} onCancel={() => { closeWizard(); void load(); }} /> : null}
        <Toast message={toast.message} onDismiss={toast.dismiss} />
      </div>
    );
  }

  if (!workflow.ready) return <PortalLoading label="Loading application…" />;
  // SLIT administrators are not inherently read-only. Status alone controls
  // whether a record is editable; RLS separately determines who may edit it.
  const handoffBlocks = role === "student"
    ? ["with_agent", "change_requested", "waiting_guardian"].includes(handoff?.state ?? "")
    : handoff?.state === "waiting_guardian"; // the agent and staff edit while the student has it too (migration 20261127020517)
  // ADMIN-EDIT-SUBMITTED (owner 2026-11-26): SLIT admins correct a submitted application on the same page, until an offer is issued.
  // The same two statuses portal_lock_draft lets SLIT admins save (migration 20261127010517).
  const adminEdits = isSlit && (application.status === "submitted" || application.status === "under_review");
  const readOnly = (!isEditableStatus(workflow, application.status) && !adminEdits) || handoffBlocks;
  const nextHint = statusInfo(workflow, application.status).hint;
  const agentName = application.agentName || profile?.fullName || "";
  const agencyName = application.agencyName || agency?.name || "";
  const outstanding =
    ((application.data?.wizard as { outstanding?: string[] } | undefined)?.outstanding ?? []).filter(Boolean);

  return (
    <div>
      {/* Owner 2026-11-25 (clean view): one header line with the name, one status badge and the actions (Take action for SLIT staff);
          one details line underneath with what is needed next. */}
      <header>
        <Link
          to={isSlit && paths.area === "portal" ? "/agency/all-applications" : paths.list}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground-500 hover:text-primary-600"
        >
          <i className="ri-arrow-left-line" aria-hidden="true" />
          All applications
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 font-heading text-xl font-bold text-foreground-950 md:text-2xl">
            {application.studentName || "New application"}
          </h1>
          <StatusBadge status={application.status} />
          {application.isTest ? (
            <span className="rounded-full bg-accent-100 px-2.5 py-1 text-2xs font-semibold uppercase text-accent-900">Test data</span>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {application.studentId ? <StudentPortalInvite studentId={application.studentId} studentName={application.studentName} onMessage={(m) => toast.show(m)} /> : null}
            {isSlit && paths.area !== "portal" ? <MessagePersonButton kind="student" refId={application.studentId} name={application.studentName || "the student"} label="Student" size="sm" variant="ghost" /> : null}
            {isSlit && paths.area !== "portal" ? <MessagePersonButton kind="agent" refId={application.agentId} name={application.agentName || "the agent"} label="Agent" size="sm" variant="ghost" /> : null}
            {isSlit ? (
              <button
                type="button"
                title="Download the application as a PDF"
                onClick={() => { setActionError(""); void logAdminAccess(application.id, "pdf_exported").then(() => downloadApplicationPdf(application)).catch((e) => setActionError(e instanceof Error ? e.message : "The PDF could not be created.")); }}
                className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100 hover:text-primary-700"
              >
                <i className="ri-file-pdf-2-line text-sm" aria-hidden="true" />
                PDF
              </button>
            ) : null}
            {!readOnly && !(role === "student" && handoff?.state) ? (
              <button
                type="button"
                onClick={openWizard}
                className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700"
              >
                <i className="ri-magic-line" aria-hidden="true" />
                Document upload wizard
              </button>
            ) : null}
            {isSlit ? (
              <TakeActionMenu align="right" size="md" onStatus={() => undefined} onDone={() => void load()} reviewIssues={reviewIssues}
                onResult={(message, _ok, action) => toast.show(message, action, action ? 5000 : undefined)}
                application={{ id: application.id, status: application.status, reference: application.reference, studentName: application.studentName, studentId: application.studentId,
                  course: application.courses[0] ? { title: application.courses[0].title, code: application.courses[0].code } : null, intake: application.intake }} />
            ) : null}
          </div>
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-500" data-testid="application-meta">
          <span className="inline-flex items-center gap-1 font-mono font-semibold text-foreground-800">
            <i className="ri-hashtag" aria-hidden="true" />
            {application.reference || "Draft"}
          </span>
          {agencyName ? <span>Agency: <span className="font-medium text-foreground-800">{agencyName}</span></span> : null}
          {canManageAssignment ? (
            <AgentMetaEditor agentId={application.agentId} agentName={application.agentName} agents={agents} busy={busy} onAssign={(profileId) => void handleReassign(profileId)} />
          ) : application.agentName ? <span>Agent: <span className="font-medium text-foreground-800">{application.agentName}</span></span> : null}
          {application.submittedAt ? <span>Submitted {formatDate(application.submittedAt)}</span> : <span>Created {formatDate(application.createdAt)}</span>}
          <span>{application.completion}% complete</span>
          {isSlit && nextHint ? <span className="font-medium text-foreground-800">Next: {nextHint}</span> : null}
        </p>
      </header>

      {/* The student review and signature (timeline, what the student changed, Take back / Resend / Request a change) is its own tab. */}
      {handoff?.state ? (
        <button type="button" onClick={() => setTab("signing")} data-testid="handoff-strip"
          className="mt-4 flex w-full cursor-pointer flex-wrap items-center gap-2 rounded-card border border-background-200 bg-background-50 px-4 py-2.5 text-left text-sm hover:border-primary-300">
          <i className="ri-quill-pen-line text-base text-primary-600" aria-hidden="true" />
          <span className="font-medium text-foreground-900">Student review and signature</span>
          <span className="rounded-full bg-background-200 px-2 py-0.5 text-xs font-semibold text-foreground-800">{HANDOFF_STATE_LABEL[handoff.state]}</span>
          <span className="ml-auto text-xs font-semibold text-primary-700">Open <i className="ri-arrow-right-line" aria-hidden="true" /></span>
        </button>
      ) : null}
      {!isSlit ? <ApplicantStatusBanner application={application} history={history} onChanged={() => { void load(); setWorkspaceKey((key) => key + 1); }} /> : null}
      {/* OFFER-DEPOSIT: acceptance and deposit at a glance; staff and the agent remind, staff set the automatic reminders. */}
      <OfferDepositCard applicationId={application.id} canRemind={isSlit || role === "agent" || role === "agency_admin"} canConfigure={isSlit} refreshKey={application.status} />

      <nav className="mt-6 flex flex-wrap gap-1.5 border-b border-background-200 pb-px">
        {[...TABS.slice(0, 1), ...(handoff?.state ? [{ id: "signing" as Tab, label: "Review & signature", icon: "ri-quill-pen-line" }] : []), ...TABS.slice(1),
          ...(paths.area === "cms" ? [{ id: "notifications" as Tab, label: "Notifications", icon: "ri-mail-line" }] : [])].map((item) => (
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
            {item.id === "documents" && documents.length ? (
              <span className="rounded-full bg-background-200 px-1.5 text-2xs font-semibold text-foreground-800">{documents.length}</span>
            ) : null}
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
        {tab === "form" ? (
          <ApplicationWorkspace
            key={workspaceKey}
            application={application}
            agentName={agentName}
            agentEmail={application.agentEmail || (role === "agent" ? profile?.email ?? "" : "")}
            agentPhone={application.agentPhone || (role === "agent" ? profile?.phone ?? "" : "")}
            agencyName={agencyName}
            readOnly={readOnly}
            onePage
            initialEdit={searchParams.get("edit") === "course" ? "courses_of_interest" : undefined}
            sentToStudent={handoff?.state === "with_student"}
            auditAccess={isSlit}
            reviewBar={isSlit ? (issues: number) => <ReviewIssuesReporter count={issues} onCount={setReviewIssues} /> : undefined}
            onSaved={refreshAfterSave}
            onSentToStudent={() => { void reloadHandoff(); void load(); setWorkspaceKey((key) => key + 1);
              toast.show(role === "student" ? "Signed. Your parent or guardian signs next." : "Sent to the student to review and sign."); }}
            onSubmitted={(reference, studentName) =>
              navigate(isSlit && paths.area === "portal" ? "/agency/all-applications" : paths.list, { state: { submittedReference: reference, submittedName: studentName, submittedPath: paths.detail(application.id) } })}
          />
        ) : null}

        {tab === "documents" ? <SignedApplicationCard application={application} /> : null}
        {tab === "documents" ? <OfferLettersList applicationId={application.id} refreshKey={application.status} /> : null}
        {tab === "documents" ? (
          documents.length === 0 ? (
            <PortalEmpty
              icon="ri-folder-3-line"
              title="No documents yet"
              message="Upload passport, visa, English, licence and academic documents with the Document upload wizard. They will appear here as soon as they are persisted."
            />
          ) : (
            <div className="rounded-card border border-background-200 bg-background-50">
              <ResponsiveTable>
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
                        {extractionLabel((doc.metadata.extraction as { status?: string } | undefined)?.status)}
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground-600">{formatDate(doc.createdAt)}</td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-wrap gap-1.5">
                          <button type="button" onClick={() => void handleDocumentAction(doc, "preview")} disabled={Boolean(documentBusy)} className="rounded border border-background-300 px-2 py-1 font-semibold text-foreground-700 disabled:opacity-50">Preview</button>
                          <button type="button" onClick={() => void handleDocumentAction(doc, "download")} disabled={Boolean(documentBusy)} className="rounded border border-background-300 px-2 py-1 font-semibold text-foreground-700 disabled:opacity-50">Download</button>
                          {!readOnly ? <button type="button" onClick={() => void handleDocumentAction(doc, "retry")} disabled={Boolean(documentBusy)} className="rounded border border-primary-300 px-2 py-1 font-semibold text-primary-800 disabled:opacity-50">{documentBusy === `retry:${doc.id}` ? "Queueing…" : "Extract / retry"}</button> : null}
                          {!readOnly ? <button type="button" onClick={() => void handleDocumentAction(doc, "delete")} disabled={Boolean(documentBusy)} className="rounded border border-primary-300 px-2 py-1 font-semibold text-primary-800 disabled:opacity-50">{documentBusy === `delete:${doc.id}` ? "Deleting…" : "Delete"}</button> : null}
                          {!readOnly ? <button type="button" onClick={openWizard} className="rounded border border-secondary-300 px-2 py-1 font-semibold text-secondary-900">Review</button> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
              {preview ? <DocumentPreviewModal url={preview.url} filename={preview.doc.filename} onClose={() => setPreview(null)}
                onDownload={() => { const d = preview.doc; setPreview(null); void handleDocumentAction(d, "download"); }} /> : null}
            </div>
          )
        ) : null}

        {tab === "signing" && handoff?.state ? (
          <AgentHandoffPanel applicationId={application.id} handoff={handoff} viewer={role === "student" ? "student" : "staff"}
            onChanged={() => { void reloadHandoff(); void load(); setWorkspaceKey((key) => key + 1); }} />
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
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${entry.actionKey === "deposit_paid" ? "bg-emerald-100 text-emerald-800" : "bg-secondary-100 text-secondary-900"}`}>
                    <i className={entry.actionKey === "deposit_paid" ? "ri-bank-card-line" : "ri-arrow-right-circle-line"} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground-950" data-testid={entry.actionKey === "deposit_paid" ? "history-deposit-paid" : undefined}>
                      {/* OFFER-DEPOSIT: the deposit row keeps the status; its note is the headline. */}
                      {entry.actionKey === "deposit_paid" ? entry.note || "Initial deposit paid" : <>{entry.previousStatus ? `${entry.previousStatus} \u2192 ` : ""}{entry.newStatus}</>}
                    </p>
                    <p className="mt-0.5 text-xs text-foreground-500">
                      {entry.actorName || "System"} ({entry.actorRole || "system"}) &middot; {formatDate(entry.createdAt)}
                    </p>
                    {entry.note && entry.actionKey !== "deposit_paid" ? <p className="mt-1 text-xs text-foreground-600">{entry.note}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          )
        ) : null}

        {tab === "messages" ? <ApplicationMessages applicationId={id} /> : null}

        {tab === "notifications" && paths.area === "cms" ? (
          <div>
            <NotificationGateBanner />
            <NotificationLogTable applicationId={id} />
          </div>
        ) : null}
      </div>

      {wizardOpen && !(role === "student" && handoff?.state) ? (
        <ApplicationWizard
          applicationId={application.id}
          agencyName={agencyName}
          onFinish={() => void handleWizardFinish()}
          onCancel={closeWizard}
        />
      ) : null}
      <Toast message={toast.message} onDismiss={toast.dismiss} />
    </div>
  );
}

