import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import WhatsAppLink from "@/components/base/WhatsAppLink";
import {
  CATEGORY_LABEL, PRIORITY_LABEL, STATUS_CLASS, STATUS_LABEL, getTicket, openTicketFile, replyTicket, ticketRequesterPhone, updateTicket, uploadTicketFiles,
  type TicketDetail, type TicketPriority, type TicketStatus,
} from "@/lib/supportTickets";

/** One ticket: header, actions (administrators: status / priority / assign; requester: mark resolved), thread and reply box. */
export default function TicketView({ id, backTo }: { id: string; backTo: string }) {
  const [data, setData] = useState<TicketDetail | null>(null);
  const [error, setError] = useState("");
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [phone, setPhone] = useState("");

  const load = useCallback(async () => {
    try { setData(await getTicket(id)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "We could not load this ticket."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const isHandler = data?.isHandler ?? false, requesterEmail = data?.ticket.requesterEmail ?? null, studentId = data?.ticket.studentId ?? null, requesterRole = data?.ticket.requesterRole ?? "agent";
  useEffect(() => {
    if (!isHandler) return undefined;
    let active = true;
    ticketRequesterPhone({ requesterEmail, studentId, requesterRole }).then((p) => { if (active) setPhone(p); }).catch(() => undefined);
    return () => { active = false; };
  }, [isHandler, requesterEmail, studentId, requesterRole]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setActionError("");
    try { await fn(); await load(); return true; } catch (e) { setActionError(e instanceof Error ? e.message : "That could not be done."); return false; }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!body.trim()) return;
    const ok = await run(async () => { const attachments = await uploadTicketFiles(files); await replyTicket(id, body.trim(), internal, attachments); });
    if (ok) { setBody(""); setInternal(false); setFiles([]); setFileKey((k) => k + 1); }
  };
  const open = (path: string) => { openTicketFile(path).catch((e) => setActionError(e instanceof Error ? e.message : "The file could not be opened.")); };

  if (error) return <div><p role="alert" className="text-sm text-red-700">{error}</p><Link to={backTo} className="mt-3 inline-block text-sm font-semibold text-primary-700 underline">Back to tickets</Link></div>;
  if (!data) return <p className="text-sm text-foreground-600">Loading ticket&hellip;</p>;
  const t = data.ticket;
  const field = "rounded-md border border-background-300 px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      <Link to={backTo} className="text-sm font-semibold text-primary-700 hover:underline">&larr; All tickets</Link>
      <header className="rounded-lg border border-background-200 bg-white p-5">
        <p className="font-mono text-xs text-foreground-500">{t.ref}</p>
        <h1 className="mt-1 font-heading text-xl font-bold text-foreground-950">{t.subject}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-foreground-700">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[t.status]}`}>{STATUS_LABEL[t.status]}</span>
          <span>{CATEGORY_LABEL[t.category]}</span><span aria-hidden="true">&middot;</span><span>Priority {PRIORITY_LABEL[t.priority]}</span>
          <span aria-hidden="true">&middot;</span><span>Raised by {t.requesterName}{t.requesterRole === "student" ? " (student)" : t.agencyName ? ` (${t.agencyName})` : ""}{data.isHandler ? <WhatsAppLink phone={phone} name={t.requesterName} /> : null}</span>
          {t.studentName && t.requesterRole !== "student" ? <><span aria-hidden="true">&middot;</span><span>About {t.studentName}</span></> : null}
          {data.isHandler && t.requesterEmail ? <><span aria-hidden="true">&middot;</span><a className="underline" href={`mailto:${t.requesterEmail}`}>{t.requesterEmail}</a></> : null}
        </p>
        {data.isHandler ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label className="text-sm text-foreground-700">Status{" "}
              <select className={field} value={t.status} disabled={busy} onChange={(e) => void run(() => updateTicket(id, { status: e.target.value as TicketStatus }))}>
                {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
            <label className="text-sm text-foreground-700">Priority{" "}
              <select className={field} value={t.priority} disabled={busy} onChange={(e) => void run(() => updateTicket(id, { priority: e.target.value as TicketPriority }))}>
                {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </label>
            <span className="text-sm text-foreground-700">Assigned: <strong>{t.assignedName ?? "Nobody"}</strong></span>
            {t.assignedToMe
              ? <button type="button" disabled={busy} className="rounded-md border border-background-300 px-3 py-1.5 text-sm" onClick={() => void run(() => updateTicket(id, { assign: "none" }))}>Unassign</button>
              : <button type="button" disabled={busy} className="rounded-md border border-background-300 px-3 py-1.5 text-sm" onClick={() => void run(() => updateTicket(id, { assign: "me" }))}>Assign to me</button>}
          </div>
        ) : data.isRequester && !["resolved", "closed"].includes(t.status) ? (
          <button type="button" disabled={busy} className="mt-4 rounded-md border border-background-300 px-3 py-1.5 text-sm font-semibold"
            onClick={() => void run(() => updateTicket(id, { status: "resolved" }))}>Mark as resolved</button>
        ) : null}
        {actionError ? <p role="alert" className="mt-3 text-sm text-red-700">{actionError}</p> : null}
      </header>

      <ol className="space-y-3">
        {data.messages.map((m) => m.kind === "event" ? (
          <li key={m.id} className="px-2 text-center text-xs text-foreground-500">{m.body} &middot; {m.authorName} &middot; {new Date(m.createdAt).toLocaleString()}</li>
        ) : (
          <li key={m.id} className={`rounded-lg border p-4 ${m.internal ? "border-amber-300 bg-amber-50" : m.fromStaff ? "border-primary-200 bg-primary-50" : "border-background-200 bg-white"}`}>
            <p className="text-xs text-foreground-600">
              <strong className="text-foreground-900">{m.authorName}</strong>{m.fromStaff ? " · Skyline support" : ""}{m.internal ? " · Internal note" : ""} · {new Date(m.createdAt).toLocaleString()}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground-900">{m.body}</p>
            {m.attachments.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {m.attachments.map((a) => (
                  <li key={a.path}><button type="button" onClick={() => open(a.path)} className="inline-flex items-center gap-1 rounded-md border border-background-300 bg-white px-2 py-1 text-xs hover:bg-background-50">
                    <i className="ri-attachment-2" aria-hidden="true" />{a.name}
                  </button></li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>

      {data.canReply ? (
        <form className="space-y-3 rounded-lg border border-background-200 bg-white p-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="block text-sm font-medium text-foreground-800">Reply
            <textarea className="mt-1 block min-h-[110px] w-full rounded-md border border-background-300 px-3 py-2 text-sm" maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <input key={fileKey} type="file" multiple aria-label="Attach files" className="block w-full text-sm" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx,.xls,.xlsx"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} />
          {data.isHandler ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />Internal note (not shown to the requester)</label> : null}
          <button type="submit" disabled={busy || !body.trim()} className="rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">
            {busy ? "Sending…" : internal ? "Add note" : "Send reply"}
          </button>
        </form>
      ) : <p className="text-sm text-foreground-600">This ticket is closed. Raise a new ticket if you still need help.</p>}
    </div>
  );
}
