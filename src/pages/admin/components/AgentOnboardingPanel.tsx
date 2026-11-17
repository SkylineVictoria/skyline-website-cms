import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import RequestDetail from "@/pages/admin/components/signing/RequestDetail";
import SignaturePad from "@/components/signing/SignaturePad";
import { useToast } from "@/pages/admin/components/toastContext";
import { sendAgentOnboarding, signingAction, signingStatus, type AgentOnboardingSendInput } from "@/lib/signingApi";
import { formatAuDate, listOnboarding, openOnboardingFile, prepareOnboarding, PROFILE_LABELS, todayIso, ONBOARDING_FILE_LABEL, type OnboardingFileKind, type OnboardingPrepared, type OnboardingRow } from "@/pages/admin/lib/agentOnboarding";
import type { BusinessDetail } from "@/pages/admin/lib/businessData";

/**
 * Businesses > {name}: the Agent Application Form and the Agent Agreement sent together for signature (the same signing link and
 * email as the student offer letter), where each send is up to, reminders, the signed PDFs and the certificate, and the agent's answers.
 */
export default function AgentOnboardingPanel({ business, onChanged }: { business: BusinessDetail; onChanged: () => Promise<void> }) {
  const { push } = useToast();
  const [rows, setRows] = useState<OnboardingRow[] | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState("");
  const agreement = business.agreement ?? { status: "none" as const, commencementDate: null, expiryDate: null, onboardingId: null };
  const load = useCallback(async () => {
    try { setRows(await listOnboarding(business.id)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "We could not load the onboarding documents."); }
  }, [business.id]);
  useEffect(() => { void load(); }, [load]);
  const refresh = async () => { await load(); await onChanged(); };
  const download = async (row: OnboardingRow, kind: OnboardingFileKind) => {
    setBusyId(`${row.id}:${kind}`);
    try { await openOnboardingFile(row.id, kind); } catch (e) { push(e instanceof Error ? e.message : "The document could not be opened.", "error"); } finally { setBusyId(""); }
  };
  const remind = async (row: OnboardingRow) => {
    if (!row.request.recipientId) return;
    setBusyId(`${row.id}:remind`);
    try { await signingAction({ action: "resend", id: row.request.id, recipientId: row.request.recipientId }); push(`Reminder sent to ${row.agent.email}.`); await refresh(); }
    catch (e) { push(e instanceof Error ? e.message : "The reminder could not be sent.", "error"); } finally { setBusyId(""); }
  };
  const profile = Object.entries(business.profile ?? {}).length ? PROFILE_LABELS.filter(([key]) => (business.profile ?? {})[key]) : [];
  const badge = agreement.status === "signed" ? <Badge tone="success">Agreement signed</Badge> : agreement.status === "sent" ? <Badge tone="warn">Sent, waiting for signature</Badge> : <Badge tone="muted">Not sent</Badge>;
  return <>
    <Card className="p-5" data-testid="agent-onboarding-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-semibold text-foreground-950">Agent onboarding documents</h2>
          <p className="text-sm text-foreground-600">The Agent Application Form and the Agent Agreement, prefilled from this business's record and sent together to its agent for e-signature.</p>
          {agreement.status === "signed" && agreement.commencementDate ? <p className="mt-1 text-sm text-foreground-700">Agreement from <strong>{formatAuDate(agreement.commencementDate)}</strong> to <strong>{formatAuDate(agreement.expiryDate)}</strong> (two years, Item 5).</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {badge}
          <Button size="sm" icon="ri-quill-pen-line" disabled={sending} onClick={() => setSending(true)} data-testid="send-onboarding">{agreement.status === "none" ? "Send onboarding documents" : "Send again"}</Button>
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
      {rows === null ? !error && <p className="mt-3 text-sm text-foreground-500">Loading…</p> : rows.length === 0 ? <p className="mt-3 text-sm text-foreground-600">Nothing sent yet.</p>
        : <ul className="mt-3 divide-y divide-background-200 text-sm" data-testid="onboarding-rows">{rows.map((row) => {
          const s = signingStatus(row.request.state);
          const open = ["sent", "viewed", "partial"].includes(row.request.state);
          return <li key={row.id} className="space-y-1.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <button type="button" className="font-medium text-primary-700 underline-offset-2 hover:underline" onClick={() => setOpenId(row.request.id)}>{row.request.reference}</button>
                <span className="ml-2 text-xs text-foreground-500">to {row.agent.name} ({row.agent.email}) · sent {new Date(row.createdAt).toLocaleDateString()} by {row.adminName || "SLIT"}</span>
              </div>
              <span className="flex flex-wrap items-center gap-2"><Badge tone={s.tone}>{s.label}</Badge></span>
            </div>
            <p className="text-xs text-foreground-600">Commencement {formatAuDate(row.commencementDate)} · expires {formatAuDate(row.expiryDate)} · territory {row.territory || "—"} · commission {row.commissionPercent != null ? `${row.commissionPercent}%` : "—"}
              {row.request.reminderCount ? ` · ${row.request.reminderCount} reminder${row.request.reminderCount === 1 ? "" : "s"}${row.request.lastNotifiedAt ? `, last ${new Date(row.request.lastNotifiedAt).toLocaleDateString()}` : ""}` : ""}
              {row.status === "signed" && row.signedAt ? ` · signed ${new Date(row.signedAt).toLocaleDateString()} by ${row.signerName ?? row.agent.name}` : ""}
              {row.status === "closed" ? ` · closed (${row.closedReason ?? "cancelled"})` : ""}</p>
            <div className="flex flex-wrap gap-1.5">
              {open && row.request.recipientId ? <Button size="sm" variant="outline" disabled={busyId === `${row.id}:remind`} onClick={() => void remind(row)}>{busyId === `${row.id}:remind` ? "Sending…" : "Send reminder"}</Button> : null}
              {(["form", "agreement", "certificate"] as OnboardingFileKind[]).filter((k) => row.files[k]).map((k) =>
                <Button key={k} size="sm" variant="ghost" icon="ri-file-pdf-2-line" disabled={busyId === `${row.id}:${k}`} onClick={() => void download(row, k)} data-testid={`download-${k}`}>{ONBOARDING_FILE_LABEL[k]}</Button>)}
            </div>
          </li>; })}</ul>}
    </Card>
    {profile.length ? <Card className="mt-4 p-5" data-testid="agent-profile">
      <h2 className="font-heading text-base font-semibold text-foreground-950">Agent profile</h2>
      <p className="text-sm text-foreground-600">What the agent entered on the application form (prefilled next time).</p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {profile.map(([key, label]) => <div key={key} className="flex gap-2"><dt className="w-44 shrink-0 text-foreground-500">{label}</dt><dd className="min-w-0 break-words text-foreground-900">{(business.profile ?? {})[key]}</dd></div>)}
      </dl>
    </Card> : null}
    {sending ? <SendOnboardingDialog agencyId={business.id} agencyName={business.name} onClose={() => setSending(false)} onSent={async (message) => { setSending(false); push(message); await refresh(); }} /> : null}
    {openId ? <RequestDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => void refresh()} /> : null}
  </>;
}

