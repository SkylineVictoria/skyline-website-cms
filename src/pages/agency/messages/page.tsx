import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeading, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";
import { supabase } from "@/pages/admin/lib/supabase";

type Message = { id: string; direction: "in" | "out"; channel: string; subject: string; body: string; at: string; by: string | null };
const CHANNEL_LABEL: Record<string, string> = { portal: "Message", email: "Email", sms: "Text message", whatsapp: "WhatsApp" };
const when = (at: string) => new Date(at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * Student portal › Messages (owner, 2026-11-23: a communication hub for students too). The student's conversation with SLIT: what
 * they write here and what SLIT staff send them (portal replies, emails, texts) in one thread, newest at the bottom; staff answer
 * from the Communication Hub. student_comm_thread / student_comm_send (20261123161517). Checked again every 20 seconds.
 */
export default function StudentMessagesPage() {
  const [items, setItems] = useState<Message[] | null>(null);
  const [error, setError] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const count = useRef(0);

  const load = useCallback(async () => {
    const { data, error: failed } = await supabase.rpc("student_comm_thread");
    if (failed) { setError(failed.message); return; }
    setError("");
    setItems((data as Message[] | null) ?? []);
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20000);
    return () => window.clearInterval(timer);
  }, [load]);
  // Scroll to the newest message when one arrives.
  useEffect(() => {
    if (items && items.length !== count.current) { count.current = items.length; endRef.current?.scrollIntoView({ block: "end" }); }
  }, [items]);

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true); setSendError("");
    const { error: failed } = await supabase.rpc("student_comm_send", { p_body: text });
    setSending(false);
    if (failed) { setSendError(failed.message); return; }
    setBody("");
    await load();
  };

  return (
    <div>
      <PageHeading eyebrow="Messages" title="Messages" description="Write to SLIT and read their replies. Emails and texts SLIT sends you show here too." />
      <div className="mt-6 flex min-h-[60vh] flex-col overflow-hidden rounded-card border border-background-200 bg-background-50">
        <div className="max-h-[60vh] flex-1 space-y-3 overflow-y-auto bg-background-100/40 p-4">
          {items === null && !error ? <PortalLoading label="Loading your messages…" /> : null}
          {error ? <PortalError message={error} /> : null}
          {items && !items.length ? <p className="py-10 text-center text-sm text-foreground-600">No messages yet. Ask SLIT anything below: your course, classes, documents or fees.</p> : null}
          {(items ?? []).map((m) => {
            const mine = m.direction === "in";
            return (
              <article key={m.id} className={`max-w-[85%] rounded-xl border px-3 py-2 text-sm ${mine ? "ml-auto border-primary-200 bg-primary-50" : "border-background-200 bg-white"}`}>
                <p className="mb-1 text-xs text-foreground-600">{mine ? "You" : m.by ?? "SLIT"} · {CHANNEL_LABEL[m.channel] ?? m.channel} · <time>{when(m.at)}</time></p>
                {m.subject ? <p className="font-semibold text-foreground-900">{m.subject}</p> : null}
                <p className="whitespace-pre-wrap break-words text-foreground-800">{m.body}</p>
              </article>
            );
          })}
          <div ref={endRef} />
        </div>
        <div className="space-y-2 border-t border-background-200 p-3">
          <label htmlFor="student-message" className="sr-only">Your message</label>
          <textarea id="student-message" rows={3} maxLength={4000} value={body} disabled={sending}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
            placeholder="Write your message to SLIT…"
            className="w-full rounded-lg border border-background-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40" />
          {sendError ? <p role="alert" className="text-sm text-red-700">{sendError}</p> : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground-500">Ctrl + Enter to send · SLIT staff reply here</span>
            <button type="button" onClick={() => void send()} disabled={!body.trim() || sending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">
              <i className="ri-send-plane-2-line" aria-hidden="true" />{sending ? "Sending…" : "Send"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
