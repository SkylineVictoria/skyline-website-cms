import ResponsiveTable from "@/components/ui/ResponsiveTable";
import PersonMessageIcon from "@/pages/admin/components/PersonMessageIcon";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Card, ConfirmDialog } from "@/pages/admin/components/ui";
import { ApplicationStatusPills } from "@/pages/admin/components/AgencyStatus";
import { ListMessage, Pager, SearchBox, StatusTabs } from "@/pages/admin/components/ListControls";
import { useToast } from "@/pages/admin/components/toastContext";
import { deleteStudentRecord, ENROLMENT_LABEL, ENROLMENT_ORDER, listStudents, PORTAL_ACCESS_LABEL, sendStudentInvitation, setStudentStatus, type EnrolmentStage, type PortalAccess, type StudentCounts, type StudentRow } from "@/pages/admin/lib/businessData";
import EditStudentDialog from "@/pages/admin/components/EditStudentDialog";
import { deleteApplicationDocument, listApplicationDocuments } from "@/pages/agency/lib/portalApplications";
import { StatusBadge } from "@/pages/agency/components/PortalUI";
import TakeActionMenu from "@/components/shared/application-status/TakeActionMenu";
import ActivateInIntakeDialog from "@/components/shared/application-status/ActivateInIntakeDialog";
import { getAllowedActions, statusInfo, useApplicationStatuses, type StatusAction } from "@/lib/applicationStatuses";
import { changeApplicationStatus, createApplicationForStudent } from "@/pages/agency/lib/portalApplications";
import { formatPhone } from "../../../../supabase/functions/_shared/validation/identifiers";

// Up to 100 students load per page and are sorted on this device (like the Agents list).
const PAGE_SIZE = 100;
type SortKey = "student" | "business" | "agent" | "applications" | "studentStatus";
const text = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
const studentStatusOf = (row: StudentRow) => row.status ?? "Active";
const inactiveBusiness = (row: StudentRow) => Boolean(row.businessStatus) && row.businessStatus !== "Active";
const ENROLMENT_TONE: Record<string, string> = {
  enrolled: "border-emerald-200 bg-emerald-50 text-emerald-800", deposit_paid: "border-teal-200 bg-teal-50 text-teal-800", offer_accepted: "border-sky-200 bg-sky-50 text-sky-800",
  offer_issued: "border-violet-200 bg-violet-50 text-violet-800", applicant: "border-amber-200 bg-amber-50 text-amber-900", withdrawn: "border-background-300 bg-background-100 text-foreground-600",
  none: "border-background-300 bg-background-100 text-foreground-600",
};

function compareStudents(a: StudentRow, b: StudentRow, key: SortKey): number {
  // Students without a name yet sort after named ones.
  const byName = text(a.name || "￿").localeCompare(text(b.name || "￿")) || text(a.email).localeCompare(text(b.email));
  switch (key) {
    case "student": return byName;
    case "business": return text(a.businessName).localeCompare(text(b.businessName)) || byName;
    case "agent": return text(a.agentName || "￿").localeCompare(text(b.agentName || "￿")) || byName;
    case "applications": return a.applications - b.applications || byName;
    case "studentStatus": return studentStatusOf(a).localeCompare(studentStatusOf(b)) || byName;
  }
}

/**
 * Students: who they are, their business and agent, the student's own status, and each application's status (shown
 * only). Disabling a student locks all of their applications until they are enabled again. With `businessId`, only
 * that business's students and no business column; with `agentId`, one agent's.
 */
