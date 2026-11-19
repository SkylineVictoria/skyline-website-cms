// Runtime-neutral SMS for portal users who opt in: provider contract, ClickSend adapter, deterministic mock, the configuration gate and
// the dispatch loop. The database queues a text next to each pending email for an opted-in user (migration 20261116160000); the
// notification-delivery worker sends them with dispatchSmsBatch when EF_NOTIFICATION_SMS_ENABLED=true and the ClickSend credentials are
// set. A text queued more than 24 hours ago is never sent (SMS_MAX_AGE_MS; migration 20261120052817). Same rules as delivery.ts: web
// standards only, and messages and errors are fixed strings, never phone numbers, bodies, credentials or provider text.

import type { SendOutcome } from "./delivery.ts";

export const CLICKSEND_API = "https://rest.clicksend.com/v3";
/** Four concatenated GSM-7 segments; longer bodies are cut, never split into separate sends. */
export const MAX_SMS_BODY_CHARS = 612;

export interface SmsMessage { deliveryId: string; to: string; body: string; from?: string }
export interface SmsProvider { readonly id: string; send(message: SmsMessage): Promise<SendOutcome> }

const E164 = /^\+[1-9]\d{7,14}$/;
/** ClickSend sender: an alphanumeric ID (1-11 characters, starting with a letter) or an E.164 number. */
const SENDER_ID = /^(?:[A-Za-z][A-Za-z0-9 ]{0,10}|\+[1-9]\d{7,14})$/;
const MESSAGE_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * An E.164 number, or null when it is not a plausible mobile number. Spaces, dashes, dots and brackets are ignored.
 * Without a leading + the number is read as Australian: 04XXXXXXXX or 4XXXXXXXX become +614XXXXXXXX, and 61... gains its +.
 */
export function normalizePhoneNumber(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw || raw.length > 32 || /[^\d\s+().-]/.test(raw)) return null;
  let digits = raw.replace(/[\s().-]/g, "");
  if (digits.startsWith("+")) return E164.test(digits) ? digits : null;
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  else if (/^04\d{8}$/.test(digits)) digits = `+61${digits.slice(1)}`;
  else if (/^4\d{8}$/.test(digits)) digits = `+61${digits}`;
  else if (/^61\d{9}$/.test(digits)) digits = `+${digits}`;
  else return null;
  return E164.test(digits) ? digits : null;
}

/** Plain single-line-safe text: control characters other than newline become spaces, runs collapse, and the body is capped. */
export function cleanSmsBody(body: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from the body
  return (body ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_SMS_BODY_CHARS);
}

