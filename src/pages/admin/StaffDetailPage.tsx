import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { STAFF_EMPLOYEES_PATH } from "@/pages/admin/lib/staffRoutes";
import { Badge, Button, Card, Field, Modal, PageHeader, TextArea } from "@/pages/admin/components/ui";
import { adminDecideStaff, adminReviewStaffDocument, adminStaffDetail, staffDocumentUrl, type StaffDecision, type StaffDetail, type StaffDocument } from "@/lib/staffApi";
import {
  STAFF_DOC_LABEL, STAFF_STATUS_LABEL, STAFF_STATUS_TONE, adminActionsFor, expiryState, staffChecklist,
  type StaffAdminAction, type StaffDocCategory, type StaffRole,
} from "@/lib/staffStatus";

const ACTION_LABEL: Record<StaffAdminAction, string> = { approve: "Approve", reject: "Reject account", activate: "Activate account", reactivate: "Reactivate", deactivate: "Deactivate", reopen: "Reopen as draft" };
const NOTE_REQUIRED: Record<StaffAdminAction, boolean> = { approve: false, reject: true, activate: false, reactivate: false, deactivate: false, reopen: true };
const ROLE_LABEL: Record<StaffRole, string> = { admin: "Admin", trainer: "Trainer" };
const REVIEW_TONE = { pending: "warn", approved: "success", rejected: "muted" } as const;
const REVIEW_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" } as const;
const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{label}</dt><dd className="text-sm text-foreground-900">{children || "—"}</dd></div>;
}

function Expiry({ date }: { date: string | null }) {
  if (!date) return null;
  const state = expiryState(date);
  return (
    <span className={state === "soon" || state === "expired" ? "font-semibold text-primary-800" : "text-foreground-600"} data-expiry={state}>
      Expires {new Date(`${date}T00:00:00`).toLocaleDateString()}{state === "soon" ? " (expiring soon)" : state === "expired" ? " (expired)" : ""}
    </span>
  );
}

