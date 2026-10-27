import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { portalPasswordResetUrl } from "@/pages/agency/lib/portalAuthContext";
import { invokePortalUsers, listAgencies, listInvitations, listPortalUsers, ROLE_LABELS, type InvitationRow, type PortalUserRow } from "@/pages/agency/lib/portalData";
import type { PortalAgency } from "@/pages/agency/lib/portalAuthContext";
import { PageHeading, PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { usePortalAuth } from "../lib/portalAuthContext";
import InstitutionAgents from "../components/InstitutionAgents";
import { canManagePortalUsers } from "../lib/applicationAccess";
import { useToast } from "../components/Dialog";
import { ConfirmUserDialog, UserDialog } from "../components/UserDialog";
import { deactivationBlock, roleChangeBlock, type UserFormValues } from "../lib/userValidation";

const ROLES = [
  { value: "agent", label: "Agent" },
  { value: "agency_admin", label: "Agency Admin" },
];

export default function AdminUsersPage() {
  const { selectedScope, role } = usePortalAuth();
  // UI reflection only: portal-admin-users and RLS enforce who may manage whom.
  if (!canManagePortalUsers(role)) {
    return <PortalError message="User management is available to organization and agency administrators only." />;
  }
  return selectedScope?.tenantId ? <InstitutionAgents /> : <LegacyUsersPage />;
}

type DialogState = { kind: "add" } | { kind: "edit"; user: PortalUserRow } | { kind: "status"; user: PortalUserRow } | null;

function LegacyUsersPage() {
  const { role, profile, agency: ownAgency, authUser } = usePortalAuth();
  const isSlit = role === "slit_admin";
  const authUserId = authUser?.id;
  const { toast, show } = useToast();
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [users, setUsers] = useState<PortalUserRow[]>([]);
  const [agencies, setAgencies] = useState<PortalAgency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [u, a, inv] = await Promise.all([listPortalUsers(), listAgencies(), listInvitations()]);
      setUsers(u);
      setInvitations(inv);
      setAgencies(a);
    } catch {
      setError("We could not load portal users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeAdmins = (agencyId: string | null) =>
    users.filter((u) => u.role === "agency_admin" && u.status === "Active" && u.agencyId === agencyId).length;

  const existingEmails = useMemo(() => [...users.map((u) => u.email), ...invitations.map((i) => i.email)], [users, invitations]);

  const showDelivery = (data: Record<string, unknown>, email: string) => {
    setInviteLink("");
    if (data.warning) {
      setNotice(String(data.warning));
    } else if (data.inviteLink) {
      setInviteLink(String(data.inviteLink));
      setNotice("Invitation saved. Share the secure setup link below with the user.");
    } else {
      setNotice("");
      show(data.existingIdentity ? `Invitation saved. ${email} already has an account and accepts it at next sign-in.` : `Invitation sent to ${email}.`);
    }
  };

  const handleInvitation = async (invitation: InvitationRow, action: "resend" | "revoke") => {
    setBusyId(invitation.id);
    setError("");
    setNotice("");
    setInviteLink("");
    try {
      const data = await invokePortalUsers({ action, invitationId: invitation.id, redirectTo: portalPasswordResetUrl() });
      if (action === "resend") showDelivery(data, invitation.email);
      else show(`Invitation for ${invitation.email} revoked.`);
      await load();
    } catch {
      setError("We could not update that invitation. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  // ---- dialog data (memoised so typing never resets the form) ----
  const editTarget = dialog?.kind === "edit" ? dialog.user : null;
  const addInitial = useMemo<UserFormValues>(() => ({ name: "", email: "", role: "agent", agencyId: agencies[0]?.id ?? "" }), [agencies]);
  const editInitial = useMemo<UserFormValues>(
    () => ({ name: editTarget?.fullName ?? "", email: editTarget?.email ?? "", role: editTarget?.role ?? "agent", agencyId: editTarget?.agencyId ?? "" }),
    [editTarget],
  );

  const submitAdd = async (values: UserFormValues) => {
    // An agency admin never sends an agency: the server uses the agency of their own membership.
    const data = await invokePortalUsers({
      action: "invite",
      email: values.email,
      name: values.name,
      role: values.role,
      ...(isSlit ? { agencyId: values.agencyId } : {}),
      redirectTo: portalPasswordResetUrl(),
    });
    showDelivery(data, values.email);
    setDialog(null);
    await load();
  };

  const submitEdit = async (values: UserFormValues) => {
    if (!editTarget) return;
    // Only an organization administrator may rename another user (existing RLS on portal_profiles); the role goes through the function.
    if (isSlit && values.name !== editTarget.fullName) {
      const { error: nameError } = await supabase.from("portal_profiles").update({ full_name: values.name }).eq("id", editTarget.profileId);
      if (nameError) throw new Error("name update failed");
    }
    if (values.role !== editTarget.role || (isSlit && values.agencyId !== (editTarget.agencyId ?? ""))) {
      await invokePortalUsers({
        action: "update",
        profileId: editTarget.profileId,
        role: values.role,
        ...(isSlit ? { agencyId: values.agencyId } : {}),
        status: editTarget.status,
      });
    }
    show(`${values.name || editTarget.email} updated.`);
    setDialog(null);
    await load();
  };

  const statusTarget = dialog?.kind === "status" ? dialog.user : null;
  const nextStatus = statusTarget?.status === "Active" ? "Inactive" : "Active";
  const statusBlock = statusTarget
    ? deactivationBlock({
        isSelf: statusTarget.profileId === profile?.id,
        targetRole: statusTarget.role,
        targetActive: statusTarget.status === "Active",
        activeAdmins: activeAdmins(statusTarget.agencyId),
      })
    : null;

  const confirmStatus = async () => {
    if (!statusTarget) return;
    await invokePortalUsers({ action: "update", profileId: statusTarget.profileId, status: nextStatus });
    show(`${statusTarget.fullName || statusTarget.email} ${nextStatus === "Inactive" ? "deactivated" : "reactivated"}.`);
    setDialog(null);
    await load();
  };

  const editRoleBlock = (newRole: string) =>
    editTarget
      ? roleChangeBlock({ currentRole: editTarget.role, newRole, targetActive: editTarget.status === "Active", activeAdmins: activeAdmins(editTarget.agencyId) })
      : null;

  return (
    <div>
      <PageHeading
        eyebrow="Users"
        title={isSlit ? "Portal users" : "Your agency team"}
        description={isSlit ? "Invite agency administrators and agents into any agency, resend or revoke pending invitations, and change roles or access. No passwords are stored in the portal." : `Invite and manage agents for ${ownAgency?.name ?? "your agency"}. You can only manage users in your own agency.`}
        action={
          <button
            type="button"
            onClick={() => { setNotice(""); setInviteLink(""); setDialog({ kind: "add" }); }}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
          >
            <i className="ri-user-add-line" aria-hidden="true" />
            Add user
          </button>
        }
      />

      {notice ? (
        <div className="mt-4 rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2.5 text-sm text-secondary-900" role="status">
          <p className="flex items-center gap-2"><i className="ri-checkbox-circle-line" aria-hidden="true" />{notice}</p>
          {inviteLink ? <p className="mt-2 break-all rounded border border-secondary-200 bg-background-50 px-2 py-1.5 font-mono text-xs text-foreground-700">{inviteLink}</p> : null}
        </div>
      ) : null}

      {invitations.length > 0 ? (
        <div className="mt-6 overflow-hidden rounded-card border border-background-200 bg-background-50">
          <h2 className="border-b border-background-200 px-4 py-3 font-heading text-base font-semibold text-foreground-950">Pending invitations</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <tbody>
                {invitations.map((inv) => {
                  const mine = isSlit || inv.invitedBy === authUserId;
                  return (
                    <tr key={inv.id} className="border-b border-background-100 last:border-none">
                      <td className="px-4 py-3 text-foreground-950">{inv.email}</td>
                      {isSlit ? <td className="px-4 py-3 text-foreground-600">{inv.agencyName}</td> : null}
                      <td className="px-4 py-3 text-foreground-600">{ROLE_LABELS[inv.role]}</td>
                      <td className="px-4 py-3 text-xs font-semibold text-foreground-600">{inv.status === "expired" ? "Expired" : `Expires ${new Date(inv.expiresAt).toLocaleDateString()}`}</td>
                      <td className="px-4 py-3">
                        {mine ? (
                          <div className="flex items-center justify-end gap-2">
                            {(["resend", "revoke"] as const).map((action) => (
                              <button
                                key={action}
                                type="button"
                                disabled={busyId === inv.id}
                                onClick={() => void handleInvitation(inv, action)}
                                className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-xs font-semibold capitalize text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:opacity-60"
                              >
                                {action}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-right text-xs text-foreground-500">Invited by {inv.invitedByName || "another administrator"}</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="mt-6">
        {loading ? (
          <PortalLoading label="Loading portal users…" />
        ) : error ? (
          <PortalError message={error} onRetry={() => void load()} />
        ) : users.length === 0 ? (
          <PortalEmpty icon="ri-group-line" title="No portal users yet" message="Choose Add user to invite your first user." />
        ) : (
          <div className="overflow-hidden rounded-card border border-background-200 bg-background-50">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-background-200 bg-background-100 text-left text-xs font-semibold uppercase tracking-wide text-foreground-500">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Agency</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.profileId} className="border-b border-background-100 last:border-none">
                      <td className="px-4 py-3 font-medium text-foreground-950">{user.fullName || "—"}</td>
                      <td className="px-4 py-3 text-foreground-600">{user.email}</td>
                      <td className="px-4 py-3 text-foreground-600">{user.agencyName || "—"}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-secondary-100 px-2.5 py-1 text-xs font-semibold text-secondary-900">
                          {user.role ? ROLE_LABELS[user.role] : "No role"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${user.status === "Active" ? "bg-accent-100 text-accent-900" : "bg-background-200 text-foreground-600"}`}>
                          {user.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {!isSlit && user.role === "agency_admin" && user.profileId !== profile?.id ? (
                          <p className="text-right text-xs text-foreground-500">Managed by SLIT</p>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              disabled={!user.role}
                              onClick={() => setDialog({ kind: "edit", user })}
                              className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <i className="ri-edit-line" aria-hidden="true" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setDialog({ kind: "status", user })}
                              className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-xs font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
                            >
                              {user.status === "Active" ? "Deactivate" : "Reactivate"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <UserDialog
        open={dialog?.kind === "add"}
        mode="add"
        initial={addInitial}
        roles={ROLES}
        agencies={isSlit ? agencies.map((a) => ({ id: a.id, name: a.name })) : undefined}
        existingEmails={existingEmails}
        nameEditable
        onClose={() => setDialog(null)}
        onSubmit={submitAdd}
      />
      <UserDialog
        open={dialog?.kind === "edit"}
        mode="edit"
        initial={editInitial}
        roles={ROLES}
        agencies={isSlit ? agencies.map((a) => ({ id: a.id, name: a.name })) : undefined}
        existingEmails={[]}
        nameEditable={isSlit}
        roleBlock={editRoleBlock}
        onClose={() => setDialog(null)}
        onSubmit={submitEdit}
      />
      <ConfirmUserDialog
        open={dialog?.kind === "status"}
        name={statusTarget?.fullName || statusTarget?.email || ""}
        action={nextStatus === "Inactive" ? "deactivate" : "reactivate"}
        blockedReason={statusBlock}
        onClose={() => setDialog(null)}
        onConfirm={confirmStatus}
      />
      {toast}
    </div>
  );
}
