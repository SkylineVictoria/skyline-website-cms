import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, PageHeader, TextInput } from "@/pages/admin/components/ui";
import AgencyForm from "@/pages/admin/components/AgencyForm";
import { useToast } from "@/pages/admin/components/toastContext";
import { agencyToForm, validateAgencyForm, type AgencyFormErrors, type AgencyFormState } from "@/pages/admin/lib/agencyForm";
import ApplicationsTable from "@/pages/agency/components/ApplicationsTable";
import {
  formatDate, getAgency, invokePortalUsers, listAgencyInvitations, listAgencyMembers, logAgencyChange, ROLE_LABELS, setAgencyStatus, updateAgency,
  type AgencyMemberRow, type AgencySummary, type InvitationRow,
} from "@/pages/agency/lib/portalData";
import { portalPasswordResetUrl } from "@/pages/agency/lib/portalAuthContext";
import { deactivationBlock, normaliseEmail, validateEmail, validateName } from "@/pages/agency/lib/userValidation";

type Tab = "details" | "agents" | "applications";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "details", label: "Details" },
  { id: "agents", label: "Agents" },
  { id: "applications", label: "Applications" },
];

/** Agencies > {name}. The agency comes from the URL, so a refresh or back / forward keeps it; every list below is queried by that agency id. */
export default function AgencyDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "agents" ? "agents" : params.get("tab") === "applications" ? "applications" : "details";
  const { push } = useToast();

  const [agency, setAgency] = useState<AgencySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const found = await getAgency(id);
      setAgency(found);
      if (!found) setError("This agency could not be found.");
    } catch (e) {
      setAgency(null);
      setError(e instanceof Error ? e.message : "We could not load this agency.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setAgency(null); // never show the previous agency while the next one loads
    void load();
  }, [load]);

  const changeStatus = async (next: "Active" | "Inactive") => {
    if (!agency) return;
    setBusy(true);
    try {
      await setAgencyStatus(agency.id, next);
      await logAgencyChange(agency.id, next === "Inactive" ? "agency_deactivated" : "agency_reactivated", { name: agency.name });
      push(next === "Inactive" ? `${agency.name} deactivated. Its agents, applications and history are kept.` : `${agency.name} reactivated.`);
      await load();
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not change the agency’s status.", "error");
    } finally {
      setBusy(false);
      setConfirmDeactivate(false);
    }
  };

  if (loading && !agency) return <p className="p-6 text-sm text-foreground-600">Loading agency&hellip;</p>;
  if (!agency) {
    return (
      <div>
        <PageHeader breadcrumb="Agencies" title="Agency not found" />
        <p role="alert" className="text-sm text-red-700">{error || "This agency could not be found."}</p>
        <Link to="/admin/agencies" className="mt-3 inline-block text-sm font-semibold text-primary-700 underline">Back to Agencies</Link>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        breadcrumb={`Agencies > ${agency.name}`}
        title={agency.name}
        description={`${agency.code} · ${agency.agentCount} agent${agency.agentCount === 1 ? "" : "s"} · ${agency.applicationCount} application${agency.applicationCount === 1 ? "" : "s"} · created ${formatDate(agency.createdAt)}`}
        actions={
          <>
            <Badge tone={agency.status === "Active" ? "success" : "muted"}>{agency.status}</Badge>
            {agency.status === "Active" ? (
              <Button variant="outline" disabled={busy} onClick={() => setConfirmDeactivate(true)}>Deactivate agency</Button>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => void changeStatus("Active")}>Reactivate agency</Button>
            )}
          </>
        }
      />

      <nav className="mb-5 flex gap-1 border-b border-background-200" aria-label="Agency sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setParams(item.id === "details" ? {} : { tab: item.id })}
            className={`cursor-pointer px-4 py-2.5 text-sm font-medium ${tab === item.id ? "border-b-2 border-primary-500 text-primary-700" : "text-foreground-600 hover:text-foreground-900"}`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === "details" ? <DetailsTab key={agency.id} agency={agency} onSaved={load} /> : null}
      {tab === "agents" ? <AgentsTab key={agency.id} agencyId={agency.id} agencyName={agency.name} onChanged={load} /> : null}
      {tab === "applications" ? <ApplicationsTab key={agency.id} agencyId={agency.id} /> : null}

      <ConfirmDialog
        open={confirmDeactivate}
        title="Deactivate this agency?"
        message={`${agency.name} and its agents will no longer be able to sign in or submit applications. Nothing is deleted: its agents, applications and history stay and you can reactivate it at any time.`}
        confirmLabel="Deactivate"
        onConfirm={() => void changeStatus("Inactive")}
        onCancel={() => setConfirmDeactivate(false)}
      />
    </div>
  );
}

