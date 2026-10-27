/** Per-event notification recipient settings: pure parsing and validation shared by the admin UI. The database validates again (notification_event_check). */

export const NOTIFICATION_EVENTS = ["application_submitted", "application_status_changed", "offer_accepted", "coe_voe_issued"] as const;
export type NotificationEventKey = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventKey, { title: string; when: string }> = {
  application_submitted: { title: "Application submitted", when: "An agent submits an application." },
  application_status_changed: { title: "Other status changes", when: "An administrator moves an application to another status (for example action required)." },
  offer_accepted: { title: "Offer accepted", when: "An administrator marks the offer as accepted." },
  coe_voe_issued: { title: "CoE / VoE issued", when: "An administrator issues the CoE / VoE." },
};

export interface EventSettings { recipients: string[]; notifyAgent: boolean; notifyAgencyAdmins: boolean; notifyStudent: boolean }

export const MAX_EVENT_RECIPIENTS = 10;
const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
// eslint-disable-next-line no-control-regex -- control characters are never valid in an address
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Accepts one address per line, or comma / semicolon / space separated. Trimmed, lower-cased; duplicates are reported, not dropped silently. */
export function parseRecipients(text: string): { emails: string[]; error: string | null } {
  const parts = text.split(/[\n,;\s]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.length > 254 || CONTROL.test(part) || !EMAIL.test(part)) return { emails: parts, error: `"${part.slice(0, 60)}" is not a valid email address.` };
    if (seen.has(part)) return { emails: parts, error: `${part} is listed twice.` };
    seen.add(part);
  }
  if (parts.length > MAX_EVENT_RECIPIENTS) return { emails: parts, error: `At most ${MAX_EVENT_RECIPIENTS} internal recipients per event.` };
  return { emails: parts, error: null };
}

export function validateEventForm(input: { recipientsText: string; notifyAgent: boolean; notifyAgencyAdmins: boolean; notifyStudent: boolean }): { settings: EventSettings; error: string | null } {
  const { emails, error } = parseRecipients(input.recipientsText);
  return { settings: { recipients: emails, notifyAgent: input.notifyAgent, notifyAgencyAdmins: input.notifyAgencyAdmins, notifyStudent: input.notifyStudent }, error };
}

/** Whether anybody would receive the email at all; the form warns instead of silently saving a dead event. */
export function hasAnyRecipient(settings: EventSettings): boolean {
  return settings.recipients.length > 0 || settings.notifyAgent || settings.notifyAgencyAdmins || settings.notifyStudent;
}

/** Tenant configuration after changing one event: keeps every other published field, or starts from nothing when only the built-in defaults applied. */
export function configWithEvent(source: string, config: Record<string, unknown> | null, event: NotificationEventKey, settings: EventSettings): Record<string, unknown> {
  const base = source === "published" && config ? { ...config } : {};
  const events = { ...((base.events as Record<string, unknown> | undefined) ?? {}), [event]: settings };
  return { ...base, events };
}

export function eventErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  if (error?.code === "42501") return "You do not have permission to change these recipients.";
  if (error?.code === "40001") return "These settings changed since you opened them. Reload and try again.";
  if (error?.code === "22023") return /duplicate/i.test(error.message ?? "") ? "A recipient is listed twice." : /invalid recipient|valid/i.test(error.message ?? "") ? "One of the recipient addresses is not valid." : "Those settings are not valid.";
  return "The settings could not be saved. Please try again.";
}
