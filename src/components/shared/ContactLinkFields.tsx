import { PhoneInput } from "@/components/feature/applicationInputs";
import { textableMobile } from "@/lib/textableMobile";

/**
 * CONTACT-LINKS (owner 2026-11-26): one block for every "add a person" form (student, business, agent, employee): their mobile,
 * and how their sign-up link goes: by email and text message (ClickSend), or by email only. Either link opens the same account;
 * a person who opens the text link confirms their email with a 6-digit code first (CONTACT-VERIFY). The text never blocks the email.
 */
export default function ContactLinkFields({ id, mobile, onMobile, sendText, onSendText, mobileRequired = false, locked = false, who = "they", note, mobileError }: {
  id: string;
  /** E.164 ("" when blank). */
  mobile: string;
  onMobile: (e164: string) => void;
  /** Whether the link also goes by text. Omit (with onSendText) to show the mobile only. */
  sendText?: boolean;
  onSendText?: (on: boolean) => void;
  mobileRequired?: boolean;
  locked?: boolean;
  /** "the student", "they"…, used in the help text. */
  who?: string;
  /** Shown instead of the choice when the form has none (e.g. "With a mobile, the link also goes by text."). */
  note?: string;
  mobileError?: string;
}) {
  const canText = textableMobile(mobile);
  const choice = onSendText && sendText !== undefined;
  const option = (on: boolean, title: string, sub: string, disabled = false) => (
    <label className={`flex flex-1 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${sendText === on && !disabled ? "border-primary-500 bg-primary-50" : "border-background-300 bg-background-50"} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}>
      <input type="radio" name={`${id}-send-by`} className="mt-0.5" checked={sendText === on && !disabled} disabled={locked || disabled}
        onChange={() => onSendText?.(on)} data-testid={`${id}-send-${on ? "both" : "email"}`} />
      <span><b className="block font-medium text-foreground-900">{title}</b><span className="text-xs text-foreground-600">{sub}</span></span>
    </label>
  );
  return (
    <div className="space-y-3" data-testid={`${id}-contact`}>
      <div>
        <label htmlFor={`${id}-mobile`} className="mb-1.5 block text-sm font-medium text-foreground-800">
          Mobile {mobileRequired ? <span className="text-primary-600">*</span> : <span className="font-normal text-foreground-500">(optional, for the text message)</span>}
        </label>
        <PhoneInput id={`${id}-mobile`} name={`${id}_mobile`} value={mobile} required={mobileRequired} locked={locked} placeholder="041 234 5678" onValueChange={onMobile} invalid={Boolean(mobileError)} />
        {mobileError ? <p role="alert" className="mt-1 text-xs text-primary-700">{mobileError}</p> : null}
      </div>
      {note ? <p className="text-xs text-foreground-600">{note}</p> : choice ? (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-foreground-800">Send {who === "they" ? "their" : `${who}'s`} sign-up link by</legend>
          <div className="flex flex-col gap-2 sm:flex-row">
            {option(true, "Email and text message", canText ? "Two links; either one opens the account." : "Enter a mobile to send a text too.", !canText)}
            {option(false, "Email only", "No text message.")}
          </div>
          <p className="mt-1.5 text-xs text-foreground-500">Opened from the text, {who} confirm{who === "they" ? "" : "s"} the email with a 6-digit code before signing up.</p>
        </fieldset>
      ) : null}
    </div>
  );
}
