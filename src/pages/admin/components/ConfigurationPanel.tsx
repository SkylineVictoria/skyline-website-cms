import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { useToast } from "@/pages/admin/components/toastContext";
import { AdminError, AdminLoading, Badge, Button, Card, EmptyState, Select, TextArea } from "@/pages/admin/components/ui";

type Kind = "workflow" | "roles" | "integration" | "branding" | "notifications";
const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: "workflow", label: "Admissions workflow", hint: "Statuses and allowed transitions. New applications keep the version published when they start, and status changes follow it." },
  { id: "roles", label: "Roles and permissions", hint: "cms.read, cms.edit and applications.review per role; omitted roles keep their defaults. Administration permissions stay with administrators." },
  { id: "integration", label: "Integrations", hint: "Providers and the NAMES of their secrets. Secret values are never stored here." },
  { id: "branding", label: "Branding", hint: "Primary colour and fonts." },
  { id: "notifications", label: "Email notifications", hint: "Sender, plain-text templates and which events send email. Placeholders: {{reference}}, {{status}}, {{previousStatus}}, {{institution}}. Each notification keeps the version it was created with." },
];

interface KindState {
  defaults: Record<string, unknown>;
  published: { version: number; config: Record<string, unknown>; publishedAt: string } | null;
  draft: { config: Record<string, unknown>; restoredFrom: number | null } | null;
  history: { version: number; state: string; publishedAt: string; publishedBy: string | null }[];
}
type Overview = Record<Kind, KindState>;

/** Server messages are fixed strings (no document or secret text), so the validation reason is safe to show. */
function reason(error: { code?: string; message?: string }): string {
  if (error.code === "42501") return "You do not have permission to do that.";
  if (error.code === "40001") return "This configuration changed since you opened it. Reload and try again.";
  if (error.code === "22023") return error.message ?? "That configuration is not valid.";
  return "The change could not be saved. Please try again.";
}

export default function ConfigurationPanel({ tenantId }: { tenantId: string }) {
  const { push } = useToast();
  const [kind, setKind] = useState<Kind>("workflow");
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (selected?: Kind) => {
    const { data: overview, error } = await supabase.rpc("tenant_config_overview", { p_tenant: tenantId });
    if (error || !overview) { setFailed(true); return; }
    setFailed(false);
    setData(overview as Overview);
    const state = (overview as Overview)[selected ?? kind];
    setText(JSON.stringify((state.draft ?? state.published)?.config ?? state.defaults, null, 2));
  }, [tenantId, kind]);

  useEffect(() => { void load(); }, [load]);

  if (failed) return <AdminError message="Configuration is unavailable for this account." onRetry={() => void load()} />;
  if (!data) return <AdminLoading label="Loading configuration…" />;

  const state = data[kind];
  const baseVersion = state.published?.version ?? 0;
  const parse = (): Record<string, unknown> | null => {
    try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
  };
  const call = async (command: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    const { error } = await supabase.rpc(command, { p_tenant: tenantId, p_kind: kind, ...args });
    setBusy(false);
    if (error) { push(reason(error), "error"); return false; }
    push(done);
    await load();
    return true;
  };
  const saveDraft = () => {
    const config = parse();
    if (!config) { push("The configuration must be valid JSON describing an object.", "error"); return Promise.resolve(false); }
    return call("tenant_config_save_draft", { p_config: config, p_base_version: baseVersion }, "Draft saved");
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="grid gap-3 sm:grid-cols-[260px_1fr] sm:items-center">
          <Select value={kind} onChange={(e) => { const next = e.target.value as Kind; setKind(next); void load(next); }}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </Select>
          <p className="text-sm text-background-600">{KINDS.find((k) => k.id === kind)?.hint}</p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge tone={state.published ? "success" : "muted"}>{state.published ? `Published v${state.published.version}` : "Using safe defaults"}</Badge>
          {state.draft && <Badge tone="warn">{state.draft.restoredFrom ? `Draft restored from v${state.draft.restoredFrom}` : "Unpublished draft"}</Badge>}
        </div>
      </Card>
      <Card className="p-5">
        <TextArea rows={16} spellCheck={false} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} aria-label="Configuration JSON" />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void saveDraft()}>Save draft</Button>
          <Button disabled={busy} onClick={async () => { if (await saveDraft()) await call("tenant_config_publish", { p_base_version: baseVersion }, "Published"); }}>Save and publish</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setText(JSON.stringify((state.published ?? { config: state.defaults }).config, null, 2))}>Reset editor</Button>
        </div>
      </Card>
      <Card className="p-5">
        <h3 className="mb-3 text-sm font-semibold">Version history</h3>
        {state.history.length === 0 ? <EmptyState title="Nothing published yet" /> : (
          <ul className="divide-y divide-background-200">
            {state.history.map((h) => (
              <li key={h.version} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <span>v{h.version} <Badge tone={h.state === "published" ? "success" : "muted"}>{h.state === "published" ? "Current" : "Superseded"}</Badge> · {new Date(h.publishedAt).toLocaleString()} · {h.publishedBy ?? "system"}</span>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void call("tenant_config_restore", { p_version: h.version }, `Version ${h.version} loaded as a draft`)}>Restore as draft</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
