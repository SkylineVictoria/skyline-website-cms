import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Field, Modal, Select } from "@/pages/admin/components/ui";
import { StaffAdminError, staffAdminActions, type StaffAdminResult } from "@/lib/staffApi";
import { offerLetterContext, type HrTemplate, type OfferLetterContext } from "@/lib/hrTemplatesApi";
import { TEMPLATE_PROSE } from "@/pages/admin/lib/onboardingText";
import { STAFF_TEMPLATES_PATH } from "@/pages/admin/lib/staffRoutes";
import { placeholderLabels, renderMessage, templateValues } from "../../../../../supabase/functions/_shared/hr-template";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
/**
 * "Send offer letter" (after the pay details): pick the letter template, preview the letter filled in with this person's details,
 * pick the email, then confirm. Sending makes the PDF from the template (saved against the person with the rendered letter), then
 * emails the offer with the person's sign-in link in one message. A placeholder with no value blocks the send and names what is
 * missing. With `resend` the letter that is already out is kept and only the email (with a new sign-in link) goes again.
 * An uploaded PDF can be used instead of a template.
 */
export default function SendOfferDialog({ profileId, name, email, resend, onClose, onDone }: {
  profileId: string; name: string; email: string; resend: boolean; onClose: () => void; onDone: (result: StaffAdminResult, message: string) => void;
}) {
  const [context, setContext] = useState<OfferLetterContext | null>(null);
  const [loadError, setLoadError] = useState("");
  const [source, setSource] = useState<"template" | "upload">("template");
  const [letterId, setLetterId] = useState("");
  const [emailId, setEmailId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    offerLetterContext(profileId).then((next) => {
      if (!live) return;
      setContext(next);
      const pick = (type: HrTemplate["type"]) => next.templates.filter((t) => t.type === type);
      setLetterId((pick("offer_letter").find((t) => t.isDefault) ?? pick("offer_letter")[0])?.id ?? "");
      setEmailId((pick("offer_email").find((t) => t.isDefault) ?? pick("offer_email")[0])?.id ?? "");
    }, (e) => { if (live) setLoadError(e instanceof Error ? e.message : "The offer letter could not be prepared."); });
    return () => { live = false; };
  }, [profileId]);

  const letters = useMemo(() => context?.templates.filter((t) => t.type === "offer_letter") ?? [], [context]);
  const emails = useMemo(() => context?.templates.filter((t) => t.type === "offer_email") ?? [], [context]);
  const values = useMemo(() => templateValues(context?.values ?? {}), [context]);
  const letterTemplate = letters.find((t) => t.id === letterId) ?? null;
  const emailTemplate = emails.find((t) => t.id === emailId) ?? null;
  const letter = useMemo(() => (letterTemplate ? renderMessage(letterTemplate, values) : null), [letterTemplate, values]);
  // The email is previewed with an example link; the real one-time link is made when it is sent.
  const mail = useMemo(() => (emailTemplate ? renderMessage(emailTemplate, { ...values, signing_link: "https://your-site/staff/welcome (personal link)", login_url: "https://your-site/login", link_expiry: "in 7 days" }) : null), [emailTemplate, values]);
  const letterGaps = letter ? [...letter.missing, ...letter.unknown] : [];
  const mailGaps = mail ? [...mail.missing, ...mail.unknown] : [];
  const blocked = resend ? null : context?.problem ?? null;
  const ready = !blocked && mailGaps.length === 0 && (resend || (source === "template" ? Boolean(letterTemplate) && letterGaps.length === 0 : Boolean(file)));

  const send = async () => {
    if (!ready || busy) return;
    setError("");
    try {
      if (!resend) {
        if (source === "template") { setBusy("Making the letter…"); await staffAdminActions.generateOffer(profileId, letterId); }
        else { setBusy("Checking the PDF…"); await staffAdminActions.uploadOffer(profileId, file!); }
      }
      setBusy("Sending the email…");
      const result = await staffAdminActions.sendOfferWithLogin(profileId, emailId || null);
      onDone(result, result.link ? "Email is switched off: copy the sign-in link from the window and send it yourself."
        : resend ? "The offer email was sent again with a new sign-in link."
          : result.needsPassword === false ? "The offer was emailed. This person already has a login, so they sign in with their existing password."
            : "The offer letter was emailed with the person's sign-in link.");
    } catch (e) {
      setConfirming(false);
      setError(e instanceof StaffAdminError && e.result.rolledBack ? `${e.message}` : e instanceof Error ? e.message : "The offer could not be sent.");
    } finally { setBusy(""); }
  };

  const title = resend ? `Send the offer email again: ${name}` : `Send offer letter: ${name}`;
  if (loadError) return <Modal open title={title} onClose={onClose} footer={<Button variant="outline" onClick={onClose}>Close</Button>}><p role="alert" className={ALERT}>{loadError}</p></Modal>;
  if (!context) return <Modal open title={title} onClose={onClose}><p className="text-sm text-foreground-600" role="status">Preparing the letter…</p></Modal>;

  return (
    <Modal open width="max-w-4xl" title={title} onClose={() => { if (!busy) onClose(); }}
      footer={confirming
        ? <><Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirming(false)}>Back</Button><Button disabled={Boolean(busy)} onClick={() => void send()} data-testid="offer-send-confirm">{busy || "Send the offer"}</Button></>
        : <><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!ready} onClick={() => { setError(""); setConfirming(true); }} data-testid="offer-send-next">{resend ? "Send again…" : "Send…"}</Button></>}>
      <div className="space-y-4" data-testid="offer-send-dialog">
        {blocked ? <p role="alert" className={ALERT} data-testid="offer-blocked">{blocked}</p> : null}
        {confirming ? (
          <div className="space-y-3" data-testid="offer-confirm">
            <p className="text-sm text-foreground-800">This sends <strong>one email to {email}</strong> with {resend ? "the offer that is already out" : "the offer letter"} and a personal sign-in link.</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-foreground-700">
              {resend ? null : <li>{source === "template" ? <>The letter is made from <strong>{letterTemplate?.name}</strong> and saved as a PDF against {name}. Editing the template later does not change it.</> : <>The PDF <strong>{file?.name}</strong> is checked and saved as the offer letter.</>}</li>}
              <li>A login is created for them if they do not have one. The link lets them choose their own password; it works once, for 7 days. No password is emailed.</li>
              <li>Until they are Active they can only see and sign their offer letter and see their own documents.</li>
              <li>If the email cannot be sent, nothing is changed and no login is left behind.</li>
            </ul>
          </div>
        ) : (
          <>
            {resend ? <p className={NOTICE}>The letter already sent stays as it is. This sends the email again{context.letter ? <> (letter: <strong>{context.letter.title}</strong>, from “{context.letter.templateName}”)</> : null} with a new sign-in link; an earlier link stops working.</p> : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Offer letter">
                  <Select value={source === "upload" ? "__upload" : letterId} onChange={(e) => { if (e.target.value === "__upload") setSource("upload"); else { setSource("template"); setLetterId(e.target.value); } }} data-testid="offer-letter-template">
                    {letters.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}</option>)}
                    <option value="__upload">Use a PDF I upload instead…</option>
                  </Select>
                </Field>
                <Field label="Email">
                  <Select value={emailId} onChange={(e) => setEmailId(e.target.value)} data-testid="offer-email-template">
                    {emails.length === 0 ? <option value="">Built-in offer email</option> : null}
                    {emails.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}</option>)}
                  </Select>
                </Field>
              </div>
            )}
            {resend ? (
              <Field label="Email">
                <Select value={emailId} onChange={(e) => setEmailId(e.target.value)} data-testid="offer-email-template">
                  {emails.length === 0 ? <option value="">Built-in offer email</option> : null}
                  {emails.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}</option>)}
                </Select>
              </Field>
            ) : null}
            {!resend && source === "upload" ? (
              <Field label="Offer letter (PDF)" required hint="7 MB or smaller, not password-protected. It is checked before it is stored.">
                <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" data-testid="offer-upload-file" />
              </Field>
            ) : null}
            {!resend && source === "template" && letters.length === 0 ? <p className={ALERT}>There is no offer letter template yet. <Link to={STAFF_TEMPLATES_PATH} className="font-semibold underline">Add one under HRMS › Templates</Link>, or upload a PDF.</p> : null}
            {!resend && source === "template" && letterGaps.length ? (
              <p role="alert" className={ALERT} data-testid="offer-missing">The letter cannot be sent yet: <strong>{placeholderLabels(letterGaps)}</strong> {letterGaps.length === 1 ? "has" : "have"} no value for {name}. Add {letterGaps.length === 1 ? "it" : "them"} in the pay details, or choose another template.</p>
            ) : null}
            {mailGaps.length ? <p role="alert" className={ALERT} data-testid="offer-email-missing">The email template needs <strong>{placeholderLabels(mailGaps)}</strong>, which {name} does not have yet. Choose another email template or fix this one.</p> : null}
            {!resend && source === "template" && letter ? (
              <div>
                <p className="mb-1.5 text-[13px] font-medium text-foreground-800">Preview: {letter.subject}</p>
                <div className="max-h-[42vh] overflow-y-auto rounded-md border border-background-300 bg-white px-6 py-5 shadow-sm" data-testid="offer-letter-preview">
                  {/* Sanitised by renderMessage (allow-list rebuild) and every value is escaped. */}
                  <div className={TEMPLATE_PROSE} dangerouslySetInnerHTML={{ __html: letter.html }} />
                </div>
              </div>
            ) : null}
            {mail ? (
              <details className="rounded-md border border-background-200 bg-background-50 px-3 py-2">
                <summary className="cursor-pointer text-[13px] font-medium text-foreground-800">Email preview: {mail.subject}</summary>
                <div className={`mt-2 ${TEMPLATE_PROSE}`} data-testid="offer-email-preview" dangerouslySetInnerHTML={{ __html: mail.html }} />
              </details>
            ) : null}
          </>
        )}
        {error ? <p role="alert" className={ALERT} data-testid="offer-send-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
