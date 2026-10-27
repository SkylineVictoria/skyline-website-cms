import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { currentTenantSite } from "@/lib/tenantSite";
import { useToast } from "@/pages/admin/components/toastContext";
import ConfigurationPanel from "@/pages/admin/components/ConfigurationPanel";
import PlatformPanel from "@/pages/admin/components/PlatformPanel";
import DeliveriesPanel from "@/pages/admin/components/DeliveriesPanel";
import { AdminError, AdminLoading, Badge, Button, Card, EmptyState, Field, Modal, PageHeader, SectionTabs, Select, TextInput, Toggle } from "@/pages/admin/components/ui";

type TenantRole = "tenant_admin" | "editor" | "staff" | "viewer";
const ROLE_LABEL: Record<TenantRole, string> = { tenant_admin: "Institution administrator", editor: "Editor", staff: "Staff", viewer: "Viewer" };

interface Overview {
  tenant: { id: string; slug: string; name: string; status: string };
  isPlatformAdmin: boolean;
  members: { userId: string; email: string; role: TenantRole; active: boolean }[];
  invites: { email: string; role: TenantRole; invitedAt: string }[];
  domains: { hostname: string; verified: boolean; verifiedAt: string | null }[];
  agencies: { agencyId: string; name: string; active: boolean }[];
  audit: { at: string; action: string; actor: string | null; details: Record<string, unknown> }[];
}

const ACTION_LABEL: Record<string, string> = {
  create: "Institution created", details: "Details changed", membership: "Member changed", agency: "Agency link changed",
  notification_activate: "Email sending approved", notification_deactivate: "Email sending paused", notification_retry: "Delivery sent again", notification_abandon: "Delivery closed",
  sender_approve: "Sender approved", sender_revoke: "Sender approval withdrawn", member_invite: "Member invited", member_invite_cancel: "Invitation cancelled", member_accept: "Invitation accepted", suspend: "Suspended", reactivate: "Reactivated",
  config_draft: "Configuration draft saved", config_publish: "Configuration published", config_restore: "Configuration restored",
  domain: "Domain verified", domain_claim: "Domain requested", domain_verify: "Domain verified", domain_revoke: "Domain revoked",
};

/** Errors come from fixed server messages; never show raw database text. */
function failure(error: { code?: string; message?: string }): string {
  if (error.code === "42501") return "You do not have permission to do that.";
  if (error.code === "23514") return error.message?.includes("domain") ? "The only verified domain cannot be removed." : "The last institution administrator cannot be removed or demoted.";
  if (error.code === "23505") return "That hostname is not available.";
  if (error.code === "22023") return error.message ?? "That value is not valid.";
  return "The change could not be saved. Please try again.";
}