type SignatureMethod = "saved" | "drawn" | "typed";
/** The send dialog: who signs for the business, the agreement's Items 3 to 5 (commencement, territory, commission) and the SLIT signatory. */
function SendOnboardingDialog({ agencyId, agencyName, onClose, onSent }: { agencyId: string; agencyName: string; onClose: () => void; onSent: (message: string) => Promise<void> }) {
  const [prepared, setPrepared] = useState<OnboardingPrepared | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(""); const [installing, setInstalling] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [commencement, setCommencement] = useState(todayIso());
  const [territory, setTerritory] = useState(""); const [commission, setCommission] = useState("");
  const [adminName, setAdminName] = useState(""); const [adminPosition, setAdminPosition] = useState(""); const [witness, setWitness] = useState("");
  const [method, setMethod] = useState<SignatureMethod>("typed"); const [png, setPng] = useState<string | null>(null); const [save, setSave] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    prepareOnboarding(agencyId).then((p) => {
      if (!live) return;
      setPrepared(p); setAgentId(p.agent?.id ?? "");
      setAdminName(p.admin.name); setAdminPosition(p.admin.position);
      setMethod(p.admin.signaturePng ? "saved" : "typed");
      setTerritory(p.agency.profile.agent_territory ?? ""); setCommission(p.agency.profile.agent_commission_percent ?? "");
    }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [agencyId]);
  const agent = prepared?.agents.find((a) => a.id === agentId) ?? null;
  const ready = !!prepared && !!agent && /^\d{4}-\d{2}-\d{2}$/.test(commencement) && territory.trim().length > 0 && /^\d{1,3}(\.\d{1,2})?$/.test(commission.trim().replace("%", ""))
    && adminName.trim().length >= 2 && adminPosition.trim().length > 0 && (method === "typed" || (method === "drawn" ? !!png : !!prepared?.admin.signaturePng));
  const send = async () => {
    if (!ready || busy || !agent) return;
    setBusy("Preparing the documents…"); setError("");
    const timer = setTimeout(() => setInstalling(true), 4000);
    try {
      const input: AgentOnboardingSendInput = { agencyId, agentId: agent.id, commencementDate: commencement, territory: territory.trim(), commissionPercent: commission.trim().replace("%", ""), adminName: adminName.trim(),
        adminPosition: adminPosition.trim(), adminWitnessName: witness.trim() || undefined, message: message.trim() || undefined,
        adminSignature: method === "saved" ? { kind: "saved" } : method === "drawn" ? { kind: "drawn", png: png ?? "", save } : { kind: "typed", name: adminName.trim() } };
      const result = await sendAgentOnboarding(input);
      await onSent(result.sent ? `Onboarding documents sent to ${agent.name} (${agent.email}), reference ${result.reference}.` : result.warning ?? "The request was created but not emailed.");
    } catch (e) { setError(e instanceof Error ? e.message : "The documents could not be sent."); }
    finally { clearTimeout(timer); setBusy(""); setInstalling(false); }
  };
  return <Modal open title={`Send onboarding documents: ${agencyName}`} onClose={() => { if (!busy) onClose(); }} width="max-w-2xl"
    footer={<div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="outline" disabled={!!busy} onClick={onClose}>Cancel</Button>
      <Button disabled={!ready || !!busy} onClick={() => void send()} data-testid="send-onboarding-confirm">{busy ? (installing ? "Installing the two blank templates…" : busy) : "Send for signature"}</Button>
    </div>}>
    <div className="space-y-4" data-testid="send-onboarding-dialog">
      <p className="text-sm text-foreground-600">The agent receives one email with a personal signing link to the Agent Application Form and the Agent Agreement in one document. What we already hold is printed; the agent fills in the rest, gives two references, answers the Yes / No questions and signs once.</p>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      {!prepared ? !error && <p className="text-sm">Loading…</p> : <>
        <Field label="Send to" required hint="The business admin agent signs the agreement for the business.">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} data-testid="onboarding-agent">
            <option value="">Choose an agent</option>
            {prepared.agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.email}){a.role === "agency_admin" ? " · business admin" : ""}</option>)}
          </Select>
          {!prepared.agents.length ? <p className="mt-1 text-xs font-medium text-amber-700">This business has no active agent yet. Add its business admin agent on the Agents tab first.</p> : null}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Commencement date (Item 5)" required><TextInput type="date" value={commencement} onChange={(e) => setCommencement(e.target.value)} data-testid="onboarding-commencement" /></Field>
          <Field label="Territory (Item 3)" required><TextInput value={territory} onChange={(e) => setTerritory(e.target.value)} placeholder="e.g. India, Nepal" maxLength={200} data-testid="onboarding-territory" /></Field>
          <Field label="Commission % (Item 4)" required><TextInput inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} placeholder="25" maxLength={6} data-testid="onboarding-commission" /></Field>
        </div>
        <p className="text-xs text-foreground-500">The agreement runs two years from the commencement date; the expiry is recorded on the business when it is signed.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SLIT signatory name" required><TextInput value={adminName} onChange={(e) => setAdminName(e.target.value)} maxLength={150} /></Field>
          <Field label="SLIT signatory position" required><TextInput value={adminPosition} onChange={(e) => setAdminPosition(e.target.value)} maxLength={150} placeholder="e.g. Chief Executive Officer" /></Field>
        </div>
        <div>
          <p className="mb-2 text-label font-medium text-foreground-800">SLIT signature on the agreement</p>
          <div role="tablist" className="mb-3 flex flex-wrap gap-2">{([["saved", "My saved signature"], ["drawn", "Draw"], ["typed", "Type my name"]] as const).filter(([id]) => id !== "saved" || prepared.admin.signaturePng).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => { setMethod(id); setPng(null); }}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium ${method === id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-white"}`}>{label}</button>)}</div>
          {method === "saved" && prepared.admin.signaturePng ? <img src={`data:image/png;base64,${prepared.admin.signaturePng}`} alt="Your saved signature" className="max-h-20 rounded border border-background-300 bg-white p-1" /> : null}
          {method === "drawn" ? <div className="space-y-2"><SignaturePad onChange={setPng} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="h-4 w-4" />Save as my signature for next time</label></div> : null}
          {method === "typed" ? <p className="min-h-14 rounded-md border border-background-300 bg-background-50 px-4 py-3 text-2xl italic text-[#0d1a4d]">{adminName || "Your name appears here as the signature"}</p> : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SLIT witness name" hint="Optional; printed as the witness on the agreement."><TextInput value={witness} onChange={(e) => setWitness(e.target.value)} maxLength={150} /></Field>
          <Field label="Message to the agent" hint="Optional; goes in the email."><TextArea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} /></Field>
        </div>
      </>}
    </div>
  </Modal>;
}
