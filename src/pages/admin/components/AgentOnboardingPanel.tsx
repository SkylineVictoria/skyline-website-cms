import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import RequestDetail from "@/pages/admin/components/signing/RequestDetail";
import SignaturePad from "@/components/signing/SignaturePad";
import { useToast } from "@/pages/admin/components/toastContext";
import { changeReferee, rejectOnboarding, sendAgentAgreement, sendAgentApplication, sendRefereeChecks, signingAction, signingStatus, uploadRefereeForm, type AgentAgreementSendInput } from "@/lib/signingApi";
import { ACTIVE_STAGES, approveReferences, EVENT_LABEL, formatAuDate, listOnboarding, openOnboardingFile, prepareOnboarding, PROFILE_LABELS, REFEREE_LABELS, stageWords, todayIso, ONBOARDING_FILE_LABEL,
  type OnboardingFileKind, type OnboardingPrepared, type OnboardingReferee, type OnboardingRow, type OnboardingStage, type RequestSummary } from "@/pages/admin/lib/agentOnboarding";
import type { BusinessDetail } from "@/pages/admin/lib/businessData";
import { AGENT_ONBOARDING_FIELDS, OMARA_REGISTER_URL } from "../../../../supabase/functions/_shared/agent-onboarding";
import { abrFactLines, type AbrFacts } from "../../../../supabase/functions/_shared/validation/abr";

/**
 * Businesses > {name}: agent onboarding in stages. The application form (F04) goes to the agent; when signed, a referee check (F05) goes
 * to each referee it names; at References received (or earlier with a typed reason) the agreement (P06). Each document's status and
 * signed copy, each referee's request (reminder, change of email, a signed form received by email), the override and the history.
 */
