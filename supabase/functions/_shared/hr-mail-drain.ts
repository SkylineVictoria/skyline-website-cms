// Sends queued HR outbox mail with a service-role client. Used by staff-register and staff-onboarding right after the change
// that queued the mail (run after the response with EdgeRuntime.waitUntil), and by staff-admin. Best effort: anything not sent
// stays queued (sending off) or is retried / marked failed by the outbox rules, and the admin sees failures.
import { toBase64 } from "./notification/submission-pdf.ts";
import { drainHrEmails, readHrMailConfig, selectHrMailProvider, type HrEmailRow } from "./hr-mail.ts";

export const HR_MAIL_ENV = ["EF_NOTIFICATION_EMAIL_ENABLED", "EF_POSTMARK_SERVER_TOKEN", "EF_POSTMARK_API_URL", "EF_HR_EMAIL_FROM", "EF_HR_ADMIN_NOTIFY_TO", "EF_HR_PUBLIC_SITE_URL"] as const;

// deno-lint-ignore no-explicit-any
export function drainHrOutbox(service: any, env: Record<string, string | undefined>, limit = 20) {
  const config = readHrMailConfig(env);
  return drainHrEmails({
    claim: async (kinds, n) => {
      const { data, error } = await service.rpc("hr_svc_email_claim", { p_limit: n, p_lease_seconds: 120, p_kinds: kinds });
      return error ? [] : (data as HrEmailRow[]);
    },
    // The signed offer PDF (signed_offer / admin_offer_signed): read with the service role and checked against the sha256
    // recorded at signing; a missing or changed file is not attached (the email is then marked failed for the admin).
    attachment: async (row) => {
      const offerId = String(row.payload?.offerId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(offerId)) return null;
      const { data, error } = await service.rpc("hr_svc_offer_signed_file", { p_offer: offerId });
      const file = data as { path?: string; filename?: string; sha256?: string } | null;
      if (error || !file?.path) return null;
      const { data: blob } = await service.storage.from("staff-documents").download(file.path);
      if (!blob) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
      if (hash !== file.sha256) return null;
      return { name: signedName(file.filename ?? "offer-letter.pdf"), contentType: "application/pdf", contentBase64: toBase64(bytes) };
    },
    result: async (id, state, messageId, error) => {
      await service.rpc("hr_svc_email_result", { p_id: id, p_state: state, p_message_id: messageId ?? null, p_error: error ?? null });
    },
  }, selectHrMailProvider(env), config, limit);
}

/** "offer.pdf" > "offer-signed.pdf". */
export function signedName(filename: string): string {
  const base = filename.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 120) || "offer-letter";
  return `${base}-signed.pdf`;
}
