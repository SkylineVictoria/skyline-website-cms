import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import RequestDetail from "@/pages/admin/components/signing/RequestDetail";
import SignaturePad from "@/components/signing/SignaturePad";
import { useToast } from "@/pages/admin/components/toastContext";
import { approveAgency, changeReferee, rejectOnboarding, sendAgentAgreement, sendRefereeChecks, signingAction, signingStatus, uploadRefereeForm, type AgentAgreementSendInput } from "@/lib/signingApi";
import F04ReviewDialog from "@/pages/admin/components/F04ReviewDialog";
import F04PresendDialog from "@/pages/admin/components/F04PresendDialog";
import { OnboardingStatusPill } from "@/pages/admin/components/AgencyStatus";
import { ACTIVE_STAGES, EVENT_LABEL, openRevisionFile, type OnboardingCorrection, type OnboardingRevision, formatAuDate, listOnboarding, openOnboardingFile, prepareOnboarding, PROFILE_LABELS, REFEREE_LABELS, stageWords, todayIso, ONBOARDING_FILE_LABEL, APPLICATION_ATTACHMENT_LABEL, listApplicationAttachments, openApplicationAttachment, type ApplicationAttachment,
  type OnboardingFileKind, type OnboardingPrepared, type OnboardingReferee, type OnboardingRow, type OnboardingStage, type RequestSummary } from "@/pages/admin/lib/agentOnboarding";
import type { BusinessDetail } from "@/pages/admin/lib/businessData";
import { AGENT_ONBOARDING_FIELDS, OMARA_REGISTER_URL } from "../../../../supabase/functions/_shared/agent-onboarding";
import { abrFactLines, type AbrFacts } from "../../../../supabase/functions/_shared/validation/abr";

/**
 * Businesses > {name}: agent onboarding in stages. The application form (F04) goes to the agent; when signed, a referee check (F05) goes
 * to each referee it names; at References received (or earlier with a typed reason) the agreement (P06). Each document's status and
 * signed copy, each referee's request (reminder, change of email, a signed form received by email), the override and the history.
 */
