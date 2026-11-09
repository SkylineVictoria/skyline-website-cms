import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, Field, Modal, PageHeader, TextArea } from "@/pages/admin/components/ui";
import { adminDecideStaff, adminReviewStaffDocument, adminStaffDetail, staffDocumentUrl, type StaffDecision, type StaffDetail, type StaffDocument } from "@/lib/staffApi";
import { STAFF_STATUS_LABEL, STAFF_STATUS_TONE, adminActionsFor, type StaffAdminAction, type StaffRole } from "@/lib/staffStatus";
import { EMPLOYMENT_TYPE_LABEL, JOB_APPLICATION_STATUS_LABEL } from "@/lib/jobs";

const ACTION_LABEL: Record<StaffAdminAction, string> = { approve: "Approve", reject: "Reject", activate: "Activate", deactivate: "Deactivate", reopen: "Reopen as draft" };
const NOTE_REQUIRED: Record<StaffAdminAction, boolean> = { approve: false, reject: true, activate: false, deactivate: false, reopen: true };
const ROLE_LABEL: Record<StaffRole, string> = { admin: "Admin", trainer: "Trainer" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</dt><dd className="text-sm text-foreground-900">{children || "—"}</dd></div>;
}

/** One person: details, documents (short-lived signed links), their job applications (hire / decline) and the Admin decisions. Admins only. */
export default function StaffDetailPage({ employee = false }: { employee?: boolean }) {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState<StaffAdminAction | null>(null);
  const [role, setRole] = useState<StaffRole>("trainer");
  const [note, setNote] = useState("");
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [review, setReview] = useState<{ document: StaffDocument; decision: "approved" | "rejected" } | null>(null);

  const load = useCallback(async () => {
    try { const next = await adminStaffDetail(id); setDetail(next); setRole(next.application.requested_role ?? "trainer"); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The application could not be loaded."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const open = (next: StaffAdminAction) => { setAction(next); setNote(""); setConfirmAdmin(false); setDialogError(""); };

  const decide = async () => {
    if (!action || !detail || busy) return;
    if (NOTE_REQUIRED[action] && !note.trim()) { setDialogError("Add a note explaining the decision."); return; }
    if ((action === "approve" || strictActivation) && role === "admin" && !confirmAdmin) { setDialogError("Tick the box to confirm this person should become an Admin."); return; }
    const decision: StaffDecision = strictActivation ? { action: "activateAccount", role, note: note.trim(), confirmAdmin } : action === "approve" ? { action, role, note: note.trim(), confirmAdmin } : { action, note: note.trim() };
    setBusy(true); setDialogError("");
    try { setDetail(await adminDecideStaff(detail.profile.id, decision)); setAction(null); }
    catch (e) { setDialogError(e instanceof Error ? e.message : "That could not be done."); }
    finally { setBusy(false); }
  };

  const openPath = async (storagePath: string) => {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const url = await staffDocumentUrl(storagePath, 120);
      if (tab) tab.location.replace(url);
      else window.location.assign(url);
    } catch (e) { tab?.close(); setError((e as Error).message); }
  };
  const openDoc = (doc: StaffDocument) => openPath(doc.storagePath);

  const strictActivation = action === "activate" && !!detail?.requiredCategories && detail.profile.status !== "inactive";
  const saveReview = async () => {
    if (!review || busy) return;
    setBusy(true); setDialogError("");
    try { setDetail(await adminReviewStaffDocument(review.document.id, review.decision, note.trim())); setReview(null); }
    catch (e) { setDialogError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (error && !detail) return <div><PageHeader title="Staff application" /><p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p></div>;
  if (!detail) return <p className="text-sm text-foreground-600" role="status">Loading…</p>;
  const { profile, application } = detail;
  const activeRole = detail.roles.find((r) => !r.revokedAt)?.role;
  const actions = detail.requiredCategories && profile.status === "submitted" ? (["activate", "reject"] as const) : adminActionsFor(profile.status);
  const address = [profile.address_street, profile.address_line2, profile.address_suburb, profile.address_state, profile.address_postcode, profile.address_country].filter(Boolean).join(", ");

  return (
    <div>
      <PageHeader breadcrumb={employee ? "Master Data / Employees / Onboarding" : "Staff"} title={[profile.first_name, profile.middle_name, profile.last_name].filter(Boolean).join(" ") || profile.email}
        description={`Requested role: ${application.requested_role ? ROLE_LABEL[application.requested_role] : "none"}${activeRole ? ` · Role on record: ${ROLE_LABEL[activeRole]}` : ""}`}
        actions={<>
          <span data-testid="staff-detail-status"><Badge tone={STAFF_STATUS_TONE[profile.status]}>{STAFF_STATUS_LABEL[profile.status]}</Badge></span>
          {actions.map((a) => <Button key={a} variant={a === "approve" || a === "activate" ? "primary" : "outline"} onClick={() => open(a)} data-testid={`staff-action-${a}`}>{ACTION_LABEL[a]}</Button>)}
        </>} />
      <p className="-mt-3 mb-4 text-sm"><Link to={employee ? `/admin/employees/${id}` : "/admin/staff"} className="text-primary-700 hover:underline">{employee ? "← Employee record" : "← All staff"}</Link></p>
      {error ? <p role="alert" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Details</h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Row label="Email">{profile.email}</Row><Row label="Mobile">{profile.phone_e164}</Row>
            <Row label="Date of birth">{profile.date_of_birth}</Row><Row label="Address">{address}</Row>
            <Row label="Emergency contact">{[profile.emergency_name, profile.emergency_relationship, profile.emergency_phone_e164].filter(Boolean).join(" · ")}</Row>
            <Row label="Submitted">{application.submitted_at ? new Date(application.submitted_at).toLocaleString() : ""}</Row>
            <Row label="Admin console access">{detail.hasCmsAccess ? "Yes (Admin)" : "No"}</Row>
            <Row label="Review note">{application.review_note}</Row>
          </dl>
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Documents</h2>
          {detail.requiredCategories ? <p className="mb-3 text-sm text-foreground-600">Required before activation: {detail.requiredCategories.join(", ")}.</p> : null}
          {detail.documents.length === 0 ? <p className="text-sm text-foreground-600">No documents uploaded.</p> : (
            <ul className="space-y-2" data-testid="staff-documents">
              {detail.documents.map((d) => (
                <li key={d.id} className="rounded-md border border-background-200 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="min-w-0"><span className="font-semibold">{d.category}</span> <span className="truncate text-foreground-600">{d.filename}</span></span>
                    <Button size="sm" variant="outline" onClick={() => void openDoc(d)}>View</Button>
                    {d.status ? <Badge tone={d.status === "approved" ? "success" : "muted"}>{d.status}</Badge> : null}
                    {detail.requiredCategories?.some((category) => category === d.category) && (profile.status === "submitted" || profile.status === "preboarding") ? <>
                      <Button size="sm" variant="outline" disabled={d.status === "approved"} onClick={() => { setNote(""); setDialogError(""); setReview({ document: d, decision: "approved" }); }}>Approve</Button>
                      <Button size="sm" variant="outline" disabled={d.status === "rejected"} onClick={() => { setNote(""); setDialogError(""); setReview({ document: d, decision: "rejected" }); }}>Reject</Button>
                    </> : null}
                  </div>
                  {d.expiryDate ? <p className="mt-1 text-xs">Expiry: {d.expiryDate}</p> : null}
                  {d.reviewNote ? <p className="mt-1 text-xs">{d.reviewNote}</p> : null}
                  {d.extractionStatus === "done" ? <p className="mt-1 text-xs text-foreground-600">Read from the document: {[d.extracted.passport_number && `number ${d.extracted.passport_number}`, d.extracted.passport_expiry && `expires ${d.extracted.passport_expiry}`, d.extracted.dob && `born ${d.extracted.dob}`].filter(Boolean).join(" · ") || "details filled"}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {detail.jobApplications?.length ? (
        <Card className="mt-6 p-5">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Job applications</h2>
          <ul className="space-y-3" data-testid="staff-job-applications">
            {detail.jobApplications.map((a) => (
              <li key={a.id} className="rounded-md border border-background-200 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground-950">{a.jobTitle} <span className="font-normal text-foreground-600">· {EMPLOYMENT_TYPE_LABEL[a.employmentType]} · {a.location}</span></p>
                    <p className="text-xs text-foreground-500">Applied {new Date(a.appliedAt).toLocaleString()}{a.decidedAt ? ` · decided ${new Date(a.decidedAt).toLocaleString()}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={a.status === "hired" ? "success" : a.status === "declined" ? "muted" : "warn"}>{JOB_APPLICATION_STATUS_LABEL[a.status]}</Badge>
                    <Link to={`/admin/candidates/${a.id}`} className="font-medium text-primary-700 hover:underline">View candidate</Link>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.resume ? <Button size="sm" variant="outline" onClick={() => void openPath(a.resume!.storagePath)}><i className="ri-file-text-line" aria-hidden="true" /> Resume: {a.resume.filename}</Button> : null}
                  {a.coverLetterDocument ? <Button size="sm" variant="outline" onClick={() => void openPath(a.coverLetterDocument!.storagePath)}><i className="ri-file-text-line" aria-hidden="true" /> Cover letter: {a.coverLetterDocument.filename}</Button> : null}
                </div>
                {a.coverLetter ? <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-primary-700">Cover letter</summary><p className="mt-1 whitespace-pre-line text-foreground-700">{a.coverLetter}</p></details> : null}
                {a.decisionNote ? <p className="mt-2 text-xs text-foreground-600">Note: {a.decisionNote}</p> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mt-6 p-5">
        <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">History</h2>
        <ol className="space-y-2">
          {[...detail.events].reverse().map((e, i) => (
            <li key={`${e.at}-${i}`} className="text-sm"><span className="font-semibold">{e.from ? `${STAFF_STATUS_LABEL[e.from]} → ` : ""}{STAFF_STATUS_LABEL[e.to]}</span>
              <span className="ml-2 text-xs text-foreground-500">{new Date(e.at).toLocaleString()} · {e.actorKind}</span>{e.note ? <p className="text-foreground-700">{e.note}</p> : null}</li>
          ))}
        </ol>
      </Card>

      <Modal open={action !== null} title={action ? `${ACTION_LABEL[action]}: ${profile.email}` : ""} onClose={() => { if (!busy) setAction(null); }}
        footer={<><Button variant="outline" onClick={() => setAction(null)}>Cancel</Button><Button onClick={() => void decide()} disabled={busy} data-testid="staff-decision-confirm">{busy ? "Working…" : action ? ACTION_LABEL[action] : ""}</Button></>}>
        <div className="space-y-4">
          {action === "approve" || strictActivation ? (
            <>
              <Field label="Role to grant" hint={strictActivation ? "Activation requires approved, current documents." : "CMS access for an Admin starts when you activate the account."}>
                <div role="radiogroup" aria-label="Role to grant" className="flex gap-2">
                  {(["trainer", "admin"] as StaffRole[]).map((r) => (
                    <button key={r} type="button" role="radio" aria-checked={role === r} data-testid={`staff-grant-${r}`} onClick={() => { setRole(r); setConfirmAdmin(false); }}
                      className={`cursor-pointer rounded-md border px-4 py-2 text-sm font-semibold ${role === r ? "border-primary-500 bg-primary-50 text-primary-800" : "border-background-300 text-foreground-700"}`}>{ROLE_LABEL[r]}</button>
                  ))}
                </div>
              </Field>
              {role === "admin" ? (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900">
                  <input type="checkbox" data-testid="staff-confirm-admin" checked={confirmAdmin} onChange={(e) => setConfirmAdmin(e.target.checked)} className="mt-0.5 h-4 w-4" />
                  <span>I confirm that <strong>{profile.email}</strong> should become an <strong>Admin</strong>, with full access to the admin console once activated.</span>
                </label>
              ) : null}
            </>
          ) : null}
          {action === "deactivate" ? <p className="text-sm text-foreground-700">This switches off their admin console access (if any) and marks them Inactive.</p> : null}
          <Field label={NOTE_REQUIRED[action ?? "approve"] ? "Note (required)" : "Note (optional)"}><TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="staff-decision-note" /></Field>
          {dialogError ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{dialogError}</p> : null}
        </div>
      </Modal>

      {review ? <Modal open title={`${review.decision === "approved" ? "Approve" : "Reject"} ${review.document.category}`} onClose={() => { if (!busy) setReview(null); }}
        footer={<><Button variant="outline" disabled={busy} onClick={() => setReview(null)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void saveReview()}>{busy ? "Saving…" : "Confirm review"}</Button></>}>
        <p className="mb-3 text-sm">{review.document.filename}</p>
        {review.decision === "rejected" ? <Field label="Reason" required><TextArea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></Field> : null}
        {dialogError ? <p role="alert" className="text-sm text-primary-700">{dialogError}</p> : null}
      </Modal> : null}
    </div>
  );
}