/** One staff member: details, documents with an in-page preview (short-lived signed links), per-document review, account decisions. Admins only. */
export default function StaffDetailPage() {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState<StaffAdminAction | null>(null);
  const [role, setRole] = useState<StaffRole>("trainer");
  const [note, setNote] = useState("");
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [preview, setPreview] = useState<{ doc: StaffDocument; url: string } | null>(null);
  const [rejecting, setRejecting] = useState<StaffDocument | null>(null);
  const [docNote, setDocNote] = useState("");
  const [docBusy, setDocBusy] = useState("");

  const load = useCallback(async () => {
    try { const next = await adminStaffDetail(id); setDetail(next); setRole(next.application.requested_role ?? "trainer"); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The application could not be loaded."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const open = (next: StaffAdminAction) => { setAction(next); setNote(""); setConfirmAdmin(false); setDialogError(""); };

  const decide = async () => {
    if (!action || !detail) return;
    if (NOTE_REQUIRED[action] && !note.trim()) { setDialogError("Add a note explaining the decision."); return; }
    if ((action === "approve" || action === "activate") && role === "admin" && !confirmAdmin) { setDialogError("Tick the box to confirm this person should become an Admin."); return; }
    const decision: StaffDecision = action === "approve" || action === "activate" ? { action, role, note: note.trim(), confirmAdmin } : { action, note: note.trim() };
    setBusy(true); setDialogError("");
    try { setDetail(await adminDecideStaff(detail.profile.id, decision)); setAction(null); }
    catch (e) { setDialogError(e instanceof Error ? e.message : "That could not be done."); }
    finally { setBusy(false); }
  };

  const view = async (doc: StaffDocument) => {
    setError("");
    try { setPreview({ doc, url: await staffDocumentUrl(doc.storagePath, 120) }); }
    catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); }
  };

  const review = async (doc: StaffDocument, decision: "approved" | "rejected", text = "") => {
    if (decision === "rejected" && !text.trim()) { setDialogError("Add a note telling them what to fix."); return; }
    setDocBusy(doc.id); setDialogError(""); setError("");
    try { setDetail(await adminReviewStaffDocument(doc.id, decision, text.trim())); setRejecting(null); }
    catch (e) { (decision === "rejected" ? setDialogError : setError)(e instanceof Error ? e.message : "The review could not be saved."); }
    finally { setDocBusy(""); }
  };

  if (error && !detail) return <div><PageHeader title="Staff member" /><p role="alert" className={ALERT}>{error}</p></div>;
  if (!detail) return <p className="text-sm text-foreground-600" role="status">Loading…</p>;
  const { profile, application, summary } = detail;
  const activeRole = detail.roles.find((r) => !r.revokedAt)?.role;
  const actions = adminActionsFor(profile.status);
  const canReview = profile.status !== "draft";
  const allApproved = summary.approved === summary.required;
  const address = [profile.address_street, profile.address_line2, profile.address_suburb, profile.address_state, profile.address_postcode, profile.address_country].filter(Boolean).join(", ");
  const checklist = staffChecklist(detail.documents, profile.is_australian_citizen);

  return (
    <div>
      <PageHeader breadcrumb="Staff / Employees" title={[profile.first_name, profile.middle_name, profile.last_name].filter(Boolean).join(" ") || profile.email}
        description={`Requested role: ${application.requested_role ? ROLE_LABEL[application.requested_role] : "none"}${activeRole ? ` · Role on record: ${ROLE_LABEL[activeRole]}` : ""} · Documents approved ${summary.approved}/${summary.required}`}
        actions={<>
          <span data-testid="staff-detail-status"><Badge tone={STAFF_STATUS_TONE[profile.status]}>{STAFF_STATUS_LABEL[profile.status]}</Badge></span>
          {actions.map((a) => <Button key={a} variant={a === "approve" || a === "activate" || a === "reactivate" ? "primary" : "outline"} onClick={() => open(a)} data-testid={`staff-action-${a}`}>{ACTION_LABEL[a]}</Button>)}
        </>} />
      <p className="-mt-3 mb-4 text-sm"><Link to={STAFF_EMPLOYEES_PATH} className="text-primary-700 hover:underline">&larr; All employees</Link></p>
      {error ? <p role="alert" className={`mb-4 ${ALERT}`}>{error}</p> : null}
      {summary.expiringSoon ? <p className={`mb-4 ${ALERT}`} data-testid="staff-detail-expiring">A document expires within 30 days or has expired. Check the dates below.</p> : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Details</h2>
          <dl className="grid gap-3">
            <Row label="Email">{profile.email}</Row><Row label="Mobile">{profile.phone_e164}</Row>
            <Row label="Date of birth">{profile.date_of_birth}</Row><Row label="Address">{address}</Row>
            <Row label="Australian citizen">{profile.is_australian_citizen === null ? "" : profile.is_australian_citizen ? "Yes" : "No"}</Row>
            <Row label="Emergency contact">{[profile.emergency_name, profile.emergency_relationship, profile.emergency_phone_e164].filter(Boolean).join(" · ")}</Row>
            <Row label="Submitted">{application.submitted_at ? new Date(application.submitted_at).toLocaleString() : ""}</Row>
            <Row label="Admin console access">{detail.hasCmsAccess ? "Yes (Admin)" : "No"}</Row>
            <Row label="Account review note">{application.review_note}</Row>
          </dl>
        </Card>
        <Card className="p-5 lg:col-span-3">
          <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">Documents</h2>
          {!canReview ? <p className="mb-3 text-xs text-foreground-600">Documents can be reviewed once the application is submitted.</p> : null}
          <ul className="space-y-4" data-testid="staff-documents">
            {checklist.map((item) => (
              <li key={item.kind.category}>
                <p className="mb-1.5 text-sm font-semibold text-foreground-950">{item.kind.label}{item.kind.required ? "" : " (optional)"}
                  {item.state === "missing" ? <span className="ml-2"><Badge tone="muted">{item.kind.required ? "Missing" : "Not provided"}</Badge></span> : null}</p>
                <ul className="space-y-2">
                  {detail.documents.filter((d) => d.category === item.kind.category).map((d) => (
                    <li key={d.id} className="rounded-md border border-background-200 px-3 py-2 text-sm" data-testid={`staff-doc-row-${d.id}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block truncate text-foreground-800">{d.filename}</span>
                          <span className="flex flex-wrap gap-x-3 text-xs"><Expiry date={d.expiryDate} />{d.reviewedAt ? <span className="text-foreground-500">Reviewed {new Date(d.reviewedAt).toLocaleDateString()}</span> : null}</span>
                        </span>
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={REVIEW_TONE[d.status]}>{REVIEW_LABEL[d.status]}</Badge>
                          <Button size="sm" variant="outline" onClick={() => void view(d)} data-testid={`staff-doc-view-${d.id}`}>Preview</Button>
                          {canReview && d.status !== "approved" ? <Button size="sm" onClick={() => void review(d, "approved")} disabled={docBusy === d.id} data-testid={`staff-doc-approve-${d.id}`}>Approve</Button> : null}
                          {canReview && d.status !== "rejected" ? <Button size="sm" variant="outline" onClick={() => { setRejecting(d); setDocNote(""); setDialogError(""); }} disabled={docBusy === d.id} data-testid={`staff-doc-reject-${d.id}`}>Reject</Button> : null}
                        </span>
                      </div>
                      {d.status === "rejected" && d.reviewNote ? <p className="mt-1 text-xs text-primary-900">Note: {d.reviewNote}</p> : null}
                      {d.extractionStatus === "done" ? <p className="mt-1 text-xs text-foreground-600">Read from the document: {[d.extracted.passport_number && `number ${d.extracted.passport_number}`, d.extracted.passport_expiry && `expires ${d.extracted.passport_expiry}`, d.extracted.dob && `born ${d.extracted.dob}`].filter(Boolean).join(" · ") || "details filled"}</p> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-6 p-5">
        <h2 className="mb-3 font-heading text-base font-bold text-foreground-950">History</h2>
        <ol className="space-y-2">
          {[...detail.events].reverse().map((e, i) => (
            <li key={`${e.at}-${i}`} className="text-sm"><span className="font-semibold">{e.from ? `${STAFF_STATUS_LABEL[e.from]} → ` : ""}{STAFF_STATUS_LABEL[e.to]}</span>
              <span className="ml-2 text-xs text-foreground-500">{new Date(e.at).toLocaleString()} · {e.actorKind}</span>{e.note ? <p className="text-foreground-700">{e.note}</p> : null}</li>
          ))}
        </ol>
      </Card>

      <Modal open={preview !== null} title={preview ? `${STAFF_DOC_LABEL[preview.doc.category as StaffDocCategory] ?? preview.doc.category}: ${preview.doc.filename}` : ""} onClose={() => setPreview(null)}
        footer={<Button variant="outline" onClick={() => setPreview(null)}>Close</Button>}>
        {preview ? (
          <div className="h-[65vh] w-full overflow-auto rounded-md bg-background-100" data-testid="staff-doc-preview">
            {preview.doc.mimeType === "application/pdf"
              ? <iframe title={preview.doc.filename} src={`${preview.url}#toolbar=0&navpanes=0`} className="h-full w-full border-0" />
              : <img src={preview.url} alt={preview.doc.filename} className="mx-auto max-h-full object-contain" />}
          </div>
        ) : null}
      </Modal>

      <Modal open={rejecting !== null} title={rejecting ? `Reject ${rejecting.filename}` : ""} onClose={() => setRejecting(null)}
        footer={<><Button variant="outline" onClick={() => setRejecting(null)}>Cancel</Button><Button onClick={() => rejecting && void review(rejecting, "rejected", docNote)} disabled={docBusy !== ""} data-testid="staff-doc-reject-confirm">Reject document</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-foreground-700">They see this note in their workspace and can upload a new file.</p>
          <Field label="What needs fixing (required)"><TextArea rows={3} value={docNote} onChange={(e) => setDocNote(e.target.value)} data-testid="staff-doc-reject-note" /></Field>
          {dialogError ? <p role="alert" className={ALERT}>{dialogError}</p> : null}
        </div>
      </Modal>

      <Modal open={action !== null} title={action ? `${ACTION_LABEL[action]}: ${profile.email}` : ""} onClose={() => setAction(null)}
        footer={<><Button variant="outline" onClick={() => setAction(null)}>Cancel</Button><Button onClick={() => void decide()} disabled={busy} data-testid="staff-decision-confirm">{busy ? "Working…" : action ? ACTION_LABEL[action] : ""}</Button></>}>
        <div className="space-y-4">
          {action === "activate" && !allApproved ? <p className={ALERT}>Approve every required document first ({summary.approved}/{summary.required} approved).</p> : null}
          {action === "approve" || action === "activate" ? (
            <>
              <Field label="Role to grant" hint={action === "activate" ? "Access starts now: an Admin gets the admin console; a Trainer gets no console access." : "The role is recorded now. CMS access for an Admin starts when you activate the account."}>
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
                  <span>I confirm that <strong>{profile.email}</strong> should become an <strong>Admin</strong>, with full access to the admin console.</span>
                </label>
              ) : null}
            </>
          ) : null}
          {action === "deactivate" ? <p className="text-sm text-foreground-700">This switches off their admin console access (if any) and marks them Inactive.</p> : null}
          <Field label={NOTE_REQUIRED[action ?? "approve"] ? "Note (required)" : "Note (optional)"}><TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} data-testid="staff-decision-note" /></Field>
          {dialogError ? <p role="alert" className={ALERT}>{dialogError}</p> : null}
        </div>
      </Modal>
    </div>
  );
}