export default function AgentOnboardingPanel({ business, onChanged, startSignal = 0 }: { business: BusinessDetail; onChanged: () => Promise<void>; startSignal?: number }) {
  const { push } = useToast();
  const [rows, setRows] = useState<OnboardingRow[] | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"application" | "agreement" | "review" | null>(null);
  useEffect(() => { if (startSignal) setDialog("application"); }, [startSignal]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [changing, setChanging] = useState<OnboardingReferee | null>(null);
  const [history, setHistory] = useState(false);
  const load = useCallback(async () => {
    try { setRows((await listOnboarding(business.id)).filter((r) => r.kind !== "agent")); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "We could not load the onboarding documents."); }
  }, [business.id]);
  useEffect(() => { void load(); }, [load]);
  const refresh = async () => { await load(); await onChanged(); };
  const act = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    try { push(await work()); await refresh(); } catch (e) { push(e instanceof Error ? e.message : "That did not work.", "error"); } finally { setBusy(""); }
  };
  const download = (row: OnboardingRow, kind: OnboardingFileKind, label: string) => act(`${row.id}:${kind}`, async () => { await openOnboardingFile(row.id, kind); return `${label} opened.`; });
  const remind = (request: RequestSummary, who: string) => act(`remind:${request.id}`, async () => {
    if (!request.recipientId) throw new Error("Nobody to remind.");
    await signingAction({ action: "resend", id: request.id, recipientId: request.recipientId }); return `Reminder sent to ${who}.`;
  });
  const current = rows?.find((r) => ACTIVE_STAGES.includes(r.stage)) ?? null;
  const latest = current ?? rows?.[0] ?? null;
  const received = latest ? latest.referees.filter((r) => r.status === "received").length : 0;
  const agreement = business.agreement ?? { status: "none" as const, commencementDate: null, expiryDate: null, onboardingId: null };
  const badge = business.onboarding?.readyToActivate ? <Badge tone="success">Ready to activate</Badge>
    : agreement.status === "signed" && !business.agreement?.expired ? <Badge tone="success">Agreement signed</Badge>
    : agreement.status === "signed" ? <Badge tone="warn">Agreement expired</Badge>
    : current ? <Badge tone="warn">{stageWords(current.stage, received, current.referees.length)}</Badge>
    : latest?.stage === "declined" ? <Badge tone="warn">Declined</Badge> : <Badge tone="muted">Not started</Badge>;
  const profile = PROFILE_LABELS.filter(([key]) => (business.profile ?? {})[key]);
  // The register's facts kept when the application form was sent (or first opened): read-only.
  const abrFacts = abrFactLines(((business.profile ?? {}) as Record<string, unknown>).abr_facts as Partial<AbrFacts> | null);
  return <>
    <Card className="p-5" data-testid="agent-onboarding-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-semibold text-foreground-950">Agent onboarding documents</h2>
          <p className="text-sm text-foreground-600">Once per business, with its point of contact: the application form is emailed when the business is added; when it is signed, a referee check goes to each referee named on it; after staff approve the references the agreement follows; once it is signed an administrator activates the business. Agents added to the business never receive these documents.</p>
          {agreement.status === "signed" && agreement.commencementDate ? <p className="mt-1 text-sm text-foreground-700">Agreement from <strong>{formatAuDate(agreement.commencementDate)}</strong> to <strong>{formatAuDate(agreement.expiryDate)}</strong> (two years, Item 5).</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {badge}
          {!current ? <Button size="sm" icon="ri-quill-pen-line" disabled={!!busy} onClick={() => setDialog("application")} data-testid="start-onboarding">{rows?.length ? "Start again" : "Send application form"}</Button> : null}
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
      {rows === null ? !error && <p className="mt-3 text-sm text-foreground-500">Loading…</p> : null}
      {current ? <StagedOnboarding row={current} busy={busy} onOpen={setOpenId} onRemind={remind} onDownload={download} onSendAgreement={() => setDialog("agreement")} onReview={() => setDialog("review")}
        onSendReferees={() => act("referees", async () => { const r = await sendRefereeChecks(current.id); return r.sent ? `Referee check${r.sent === 1 ? "" : "s"} sent (${r.sent}).` : "Nothing to send: every referee has a request or is received."; })}
        onChangeReferee={setChanging} onUpload={(referee, file) => act(`upload:${referee.id}`, async () => { const r = await uploadRefereeForm(referee.id, file); return `Reference ${referee.position} marked as received (${r.stage === "references_received" ? "both references are in" : "waiting for the other"}).`; })} /> : null}
      {rows && rows.filter((r) => r !== current).length ? <details className="mt-4" open={!current}>
        <summary className="cursor-pointer text-sm font-medium text-foreground-700">Earlier onboarding{rows.filter((r) => r !== current).length === 1 ? "" : "s"}</summary>
        <ul className="mt-2 divide-y divide-background-200 text-sm" data-testid="onboarding-rows">{rows.filter((r) => r !== current).map((row) => <li key={row.id} className="py-3">
          {row.stage === "legacy" ? <LegacyRow row={row} busy={busy} onOpen={setOpenId} onRemind={remind} onDownload={download} />
            : <StagedOnboarding row={row} busy={busy} compact onOpen={setOpenId} onRemind={remind} onDownload={download} onSendAgreement={() => undefined} onReview={() => undefined} onSendReferees={() => undefined} onChangeReferee={() => undefined} onUpload={() => undefined} />}
        </li>)}</ul>
      </details> : null}
      {latest && latest.events.length ? <div className="mt-4">
        <button type="button" className="text-sm font-medium text-primary-700 underline-offset-2 hover:underline" onClick={() => setHistory((h) => !h)} data-testid="onboarding-history">{history ? "Hide history" : `History (${latest.events.length})`}</button>
        {history ? <ol className="mt-2 space-y-1 text-xs text-foreground-700" data-testid="onboarding-events">{[...latest.events].reverse().map((e) => <li key={e.id}>
          <span className="tabular-nums text-foreground-500">{new Date(e.at).toLocaleString()}</span> · <span className="font-medium">{EVENT_LABEL[e.event] ?? e.event.replaceAll("_", " ")}</span>
          {e.actor ? ` · ${e.actor}` : ""}{detailWords(e.event, e.detail)}</li>)}</ol> : null}
      </div> : null}
    </Card>
    {profile.length ? <Card className="mt-4 p-5" data-testid="agent-profile">
      <h2 className="font-heading text-base font-semibold text-foreground-950">Agent profile</h2>
      <p className="text-sm text-foreground-600">What the agent entered on the application form (prefilled next time).</p>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {profile.map(([key, label]) => <div key={key} className="flex gap-2"><dt className="w-44 shrink-0 text-foreground-500">{label}</dt><dd className="min-w-0 break-words text-foreground-900">{(business.profile ?? {})[key]}
          {/* The MARN is checked by hand on the OMARA public register (no automated lookup). */}
          {key === "agent_marn" ? <a href={OMARA_REGISTER_URL} target="_blank" rel="noreferrer" className="ml-2 text-xs font-medium text-primary-700 underline underline-offset-2" data-testid="marn-register-link">Check on the OMARA register</a> : null}</dd></div>)}
      </dl>
      {abrFacts.length ? <div className="mt-4 border-t border-background-200 pt-3" data-testid="agent-abr-facts">
        <p className="text-xs font-medium uppercase tracking-wide text-foreground-500">Australian Business Register</p>
        <dl className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">{abrFacts.map((f) => <div key={f.label}><dt className="text-xs text-foreground-500">{f.label}</dt><dd className="text-foreground-900">{f.value}</dd></div>)}</dl>
      </div> : null}
    </Card> : null}
    {dialog === "application" ? <SendApplicationDialog agencyId={business.id} agencyName={business.name} onClose={() => setDialog(null)} onSent={async (m) => { setDialog(null); push(m); await refresh(); }} /> : null}
    {dialog === "agreement" && current ? <SendAgreementDialog row={current} agencyId={business.id} agencyName={business.name} onClose={() => setDialog(null)} onSent={async (m) => { setDialog(null); push(m); await refresh(); }} /> : null}
    {dialog === "review" && current ? <ReviewReferencesDialog row={current} busy={busy} onDownload={download} onClose={() => setDialog(null)}
      onApproved={async () => { await load(); await onChanged(); setDialog("agreement"); }}
      onDeclined={async (m) => { setDialog(null); push(m); await refresh(); }} /> : null}
    {changing ? <ChangeRefereeDialog referee={changing} onClose={() => setChanging(null)} onDone={async (m) => { setChanging(null); push(m); await refresh(); }} /> : null}
    {openId ? <RequestDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => void refresh()} /> : null}
  </>;
}

