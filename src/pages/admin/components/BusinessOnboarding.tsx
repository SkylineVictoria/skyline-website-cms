import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/pages/admin/components/ui";
import SubjectSigningPanel from "@/pages/admin/components/signing/SubjectSigningPanel";
import AgentOnboardingPanel from "@/pages/admin/components/AgentOnboardingPanel";
import { useToast } from "@/pages/admin/components/toastContext";
import BusinessDocumentActions, { DocumentRow } from "@/pages/admin/components/BusinessDocumentActions";
import { listBusinessDocuments, type BusinessDetail, type BusinessDocument } from "@/pages/admin/lib/businessData";

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
  const onboarding = business.onboarding;
  const contact = onboarding?.contact ?? null;
  const ready = Boolean(onboarding?.agreementReady);

  const load = useCallback(async () => {
    try { setDocs(await listBusinessDocuments(business.id)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "We could not load documents."); }
  }, [business.id]);
  useEffect(() => { void load(); }, [load]);

  const agreements = (docs ?? []).filter((d) => d.kind === "agent_agreement");
  return (
    <div className="mb-6 space-y-4" data-testid="business-onboarding">
      {/* The Onboarding checklist was removed (owner 2026-11-24: "no need"); the panel below and the header's Activate cover it. */}
      {part === "onboarding" ? <AgentOnboardingPanel business={business} onChanged={onChanged} /> : <>
      <AgentOnboardingPanel business={business} onChanged={onChanged} view="documents" />

      <BusinessDocumentActions businessId={business.id} docs={docs} onDocsChanged={load} onChanged={onChanged} />

      <details className="rounded-card border border-background-200 bg-background-50 p-4" open={agreements.length > 0} data-testid="uploaded-agreements">
        <summary className="cursor-pointer text-sm font-medium text-foreground-800">Uploaded agreement copies{agreements.length ? ` (${agreements.length})` : ""}</summary>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-sm text-foreground-600">A signed agreement on paper: upload it above with kind Agreement and the reason. It stands in for the online agreement.</p>
          {ready ? <Badge tone="success">Signed</Badge> : <Badge tone="warn">Not signed yet</Badge>}
        </div>
        {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
        {docs && agreements.length ? (
          <ul className="mt-3 divide-y divide-background-200">
            {agreements.map((d) => <DocumentRow key={d.id} doc={d} onRemoved={async () => { await load(); await onChanged(); }} />)}
          </ul>
        ) : docs ? <p className="mt-3 text-sm text-foreground-600">No signed copy uploaded.</p> : null}
      </details>

      {/* Send for signature (2026-11-24): amendments and other documents to the business; the agency admin is filled in as the signer. */}
      <SubjectSigningPanel type="agency" id={business.id} name={business.name} alsoAgentId={contact?.agentId}
        title="Send for signature" buttonLabel="Send for signature"
        intro={`Amendments and other documents for ${business.name} to sign online. ${contact ? `${contact.name} (${contact.email}) is filled in as the signer` : "The agency admin is filled in as the signer"}; upload a PDF or use an agency template, place the fields, send.`} />
      </>}
    </div>
  );
}