export default function AgentOnboardingPanel({ business, onChanged }: { business: BusinessDetail; onChanged: () => Promise<void> }) {
  const { push } = useToast();
  const [rows, setRows] = useState<OnboardingRow[] | null>(null);
  const [error, setError] = useState("");
  // Prepare application (2026-11-20) opens by itself after Add business (?prepare=1 on the business page).
  const [dialog, setDialog] = useState<"agreement" | "approve" | "review" | "decline" | "presend" | null>(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("prepare") === "1" ? "presend" : null);
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
    : latest?.label ? <OnboardingStatusPill label={latest.label} />
    : agreement.status === "signed" && !business.agreement?.expired ? <Badge tone="success">Agreement signed</Badge>
    : agreement.status === "signed" ? <Badge tone="warn">Agreement expired</Badge>
    : <Badge tone="muted">Not started</Badge>;
  // Resend link (2026-11-18): the application form goes by itself when the business is added; this re-sends the open link (the form or a
  // correction), or sends a fresh form to the point of contact when there is no onboarding in progress (a failed first send, a closed one).
  const openForm = current && openRequest(current.application) ? current.application : null;
  // 2026-11-20: a new application is always prepared first (Prepare application: the pre-send step); Resend link only re-sends an open one.
  const resendLink = () => act("resend-link", async () => {
    if (openForm?.recipientId) { await signingAction({ action: "resend", id: openForm.id, recipientId: openForm.recipientId }); return `Link sent again to ${current!.agent.email}.`; }
    throw new Error("Nothing to resend: prepare the application and send it.");
  });
  const draft = current?.stage === "draft" ? current : null;
  const canPrepare = !!rows && (!current || !!draft) && !business.onboarding?.readyToActivate;
  const closePresend = () => {
    setDialog(null);
    if (new URLSearchParams(window.location.search).has("prepare")) { const url = new URL(window.location.href); url.searchParams.delete("prepare"); window.history.replaceState(window.history.state, "", url.toString()); }
  };
  const statusLine = current ? statusWords(current) : latest ? `${STAGE_LABEL_SHORT[latest.stage] ?? latest.stage}${latest.closedReason ? ` (${latest.closedReason})` : ""}.` : "No application form has been sent yet.";
  const profile = PROFILE_LABELS.filter(([key]) => (business.profile ?? {})[key]);
  // The register's facts kept when the application form was sent (or first opened): read-only.
  const abrFacts = abrFactLines(((business.profile ?? {}) as Record<string, unknown>).abr_facts as Partial<AbrFacts> | null);
  return <>
    <Card className="p-5" data-testid="agent-onboarding-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-base font-semibold text-foreground-950">Agent onboarding</h2>
          <p className="text-sm text-foreground-600">Once per business with its agency admin. You prepare the application (business details, the agreement's terms, optionally the witness) and send it; the agency admin signs the application form and the agent agreement once. Both referees get a referee check at once, but you do not wait for them: review the application (edit, send back for correction, or approve). Approving activates the business, countersigns and issues the signed agreement, and sends the sign-in emails.</p>
          <p className="mt-1 text-sm font-medium text-foreground-900" data-testid="onboarding-status-line">{statusLine}</p>
          {agreement.status === "signed" && agreement.commencementDate ? <p className="mt-1 text-sm text-foreground-700">Agreement from <strong>{formatAuDate(agreement.commencementDate)}</strong> to <strong>{formatAuDate(agreement.expiryDate)}</strong> (two years, Item 5).</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {badge}
          {rows && openForm && !business.onboarding?.readyToActivate ? <Button size="sm" variant="outline" icon="ri-mail-send-line" disabled={!!busy} onClick={() => void resendLink()} data-testid="resend-link">{busy === "resend-link" ? "Sending…" : "Resend link"}</Button> : null}
          {canPrepare ? <Button size="sm" icon="ri-edit-box-line" disabled={!!busy} onClick={() => setDialog("presend")} data-testid="prepare-application">{draft ? "Continue preparing" : "Prepare application"}</Button> : null}
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
      {rows === null ? !error && <p className="mt-3 text-sm text-foreground-500">Loading…</p> : null}
      {draft ? <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="onboarding-draft">
        <p className="font-medium">Not sent yet: nothing has been emailed to {draft.agent.name} ({draft.agent.email}).</p>
        <p className="mt-1">Prepare the application: check and fill in the business details, set the agreement's terms and, if you like, add the SLIT witness (the agency admin adds their own witness when signing). Then send it to the point of contact to sign once (application form and agreement together).
          {draft.presendSavedAt ? ` Draft saved ${new Date(draft.presendSavedAt).toLocaleString()}.` : ""}</p>
      </div> : null}
      {current && !draft ? <StagedOnboarding row={current} busy={busy} onOpen={setOpenId} onRemind={remind} onDownload={download} onSendAgreement={() => setDialog("agreement")} onReview={() => setDialog("review")} onDecline={() => setDialog("decline")}
        onSendReferees={() => act("referees", async () => { const r = await sendRefereeChecks(current.id); return r.sent ? `Referee check${r.sent === 1 ? "" : "s"} sent (${r.sent}).` : "Nothing to send: every referee has a request or is received."; })}
        onChangeReferee={setChanging} onUpload={(referee, file) => act(`upload:${referee.id}`, async () => { const r = await uploadRefereeForm(referee.id, file); return `Reference ${referee.position} marked as received (${r.stage === "references_received" ? "both references are in" : "waiting for the other"}).`; })} /> : null}
      {rows && rows.filter((r) => r !== current).length ? <details className="mt-4" open={!current}>
        <summary className="cursor-pointer text-sm font-medium text-foreground-700">Earlier onboarding{rows.filter((r) => r !== current).length === 1 ? "" : "s"}</summary>
        <ul className="mt-2 divide-y divide-background-200 text-sm" data-testid="onboarding-rows">{rows.filter((r) => r !== current).map((row) => <li key={row.id} className="py-3">
          {row.stage === "legacy" ? <LegacyRow row={row} busy={busy} onOpen={setOpenId} onRemind={remind} onDownload={download} />
            : <StagedOnboarding row={row} busy={busy} compact onOpen={setOpenId} onRemind={remind} onDownload={download} onSendAgreement={() => undefined} onReview={() => undefined} onDecline={() => undefined} onSendReferees={() => undefined} onChangeReferee={() => undefined} onUpload={() => undefined} />}
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
    {(dialog === "agreement" || dialog === "approve") && current ? <SendAgreementDialog row={current} agencyId={business.id} agencyName={business.name} approve={dialog === "approve" || !!current.combined} onClose={() => setDialog(null)} onSent={async (m) => { setDialog(null); push(m); await refresh(); }} /> : null}
    {dialog === "review" && current ? <F04ReviewDialog onboardingId={current.id} agencyName={business.name} onClose={() => { setDialog(null); void refresh(); }}
      onDone={async (m) => { setDialog(null); push(m); await refresh(); }} onApprove={() => setDialog("approve")} /> : null}
    {dialog === "presend" && canPrepare ? <F04PresendDialog agencyId={business.id} agencyName={business.name} onClose={() => { closePresend(); void refresh(); }}
      onSent={async (m) => { closePresend(); push(m); await refresh(); }} /> : null}
    {dialog === "decline" && current ? <DeclineDialog row={current} onClose={() => setDialog(null)} onDeclined={async (m) => { setDialog(null); push(m); await refresh(); }} /> : null}
    {changing ? <ChangeRefereeDialog referee={changing} onClose={() => setChanging(null)} onDone={async (m) => { setChanging(null); push(m); await refresh(); }} /> : null}
    {openId ? <RequestDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => void refresh()} /> : null}
  </>;
}

const STEPS: Array<{ label: string; stages: OnboardingStage[] }> = [
  { label: "Application sent", stages: ["application_sent"] }, { label: "Awaiting referees", stages: ["application_signed", "references_pending"] },
  { label: "Review", stages: ["references_received", "correction_requested", "resubmitted"] }, { label: "Active: agreement", stages: ["references_approved", "agreement_sent"] }, { label: "Signed in", stages: ["agreement_signed"] },
];
/** The combined flow (2026-11-20): one signature on both documents; referees never block; approval issues the agreement. */
const COMBINED_STEPS: Array<{ label: string; stages: OnboardingStage[] }> = [
  { label: "Sent to sign", stages: ["application_sent"] },
  { label: "Signed once: review", stages: ["application_signed", "references_pending", "references_received", "correction_requested", "resubmitted"] },
  { label: "Approved: agreement issued", stages: ["references_approved"] }, { label: "Signed in", stages: ["agreement_signed"] },
];
const STAGE_LABEL_SHORT: Partial<Record<OnboardingStage, string>> = { declined: "Declined", cancelled: "Closed", expired: "Expired", agreement_signed: "Agreement signed", legacy: "Sent as one document" };
/** The status line of the business page: where it is up to and what happens next. */
function statusWords(row: OnboardingRow): string {
  const received = row.referees.filter((r) => r.status === "received").length, total = row.referees.length || 2;
  const open = row.corrections?.find((c) => c.status === "open");
  switch (row.stage) {
    case "application_sent": return `Application sent to ${row.agent.name} (${row.agent.email})${row.application?.sentAt ? ` on ${new Date(row.application.sentAt).toLocaleDateString()}` : ""}: waiting for them to sign.`;
    case "application_signed": case "references_pending": return row.combined ? `Ready for review: the application form and the agreement are signed. Referees: ${received} of ${total} replied (you do not need to wait). Choose Review application.` : `Awaiting referees: ${received} of ${total} replied. You can review now; the review shows each referee's status.`;
    case "references_received": return "Ready for review: both referees have replied. Choose Review application.";
    case "correction_requested": return `Correction requested${open ? ` (round ${open.round})` : ""}: waiting for ${row.agent.name} to correct and sign again.`;
    case "resubmitted": return received < total ? `Resubmitted; a changed referee was contacted (${received} of ${total} replied).` : "Resubmitted: review the corrections.";
    case "references_approved": return "Approved and active: the agent agreement is being prepared.";
    case "agreement_sent": return `Active: agent agreement sent to ${row.agent.email}; sign-in emails go out when it is signed.`;
    default: return row.label ?? row.stage;
  }
}
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

function StagedOnboarding({ row, busy, compact = false, onOpen, onRemind, onDownload, onSendAgreement, onReview, onDecline, onSendReferees, onChangeReferee, onUpload }: {
  row: OnboardingRow; busy: string; compact?: boolean; onOpen: (id: string) => void; onRemind: (r: RequestSummary, who: string) => void; onDownload: (row: OnboardingRow, kind: OnboardingFileKind, label: string) => void;
  onSendAgreement: () => void; onReview: () => void; onDecline: () => void; onSendReferees: () => void; onChangeReferee: (r: OnboardingReferee) => void; onUpload: (r: OnboardingReferee, file: File) => void;
}) {
  const steps = row.combined ? COMBINED_STEPS : STEPS;
  // Activated: every step is done (the stage stays agreement_signed; the activation is recorded on the row).
  const index = row.activation ? steps.length : stepIndex(row.stage, steps);
  const received = row.referees.filter((r) => r.status === "received").length;
  // The agreement goes after staff approve the references; before that only with a typed reason (override).
  // 2026-11-18: the agreement goes with Approve; Send agreement remains only when the automatic send after Approve failed.
  const canSend = row.stage === "references_approved";
  const reviewable = !!row.applicationSignedAt && ["application_signed", "references_pending", "references_received", "correction_requested", "resubmitted"].includes(row.stage);
  const closed = row.stage === "cancelled" || row.stage === "expired" || row.stage === "declined";
  const pendingSend = row.referees.some((r) => r.status === "pending" && !r.request) && (row.stage === "application_signed" || row.stage === "references_pending");
  const dl = (kind: OnboardingFileKind, label: string) => <Button key={kind} size="sm" variant="ghost" icon="ri-file-pdf-2-line" disabled={busy === `${row.id}:${kind}`} onClick={() => onDownload(row, kind, label)} data-testid={`download-${kind.replace(/:.*/, "")}`}>{label}</Button>;
  return <div className={compact ? "space-y-2" : "mt-4 space-y-4"} data-testid={compact ? undefined : "onboarding-current"} data-stage={row.stage}>
    <ol className="flex flex-wrap gap-2" aria-label="Onboarding stages" data-testid="onboarding-stepper">{steps.map((step, i) => {
      const state = closed ? "todo" : i < index ? "done" : i === index ? "current" : "todo";
      return <li key={step.label} data-step-state={state} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${state === "done" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : state === "current" ? "border-primary-500 bg-primary-50 font-semibold text-primary-800" : "border-background-300 text-foreground-500"}`}>
        <i className={state === "done" ? "ri-checkbox-circle-fill" : state === "current" ? "ri-radio-button-line" : "ri-checkbox-blank-circle-line"} aria-hidden="true" />{step.label}</li>; })}</ol>
    <p className="text-sm text-foreground-700"><strong>{row.activation ? "Activated" : row.label ?? (row.stage === "agreement_signed" ? "Ready to activate" : stageWords(row.stage, received, row.referees.length, "business"))}</strong> · to {row.agent.name} ({row.agent.email}) · started {new Date(row.createdAt).toLocaleDateString()}{row.adminName ? ` by ${row.adminName}` : ""}{closed && row.closedReason ? ` · ${row.closedReason}` : ""}</p>
    <div className="space-y-1 rounded-lg border border-background-200 p-3">
      <p className="text-sm font-medium text-foreground-900">1. Agent Application Form (F04){row.combined ? " and Agent Agreement (P06), signed once" : ""}</p>
      <RequestLine request={row.application} who={row.agent.email} busy={busy} onOpen={onOpen} onRemind={onRemind} remindLabel="Resend link" />
      {row.applicationSignedAt ? <p className="text-xs text-foreground-600">Signed {new Date(row.applicationSignedAt).toLocaleDateString()} by {row.signerName ?? row.agent.name}.</p> : null}
      <div className="flex flex-wrap gap-1.5">{row.files.form ? dl("form", ONBOARDING_FILE_LABEL.form) : null}{row.files.application_certificate ? dl("application_certificate", ONBOARDING_FILE_LABEL.application_certificate) : null}</div>
      {compact ? null : <ApplicationAttachments onboardingId={row.id} />}
      {!compact && reviewable ? <div className="flex flex-wrap gap-1.5 pt-1">
        <Button size="sm" icon="ri-file-search-line" disabled={!!busy} onClick={onReview} data-testid="review-application">Review application</Button>
        {["application_signed", "references_pending", "references_received", "resubmitted"].includes(row.stage) ? <Button size="sm" variant="ghost" icon="ri-close-circle-line" disabled={!!busy} onClick={onDecline} data-testid="decline-application">Decline…</Button> : null}
      </div> : null}
      <CorrectionHistory corrections={row.corrections ?? []} revisions={row.revisions ?? []} onOpen={onOpen} />
    </div>
    <div className="space-y-2 rounded-lg border border-background-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground-900">2. Referee checks (F05) · {received} of {row.referees.length || 2} received</p>
        <span className="flex flex-wrap gap-1.5">
          {!compact && pendingSend ? <Button size="sm" variant="outline" disabled={busy === "referees"} onClick={onSendReferees} data-testid="send-referees">Send referee checks</Button> : null}
        </span>
      </div>
      {row.approval ? <p className="text-xs text-emerald-800" data-testid="approval-note">References approved{row.approval.by ? ` by ${row.approval.by}` : ""} on {new Date(row.approval.at).toLocaleDateString()}.</p> : null}
      {row.decline ? <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900" data-testid="decline-note">Declined{row.decline.by ? ` by ${row.decline.by}` : ""} on {new Date(row.decline.at).toLocaleDateString()} (reason kept for staff): “{row.decline.reason}”. The agent was told politely, without the reason; you can start the onboarding again later.</p> : null}
      {!row.referees.length ? <p className="text-xs text-foreground-500">The referees come from the signed application form.</p> : row.referees.map((ref) => <div key={ref.id} className="rounded-md bg-background-50 p-2" data-testid={`referee-${ref.position}`} data-status={ref.status}>
        <p className="text-sm"><span className="font-medium">Reference {ref.position}: {ref.name || "—"}</span>{ref.organisation ? `, ${ref.organisation}` : ""}{ref.positionTitle ? ` (${ref.positionTitle})` : ""} · {ref.email}
          {ref.domainWarning ? <span className="ml-2 rounded border border-amber-300 bg-amber-50 px-1.5 text-2xs font-medium text-amber-900" title="The referee's email address shares the agency's own domain">Same domain as the agency</span> : null}</p>
        <p className="text-xs text-foreground-600">{ref.status === "received" ? `Received ${ref.receivedAt ? new Date(ref.receivedAt).toLocaleDateString() : ""} (${ref.receivedVia === "upload" ? `uploaded${ref.fileName ? `: ${ref.fileName}` : ""}` : "signed online"})`
          : ref.status === "cancelled" ? "Cancelled" : ref.status === "sent" ? "Waiting for the referee" : "Not sent yet"}</p>
        {ref.request ? <RequestLine request={ref.request} who={ref.email} busy={busy} onOpen={onOpen} onRemind={onRemind} remindLabel="Resend to referee" /> : null}
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
        <p className="text-sm font-medium text-foreground-900">3. Agent Agreement (P06){row.combined ? ": signed with the application, countersigned on approval" : ""}</p>
        {!compact && !row.combined && !row.agreement && !closed && canSend ? <Button size="sm" icon="ri-quill-pen-line" disabled={!!busy} onClick={onSendAgreement} data-testid="send-agreement">Send agreement</Button> : null}
        {!compact && row.combined && row.stage === "references_approved" ? <Button size="sm" icon="ri-quill-pen-line" disabled={!!busy} onClick={onSendAgreement} data-testid="issue-agreement">Issue agreement</Button> : null}
      </div>
      {row.combined ? <div className="space-y-0.5 text-xs text-foreground-700" data-testid="agreement-combined">
        <p>Commencement {formatAuDate(row.commencementDate)} · ends {formatAuDate(row.expiryDate)} · territory {row.territory || "—"} · commission {row.commissionPercent != null ? `${row.commissionPercent}%` : "—"}</p>
        {row.signatureEvent ? <p data-testid="signature-event">Signed once by {row.signatureEvent.signer ?? row.agent.name} on {new Date(row.signatureEvent.at).toLocaleString()} (application form and agreement){row.signatureEvent.ip ? ` · IP ${row.signatureEvent.ip}` : ""}.</p>
          : row.stage === "application_sent" ? <p>Waiting for {row.agent.name} to sign the application form and the agreement (one signature).</p> : null}
        {row.slitWitness ? <p data-testid="slit-witness-note">SLIT witness: {row.slitWitness.name} (added before sending; drawn signature).</p> : null}
        {row.witness ? <p data-testid="agent-witness-note">Agency's witness: {row.witness.name} (added by the agency admin when signing; drawn signature).</p> : null}
        {row.agreementIssuedAt ? <p className="text-emerald-800">Countersigned by {row.adminName || "SLIT"} and issued on {new Date(row.agreementIssuedAt).toLocaleDateString()}; the completed copy was emailed to {row.agent.email}.</p> : null}
      </div> : <RequestLine request={row.agreement} who={row.agent.email} busy={busy} onOpen={onOpen} onRemind={onRemind} />}
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

type SignatureMethod = "saved" | "drawn" | "typed";
/**
 * Send agreement: Items 3 to 5 and the SLIT signatory; before References received a typed reason is required and kept on the record.
 * 2026-11-20: on a combined onboarding (the agency admin signed the agreement with the application) Approve only takes the SLIT signatory:
 * the signed agreement is countersigned and issued, nothing goes out for a second signature. The SLIT witness, when given, is a typed name
 * and a DRAWN signature (never typed). Referees still pending are a warning, never a block.
 */
function SendAgreementDialog({ row, agencyId, agencyName, approve = false, onClose, onSent }: { row: OnboardingRow; agencyId: string; agencyName: string; approve?: boolean; onClose: () => void; onSent: (message: string) => Promise<void> }) {
  const [prepared, setPrepared] = useState<OnboardingPrepared | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const [commencement, setCommencement] = useState(todayIso());
  const [territory, setTerritory] = useState(""); const [commission, setCommission] = useState("");
  const [adminName, setAdminName] = useState(""); const [adminPosition, setAdminPosition] = useState("");
  const [witness, setWitness] = useState(""); const [witnessPng, setWitnessPng] = useState<string | null>(null);
  const [method, setMethod] = useState<SignatureMethod>("typed"); const [png, setPng] = useState<string | null>(null); const [save, setSave] = useState(true);
  const [message, setMessage] = useState(""); const [reason, setReason] = useState("");
  const combined = !!row.combined;
  // Approve and activate agency (2026-11-18) sends the agreement in the same step; a plain send is only the retry after Approve.
  const override = !approve && !combined && row.stage !== "references_approved";
  const received = row.referees.filter((r) => r.status === "received").length, total = row.referees.length || 2;
  useEffect(() => {
    let live = true;
    prepareOnboarding(agencyId, row.agent.id).then((p) => {
      if (!live) return;
      setPrepared(p); setAdminName(p.admin.name); setAdminPosition(p.admin.position); setMethod(p.admin.signaturePng ? "saved" : "typed");
      setTerritory(p.agency.profile.agent_territory ?? ""); setCommission(p.agency.profile.agent_commission_percent ?? "");
    }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [agencyId, row.agent.id]);
  const termsReady = combined || (/^\d{4}-\d{2}-\d{2}$/.test(commencement) && territory.trim().length > 0 && /^\d{1,3}(\.\d{1,2})?$/.test(commission.trim().replace("%", "")));
  const witnessReady = (!witness.trim() && !witnessPng) || (witness.trim().length >= 2 && !!witnessPng);
  const ready = !!prepared && termsReady && adminName.trim().length >= 2 && adminPosition.trim().length > 0 && (method === "typed" || (method === "drawn" ? !!png : !!prepared?.admin.signaturePng))
    && (!override || reason.trim().length >= 5) && witnessReady;
  const send = async () => {
    if (!ready || busy) return;
    setBusy(combined ? "Issuing the agreement…" : "Preparing the agreement…"); setError("");
    try {
      const input: AgentAgreementSendInput = { agencyId, onboardingId: row.id, agentId: row.agent.id, commencementDate: commencement, territory: territory.trim(), commissionPercent: commission.trim().replace("%", ""),
        adminName: adminName.trim(), adminPosition: adminPosition.trim(), adminWitness: witnessPng && witness.trim() ? { name: witness.trim(), png: witnessPng } : null,
        message: message.trim() || undefined, overrideReason: override ? reason.trim() : undefined,
        adminSignature: method === "saved" ? { kind: "saved" } : method === "drawn" ? { kind: "drawn", png: png ?? "", save } : { kind: "typed", name: adminName.trim() } };
      if (approve || combined) {
        const r = await approveAgency(input);
        if (r.combined) {
          const issued = r.issued;
          await onSent(r.warning ?? (issued?.issued ? `Approved: ${agencyName} is active. The agreement ${row.agent.name} signed is countersigned and issued${issued.emailed ? `; the completed copy was emailed to ${issued.to ?? row.agent.email}` : ""}${issued.invitations.length ? `; sign-in emails sent to ${issued.invitations.join(", ")}` : ""}.` : "Approved."));
          return;
        }
        await onSent(r.warning ?? (r.agreement?.sent ? `Approved: ${agencyName} is active. Agent agreement sent to ${row.agent.email} (${r.agreement.reference}); sign-in emails go out when it is signed.` : r.agreement?.warning ?? "Approved; the agreement was created but not emailed."));
        return;
      }
      const r = await sendAgentAgreement(input);
      await onSent(r.sent ? `Agreement sent to ${row.agent.name} (${row.agent.email}), reference ${r.reference}${r.override ? " (sent before both references were back; the reason is on the record)" : ""}.` : r.warning ?? "The request was created but not emailed.");
    } catch (e) { setError(e instanceof Error ? e.message : "The agreement could not be sent."); } finally { setBusy(""); }
  };
  const approving = approve || combined;
  return <Modal open title={`${approving ? "Approve and activate agency" : override ? "Send agreement anyway" : "Send agreement"}: ${agencyName}`} onClose={() => { if (!busy) onClose(); }} width="max-w-2xl"
    footer={<div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="outline" disabled={!!busy} onClick={onClose}>Cancel</Button>
      <Button disabled={!ready || !!busy} onClick={() => void send()} data-testid={approving ? "approve-agency-confirm" : "send-agreement-confirm"}>{busy || (approving ? (combined ? "Approve, countersign and issue" : "Approve and activate agency") : override ? "Send agreement anyway" : "Send agreement for signature")}</Button>
    </div>}>
    <div className="space-y-4" data-testid="send-agreement-dialog">
      {combined ? <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950" data-testid="approve-note">The business becomes <strong>active</strong> now (its agents do not). {row.agent.name} ({row.agent.email}) already signed the Agent Agreement with the application, so nothing is sent for a second signature: your signature below countersigns it, the completed agreement is emailed to them, and the agency admin and every agent already added get their sign-in email.</p>
        : approve ? <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950" data-testid="approve-note">The business becomes <strong>active</strong> now (its agents do not). The agency admin, {row.agent.name} ({row.agent.email}), receives the Agent Agreement (P06) to sign, with your signature filled in. When it is signed, the agency admin and every agent already added get their sign-in email.</p> : null}
      {approving && received < total ? <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" data-testid="approve-referees-warning">
        <i className="ri-error-warning-line mr-1" aria-hidden="true" />Only {received} of {total} referees have replied. You can still approve; replies that arrive later are kept on the business record.</p> : null}
      {combined ? null : <p className="text-sm text-foreground-600">The agent receives the Agent Agreement (P06) with a personal signing link, prefilled with Items 1 to 4 and the signatory from the application form.</p>}
      {override ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
        <p className="font-medium">{row.stage === "references_received" ? "Both references are back but not approved yet." : `Only ${received} of ${total} references ${received === 1 ? "is" : "are"} back.`} Sending now is logged on the record with your reason.</p>
        <Field label="Reason" required><TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Referee confirmed by phone on 17 Nov" data-testid="override-reason" /></Field>
      </div> : null}
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      {!prepared ? !error && <p className="text-sm">Loading…</p> : <>
        {combined ? <p className="text-sm text-foreground-700" data-testid="approve-terms">Signed terms: commencement {formatAuDate(row.commencementDate)} · ends {formatAuDate(row.expiryDate)} · territory {row.territory || "—"} · commission {row.commissionPercent != null ? `${row.commissionPercent}%` : "—"}.</p> : <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Commencement date (Item 5)" required><TextInput type="date" value={commencement} onChange={(e) => setCommencement(e.target.value)} data-testid="onboarding-commencement" /></Field>
            <Field label="Territory (Item 3)" required><TextInput value={territory} onChange={(e) => setTerritory(e.target.value)} placeholder="e.g. India, Nepal" maxLength={200} data-testid="onboarding-territory" /></Field>
            <Field label="Commission % (Item 4)" required><TextInput inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} placeholder="25" maxLength={6} data-testid="onboarding-commission" /></Field>
          </div>
          <p className="text-xs text-foreground-500">The agreement runs two years from the commencement date; the expiry is recorded on the business when it is signed.</p>
        </>}
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
        {combined && row.slitWitness ? <p className="rounded-md border border-background-200 p-3 text-sm text-foreground-700" data-testid="slit-witness-preset">SLIT witness: <strong>{row.slitWitness.name}</strong>, already on the agreement (added before sending).</p> : <div className="space-y-2 rounded-md border border-background-200 p-3" data-testid="slit-witness">
          <Field label="SLIT witness name" hint="Optional. The witness types their name and draws their signature below (a typed signature is not accepted).">
            <TextInput value={witness} onChange={(e) => setWitness(e.target.value)} maxLength={150} data-testid="slit-witness-name" /></Field>
          {witness.trim() ? <div><p className="mb-1 text-label font-medium text-foreground-800">SLIT witness signature (drawn)</p><SignaturePad onChange={setWitnessPng} /></div> : null}
          {!witnessReady ? <p className="text-xs text-amber-800">The witness must draw their signature, or clear the witness's name.</p> : null}
        </div>}
        {combined ? null : <Field label="Message to the agent" hint="Optional; goes in the email."><TextArea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} /></Field>}
      </>}
    </div>
  </Modal>;
}

/** Decline (staff only): the onboarding closes, its open requests are voided and the agency admin gets a polite email without the reason. */
function DeclineDialog({ row, onClose, onDeclined }: { row: OnboardingRow; onClose: () => void; onDeclined: (message: string) => Promise<void> }) {
  const [reason, setReason] = useState(""); const [working, setWorking] = useState(false); const [error, setError] = useState("");
  const decline = async () => {
    if (working || reason.trim().length < 5) return;
    setWorking(true); setError("");
    try { const r = await rejectOnboarding({ onboardingId: row.id, reason: reason.trim() }); await onDeclined(`Application declined. ${r.emailed ? `${r.agent.name} was told politely (without the reason).` : "The agency admin could not be emailed; tell them yourself."}`); }
    catch (e) { setError(e instanceof Error ? e.message : "The application could not be declined."); setWorking(false); }
  };
  return <Modal open title={`Decline application: ${row.agent.name}`} onClose={() => { if (!working) onClose(); }} width="max-w-xl"
    footer={<div className="flex justify-end gap-2"><Button variant="outline" disabled={working} onClick={onClose}>Cancel</Button>
      <Button variant="outline" icon="ri-close-circle-line" disabled={working || reason.trim().length < 5} onClick={() => void decline()} data-testid="reject-confirm">{working ? "Declining…" : "Decline this application"}</Button></div>}>
    <div className="space-y-3" data-testid="decline-dialog">
      <p className="text-sm text-foreground-700">Declining closes this onboarding: its open requests are voided, the agency admin gets a polite email without your reason, and nobody from the business can sign in. You can start the onboarding again later (Resend link).</p>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      <Field label="Reason (kept for staff only)" required><TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="e.g. Referee 2 could not confirm the agency's work" data-testid="reject-reason" /></Field>
    </div>
  </Modal>;
}

/** Earlier versions and correction notes (2026-11-18): every round sent back, what changed, and every PDF revision after the first signature. */
function CorrectionHistory({ corrections, revisions, onOpen }: { corrections: OnboardingCorrection[]; revisions: OnboardingRevision[]; onOpen: (id: string) => void }) {
  const [opening, setOpening] = useState(""); const [problem, setProblem] = useState("");
  if (!corrections.length && !revisions.length) return null;
  const open = (id: string) => { setOpening(id); setProblem(""); openRevisionFile(id).catch((e: Error) => setProblem(e.message)).finally(() => setOpening("")); };
  return <details className="mt-2 rounded-md border border-background-200 px-3 py-2 text-xs" data-testid="correction-history" open={corrections.some((c) => c.status === "open") || undefined}>
    <summary className="cursor-pointer font-medium text-foreground-800">Corrections and revisions ({corrections.length} round{corrections.length === 1 ? "" : "s"}, {revisions.length} revision{revisions.length === 1 ? "" : "s"})</summary>
    {corrections.length ? <ol className="mt-2 space-y-2">{corrections.map((c) => <li key={c.id} className="rounded bg-background-100/70 p-2" data-testid={`correction-round-${c.round}`}>
      <p className="font-medium text-foreground-900">Round {c.round}: sent back {new Date(c.requestedAt).toLocaleDateString()}{c.by ? ` by ${c.by}` : ""} · {c.status === "open" ? "waiting for the agency" : c.status === "resubmitted" ? `resubmitted ${c.resubmittedAt ? new Date(c.resubmittedAt).toLocaleDateString() : ""}` : `closed (${c.closedReason ?? "unsigned"})`}
        {c.request ? <> · <button type="button" className="font-medium text-primary-700 underline-offset-2 hover:underline" onClick={() => onOpen(c.request!.id)}>{c.request.reference}</button></> : null}</p>
      {c.message ? <p className="mt-0.5 whitespace-pre-line text-foreground-700">“{c.message}”</p> : null}
      <ul className="mt-1 list-disc pl-4 text-foreground-700">{Object.entries(c.flags).map(([k, note]) => <li key={k}><span className="font-medium">{k.replaceAll("_", " ")}</span>{note ? `: ${note}` : ""}</li>)}</ul>
      {c.changes?.length ? <p className="mt-1 text-foreground-600">Changed: {c.changes.map((ch) => `${ch.field.replaceAll("_", " ")} “${ch.old}” → “${ch.new}”`).join("; ")}</p> : null}
    </li>)}</ol> : null}
    {revisions.length ? <ul className="mt-2 space-y-1">{revisions.map((v) => <li key={v.id} className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" icon="ri-file-pdf-2-line" disabled={opening === v.id} onClick={() => open(v.id)} data-testid={`revision-${v.revision}`}>Revision {v.revision}</Button>
      <span className="text-foreground-600">{v.kind === "staff_edit" ? "edited by SLIT staff" : "re-signed after a correction"}{v.by ? ` · ${v.by}` : ""} · {new Date(v.at).toLocaleDateString()}{v.changes?.length ? ` · ${v.changes.length} change${v.changes.length === 1 ? "" : "s"}` : ""}</span>
    </li>)}</ul> : null}
    {problem ? <p className="mt-1 text-red-700">{problem}</p> : null}
  </details>;
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

/** The organisation chart / business profile the contact uploaded with the F04 wizard (2026-11-19); opened in a new tab. */
function ApplicationAttachments({ onboardingId }: { onboardingId: string }) {
  const [files, setFiles] = useState<ApplicationAttachment[] | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => { let live = true; listApplicationAttachments(onboardingId).then((list) => { if (live) setFiles(list); }).catch(() => { if (live) setFiles([]); }); return () => { live = false; }; }, [onboardingId]);
  if (!files?.length) return null;
  return <div className="flex flex-wrap items-center gap-1.5" data-testid="onboarding-attachments">
    {files.map((file) => <Button key={file.kind} size="sm" variant="ghost" icon="ri-attachment-2" onClick={() => { setProblem(""); openApplicationAttachment(onboardingId, file.kind).catch((e: Error) => setProblem(e.message)); }}>{APPLICATION_ATTACHMENT_LABEL[file.kind] ?? file.kind}: {file.name}</Button>)}
    {problem ? <span className="text-xs text-red-700">{problem}</span> : null}
  </div>;
}
