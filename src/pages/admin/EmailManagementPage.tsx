import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Microsoft365Panel, { Microsoft365Badge } from "@/pages/admin/components/Microsoft365Panel";
import CreateEmailSection from "@/pages/admin/components/CreateEmailSection";
import { useMicrosoft365 } from "@/pages/admin/lib/microsoft365";

/*
 * Email Management (2026-11-20): every screen reads the ONE Microsoft 365 status (useMicrosoft365: the same check as Integrations >
 * Connections > Microsoft 365, real Microsoft Graph calls). Create Email: CreateEmailSection (students and staff, existing mailbox first).
 */

const sections = [
  { id: "accounts", label: "Email Accounts", description: "View and manage SLIT Microsoft 365 identities." },
  { id: "create", label: "Create Email", description: "Prepare a mailbox for an existing SLIT person." },
  { id: "automation", label: "Automation Rules", description: "Configure lifecycle events for email accounts." },
  { id: "settings", label: "Microsoft 365 Settings", description: "Connection, permissions and licence configuration." },
  { id: "audit", label: "Audit Logs", description: "Review provisioning and administrative activity." },
] as const;
type Section = typeof sections[number]["id"];
const panel = "rounded-xl border border-background-200 bg-white p-5 sm:p-6";
const field = "w-full rounded-lg border border-background-300 bg-white px-3 py-2.5 text-sm text-foreground-900 focus:outline-none focus:ring-2 focus:ring-primary-500";
const muted = "text-sm text-foreground-600";
const button = "rounded-lg border border-background-300 px-4 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100";
function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <div className="flex flex-col items-center rounded-xl border border-dashed border-background-300 px-5 py-12 text-center">
    <i className={icon + " mb-3 text-3xl text-foreground-500"} aria-hidden="true" />
    <h3 className="font-semibold text-foreground-900">{title}</h3><p className="mt-2 max-w-md text-sm text-foreground-600">{text}</p>
  </div>;
}
export default function EmailManagementPage() {
  const [params] = useSearchParams();
  const selected = params.get("section");
  const active: Section = sections.some(s => s.id === selected) ? selected as Section : "accounts";
  const current = sections.find(s => s.id === active)!;
  const [query, setQuery] = useState("");
  const [rule, setRule] = useState("student-enrolled");
  const filtered = useMemo(() => query.trim(), [query]);
  const { status, loading } = useMicrosoft365();
  const studentLicence = status?.licences.find((l) => l.student) ?? null;
  const freeSeats = status?.licences.reduce((n, l) => n + l.available, 0);
  return <main className="mx-auto max-w-6xl space-y-6 pb-12">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Administration / Email Management</p>
        <h1 className="mt-1 font-heading text-3xl font-bold text-foreground-950">{current.label}</h1>
        <p className="mt-2 text-sm text-foreground-600">{current.description}</p></div>
      <Microsoft365Badge />
    </header>
    {status && !status.ready ? <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" data-testid="m365-banner">
      <i className="ri-information-line mt-0.5 text-lg" aria-hidden="true" />
      <div><strong>{status.connected ? "Microsoft 365 is connected but not ready." : "Microsoft 365 is not connected."}</strong> {status.problems[0] ?? ""} <Link className="font-semibold underline" to="/admin/email-management?section=settings">See Microsoft 365 Settings</Link></div>
    </div> : null}

    {active === "accounts" && <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {[["Accounts", "—", "ri-mail-line", "Account listing is not available yet"], ["Active mailboxes", "—", "ri-checkbox-circle-line", "Account listing is not available yet"],
          ["Licences available", status?.connected ? String(freeSeats ?? 0) : "—", "ri-key-2-line", status?.connected ? (studentLicence ? `${studentLicence.available} student licences free` : "From Microsoft 365") : loading ? "Checking Microsoft 365…" : "Needs the Microsoft 365 connection"]].map(([name, value, icon, note]) => <div key={name} className={panel}>
          <i className={icon + " text-xl text-foreground-500"} aria-hidden="true" /><p className="mt-3 text-sm text-foreground-600">{name}</p><p className="mt-1 text-2xl font-semibold">{value}</p><p className="mt-1 text-xs text-foreground-500">{note}</p>
        </div>)}
      </div>
      <section className={panel}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Account directory</h2><Link to="/admin/email-management?section=create" className={button}>Create email</Link></div>
        <label htmlFor="account-search" className="sr-only">Search email accounts</label>
        <div className="relative mb-5"><i className="ri-search-line absolute left-3 top-3 text-foreground-500" aria-hidden="true" /><input id="account-search" className={field + " pl-9"} placeholder="Search by name, email or person type" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-sm"><thead className="border-b border-background-200 text-foreground-600"><tr>{["Person", "Email address", "Type", "Status", "Licence"].map(h => <th key={h} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead></table></div>
        <Empty icon="ri-inbox-line" title="No account data available" text={status?.connected ? "Listing Microsoft 365 accounts is not available yet. Create Email shows who already has an account." : filtered ? "Search results will appear after Microsoft 365 is connected." : "Connect Microsoft 365 to securely display existing accounts and their mailbox status."} />
      </section>
    </div>}

    {active === "create" && <CreateEmailSection />}

    {active === "automation" && <div className="space-y-5">
      <section className={panel}><div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-semibold">Lifecycle automation</h2><p className={"mt-1 " + muted}>Review proposed triggers before enabling any workflow.</p></div><span className="rounded-full bg-background-100 px-3 py-1 text-xs font-semibold text-foreground-600">All rules inactive</span></div>
        <div className="mt-5 space-y-3">{[["Student enrolled", "Prepare student email account", "ri-graduation-cap-line"], ["Employee onboarded", "Prepare staff email account", "ri-user-follow-line"], ["Person offboarded", "Request review before disabling access", "ri-user-unfollow-line"]].map(([title, desc, icon]) => <div key={title} className="flex items-center gap-3 rounded-lg border border-background-200 p-4"><i className={icon + " text-xl text-foreground-500"} aria-hidden="true" /><div className="flex-1"><h3 className="text-sm font-semibold">{title}</h3><p className="text-xs text-foreground-600">{desc}</p></div><span className="text-xs text-foreground-500">Off</span></div>)}</div>
      </section>
      <section className={panel}><h2 className="font-semibold">Rule preview</h2><label htmlFor="rule-select" className="mt-4 mb-2 block text-sm">When this event occurs</label><select id="rule-select" className={field} value={rule} onChange={e => setRule(e.target.value)}><option value="student-enrolled">Student enrolled</option><option value="employee-onboarded">Employee onboarded</option><option value="person-offboarded">Person offboarded</option></select><p className={"mt-3 " + muted}>Action: {rule === "person-offboarded" ? "Request an administrator's approval to disable the account." : "Queue a mailbox provisioning request for administrator review."}</p><button type="button" disabled className={button + " mt-5 opacity-50"}>Save rule (connection required)</button></section>
    </div>}

    {active === "settings" && <div className="grid gap-5 lg:grid-cols-2">
      <section className={panel}><Microsoft365Panel compact /><p className={"mt-4 " + muted}>The same connection as <Link className="underline" to="/admin/integrations">Integrations › Connections › Microsoft 365</Link>. Credentials stay in server-side secrets, never in browser forms.</p></section>
      <section className={panel}><h2 className="text-lg font-semibold">Licences and permissions</h2>
        {status?.connected ? <div className="mt-3 space-y-4 text-sm">
          <div><h3 className="font-medium">Licences</h3>{status.licences.length ? <ul className="mt-1">{status.licences.map(l => <li key={l.sku}>{l.sku}{l.student ? " (used for students)" : ""}: {l.available} of {l.total} free</li>)}</ul> : <p className={muted}>No licences found.</p>}</div>
          <div><h3 className="font-medium">Application permissions with admin consent</h3><ul className="mt-1">{status.consent.granted.map(r => <li key={r}>{r}</li>)}{status.consent.missing.map(r => <li key={r} className="text-amber-800">{r} (missing)</li>)}</ul></div>
        </div> : <Empty icon="ri-key-2-line" title="Licence catalogue unavailable" text={loading ? "Checking Microsoft 365…" : "Connect Microsoft 365 to retrieve subscribed SKUs and available seats."} />}</section>
    </div>}

    {active === "audit" && <section className={panel}><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Account activity</h2><p className={"mt-1 " + muted}>Provisioning, licence and access events will be recorded here.</p></div><span className="text-xs text-foreground-500">No connected audit source</span></div>
      <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[580px] text-left text-sm"><thead className="border-b border-background-200 text-foreground-600"><tr>{["Date / time", "Actor", "Action", "Account", "Result"].map(h => <th key={h} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead></table></div><Empty icon="ri-file-list-3-line" title="No audit events available" text="Once the backend integration is enabled, account changes and their outcomes will be recorded here." />
    </section>}
  </main>;
}
