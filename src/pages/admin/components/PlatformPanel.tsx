import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { useToast } from "@/pages/admin/components/toastContext";
import { AdminError, AdminLoading, Badge, Button, Card, EmptyState, Field, Modal, TextInput } from "@/pages/admin/components/ui";

interface Institution { id: string; slug: string; name: string; status: "active" | "inactive"; members: number; domains: number; pendingInvites: number }
interface AuditEntry { at: string; action: string; actor: string | null; details: Record<string, unknown> }

const LABEL: Record<string, string> = {
  create: "Institution created", suspend: "Suspended", reactivate: "Reactivated", details: "Details changed", membership: "Member changed",
  member_invite: "Member invited", member_invite_cancel: "Invitation cancelled", member_accept: "Invitation accepted", agency: "Agency link changed",
  domain: "Domain verified", domain_claim: "Domain requested", domain_verify: "Domain verified", domain_revoke: "Domain revoked",
  config_draft: "Configuration draft saved", config_publish: "Configuration published", config_restore: "Configuration restored",
};

function reason(error: { code?: string; message?: string }): string {
  if (error.code === "42501") return "You do not have permission to do that.";
  if (error.code === "22023" || error.code === "23505") return error.message ?? "That value is not valid.";
  return "The change could not be saved. Please try again.";
}

/** Platform-administrator lifecycle: onboarding, suspension and reactivation. Works for suspended institutions too. */
export default function PlatformPanel() {
  const { push } = useToast();
  const [rows, setRows] = useState<Institution[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [target, setTarget] = useState<Institution | null>(null);
  const [why, setWhy] = useState("");
  const [audit, setAudit] = useState<{ name: string; entries: AuditEntry[] } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("tenant_platform_overview");
    if (error || !data) { setFailed(true); return; }
    setFailed(false);
    setRows(data as Institution[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const call = async (command: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    const { error } = await supabase.rpc(command, args);
    setBusy(false);
    if (error) { push(reason(error), "error"); return false; }
    push(done);
    await load();
    return true;
  };

  if (failed) return <AdminError message="Platform administration is unavailable for this account." onRetry={() => void load()} />;
  if (!rows) return <AdminLoading label="Loading institutions…" />;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold">Onboard an institution</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Identifier" hint="Lowercase letters, numbers and hyphens."><TextInput value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
          <Field label="Institution name"><TextInput value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="First administrator email" hint="They are invited; no account is created or revealed."><TextInput type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} /></Field>
        </div>
        <Button className="mt-3" disabled={busy || !slug.trim() || !name.trim() || !adminEmail.trim()}
          onClick={async () => { if (await call("tenant_onboard", { p_slug: slug.trim(), p_name: name, p_admin_email: adminEmail }, "Institution created and administrator invited")) { setSlug(""); setName(""); setAdminEmail(""); } }}>Create institution</Button>
      </Card>
      <Card className="p-5">
        {rows.length === 0 ? <EmptyState title="No institutions" /> : (
          <ul className="divide-y divide-background-200">
            {rows.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{t.name} <span className="text-background-600">({t.slug})</span></p>
                  <p className="text-xs text-background-600">{t.members} members · {t.domains} verified domains · {t.pendingInvites} pending invitations</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={t.status === "active" ? "success" : "warn"}>{t.status === "active" ? "Active" : "Suspended"}</Badge>
                  <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
                    const { data, error } = await supabase.rpc("tenant_platform_audit", { p_tenant: t.id });
                    if (error) { push(reason(error), "error"); return; }
                    setAudit({ name: t.name, entries: (data ?? []) as AuditEntry[] });
                  }}>History</Button>
                  <Button size="sm" variant={t.status === "active" ? "danger" : "primary"} disabled={busy} onClick={() => { setWhy(""); setTarget(t); }}>{t.status === "active" ? "Suspend" : "Reactivate"}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal
        open={target !== null}
        title={target?.status === "active" ? "Suspend institution" : "Reactivate institution"}
        onClose={() => setTarget(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button>
            <Button variant={target?.status === "active" ? "danger" : "primary"} disabled={busy || !why.trim()} onClick={async () => {
              if (!target) return;
              const next = target.status === "active" ? "inactive" : "active";
              const id = target.id;
              setTarget(null);
              await call("tenant_set_status", { p_tenant: id, p_status: next, p_reason: why }, next === "inactive" ? "Institution suspended" : "Institution reactivated");
            }}>{target?.status === "active" ? "Suspend" : "Reactivate"}</Button>
          </>
        }
      >
        <p className="mb-3 text-sm">
          {target?.status === "active"
            ? `${target?.name} will stop serving its website and its members will lose access. No records are deleted, and reactivation restores everything.`
            : `${target?.name} will serve its website again and its members regain access.`}
        </p>
        <Field label="Reason (recorded in the audit history)" required><TextInput value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} /></Field>
      </Modal>
      <Modal open={audit !== null} title={audit ? `History: ${audit.name}` : "History"} onClose={() => setAudit(null)} footer={<Button variant="outline" onClick={() => setAudit(null)}>Close</Button>}>
        {audit && audit.entries.length === 0 ? <EmptyState title="No history yet" /> : (
          <ul className="divide-y divide-background-200 text-sm">
            {audit?.entries.map((e, i) => (
              <li key={`${e.at}-${i}`} className="py-2"><span className="font-medium">{LABEL[e.action] ?? e.action}</span><span className="text-background-600"> by {e.actor ?? "system"} · {new Date(e.at).toLocaleString()}</span></li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
