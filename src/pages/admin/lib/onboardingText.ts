import type { OnboardingAccount, OnboardingTimelineEntry } from "@/lib/staffApi";
import { EMAIL_KIND_LABEL, STAFF_DOC_LABEL, STAFF_STATUS_LABEL, type StaffDocCategory, type StaffStatus } from "@/lib/staffStatus";

/** The look of a rendered template (letter or email) inside the admin: plain document typography; no page styles leak in. */
export const TEMPLATE_PROSE = "break-words text-sm leading-relaxed text-foreground-900 [&_a]:text-primary-700 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-background-300 [&_blockquote]:pl-3 [&_blockquote]:text-foreground-700 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:font-semibold [&_hr]:my-4 [&_hr]:border-background-300 [&_li]:mb-1 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6";

const doc = (d: Record<string, unknown>) => `${STAFF_DOC_LABEL[String(d.category) as StaffDocCategory] ?? String(d.category ?? "document")}${d.filename ? ` (${String(d.filename)})` : ""}`;
const LINK: Record<string, string> = { documents: "Document link", reupload: "Re-upload link", offer: "Offer link", account: "Sign-in link" };
const STAGE: Record<string, string> = { screening: "Screening", shortlisted: "Shortlisted", interview: "Interview", selected: "Selected" };

/**
 * One line of the history as a sentence, or null for an entry that is only bookkeeping (the internal link behind a sent offer).
 * `note` is the extra text an entry carries (a status note, a rejection reason).
 */
export function timelineText(e: OnboardingTimelineEntry): { text: string; note?: string } | null {
  const d = e.detail ?? {};
  if (e.type === "status") {
    const from = d.from ? `${STAFF_STATUS_LABEL[d.from as StaffStatus] ?? String(d.from)} → ` : "";
    return { text: `Status: ${from}${STAFF_STATUS_LABEL[d.to as StaffStatus] ?? String(d.to)}`, note: String(d.note ?? "") || undefined };
  }
  if (e.type === "email") {
    const state = d.state === "sent" ? "sent" : d.state === "failed" ? "could not be sent" : "not sent (email is switched off)";
    return { text: `Email ${state}: ${EMAIL_KIND_LABEL[e.action] ?? e.action}` };
  }
  if (e.type === "recruitment") {
    if (e.action.startsWith("Application")) {
      const state = d.status && d.status !== "applied" ? String(d.status) : STAGE[String(d.stage)] ?? "";
      return { text: `Job application ${e.action.endsWith("created") ? "received" : "updated"}${state ? `: ${state}` : ""}` };
    }
    if (e.action.startsWith("Employment")) return { text: `Employment details ${e.action.endsWith("created") ? "added" : "updated"}${d.jobTitle ? `: ${String(d.jobTitle)}` : ""}` };
    return { text: e.action };
  }
  switch (e.action) {
    case "document_uploaded": return { text: `Uploaded ${doc(d)}` };
    case "document_approved": return { text: `Approved ${doc(d)}` };
    case "document_rejected": return { text: `Rejected ${doc(d)}`, note: String(d.note ?? "") || undefined };
    case "document_replaced": return { text: `Replaced ${doc(d)}` };
    case "link_created": return d.purpose === "offer" ? null : { text: `${LINK[String(d.purpose)] ?? "Link"} created` };
    case "link_revoked": return d.purpose === "offer" ? null : { text: `${LINK[String(d.purpose)] ?? "Link"} cancelled` };
    case "password_set": return { text: "Chose their password" };
    case "offer_prepared": return { text: `Offer letter prepared${d.filename ? ` (${String(d.filename)})` : ""}` };
    case "offer_letter_generated": return { text: `Offer letter made from the “${String(d.template ?? "")}” template` };
    case "offer_sent": return { text: "Offer letter sent" };
    case "offer_send_failed": return { text: "Offer email failed: the send was undone" };
    case "offer_replaced": return { text: "Unsent offer letter replaced" };
    case "offer_withdrawn": return { text: "Offer withdrawn" };
    case "offer_signed": return { text: `Offer signed${d.signerName ? ` by ${String(d.signerName)}` : ""}` };
    case "pay_details_added": return { text: `Pay details saved${d.jobTitle ? `: ${String(d.jobTitle)}` : ""}${d.startDate ? `, starting ${new Date(`${String(d.startDate)}T00:00:00`).toLocaleDateString("en-AU")}` : ""}` };
    case "pay_saved": return { text: "Pay setup saved" };
    case "bank_saved": return { text: "Bank details saved" };
    case "role_granted": return { text: `Role granted: ${d.role === "admin" ? "Admin" : "Trainer"}` };
    case "role_revoked": return { text: `Role removed: ${d.role === "admin" ? "Admin" : "Trainer"}` };
    default: return { text: e.action.replace(/_/g, " ") };
  }
}

/** The "Login" line on the employee page. Never shows a link or a password: only what state the login is in. */
export function accountText(account: OnboardingAccount | null | undefined, when: (iso: string | null | undefined) => string): string {
  if (!account?.hasLogin) return "None yet (created when the offer is sent)";
  if (account.passwordSet) return account.lastSignInAt ? `Password chosen · last signed in ${when(account.lastSignInAt)}` : "Password chosen";
  const link = account.link;
  if (!link) return "Created, no sign-in link out";
  if (link.state === "live") return `Sign-in link sent ${when(link.sentAt)}, valid until ${new Date(link.expiresAt).toLocaleDateString("en-AU")} · password not chosen yet`;
  if (link.state === "expired") return `Sign-in link sent ${when(link.sentAt)} has expired · use Resend login`;
  return "Sign-in link is no longer valid · use Resend login";
}
