// payments: Stripe Checkout for things people pay for in Skyline (signing requests today, the offer letter's initial deposit among them).
// Saved into the repo 2026-11-16 from the hosted v1 (deployed by the payments backend session) with the receipt URL additions.
// verify_jwt = true. A link holder (signer, no account) calls with the anon key plus the token of their emailed signing link, exactly like
// document-signing. Administrators call with their session.
// Actions
//   status   {token}                 what is owed on this signing request (link holder)
//   checkout {token, returnUrl}      a Stripe Checkout URL for it (link holder)
//   confirm  {token}                 after the redirect back: re-reads the session from Stripe and records it (link holder)
//   refresh  {paymentId}             same as confirm, for an administrator
//   webhook_sync {tenantId}          creates or updates the Stripe webhook endpoint with the payment events (integration administrator)
// Secrets come from Vault through integration_credential_read and never leave this function. Amounts come only from public.payments.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-tenant-domain",
  "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const LINK_INVALID = "This signing link is invalid or expired.";
const PAYABLE = ["pending", "open", "failed"];
// charge.succeeded / charge.updated carry the receipt URL of a paid deposit (OFFER-DEPOSIT).
export const WEBHOOK_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "checkout.session.expired", "payment_intent.succeeded", "payment_intent.payment_failed", "charge.succeeded", "charge.updated", "charge.refunded",
  "invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"];

class Fail extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const sha256Hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

type Payment = { id: string; tenant_id: string | null; connection_id: string | null; subject_type: string; subject_id: string; description: string; amount_cents: number;
  currency: string; timing: string; status: string; payer_email: string | null; stripe_checkout_session_id: string | null; checkout_url: string | null;
  checkout_expires_at: string | null; checkout_count: number; paid_at: string | null; failure_reason: string | null; amount_paid_cents: number | null; livemode: boolean | null; receipt_url?: string | null };

