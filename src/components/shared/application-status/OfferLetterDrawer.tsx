import { useEffect, useMemo, useState } from "react";
import ActionDrawer from "./ActionDrawer";
import SegmentedControl from "@/components/shared/application-form/SegmentedControl";
import { DocumentRow, Dropzone, RowAction } from "@/components/shared/application-form/DocumentUpload";
import { FORM_LABEL } from "@/components/shared/application-form/Field";
import { signingAction, signingAdmin, type SigningContext, type SigningTemplate } from "@/lib/signingApi";
import { getApplication, issueOfferLetter, offerLetterRecipient, type OfferRecipient } from "@/pages/agency/lib/portalApplications";

const MAX_BYTES = 3 * 1024 * 1024;

export interface OfferApplication {
  id: string;
  reference: string;
  studentName: string;
  studentId: string | null;
  /** The course on the application (fills the template's course details for this application, not another one). */
  course?: { title: string; code: string } | null;
  intake?: string;
}

const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const pdfUrl = (base64: string) => URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "application/pdf" }));

/**
 * Issue offer letter: a template filled from the application (preview, small wording edits) or an uploaded PDF; who it goes to
 * (decided by the database: the agent for an agent's application, otherwise the student) and why; an optional message; then
 * Send offer letter, which stores the letter, emails it and moves the application to Offer letter issued. A declaration whose
 * name and signature do not match needs a staff note to go ahead.
 */