function DetailsTab({ agency, onSaved }: { agency: AgencySummary; onSaved: () => Promise<void> }) {
  const { push } = useToast();
  const [form, setForm] = useState<AgencyFormState>(() => agencyToForm(agency));
  const [errors, setErrors] = useState<AgencyFormErrors>({});
  const [saving, setSaving] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const checked = validateAgencyForm(form);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length > 0) return;
    setSaving(true);
    try {
      await updateAgency(agency.id, { ...form, registrationNumber: form.registrationNumber, businessEmail: form.businessEmail, phone: checked.phone, primaryContact: form.primaryContact });
      await logAgencyChange(agency.id, "agency_updated", { name: form.name.trim(), code: form.code.trim() });
      push("Agency details saved.");
      await onSaved();
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not save these details.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} noValidate>
      <Card className="p-5">
        <AgencyForm value={form} errors={errors} disabled={saving || agency.isPermanent} onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))} />
        {agency.isPermanent ? <p className="mt-3 text-xs text-foreground-500">This is a permanent reference agency and its details are fixed.</p> : null}
      </Card>
      <div className="mt-5">
        <Button type="submit" icon="ri-save-line" disabled={saving || agency.isPermanent}>{saving ? "Saving…" : "Save details"}</Button>
      </div>
    </form>
  );
}

