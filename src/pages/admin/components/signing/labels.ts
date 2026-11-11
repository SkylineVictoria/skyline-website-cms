const EVENT_LABEL: Record<string, string> = { created: "Request created", sent: "Sent for signature", recipient_invited: "Invitation queued for", viewed: "Opened by", signed: "Signed by", declined: "Declined by",
  completed: "Completed: everyone required has signed", resent: "Invitation sent again to", reminder_queued: "Reminder queued for", email_sent: "Email sent to", email_failed: "Email FAILED for", email_queued: "Email will be retried for",
  fields_changed: "Fields changed", opened_signed_in: "Opened while signed in by", voided: "Voided", expired: "Expired", draft_discarded: "Draft discarded", email_started: "Email started" };
export const signingEventLabel = (event: string) => EVENT_LABEL[event] ?? event.replaceAll("_", " ");
