// CONTACT-VERIFY (owner, 2026-11-26): one method for every link SLIT sends: the email and the text carry different links, the
// opened link proves its channel, and a person who came by the text confirms their email with a 6-digit code before signing,
// setting a password or submitting (migration 20261126170517_contact_verify_everyone). This file: the text side, shared by
// document-signing, staff-admin / staff-onboarding and cms-admin-users. Texts go through the organisation's ClickSend connection
// (Integrations › Connections, public.invite_sms_settings); not connected = no text, never an error, the email is never blocked.
import { createClickSendProvider, normalizePhoneNumber } from "./notification/sms.ts";
import { simpleEmailHtml } from "./email-html.ts";

// deno-lint-ignore no-explicit-any
type Service = { rpc: (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string; code?: string } | null }> };

export type TextOutcome = { state: "sent" | "failed" | "skipped"; code: string; to: string };

/** 32 random bytes as base64url (43 characters): a link token, like every emailed link. */
export function newLinkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A 6-digit code (crypto random). */
export function newCode(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

/** Sends one text through the ClickSend connection. Never throws. */
export async function sendText(service: Service, input: { mobile: string; body: string; deliveryId: string }, fetchImpl?: typeof fetch): Promise<TextOutcome> {
  try {
    const { data: settings } = await service.rpc("invite_sms_settings");
    if (!settings?.username || !settings?.apiKey) return { state: "skipped", code: "not_connected", to: "" };
    const to = normalizePhoneNumber(String(input.mobile ?? ""));
    if (!to) return { state: "skipped", code: "no_mobile", to: "" };
    const provider = createClickSendProvider({ username: settings.username, apiKey: settings.apiKey, senderId: settings.from ?? undefined, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    const outcome = await provider.send({ deliveryId: input.deliveryId, to, body: input.body });
    return outcome.kind === "accepted" ? { state: "sent", code: "", to } : { state: "failed", code: String((outcome as { code?: string }).code ?? "error"), to };
  } catch {
    return { state: "failed", code: "error", to: "" };
  }
}

/** The email that confirms a person's email address after they came by a text link. */
export function contactCodeEmail(input: { name?: string | null; code: string; purpose: string }): { subject: string; text: string; html: string } {
  const hello = `Hello ${String(input.name ?? "").trim().slice(0, 80) || "there"},`;
  const lead = `You opened the link we sent by text message. Enter this code to confirm your email before you ${input.purpose}.`;
  const note = "The code works for 10 minutes. If you did not ask for it, you can ignore this email.";
  return {
    subject: "Confirm your email",
    text: `${hello}\n\n${lead}\n\n${input.code}\n\n${note}\n\nSkyline Institute of Technology\nThis is an automated message.`,
    html: simpleEmailHtml({ brand: "Skyline Institute of Technology", heading: "Confirm your email", paragraphs: [hello, lead], code: input.code, note, footer: "This is an automated message." }),
  };
}

export const maskEmail = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, "$1•••$2");
