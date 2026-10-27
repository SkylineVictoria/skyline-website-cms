import { useState } from "react";
import { useAuth, passwordResetUrl } from "@/pages/admin/lib/authContext";
import { supabase } from "@/pages/admin/lib/supabase";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Badge, Button, Card, ConfirmDialog, Field, Modal, PageHeader, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { AdminUser, Role } from "@/pages/admin/lib/types";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import DraftResume from "@/pages/admin/components/DraftResume";
import { useSlotDraft } from "@/pages/admin/lib/useSlotDraft";

const PERMISSIONS: { area: string; admin: boolean; editor: boolean }[] = [
  { area: "Dashboard", admin: true, editor: true },
  { area: "Courses", admin: true, editor: true },
  { area: "Pages", admin: true, editor: true },
  { area: "Header & Navigation", admin: true, editor: true },
  { area: "Footer", admin: true, editor: true },
  { area: "Website Settings", admin: true, editor: false },
  { area: "Media Library", admin: true, editor: true },
  { area: "Documents & Policies", admin: true, editor: true },
  { area: "Forms", admin: true, editor: true },
  { area: "Links", admin: true, editor: true },
  { area: "Users & Permissions", admin: true, editor: false },
  { area: "Activity Log", admin: true, editor: false },
];

const emptyUser = (): AdminUser => ({
  id: "",
  name: "",
  email: "",
  role: "Editor",
  status: "Active",
  lastLogin: "—",
});

type EdgeResult = { ok: boolean; error?: string; data?: Record<string, unknown> | null };

/**
 * All auth provisioning goes through the `cms-admin-users` Edge Function,
 * which uses the official Supabase Auth Admin API. The CMS never writes the
 * auth schema directly and never handles raw passwords.
 */
async function callAdminUsers(body: Record<string, unknown>): Promise<EdgeResult> {
  const { data, error } = await supabase.functions.invoke("cms-admin-users", { body });
  if (error) {
    let message = error.message || "Request failed.";
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === "function") {
        const parsed = (await ctx.json()) as { error?: string } | null;
        if (parsed?.error) message = parsed.error;
      }
    } catch {
      /* keep the default message */
    }
    return { ok: false, error: message, data: null };
  }
  const payload = (data ?? null) as Record<string, unknown> | null;
  if (payload && typeof payload.error === "string") {
    return { ok: false, error: payload.error, data: null };
  }
  return { ok: true, data: payload };
}

