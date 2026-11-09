// Sends queued HR outbox mail with a service-role client. Used by staff-register and staff-onboarding right after the change
// that queued the mail (run after the response with EdgeRuntime.waitUntil), and by staff-admin. Best effort: anything not sent
// stays queued (sending off) or is retried / marked failed by the outbox rules, and the admin sees failures.
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
    result: async (id, state, messageId, error) => {
      await service.rpc("hr_svc_email_result", { p_id: id, p_state: state, p_message_id: messageId ?? null, p_error: error ?? null });
    },
  }, selectHrMailProvider(env), config, limit);
}
