import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Field, Modal, Select, TextArea, TextInput } from "@/pages/admin/components/ui";
import DocumentViewer, { type ViewerDoc } from "@/pages/admin/components/DocumentViewer";
import { useToast } from "@/pages/admin/components/toastContext";
import { ruleNumber } from "@/lib/businessRules";
import {
  BUSINESS_DOCUMENT_KINDS, BUSINESS_DOCUMENT_TYPES, businessDocumentKindLabel, businessDocumentLimitMb, businessDocumentProblem, businessDocumentStatus,
  changeBusinessContactEmail, downloadBusinessDocument, opensInBrowser, removeBusinessDocument, resendBusinessApplication, uploadBusinessDocument, businessDocumentViewUrl,
  type BusinessDocument, type BusinessDocumentKind, type BusinessDocumentStatus,
} from "@/pages/admin/lib/businessData";

const ACCEPT = Object.keys(BUSINESS_DOCUMENT_TYPES).map((ext) => `.${ext}`).join(",");
const reasonMin = () => Math.max(1, Math.round(ruleNumber("agents.onboarding_reason_min_chars", 5)));
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Business page › Documents (2026-11-24): the agency admin's email (change it), Resend application / Email signed copy, Upload document,
 * and the uploaded documents that are not agreements (Other documents) with View / Download. Every action is checked and logged by the
 * database (SLIT administrators only); the buttons are only the way in.
 */