const STEPS: Array<{ label: string; stages: OnboardingStage[] }> = [
  { label: "Application form", stages: ["application_sent"] }, { label: "Referee checks", stages: ["application_signed", "references_pending"] },
  { label: "Staff review", stages: ["references_received"] }, { label: "Agreement", stages: ["references_approved", "agreement_sent"] }, { label: "Ready to activate", stages: ["agreement_signed"] },
];
function stepIndex(stage: OnboardingStage, steps = STEPS) { const i = steps.findIndex((s) => s.stages.includes(stage)); return i < 0 ? -1 : i; }
/** A prefilled F04 field in words (the registry label), for the history. */
const prefillLabel = (key: string) => (Object.entries(AGENT_ONBOARDING_FIELDS).find(([k]) => k.replace(/_(form|referee)$/, "").replace(/:.*$/, "") === key && AGENT_ONBOARDING_FIELDS[k].doc === "form")?.[1].label ?? key).replace(/: (Yes|No)$/, "");
function detailWords(event: string, detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.request === "string") parts.push(detail.request);
  if (typeof detail.position === "number") parts.push(`reference ${detail.position}`);
  if (typeof detail.email === "string") parts.push(String(detail.email));
  if (event === "referee_email_changed") parts.push(`${String(detail.from ?? "")} → ${String(detail.to ?? "")}`);
  if (event === "override" || event === "declined") parts.push(`reason: ${String(detail.reason ?? "")}`);
  if (event === "references_received" || event === "references_approved") parts.push(`${String(detail.received ?? "")} of ${String(detail.total ?? "")}`);
  if (event === "activated") parts.push(detail.invitation ? "set-password email" : detail.login ? "already signs in" : "no invitation");
  if (event === "agreement_uploaded") parts.push(`${String(detail.file ?? "")} · reason: ${String(detail.reason ?? "")}`);
  if (event === "application_prefilled" && Array.isArray(detail.fields)) parts.push(`${detail.fields.length} field${detail.fields.length === 1 ? "" : "s"}: ${(detail.fields as string[]).map(prefillLabel).join(", ")}`);
  if (event === "prefill_reviewed") {
    const changed = Array.isArray(detail.changed) ? detail.changed as Array<{ field: string; prefilled: string; submitted: string }> : [];
    parts.push(changed.length ? `changed by the contact: ${changed.map((c) => `${prefillLabel(c.field)} "${c.prefilled}" → "${c.submitted}"`).join("; ")}` : "all prefilled values kept");
  }
  if (event === "agreement_sent" && typeof detail.template === "string") parts.push(`template ${detail.template}${detail.version ? ` v${String(detail.version)}` : ""}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}
const openRequest = (r: RequestSummary | null) => !!r && ["sent", "viewed", "partial"].includes(r.state);

function RequestLine({ request, who, busy, onOpen, onRemind, remindLabel = "Send reminder" }: { request: RequestSummary | null; who: string; busy: string; onOpen: (id: string) => void; onRemind: (r: RequestSummary, who: string) => void; remindLabel?: string }) {
  if (!request) return <span className="text-xs text-foreground-500">Not sent</span>;
  const s = signingStatus(request.state);
  return <span className="flex flex-wrap items-center gap-2 text-xs">
    <button type="button" className="font-medium text-primary-700 underline-offset-2 hover:underline" onClick={() => onOpen(request.id)}>{request.reference}</button>
    <Badge tone={s.tone}>{s.label}</Badge>
    {request.reminderCount ? <span className="text-foreground-500">{request.reminderCount} reminder{request.reminderCount === 1 ? "" : "s"}{request.lastNotifiedAt ? `, last ${new Date(request.lastNotifiedAt).toLocaleDateString()}` : ""}</span> : null}
    {openRequest(request) ? <Button size="sm" variant="outline" disabled={busy === `remind:${request.id}`} onClick={() => onRemind(request, who)} data-testid={remindLabel === "Send reminder" ? undefined : "resend-application"}>{remindLabel}</Button> : null}
  </span>;
}

function StagedOnboarding({ row, busy, compact = false, onOpen, onRemind, onDownload, onSendAgreement, onReview, onSendReferees, onChangeReferee, onUpload }: {
  row: OnboardingRow; busy: string; compact?: boolean; onOpen: (id: string) => void; onRemind: (r: RequestSummary, who: string) => void; onDownload: (row: OnboardingRow, kind: OnboardingFileKind, label: string) => void;
  onSendAgreement: () => void; onReview: () => void; onSendReferees: () => void; onChangeReferee: (r: OnboardingReferee) => void; onUpload: (r: OnboardingReferee, file: File) => void;
}) {
  const steps = STEPS;
  // Activated: every step is done (the stage stays agreement_signed; the activation is recorded on the row).
  const index = row.activation ? steps.length : stepIndex(row.stage, steps);
  const received = row.referees.filter((r) => r.status === "received").length;
  // The agreement goes after staff approve the references; before that only with a typed reason (override).
  const canSend = row.stage === "references_approved", canOverride = row.stage === "application_signed" || row.stage === "references_pending" || row.stage === "references_received";
  const closed = row.stage === "cancelled" || row.stage === "expired" || row.stage === "declined";
  const pendingSend = row.referees.some((r) => r.status === "pending" && !r.request) && (row.stage === "application_signed" || row.stage === "references_pending");
  const dl = (kind: OnboardingFileKind, label: string) => <Button key={kind} size="sm" variant="ghost" icon="ri-file-pdf-2-line" disabled={busy === `${row.id}:${kind}`} onClick={() => onDownload(row, kind, label)} data-testid={`download-${kind.replace(/:.*/, "")}`}>{label}</Button>;
  return <div className={compact ? "space-y-2" : "mt-4 space-y-4"} data-testid={compact ? undefined : "onboarding-current"} data-stage={row.stage}>
    <ol className="flex flex-wrap gap-2" aria-label="Onboarding stages" data-testid="onboarding-stepper">{steps.map((step, i) => {
      const state = closed ? "todo" : i < index ? "done" : i === index ? "current" : "todo";
      return <li key={step.label} data-step-state={state} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${state === "done" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : state === "current" ? "border-primary-500 bg-primary-50 font-semibold text-primary-800" : "border-background-300 text-foreground-500"}`}>
        <i className={state === "done" ? "ri-checkbox-circle-fill" : state === "current" ? "ri-radio-button-line" : "ri-checkbox-blank-circle-line"} aria-hidden="true" />{step.label}</li>; })}</ol>
    <p className="text-sm text-foreground-700"><strong>{row.activation ? "Activated" : row.stage === "agreement_signed" ? "Ready to activate" : stageWords(row.stage, received, row.referees.length, "business")}</strong> · to {row.agent.name} ({row.agent.email}) · started {new Date(row.createdAt).toLocaleDateString()}{row.adminName ? ` by ${row.adminName}` : ""}{closed && row.closedReason ? ` · ${row.closedReason}` : ""}</p>
    <div className="space-y-1 rounded-lg border border-background-200 p-3">
      <p className="text-sm font-medium text-foreground-900">1. Agent Application Form (F04)</p>
      <RequestLine request={row.application} who={row.agent.email} busy={busy} onOpen={onOpen} onRemind={onRemind} remindLabel="Resend application" />
      {row.applicationSignedAt ? <p className="text-xs text-foreground-600">Signed {new Date(row.applicationSignedAt).toLocaleDateString()} by {row.signerName ?? row.agent.name}.</p> : null}
      <div className="flex flex-wrap gap-1.5">{row.files.form ? dl("form", ONBOARDING_FILE_LABEL.form) : null}{row.files.application_certificate ? dl("application_certificate", ONBOARDING_FILE_LABEL.application_certificate) : null}</div>
    </div>
    <div className="space-y-2 rounded-lg border border-background-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground-900">2. Referee checks (F05) · {received} of {row.referees.length || 2} received</p>
        <span className="flex flex-wrap gap-1.5">
          {!compact && pendingSend ? <Button size="sm" variant="outline" disabled={busy === "referees"} onClick={onSendReferees} data-testid="send-referees">Send referee checks</Button> : null}
          {!compact && row.stage === "references_received" ? <Button size="sm" icon="ri-shield-check-line" disabled={!!busy} onClick={onReview} data-testid="review-references">Review references</Button> : null}
        </span>
      </div>
      {row.approval ? <p className="text-xs text-emerald-800" data-testid="approval-note">References approved{row.approval.by ? ` by ${row.approval.by}` : ""} on {new Date(row.approval.at).toLocaleDateString()}.</p> : null}
      {row.decline ? <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900" data-testid="decline-note">Declined{row.decline.by ? ` by ${row.decline.by}` : ""} on {new Date(row.decline.at).toLocaleDateString()} (reason kept for staff): “{row.decline.reason}”. The agent was told politely, without the reason; you can start the onboarding again later.</p> : null}
      {!row.referees.length ? <p className="text-xs text-foreground-500">The referees come from the signed application form.</p> : row.referees.map((ref) => <div key={ref.id} className="rounded-md bg-background-50 p-2" data-testid={`referee-${ref.position}`} data-status={ref.status}>
        <p className="text-sm"><span className="font-medium">Reference {ref.position}: {ref.name || "—"}</span>{ref.organisation ? `, ${ref.organisation}` : ""}{ref.positionTitle ? ` (${ref.positionTitle})` : ""} · {ref.email}
          {ref.domainWarning ? <span className="ml-2 rounded border border-amber-300 bg-amber-50 px-1.5 text-2xs font-medium text-amber-900" title="The referee's email address shares the agency's own domain">Same domain as the agency</span> : null}</p>
        <p className="text-xs text-foreground-600">{ref.status === "received" ? `Received ${ref.receivedAt ? new Date(ref.receivedAt).toLocaleDateString() : ""} (${ref.receivedVia === "upload" ? `uploaded${ref.fileName ? `: ${ref.fileName}` : ""}` : "signed online"})`
          : ref.status === "cancelled" ? "Cancelled" : ref.status === "sent" ? "Waiting for the referee" : "Not sent yet"}</p>
        {ref.request ? <RequestLine request={ref.request} who={ref.email} busy={busy} onOpen={onOpen} onRemind={onRemind} /> : null}
        {ref.status === "received" && Object.keys(ref.answers ?? {}).length ? <dl className="mt-1 grid grid-cols-1 gap-x-4 text-xs sm:grid-cols-2">{REFEREE_LABELS.filter(([k]) => ref.answers[k]).map(([k, label]) => <div key={k} className="flex gap-1"><dt className="text-foreground-500">{label}:</dt><dd className="min-w-0 break-words">{ref.answers[k]}</dd></div>)}</dl> : null}
        <div className="mt-1 flex flex-wrap gap-1.5">
          {ref.files.form ? dl(`referee:${ref.id}`, `Referee check ${ref.position} (${ref.receivedVia === "upload" ? "uploaded" : "signed"})`) : null}
          {ref.files.certificate ? dl(`referee_certificate:${ref.id}`, `Referee check ${ref.position} certificate`) : null}
          {!compact && ref.status !== "received" && !closed ? <>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => onChangeReferee(ref)} data-testid={`change-referee-${ref.position}`}>Change referee email</Button>
            <UploadButton disabled={busy === `upload:${ref.id}`} onFile={(file) => onUpload(ref, file)} position={ref.position} />
          </> : null}
        </div>
      </div>)}
    </div>
    <div className="space-y-1 rounded-lg border border-background-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground-900">3. Agent Agreement (P06)</p>
        {!compact && !row.agreement && !closed ? (canSend
          ? <Button size="sm" icon="ri-quill-pen-line" disabled={!!busy} onClick={onSendAgreement} data-testid="send-agreement">Send agreement</Button>
          : <Button size="sm" variant="outline" icon="ri-alert-line" disabled={!!busy || !canOverride} title={canOverride ? "Needs a typed reason; it is kept on the record" : "Available once the application form is signed"} onClick={onSendAgreement} data-testid="send-agreement-anyway">Send agreement anyway</Button>) : null}
      </div>
      <RequestLine request={row.agreement} who={row.agent.email} busy={busy} onOpen={onOpen} onRemind={onRemind} />
      {!row.activation && row.stage === "agreement_signed" ? <p className="text-xs font-medium text-emerald-800" data-testid="ready-to-activate-note">Signed: the business is ready to activate. Press Activate at the top of the page; the point of contact and every agent added meanwhile then get their sign-in email.</p> : null}
      {row.activation ? <p className="text-xs text-emerald-800" data-testid="activation-note">Business activated on {new Date(row.activation.at).toLocaleDateString()}{row.activation.invitationId ? `; set-password email sent (${row.activation.invitationStatus === "accepted" ? "password set, signed in" : row.activation.invitationStatus === "pending" ? "waiting for the password" : "invitation withdrawn"})` : "; the agent already signs in"}.</p> : null}
      {row.agreement ? <p className="text-xs text-foreground-600">Commencement {formatAuDate(row.commencementDate)} · expires {formatAuDate(row.expiryDate)} · territory {row.territory || "—"} · commission {row.commissionPercent != null ? `${row.commissionPercent}%` : "—"}{row.signedAt && row.stage === "agreement_signed" ? ` · signed ${new Date(row.signedAt).toLocaleDateString()}` : ""}</p> : null}
      {row.override ? <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900" data-testid="override-note">Sent before both references were back{row.override.by ? ` by ${row.override.by}` : ""} on {new Date(row.override.at).toLocaleDateString()}: “{row.override.reason}”</p> : null}
      <div className="flex flex-wrap gap-1.5">{row.files.agreement ? dl("agreement", ONBOARDING_FILE_LABEL.agreement) : null}{row.files.certificate ? dl("certificate", ONBOARDING_FILE_LABEL.certificate) : null}</div>
    </div>
  </div>;
}