/** Where Stripe may send the payer back to: the CMS, any slit.edu.au site, local development, plus EF_PAYMENT_RETURN_ORIGINS (comma separated). */
function returnUrlAllowed(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u: URL; try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  const extra = (Deno.env.get("EF_PAYMENT_RETURN_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = new Set(["https://skyline-website-cms.vercel.app", ...extra]);
  if (allowed.has(u.origin)) return u;
  if (u.protocol === "https:" && (u.hostname === "slit.edu.au" || u.hostname.endsWith(".slit.edu.au"))) return u;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const url = Deno.env.get("SUPABASE_URL") ?? "", anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "", serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const authorization = req.headers.get("Authorization") ?? "";
  const caller = createClient(url, anon, { global: { headers: { Authorization: authorization,
    ...(req.headers.get("x-tenant-domain") ? { "x-tenant-domain": req.headers.get("x-tenant-domain")! } : {}) } }, auth: { persistSession: false } });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64) || null;

  // ---------------------------------------------------------------- shared helpers
  const stripeKey = async (connectionId: string) => {
    const r = await db.rpc("integration_credential_read", { p_connection: connectionId, p_kind: "api_key" });
    if (r.error || typeof r.data !== "string" || !r.data) throw new Fail("Online payment is not set up yet. Please contact us.", 503);
    const raw = r.data as string;
    if (!raw.startsWith("{")) return { key: raw, account: undefined as string | undefined };
    // Signed in with Stripe (Connect): Skyline's platform key acting on the connected account.
    let stored: { token?: { stripe_account?: string } };
    try { stored = JSON.parse(raw); } catch { throw new Fail("Online payment is not set up correctly. Please contact us.", 503); }
    const account = stored?.token?.stripe_account, platform = Deno.env.get("EF_STRIPE_CLIENT_SECRET") ?? "";
    if (!account || !/^acct_[A-Za-z0-9]+$/.test(account) || !platform) throw new Fail("Online payment is not set up correctly. Please contact us.", 503);
    return { key: platform, account };
  };
  const stripe = async (connectionId: string, method: "GET" | "POST", path: string, form?: URLSearchParams, idempotency?: string) => {
    const { key, account } = await stripeKey(connectionId);
    const response = await fetch(`https://api.stripe.com/v1/${path}`, { method, body: form,
      headers: { Authorization: `Bearer ${key}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(account ? { "Stripe-Account": account } : {}),
        ...(idempotency ? { "Idempotency-Key": idempotency } : {}), "Stripe-Version": "2024-06-20" },
      signal: AbortSignal.timeout(15000), redirect: "error" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = body?.error?.code ?? body?.error?.type ?? response.status;
      await db.from("integration_logs").insert({ connection_id: connectionId, connector_id: "stripe", severity: "error", code: `payments_${String(code).slice(0, 60)}`,
        correlation_id: crypto.randomUUID() });
      throw new Fail(response.status === 401 || response.status === 403 ? "Online payment is not available right now. Please contact us." : "Stripe could not process this request. Please try again.", 502);
    }
    return body;
  };
  const stripeConnection = async (tenant: string | null) => {
    let q = db.from("integration_connections").select("id,status,tenant_id").eq("connector_id", "stripe");
    q = tenant ? q.eq("tenant_id", tenant) : q.is("tenant_id", null);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Fail("Online payment is not available right now.", 503);
    return data && data.status === "connected" ? data as { id: string; status: string; tenant_id: string | null } : null;
  };
  const loadPayment = async (column: "id" | "subject_id", value: string) => {
    let q = db.from("payments").select("*").eq(column, value);
    if (column === "subject_id") q = q.eq("subject_type", "sign_request");
    const { data, error } = await q.maybeSingle();
    if (error) throw new Fail("The payment could not be loaded.", 500);
    return data as Payment | null;
  };
  const view = (p: Payment | null, ready: boolean, signState?: string) => {
    if (!p || p.status === "canceled") return { required: false, payment: null };
    const paid = p.status === "paid";
    return { required: true, stripeReady: ready,
      mustPayBeforeSigning: p.timing === "before_sign" && !paid,
      canPay: ready && PAYABLE.includes(p.status) && (signState === undefined || ["sent", "viewed", "partial", "signed"].includes(signState)),
      payment: { id: p.id, description: p.description, amountCents: p.amount_cents, currency: p.currency.toUpperCase(), timing: p.timing, status: p.status,
        paidAt: p.paid_at, amountPaidCents: p.amount_paid_cents, failureReason: p.failure_reason, testMode: p.livemode === false, receiptUrl: p.receipt_url ?? null } };
  };
  const syncFromStripe = async (p: Payment) => {
    if (!p.stripe_checkout_session_id || !p.connection_id || p.status === "paid") return p;
    // The intent and its latest charge come with the session, so the receipt URL is recorded even when no webhook is set up yet.
    const session = await stripe(p.connection_id, "GET", `checkout/sessions/${encodeURIComponent(p.stripe_checkout_session_id)}?expand[]=payment_intent.latest_charge`);
    const r = await db.rpc("payment_apply_stripe", { p_connection: p.connection_id, p_type: "checkout.session.retrieved", p_object: session });
    if (r.error) throw new Fail("The payment could not be recorded. Please try again.", 500);
    return (await loadPayment("id", p.id)) ?? p;
  };

  try {
    const raw = await req.text(); if (raw.length > 8000) return json({ error: "Request too large." }, 413);
    let body: Record<string, unknown>; try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON." }, 400); }
    const action = String(body.action ?? "");

    // ---------------------------------------------------------------- link holders
    if (["status", "checkout", "confirm"].includes(action)) {
      const token = String(body.token ?? "");
      const rate = async (key: string, limit: number) => {
        const r = await db.rpc("signing_service", { p_action: "rate", p_hash: null, p_id: null, p_data: { key, limit, seconds: 600 } });
        return r.data === false;
      };
      if (ip && await rate(`pay:${ip.replace(/[^A-Za-z0-9.:_-]/g, "").slice(0, 60) || "unknown"}`, 60)) throw new Fail("Too many requests. Please wait a few minutes and try again.", 429);
      if (!TOKEN.test(token)) throw new Fail(LINK_INVALID, 403);
      const hash = await sha256Hex(token);
      // The signing service validates the link (live token, open or completed request, not expired) the same way the signing page does.
      const opened = await db.rpc("signing_service", { p_action: "open", p_hash: hash, p_id: null, p_data: { ip } });
      if (opened.error) throw new Fail(/invalid or expired/.test(opened.error.message) ? LINK_INVALID : opened.error.message, 403);
      const record = opened.data as { id: string; state: string; title: string; recipient: { email: string } };
      let p = await loadPayment("subject_id", record.id);
      const connection = p ? await stripeConnection(p.tenant_id) : null;

      if (action === "status") return json(view(p, !!connection, record.state));
      if (!p || p.status === "canceled") throw new Fail("There is nothing to pay for this document.", 404);

      if (action === "confirm") {
        p = await syncFromStripe(p);
        return json(view(p, !!connection, record.state));
      }

      // checkout
      if (p.status === "paid") return json({ ...view(p, !!connection, record.state), alreadyPaid: true });
      if (p.status === "processing") throw new Fail("Your payment is being processed. Check back shortly.", 409);
      if (!connection) throw new Fail("Online payment is not set up yet. Please contact us.", 503);
      if (!["sent", "viewed", "partial", "signed"].includes(record.state)) throw new Fail("This document is not open for payment.", 409);
      const back = returnUrlAllowed(body.returnUrl);
      if (!back) throw new Fail("Invalid return address.", 400);
      // Reuse a session that is still open on the same connection.
      if (p.status === "open" && p.checkout_url && p.connection_id === connection.id && p.checkout_expires_at && Date.parse(p.checkout_expires_at) > Date.now() + 120000) {
        return json({ url: p.checkout_url });
      }
      const success = new URL(back.href); success.searchParams.set("payment", "success");
      const cancel = new URL(back.href); cancel.searchParams.set("payment", "cancelled");
      const form = new URLSearchParams({
        mode: "payment",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": p.currency,
        "line_items[0][price_data][unit_amount]": String(p.amount_cents),
        "line_items[0][price_data][product_data][name]": p.description.slice(0, 250),
        client_reference_id: p.id,
        "metadata[payment_id]": p.id,
        "metadata[subject_type]": p.subject_type,
        "metadata[subject_id]": p.subject_id,
        "payment_intent_data[metadata][payment_id]": p.id,
        "payment_intent_data[metadata][subject_id]": p.subject_id,
        "payment_intent_data[description]": `${p.description} (${record.title})`.slice(0, 500),
        success_url: success.href,
        cancel_url: cancel.href,
        expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),
      });
      const email = p.payer_email || record.recipient?.email;
      if (email) form.set("customer_email", email);
      const attempt = p.checkout_count + 1;
      const session = await stripe(connection.id, "POST", "checkout/sessions", form, `skyline-checkout-${p.id}-${attempt}-${p.amount_cents}-${p.currency}`);
      if (typeof session.url !== "string" || typeof session.id !== "string") throw new Fail("Stripe returned an unexpected response. Please try again.", 502);
      const { data: claimed, error: ue } = await db.from("payments").update({ status: "open", connection_id: connection.id, stripe_checkout_session_id: session.id,
        checkout_url: session.url, checkout_expires_at: new Date(Number(session.expires_at) * 1000).toISOString(), checkout_count: attempt,
        livemode: session.livemode === true, failure_reason: null, updated_at: new Date().toISOString() })
        .eq("id", p.id).eq("checkout_count", p.checkout_count).neq("status", "paid").select("id");
      if (ue) throw new Fail("The payment could not be started. Please try again.", 500);
      if (!claimed?.length) {
        const latest = await loadPayment("id", p.id);
        if (latest?.checkout_url) return json({ url: latest.checkout_url });
        throw new Fail("The payment changed. Please reload the page.", 409);
      }
      return json({ url: session.url });
    }

    // ---------------------------------------------------------------- administrators
    if (!authorization.startsWith("Bearer ")) throw new Fail("Sign in required.", 401);
    const { data: user, error: userError } = await caller.auth.getUser();
    if (userError || !user.user) throw new Fail("Sign in required.", 401);

    if (action === "refresh") {
      const admin = await caller.rpc("cms_is_admin");
      if (admin.data !== true) throw new Fail("Administrator access required.", 403);
      if (typeof body.paymentId !== "string" || !UUID.test(body.paymentId)) throw new Fail("Select a payment.");
      const p = await loadPayment("id", body.paymentId);
      if (!p) throw new Fail("Payment not found.", 404);
      const after = await syncFromStripe(p);
      return json(view(after, true));
    }

    if (action === "webhook_sync") {
      const tenant = body.tenantId === null || body.tenantId === undefined ? null : typeof body.tenantId === "string" && UUID.test(body.tenantId) ? body.tenantId : undefined;
      if (tenant === undefined) throw new Fail("Valid organization scope required.");
      const allowed = await caller.rpc("integration_can_manage", { p_tenant: tenant });
      if (allowed.data !== true) throw new Fail("Administrator access required.", 403);
      const connection = await stripeConnection(tenant);
      if (!connection) throw new Fail("Connect and test Stripe first.", 409);
      const { key, account } = await stripeKey(connection.id);
      if (account || !key) throw new Fail("Webhooks need a Stripe secret or restricted API key on this connection.", 409);
      const endpoint = `${url}/functions/v1/integrations-webhook?connection=${connection.id}`;
      const { data: existing } = await db.from("integration_webhook_registrations").select("id,provider_id").eq("connection_id", connection.id).maybeSingle();
      const events = new URLSearchParams(); WEBHOOK_EVENTS.forEach((e) => events.append("enabled_events[]", e));
      if (existing?.provider_id) {
        try {
          await stripe(connection.id, "POST", `webhook_endpoints/${encodeURIComponent(existing.provider_id)}`, events);
          await db.from("integration_webhook_registrations").update({ event_types: WEBHOOK_EVENTS }).eq("id", existing.id);
          await db.from("integration_logs").insert({ connection_id: connection.id, connector_id: "stripe", severity: "info", code: "webhook_events_updated", correlation_id: crypto.randomUUID() });
          return json({ ok: true, updated: true, events: WEBHOOK_EVENTS });
        } catch { await db.from("integration_webhook_registrations").delete().eq("id", existing.id); /* endpoint gone at Stripe: create a new one below */ }
      }
      const form = new URLSearchParams(events); form.set("url", endpoint); form.set("description", "Skyline payments and signing");
      const created = await stripe(connection.id, "POST", "webhook_endpoints", form, `skyline-webhook-${connection.id}-${Date.now().toString().slice(0, -5)}`);
      if (typeof created.id !== "string" || typeof created.secret !== "string") throw new Fail("Unexpected response from Stripe.", 502);
      const stored = await db.rpc("integration_credential_write", { p_connection: connection.id, p_kind: "webhook_secret", p_secret: created.secret });
      if (stored.error) throw new Fail("The webhook secret could not be stored.", 500);
      await db.from("integration_webhook_registrations").insert({ connection_id: connection.id, provider_id: created.id, endpoint_url: endpoint, event_types: WEBHOOK_EVENTS });
      await db.from("integration_logs").insert({ connection_id: connection.id, connector_id: "stripe", severity: "info", code: "webhook_registered", correlation_id: crypto.randomUUID() });
      return json({ ok: true, created: true, events: WEBHOOK_EVENTS });
    }

    throw new Fail("Unknown action.");
  } catch (error) {
    if (error instanceof Fail) return json({ error: error.message }, error.status);
    return json({ error: "The payment request could not be completed. Please try again." }, 500);
  }
});
