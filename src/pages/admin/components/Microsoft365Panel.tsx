import { m365Checklist, m365Label, useMicrosoft365, type CheckState } from "@/pages/admin/lib/microsoft365";
import { institutionTimeZone } from "@/lib/timeZone";

/*
 * The one Microsoft 365 status, as a badge and as a panel (owner 2026-11-20): Integrations > Connections > Microsoft 365 and
 * Administration > Email Management show exactly this, from the same check (useMicrosoft365).
 */

const ICON: Record<CheckState, [string, string]> = {
  ok: ["ri-checkbox-circle-fill", "text-emerald-600"], missing: ["ri-error-warning-fill", "text-amber-600"],
  failed: ["ri-close-circle-fill", "text-red-600"], not_checked: ["ri-checkbox-blank-circle-line", "text-foreground-400"],
};

export function Microsoft365Badge() {
  const { status, loading } = useMicrosoft365();
  const label = m365Label(status, loading);
  const tone = status?.ready ? "bg-emerald-50 text-emerald-800" : status?.connected ? "bg-amber-50 text-amber-800" : loading && !status ? "bg-background-100 text-foreground-600" : "bg-red-50 text-red-800";
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`} data-testid="m365-badge">
    <i className={status?.ready ? "ri-checkbox-circle-line" : loading && !status ? "ri-loader-4-line animate-spin" : "ri-alert-line"} aria-hidden="true" /> {label}</span>;
}

/** The checklist: connection, verified slit.edu.au domain, admin consent, available licence. */
export function Microsoft365Checklist() {
  const { status } = useMicrosoft365();
  return <ul className="space-y-3 text-sm" data-testid="m365-checklist">
    {m365Checklist(status).map((item) => {
      const [icon, tone] = ICON[item.state];
      return <li key={item.key} className="flex items-start gap-2" data-testid={`m365-check-${item.key}`} data-state={item.state}>
        <i className={`${icon} ${tone} mt-0.5`} aria-hidden="true" />
        <span className="min-w-0"><span className="font-medium text-foreground-900">{item.label}</span>
          {item.detail ? <span className="block break-words text-xs text-foreground-600">{item.detail}</span> : null}</span>
      </li>;
    })}
  </ul>;
}

export default function Microsoft365Panel({ compact = false }: { compact?: boolean }) {
  const { status, loading, error, refresh } = useMicrosoft365();
  return <section className="space-y-4" data-testid="m365-panel" aria-label="Microsoft 365 status">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">Microsoft 365</h2>
        <p className="text-sm text-foreground-600">{status?.tenant ? <>Tenant <strong>{status.tenant.name}</strong> · </> : null}Skyline's Entra app, app-only (used by Email Management and student emails).</p>
      </div>
      <div className="flex items-center gap-2"><Microsoft365Badge />
        <button type="button" onClick={() => void refresh()} disabled={loading} className="cursor-pointer rounded-lg border border-background-300 px-3 py-1.5 text-sm font-medium hover:bg-background-100 disabled:opacity-50" data-testid="m365-recheck">
          {loading ? "Checking…" : "Check again"}</button></div>
    </div>
    {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
    <Microsoft365Checklist />
    {status?.problems.length ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="m365-problems">
      <p className="font-medium">To fix</p>
      <ol className="mt-1 list-decimal space-y-1 pl-5">{status.problems.map((p) => <li key={p}>{p}</li>)}</ol>
    </div> : null}
    {!compact && status?.connected ? <div className="grid gap-4 sm:grid-cols-2">
      <div><h3 className="mb-1 text-sm font-semibold">Application permissions (admin consent)</h3>
        <ul className="text-sm">{[...status.consent.granted, ...status.consent.missing.map((m) => `${m} (missing)`)].map((r) => <li key={r} className={r.endsWith("(missing)") ? "text-amber-800" : ""}>{r}</li>)}
          {!status.consent.welcomeEmail ? <li className="text-foreground-500">Mail.Send (not granted: the login email to a new student cannot be sent)</li> : null}</ul></div>
      <div><h3 className="mb-1 text-sm font-semibold">Licences</h3>
        {status.licences.length ? <ul className="text-sm" data-testid="m365-licences">{status.licences.map((l) => <li key={l.sku}>{l.sku}{l.student ? " (students)" : ""}: {l.available} of {l.total} free</li>)}</ul>
          : <p className="text-sm text-foreground-600">No licences found.</p>}</div>
    </div> : null}
    {status ? <p className="text-xs text-foreground-500">Checked {new Date(status.checkedAt).toLocaleString("en-AU", { timeZone: institutionTimeZone(), dateStyle: "medium", timeStyle: "short" })}. Credentials stay in server-side secrets.</p> : null}
  </section>;
}