export default function OfferLetterDrawer({ application: given, onClose, onSent }: { application: OfferApplication; onClose: () => void; onSent: () => void }) {
  // From a list row the student and course may be missing: they are read from the application.
  const [application, setApplication] = useState<OfferApplication>(given);
  useEffect(() => {
    if (given.studentId) return;
    void getApplication(given.id).then((detail) => {
      if (detail) setApplication((prev) => ({ ...prev, studentId: detail.studentId, course: prev.course ?? (detail.courses[0] ? { title: detail.courses[0].title, code: detail.courses[0].code } : null), intake: prev.intake || detail.intake }));
    }, () => undefined);
  }, [given.id, given.studentId]);
  const [mode, setMode] = useState<"template" | "upload">("template");
  const [recipient, setRecipient] = useState<OfferRecipient | null>(null);
  const [templates, setTemplates] = useState<SigningTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [preview, setPreview] = useState<{ base64: string; url: string; text: string; isHtml: boolean } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void offerLetterRecipient(application.id).then(setRecipient, (e: Error) => setError(e.message));
    void signingAdmin<SigningContext>("list").then((context) => {
      // Text templates that are in use; student letters first.
      const list = context.templates.filter((t) => t.status === "active" && t.kind === "text")
        .sort((a, b) => Number(b.audience === "student") - Number(a.audience === "student") || Number(b.category === "offer_letter") - Number(a.category === "offer_letter") || a.name.localeCompare(b.name));
      setTemplates(list);
      if (list[0]) setTemplateId(list[0].id);
    }, () => setTemplates([]));
  }, [application.id]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const values = useMemo(() => ({
    ...(application.course ? { "course.name": application.course.title, "course.code": application.course.code } : {}),
    ...(application.intake ? { "course.intake": application.intake } : {}),
  }), [application.course, application.intake]);

  const makePreview = async (edits: string | null = editing) => {
    if (!templateId || !recipient) return;
    setBusy("preview"); setError("");
    try {
      const made = await signingAction<{ pdfBase64: string; text: string; isHtml?: boolean }>({
        action: "preview", templateId, values,
        ...(application.studentId ? { subjectType: "student", subjectId: application.studentId } : {}),
        recipients: [{ name: recipient.name || application.studentName || "Applicant", email: recipient.email, role: "recipient" }],
        ...(edits !== null ? (preview?.isHtml ? { html: edits } : { text: edits }) : {}),
      });
      setPreview((prev) => { if (prev) URL.revokeObjectURL(prev.url); return { base64: made.pdfBase64, url: pdfUrl(made.pdfBase64), text: made.text, isHtml: Boolean(made.isHtml) }; });
    } catch (e) { setError(e instanceof Error ? e.message : "The preview could not be made."); }
    finally { setBusy(""); }
  };

  const pickFile = (files: FileList | null) => {
    const picked = files?.[0];
    setError("");
    if (!picked) return;
    if (!/\.pdf$/i.test(picked.name) && picked.type !== "application/pdf") { setError("Upload the letter as a PDF."); return; }
    if (picked.size > MAX_BYTES) { setError("The letter must be 3 MB or smaller."); return; }
    setFile(picked);
  };

  const mismatch = Boolean(recipient?.declarationMismatch);
  const ready = Boolean(recipient?.email) && (mode === "template" ? Boolean(preview) : Boolean(file)) && (!mismatch || override.trim().length > 0) && !busy;

  const send = async () => {
    if (!ready) return;
    setBusy("send"); setError("");
    try {
      const template = templates?.find((t) => t.id === templateId);
      await issueOfferLetter({
        applicationId: application.id, source: mode,
        fileName: mode === "upload" && file ? file.name : `Offer letter ${application.reference || application.studentName}.pdf`.replace(/[\\/:*?"<>|]+/g, " "),
        contentBase64: mode === "upload" && file ? await toBase64(file) : preview!.base64,
        templateId: mode === "template" ? template?.id ?? null : null, message: message.trim(), overrideNote: mismatch ? override.trim() : "",
      });
      onSent();
    } catch (e) { setError(e instanceof Error ? e.message : "The offer letter could not be sent."); setBusy(""); }
  };

  return (
    <ActionDrawer title="Issue offer letter" testId="offer-letter-drawer"
      subtitle={<>{application.studentName || "Application"}{application.reference ? <> &middot; {application.reference}</> : null}</>}
      busy={busy === "send"} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy === "send"} className="h-9 cursor-pointer rounded-lg border border-background-300 px-3 text-sm font-medium text-foreground-700 hover:bg-background-100 disabled:opacity-50">Cancel</button>
        <button type="button" onClick={() => void send()} disabled={!ready} data-testid="send-offer-letter"
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60">
          {busy === "send" ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-send-plane-line" aria-hidden="true" />}
          Send offer letter
        </button>
      </>}>
      <div className="space-y-4">
        <div className="rounded-lg border border-background-200 bg-background-100/60 px-3 py-2.5" data-testid="offer-recipient">
          <p className={FORM_LABEL}>Sends to</p>
          {recipient ? (
            <>
              <p className="mt-1 text-sm text-foreground-900">
                <span className="mr-1.5 rounded-full bg-background-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-700 ring-1 ring-background-200">{recipient.kind === "agent" ? "Agent" : "Student"}</span>
                {recipient.name || "Unnamed"} <span className="text-foreground-500">&lt;{recipient.email || "no email"}&gt;</span>
              </p>
              <p className="mt-0.5 text-xs text-foreground-500">{recipient.reason}.</p>
            </>
          ) : <p className="mt-1 text-sm text-foreground-500">Working out the recipient&hellip;</p>}
        </div>

        {mismatch ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5" data-testid="offer-mismatch">
            <p className="flex items-start gap-1.5 text-sm text-amber-900">
              <i className="ri-error-warning-line text-base leading-none" aria-hidden="true" />
              The declarant name and digital signature on the declaration do not match.
            </p>
            <label htmlFor="offer-override" className={`${FORM_LABEL} mt-2 block`}>Note to issue anyway <span className="text-red-600" aria-hidden="true">*</span></label>
            <textarea id="offer-override" rows={2} maxLength={500} value={override} onChange={(e) => setOverride(e.target.value)}
              placeholder="e.g. Confirmed with the student by phone" className="mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40" />
          </div>
        ) : null}

        <SegmentedControl<"template" | "upload"> label="How to make the letter" value={mode} onChange={setMode} testId="offer-mode"
          options={[{ value: "template", label: "Use template", icon: "ri-file-text-line" }, { value: "upload", label: "Upload letter", icon: "ri-upload-2-line" }]} />

        <div key={mode} className="fade-in space-y-3">
          {mode === "template" ? (
            <>
              <div>
                <label htmlFor="offer-template" className={`${FORM_LABEL} mb-1 block`}>Template</label>
                <select id="offer-template" value={templateId} disabled={!templates?.length} onChange={(e) => { setTemplateId(e.target.value); setPreview(null); setEditing(null); }}
                  className="h-10 w-full rounded-lg border border-background-300 bg-background-50 px-3 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40">
                  {templates === null ? <option>Loading templates&hellip;</option> : templates.length === 0 ? <option value="">No text templates yet (Documents &amp; Signatures)</option>
                    : templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <p className="mt-1 text-xs text-foreground-500">Filled from the application: student name, course, code, CRICOS, intake, fees and dates.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void makePreview()} disabled={!templateId || !recipient || Boolean(busy)} data-testid="offer-preview"
                  className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-background-300 px-3 text-sm font-medium text-foreground-700 hover:bg-background-100 disabled:opacity-50">
                  <i className={busy === "preview" ? "ri-loader-4-line animate-spin" : "ri-eye-line"} aria-hidden="true" />
                  {preview ? "Refresh preview" : "Preview"}
                </button>
                {preview && editing === null ? (
                  <button type="button" onClick={() => setEditing(preview.text)} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-foreground-600 hover:bg-background-100">
                    <i className="ri-edit-line" aria-hidden="true" />Edit wording
                  </button>
                ) : null}
              </div>
              {editing !== null ? (
                <div>
                  <label htmlFor="offer-wording" className={`${FORM_LABEL} mb-1 block`}>Wording{preview?.isHtml ? " (HTML)" : ""}</label>
                  <textarea id="offer-wording" rows={8} value={editing} onChange={(e) => setEditing(e.target.value)}
                    className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 font-mono text-xs focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40" />
                  <button type="button" onClick={() => void makePreview(editing)} disabled={Boolean(busy)} className="mt-1 text-xs font-medium text-foreground-700 underline underline-offset-2 hover:text-primary-700">Apply the edits to the preview</button>
                </div>
              ) : null}
              {preview ? <iframe title="Offer letter preview" src={`${preview.url}#toolbar=0&navpanes=0`} className="h-[360px] w-full rounded-lg border border-background-200 bg-background-100" data-testid="offer-preview-frame" /> : null}
            </>
          ) : file ? (
            <DocumentRow filename={file.name} pill={{ text: "Ready to send", tone: "ready" }}
              actions={<RowAction title="Remove" icon="ri-delete-bin-line" label={`Remove ${file.name}`} onClick={() => setFile(null)} />} />
          ) : (
            <Dropzone id="offer-upload" label="Choose the signed letter or drop it here" hint="PDF · max 3 MB" accept=".pdf,application/pdf" onFiles={pickFile} testId="offer-dropzone" />
          )}
        </div>

        <div>
          <label htmlFor="offer-message" className={`${FORM_LABEL} mb-1 block`}>Message (optional)</label>
          <textarea id="offer-message" rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Added to the email with the letter"
            className="w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40" />
        </div>
        {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
      </div>
    </ActionDrawer>
  );
}
