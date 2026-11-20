import { useEffect, useState } from "react";
import { Microsoft365Checklist } from "@/pages/admin/components/Microsoft365Panel";
import { createOffice365, fetchEmailPeople, linkOffice365, lookupOffice365, Office365Refusal, resendOffice365, useMicrosoft365,
  type EmailPerson, type MailboxKind, type Office365Existing, type Office365Lookup } from "@/pages/admin/lib/microsoft365";
import { formatSignedAt } from "@/lib/signedTime";
import { ruleText } from "@/lib/businessRules";

/*
 * Administration > Email Management > Create Email (owner 2026-11-20).
 *   Student  -> @student.slit.edu.au, Office 365 A1 for students
 *   Employee / Trainer / Agent -> @slit.edu.au, Office 365 A1 for faculty (never the student domain or licence; never Microsoft 365 Apps
 *   for faculty, which has no mailbox). The domain dropdown offers the tenant's verified domains for the type only (never onmicrosoft.com).
 * Once the person's account exists, Create is replaced by its steps and "Resend login email" (the server refuses a second account).
 * Choosing a person looks them up in Microsoft 365 first (student-office365 "lookup": linked account, work email, username, name).
 * Already has a mailbox: "Already has <address>" and Link, nothing is created. A same-name account may be someone else: Link it, or say
 * "different person" (only then the address gets a number). Creation is blocked when no licence of that kind is free.
 */

const panel = "rounded-xl border border-background-200 bg-white p-5 sm:p-6";
const field = "w-full rounded-lg border border-background-300 bg-white px-3 py-2.5 text-sm text-foreground-900 focus:outline-none focus:ring-2 focus:ring-primary-500";
const muted = "text-sm text-foreground-600";
const button = "rounded-lg border border-background-300 px-4 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100 disabled:opacity-50";
const KIND_LABEL: Record<MailboxKind, string> = { student: "Student", employee: "Employee", trainer: "Trainer", agent: "Agent" };
/** Business Rule office365.agent_mailbox: "No mailbox" hides Agent here (student-office365 refuses it too). */
const agentMailboxOffered = () => ruleText("office365.agent_mailbox", "Staff mailbox at slit.edu.au").trim().toLowerCase() !== "no mailbox";
const MATCH_LABEL: Record<Office365Existing["match"], string> = { linked: "linked to this record", email: "the email on this record", username: "same username", name: "same name" };
const certain = (e: Office365Existing) => e.match === "linked" || e.match === "email";

