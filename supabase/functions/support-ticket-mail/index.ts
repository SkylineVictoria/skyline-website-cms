// support-ticket-mail: sends ticket emails (notification_deliveries with event support_ticket_*) through Postmark with
// both an HTML and a plain-text body. Called every minute by public.support_mail_dispatch() (pg_cron + pg_net) with the
// project's service-role key; verify_jwt stays on. The application worker (notification-delivery) never claims these rows.
// Same claim / lease / record rules as notification-delivery: claim via support_mail_claim(), record via notification_record_attempt().
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const enabled = (Deno.env.get("EF_NOTIFICATION_EMAIL_ENABLED") ?? "").trim() === "true";
const postmarkToken = (Deno.env.get("EF_POSTMARK_SERVER_TOKEN") ?? "").trim();
const POSTMARK_API = "https://api.postmarkapp.com/email";
const MESSAGE_ID = /^[A-Za-z0-9-]{8,64}$/;
const BATCH = 20;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Only this project's service_role token may run the worker (the gateway has verified the signature: verify_jwt = true). */
function authorized(header: string | null): 200 | 401 | 403 {
  const token = /^Bearer (.+)$/.exec((header ?? "").trim())?.[1] ?? "";
  if (!token) return 401;
  const parts = token.split(".");
  if (parts.length !== 3) return 403;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as { role?: string; ref?: string };
    if (claims.role !== "service_role") return 403;
    const host = new URL(url).hostname;
    const ref = host.endsWith(".supabase.co") ? host.split(".")[0] : null;
    if (ref && claims.ref && claims.ref !== ref) return 403;
    return 200;
  } catch { return 403; }
}

function formatFrom(name: string, email: string): string {
  // deno-lint-ignore no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 100).replace(/[\\"]/g, "\\$&");
  return `"${clean}" <${email}>`;
}

type Outcome = { outcome: "accepted"; messageId: string } | { outcome: "failed" | "unknown"; code: string; retry: boolean };

async function send(d: Record<string, unknown>): Promise<Outcome> {
  const sender = d.sender as { name?: string; email?: string; replyTo?: string } | null;
  if (!sender?.email || !sender?.name) return { outcome: "failed", code: "no_sender", retry: false };
  let response: Response;
  try {
    response = await fetch(POSTMARK_API, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": postmarkToken },
      body: JSON.stringify({
        From: formatFrom(sender.name, sender.email), ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}),
        To: String(d.recipient_email), Subject: String(d.subject), TextBody: String(d.body),
        ...(typeof d.html_body === "string" && d.html_body ? { HtmlBody: d.html_body } : {}),
        MessageStream: "outbound", Metadata: { deliveryId: String(d.id) }, TrackOpens: false, TrackLinks: "None",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // May or may not have reached Postmark: never resent automatically.
    return { outcome: "unknown", code: (error as Error)?.name === "TimeoutError" ? "timeout" : "network", retry: false };
  }
  if (response.status === 429) return { outcome: "failed", code: "rate_limit", retry: true };
  if (response.status >= 500) return { outcome: "failed", code: "provider", retry: true };
  if (response.status === 401) return { outcome: "failed", code: "unauthorized", retry: false };
  let body: Record<string, unknown> | null = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 200 && body?.ErrorCode === 0 && typeof body.MessageID === "string" && MESSAGE_ID.test(body.MessageID)) {
    return { outcome: "accepted", messageId: body.MessageID };
  }
  const code = typeof body?.ErrorCode === "number" ? body.ErrorCode : 0;
  if (code === 406) return { outcome: "failed", code: "inactive_recipient", retry: false };
  if (code === 300) return { outcome: "failed", code: "invalid_recipient", retry: false };
  if (code === 400 || code === 401) return { outcome: "failed", code: "sender_rejected", retry: false };
  return { outcome: "failed", code: "rejected", retry: false };
}

async function worker(): Promise<Response> {
  if (!enabled || !postmarkToken) return json({ error: "Email sending is not configured." }, 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  let sent = 0, failed = 0;
  for (let i = 0; i < BATCH; i++) {
    const { data, error } = await admin.rpc("support_mail_claim");
    if (error) return json({ ok: false, error: "claim failed", sent, failed }, 500);
    const d = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!d) break;
    const result = await send(d);
    const { error: recordError } = await admin.rpc("notification_record_attempt", {
      p_id: d.id, p_lease: d.lease_token, p_outcome: result.outcome,
      p_message_id: result.outcome === "accepted" ? result.messageId : null,
      p_error: result.outcome === "accepted" ? null : result.code,
      p_retry: result.outcome === "failed" ? result.retry : false, p_delay: 60,
    });
    if (recordError) console.error(JSON.stringify({ event: "support_mail_record_failed" }));
    if (result.outcome === "accepted") sent++; else failed++;
  }
  return json({ ok: true, sent, failed });
}

Deno.serve(async (request) => {
  if (!url || !serviceKey) return json({ error: "Edge Function configuration is unavailable." }, 503);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const status = authorized(request.headers.get("authorization"));
  if (status !== 200) return json({ error: status === 401 ? "Unauthorized." : "Forbidden." }, status);
  try { return await worker(); }
  catch { return json({ ok: false, error: "Worker stopped unexpectedly." }, 500); }
});
