import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Modal, TextInput } from "../ui";
import FieldEditor, { type EditorField } from "@/components/signing/FieldEditor";
import { RECIPIENT_STATE, signingAction, signingAdmin, signingStatus, type SigningDetail } from "@/lib/signingApi";
import { SIGN_CATEGORIES } from "../../../../../supabase/functions/_shared/signing";
import { signingEventLabel } from "./labels";

const time = (value: string | null) => value ? new Date(value).toLocaleString() : "";
type Check = { ok: boolean; chainOk: boolean; files: Array<{ name: string; ok: boolean; sha256: string }> };

/** One request: its recipients and where each is up to, the document, the fields (while it is a draft), send / resend / void, the integrity check and the full history. */
export default function RequestDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<SigningDetail | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [placing, setPlacing] = useState<{ url: string; fields: EditorField[] } | null>(null);
  const [voiding, setVoiding] = useState(false); const [reason, setReason] = useState(""); const [verified, setVerified] = useState<Check | null>(null);
  const load = useCallback(async () => setDetail(await signingAdmin<SigningDetail>("detail", id)), [id]);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);
  const act = async (work: () => Promise<unknown>, message = "") => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await work(); await load(); onChanged(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };
  const openFile = (which: "document" | "certificate" | "original") => act(async () => { window.open((await signingAction<{ url: string }>({ action: "admin_url", id, which })).url, "_blank", "noopener"); });
  if (!detail) return <Modal open title="Signing request" onClose={onClose}>{error ? <p role="alert" className="text-red-700">{error}</p> : <p role="status">Loading…</p>}</Modal>;
  const status = signingStatus(detail.status), open = ["sent", "viewed", "partial"].includes(detail.status), draft = detail.state === "draft";

  if (placing) return <Modal open title={`Place fields: ${detail.title}`} width="max-w-6xl" onClose={() => setPlacing(null)}
    footer={<Button disabled={busy} data-testid="save-fields" onClick={() => void act(async () => {
      await signingAdmin("fields_save", id, { fields: placing.fields.map((f) => ({ recipient_id: f.owner, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label })) }); setPlacing(null);
    }, "Fields saved.")}>Save fields</Button>}>
    {error && <p role="alert" className="mb-3 rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
    <FieldEditor source={placing.url} owners={detail.recipients.map((r) => ({ id: r.id, label: `${r.role_label}: ${r.name}` }))} fields={placing.fields} onChange={(fields) => setPlacing({ ...placing, fields })} />
  </Modal>;

  return <Modal open title={detail.title} width="max-w-4xl" onClose={onClose}>
    <div className="space-y-5 text-sm">
      {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded border border-green-300 p-3">{notice}</p>}
      <div className="flex flex-wrap items-center gap-3"><Badge tone={status.tone}>{status.label}</Badge><span className="font-mono text-xs">{detail.reference}</span>
        <span>{SIGN_CATEGORIES[detail.category]?.label ?? detail.category}</span><span>{detail.signing_mode === "parallel" ? "Everyone at once" : "One after another"}</span>
        {detail.expires_at && <span>{detail.status === "expired" ? "Expired" : "Expires"} {time(detail.expires_at)}</span>}</div>
      {detail.closed_reason && <p className="rounded border border-background-300 p-3">Reason: {detail.closed_reason}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void openFile("document")}>{detail.state === "signed" ? "Download signed PDF" : "Open document"}</Button>
        {detail.state === "signed" && <Button variant="outline" disabled={busy} onClick={() => void openFile("certificate")}>Completion certificate</Button>}
        {detail.state !== "draft" && <Button variant="outline" disabled={busy} onClick={() => void openFile("original")}>Original</Button>}
        {draft && <Button variant="outline" disabled={busy} data-testid="place-fields" onClick={() => void act(async () => {
          const url = (await signingAction<{ url: string }>({ action: "admin_url", id, which: "original" })).url;
          setPlacing({ url, fields: detail.fields.map((f, i) => ({ key: `r${i}`, type: f.type, owner: f.recipient_id, page: f.page, x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h), required: f.required, label: f.label })) });
        })}>Place fields ({detail.fields.length})</Button>}
        {draft && <Button disabled={busy} data-testid="send-request" onClick={() => { if (window.confirm(`Send “${detail.title}” for signature? ${detail.signing_mode === "parallel" ? "Every recipient" : "The first signer"} is emailed now.`)) void act(() => signingAction({ action: "send", id }), "Sent for signature."); }}>Send for signature</Button>}
        {draft && <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm("Discard this draft?")) void act(() => signingAdmin("delete_draft", id), "Draft discarded."); }}>Discard draft</Button>}
        {open && <Button variant="outline" disabled={busy} onClick={() => setVoiding(true)}>Void</Button>}
        {detail.state !== "draft" && <Button variant="outline" disabled={busy} onClick={() => void act(async () => setVerified(await signingAction<Check>({ action: "verify", id })))}>Check integrity</Button>}
      </div>
      {voiding && <div className="space-y-2 rounded-md border border-background-300 p-3"><p className="font-semibold">Void this request? Every link stops working and reminders stop.</p>
        <TextInput value={reason} maxLength={500} placeholder="Reason (optional, kept in the history)" onChange={(e) => setReason(e.target.value)} />
        <div className="flex gap-2"><Button variant="danger" disabled={busy} onClick={() => void act(async () => { await signingAction({ action: "void", id, reason }); setVoiding(false); }, "Request voided.")}>Void request</Button><Button variant="outline" onClick={() => setVoiding(false)}>Cancel</Button></div></div>}
      {verified && <div role="status" className={`rounded-md border p-3 ${verified.ok ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
        <p className="font-semibold">{verified.ok ? "Nothing has been changed since it was recorded." : "A change was detected. Do not rely on this record until it is investigated."}</p>
        <ul className="mt-1 list-inside list-disc"><li>History chain: {verified.chainOk ? "intact" : "BROKEN"}</li>{verified.files.map((f) => <li key={f.name}>{f.name}: {f.ok ? "matches its recorded SHA-256" : "DOES NOT match its recorded SHA-256"}</li>)}</ul></div>}

      <section><h3 className="mb-2 font-semibold">Recipients</h3>
        <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left"><thead className="text-xs text-foreground-500"><tr><th className="py-1 pr-3">Order</th><th className="pr-3">Recipient</th><th className="pr-3">Role</th><th className="pr-3">Status</th><th /></tr></thead>
          <tbody>{detail.recipients.map((r) => <tr key={r.id} className="border-t border-background-200 align-top"><td className="py-2 pr-3">{detail.signing_mode === "parallel" ? "–" : r.signing_order}</td>
            <td className="pr-3"><p className="font-medium">{r.name}</p><p className="text-foreground-600">{r.email}</p></td><td className="pr-3">{r.role_label}{r.required ? "" : " (optional)"}</td>
            <td className="pr-3"><p>{RECIPIENT_STATE[r.state] ?? r.state}{r.state === "signed" && r.signature_kind ? ` (${r.signature_kind})` : ""}</p>
              <p className="text-xs text-foreground-500">{r.signed_at ? `Signed ${time(r.signed_at)}` : r.declined_at ? `Declined ${time(r.declined_at)}` : r.viewed_at ? `Opened ${time(r.viewed_at)}` : r.sent_at ? `Invited ${time(r.sent_at)}` : ""}{r.reminder_count ? ` · ${r.reminder_count} reminder${r.reminder_count === 1 ? "" : "s"}` : ""}</p>
              {r.decline_reason && <p className="text-xs">Reason: {r.decline_reason}</p>}{r.delivery_error && <p className="text-xs text-red-700">{r.delivery_error}</p>}</td>
            <td className="py-2 text-right">{open && ["sent", "viewed"].includes(r.state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => signingAction({ action: "resend", id, recipientId: r.id }), `Invitation sent again to ${r.email}.`)}>Resend</Button>}</td></tr>)}</tbody></table></div></section>
      <section><h3 className="mb-2 font-semibold">History</h3>
        <ol className="space-y-1">{detail.events.map((e) => <li key={e.id} className="flex flex-wrap gap-x-3"><span className="w-40 shrink-0 text-foreground-500">{time(e.at)}</span><span>{signingEventLabel(e.event)}{e.recipient_name ? ` ${e.recipient_name}` : ""}{e.event.startsWith("email_") && e.detail?.kind ? ` (${String(e.detail.kind)})` : ""}</span></li>)}</ol>
        <p className="mt-2 text-xs text-foreground-500">History chain {detail.chain_ok ? "intact" : "BROKEN"}. Original SHA-256 {detail.original_hash}{detail.signed_hash ? `. Signed SHA-256 ${detail.signed_hash}` : ""}</p></section>
      {detail.notifications.length > 0 && <section><h3 className="mb-2 font-semibold">Emails</h3>
        <ul className="space-y-1">{detail.notifications.map((n) => <li key={n.id}>{n.kind} to {n.audience === "admin" ? "the sender" : detail.recipients.find((r) => r.id === n.recipient_id)?.email ?? "recipient"}: {n.state}{n.sent_at ? ` ${time(n.sent_at)}` : ""}{n.error ? ` (${n.error})` : ""}</li>)}</ul></section>}
    </div>
  </Modal>;
}