function UploadButton({ disabled, onFile, position }: { disabled: boolean; onFile: (file: File) => void; position: number }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <Button size="sm" variant="outline" icon="ri-upload-2-line" disabled={disabled} onClick={() => input.current?.click()} data-testid={`upload-referee-${position}`}>{disabled ? "Uploading…" : "Upload signed form"}</Button>
    <input ref={input} type="file" accept=".pdf,application/pdf" className="hidden" aria-label={`Signed referee check ${position}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
  </>;
}

/** A legacy onboarding (the first version: both documents in one request). */
function LegacyRow({ row, busy, onOpen, onRemind, onDownload }: { row: OnboardingRow; busy: string; onOpen: (id: string) => void; onRemind: (r: RequestSummary, who: string) => void; onDownload: (row: OnboardingRow, kind: OnboardingFileKind, label: string) => void }) {
  return <div className="space-y-1.5" data-testid="onboarding-legacy">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-foreground-500">Sent as one document (application form + agreement) to {row.agent.name} ({row.agent.email}) · {new Date(row.createdAt).toLocaleDateString()} by {row.adminName || "SLIT"}</span>
      <RequestLine request={row.request} who={row.agent.email} busy={busy} onOpen={onOpen} onRemind={onRemind} />
    </div>
    <p className="text-xs text-foreground-600">Commencement {formatAuDate(row.commencementDate)} · expires {formatAuDate(row.expiryDate)} · territory {row.territory || "—"} · commission {row.commissionPercent != null ? `${row.commissionPercent}%` : "—"}
      {row.status === "signed" && row.signedAt ? ` · signed ${new Date(row.signedAt).toLocaleDateString()} by ${row.signerName ?? row.agent.name}` : ""}{row.status === "closed" ? ` · closed (${row.closedReason ?? "cancelled"})` : ""}</p>
    <div className="flex flex-wrap gap-1.5">{(["form", "agreement", "certificate"] as const).filter((k) => row.files[k]).map((k) =>
      <Button key={k} size="sm" variant="ghost" icon="ri-file-pdf-2-line" disabled={busy === `${row.id}:${k}`} onClick={() => onDownload(row, k, ONBOARDING_FILE_LABEL[k])} data-testid={`download-${k}`}>{ONBOARDING_FILE_LABEL[k]}</Button>)}</div>
  </div>;
}

function SendApplicationDialog({ agencyId, agencyName, onClose, onSent }: { agencyId: string; agencyName: string; onClose: () => void; onSent: (message: string) => Promise<void> }) {
  const [prepared, setPrepared] = useState<OnboardingPrepared | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    prepareOnboarding(agencyId).then((p) => { if (live) { setPrepared(p); setAgentId(p.agent?.id ?? ""); } }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [agencyId]);
  const agent = prepared?.agents.find((a) => a.id === agentId) ?? null;
  const send = async () => {
    if (!agent || busy) return;
    setBusy(true); setError("");
    try { const r = await sendAgentApplication({ agencyId, agentId: agent.id, message: message.trim() || undefined }); await onSent(r.sent ? `Application form sent to ${agent.name} (${agent.email}), reference ${r.reference}.` : r.warning ?? "The request was created but not emailed."); }
    catch (e) { setError(e instanceof Error ? e.message : "The form could not be sent."); } finally { setBusy(false); }
  };
  return <Modal open title={`Start onboarding: ${agencyName}`} onClose={() => { if (!busy) onClose(); }} width="max-w-xl"
    footer={<div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={!agent || busy} onClick={() => void send()} data-testid="send-application-confirm">{busy ? "Preparing the form…" : "Send application form"}</Button></div>}>
    <div className="space-y-4" data-testid="send-application-dialog">
      <p className="text-sm text-foreground-600">The agent receives the Agent Application Form (F04) with a personal signing link. What we already hold is printed; the agent fills in the rest, names two referees and signs. The referee checks go out by themselves once the form is signed; the agreement is sent from here afterwards.</p>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      {!prepared ? !error && <p className="text-sm">Loading…</p> : <>
        <Field label="Send to" required hint="The business admin agent signs for the business.">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} data-testid="onboarding-agent">
            <option value="">Choose an agent</option>
            {prepared.agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.email}){a.role === "agency_admin" ? " · business admin" : ""}</option>)}
          </Select>
          {!prepared.agents.length ? <p className="mt-1 text-xs font-medium text-amber-700">This business has no point of contact to send the form to. Add business creates one; contact SLIT IT if it is missing.</p> : null}
        </Field>
        <Field label="Message to the agent" hint="Optional; goes in the email."><TextArea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} /></Field>
      </>}
    </div>
  </Modal>;
}

type SignatureMethod = "saved" | "drawn" | "typed";
/** Send agreement: Items 3 to 5 and the SLIT signatory; before References received a typed reason is required and kept on the record. */
function SendAgreementDialog({ row, agencyId, agencyName, onClose, onSent }: { row: OnboardingRow; agencyId: string; agencyName: string; onClose: () => void; onSent: (message: string) => Promise<void> }) {
  const [prepared, setPrepared] = useState<OnboardingPrepared | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const [commencement, setCommencement] = useState(todayIso());
  const [territory, setTerritory] = useState(""); const [commission, setCommission] = useState("");
  const [adminName, setAdminName] = useState(""); const [adminPosition, setAdminPosition] = useState(""); const [witness, setWitness] = useState("");
  const [method, setMethod] = useState<SignatureMethod>("typed"); const [png, setPng] = useState<string | null>(null); const [save, setSave] = useState(true);
  const [message, setMessage] = useState(""); const [reason, setReason] = useState("");
  const override = row.stage !== "references_approved";
  const received = row.referees.filter((r) => r.status === "received").length;
  useEffect(() => {
    let live = true;
    prepareOnboarding(agencyId, row.agent.id).then((p) => {
      if (!live) return;
      setPrepared(p); setAdminName(p.admin.name); setAdminPosition(p.admin.position); setMethod(p.admin.signaturePng ? "saved" : "typed");
      setTerritory(p.agency.profile.agent_territory ?? ""); setCommission(p.agency.profile.agent_commission_percent ?? "");
    }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [agencyId, row.agent.id]);
  const ready = !!prepared && /^\d{4}-\d{2}-\d{2}$/.test(commencement) && territory.trim().length > 0 && /^\d{1,3}(\.\d{1,2})?$/.test(commission.trim().replace("%", ""))
    && adminName.trim().length >= 2 && adminPosition.trim().length > 0 && (method === "typed" || (method === "drawn" ? !!png : !!prepared?.admin.signaturePng)) && (!override || reason.trim().length >= 5);
  const send = async () => {
    if (!ready || busy) return;
    setBusy("Preparing the agreement…"); setError("");
    try {
      const input: AgentAgreementSendInput = { agencyId, onboardingId: row.id, agentId: row.agent.id, commencementDate: commencement, territory: territory.trim(), commissionPercent: commission.trim().replace("%", ""),
        adminName: adminName.trim(), adminPosition: adminPosition.trim(), adminWitnessName: witness.trim() || undefined, message: message.trim() || undefined, overrideReason: override ? reason.trim() : undefined,
        adminSignature: method === "saved" ? { kind: "saved" } : method === "drawn" ? { kind: "drawn", png: png ?? "", save } : { kind: "typed", name: adminName.trim() } };
      const r = await sendAgentAgreement(input);
      await onSent(r.sent ? `Agreement sent to ${row.agent.name} (${row.agent.email}), reference ${r.reference}${r.override ? " (sent before both references were back; the reason is on the record)" : ""}.` : r.warning ?? "The request was created but not emailed.");
    } catch (e) { setError(e instanceof Error ? e.message : "The agreement could not be sent."); } finally { setBusy(""); }
  };
  return <Modal open title={`${override ? "Send agreement anyway" : "Send agreement"}: ${agencyName}`} onClose={() => { if (!busy) onClose(); }} width="max-w-2xl"
    footer={<div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="outline" disabled={!!busy} onClick={onClose}>Cancel</Button>
      <Button disabled={!ready || !!busy} onClick={() => void send()} data-testid="send-agreement-confirm">{busy || (override ? "Send agreement anyway" : "Send agreement for signature")}</Button>
    </div>}>
    <div className="space-y-4" data-testid="send-agreement-dialog">
      <p className="text-sm text-foreground-600">The agent receives the Agent Agreement (P06) with a personal signing link, prefilled with Items 1 to 4 and the signatory from the application form.</p>
      {override ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
        <p className="font-medium">{row.stage === "references_received" ? "Both references are back but not approved yet." : `Only ${received} of ${row.referees.length || 2} references ${received === 1 ? "is" : "are"} back.`} Sending now is logged on the record with your reason.</p>
        <Field label="Reason" required><TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Referee confirmed by phone on 17 Nov" data-testid="override-reason" /></Field>
      </div> : null}
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      {!prepared ? !error && <p className="text-sm">Loading…</p> : <>
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

/** Review references (2026-11-17): both signed referee checks, then Approve (the Send agreement dialog opens) or Reject with a reason kept for staff. */
function ReviewReferencesDialog({ row, busy, onDownload, onClose, onApproved, onDeclined }: {
  row: OnboardingRow; busy: string; onDownload: (row: OnboardingRow, kind: OnboardingFileKind, label: string) => void; onClose: () => void; onApproved: () => Promise<void>; onDeclined: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"review" | "reject">("review");
  const [reason, setReason] = useState(""); const [working, setWorking] = useState(""); const [error, setError] = useState("");
  const approve = async () => {
    if (working) return;
    setWorking("Approving…"); setError("");
    try { await approveReferences(row.id); await onApproved(); } catch (e) { setError(e instanceof Error ? e.message : "The references could not be approved."); setWorking(""); }
  };
  const reject = async () => {
    if (working || reason.trim().length < 5) return;
    setWorking("Declining…"); setError("");
    try { const r = await rejectOnboarding({ onboardingId: row.id, reason: reason.trim() }); await onDeclined(`Onboarding declined. ${r.emailed ? `${r.agent.name} was told politely (without the reason).` : "The agent could not be emailed; tell them yourself."}`); }
    catch (e) { setError(e instanceof Error ? e.message : "The onboarding could not be declined."); setWorking(""); }
  };
  return <Modal open title={`Review references: ${row.agent.name}`} onClose={() => { if (!working) onClose(); }} width="max-w-2xl"
    footer={<div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="outline" disabled={!!working} onClick={onClose}>Cancel</Button>
      {mode === "review" ? <>
        <Button variant="outline" icon="ri-close-circle-line" disabled={!!working} onClick={() => setMode("reject")} data-testid="reject-references">Reject…</Button>
        <Button icon="ri-check-line" disabled={!!working} onClick={() => void approve()} data-testid="approve-references">{working || "Approve and send the agreement"}</Button>
      </> : <Button variant="outline" icon="ri-close-circle-line" disabled={!!working || reason.trim().length < 5} onClick={() => void reject()} data-testid="reject-confirm">{working || "Decline this onboarding"}</Button>}
    </div>}>
    <div className="space-y-4" data-testid="review-references-dialog">
      <p className="text-sm text-foreground-600">Both referee checks for {row.agent.name} ({row.agent.email}) are in. Read them, then approve (the Send agreement dialog opens) or reject. Your decision and the time are kept on the record.</p>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      {row.referees.map((ref) => <div key={ref.id} className="rounded-md border border-background-200 p-3" data-testid={`review-referee-${ref.position}`}>
        <p className="text-sm font-medium text-foreground-900">Reference {ref.position}: {ref.name || "—"}{ref.organisation ? `, ${ref.organisation}` : ""}{ref.positionTitle ? ` (${ref.positionTitle})` : ""} · {ref.email}</p>
        <p className="text-xs text-foreground-600">{ref.status === "received" ? `Received ${ref.receivedAt ? new Date(ref.receivedAt).toLocaleDateString() : ""} (${ref.receivedVia === "upload" ? "uploaded by staff" : "signed online"})` : ref.status}{ref.domainWarning ? " · same email domain as the agency" : ""}</p>
        {Object.keys(ref.answers ?? {}).length ? <dl className="mt-1 grid grid-cols-1 gap-x-4 text-xs sm:grid-cols-2">{REFEREE_LABELS.filter(([k]) => ref.answers[k]).map(([k, label]) => <div key={k} className="flex gap-1"><dt className="text-foreground-500">{label}:</dt><dd className="min-w-0 break-words">{ref.answers[k]}</dd></div>)}</dl> : null}
        <div className="mt-1 flex flex-wrap gap-1.5">
          {ref.files.form ? <Button size="sm" variant="ghost" icon="ri-file-pdf-2-line" disabled={busy === `${row.id}:referee:${ref.id}`} onClick={() => onDownload(row, `referee:${ref.id}`, `Referee check ${ref.position}`)}>Open signed referee check {ref.position}</Button> : null}
          {ref.files.certificate ? <Button size="sm" variant="ghost" icon="ri-file-pdf-2-line" disabled={busy === `${row.id}:referee_certificate:${ref.id}`} onClick={() => onDownload(row, `referee_certificate:${ref.id}`, `Referee check ${ref.position} certificate`)}>Certificate</Button> : null}
        </div>
      </div>)}
      {mode === "reject" ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="reject-form">
        <p className="font-medium">Declining closes this onboarding: its open requests are voided, the agent gets a polite email without your reason, and nobody from the business can sign in. You can start the onboarding again later.</p>
        <Field label="Reason (kept for staff only)" required><TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="e.g. Referee 2 could not confirm the agency's work" data-testid="reject-reason" /></Field>
      </div> : null}
    </div>
  </Modal>;
}

function ChangeRefereeDialog({ referee, onClose, onDone }: { referee: OnboardingReferee; onClose: () => void; onDone: (message: string) => Promise<void> }) {
  const [email, setEmail] = useState(referee.email); const [name, setName] = useState(referee.name);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const valid = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(email.trim()) && (email.trim().toLowerCase() !== referee.email.toLowerCase() || name.trim() !== referee.name);
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try { const r = await changeReferee({ refereeId: referee.id, email: email.trim(), name: name.trim() || undefined }); await onDone(`Reference ${referee.position} updated: a new referee check ${r.sent ? "was sent" : "will be sent"} to ${r.email}.`); }
    catch (e) { setError(e instanceof Error ? e.message : "The referee could not be changed."); } finally { setBusy(false); }
  };
  return <Modal open title={`Change reference ${referee.position}`} onClose={() => { if (!busy) onClose(); }}
    footer={<div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={!valid || busy} onClick={() => void submit()} data-testid="change-referee-confirm">{busy ? "Sending…" : "Save and send new check"}</Button></div>}>
    <div className="space-y-3" data-testid="change-referee-dialog">
      <p className="text-sm text-foreground-600">The referee check already sent is cancelled (its link stops working) and a new one goes to the address below. This is kept in the history.</p>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      <Field label="Referee name"><TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={150} /></Field>
      <Field label="Referee email" required><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} data-testid="referee-email" /></Field>
    </div>
  </Modal>;
}
