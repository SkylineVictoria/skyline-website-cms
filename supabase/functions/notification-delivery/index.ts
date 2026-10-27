import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { backendConfiguration } from "../_shared/config.ts";
import { authorizeWorker, dispatchBatch, selectEmailProvider, type ClaimedDelivery, type DeliveryPort } from "../_shared/notification/delivery.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const providerConfig: Record<string, string> = {};
for (const name of ["EF_NOTIFICATION_EMAIL_ENABLED", "EF_POSTMARK_SERVER_TOKEN"]) providerConfig[name] = Deno.env.get(name) ?? "";

const headers = { "Content-Type": "application/json" };
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
const BATCH = 10;

async function worker() {
  // Nothing is claimed unless sending is enabled and fully configured; values are never echoed.
  const selection = selectEmailProvider(providerConfig);
  if (!selection.provider) return reply({ error: "Edge Function configuration is unavailable.", code: selection.unavailable.code, variables: selection.unavailable.variables }, 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const port: DeliveryPort = {
    claim: async () => {
      const { data, error } = await admin.rpc("notification_claim_delivery");
      if (error) throw new Error("claim");
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      const sender = row.sender && typeof row.sender === "object" && typeof row.sender.email === "string" && typeof row.sender.name === "string" ? { name: String(row.sender.name), email: String(row.sender.email), replyTo: typeof row.sender.replyTo === "string" ? row.sender.replyTo : undefined } : null;
      return { id: row.id, leaseToken: row.lease_token, recipientEmail: row.recipient_email, subject: row.subject, body: row.body, sender, attempt: Number(row.attempt_count ?? 1), event: typeof row.event === "string" ? row.event : undefined } satisfies ClaimedDelivery;
    },
    submission: async (d) => {
      const { data, error } = await admin.rpc("notification_delivery_submission", { p_id: d.id, p_lease: d.leaseToken });
      if (error || !data || typeof data !== "object") return null;
      const info = data as Record<string, unknown>;
      return { mode: info.mode === "link" ? "link" : "attach", link: typeof info.link === "string" ? info.link : "", reference: String(info.reference ?? ""), version: Number(info.version ?? 0), institution: String(info.institution ?? ""), submittedAt: typeof info.submittedAt === "string" ? info.submittedAt : null, snapshot: info.snapshot ?? null };
    },
    coeDocument: async (d) => {
      const { data, error } = await admin.rpc("notification_delivery_coe_document", { p_id: d.id, p_lease: d.leaseToken });
      if (error) throw new Error("coe");
      if (!data || typeof data !== "object") return null;
      const doc = data as Record<string, unknown>;
      return { kind: doc.kind === "voe" ? "voe" : "coe", sizeBytes: Number(doc.sizeBytes ?? 0), contentBase64: String(doc.contentBase64 ?? ""), reference: String(doc.reference ?? "") };
    },
    record: async (d, outcome, messageId, errorCode, retry, delay) => {
      const { data, error } = await admin.rpc("notification_record_attempt", { p_id: d.id, p_lease: d.leaseToken, p_outcome: outcome, p_message_id: messageId, p_error: errorCode, p_retry: retry, p_delay: delay });
      if (error) throw new Error("record");
      return data === true;
    },
  };
  try {
    return reply({ ok: true, ...(await dispatchBatch(port, selection.provider, BATCH)) });
  } catch {
    // A claimed delivery whose outcome could not be stored becomes 'unknown' when its lease expires; it is never resent.
    return reply({ ok: false, error: "Delivery run stopped unexpectedly." }, 500);
  }
}

Deno.serve(async (request) => {
  const configuration = backendConfiguration(url, serviceKey);
  if (configuration) return reply(configuration, 503);
  if (request.method !== "POST") return reply({ ok: false, error: "Method not allowed." }, 405);
  // Postmark callbacks are disabled (410) until they can be authenticated without a shared secret; delivery states stay worker-driven.
  if (new URL(request.url).pathname.endsWith("/webhook")) return reply({ ok: false, error: "Webhook disabled." }, 410);
  // Platform authentication: config.toml verify_jwt = true rejects unsigned tokens; only the service-role key may run the worker.
  const status = await authorizeWorker(request.headers.get("authorization"), serviceKey);
  if (status !== 200) return reply({ ok: false, error: status === 401 ? "Unauthorized." : "Forbidden." }, status);
  return await worker();
});
