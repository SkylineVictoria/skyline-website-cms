import ResponsiveTable from "@/components/ui/ResponsiveTable";
import WhatsAppLink from "@/components/base/WhatsAppLink";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ConfirmDialog } from "@/pages/admin/components/ui";
import { ApplicationStatusPills } from "@/pages/admin/components/AgencyStatus";
import { ListMessage, Pager, SearchBox, StatusTabs } from "@/pages/admin/components/ListControls";
import { useToast } from "@/pages/admin/components/toastContext";
import { deleteStudentRecord, listStudents, sendStudentInvitation, setStudentStatus, type StudentCounts, type StudentRow } from "@/pages/admin/lib/businessData";
import StudentLoginCell from "@/pages/admin/components/StudentLoginCell";
import EditStudentDialog from "@/pages/admin/components/EditStudentDialog";
import { deleteApplicationDocument, listApplicationDocuments } from "@/pages/agency/lib/portalApplications";
import { useStatusCatalog } from "@/pages/agency/lib/statusCatalog";
import { StatusBadge } from "@/pages/agency/components/PortalUI";
import { formatPhone } from "../../../../supabase/functions/_shared/validation/identifiers";

// Up to 100 students load per page and are sorted on this device (like the Agents list).
const PAGE_SIZE = 100;
type SortKey = "student" | "business" | "agent" | "applications" | "studentStatus";
const text = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
const studentStatusOf = (row: StudentRow) => row.status ?? "Active";
const inactiveBusiness = (row: StudentRow) => Boolean(row.businessStatus) && row.businessStatus !== "Active";

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
  const statusCatalog = useStatusCatalog();
  const [search, setSearch] = useState("");
  // Active is the default tab; "" is All.
  const [status, setStatus] = useState("Active");
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

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listStudents({ search, studentStatus: status, businessId: businessId ?? null, agentId: agentId ?? null, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      .then((result) => { if (active) { setRows(result.rows); setTotal(result.total); setCounts(result.counts ?? null); setLoaded(true); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "We could not load students."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [search, status, businessId, agentId, page, reload, refreshKey]);

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

  const filtered = Boolean(search || status !== "Active");
  const columns = businessId ? 5 : 6;
  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        {/* Filters on the student's own status, from the backend's list (the same one the Student status column uses). */}
        <StatusTabs label="Student status" value={status || "all"} onChange={(v) => { setStatus(v === "all" ? "" : v); setPage(1); }}
          tabs={[{ id: "all", label: "All", count: counts?.all ?? null },
            ...statusCatalog.student.map((s) => ({ id: s.value, label: s.label, count: (s.value === "Active" ? counts?.active : s.value === "Inactive" ? counts?.inactive : undefined) ?? null }))]} />
        <div className="flex-1"><SearchBox label="Search students" value={search} onSearch={(v) => { setSearch(v); setPage(1); }}
          placeholder={businessId ? "Search name, email, mobile, passport, agent or application reference" : "Search name, email, mobile, passport, business, agent or application reference"} /></div>
      </div>
      <Card>
        {error ? (
          <ListMessage icon="ri-error-warning-line" title="Students did not load" text={error}
            action={<Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>Try again</Button>} />
        ) : loaded && !loading && rows.length === 0 ? (
          <ListMessage icon="ri-user-line" title={filtered ? "No students match" : "No students yet"}
            text={filtered ? "Check the spelling or choose another student status." : emptyText ?? "Students appear here when an agent adds them."} />
        ) : (
          <div className={loading && loaded ? "opacity-60 transition-opacity" : ""}>
            <ResponsiveTable aria-busy={loading}>
              <thead>
                <tr>
                  {sortHeader("student", "Student", businessId ? "w-[30%]" : "w-[25%]")}
                  {businessId ? null : sortHeader("business", "Business", "w-[16%]")}
                  {sortHeader("agent", "Agent", "w-[13%]")}
                  {sortHeader("studentStatus", "Student status", "w-[11%]")}
                  <th className="w-[12%]">Sign-in</th>
                  {sortHeader("applications", "Application status", "w-[23%]")}
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
                        <WhatsAppLink phone={row.phone} name={row.name} />
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
                      <td>
                        <label className="sr-only" htmlFor={`student-status-${row.id}`}>Status for {row.name || row.email}</label>
                        <select id={`student-status-${row.id}`} value={studentStatusOf(row)} disabled={busyId === row.id || row.status === undefined}
                          onChange={(e) => { if (e.target.value === "Inactive") setConfirmDisable(row); else void changeStudentStatus(row, "Active"); }}
                          className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium outline-none focus:ring-2 focus:ring-primary-100 disabled:opacity-60 ${disabled ? "border-background-300 bg-background-100 text-foreground-600" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
                          {statusCatalog.student.map((item) => (
                            <option key={item.value} value={item.value}>{busyId === row.id && item.value === studentStatusOf(row) ? "Saving…" : item.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <StudentLoginCell login={row.login} email={row.email} busy={busyId === row.id} disabled={disabled} onInvite={() => void invite(row)} />
                      </td>
                      <td>
                        {row.applicationRows ? (
                          row.applicationRows.length === 0 ? <span className="text-xs text-foreground-500">No applications</span> : (
                            <ul className="space-y-2">
                              {row.applicationRows.map((application) => (
                                <li key={application.id} className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="min-w-0 text-xs">
                                    <Link to={`/admin/applications/${application.id}`} className="font-semibold text-foreground-900 hover:text-primary-700">{application.reference || "Draft"}</Link>
                                    <span className="block text-foreground-600">{[application.course || "No course yet", application.intake ? `Intake ${application.intake}` : "", `${application.completion}%`].filter(Boolean).join(" · ")}</span>
                                  </span>
                                  <span className="inline-flex flex-col items-end gap-0.5">
                                    {/* Shown only; the status is changed on the Applications list or the application itself. */}
                                    <StatusBadge status={application.status} />
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
