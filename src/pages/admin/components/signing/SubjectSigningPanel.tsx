import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "../ui";
import ComposeRequest from "./ComposeRequest";
import RequestDetail from "./RequestDetail";
import PaymentBadge from "./PaymentBadge";
import { signedCount, signingAction, signingAdmin, signingStatus, type SigningContext, type SigningRequest } from "@/lib/signingApi";
import { SIGN_CATEGORIES } from "../../../../../supabase/functions/_shared/signing";
import { AGENT_ONBOARDING_DOCS } from "../../../../../supabase/functions/_shared/agent-onboarding";

/** 2026-11-18: the Agent Application Form goes by itself (Add business, corrections); it is never chosen here (document-signing refuses it too). */
const withoutF04 = (templates: SigningContext["templates"]) => templates.filter((t) => (t as { system_key?: string | null }).system_key !== AGENT_ONBOARDING_DOCS.form.key);

/** On a student's, an employee's or an agent's record: the documents sent to them for signature with their status, and a button to send another. */
export default function SubjectSigningPanel({ type, id, name }: { type: "student" | "employee" | "agent" | "agency"; id: string; name?: string }) {
  const [requests, setRequests] = useState<SigningRequest[] | null>(null);
  const [error, setError] = useState(""); const [openId, setOpenId] = useState<string | null>(null); const [placeAfterCreateId, setPlaceAfterCreateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SigningContext["templates"] | null>(null);
  const load = useCallback(async () => setRequests(await signingAdmin<SigningRequest[]>("subject_list", id, { type })), [id, type]);
  const [hidden, setHidden] = useState(false);
  // Resend (owner 2026-11-24): emails the signing link again to whoever has not signed yet (the same action as Resend in the request).
  const [sending, setSending] = useState(""); const [note, setNote] = useState("");
  const waiting = (r: SigningRequest) => ["sent", "viewed", "partial"].includes(r.status) ? (r.recipients ?? []).filter((x) => x.state === "sent" || x.state === "viewed") : [];
  const resend = async (r: SigningRequest) => {
    setSending(r.id); setError(""); setNote("");
    try {
      const to = waiting(r);
      for (const x of to) await signingAction({ action: "resend", id: r.id, recipientId: x.id });
      setNote(`Invitation sent again to ${to.map((x) => x.email).join(", ")}.`); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "We could not resend it."); } finally { setSending(""); }
  };
  // Until the hosted database has the second-stage actions there is nothing to list: the panel stays out of the way.
  useEffect(() => { void load().catch((e: Error) => { if (/Unknown signing action|Signing request not found/i.test(e.message)) setHidden(true); else setError(e.message); }); }, [load]);
  if (hidden) return null;
  const examples = Object.values(SIGN_CATEGORIES).filter((c) => c.audience === type).map((c) => c.label.toLowerCase()).join(", ");
  return <Card className="p-5" >
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3" data-testid="subject-signing-panel">
      <div><h2 className="font-heading text-base font-semibold text-foreground-950">Documents &amp; signatures</h2><p className="text-sm text-foreground-600">Documents sent for signature ({examples}).</p></div>
      <Button size="sm" icon="ri-quill-pen-line" onClick={() => void signingAdmin<SigningContext>("list").then((c) => setTemplates(withoutF04(c.templates))).catch((e: Error) => setError(e.message))}>Send a document to sign</Button>
    </div>
    {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
    {note && <p role="status" className="mb-2 text-sm text-emerald-800">{note}</p>}
    {!requests ? !error && <p role="status" className="text-sm">Loading…</p> : !requests.length ? <p className="text-sm text-foreground-600">Nothing has been sent for signature yet.</p>
      : <ul className="divide-y divide-background-200 text-sm">{requests.map((r) => { const s = signingStatus(r.status); return <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <button type="button" className="text-left" onClick={() => setOpenId(r.id)}><span className="font-medium text-primary-700 underline-offset-2 hover:underline">{r.title}</span>
          <span className="block text-xs text-foreground-500">{r.reference} · {SIGN_CATEGORIES[r.category]?.label ?? r.category} · {new Date(r.created_at).toLocaleDateString()}</span></button>
        <span className="flex flex-wrap items-center gap-2"><span className="text-xs text-foreground-600">{r.state === "draft" ? "Not sent" : signedCount(r)}</span>{r.payment && <PaymentBadge payment={r.payment} />}<Badge tone={s.tone}>{s.label}</Badge>
          {waiting(r).length ? <Button size="sm" variant="outline" icon="ri-mail-send-line" disabled={!!sending} title={`Email the signing link again to ${waiting(r).map((x) => x.email).join(", ")}`} onClick={() => void resend(r)} data-testid={`resend-${r.reference}`}>{sending === r.id ? "Sending…" : "Resend"}</Button> : null}</span></li>; })}</ul>}
    {templates && <ComposeRequest templates={templates} preset={{ type, id, name }} onClose={() => setTemplates(null)} onOfferSent={() => { setTemplates(null); setError(""); void load(); }} onCreated={(r, warning) => { setTemplates(null); setError(warning ?? ""); void load(); setPlaceAfterCreateId(r.id); setOpenId(r.id); }} />}
    {openId && <RequestDetail id={openId} startPlacing={placeAfterCreateId === openId} onClose={() => { setOpenId(null); setPlaceAfterCreateId(null); }} onChanged={() => void load()} />}
  </Card>;
}
