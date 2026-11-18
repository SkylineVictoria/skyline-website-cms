import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card } from "@/pages/admin/components/ui";
import SubjectSigningPanel from "@/pages/admin/components/signing/SubjectSigningPanel";
import AgentOnboardingPanel from "@/pages/admin/components/AgentOnboardingPanel";
import { useToast } from "@/pages/admin/components/toastContext";
import { listBusinessDocuments, openBusinessDocument, removeBusinessDocument, uploadBusinessDocument, type BusinessDetail, type BusinessDocument } from "@/pages/admin/lib/businessData";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.doc,.docx";

/**
 * The business's agent agreement: upload a signed copy, or send it to the business admin agent through Skyline Sign.
 * While the business is inactive it is shown as the onboarding checklist, ending with Activate & invite.
 */
export default function BusinessOnboarding({ business, onChanged, onActivate, activating }: {
  business: BusinessDetail;
  onChanged: () => Promise<void>;
  onActivate?: () => void;
  activating?: boolean;
}) {
  const { push } = useToast();
  const [docs, setDocs] = useState<BusinessDocument[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const onboarding = business.onboarding;
  const contact = onboarding?.contact ?? null;
  const ready = Boolean(onboarding?.agreementReady);
  const inactive = business.status !== "Active";

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
      {inactive ? (
        <Card className="p-5">
          <h2 className="font-heading text-base font-semibold text-foreground-950">Onboarding</h2>
          <p className="mt-1 text-sm text-foreground-600">The onboarding runs once for the business, with its point of contact: the application form (emailed when the business was added), two referee checks, staff review, the agent agreement. Nobody from the business can sign in until an administrator activates it. Agents can be added meanwhile; they get only their sign-in invitation, sent at Activate.</p>
          <ol className="mt-4 space-y-2 text-sm">
            <Step done={Boolean(contact)} label="Business admin agent (point of contact)" detail={contact ? `${contact.name}, ${contact.email}` : "Missing. Add business creates one; contact SLIT IT if it is missing."} />
            <Step done={ready} label="Signed agent agreement" detail={ready ? "Received: ready to activate." : "Follow the onboarding below (application form, referee checks, staff review, agreement), or upload a signed copy with a reason."} />
            <Step done={business.status === "Active"} label="Activated by an administrator" detail={contact ? `Press Activate: the business goes active, ${contact.email} gets the set-password email${onboarding?.heldAgents ? `, and ${onboarding.heldAgents} agent${onboarding.heldAgents === 1 ? "" : "s"} added meanwhile get their sign-in invitation` : ""}.` : "Needs a point of contact."} />
          </ol>
          {onActivate ? (
            <div className="mt-4">
              <Button icon="ri-mail-send-line" disabled={!ready || !contact || activating} onClick={onActivate} data-testid="onboarding-activate">{activating ? "Activating…" : "Activate"}</Button>
              {!ready ? <p className="mt-1 text-xs text-foreground-500">Available once the agent agreement is signed online, or a signed copy is uploaded with a reason.</p> : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <AgentOnboardingPanel business={business} onChanged={onChanged} />

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-heading text-base font-semibold text-foreground-950">Agent agreement (uploaded copies)</h2>
            <p className="text-sm text-foreground-600">Signed copies uploaded for this business (PDF, image or Word, up to 15 MB). A copy stands in for the online agreement, so it needs a reason, which is kept with the document and in the onboarding history; administrators only.</p>
          </div>
          <div className="flex items-center gap-2">
            {ready ? <Badge tone="success">Signed</Badge> : <Badge tone="warn">Not signed yet</Badge>}
            <Button size="sm" variant="outline" icon="ri-upload-2-line" disabled={busy || reason.trim().length < 5} title={reason.trim().length < 5 ? "Type the reason first" : undefined} onClick={() => file.current?.click()} data-testid="upload-agreement">{busy ? "Uploading…" : "Upload signed agreement"}</Button>
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
      </Card>

      {contact ? <SubjectSigningPanel type="agent" id={contact.agentId} name={contact.name} /> : null}
    </div>
  );
}

function Step({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <li className="flex gap-2">
      <i className={done ? "ri-checkbox-circle-fill text-green-600" : "ri-checkbox-blank-circle-line text-foreground-400"} aria-hidden="true" />
      <span><span className="font-medium text-foreground-900">{label}</span><span className="block text-xs text-foreground-600">{detail}</span></span>
    </li>
  );
}