export default function CreateEmailSection() {
  const { status, loading } = useMicrosoft365();
  const [kind, setKind] = useState<MailboxKind>("student");
  const [people, setPeople] = useState<EmailPerson[] | null>(null);
  const [peopleError, setPeopleError] = useState("");
  const [personId, setPersonId] = useState("");
  const [look, setLook] = useState<Office365Lookup | null>(null);
  const [lookError, setLookError] = useState("");
  const [differentPerson, setDifferentPerson] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"" | "create" | "link" | "resend">("");
  const [domain, setDomain] = useState("");
  const [resendConfirm, setResendConfirm] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [reload, setReload] = useState(0);

  // The person list (once Microsoft 365 is connected), per person type.
  useEffect(() => {
    if (!status?.connected) return;
    let live = true; setPeople(null); setPeopleError(""); setPersonId("");
    void fetchEmailPeople(kind).then((rows) => { if (live) setPeople(rows); }, (e: unknown) => { if (live) setPeopleError(e instanceof Error ? e.message : "The people could not be loaded."); });
    return () => { live = false; };
  }, [kind, status?.connected, reload]);
  // The Microsoft 365 lookup for the chosen person.
  useEffect(() => {
    setLook(null); setLookError(""); setDifferentPerson(false); setConfirming(false); setResendConfirm(false);
    if (!personId || !status?.connected) return;
    let live = true;
    void lookupOffice365(kind, personId).then((r) => { if (live) setLook(r); }, (e: unknown) => { if (live) setLookError(e instanceof Error ? e.message : "Microsoft 365 could not be checked."); });
    return () => { live = false; };
  }, [kind, personId, status?.connected, reload]);

  const person = people?.find((p) => p.id === personId) ?? null;
  const domains = look?.domains ?? [];
  useEffect(() => { setDomain(domains[0] ?? ""); }, [domains.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  // The account Skyline created for this person (any step): never created again, only Resend login email.
  const created = look?.account?.msUserId && !look.account.linked ? look.account : null;
  const has = created ? null : look?.account?.status === "active" ? look.account.email : look?.existing.find(certain)?.upn ?? null;
  const possible = look && !has ? look.existing.filter((e) => !certain(e)) : [];
  const address = look ? (possible.length && !differentPerson ? null : look.address) : null;
  const canCreate = !!status?.ready && !!look && !look.blocked && !has && !created && (!possible.length || differentPerson) && !!look.address && !!domain && !busy;
  const why = !status?.ready ? "Microsoft 365 is not ready" : !person ? "Choose a person" : !look ? "Checking Microsoft 365…" : look.blocked ?? (has ? `Already has ${has}` : possible.length && !differentPerson ? "Link the existing account, or confirm it is a different person" : undefined);

  const create = async () => {
    if (!person || !canCreate) return;
    setBusy("create"); setResult(null);
    try {
      const r = await createOffice365(kind, person.id, { differentPerson, domain });
      setResult({ tone: "ok", text: `Created ${r.email}.${r.welcomeSent ? " The login details were emailed to the person's own email." : ""}${r.warning ? ` ${r.warning}` : ""}` });
      setReload((n) => n + 1);
    } catch (e) { setResult({ tone: "error", text: e instanceof Error ? e.message : "The account could not be created." }); if (e instanceof Office365Refusal && e.existing.length) setReload((n) => n + 1); }
    finally { setBusy(""); setConfirming(false); }
  };
  const resendLogin = async () => {
    if (!person || busy) return;
    setBusy("resend"); setResult(null);
    try { const r = await resendOffice365(kind, person.id); setResult({ tone: "ok", text: `Login email sent to ${r.welcomeTo ?? "the person's email"} for ${r.email}. A new temporary password was set (change at next sign-in).` }); }
    catch (e) { setResult({ tone: "error", text: `${e instanceof Error ? e.message : "The login email could not be sent."}` }); }
    finally { setBusy(""); setResendConfirm(false); setReload((n) => n + 1); }
  };
  const link = async (account: Office365Existing) => {
    if (!person || busy) return;
    setBusy("link"); setResult(null);
    try { const r = await linkOffice365(kind, person.id, account.id); setResult({ tone: "ok", text: `Linked ${r.email} to ${person.name}. No new account was created.` }); setReload((n) => n + 1); }
    catch (e) { setResult({ tone: "error", text: e instanceof Error ? e.message : "The account could not be linked." }); }
    finally { setBusy(""); }
  };

  return <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
    <section className={panel}><h2 className="text-lg font-semibold">New email account</h2><p className={"mt-1 " + muted}>Select an existing CRM or HRMS record. No duplicate person records will be created.</p>
      <div className="mt-6 space-y-5">
        <div><label htmlFor="person-type" className="mb-2 block text-sm font-medium">Person type</label>
          <select id="person-type" className={field} value={kind} onChange={(e) => { setKind(e.target.value as MailboxKind); setResult(null); }} data-testid="email-kind">
            {(Object.keys(KIND_LABEL) as MailboxKind[]).filter((k) => k !== "agent" || agentMailboxOffered()).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
          <p className="mt-2 text-xs text-foreground-500">{kind === "student" ? "Student accounts: @student.slit.edu.au with Office 365 A1 for students." : "Staff accounts (employees, trainers, agents): @slit.edu.au with Office 365 A1 for faculty."}</p></div>
        <div><label htmlFor="person-record" className="mb-2 block text-sm font-medium">Existing person</label>
          <select id="person-record" disabled={!status?.connected || !people?.length} className={field + " disabled:opacity-60"} value={personId} onChange={(e) => { setPersonId(e.target.value); setResult(null); }} data-testid="email-person">
            <option value="">{!status?.connected ? (loading ? "Checking Microsoft 365…" : "Needs the Microsoft 365 connection") : peopleError ? "Could not load the list" : people === null ? "Loading…" : people.length ? `Choose a person (${people.length})` : "No people of this type"}</option>
            {(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.email ? ` · ${p.email}` : ""}{p.mailbox ? " · has Microsoft 365" : ""}</option>)}</select>
          {peopleError ? <p role="alert" className="mt-2 text-xs text-red-700">{peopleError}</p> : null}
          <p className="mt-2 text-xs text-foreground-500">Source: existing {kind === "student" ? "CRM student" : kind === "agent" ? "CRM agent" : "HRMS staff"} profiles</p></div>

        {person && !look && !lookError ? <p role="status" className={muted}>Looking {person.name} up in Microsoft 365…</p> : null}
        {lookError ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{lookError}</p> : null}
        {created ? <div className="rounded-md border border-background-200 bg-background-50 p-3 text-sm" data-testid="email-created">
          <p className="font-medium text-foreground-900">Created {created.email}</p>
          <ul className="mt-2 space-y-1">{([
            ["Account created", created.steps?.accountCreatedAt ? "ok" : "todo", created.steps?.accountCreatedAt ? formatSignedAt(created.steps.accountCreatedAt) : ""],
            ["Licence assigned", created.steps?.licenceAssignedAt ? "ok" : "todo", created.steps?.licenceAssignedAt ? `${created.licenceSku ?? ""} ${formatSignedAt(created.steps.licenceAssignedAt)}` : "not yet: Resend finishes it"],
            ["Groups added", created.steps?.groupsAddedAt ? "ok" : created.steps?.groupsError ? "fail" : "todo", created.steps?.groupsAddedAt ? formatSignedAt(created.steps.groupsAddedAt) : created.steps?.groupsError ? `failed (${created.steps.groupsError})` : look?.groups ? "not yet" : "no groups set up yet"],
            ["Login email", created.steps?.welcomeSentAt && !created.steps.welcomeError ? "ok" : created.steps?.welcomeError ? "fail" : "todo", created.steps?.welcomeError ? `failed (${created.steps.welcomeError})` : created.steps?.welcomeSentAt ? `sent ${formatSignedAt(created.steps.welcomeSentAt)}` : "not sent"],
          ] as const).map(([label, state, detail]) => <li key={label} className="flex items-start gap-2" data-testid={`email-step-${label.split(" ")[0].toLowerCase()}`} data-state={state}>
            <i className={state === "ok" ? "ri-checkbox-circle-fill text-emerald-600" : state === "fail" ? "ri-close-circle-fill text-red-600" : "ri-checkbox-blank-circle-line text-foreground-400"} aria-hidden="true" />
            <span><span className="font-medium">{label}</span>{detail ? <span className="text-foreground-600"> · {detail}</span> : null}</span></li>)}</ul>
          {resendConfirm ? <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="email-resend-confirm">
            <span>Set a new temporary password for {created.email} and email it to {person?.email ?? "the person"}?</span>
            <button type="button" onClick={() => void resendLogin()} disabled={!!busy} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" data-testid="email-resend-yes">{busy === "resend" ? "Sending…" : "Yes, resend"}</button>
            <button type="button" onClick={() => setResendConfirm(false)} disabled={!!busy} className={button}>Cancel</button></div>
            : <button type="button" className="mt-3 rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!!busy || !status?.connected} onClick={() => setResendConfirm(true)} data-testid="email-resend">Resend login email</button>}
        </div> : null}
        {look && has ? <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950" data-testid="email-already-has">
          <p className="font-medium">Already has {has}</p>
          {look.account?.status === "active" ? <p className="mt-1">It is linked to this record. Nothing to create.</p> : <>
            <p className="mt-1">Microsoft 365 already has this person's mailbox ({MATCH_LABEL[look.existing.find(certain)!.match]}). No second account will be created.</p>
            <button type="button" className={button + " mt-2 bg-white"} disabled={!!busy} onClick={() => void link(look.existing.find(certain)!)} data-testid="email-link">{busy === "link" ? "Linking…" : "Link it to this record"}</button>
          </>}
        </div> : null}
        {look && possible.length ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="email-possible">
          <p className="font-medium">Microsoft 365 has {possible.length === 1 ? "an account" : "accounts"} that may be {person?.name}:</p>
          <ul className="mt-2 space-y-2">{possible.map((e) => <li key={e.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words">{e.displayName} · {e.upn} <span className="text-xs text-amber-800">({MATCH_LABEL[e.match]}{e.enabled ? "" : ", disabled"})</span></span>
            <button type="button" className={button + " bg-white py-1"} disabled={!!busy} onClick={() => void link(e)} data-testid={`email-link-${e.id}`}>This is them: link it</button></li>)}</ul>
          <label className="mt-3 flex cursor-pointer items-start gap-2"><input type="checkbox" className="mt-0.5" checked={differentPerson} onChange={(e) => setDifferentPerson(e.target.checked)} data-testid="email-different-person" />
            <span>It is a different person: create a new account (a number is added to the address).</span></label>
        </div> : null}

        {!created ? <div><label htmlFor="email-name" className="mb-2 block text-sm font-medium">Username and domain</label>
          <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-background-300">
            <input id="email-name" readOnly className="min-w-0 flex-1 bg-background-50 px-3 py-2.5 text-sm outline-none" value={has ? has.split("@")[0] : address ? address.split("@")[0] : ""} placeholder={look ? (possible.length ? "Choose above first" : "—") : "firstname.lastname"} data-testid="email-username" />
            <span className="flex items-center border-l border-background-200 px-2 text-sm text-foreground-600">@</span>
            <label htmlFor="email-domain" className="sr-only">Domain</label>
            <select id="email-domain" className="border-l border-background-200 bg-white px-2 text-sm disabled:opacity-60" value={domain} disabled={!domains.length} onChange={(e) => setDomain(e.target.value)} data-testid="email-domain">
              {domains.length ? domains.map((d) => <option key={d} value={d}>{d}</option>) : <option value="">{kind === "student" ? "student.slit.edu.au" : "slit.edu.au"}</option>}</select>
          </div>
          <p className="mt-2 text-xs text-foreground-500">From the person's name; a number is added only for a different person with the same name. Only the tenant's verified {kind === "student" ? "student" : "staff"} domain is offered.</p></div> : null}
        <div><p className="mb-2 block text-sm font-medium">Microsoft 365 licence</p>
          <p className="rounded-lg border border-background-200 bg-background-50 px-3 py-2.5 text-sm" data-testid="email-licence">
            {look ? <>{look.plan.licenceName} ({look.plan.sku}): {look.licence ? `${look.licence.available} of ${look.licence.total} free` : "not in the tenant"}</>
              : kind === "student" ? "Office 365 A1 for students" : "Office 365 A1 for faculty"}</p></div>
        {look?.blocked && !has ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="email-blocked">{look.blocked}</p> : null}
        {result ? <p role={result.tone === "error" ? "alert" : "status"} className={`rounded-md border p-3 text-sm ${result.tone === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`} data-testid="email-result">{result.text}</p> : null}
        {created ? null : confirming && person ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="email-confirm">
          <span>Create <strong>{address ? `${address.split("@")[0]}@${domain}` : ""}</strong> for <strong>{person.name}</strong> with {look?.plan.licenceName} and email the login details to {person.email ?? "their own email"}?</span>
          <button type="button" onClick={() => void create()} disabled={!canCreate} className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" data-testid="email-create-confirm">{busy === "create" ? "Creating…" : "Yes, create it"}</button>
          <button type="button" onClick={() => setConfirming(false)} disabled={!!busy} className={button}>Cancel</button>
        </div> : <button type="button" disabled={!canCreate} onClick={() => setConfirming(true)} title={why}
          className="rounded-lg bg-primary-500 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" data-testid="email-create">Create Microsoft 365 account</button>}
      </div>
    </section>
    <aside className={panel}><h2 className="font-semibold">Provisioning checklist</h2><div className="mt-4 space-y-3"><Microsoft365Checklist />
      <div className="flex items-start gap-2 text-sm" data-testid="m365-check-person" data-state={person && !has ? "ok" : "not_checked"}>
        <i className={person && !has ? "ri-checkbox-circle-fill text-emerald-600" : has ? "ri-error-warning-fill text-amber-600" : "ri-checkbox-blank-circle-line text-foreground-400"} aria-hidden="true" />
        <span><span className="font-medium text-foreground-900">Existing person selected</span>{has ? <span className="block text-xs text-foreground-600">Already has {has}</span> : null}</span></div></div>
      <p className={"mt-5 " + muted}>Mailbox readiness is verified separately after user creation and licence assignment.</p></aside>
  </div>;
}