export default function StudentsTable({ businessId, agentId, emptyText, refreshKey = 0 }: { businessId?: string; agentId?: string; emptyText?: string; refreshKey?: number }) {
  const { push } = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  // 2026-11-21: the tabs are about portal access (never enrolment); "" is All. Enrolment is its own filter, derived from the applications.
  const [access, setAccess] = useState<PortalAccess | "">("");
  const [enrolment, setEnrolment] = useState<EnrolmentStage | "">("");
  const [counts, setCounts] = useState<StudentCounts | null>(null);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [confirmDisable, setConfirmDisable] = useState<StudentRow | null>(null);
  const [editing, setEditing] = useState<StudentRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StudentRow | null>(null);
  const [busyId, setBusyId] = useState("");
  // ONE-STATUS (owner, 2026-11-23): Student status, Enrolment and the main application's status are one Status dropdown.
  const workflow = useApplicationStatuses();
  const [move, setMove] = useState<{ row: StudentRow; applicationId: string; action: StatusAction } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listStudents({ search, access, enrolment, businessId: businessId ?? null, agentId: agentId ?? null, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      .then((result) => { if (active) { setRows(result.rows); setTotal(result.total); setCounts(result.counts ?? null); setLoaded(true); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "We could not load students."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [search, access, enrolment, businessId, agentId, page, reload, refreshKey]);

  // No sort chosen: the server's order (latest activity first).
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const out = [...rows].sort((a, b) => compareStudents(a, b, sort.key));
    if (sort.dir === "desc") out.reverse();
    // Students of an inactive business always stay at the bottom.
    return [...out.filter((r) => !inactiveBusiness(r)), ...out.filter(inactiveBusiness)];
  }, [rows, sort]);
  const toggleSort = (key: SortKey) => setSort((prev) => ({ key, dir: prev?.key === key && prev.dir === "asc" ? "desc" : "asc" }));
  const sortHeader = (key: SortKey, label: string, className: string) => (
    <th className={className} aria-sort={sort?.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 hover:text-foreground-900">
        {label}
        <i aria-hidden="true" className={sort?.key === key ? (sort.dir === "asc" ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line") : "ri-arrow-up-down-line text-foreground-400"} />
      </button>
    </th>
  );

  const invite = async (row: StudentRow) => {
    setBusyId(row.id);
    try {
      push(await sendStudentInvitation({ id: row.id, email: row.email, name: row.name, agencyId: row.agencyId, login: row.login }));
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not send the invitation.", "error");
    } finally {
      setBusyId("");
    }
  };

  const changeStudentStatus = async (row: StudentRow, next: "Active" | "Inactive") => {
    setBusyId(row.id);
    try {
      await setStudentStatus(row.id, next);
      push(next === "Inactive"
        ? `${row.name || row.email} disabled. Their applications are locked until they are enabled again.`
        : `${row.name || row.email} enabled. Their applications can be worked on again.`);
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not change this student's status.", "error");
    } finally {
      setBusyId("");
      setConfirmDisable(null);
    }
  };

  /** The application the Status follows: the most advanced one (row.enrolment), else the first. */
  const mainApplication = (row: StudentRow) => {
    const apps = (row.applicationRows ?? []).filter((a) => a.status !== "draft");
    return apps.find((a) => a.id === row.enrolment?.applicationId) ?? apps[0] ?? null;
  };
  /** "Change status to" moves the signed-in user may make from this status (set_*, Admins; the database checks again). */
  const movesFrom = (status: string) => getAllowedActions(workflow, status).filter((a) => a.action.startsWith("set_") && a.to);
  /** Start an application for the student and open it in the wizard (the same page Add student goes to). */
  const startApplication = async (row: StudentRow) => {
    setBusyId(row.id);
    try {
      const key = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const { id } = await createApplicationForStudent(key, row.id);
      navigate(`/admin/applications/${id}?wizard=1`);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not start the application.", "error");
    } finally {
      setBusyId("");
    }
  };
  const pickStatus = (row: StudentRow, value: string) => {
    if (value === "__inactive") { setConfirmDisable(row); return; }
    if (value === "__enable") { void changeStudentStatus(row, "Active"); return; }
    const app = mainApplication(row);
    const action = app ? movesFrom(app.status).find((a) => a.to === value) : undefined;
    if (app && action) setMove({ row, applicationId: app.id, action });
  };
  const runMove = async () => {
    if (!move) return;
    setBusyId(move.row.id);
    try {
      const result = await changeApplicationStatus(move.applicationId, move.action.action, { note: "Changed on the Students list" });
      push(`${move.row.name || move.row.email} is now ${result.label}.`);
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not change the status.", "error");
    } finally {
      setBusyId(""); setMove(null);
    }
  };

  // Deleting a student deletes all of their applications too. Files of applications still being worked on are removed
  // here first (the document-delete function keeps files of submitted ones); the database then deletes every
  // application with its records and queues any remaining files for removal, then the student.
  const submittedCount = (row: StudentRow) => (row.applicationRows ?? []).filter((application) => application.status !== "draft").length;
  const deleteStudent = async (row: StudentRow) => {
    setBusyId(row.id);
    try {
      // Draft files are removed in parallel; anything left over is queued by the server.
      const editable = (row.applicationRows ?? []).filter((a) => a.status === "draft" || a.status === "action_required");
      await Promise.all(editable.map(async (application) => {
        const documents = await listApplicationDocuments(application.id).catch(() => []);
        await Promise.all(documents.map((document) => deleteApplicationDocument({ id: document.id, storagePath: document.storagePath }).catch(() => undefined)));
      }));
      const result = await deleteStudentRecord(row.id);
      const count = result.applicationsDeleted ?? row.applications;
      // Drop the row straight away so the list never shows a deleted student.
      setRows((current) => current.filter((r) => r.id !== row.id));
      setTotal((n) => Math.max(0, n - 1));
      push(`${row.name || row.email} deleted, with ${count} application${count === 1 ? "" : "s"}.`);
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not delete this student.", "error");
      setReload((n) => n + 1);
    } finally {
      setBusyId("");
      setConfirmDelete(null);
    }
  };

  // The browser's own confirm box: it always shows in front of the page, however long the list is.
  const askDelete = (row: StudentRow) => {
    const who = row.name || row.email || "this student";
    const total = row.applications;
    const submitted = submittedCount(row);
    const ok = window.confirm(`Delete ${who}?

This permanently deletes the student and ALL ${total} of their application${total === 1 ? "" : "s"}${submitted > 0 ? `, including ${submitted} submitted or processed application${submitted === 1 ? "" : "s"}` : ""}, with their documents, history and messages. This cannot be undone.${submitted > 0 ? "\n\nTo keep the records, set the Student status to Disabled instead." : ""}`);
    if (!ok) return;
    setConfirmDelete(row);
    void deleteStudent(row);
  };

  const filtered = Boolean(search || access || enrolment);
  const columns = businessId ? 4 : 5;
  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        {/* Portal access (2026-11-21): whether the student can use the portal; enrolment is the separate filter beside it. */}
        <StatusTabs label="Portal access" value={access || "all"} onChange={(v) => { setAccess(v === "all" ? "" : v as PortalAccess); setPage(1); }}
          tabs={[{ id: "all", label: "All", count: counts?.access?.all ?? counts?.all ?? null },
            ...(["active", "invited", "not_invited", "disabled"] as const).map((a) => ({ id: a, label: PORTAL_ACCESS_LABEL[a], count: counts?.access?.[a] ?? null }))]} />
        <label className="flex items-center gap-2 text-sm text-foreground-700">
          <span className="whitespace-nowrap">Enrolment</span>
          <select value={enrolment} onChange={(e) => { setEnrolment(e.target.value as EnrolmentStage | ""); setPage(1); }} data-testid="students-enrolment-filter"
            className="rounded-md border border-background-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary-100">
            <option value="">Any</option>
            {ENROLMENT_ORDER.map((stage) => <option key={stage} value={stage}>{ENROLMENT_LABEL[stage]}{counts?.enrolment ? ` (${counts.enrolment[stage] ?? 0})` : ""}</option>)}
          </select>
        </label>
        <div className="flex-1"><SearchBox label="Search students" value={search} onSearch={(v) => { setSearch(v); setPage(1); }}
          placeholder={businessId ? "Search name, email, mobile, passport, agent or application reference" : "Search name, email, mobile, passport, business, agent or application reference"} /></div>
      </div>
      <Card>
        {error ? (
          <ListMessage icon="ri-error-warning-line" title="Students did not load" text={error}
            action={<Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>Try again</Button>} />
        ) : loaded && !loading && rows.length === 0 ? (
          <ListMessage icon="ri-user-line" title={filtered ? "No students match" : "No students yet"}
            text={filtered ? "Check the spelling, or choose another portal access tab or enrolment." : emptyText ?? "Students appear here when an agent adds them."} />
        ) : (
          <div className={loading && loaded ? "opacity-60 transition-opacity" : ""}>
            <ResponsiveTable aria-busy={loading}>
              <thead>
                <tr>
                  {sortHeader("student", "Student", businessId ? "w-[26%]" : "w-[21%]")}
                  {businessId ? null : sortHeader("business", "Business", "w-[13%]")}
                  {sortHeader("agent", "Agent", "w-[11%]")}
                  {sortHeader("studentStatus", "Status", "w-[22%]")}
                  {sortHeader("applications", "Applications", "w-[23%]")}
                </tr>
              </thead>
              <tbody>
                {!loaded ? <tr><td colSpan={columns} className="py-10 text-center text-foreground-500">Loading students…</td></tr> : sorted.map((row) => {
                  const disabled = studentStatusOf(row) === "Inactive";
                  return (
                    <tr key={row.id} className={`align-top ${inactiveBusiness(row) ? "bg-background-100/70 opacity-60" : disabled ? "bg-background-100/60" : ""}`}
                      title={inactiveBusiness(row) ? "This student's business is inactive" : undefined}>
                      <td>
                        <Link to={`/admin/students/${row.id}`} className="font-semibold text-foreground-900 hover:text-primary-700">
                          {row.name || <span className="italic text-foreground-500">Name not read from passport yet</span>}
                        </Link>
                        <PersonMessageIcon phone={row.phone} name={row.name} email={row.email} />
                        <p className="mt-0.5 text-xs text-foreground-600">{row.email || "No email"}</p>
                        {row.phone ? <p className="text-xs text-foreground-600">{formatPhone(row.phone)}</p> : null}
                        {row.passportNumber || row.nationality ? (
                          <p className="text-xs text-foreground-500">{[row.passportNumber ? `Passport ${row.passportNumber}` : "", row.nationality ?? ""].filter(Boolean).join(" · ")}</p>
                        ) : null}
                        <span className="mt-1.5 flex gap-3 text-xs font-semibold">
                          <button type="button" disabled={busyId === row.id} onClick={() => setEditing(row)} className="inline-flex items-center gap-1 text-primary-700 hover:underline disabled:opacity-50">
                            <i className="ri-edit-line" aria-hidden="true" /> Edit
                          </button>
                          <button type="button" disabled={busyId === row.id} onClick={() => askDelete(row)} className="inline-flex items-center gap-1 text-red-700 hover:underline disabled:opacity-50">
                            <i className="ri-delete-bin-line" aria-hidden="true" /> {busyId === row.id && confirmDelete?.id === row.id ? "Deleting…" : "Delete"}
                          </button>
                        </span>
                      </td>
                      {businessId ? null : <td><Link to={`/admin/businesses/${row.businessId}`} className="text-foreground-800 hover:text-primary-700">{row.businessName}</Link>{inactiveBusiness(row) ? <p className="text-xs font-medium text-foreground-600">Business inactive</p> : null}</td>}
                      <td>{row.agentId ? <Link to={`/admin/agents/${row.agentId}`} className="text-foreground-800 hover:text-primary-700">{row.agentName}</Link> : <span className="text-xs text-foreground-500">Not assigned</span>}</td>
                      <td data-testid={`student-status-cell-${row.id}`}>
                        {(() => {
                          const app = disabled ? null : mainApplication(row);
                          const moves = app ? movesFrom(app.status) : [];
                          const current = disabled ? "__inactive" : app?.status ?? "";
                          const tone = disabled ? ENROLMENT_TONE.none : ENROLMENT_TONE[row.enrolment?.stage ?? "none"] ?? ENROLMENT_TONE.none;
                          return <div className="flex flex-col items-start gap-1 text-xs">
                            <label className="sr-only" htmlFor={`student-status-${row.id}`}>Status for {row.name || row.email}</label>
                            <select id={`student-status-${row.id}`} value={current} disabled={busyId === row.id || row.status === undefined}
                              onChange={(e) => pickStatus(row, e.target.value)}
                              className={`max-w-full cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium outline-none focus:ring-2 focus:ring-primary-100 disabled:opacity-60 ${tone}`}>
                              {disabled ? <>
                                <option value="__inactive">Inactive (switched off)</option>
                                <option value="__enable">Switch back on</option>
                              </> : <>
                                {app ? <option value={app.status}>{busyId === row.id ? "Saving…" : statusInfo(workflow, app.status).label}</option> : <option value="">No submitted application</option>}
                                {moves.map((a) => <option key={a.action} value={a.to ?? ""}>{a.to === "active" ? "Active (choose intake)" : statusInfo(workflow, a.to ?? "").label}</option>)}
                                <option value="__inactive">Inactive (switch off student)</option>
                              </>}
                            </select>
                            {!disabled && row.enrolment?.stage === "deposit_paid" ? <span className="font-medium text-teal-800">Deposit paid</span> : null}
                            {app ? <Link to={`/admin/applications/${app.id}`} className="text-foreground-700 hover:text-primary-700">
                              {[app.course, app.reference].filter(Boolean).join(" · ") || "Application"}</Link> : null}
                            {/* Portal access as plain text (not a second status pill), with Invite when it is needed. */}
                            {(() => {
                              const access = disabled ? "disabled" : row.portalAccess ?? "not_invited";
                              const canInvite = !disabled && Boolean(row.email) && access !== "active" && access !== "disabled";
                              return <span className="inline-flex flex-wrap items-center gap-1 text-foreground-600" title="Portal access (login)">
                                <i className="ri-key-2-line" aria-hidden="true" /> Login: {PORTAL_ACCESS_LABEL[access]}
                                {canInvite ? <button type="button" disabled={busyId === row.id} onClick={() => void invite(row)}
                                  className="ml-1 font-semibold text-primary-700 hover:underline disabled:opacity-60">{access === "invited" ? "Resend" : "Invite"}</button> : null}
                              </span>;
                            })()}
                          </div>;
                        })()}
                      </td>
                      <td>
                        {row.applicationRows ? (
                          row.applicationRows.length === 0 ? (disabled ? <span className="text-xs text-foreground-500">No applications</span> : <span className="flex flex-col items-start gap-1 text-xs">
                            <span className="text-foreground-500">No applications</span>
                            <Button size="sm" icon="ri-magic-line" disabled={busyId === row.id} onClick={() => void startApplication(row)}>Start application</Button>
                          </span>) : (
                            <ul className="space-y-2">
                              {row.applicationRows.map((application) => (
                                <li key={application.id} className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="min-w-0 text-xs">
                                    <Link to={`/admin/applications/${application.id}`} className="font-semibold text-foreground-900 hover:text-primary-700">{application.reference || "Draft"}</Link>
                                    <span className="block text-foreground-600">{[application.course || "No course yet", application.intake ? `Intake ${application.intake}` : "", `${application.completion}%`].filter(Boolean).join(" · ")}</span>
                                    {!disabled && application.status === "draft" ? <Link to={`/admin/applications/${application.id}?wizard=1`} className="font-semibold text-primary-700 hover:underline"><i className="ri-magic-line" aria-hidden="true" /> Continue in wizard</Link> : null}
                                  </span>
                                  <span className="inline-flex flex-col items-end gap-0.5">
                                    {/* STUDENT-STATUS-MENU (owner, 2026-11-23): the application status (and so Enrolment) can be changed here by hand
                                        when automation did not move it: the same Take action menu as the Applications list ("Change status to", Admins). */}
                                    {/* ONE-STATUS: the main application's status is the Status dropdown; only the others show a badge here. */}
                                    {application.id !== mainApplication(row)?.id ? <StatusBadge status={application.status} /> : null}
                                    {!disabled && application.status !== "draft" && application.id !== mainApplication(row)?.id ? <TakeActionMenu
                                      application={{ id: application.id, status: application.status, reference: application.reference, studentName: row.name ?? "", studentId: row.id,
                                        course: application.course ? { title: application.course, code: application.course } : null, intake: application.intake }}
                                      onDone={() => setReload((n) => n + 1)}
                                      onResult={(message, ok) => push(message, ok ? undefined : "error")} /> : null}
                                    {disabled ? <span className="text-2xs font-medium text-foreground-500"><i className="ri-lock-line" aria-hidden="true" /> Locked</span> : null}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )
                        ) : (
                          <>
                            <p className="mb-1 text-xs font-semibold text-foreground-900">{row.applications} application{row.applications === 1 ? "" : "s"}</p>
                            <ApplicationStatusPills counts={row.statusCounts} />
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </ResponsiveTable>
          </div>
        )}
        {!error ? <Pager page={page} pageSize={PAGE_SIZE} total={total} loading={loading} onPage={setPage} /> : null}
      </Card>

      <EditStudentDialog student={editing} onClose={() => setEditing(null)} onSaved={() => setReload((n) => n + 1)} />

      {move && move.action.to === "active" ? (
        <ActivateInIntakeDialog application={{ id: move.applicationId, studentName: move.row.name ?? "" }} action={move.action}
          onClose={() => setMove(null)}
          onDone={(result) => { push(`${move.row.name || move.row.email} is now ${result.label}.`); setMove(null); setReload((n) => n + 1); }} />
      ) : null}
      <ConfirmDialog
        open={Boolean(move) && move?.action.to !== "active"}
        title={`Change ${move?.row.name || move?.row.email || "this student"} to ${move?.action.to ? statusInfo(workflow, move.action.to).label : ""}?`}
        message="This moves the status by hand. To issue an offer letter or CoE / VoE, use Take action under Applications instead."
        confirmLabel={busyId ? "Saving…" : "Change status"}
        onConfirm={() => { if (!busyId) void runMove(); }}
        onCancel={() => { if (!busyId) setMove(null); }}
      />
      <ConfirmDialog
        open={Boolean(confirmDisable)}
        title={`Disable ${confirmDisable?.name || confirmDisable?.email || "this student"}?`}
        message={`All ${confirmDisable?.applications ?? 0} of their application${confirmDisable?.applications === 1 ? "" : "s"} will be locked: nothing can be edited, uploaded, submitted or have its status changed. Their statuses are kept, and enabling the student again unlocks everything.`}
        confirmLabel={busyId ? "Disabling…" : "Disable student"}
        onConfirm={() => { if (confirmDisable && !busyId) void changeStudentStatus(confirmDisable, "Inactive"); }}
        onCancel={() => { if (!busyId) setConfirmDisable(null); }}
      />
    </div>
  );
}