export default function InstitutionPage() {
  const { push } = useToast();
  const tenantId = currentTenantSite()?.tenantId ?? null;
  const [tab, setTab] = useState("details");
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantRole>("editor");
  const [host, setHost] = useState("");
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [revoke, setRevoke] = useState<{ hostname: string } | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const load = useCallback(async () => {
    if (!tenantId) { setLoadError(true); return; }
    const { data: overview, error } = await supabase.rpc("tenant_admin_overview", { p_tenant: tenantId });
    if (error || !overview) { setLoadError(true); return; }
    setLoadError(false);
    setData(overview as Overview);
    setName((overview as Overview).tenant.name);
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const run = async (command: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    const { error } = await supabase.rpc(command, { p_tenant: tenantId, ...args });
    setBusy(false);
    if (error) { push(failure(error), "error"); return false; }
    push(done);
    await load();
    return true;
  };

  if (loadError) return <AdminError message="Institution administration is unavailable for this account." onRetry={() => void load()} />;
  if (!data) return <AdminLoading label="Loading institution…" />;

  const tabs = [
    { id: "details", label: "Details", icon: "ri-building-line" },
    { id: "members", label: "Members", icon: "ri-team-line" },
    { id: "domains", label: "Domains", icon: "ri-global-line" },
    { id: "agencies", label: "Agencies", icon: "ri-links-line" },
    { id: "config", label: "Configuration", icon: "ri-settings-4-line" },
    { id: "deliveries", label: "Email deliveries", icon: "ri-mail-send-line" },
    { id: "activity", label: "Activity", icon: "ri-history-line" },
    ...(data.isPlatformAdmin ? [{ id: "platform", label: "Platform", icon: "ri-building-4-line" }] : []),
  ];

  return (
    <div>
      <PageHeader title="Institution" description="Manage this institution's details, members and domains." breadcrumb="Administration" />
      <SectionTabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "details" && (
        <Card className="max-w-xl p-5">
          <div className="space-y-4">
            <Field label="Institution name" required>
              <TextInput value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Identifier" hint="Fixed when the institution was created.">
              <TextInput value={data.tenant.slug} readOnly />
            </Field>
            <Button disabled={busy || !name.trim() || name.trim() === data.tenant.name} onClick={() => void run("tenant_update_details", { p_name: name }, "Details saved")}>Save details</Button>
          </div>
        </Card>
      )}

      {tab === "members" && (
        <div className="space-y-5">
          <Card className="p-5">
            <div className="grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end">
              <Field label="Email address" hint="They receive this role the next time they sign in with this address. The response is the same whether or not an account exists.">
                <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Role">
                <Select value={role} onChange={(e) => setRole(e.target.value as TenantRole)}>
                  {(Object.keys(ROLE_LABEL) as TenantRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </Select>
              </Field>
              <Button disabled={busy || !email.trim()} onClick={async () => { if (await run("tenant_grant_membership", { p_email: email, p_role: role, p_active: true }, "Invitation recorded")) setEmail(""); }}>Invite member</Button>
            </div>
          </Card>
          <Card className="p-5">
            {data.members.length === 0 ? <EmptyState title="No members yet" /> : (
              <ul className="divide-y divide-background-200">
                {data.members.map((m) => (
                  <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm font-medium">{m.email}</p>
                      <Badge tone={m.active ? "success" : "muted"}>{m.active ? "Active" : "Inactive"}</Badge>
                    </div>
                    <div className="flex items-center gap-3">
                      <Select aria-label={`Role for ${m.email}`} value={m.role} disabled={busy} onChange={(e) => void run("tenant_set_membership", { p_user: m.userId, p_role: e.target.value, p_active: m.active }, "Role updated")}>
                        {(Object.keys(ROLE_LABEL) as TenantRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </Select>
                      <Toggle checked={m.active} disabled={busy} label={`Active: ${m.email}`} onChange={(v) => void run("tenant_set_membership", { p_user: m.userId, p_role: m.role, p_active: v }, v ? "Member reactivated" : "Member deactivated")} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {tab === "members" && data.invites.length > 0 && (
        <Card className="mt-5 p-5">
          <h3 className="mb-3 text-sm font-semibold">Pending invitations</h3>
          <ul className="divide-y divide-background-200">
            {data.invites.map((i) => (
              <li key={i.email} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <span>{i.email} · {ROLE_LABEL[i.role]}</span>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("tenant_grant_membership", { p_email: i.email, p_role: i.role, p_active: false }, "Invitation cancelled")}>Cancel invitation</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === "domains" && (
        <div className="space-y-5">
          <Card className="p-5">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="Request a domain" hint="A platform administrator verifies ownership before it serves this institution.">
                <TextInput value={host} placeholder="www.example.edu.au" onChange={(e) => setHost(e.target.value)} />
              </Field>
              <Button disabled={busy || !host.trim()} onClick={async () => { if (await run("tenant_claim_domain", { p_hostname: host }, "Domain requested")) setHost(""); }}>Request domain</Button>
            </div>
          </Card>
          <Card className="p-5">
            {data.domains.length === 0 ? <EmptyState title="No domains" /> : (
              <ul className="divide-y divide-background-200">
                {data.domains.map((d) => (
                  <li key={d.hostname} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium">{d.hostname}</span>
                      <Badge tone={d.verified ? "success" : "warn"}>{d.verified ? "Verified" : "Awaiting verification"}</Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {data.isPlatformAdmin && !d.verified && (
                        <>
                          <TextInput className="w-56" aria-label={`Verification evidence for ${d.hostname}`} placeholder="Verification evidence" value={evidence[d.hostname] ?? ""} onChange={(e) => setEvidence({ ...evidence, [d.hostname]: e.target.value })} />
                          <Button size="sm" disabled={busy || !(evidence[d.hostname] ?? "").trim()} onClick={() => void run("tenant_verify_domain", { p_hostname: d.hostname, p_evidence: evidence[d.hostname] }, "Domain verified")}>Verify</Button>
                        </>
                      )}
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => { setRevokeReason(""); setRevoke({ hostname: d.hostname }); }}>Revoke</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Modal
            open={revoke !== null}
            title="Revoke domain"
            onClose={() => setRevoke(null)}
            footer={
              <>
                <Button variant="outline" onClick={() => setRevoke(null)}>Cancel</Button>
                <Button variant="danger" disabled={busy || !revokeReason.trim()} onClick={() => { const target = revoke?.hostname; setRevoke(null); if (target) void run("tenant_revoke_domain", { p_hostname: target, p_reason: revokeReason }, "Domain revoked"); }}>Revoke</Button>
              </>
            }
          >
            <p className="mb-3 text-sm">{revoke?.hostname} will stop serving this institution immediately.</p>
            <Field label="Reason for revoking" required>
              <TextInput value={revokeReason} maxLength={300} onChange={(e) => setRevokeReason(e.target.value)} />
            </Field>
          </Modal>
        </div>
      )}

      {tab === "agencies" && (
        <Card className="p-5">
          <p className="mb-3 text-sm text-background-600">Agencies are shared across institutions. A platform administrator links or unlinks them; unlinking never changes the agency itself.</p>
          {data.agencies.length === 0 ? <EmptyState title="No linked agencies" /> : (
            <ul className="divide-y divide-background-200">
              {data.agencies.map((a) => (
                <li key={a.agencyId} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-sm font-medium">{a.name}</span>
                  {data.isPlatformAdmin
                    ? <Toggle checked={a.active} disabled={busy} label="Linked" onChange={(v) => void run("tenant_set_agency", { p_agency: a.agencyId, p_active: v }, v ? "Agency linked" : "Agency unlinked")} />
                    : <Badge tone={a.active ? "success" : "muted"}>{a.active ? "Linked" : "Unlinked"}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === "platform" && data.isPlatformAdmin && <PlatformPanel />}

      {tab === "deliveries" && tenantId && <DeliveriesPanel tenantId={tenantId} />}

      {tab === "config" && tenantId && <ConfigurationPanel tenantId={tenantId} />}

      {tab === "activity" && (
        <Card className="p-5">
          {data.audit.length === 0 ? <EmptyState title="No administration activity yet" /> : (
            <ul className="divide-y divide-background-200">
              {data.audit.map((entry, i) => (
                <li key={`${entry.at}-${i}`} className="py-3 text-sm">
                  <span className="font-medium">{ACTION_LABEL[entry.action] ?? entry.action}</span>
                  <span className="text-background-600"> by {entry.actor ?? "system"} · {new Date(entry.at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
