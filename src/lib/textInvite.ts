// CONTACT-VERIFY (2026-11-26): the CMS invitation's text message outcome (cms-admin-users invite answers `text`).
/** What the invitation answer's `text` means, for the admin who sent it. */
export const TEXT_INVITE_LABEL: Record<string, string> = {
  sent: "The invitation also went by text message",
  not_connected: "No text message: ClickSend is not connected (Integrations › Connections)",
  invalid_mobile: "No text message: the mobile number is not valid",
  no_mobile: "No text message: no mobile number",
  not_ready: "No text message: the text link could not be made",
};

/** A portal invitation answer's `text` (portal-admin-users) as a sentence to add to the toast ("" when nothing to say). */
export function textInviteNote(text: unknown): string {
  if (text === "sent") return " Also sent by text message.";
  if (text === "not_connected") return " No text message: ClickSend is not connected (Integrations › Connections).";
  if (text === "failed") return " The text message could not be sent (the email went).";
  return "";
}
