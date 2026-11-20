import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Field, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { StaffAdminError, staffAdminActions, type StaffAdminResult } from "@/lib/staffApi";
import { offerLetterContext, type OfferLetterContext } from "@/lib/hrTemplatesApi";
import { signingAdmin } from "@/lib/signingApi";
import TemplateEditor from "@/pages/admin/components/hrms/TemplateEditor";
import { TEMPLATE_PROSE } from "@/pages/admin/lib/onboardingText";
import { STAFF_TEMPLATES_PATH } from "@/pages/admin/lib/staffRoutes";
import { placeholderLabels, renderMessage, sanitizeTemplateHtml, templatePlaceholders, templateText, templateValues } from "../../../../../supabase/functions/_shared/hr-template";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
type Step = "choose" | "preview" | "edit" | "confirm";

/** A PDF handed back as base64 becomes a blob URL for the iframe (revoked when it changes). */
function usePdfUrl(base64: string | null): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!base64) { setUrl(""); return; }
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const next = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [base64]);
  return url;
}

/**
 * "Send offer letter" (after the pay details). Flow: choose the letter template (or a PDF) and the email › preview the letter
 * exactly as the PDF will be sent (same letterhead, fonts and "Offer letter" header; made by the staff-admin function from the
 * same code that makes the real one) › optionally edit the text of THIS letter (the saved template is not changed; "Save as new
 * template" is offered) › confirm › send. A placeholder with no value blocks the send and names what is missing; a character the
 * PDF font cannot print is reported inline before anything is made. The sent copy is stored with the template's own render.
 * With `resend` the letter already out is kept and only the email (with a new sign-in link) goes again.
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
  const [step, setStep] = useState<Step>("choose");
  const [edited, setEdited] = useState<string | null>(null); // the admin's HTML for this letter, null = the template's render
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<{ pdfBase64: string; pages: number; title: string; html: string; edited: boolean } | null>(null);
  const [saveAs, setSaveAs] = useState("");
  const [savedAs, setSavedAs] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const pdfUrl = usePdfUrl(preview?.pdfBase64 ?? null);

  useEffect(() => {
    let live = true;
    offerLetterContext(profileId).then((next) => {
      if (!live) return;
      setContext(next);
      setLetterId("");
      setEmailId("");
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
  const chosen = resend || (source === "template" ? Boolean(letterTemplate) && letterGaps.length === 0 : Boolean(file));
  const ready = !blocked && mailGaps.length === 0 && chosen;
  const draftLeft = step === "edit" ? templatePlaceholders(draft) : [];

  const fail = (e: unknown, fallback: string) => {
    if (e instanceof StaffAdminError) {
      const detail = e.result.unsupported ? ` Found: “${e.result.unsupported}”.` : "";
      setError(`${e.message}${detail}`);
    } else setError(e instanceof Error ? e.message : fallback);
  };
  const showPreview = async (html: string | null) => {
    if (!letterTemplate || busy) return;
    setError(""); setBusy("Making the preview…");
    try {
      const result = await staffAdminActions.previewOffer(profileId, letterTemplate.id, html);
      setPreview({ pdfBase64: result.pdfBase64 ?? "", pages: result.pages ?? 0, title: result.title ?? letter?.subject ?? "", html: result.html ?? "", edited: Boolean(result.edited) });
      setEdited(result.edited ? (result.html ?? html) : null);
      setStep("preview");
    } catch (e) { fail(e, "The preview could not be made."); }
    finally { setBusy(""); }
  };
  const startEdit = () => { setDraft(edited ?? preview?.html ?? letter?.html ?? ""); setSaveAs(""); setError(""); setStep("edit"); };
  const saveAsTemplate = async () => {
    if (!letterTemplate || !saveAs.trim() || busy) return;
    setBusy("Saving the template…"); setError("");
    try {
      // The one template table (20261113170000): a new offer letter version 1, rich HTML with its plain-text copy.
      const html = sanitizeTemplateHtml(draft);
      await signingAdmin("template_save", null, { name: saveAs.trim(), title: letterTemplate.subject, body_html: html, body: templateText(html), kind: "text", audience: "employee", category: "offer_letter" });
      setSavedAs(saveAs.trim()); setSaveAs("");
    } catch (e) { fail(e, "The template could not be saved."); }
    finally { setBusy(""); }
  };

  const send = async () => {
    if (!ready || busy) return;
    setError("");
    try {
      if (!resend) {
        if (source === "template") { setBusy("Making the letter…"); await staffAdminActions.generateOffer(profileId, letterId, edited); }
        else { setBusy("Checking the PDF…"); await staffAdminActions.uploadOffer(profileId, file!); }
      }
      setBusy("Sending the email…");
      const result = await staffAdminActions.sendOfferWithLogin(profileId, emailId || null);
      onDone(result, result.link ? "Email is switched off: copy the sign-in link from the window and send it yourself."
        : resend ? "The offer email was sent again with a new sign-in link."
          : result.needsPassword === false ? "The offer was emailed. This person already has a login, so they sign in with their existing password."
            : "The offer letter was emailed with the person's sign-in link.");
    } catch (e) {
      setStep(source === "template" ? "preview" : "choose");
      fail(e, "The offer could not be sent.");
    } finally { setBusy(""); }
  };

  const title = resend ? `Send the offer email again: ${name}` : `Send offer letter: ${name}`;
  if (loadError) return <Modal open title={title} onClose={onClose} footer={<Button variant="outline" onClick={onClose}>Close</Button>}><p role="alert" className={ALERT}>{loadError}</p></Modal>;
  if (!context) return <Modal open title={title} onClose={onClose}><p className="text-sm text-foreground-600" role="status">Preparing the letter…</p></Modal>;

  const footer = (() => {
    const cancel = <Button variant="outline" disabled={Boolean(busy)} onClick={onClose}>Cancel</Button>;
    if (step === "confirm") return <><Button variant="outline" disabled={Boolean(busy)} onClick={() => setStep(resend || source === "upload" ? "choose" : "preview")}>Back</Button><Button disabled={Boolean(busy)} onClick={() => void send()} data-testid="offer-send-confirm">{busy || "Send the offer"}</Button></>;
    if (step === "preview") return <><Button variant="outline" disabled={Boolean(busy)} onClick={() => setStep("choose")}>Back</Button>
      <Button variant="outline" disabled={Boolean(busy)} onClick={startEdit} data-testid="offer-edit">Edit this letter</Button>
      <Button disabled={Boolean(busy) || !ready} onClick={() => { setError(""); setStep("confirm"); }} data-testid="offer-send-next">Next: send…</Button></>;
    if (step === "edit") return <><Button variant="outline" disabled={Boolean(busy)} onClick={() => setStep("preview")}>Back</Button>
      {edited ? <Button variant="outline" disabled={Boolean(busy)} onClick={() => { setEdited(null); void showPreview(null); }} data-testid="offer-edit-discard">Discard my changes</Button> : null}
      <Button disabled={Boolean(busy) || draftLeft.length > 0} onClick={() => void showPreview(draft)} data-testid="offer-edit-preview">{busy || "Preview with my changes"}</Button></>;
    if (resend || source === "upload") return <>{cancel}<Button disabled={!ready} onClick={() => { setError(""); setStep("confirm"); }} data-testid="offer-send-next">{resend ? "Send again…" : "Send…"}</Button></>;
    return <>{cancel}<Button disabled={!ready || Boolean(busy)} onClick={() => void showPreview(edited)} data-testid="offer-preview-next">{busy || "Next: preview the letter"}</Button></>;
  })();

  return (
    <Modal open width="max-w-5xl" title={title} onClose={() => { if (!busy) onClose(); }} footer={footer}>
      <div className="space-y-4" data-testid="offer-send-dialog">
        {blocked ? <p role="alert" className={ALERT} data-testid="offer-blocked">{blocked}</p> : null}
        {!resend ? <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-600" aria-label="Steps">
          {(["choose", "preview", "edit", "confirm"] as Step[]).map((s, i) => <li key={s} className={s === step ? "font-semibold text-foreground-950" : ""}>{i + 1}. {s === "choose" ? "Template and email" : s === "preview" ? "Preview" : s === "edit" ? "Edit (optional)" : "Send"}</li>)}
        </ol> : null}

        {step === "confirm" ? (
          <div className="space-y-3" data-testid="offer-confirm">
            <p className="text-sm text-foreground-800">This sends <strong>one email to {email}</strong> with {resend ? "the offer that is already out" : "the offer letter"} and a personal sign-in link.</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-foreground-700">
              {resend ? null : <li>{source === "template"
                ? <>The letter is made from <strong>{letterTemplate?.name}</strong>{edited ? <> <strong>with your edits</strong></> : null} and saved as a PDF against {name}, exactly as previewed. Editing the template later does not change it{edited ? "; the template itself was not changed by your edits" : ""}.</>
                : <>The PDF <strong>{file?.name}</strong> is checked and saved against {name}.</>}</li>}
              <li>A login is created for them if they do not have one. The link lets them choose their own password; it works once, for 7 days. No password is emailed.</li>
              <li>Until they are Active they can only see and sign their offer letter and see their own documents.</li>
              <li>If the email cannot be sent, nothing is changed and no login is left behind.</li>
            </ul>
          </div>
        ) : step === "preview" && preview ? (
          <div className="space-y-2" data-testid="offer-pdf-preview">
            <p className="text-sm text-foreground-800">
              <strong>{preview.title}</strong> · {preview.pages} page{preview.pages === 1 ? "" : "s"}{preview.edited ? <> · <span className="rounded bg-secondary-100 px-1.5 py-0.5 text-xs font-semibold text-secondary-900" data-testid="offer-edited-badge">Edited for this letter</span></> : null}
            </p>
            <p className="text-xs text-foreground-600">This is the PDF that will be sent: the same letterhead, fonts and header as the final letter.</p>
            {pdfUrl ? <iframe title="Offer letter preview" src={pdfUrl} className="h-[60vh] w-full rounded-md border border-background-300 bg-white" /> : null}
            <details className="rounded-md border border-background-200 bg-background-50 px-3 py-2">
              <summary className="cursor-pointer text-label font-medium text-foreground-800">Text of the letter</summary>
              <div className={`mt-2 ${TEMPLATE_PROSE}`} data-testid="offer-letter-preview" dangerouslySetInnerHTML={{ __html: preview.html }} />
            </details>
          </div>
        ) : step === "edit" ? (
          <div className="space-y-3" data-testid="offer-edit-step">
            <p className="text-sm text-foreground-800">Change the text of <strong>this letter only</strong>. The saved template “{letterTemplate?.name}” stays as it is unless you save your version as a new template.</p>
            <TemplateEditor value={draft} onChange={setDraft} placeholders={[]} minHeight={280} />
            {draftLeft.length ? <p role="alert" className={ALERT} data-testid="offer-edit-placeholders">The letter still has {draftLeft.map((k) => `{{${k}}}`).join(", ")} in it. Fill it in or remove it before previewing.</p> : null}
            <div className="flex flex-wrap items-end gap-2 rounded-md border border-background-200 bg-background-50 p-3">
              <Field label="Save my version as a new template (optional)" hint="Keeps the person's details as typed; replace them with placeholders in HRMS › Templates if you want to reuse it for others.">
                <TextInput value={saveAs} maxLength={120} placeholder="Template name" onChange={(e) => setSaveAs(e.target.value)} data-testid="offer-save-as-name" />
              </Field>
              <Button size="sm" variant="outline" disabled={Boolean(busy) || !saveAs.trim() || draftLeft.length > 0} onClick={() => void saveAsTemplate()} data-testid="offer-save-as">Save as new template</Button>
              {savedAs ? <p className={`w-full ${NOTICE}`}>Saved as “{savedAs}”. It is listed under <Link to={STAFF_TEMPLATES_PATH} className="font-semibold underline">HRMS › Templates</Link>.</p> : null}
            </div>
          </div>
        ) : (
          <>
            {resend ? <p className={NOTICE}>The letter already sent stays as it is. This sends the email again{context.letter ? <> (letter: <strong>{context.letter.title}</strong>, from “{context.letter.templateName}”{context.letter.edited ? ", edited" : ""})</> : null} with a new sign-in link; any earlier link stops working.</p> : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Offer letter">
                  <Select value={source === "upload" ? "__upload" : letterId} onChange={(e) => { setEdited(null); setPreview(null); if (e.target.value === "__upload") setSource("upload"); else { setSource("template"); setLetterId(e.target.value); } }} data-testid="offer-letter-template">
                    <option value="">Choose an offer letter template</option>
                    {letters.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    <option value="__upload">Use a PDF I upload instead…</option>
                  </Select>
                </Field>
                <Field label="Email">
                  <Select value={emailId} onChange={(e) => setEmailId(e.target.value)} data-testid="offer-email-template">
                    <option value="">Built-in offer email</option>
                    {emails.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </Field>
              </div>
            )}
            {resend ? (
              <Field label="Email">
                <Select value={emailId} onChange={(e) => setEmailId(e.target.value)} data-testid="offer-email-template">
                  <option value="">Built-in offer email</option>
                  {emails.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
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
              <p role="alert" className={ALERT} data-testid="offer-missing">The letter cannot be sent yet: <strong>{placeholderLabels(letterGaps)}</strong> {letterGaps.length === 1 ? "has" : "have"} no value for {name}. Add {letterGaps.length === 1 ? "it" : "them"} in the pay details or the employment details, or choose another template.</p>
            ) : null}
            {mailGaps.length ? <p role="alert" className={ALERT} data-testid="offer-email-missing">The email template needs <strong>{placeholderLabels(mailGaps)}</strong>, which {name} does not have yet. Choose another email template or fix this one.</p> : null}
            {!resend && source === "template" && letter ? (
              <div>
                <p className="mb-1.5 text-label font-medium text-foreground-800">Letter: {letter.subject}{edited ? " (with your edits)" : ""}</p>
                <div className="max-h-[36vh] overflow-y-auto rounded-md border border-background-300 bg-white px-6 py-5 shadow-sm" data-testid="offer-letter-preview">
                  {/* Sanitised by renderMessage (allow-list rebuild) and every value is escaped. */}
                  <div className={TEMPLATE_PROSE} dangerouslySetInnerHTML={{ __html: edited ?? letter.html }} />
                </div>
                <p className="mt-1 text-xs text-foreground-600">Next, the letter is shown as the PDF the person will receive; you can edit it there.</p>
              </div>
            ) : null}
            {mail ? (
              <details className="rounded-md border border-background-200 bg-background-50 px-3 py-2">
                <summary className="cursor-pointer text-label font-medium text-foreground-800">Email preview: {mail.subject}</summary>
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