export default function UsersPage() {
  const { user, users, saveUsers, refreshUsers, can } = useAuth();
  const { logActivity, reload } = useAdminData();
  const { push } = useToast();
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const slot = useSlotDraft<AdminUser>("user", (id) => users.find((u) => u.id === id) ?? null, emptyUser);
  const draft = slot.draft;
  const setDraft = slot.setDraft;
  const [pendingDelete, setPendingDelete] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const readOnly = !can("governance");

  const openNew = () => {
    setEditing(null);
    slot.openNew();
  };
  const openEdit = (u: AdminUser) => {
    setEditing(u);
    slot.openEdit(u.id, { ...u });
  };
  const resumeDraft = (id: string) => { setEditing(id === "new" ? null : users.find((u) => u.id === id) ?? null); slot.resume(id); };
  const close = () => {
    slot.close();
    setEditing(null);
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.email.trim()) {
      push("Name and email are required", "error");
      return;
    }
    if (editing) {
      const next = users.map((u) => (u.id === draft.id ? draft : u));
      saveUsers(next);
      logActivity("Updated", draft.name, "Users");
      push("User updated");
      close();
      return;
    }

    // New staff member — create the account via the official Admin API.
    setBusy(true);
    const res = await callAdminUsers({
      action: "invite",
      email: draft.email.trim(),
      name: draft.name.trim(),
      role: draft.role,
      redirectTo: passwordResetUrl(),
    });
    setBusy(false);
    if (!res.ok) {
      push(res.error ?? "Could not create the invitation", "error");
      return;
    }
    await refreshUsers();
    reload();
    logActivity("Invited", draft.name, "Users");
    const link = typeof res.data?.inviteLink === "string" ? (res.data?.inviteLink as string) : null;
    if (res.data?.emailSent) push("Invitation email sent");
    else if (link) setInviteLink(link);
    else push("Invitation created");
    close();
  };

  const sendReset = async (u: AdminUser) => {
    setBusy(true);
    const res = await callAdminUsers({ action: "reset", email: u.email, redirectTo: passwordResetUrl() });
    setBusy(false);
    if (!res.ok) {
      push(res.error ?? "Could not create a reset link", "error");
      return;
    }
    const link = typeof res.data?.link === "string" ? (res.data?.link as string) : null;
    if (link) {
      setInviteLink(link);
      logActivity("Password reset", u.name, "Users");
    } else {
      push("Reset email sent");
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    if (pendingDelete.email === user?.email) {
      push("You cannot remove your own account", "error");
      setPendingDelete(null);
      return;
    }
    setBusy(true);
    const res = await callAdminUsers({ action: "delete", email: pendingDelete.email });
    setBusy(false);
    if (!res.ok) {
      push(res.error ?? "Could not remove the user", "error");
      return;
    }
    await refreshUsers();
    reload();
    logActivity("Removed", pendingDelete.name, "Users");
    push("User removed", "info");
    setPendingDelete(null);
  };

  const copyLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      push("Link copied to clipboard");
    } catch {
      push("Copy failed — select and copy the link manually", "error");
    }
  };

  return (
    <div>
      <PageHeader
        title="Users & Permissions"
        description="Staff accounts and what each role is allowed to manage."
        breadcrumb="Governance"
        actions={
          !readOnly ? (
            <Button icon="ri-user-add-line" onClick={openNew}>
              Invite user
            </Button>
          ) : undefined
        }
      />
      <DraftResume items={slot.pending.map((d) => ({ id: d.id, label: d.id === "new" ? "New user invitation (not sent yet)" : `User: ${users.find((u) => u.id === d.id)?.name ?? d.id}` }))} onResume={resumeDraft} onDiscard={slot.dropPending} />

      {readOnly ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-primary-200 bg-primary-50 px-4 py-3 text-[13px] text-primary-900">
          <i className="ri-lock-line" aria-hidden="true" />
          Only Administrators can manage users. You can view this page in read-only mode.
        </div>
      ) : null}

      <Card className="mb-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-background-200">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-background-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary-100 text-xs font-semibold text-secondary-900">
                        {u.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                      </span>
                      <div>
                        <p className="font-medium text-foreground-900">
                          {u.name} {u.email === user?.email ? <span className="text-xs text-foreground-400">(you)</span> : null}
                        </p>
                        <p className="text-xs text-foreground-500">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.role === "Admin" ? "primary" : "secondary"}>{u.role}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.status === "Active" ? "primary" : "muted"}>{u.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground-500">{u.lastLogin}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        disabled={readOnly || busy}
                        onClick={() => sendReset(u)}
                        aria-label="Send password reset"
                        title="Send a password reset link"
                        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <i className="ri-lock-password-line" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => openEdit(u)}
                        aria-label="Edit"
                        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <i className="ri-pencil-line" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={readOnly || busy}
                        onClick={() => setPendingDelete(u)}
                        aria-label="Remove"
                        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <i className="ri-delete-bin-line" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-heading text-base font-semibold text-foreground-950">Permissions by role</h2>
        <p className="mb-4 text-sm text-foreground-500">The default access each role has in the CMS.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="border-b border-background-200 text-xs uppercase tracking-wide text-foreground-500">
                <th className="px-3 py-2.5 font-medium">Area</th>
                <th className="px-3 py-2.5 text-center font-medium">Admin</th>
                <th className="px-3 py-2.5 text-center font-medium">Editor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-background-200">
              {PERMISSIONS.map((p) => (
                <tr key={p.area}>
                  <td className="px-3 py-2.5 text-foreground-800">{p.area}</td>
                  <td className="px-3 py-2.5 text-center">
                    {p.admin ? <i className="ri-check-line text-primary-600" aria-hidden="true" /> : <i className="ri-subtract-line text-foreground-300" aria-hidden="true" />}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {p.editor ? <i className="ri-check-line text-primary-600" aria-hidden="true" /> : <i className="ri-subtract-line text-foreground-300" aria-hidden="true" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={!!draft}
        title={editing ? "Edit user" : "Invite user"}
        onClose={close}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button icon="ri-check-line" onClick={save} disabled={busy}>
              {editing ? "Save changes" : busy ? "Sending invite…" : "Send invite"}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="space-y-4">
            <DraftStatus draft={slot} />
            <Field label="Full name" required>
              <TextInput value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Email" required>
              <TextInput type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Role">
                <Select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>
                  <option value="Admin">Admin</option>
                  <option value="Editor">Editor</option>
                </Select>
              </Field>
              <Field label="Account status">
                <Select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as AdminUser["status"] })}>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </Select>
              </Field>
            </div>
            {!editing ? (
              <p className="rounded-md border border-background-200 bg-background-100 px-3 py-2.5 text-xs leading-relaxed text-foreground-600">
                <i className="ri-shield-keyhole-line mr-1 text-primary-600" aria-hidden="true" />
                New staff members are created through Supabase Auth and receive a secure link to set their
                own password. No password is set or stored here.
              </p>
            ) : null}
            {editing ? (
              <Toggle
                checked={draft.status === "Active"}
                onChange={(v) => setDraft({ ...draft, status: v ? "Active" : "Inactive" })}
                label="Account active"
              />
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={!!inviteLink}
        title="Secure one-time link"
        onClose={() => setInviteLink(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setInviteLink(null)}>
              Close
            </Button>
            <Button icon="ri-file-copy-line" onClick={copyLink}>
              Copy link
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-foreground-700">
          Share this single-use link with the staff member so they can set their own password. It
          expires shortly and cannot be reused.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-background-200 bg-background-100 px-3 py-2.5">
          <code className="flex-1 truncate text-xs text-foreground-700">{inviteLink}</code>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Remove user"
        message={`Remove "${pendingDelete?.name}"? Their Supabase sign-in will be deleted and they will lose access to the CMS.`}
        confirmLabel="Remove user"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}