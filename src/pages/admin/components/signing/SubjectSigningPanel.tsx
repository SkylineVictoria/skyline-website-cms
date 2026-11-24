import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "../ui";
import ComposeRequest from "./ComposeRequest";
import RequestDetail from "./RequestDetail";
import PaymentBadge from "./PaymentBadge";
import { signedCount, signingAdmin, signingStatus, type SigningContext, type SigningRequest } from "@/lib/signingApi";
import { SIGN_CATEGORIES } from "../../../../../supabase/functions/_shared/signing";
import { AGENT_ONBOARDING_DOCS } from "../../../../../supabase/functions/_shared/agent-onboarding";

/** 2026-11-18: the Agent Application Form goes by itself (Add business, corrections); it is never chosen here (document-signing refuses it too). */
const withoutF04 = (templates: SigningContext["templates"]) => templates.filter((t) => (t as { system_key?: string | null }).system_key !== AGENT_ONBOARDING_DOCS.form.key);

/** On a student's, an employee's or an agent's record: the documents sent to them for signature with their status, and a button to send another. */
export default function SubjectSigningPanel({ type, id, name, title = "Documents & signatures", intro, buttonLabel = "Send a document to sign", alsoAgentId }: {
  type: "student" | "employee" | "agent" | "agency"; id: string; name?: string;
  /** The business Documents tab (2026-11-24): "Send for signature" of amendments to the agency admin, whose name and email fill in by themselves. */
  title?: string; intro?: string; buttonLabel?: string;
  /** A business: requests sent earlier to its agency admin as an agent are listed with the business's own. */
  alsoAgentId?: string;
}) {
  const [requests, setRequests] = useState<SigningRequest[] | null>(null);
  const [error, setError] = useState(""); const [openId, setOpenId] = useState<string | null>(null); const [placeAfterCreateId, setPlaceAfterCreateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SigningContext["templates"] | null>(null);
  const load = useCallback(async () => {
    const own = await signingAdmin<SigningRequest[]>("subject_list", id, { type });
    const agent = alsoAgentId ? await signingAdmin<SigningRequest[]>("subject_list", alsoAgentId, { type: "agent" }).catch(() => [] as SigningRequest[]) : [];
    const seen = new Set(own.map((r) => r.id));
    setRequests([...own, ...agent.filter((r) => !seen.has(r.id))].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }, [id, type, alsoAgentId]);
  const [source, setSource] = useState<"template" | "upload">("template");
  const [hidden, setHidden] = useState(false);
  // Until the hosted database has the second-stage actions there is nothing to list: the panel stays out of the way.
  useEffect(() => { void load().catch((e: Error) => { if (/Unknown signing action|Signing request not found/i.test(e.message)) setHidden(true); else setError(e.message); }); }, [load]);
  if (hidden) return null;
  const examples = Object.values(SIGN_CATEGORIES).filter((c) => c.audience === type).map((c) => c.label.toLowerCase()).join(", ");
  return <Card className="p-5" >
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3" data-testid="subject-signing-panel">
      <div className="min-w-0"><h2 className="font-heading text-base font-semibold text-foreground-950">{title}</h2><p className="text-sm text-foreground-600">{intro ?? `Documents sent for signature (${examples}).`}</p></div>
      <Button size="sm" icon="ri-quill-pen-line" className="w-full sm:w-auto" data-testid="send-for-signature" onClick={() => void signingAdmin<SigningContext>("list").then((c) => {
        const list = withoutF04(c.templates);
        // No active template for this kind of record: start on "One-time sign (upload PDF)" (an amendment is usually its own PDF).
        setSource(list.some((t) => t.status === "active" && t.kind !== "email" && (t.audience === "any" || t.audience === type)) ? "template" : "upload");
        setTemplates(list);
      }).catch((e: Error) => setError(e.message))}>{buttonLabel}</Button>
    </div>
    {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
    {!requests ? !error && <p role="status" className="text-sm">Loading…</p> : !requests.length ? <p className="text-sm text-foreground-600">Nothing has been sent for signature yet.</p>
      : <ul className="divide-y divide-background-200 text-sm">{requests.map((r) => { const s = signingStatus(r.status); return <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <button type="button" className="text-left" onClick={() => setOpenId(r.id)}><span className="font-medium text-primary-700 underline-offset-2 hover:underline">{r.title}</span>
          <span className="block text-xs text-foreground-500">{r.reference} · {SIGN_CATEGORIES[r.category]?.label ?? r.category} · {new Date(r.created_at).toLocaleDateString()}</span></button>
        <span className="flex flex-wrap items-center gap-2"><span className="text-xs text-foreground-600">{r.state === "draft" ? "Not sent" : signedCount(r)}</span>{r.payment && <PaymentBadge payment={r.payment} />}<Badge tone={s.tone}>{s.label}</Badge></span></li>; })}</ul>}
    {templates && <ComposeRequest templates={templates} preset={{ type, id, name }} initialSource={source} onClose={() => setTemplates(null)} onOfferSent={() => { setTemplates(null); setError(""); void load(); }} onCreated={(r, warning) => { setTemplates(null); setError(warning ?? ""); void load(); setPlaceAfterCreateId(r.id); setOpenId(r.id); }} />}
    {openId && <RequestDetail id={openId} startPlacing={placeAfterCreateId === openId} onClose={() => { setOpenId(null); setPlaceAfterCreateId(null); }} onChanged={() => void load()} />}
  </Card>;
}