function AgentsTab({ agencyId, agencyName, onChanged }: { agencyId: string; agencyName: string; onChanged: () => Promise<void> }) {
  const { push } = useToast();
  const [members, setMembers] = useState<AgencyMemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [person, setPerson] = useState({ name: "", email: "" });
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [confirm, setConfirm] = useState<AgencyMemberRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Both lists are queried by this agency's id; nothing is filtered after loading.
      const [m, inv] = await Promise.all([listAgencyMembers(agencyId), listAgencyInvitations(agencyId)]);
      setMembers(m);
      setInvitations(inv);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load this agency’s agents.");
    } finally {
      setLoading(false);
    }
  }, [agencyId]);

  useEffect(() => {
    setMembers([]);
    setInvitations([]);
    void load();
  }, [load]);

  const activeAdmins = useMemo(() => members.filter((m) => m.role === "agency_admin" && m.status === "Active").length, [members]);
  const existing = useMemo(() => [...members.map((m) => m.email), ...invitations.map((i) => i.email)], [members, invitations]);

  const report = (data: Record<string, unknown>, email: string) => {
    if (data.warning) setNotice(String(data.warning));
    else if (data.inviteLink) setNotice(`Invitation saved. Share this secure setup link with ${email}: ${String(data.inviteLink)}`);
    else {
      setNotice("");
      push(data.existingIdentity ? `Invitation saved. ${email} already has an account and accepts it at next sign-in.` : `Invitation sent to ${email}.`);
    }
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    const nameError = validateName(person.name);
    const emailError = validateEmail(person.email, existing);
    setErrors({ name: nameError ?? undefined, email: emailError ?? undefined });
    if (nameError || emailError) return;
    setBusyId("invite");
    try {
      const data = await invokePortalUsers({ action: "invite", email: normaliseEmail(person.email), name: person.name.trim(), role: "agent", agencyId, redirectTo: portalPasswordResetUrl() });
      report(data, normaliseEmail(person.email));
      setPerson({ name: "", email: "" });
      await Promise.all([load(), onChanged()]);
    } catch (e) {
      setErrors({ email: e instanceof Error ? e.message : "We could not send that invitation." });
    } finally {
      setBusyId("");
    }
  };

  const setActive = async (member: AgencyMemberRow, status: "Active" | "Inactive") => {
    setBusyId(member.profileId);
    try {
      await invokePortalUsers({ action: "update", profileId: member.profileId, status });
      push(`${member.fullName || member.email} ${status === "Inactive" ? "deactivated" : "reactivated"}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not change that person’s access.");
    } finally {
      setBusyId("");
      setConfirm(null);
    }
  };

  const resend = async (invitation: InvitationRow) => {
    setBusyId(invitation.id);
    try {
      report(await invokePortalUsers({ action: "resend", invitationId: invitation.id, redirectTo: portalPasswordResetUrl() }), invitation.email);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not resend that invitation.");
    } finally {
      setBusyId("");
    }
  };

  const block = confirm ? deactivationBlock({ isSelf: false, targetRole: confirm.role, targetActive: confirm.status === "Active", activeAdmins }) : null;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="font-heading text-base font-semibold">Add agent</h2>
        <form onSubmit={invite} noValidate className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-[1fr_1fr_auto] md:items-start">
          <div>
            <Field label="Name"><TextInput value={person.name} aria-invalid={Boolean(errors.name)} onChange={(e) => setPerson((p) => ({ ...p, name: e.target.value }))} /></Field>
            {errors.name ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{errors.name}</p> : null}
          </div>
          <div>
            <Field label="Email" hint={errors.email ? undefined : `This email receives the invite to join ${agencyName}.`}>
              <TextInput type="email" value={person.email} aria-invalid={Boolean(errors.email)} onChange={(e) => setPerson((p) => ({ ...p, email: e.target.value }))} />
            </Field>
            {errors.email ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{errors.email}</p> : null}
          </div>
          <div className="md:pt-6"><Button type="submit" icon="ri-mail-send-line" disabled={busyId === "invite"}>{busyId === "invite" ? "Sending…" : "Send invite"}</Button></div>
        </form>
        {notice ? <p role="status" className="mt-3 break-words text-sm text-foreground-700">{notice}</p> : null}
      </Card>

      {error ? <p role="alert" className="text-sm font-medium text-red-700">{error}</p> : null}

      <Card>
        {!loading && members.length === 0 ? (
          <EmptyState icon="ri-team-line" title="No agents yet" description="Invite this agency's first agent above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm" aria-busy={loading}>
              <thead>
                <tr className="border-b border-background-200 text-xs uppercase text-foreground-500">
                  <th className="p-4">Name</th><th className="p-4">Email</th><th className="p-4">Role</th><th className="p-4">Status</th><th className="p-4 text-right">Access</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-background-200">
                {members.map((member) => (
                  <tr key={member.profileId}>
                    <td className="p-4 font-medium">{member.fullName || "—"}</td>
                    <td className="p-4 text-xs">{member.email}</td>
                    <td className="p-4 text-xs">{ROLE_LABELS[member.role] ?? member.role}</td>
                    <td className="p-4"><Badge tone={member.status === "Active" ? "success" : "muted"}>{member.status}</Badge></td>
                    <td className="p-4 text-right">
                      {member.status === "Active" ? (
                        <Button size="sm" variant="outline" disabled={busyId === member.profileId} onClick={() => setConfirm(member)}>Deactivate</Button>
                      ) : (
                        <Button size="sm" variant="outline" disabled={busyId === member.profileId} onClick={() => void setActive(member, "Active")}>Reactivate</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {invitations.length > 0 ? (
        <Card>
          <h2 className="p-4 pb-0 font-heading text-base font-semibold">Pending invitations</h2>
          <ul className="divide-y divide-background-200">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                <span>
                  <span className="font-medium">{invitation.fullName || invitation.email}</span>
                  <span className="ml-2 text-xs text-foreground-500">{invitation.email} · {ROLE_LABELS[invitation.role] ?? invitation.role} · {invitation.status === "expired" ? "expired" : `expires ${formatDate(invitation.expiresAt)}`}</span>
                </span>
                <Button size="sm" variant="outline" disabled={busyId === invitation.id} onClick={() => void resend(invitation)}>Resend invite</Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={block ? "Cannot deactivate" : "Deactivate this person?"}
        message={block ?? `${confirm?.fullName || confirm?.email} will no longer be able to sign in to ${agencyName}. Their applications and history are kept, and you can reactivate them later.`}
        confirmLabel={block ? "OK" : "Deactivate"}
        onConfirm={() => { if (confirm && !block) void setActive(confirm, "Inactive"); else setConfirm(null); }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function ApplicationsTab({ agencyId }: { agencyId: string }) {
  const [members, setMembers] = useState<AgencyMemberRow[]>([]);
  useEffect(() => {
    setMembers([]);
    void listAgencyMembers(agencyId).then(setMembers).catch(() => setMembers([]));
  }, [agencyId]);
  return (
    <ApplicationsTable
      remote
      rows={[]}
      fixedAgencyId={agencyId}
      agents={members.filter((m) => m.role === "agent").map((m) => ({ id: m.profileId, name: m.fullName || m.email }))}
      emptyTitle="No applications for this agency yet"
      emptyMessage="Applications created by this agency's agents will appear here."
    />
  );
}
