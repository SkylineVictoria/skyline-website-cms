import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card } from "@/pages/admin/components/ui";
import SubjectSigningPanel from "@/pages/admin/components/signing/SubjectSigningPanel";
import AgentOnboardingPanel from "@/pages/admin/components/AgentOnboardingPanel";
import { useToast } from "@/pages/admin/components/toastContext";
import { businessDocumentLimitMb, listBusinessDocuments, openBusinessDocument, removeBusinessDocument, uploadBusinessDocument, type BusinessDetail, type BusinessDocument } from "@/pages/admin/lib/businessData";
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
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      await uploadBusinessDocument(business.id, f, "agent_agreement", reason);
      setReason("");
      push("Signed agent agreement uploaded; the reason is on the record.");
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

  const agreements = (docs ?? []).filter((d) => d.kind === "agent_agreement");
  return (
    <div className="mb-6 space-y-4" data-testid="business-onboarding">
      {/* The Onboarding checklist was removed (owner 2026-11-24: "no need"); the panel below and the header's Activate cover it. */}
      {part === "onboarding" ? <AgentOnboardingPanel business={business} onChanged={onChanged} /> : <>
      <AgentOnboardingPanel business={business} onChanged={onChanged} view="documents" />

      <details className="rounded-card border border-background-200 bg-background-50 p-4" open={agreements.length > 0} data-testid="uploaded-agreements">
        <summary className="cursor-pointer text-sm font-medium text-foreground-800">Uploaded copies: signed agreement on paper? Upload a copy{agreements.length ? ` (${agreements.length} uploaded)` : ""}</summary>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="sr-only">Agent agreement (uploaded copies)</h2>
            <p className="text-sm text-foreground-600">Signed copies uploaded for this business (PDF, image or Word, up to {businessDocumentLimitMb()} MB). A copy stands in for the online agreement, so it needs a reason, which is kept with the document and in the onboarding history; administrators only.</p>
          </div>
          <div className="flex items-center gap-2">
            {ready ? <Badge tone="success">Signed</Badge> : <Badge tone="warn">Not signed yet</Badge>}
            <Button size="sm" variant="outline" icon="ri-upload-2-line" disabled={busy || reason.trim().length < Math.max(1, ruleNumber("agents.onboarding_reason_min_chars", 5))} title={reason.trim().length < Math.max(1, ruleNumber("agents.onboarding_reason_min_chars", 5)) ? "Type the reason first" : undefined} onClick={() => file.current?.click()} data-testid="upload-agreement">{busy ? "Uploading…" : "Upload signed agreement"}</Button>
            <input ref={file} type="file" accept={ACCEPT} className="hidden" aria-label="Signed agent agreement file" onChange={(e) => void upload(e.target.files?.[0])} />
          </div>
        </div>
        <label className="mt-3 block text-sm">
          <span className="font-medium text-foreground-800">Reason for recording a signed copy</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="e.g. Agreement signed on paper at the agent fair on 12 Nov" data-testid="upload-agreement-reason"
            className="mt-1 w-full rounded-md border border-background-300 px-3 py-2 text-foreground-950" />
        </label>
        {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
        {docs && agreements.length ? (
          <ul className="mt-3 divide-y divide-background-200 text-sm">
            {agreements.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <button type="button" className="text-left font-medium text-primary-700 hover:underline" onClick={() => void openBusinessDocument(d.path).catch((e: Error) => push(e.message, "error"))}>
                  <i className="ri-file-text-line mr-1" aria-hidden="true" />{d.fileName}
                </button>
                {d.reason ? <span className="w-full text-xs text-foreground-600">Reason: {d.reason}</span> : null}
                <span className="flex items-center gap-3 text-xs text-foreground-500">
                  {new Date(d.createdAt).toLocaleDateString()}{d.uploadedBy ? ` · ${d.uploadedBy}` : ""}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(d)}>Remove</Button>
                </span>
              </li>
            ))}
          </ul>
        ) : docs ? <p className="mt-3 text-sm text-foreground-600">No signed copy uploaded.</p> : null}
      </details>

      {contact ? <SubjectSigningPanel type="agent" id={contact.agentId} name={contact.name} /> : null}
      </>}
    </div>
  );
}
