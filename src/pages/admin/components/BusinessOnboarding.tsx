import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card } from "@/pages/admin/components/ui";
import SubjectSigningPanel from "@/pages/admin/components/signing/SubjectSigningPanel";
import AgentOnboardingPanel from "@/pages/admin/components/AgentOnboardingPanel";
import { useToast } from "@/pages/admin/components/toastContext";
import DocumentViewer, { type ViewerDoc } from "@/pages/admin/components/DocumentViewer";
import { businessDocumentLimitMb, businessDocumentUrl, listBusinessDocuments, removeBusinessDocument, uploadBusinessDocument, type BusinessDetail, type BusinessDocument } from "@/pages/admin/lib/businessData";
import { ruleNumber } from "@/lib/businessRules";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.doc,.docx";

/**
 * The business's agent agreement: upload a signed copy, or send it to the business admin agent through Skyline Sign.
 * While the business is inactive it is shown as the onboarding checklist, ending with Activate & invite.
 */
export default function BusinessOnboarding({ business, onChanged, part = "onboarding" }: {
  business: BusinessDetail;
  onChanged: () => Promise<void>;
  onActivate?: () => void;
  activating?: boolean;
  /** "onboarding": the onboarding panel (Details tab); "documents": every document of the business in one place (Documents tab, 2026-11-24). */
  part?: "onboarding" | "documents";
}) {
  const { push } = useToast();
  const [docs, setDocs] = useState<BusinessDocument[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const onboarding = business.onboarding;
  const contact = onboarding?.contact ?? null;
  const ready = Boolean(onboarding?.agreementReady);

  const load = useCallback(async () => {
    try { setDocs(await listBusinessDocuments(business.id)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "We could not load documents."); }
  }, [business.id]);
  useEffect(() => { void load(); }, [load]);

  const [reason, setReason] = useState("");
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  // Any document can be uploaded (owner 2026-11-24); only a signed agreement copy needs a reason.
  const [kind, setKind] = useState<BusinessDocument["kind"]>("other");
  const needsReason = kind === "agent_agreement" && reason.trim().length < Math.max(1, ruleNumber("agents.onboarding_reason_min_chars", 5));
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      await uploadBusinessDocument(business.id, f, kind, reason);
      setReason("");
      push(kind === "agent_agreement" ? "Signed agent agreement uploaded; the reason is on the record." : `${f.name} uploaded.`);
      await load();
      await onChanged();
    } catch (e) {
      push(e instanceof Error ? e.message : "We could not upload this file.", "error");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  const remove = async (d: BusinessDocument) => {
    if (!window.confirm(`Remove ${d.fileName}?`)) return;
    setBusy(true);
    try { await removeBusinessDocument(d.id); await load(); await onChanged(); } catch (e) { push(e instanceof Error ? e.message : "We could not remove it.", "error"); } finally { setBusy(false); }
  };

  return (
    <div className="mb-6 space-y-4" data-testid="business-onboarding">
      {/* The Onboarding checklist was removed (owner 2026-11-24: "no need"); the panel below and the header's Activate cover it. */}
      {part === "onboarding" ? <AgentOnboardingPanel business={business} onChanged={onChanged} /> : <>
      <AgentOnboardingPanel business={business} onChanged={onChanged} view="documents" />

      <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />
      <Card className="p-5" data-testid="uploaded-agreements">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-base font-semibold text-foreground-950">Uploaded documents{docs?.length ? ` (${docs.length})` : ""}</h2>
            <p className="text-sm text-foreground-600">Any other document for this business: a paper-signed agreement, ID, licence, letters (PDF, image or Word, up to {businessDocumentLimitMb()} MB). Administrators only.</p>
          </div>
          {ready ? <Badge tone="success">Agreement signed</Badge> : <Badge tone="warn">Agreement not signed yet</Badge>}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end">
          <label className="block text-sm"><span className="mb-1 block text-xs font-semibold text-foreground-700">Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as BusinessDocument["kind"])} data-testid="upload-kind"
              className="w-full rounded-md border border-background-300 bg-white px-3 py-2">
              <option value="other">Other document</option>
              <option value="agent_agreement">Signed agreement (paper copy)</option>
            </select></label>
          <label className="block text-sm"><span className="mb-1 block text-xs font-semibold text-foreground-700">{kind === "agent_agreement" ? "Reason for recording a signed copy *" : "Note (optional)"}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} data-testid="upload-agreement-reason"
              placeholder={kind === "agent_agreement" ? "e.g. Agreement signed on paper at the agent fair on 12 Nov" : "e.g. Director's passport copy"}
              className="w-full rounded-md border border-background-300 px-3 py-2 text-foreground-950" /></label>
          <Button size="sm" icon="ri-upload-2-line" disabled={busy || needsReason} title={needsReason ? "Type the reason first" : undefined} onClick={() => file.current?.click()} data-testid="upload-agreement">{busy ? "Uploading…" : "Upload"}</Button>
          <input ref={file} type="file" accept={ACCEPT} className="hidden" aria-label="Document file" onChange={(e) => void upload(e.target.files?.[0])} />
        </div>
        {kind === "agent_agreement" ? <p className="mt-2 text-xs text-foreground-500">A signed agreement copy stands in for the online agreement, so its reason is kept with it and in the onboarding history.</p> : null}
        {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
        {docs && docs.length ? (
          <ul className="mt-3 divide-y divide-background-200 text-sm">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <button type="button" className="text-left font-medium text-primary-700 hover:underline" onClick={() => void businessDocumentUrl(d.path).then((url) => setViewing({ url, name: d.fileName })).catch((e: Error) => push(e.message, "error"))}>
                    <i className="ri-file-text-line mr-1" aria-hidden="true" />{d.fileName}
                  </button>
                  <Badge tone={d.kind === "agent_agreement" ? "success" : "muted"}>{d.kind === "agent_agreement" ? "Signed agreement" : "Other"}</Badge>
                </span>
                <span className="flex items-center gap-3 text-xs text-foreground-500">
                  {new Date(d.createdAt).toLocaleDateString()}{d.uploadedBy ? ` · ${d.uploadedBy}` : ""}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(d)}>Remove</Button>
                </span>
                {d.reason ? <span className="w-full text-xs text-foreground-600">{d.kind === "agent_agreement" ? "Reason" : "Note"}: {d.reason}</span> : null}
              </li>
            ))}
          </ul>
        ) : docs ? <p className="mt-3 text-sm text-foreground-600">Nothing uploaded yet.</p> : null}
      </Card>

      {contact ? <SubjectSigningPanel type="agent" id={contact.agentId} name={contact.name} /> : null}
      </>}
    </div>
  );
}
