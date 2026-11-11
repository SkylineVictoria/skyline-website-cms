import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "../ui";
import ComposeRequest from "./ComposeRequest";
import RequestDetail from "./RequestDetail";
import { signedCount, signingAdmin, signingStatus, type SigningContext, type SigningRequest } from "@/lib/signingApi";
import { SIGN_CATEGORIES } from "../../../../../supabase/functions/_shared/signing";

/** On a student's, an employee's or an agent's record: the documents sent to them for signature with their status, and a button to send another. */
export default function SubjectSigningPanel({ type, id, name }: { type: "student" | "employee" | "agent"; id: string; name?: string }) {
  const [requests, setRequests] = useState<SigningRequest[] | null>(null);
  const [error, setError] = useState(""); const [openId, setOpenId] = useState<string | null>(null); const [placeAfterCreateId, setPlaceAfterCreateId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SigningContext["templates"] | null>(null);
  const load = useCallback(async () => setRequests(await signingAdmin<SigningRequest[]>("subject_list", id, { type })), [id, type]);
  const [hidden, setHidden] = useState(false);
  // Until the hosted database has the second-stage actions there is nothing to list: the panel stays out of the way.
  useEffect(() => { void load().catch((e: Error) => { if (/Unknown signing action|Signing request not found/i.test(e.message)) setHidden(true); else setError(e.message); }); }, [load]);
  if (hidden) return null;
  const examples = Object.values(SIGN_CATEGORIES).filter((c) => c.audience === type).map((c) => c.label.toLowerCase()).join(", ");
  return <Card className="p-5" >
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3" data-testid="subject-signing-panel">
      <div><h2 className="font-heading text-base font-semibold text-foreground-950">Documents &amp; signatures</h2><p className="text-sm text-foreground-600">Documents sent for signature ({examples}).</p></div>
      <Button size="sm" icon="ri-quill-pen-line" onClick={() => void signingAdmin<SigningContext>("list").then((c) => setTemplates(c.templates)).catch((e: Error) => setError(e.message))}>Send a document to sign</Button>
    </div>
    {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
    {!requests ? !error && <p role="status" className="text-sm">Loading…</p> : !requests.length ? <p className="text-sm text-foreground-600">Nothing has been sent for signature yet.</p>
      : <ul className="divide-y divide-background-200 text-sm">{requests.map((r) => { const s = signingStatus(r.status); return <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <button type="button" className="text-left" onClick={() => setOpenId(r.id)}><span className="font-medium text-primary-700 underline-offset-2 hover:underline">{r.title}</span>
          <span className="block text-xs text-foreground-500">{r.reference} · {SIGN_CATEGORIES[r.category]?.label ?? r.category} · {new Date(r.created_at).toLocaleDateString()}</span></button>
        <span className="flex items-center gap-2"><span className="text-xs text-foreground-600">{r.state === "draft" ? "Not sent" : signedCount(r)}</span><Badge tone={s.tone}>{s.label}</Badge></span></li>; })}</ul>}
    {templates && <ComposeRequest templates={templates} preset={{ type, id, name }} onClose={() => setTemplates(null)} onCreated={(r) => { setTemplates(null); void load(); setPlaceAfterCreateId(r.id); setOpenId(r.id); }} />}
    {openId && <RequestDetail id={openId} startPlacing={placeAfterCreateId === openId} onClose={() => { setOpenId(null); setPlaceAfterCreateId(null); }} onChanged={() => void load()} />}
  </Card>;
}
