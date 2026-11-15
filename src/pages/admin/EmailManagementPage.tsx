import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

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
function Status() { return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800"><i className="ri-alert-line" aria-hidden="true" /> Not connected</span>; }
export default function EmailManagementPage() {
  const [params] = useSearchParams();
  const selected = params.get("section");
  const active: Section = sections.some(s => s.id === selected) ? selected as Section : "accounts";
  const current = sections.find(s => s.id === active)!;
  const [query, setQuery] = useState("");
  const [personType, setPersonType] = useState("student");
  const [username, setUsername] = useState("");
  const [rule, setRule] = useState("student-enrolled");
  const filtered = useMemo(() => query.trim(), [query]);
  return <main className="mx-auto max-w-6xl space-y-6 pb-12">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Administration / Email Management</p>
        <h1 className="mt-1 font-heading text-3xl font-bold text-foreground-950">{current.label}</h1>
        <p className="mt-2 text-sm text-foreground-600">{current.description}</p></div>
      <Status />
    </header>
    <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <i className="ri-information-line mt-0.5 text-lg" aria-hidden="true" />
      <div><strong>Microsoft 365 connection required.</strong> These screens are ready for configuration, but no Microsoft accounts or licences have been retrieved. Account changes are disabled until a secure server-side connection is established.</div>
    </div>

    {active === "accounts" && <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {[["Accounts", "—", "ri-mail-line"], ["Active mailboxes", "—", "ri-checkbox-circle-line"], ["Licences available", "—", "ri-key-2-line"]].map(([name, value, icon]) => <div key={name} className={panel}>
          <i className={icon + " text-xl text-foreground-500"} aria-hidden="true" /><p className="mt-3 text-sm text-foreground-600">{name}</p><p className="mt-1 text-2xl font-semibold">{value}</p><p className="mt-1 text-xs text-foreground-500">Awaiting Microsoft 365 sync</p>
        </div>)}
      </div>
      <section className={panel}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Account directory</h2><Link to="/admin/email-management?section=create" className={button}>Create email</Link></div>
        <label htmlFor="account-search" className="sr-only">Search email accounts</label>
        <div className="relative mb-5"><i className="ri-search-line absolute left-3 top-3 text-foreground-500" aria-hidden="true" /><input id="account-search" className={field + " pl-9"} placeholder="Search by name, email or person type" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-sm"><thead className="border-b border-background-200 text-foreground-600"><tr>{["Person", "Email address", "Type", "Status", "Licence"].map(h => <th key={h} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead></table></div>
        <Empty icon="ri-inbox-line" title="No account data available" text={filtered ? "Search results will appear after Microsoft 365 is connected." : "Connect Microsoft 365 to securely display existing accounts and their mailbox status."} />
      </section>
    </div>}

    {active === "create" && <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className={panel}><h2 className="text-lg font-semibold">New email account</h2><p className={"mt-1 " + muted}>Select an existing CRM or HRMS record. No duplicate person records will be created.</p>
        <div className="mt-6 space-y-5">
          <div><label htmlFor="person-type" className="mb-2 block text-sm font-medium">Person type</label><select id="person-type" className={field} value={personType} onChange={e => setPersonType(e.target.value)}><option value="student">Student</option><option value="employee">Employee</option><option value="trainer">Trainer</option><option value="agent">Agent</option></select></div>
          <div><label htmlFor="person-record" className="mb-2 block text-sm font-medium">Existing person</label><select id="person-record" disabled className={field + " disabled:opacity-60"}><option>Connect directory to select a record</option></select><p className="mt-2 text-xs text-foreground-500">Source: existing {personType === "student" ? "CRM student" : personType === "agent" ? "CRM agent" : "HRMS staff"} profiles</p></div>
          <div><label htmlFor="email-name" className="mb-2 block text-sm font-medium">Requested email username</label><div className="flex min-w-0 items-center rounded-lg border border-background-300"><input id="email-name" className="min-w-0 flex-1 rounded-l-lg px-3 py-2.5 text-sm outline-none" placeholder="firstname.lastname" value={username} onChange={e => setUsername(e.target.value)} /><span className="shrink-0 border-l border-background-200 px-3 text-xs text-foreground-600">@slit.edu.au</span></div><p className="mt-2 text-xs text-foreground-500">Availability and domain verification will be checked before provisioning.</p></div>
          <div><label className="mb-2 block text-sm font-medium">Microsoft 365 licence</label><select disabled className={field + " disabled:opacity-60"}><option>Available licences not loaded</option></select></div>
          <button type="button" disabled className="rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">Create Microsoft 365 account</button>
        </div>
      </section>
      <aside className={panel}><h2 className="font-semibold">Provisioning checklist</h2><div className="mt-4 space-y-3 text-sm">{["Microsoft 365 connection","Verified slit.edu.au domain","Admin consent","Available licence","Existing person selected"].map(item => <div key={item} className="flex items-start gap-2"><i className="ri-checkbox-blank-circle-line text-amber-700" aria-hidden="true" />{item}</div>)}</div><p className={"mt-5 " + muted}>Mailbox readiness is verified separately after user creation and licence assignment.</p></aside>
    </div>}

    {active === "automation" && <div className="space-y-5">
      <section className={panel}><div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-semibold">Lifecycle automation</h2><p className={"mt-1 " + muted}>Review proposed triggers before enabling any workflow.</p></div><span className="rounded-full bg-background-100 px-3 py-1 text-xs font-semibold text-foreground-600">All rules inactive</span></div>
        <div className="mt-5 space-y-3">{[["Student enrolled", "Prepare student email account", "ri-graduation-cap-line"], ["Employee onboarded", "Prepare staff email account", "ri-user-follow-line"], ["Person offboarded", "Request review before disabling access", "ri-user-unfollow-line"]].map(([title, desc, icon]) => <div key={title} className="flex items-center gap-3 rounded-lg border border-background-200 p-4"><i className={icon + " text-xl text-foreground-500"} aria-hidden="true" /><div className="flex-1"><h3 className="text-sm font-semibold">{title}</h3><p className="text-xs text-foreground-600">{desc}</p></div><span className="text-xs text-foreground-500">Off</span></div>)}</div>
      </section>
      <section className={panel}><h2 className="font-semibold">Rule preview</h2><label htmlFor="rule-select" className="mt-4 mb-2 block text-sm">When this event occurs</label><select id="rule-select" className={field} value={rule} onChange={e => setRule(e.target.value)}><option value="student-enrolled">Student enrolled</option><option value="employee-onboarded">Employee onboarded</option><option value="person-offboarded">Person offboarded</option></select><p className={"mt-3 " + muted}>Action: {rule === "person-offboarded" ? "Request an administrator's approval to disable the account." : "Queue a mailbox provisioning request for administrator review."}</p><button type="button" disabled className={button + " mt-5 opacity-50"}>Save rule (connection required)</button></section>
    </div>}

    {active === "settings" && <div className="grid gap-5 lg:grid-cols-2">
      <section className={panel}><h2 className="text-lg font-semibold">Microsoft 365 connection</h2><div className="mt-5 space-y-4">{[["Tenant", "Not configured"], ["Application", "Not configured"], ["Verified email domain", "Not verified"], ["Graph API consent", "Not verified"], ["Connection status", "Not connected"]].map(([name, value]) => <div key={name} className="flex items-center justify-between gap-4 border-b border-background-100 pb-3 text-sm"><span className="text-foreground-600">{name}</span><span className="text-right font-medium">{value}</span></div>)}</div><p className={"mt-5 " + muted}>Credentials must be stored in secure server-side configuration, never in browser forms.</p><button type="button" disabled className={button + " mt-4 opacity-50"}>Test connection</button></section>
      <section className={panel}><h2 className="text-lg font-semibold">Licence mapping</h2><p className={"mt-2 " + muted}>Assign the appropriate Microsoft 365 SKU for students, employees and trainers after the tenant licence catalogue is available.</p><Empty icon="ri-key-2-line" title="Licence catalogue unavailable" text="Connect Microsoft 365 to retrieve subscribed SKUs and available seats." /></section>
    </div>}

    {active === "audit" && <section className={panel}><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Account activity</h2><p className={"mt-1 " + muted}>Provisioning, licence and access events will be recorded here.</p></div><span className="text-xs text-foreground-500">No connected audit source</span></div>
      <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[580px] text-left text-sm"><thead className="border-b border-background-200 text-foreground-600"><tr>{["Date / time", "Actor", "Action", "Account", "Result"].map(h => <th key={h} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead></table></div><Empty icon="ri-file-list-3-line" title="No audit events available" text="Once the backend integration is enabled, account changes and their outcomes will be recorded here." />
    </section>}
  </main>;
}
