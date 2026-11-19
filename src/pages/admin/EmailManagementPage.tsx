import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Microsoft365Panel, { Microsoft365Badge, Microsoft365Checklist } from "@/pages/admin/components/Microsoft365Panel";
import { fetchEmailPeople, useMicrosoft365, type EmailPerson, type PersonType } from "@/pages/admin/lib/microsoft365";
import { createStudentOffice365 } from "@/pages/admin/lib/studentOffice365";

/*
 * Email Management (2026-11-20): every screen reads the ONE Microsoft 365 status (useMicrosoft365: the same check as Integrations >
 * Connections > Microsoft 365, real Microsoft Graph calls). Create Email lists existing people (email_mgmt_people) once connected; a
 * student's account is created by the student-office365 function (the same path as the student page), after a second confirmation.
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
/** The address the server will try first: firstname.lastname (accents and symbols dropped), as student-office365 builds it. */
function suggestedName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).map(p => p.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean);
  return (parts.length === 1 ? parts[0] : parts.length ? `${parts[0]}.${parts[parts.length - 1]}` : "").slice(0, 56);
}
export default function EmailManagementPage() {
  const [params] = useSearchParams();
  const selected = params.get("section");
  const active: Section = sections.some(s => s.id === selected) ? selected as Section : "accounts";
  const current = sections.find(s => s.id === active)!;
  const [query, setQuery] = useState("");
  const [personType, setPersonType] = useState<PersonType>("student");
  const { status, loading } = useMicrosoft365();
  const [people, setPeople] = useState<EmailPerson[] | null>(null);
  const [peopleError, setPeopleError] = useState("");
  const [personId, setPersonId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // The "Existing person" list loads once Microsoft 365 is connected (and again for another person type).
  useEffect(() => {
    if (active !== "create" || !status?.connected) return;
    let live = true; setPeople(null); setPeopleError(""); setPersonId(""); setConfirming(false);
    void fetchEmailPeople(personType).then((rows) => { if (live) setPeople(rows); }, (e: unknown) => { if (live) setPeopleError(e instanceof Error ? e.message : "The people could not be loaded."); });
    return () => { live = false; };
  }, [active, personType, status?.connected]);
  const person = people?.find((p) => p.id === personId) ?? null;
  const studentLicence = status?.licences.find((l) => l.student) ?? null;
  const freeSeats = status?.licences.reduce((n, l) => n + l.available, 0);
  const canCreate = personType === "student" && !!status?.ready && !!person && !person.mailbox && !creating;
  const create = async () => {
    if (!person || !canCreate) return;
    setCreating(true); setResult(null);
    try {
      const r = await createStudentOffice365(person.id);
      setResult({ tone: "ok", text: `Created ${r.email}.${r.welcomeSent ? " The login details were emailed to the student." : ""}${r.warning ? ` ${r.warning}` : ""}` });
      setPeople(await fetchEmailPeople(personType));
    } catch (e) { setResult({ tone: "error", text: e instanceof Error ? e.message : "The account could not be created." }); }
    finally { setCreating(false); setConfirming(false); }
  };
  const [rule, setRule] = useState("student-enrolled");
  const filtered = useMemo(() => query.trim(), [query]);
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

    {active === "create" && <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className={panel}><h2 className="text-lg font-semibold">New email account</h2><p className={"mt-1 " + muted}>Select an existing CRM or HRMS record. No duplicate person records will be created.</p>
        <div className="mt-6 space-y-5">
          <div><label htmlFor="person-type" className="mb-2 block text-sm font-medium">Person type</label><select id="person-type" className={field} value={personType} onChange={e => { setPersonType(e.target.value as PersonType); setResult(null); }}><option value="student">Student</option><option value="employee">Employee</option><option value="trainer">Trainer</option><option value="agent">Agent</option></select></div>
          <div><label htmlFor="person-record" className="mb-2 block text-sm font-medium">Existing person</label><select id="person-record" disabled={!status?.connected || !people?.length} className={field + " disabled:opacity-60"} value={personId} onChange={e => { setPersonId(e.target.value); setConfirming(false); setResult(null); }} data-testid="email-person">
            <option value="">{!status?.connected ? (loading ? "Checking Microsoft 365…" : "Needs the Microsoft 365 connection") : peopleError ? "Could not load the list" : people === null ? "Loading…" : people.length ? `Choose a person (${people.length})` : "No people of this type"}</option>
            {(people ?? []).map(p => <option key={p.id} value={p.id}>{p.name}{p.email ? ` · ${p.email}` : ""}{p.mailbox ? " · has Microsoft 365" : ""}</option>)}</select>
          {peopleError ? <p role="alert" className="mt-2 text-xs text-red-700">{peopleError}</p> : null}<p className="mt-2 text-xs text-foreground-500">Source: existing {personType === "student" ? "CRM student" : personType === "agent" ? "CRM agent" : "HRMS staff"} profiles</p></div>
          <div><label htmlFor="email-name" className="mb-2 block text-sm font-medium">Requested email username</label><div className="flex min-w-0 items-center rounded-lg border border-background-300"><input id="email-name" readOnly className="min-w-0 flex-1 rounded-l-lg bg-background-50 px-3 py-2.5 text-sm outline-none" placeholder="firstname.lastname" value={person ? (person.mailbox ?? suggestedName(person.name)) : ""} /><span className="shrink-0 border-l border-background-200 px-3 text-xs text-foreground-600">@{status?.domains.find(d => d.name !== "slit.edu.au")?.name ?? "slit.edu.au"}</span></div><p className="mt-2 text-xs text-foreground-500">{person?.mailbox ? "This person already has a Microsoft 365 address." : "Chosen from the person's name; a number is added when the address is taken."}</p></div>
          <div><label className="mb-2 block text-sm font-medium">Microsoft 365 licence</label><select disabled className={field + " disabled:opacity-60"} value={studentLicence?.sku ?? ""} data-testid="email-licence">{status?.connected && status.licences.length ? status.licences.map(l => <option key={l.sku} value={l.sku}>{l.sku}: {l.available} of {l.total} free{l.student ? " (students)" : ""}</option>) : <option value="">{status?.connected ? "No licences found" : "Needs the Microsoft 365 connection"}</option>}</select>
            <p className="mt-2 text-xs text-foreground-500">Students get the student licence. Staff, trainer and agent accounts are not created from here yet.</p></div>
          {result ? <p role={result.tone === "error" ? "alert" : "status"} className={`rounded-md border p-3 text-sm ${result.tone === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{result.text}</p> : null}
          {confirming && person ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="email-confirm">
            <span>Create a Microsoft 365 account for <strong>{person.name}</strong> and email the login details to {person.email ?? "their personal email"}?</span>
            <button type="button" onClick={() => void create()} disabled={!canCreate} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{creating ? "Creating…" : "Yes, create it"}</button>
            <button type="button" onClick={() => setConfirming(false)} disabled={creating} className={button}>Cancel</button>
          </div> : <button type="button" disabled={!canCreate} onClick={() => setConfirming(true)} title={personType !== "student" ? "Only student accounts can be created here for now" : !status?.ready ? "Microsoft 365 is not ready" : person?.mailbox ? "This person already has an account" : !person ? "Choose a person" : undefined}
            className="rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" data-testid="email-create">Create Microsoft 365 account</button>}
        </div>
      </section>
      <aside className={panel}><h2 className="font-semibold">Provisioning checklist</h2><div className="mt-4 space-y-3"><Microsoft365Checklist />
        <div className="flex items-start gap-2 text-sm" data-testid="m365-check-person" data-state={person && !person.mailbox ? "ok" : "not_checked"}><i className={person && !person.mailbox ? "ri-checkbox-circle-fill text-emerald-600" : person?.mailbox ? "ri-error-warning-fill text-amber-600" : "ri-checkbox-blank-circle-line text-foreground-400"} aria-hidden="true" />
          <span><span className="font-medium text-foreground-900">Existing person selected</span>{person?.mailbox ? <span className="block text-xs text-foreground-600">Already has {person.mailbox}</span> : null}</span></div></div>
        <p className={"mt-5 " + muted}>Mailbox readiness is verified separately after user creation and licence assignment.</p></aside>
    </div>}

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
