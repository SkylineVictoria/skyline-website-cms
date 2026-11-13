import ResponsiveTable from "@/components/ui/ResponsiveTable";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ConfirmDialog, PageHeader } from "@/pages/admin/components/ui";
import { ApplicationStatusPills } from "@/pages/admin/components/AgencyStatus";
import { ListMessage, Pager, SearchBox, StatusTabs } from "@/pages/admin/components/ListControls";
import { useToast } from "@/pages/admin/components/toastContext";
import { changeBusinessStatus, invitedBusinesses, listBusinesses, listPendingRegistrations, resendInvitation, setBusinessStatus, type BusinessRow, type BusinessStatus, type DirectoryAgent, type ListCounts, type PendingRegistration } from "@/pages/admin/lib/businessData";
import PendingRegistrationsTable from "@/pages/admin/components/PendingRegistrationsTable";
import { useListParams } from "@/pages/admin/lib/listParams";
import { useStatusCatalog } from "@/pages/agency/lib/statusCatalog";

const PAGE_SIZE = 25;
/** Active and Invited are worked out on the device from the active businesses (up to this many). */
const ACTIVE_LIMIT = 100;
const KEYS = ["q", "status"] as const;

/** Agencies > Businesses: one row per business (ABN), with its agents, students and applications. */
export default function BusinessesPage() {
  const { push } = useToast();
  const { values, page, update, setPage, clear } = useListParams(KEYS);
  // Tabs and each row's dropdown use the backend's business statuses.
  const businessStatuses = useStatusCatalog().business;
  // Active is the default tab; "all" in the address shows every business.
  const status = values.status === "all" ? "" : values.status === "Inactive" ? "Inactive" : values.status === "Invited" ? "Invited" : values.status === "Pending" ? "Pending" : "Active";
  // Invited: active, but nobody in it has signed in yet (its agents are all still invited).
  const [invited, setInvited] = useState<Map<string, DirectoryAgent[]>>(new Map());
  // Pending review: businesses that registered themselves from the sign-in page (migration 119).
  const [pending, setPending] = useState<PendingRegistration[]>([]);
  const [decline, setDecline] = useState<PendingRegistration | null>(null);
  const countFor = (value: string) => (value === "Active" ? (counts ? Math.max(0, counts.active - invited.size) : null)
    : value === "Invited" ? (counts ? invited.size : null) : value === "Pending" ? (counts ? pending.length : null) : value === "Inactive" ? counts?.inactive : undefined) ?? null;
  const [rows, setRows] = useState<BusinessRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<ListCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [confirm, setConfirm] = useState<BusinessRow | null>(null);
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const split = status === "Active" || status === "Invited";
    const pendingTab = status === "Pending";
    Promise.all([
      split ? listBusinesses({ search: values.q, status: "Active", limit: ACTIVE_LIMIT, offset: 0 })
        : listBusinesses({ search: values.q, status: pendingTab ? "Inactive" : status, limit: pendingTab ? 1 : PAGE_SIZE, offset: pendingTab ? 0 : (page - 1) * PAGE_SIZE }),
      invitedBusinesses().catch(() => new Map<string, DirectoryAgent[]>()),
      listPendingRegistrations().catch(() => [] as PendingRegistration[]),
    ])
      .then(([result, invitedMap, pendingList]) => {
        if (!active) return;
        setInvited(invitedMap);
        setPending(pendingList);
        if (pendingTab) {
          setRows([]);
          setTotal(pendingList.length);
        } else if (split) {
          const kept = result.rows.filter((r) => (status === "Invited") === invitedMap.has(r.id));
          setRows(kept.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE));
          setTotal(kept.length);
        } else {
          setRows(result.rows);
          setTotal(result.total);
        }
        setCounts(result.counts);
      })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "We could not load businesses."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [values.q, status, page, reload]);

  const change = async (row: BusinessRow, next: BusinessStatus) => {
    setBusyId(row.id);
    try {
      push(await changeBusinessStatus(row, next));
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not change this business’s status.", "error");
    } finally {
      setBusyId("");
      setConfirm(null);
    }
  };

  const resend = async (row: BusinessRow) => {
    const people = invited.get(row.id) ?? [];
    // The business's administrators first; when none is waiting, every invited agent.
    const admins = people.filter((p) => p.role === "agency_admin");
    const targets = (admins.length ? admins : people).filter((p) => p.email);
    if (!targets.length) { push("No one in this business has an email to invite.", "error"); return; }
    setBusyId(row.id);
    try {
      const messages: string[] = [];
      for (const person of targets) messages.push(await resendInvitation(person));
      push(messages.join(" "));
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not resend that invitation.", "error");
    } finally {
      setBusyId("");
    }
  };

  // Approving activates the business and emails its waiting administrator invitation; declining leaves it inactive.
  const approve = async (row: PendingRegistration) => {
    setBusyId(row.id);
    try {
      const result = await setBusinessStatus(row.id, "Active");
      let message = `${row.name} approved and active.`;
      if (result.pendingInvitation) {
        try {
          message += ` ${await resendInvitation({ invitationId: result.pendingInvitation.id, email: result.pendingInvitation.email, name: result.pendingInvitation.name, role: "agency_admin", businessId: row.id })}`;
        } catch (e) {
          message += ` The invitation email could not be sent${e instanceof Error && e.message ? ` (${e.message})` : ""}; resend it from the Invited tab.`;
        }
      } else if (row.signedIn) {
        message += " Its administrator can sign in now.";
      }
      push(message);
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not approve this registration.", "error");
    } finally {
      setBusyId("");
    }
  };

  const declineNow = async (row: PendingRegistration) => {
    setBusyId(row.id);
    try {
      await setBusinessStatus(row.id, "Inactive");
      push(`${row.name} declined. Its invitation was revoked and nobody in it can sign in.`);
      setReload((n) => n + 1);
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not decline this registration.", "error");
    } finally {
      setBusyId("");
      setDecline(null);
    }
  };

  const filtered = Boolean(values.q || values.status);
  return (
    <div>
      <PageHeader
        title="Businesses"
        description="Every business, identified by its ABN. A business has agents; each agent has students; each student has applications. Deactivate a business to block everyone in it."
        actions={<Link to="/admin/agencies/new"><Button icon="ri-add-line">Add business</Button></Link>}
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <StatusTabs label="Business status" value={status || "all"} onChange={(v) => update({ status: v === "Active" ? "" : v })}
          tabs={[{ id: "all", label: "All", count: counts?.all ?? null }, ...businessStatuses.flatMap((item) => {
            const tab = { id: item.value, label: item.label, count: countFor(item.value) };
            return item.value === "Active" ? [tab, { id: "Invited", label: "Invited", count: countFor("Invited") }] : [tab];
          }), { id: "Pending", label: "Pending review", count: countFor("Pending") }]} />
        <div className="flex-1">
          <SearchBox label="Search businesses" value={values.q} onSearch={(q) => update({ q })} placeholder="Search business, ABN, agent name, MARN, email or phone" />
        </div>
      </div>

      <Card>
        {status === "Pending" ? (
          <PendingRegistrationsTable rows={pending} loading={loading} busyId={busyId} onApprove={(row) => void approve(row)} onDecline={setDecline} />
        ) : error ? (
          <ListMessage icon="ri-error-warning-line" title="Businesses did not load" text={error}
            action={<Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>Try again</Button>} />
        ) : !loading && rows.length === 0 ? (
          <ListMessage icon="ri-building-line" title={filtered ? "No businesses match" : "No businesses yet"}
            text={filtered ? "Check the spelling, search fewer words, or clear the filters." : "Add a business with its ABN to get started."}
            action={filtered ? <Button variant="outline" size="sm" onClick={clear}>Clear search and filters</Button> : undefined} />
        ) : (
          <div className={loading && counts ? "opacity-60 transition-opacity" : ""}>
            <ResponsiveTable aria-busy={loading}>
              <thead>
                <tr>
                  <th className="w-[30%]">Business</th>
                  <th className="w-[13%]">Agents</th>
                  <th className="w-[9%]">Students</th>
                  <th className="w-[22%]">Applications</th>
                  <th className="w-[10%]">Status</th>
                  <th className="w-[16%]"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {loading && !counts ? <tr><td colSpan={6} className="py-10 text-center text-foreground-500">Loading businesses…</td></tr> : rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link to={`/admin/businesses/${row.id}`} className="font-semibold text-foreground-900 hover:text-primary-700">{row.name}</Link>
                      <p className="mt-0.5 text-xs text-foreground-500">{[row.abn ? `ABN ${row.abn}` : row.agencyCode, row.contact].filter(Boolean).join(", ")}</p>
                    </td>
                    <td className="text-xs">
                      <p><b className="text-foreground-900">{row.agents}</b> agent{row.agents === 1 ? "" : "s"}</p>
                      <p><b className="text-foreground-900">{row.admins}</b> business admin agent{row.admins === 1 ? "" : "s"}</p>
                      {row.admins === 0 ? <p className="mt-0.5 font-medium text-amber-700">No business admin agent yet</p> : null}
                    </td>
                    <td><Link to={`/admin/businesses/${row.id}?tab=students`} className="font-bold text-foreground-900 hover:text-primary-700">{row.students}</Link></td>
                    <td>
                      {row.applications === 0 ? <span className="text-xs text-foreground-500">No applications</span> : (
                        <div className="space-y-1.5">
                          <Link to={`/admin/businesses/${row.id}?tab=applications`} className="text-xs font-semibold text-foreground-900 hover:text-primary-700">
                            {row.applications} application{row.applications === 1 ? "" : "s"}
                          </Link>
                          <ApplicationStatusPills counts={row.statusCounts} hrefFor={(s) => `/admin/businesses/${row.id}?tab=applications&status=${s}`} limit={3} />
                        </div>
                      )}
                    </td>
                    <td>
                      {/* Activating happens at once; deactivating asks first, as it blocks everyone in the business. */}
                      <label className="sr-only" htmlFor={`business-status-${row.id}`}>Status for {row.name}</label>
                      {/* Invited is an active business nobody has signed in to yet; it is shown, never chosen. */}
                      {(() => {
                        const isInvited = row.status === "Active" && invited.has(row.id);
                        const shown = isInvited ? "Invited" : row.status;
                        return (
                          <>
                            <select id={`business-status-${row.id}`} value={shown} disabled={busyId === row.id}
                              onChange={(e) => { if (e.target.value === "Inactive") setConfirm(row); else if (e.target.value === "Active" && row.status !== "Active") void change(row, "Active"); }}
                              className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium outline-none focus:ring-2 focus:ring-primary-100 disabled:opacity-60 ${isInvited ? "border-amber-200 bg-amber-50 text-amber-900" : row.status === "Active" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-background-300 bg-background-100 text-foreground-600"}`}>
                              {isInvited ? <option value="Invited">Invited</option> : null}
                              {businessStatuses.map((item) => (
                                <option key={item.value} value={item.value} disabled={isInvited && item.value === "Active"}>{busyId === row.id && item.value === shown ? "Saving…" : item.label}</option>
                              ))}
                            </select>
                            {isInvited ? (
                              <button type="button" disabled={busyId === row.id} onClick={() => void resend(row)}
                                className="mt-1.5 flex cursor-pointer items-center gap-1 whitespace-nowrap text-xs font-semibold text-primary-700 hover:underline disabled:cursor-not-allowed disabled:opacity-60">
                                <i className="ri-mail-send-line" aria-hidden="true" /> {busyId === row.id ? "Sending…" : "Resend invite"}
                              </button>
                            ) : null}
                          </>
                        );
                      })()}
                    </td>
                    <td>
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <Link to={`/admin/businesses/${row.id}`} className="inline-flex items-center rounded-md border border-background-300 px-2.5 py-1 text-[13px] font-medium text-foreground-800 hover:bg-background-100">Open</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </div>
        )}
        {!error && status !== "Pending" ? <Pager page={page} pageSize={PAGE_SIZE} total={total} loading={loading} onPage={setPage} /> : null}
      </Card>

      <ConfirmDialog
        open={Boolean(decline)}
        title={`Decline ${decline?.name ?? "this registration"}?`}
        message="The business stays inactive and its sign-in invitation is revoked. The person who registered is not emailed; contact them yourself if you want to explain."
        confirmLabel={busyId ? "Declining…" : "Decline registration"}
        onConfirm={() => { if (decline && !busyId) void declineNow(decline); }}
        onCancel={() => { if (!busyId) setDecline(null); }}
      />

      <ConfirmDialog
        open={Boolean(confirm)}
        title={`Deactivate ${confirm?.name ?? "this business"}?`}
        message="Its administrators and agents will not be able to sign in. Students, applications and history are kept, and you can activate it again at any time."
        confirmLabel={busyId ? "Deactivating…" : "Deactivate business"}
        onConfirm={() => { if (confirm && !busyId) void change(confirm, "Inactive"); }}
        onCancel={() => { if (!busyId) setConfirm(null); }}
      />
    </div>
  );
}