export default function BusinessDocumentActions({ businessId, docs, onDocsChanged, onChanged }: {
  businessId: string;
  /** The business's uploaded documents (null while loading), shared with the agreement copies list below. */
  docs: BusinessDocument[] | null;
  onDocsChanged: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const { push } = useToast();
  const [status, setStatus] = useState<BusinessDocumentStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState("");
  const [wait, setWait] = useState(0);
  const [editing, setEditing] = useState(false);

  const loadStatus = useCallback(async () => {
    try { const s = await businessDocumentStatus(businessId); setStatus(s); setWait(s.waitSeconds); setStatusError(""); }
    catch (e) { setStatusError(e instanceof Error ? e.message : "We could not load this business’s document status."); }
  }, [businessId]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  // The countdown to the next resend (the database refuses earlier ones anyway).
  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);

  const resend = async () => {
    setBusy("resend");
    try {
      const r = await resendBusinessApplication(businessId);
      push(r.mode === "signed" ? `Signed copies emailed to ${r.to}.`
        : `Application emailed again to ${r.to}${r.linkRotated ? " with a new link (the expired one no longer works)" : ""}.${r.mail && r.mail.sent === 0 ? " It is queued and goes out within a few minutes." : ""}`);
      await loadStatus();
    } catch (e) {
      push(e instanceof Error ? e.message : "That did not send.", "error");
      await loadStatus();
    } finally { setBusy(""); }
  };

  const contact = status?.contact ?? null;
  const signed = !!status?.applicationSigned;
  const others = (docs ?? []).filter((d) => d.kind !== "agent_agreement");

  return (
    <div className="space-y-4" data-testid="business-document-actions">
      <Card className="p-4 sm:p-5">
        <h2 className="font-heading text-base font-semibold text-foreground-950">Agency admin</h2>
        {statusError ? <p role="alert" className="mt-2 text-sm text-red-700">{statusError}</p> : null}
        {!status && !statusError ? <p className="mt-2 text-sm text-foreground-500">Loading…</p> : null}
        {status ? <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {contact ? <>
              <p className="text-sm font-medium text-foreground-900">{contact.name}</p>
              <p className="flex items-center gap-1 text-sm text-foreground-700">
                <span className="min-w-0 break-all" data-testid="contact-email">{contact.email || "No email"}</span>
                <button type="button" onClick={() => setEditing(true)} aria-label="Change email" title="Change email" data-testid="change-contact-email"
                  className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100 hover:text-primary-700">
                  <i className="ri-pencil-line" aria-hidden="true" />
                </button>
              </p>
              {contact.hasLogin ? <p className="text-xs text-foreground-500">Has an agent portal login (it moves to a new email too).</p> : null}
            </> : <p className="text-sm text-foreground-600">This business has no agency admin yet.</p>}
          </div>
          <div className="flex flex-col gap-1 sm:items-end">
            <Button size="sm" variant="outline" icon={signed ? "ri-mail-send-line" : "ri-send-plane-line"} className="w-full sm:w-auto"
              disabled={!status.applicationSent || busy === "resend" || wait > 0} onClick={() => void resend()} data-testid="resend-application"
              title={!status.applicationSent ? "No application has been sent yet" : undefined}>
              {busy === "resend" ? "Sending…" : wait > 0 ? `${signed ? "Email signed copy" : "Resend application"} (${wait}s)` : signed ? "Email signed copy" : "Resend application"}
            </Button>
            <p className="text-xs text-foreground-500" data-testid="last-sent">
              {status.lastSentAt ? `Last sent ${when(status.lastSentAt)}` : status.applicationSent ? "Not sent again yet" : "No application sent yet"}
            </p>
            <p className="text-xs text-foreground-500">{signed ? "Emails the signed application form and agreement (never the certificate)." : "Emails the same signing link; the saved answers are kept."}</p>
          </div>
        </div> : null}
      </Card>

      <UploadDocument businessId={businessId} onUploaded={async () => { await onDocsChanged(); await onChanged(); await loadStatus(); }} />

      <Card className="p-4 sm:p-5" data-testid="other-documents">
        <h2 className="font-heading text-base font-semibold text-foreground-950">Other documents{docs ? ` (${others.length})` : ""}</h2>
        {docs === null ? <p className="mt-2 text-sm text-foreground-500">Loading…</p> : !others.length ? <p className="mt-2 text-sm text-foreground-600">No ID, insurance or other documents uploaded.</p> : (
          <ul className="mt-2 divide-y divide-background-200">
            {others.map((d) => <DocumentRow key={d.id} doc={d} onRemoved={onDocsChanged} />)}
          </ul>
        )}
      </Card>

      {editing && contact ? <ChangeEmailDialog businessId={businessId} current={contact.email} onClose={() => setEditing(false)}
        onDone={async () => { setEditing(false); await loadStatus(); await onChanged(); }} /> : null}
    </div>
  );
}

/** One uploaded document: kind, name, uploader and date; View (PDF / picture, a 60-second link), Download, Remove. */
export function DocumentRow({ doc, onRemoved }: { doc: BusinessDocument; onRemoved: () => Promise<void> }) {
  const { push } = useToast();
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (!window.confirm(`Remove ${doc.fileName}?`)) return;
    setBusy(true);
    try { await removeBusinessDocument(doc.id); await onRemoved(); } catch (e) { push(e instanceof Error ? e.message : "We could not remove it.", "error"); } finally { setBusy(false); }
  };
  return (
    <li className="flex flex-col gap-2 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between" data-testid={`business-document-${doc.id}`}>
      <div className="min-w-0">
        <p className="flex items-center gap-2"><Badge tone="muted">{businessDocumentKindLabel(doc.kind)}</Badge><span className="min-w-0 break-all font-medium text-foreground-900">{doc.fileName}</span></p>
        <p className="mt-0.5 text-xs text-foreground-500">{doc.uploadedBy ? `${doc.uploadedBy} · ` : ""}{when(doc.createdAt)}</p>
        {doc.reason ? <p className="mt-0.5 text-xs text-foreground-600">Reason: {doc.reason}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        {opensInBrowser(doc.fileName) ? <Button size="sm" variant="ghost" icon="ri-eye-line" onClick={() => void businessDocumentViewUrl(doc.path).then((url) => setViewing({ url, name: doc.fileName })).catch((e: Error) => push(e.message, "error"))}>View</Button> : null}
        <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />
        <Button size="sm" variant="ghost" icon="ri-download-2-line" onClick={() => void downloadBusinessDocument(doc.path, doc.fileName).catch((e: Error) => push(e.message, "error"))}>Download</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>Remove</Button>
      </div>
    </li>
  );
}

function UploadDocument({ businessId, onUploaded }: { businessId: string; onUploaded: () => Promise<void> }) {
  const { push } = useToast();
  const [kind, setKind] = useState<BusinessDocumentKind>("other");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const needsReason = kind === "agent_agreement";
  const reasonShort = needsReason && reason.trim().length < reasonMin();

  const choose = (f: File | undefined) => {
    setFile(f ?? null);
    setProblem(f ? businessDocumentProblem(f) ?? "" : "");
  };
  const upload = async () => {
    if (!file || problem || reasonShort) return;
    setBusy(true);
    try {
      await uploadBusinessDocument(businessId, file, kind, reason);
      push(`${businessDocumentKindLabel(kind)} uploaded: ${file.name}.`);
      setFile(null); setReason(""); if (input.current) input.current.value = "";
      await onUploaded();
    } catch (e) { push(e instanceof Error ? e.message : "We could not upload this file.", "error"); } finally { setBusy(false); }
  };

  return (
    <Card className="p-4 sm:p-5" data-testid="upload-document">
      <h2 className="font-heading text-base font-semibold text-foreground-950">Upload document</h2>
      <p className="mt-1 text-sm text-foreground-600">PDF, PNG, JPG, DOC or DOCX, up to {businessDocumentLimitMb()} MB. Administrators only.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Kind" required>
          <Select value={kind} onChange={(e) => setKind(e.target.value as BusinessDocumentKind)} data-testid="upload-document-kind">
            {BUSINESS_DOCUMENT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </Field>
        <Field label="File" required hint={file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : undefined}>
          <input ref={input} type="file" accept={ACCEPT} onChange={(e) => choose(e.target.files?.[0])} data-testid="upload-document-file"
            className="block w-full text-sm text-foreground-700 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-background-200 file:px-3 file:py-2 file:text-sm file:font-medium" />
        </Field>
      </div>
      <div className="mt-3">
        <Field label={needsReason ? "Reason (needed for an agreement)" : "Reason (optional)"} required={needsReason}
          hint={needsReason ? "An uploaded agreement stands in for the online one; the reason is kept with it and in the onboarding history." : undefined}>
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder={needsReason ? "e.g. Signed on paper at the agent fair on 12 Nov" : "e.g. Professional indemnity insurance 2026-27"} data-testid="upload-document-reason" />
        </Field>
      </div>
      {problem ? <p role="alert" className="mt-2 text-sm text-red-700">{problem}</p> : null}
      <div className="mt-3 flex justify-end">
        <Button icon="ri-upload-2-line" className="w-full sm:w-auto" disabled={busy || !file || !!problem || reasonShort} onClick={() => void upload()} data-testid="upload-document-submit">
          {busy ? "Uploading…" : "Upload document"}
        </Button>
      </div>
    </Card>
  );
}

function ChangeEmailDialog({ businessId, current, onClose, onDone }: { businessId: string; current: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { push } = useToast();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(email.trim()) && email.trim().toLowerCase() !== current.toLowerCase();
  const ready = valid && reason.trim().length >= reasonMin();
  const save = async () => {
    if (!ready) return;
    setBusy(true); setError("");
    try {
      const r = await changeBusinessContactEmail(businessId, email.trim(), reason.trim());
      push(r.message);
      if (r.warning) push(r.warning, "error");
      await onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "The email could not be changed."); } finally { setBusy(false); }
  };
  return (
    <Modal open title="Change the agency admin's email" onClose={busy ? () => undefined : onClose}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={!ready || busy} onClick={() => void save()} data-testid="change-email-save">{busy ? "Changing…" : "Change email"}</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-foreground-600">Now <strong className="break-all">{current || "no email"}</strong>. A waiting signing link goes to the new address (the old link stops working), a waiting sign-in invitation is sent again, and an existing login signs in with the new email.</p>
        <Field label="New email" required>
          <TextInput type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => { setEmail(e.target.value); setError(""); }} data-testid="change-email-input" />
        </Field>
        <Field label="Reason" required hint="Kept in the onboarding history.">
          <TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-testid="change-email-reason" />
        </Field>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      </div>
    </Modal>
  );
}