export function createClickSendProvider(options: { username: string; apiKey: string; senderId?: string; fetch?: typeof fetch; timeoutMs?: number }): SmsProvider {
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const authorization = `Basic ${btoa(`${options.username}:${options.apiKey}`)}`;
  return {
    id: "clicksend",
    async send(message) {
      const to = normalizePhoneNumber(message.to);
      if (!to) return { kind: "failed", code: "invalid_recipient" };
      const body = cleanSmsBody(message.body);
      if (!body) return { kind: "failed", code: "empty_body" };
      const from = (message.from ?? options.senderId ?? "").trim();
      if (from && !SENDER_ID.test(from)) return { kind: "failed", code: "sender_rejected" };
      let response: Response;
      try {
        response = await call(`${CLICKSEND_API}/sms/send`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: authorization },
          body: JSON.stringify({ messages: [{ source: "skyline", to, body, custom_string: message.deliveryId, ...(from ? { from } : {}) }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // The request may or may not have reached ClickSend; there is no idempotency key, so this is never resent automatically.
        return { kind: "unknown", code: (error as Error)?.name === "TimeoutError" ? "timeout" : "network" };
      }
      if (response.status === 429) return { kind: "retry", code: "rate_limit" };
      if (response.status >= 500) return { kind: "retry", code: "provider" };
      if (response.status === 401 || response.status === 403) return { kind: "failed", code: "unauthorized" };
      let parsed: Record<string, unknown> | null = null;
      try { const value = await response.json(); parsed = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { parsed = null; }
      if (response.status !== 200) return { kind: "failed", code: "rejected" };
      const data = parsed?.data && typeof parsed.data === "object" ? parsed.data as Record<string, unknown> : null;
      const first = Array.isArray(data?.messages) ? data!.messages[0] as Record<string, unknown> | undefined : undefined;
      if (!first || typeof first !== "object") return { kind: "unknown", code: "schema" };
      const status = typeof first.status === "string" ? first.status : "";
      if (status === "SUCCESS" || status === "QUEUED") {
        return typeof first.message_id === "string" && MESSAGE_ID.test(first.message_id) ? { kind: "accepted", messageId: first.message_id } : { kind: "unknown", code: "schema" };
      }
      // Per-message refusals: the message was definitively not accepted.
      if (status === "INVALID_RECIPIENT" || status === "INVALID_RECIPIENT_COUNTRY") return { kind: "failed", code: "invalid_recipient" };
      if (status === "INSUFFICIENT_CREDIT") return { kind: "failed", code: "insufficient_credit" };
      if (status === "INVALID_SENDER_ID" || status === "INVALID_SENDER") return { kind: "failed", code: "sender_rejected" };
      if (status === "COUNTRY_NOT_ENABLED") return { kind: "failed", code: "country_not_enabled" };
      return status ? { kind: "failed", code: "rejected" } : { kind: "unknown", code: "schema" };
    },
  };
}

/** Deterministic provider for tests and local development; never reachable from selectSmsProvider. */
export function createMockSmsProvider(script: SendOutcome[] | ((message: SmsMessage, call: number) => SendOutcome)): SmsProvider & { sent: SmsMessage[] } {
  const sent: SmsMessage[] = [];
  let n = 0;
  return { id: "mock", sent, async send(message) { sent.push(message); n += 1; return typeof script === "function" ? script(message, n) : script[Math.min(n - 1, script.length - 1)]; } };
}

export type SmsProviderSelection = { provider: SmsProvider; unavailable: null } | { provider: null; unavailable: { code: "configuration_unavailable"; variables: string[] } };

/** SMS is on only when EF_NOTIFICATION_SMS_ENABLED is exactly "true" and the ClickSend username and API key are set. Names only in errors. */
export function selectSmsProvider(config: Record<string, string | undefined>, options: { fetch?: typeof fetch } = {}): SmsProviderSelection {
  const variables: string[] = [];
  if ((config.EF_NOTIFICATION_SMS_ENABLED ?? "").trim() !== "true") variables.push("EF_NOTIFICATION_SMS_ENABLED");
  if (!(config.EF_CLICKSEND_USERNAME ?? "").trim()) variables.push("EF_CLICKSEND_USERNAME");
  if (!(config.EF_CLICKSEND_API_KEY ?? "").trim()) variables.push("EF_CLICKSEND_API_KEY");
  const senderId = (config.EF_CLICKSEND_SENDER_ID ?? "").trim();
  if (senderId && !SENDER_ID.test(senderId)) variables.push("EF_CLICKSEND_SENDER_ID");
  if (variables.length) return { provider: null, unavailable: { code: "configuration_unavailable", variables } };
  return { provider: createClickSendProvider({ username: config.EF_CLICKSEND_USERNAME!.trim(), apiKey: config.EF_CLICKSEND_API_KEY!.trim(), senderId: senderId || undefined, fetch: options.fetch }), unavailable: null };
}

// ---- dispatch loop ------------------------------------------------------------------------------
/** A text queued longer ago than this is never sent: it is recorded as expired (reason older_than_24h). */
export const SMS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** One claimed SMS (migration 20261116160000; createdAt since 20261120052817). The phone number and body are held in memory for this send only. */
export interface ClaimedSms { id: string; leaseToken: string; phone: string; body: string; attempt: number; createdAt: string | null }
export interface SmsDeliveryPort {
  claim(): Promise<ClaimedSms | null>;
  record(delivery: ClaimedSms, outcome: "accepted" | "failed" | "unknown" | "expired", messageId: string | null, errorCode: string | null, retry: boolean, delaySeconds: number): Promise<boolean>;
}
export interface SmsDispatchSummary { accepted: number; retried: number; failed: number; unknown: number; expired: number; stale: number }

/** True when the text was queued more than 24 hours before `now` (or its queue time cannot be read: it is not sent on a guess). */
export function smsExpired(createdAt: string | null, now: number): boolean {
  const queued = createdAt ? Date.parse(createdAt) : NaN;
  return !Number.isFinite(queued) || now - queued > SMS_MAX_AGE_MS;
}

export async function dispatchSmsBatch(port: SmsDeliveryPort, provider: SmsProvider, limit: number, now: () => number = Date.now): Promise<SmsDispatchSummary> {
  const summary: SmsDispatchSummary = { accepted: 0, retried: 0, failed: 0, unknown: 0, expired: 0, stale: 0 };
  for (let i = 0; i < limit; i++) {
    const sms = await port.claim();
    if (!sms) break;
    // Never send a text older than 24 hours (the database expires most of them before the claim; this catches one that crossed the line).
    if (smsExpired(sms.createdAt, now())) {
      if (await port.record(sms, "expired", null, "older_than_24h", false, 0)) summary.expired++; else summary.stale++;
      continue;
    }
    const outcome = await provider.send({ deliveryId: sms.id, to: sms.phone, body: sms.body });
    let stored: boolean;
    if (outcome.kind === "accepted") { stored = await port.record(sms, "accepted", outcome.messageId, null, false, 0); if (stored) summary.accepted++; }
    else if (outcome.kind === "retry") {
      stored = await port.record(sms, "failed", null, outcome.code, true, Math.min(900, 30 * 2 ** sms.attempt));
      if (stored) { if (sms.attempt < 3) summary.retried++; else summary.failed++; }
    }
    else if (outcome.kind === "failed") { stored = await port.record(sms, "failed", null, outcome.code, false, 0); if (stored) summary.failed++; }
    else { stored = await port.record(sms, "unknown", null, outcome.code, false, 0); if (stored) summary.unknown++; }
    if (!stored) summary.stale++;
  }
  return summary;
}
