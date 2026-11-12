import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ActionDrawer from "./ActionDrawer";
import SegmentedControl from "@/components/shared/application-form/SegmentedControl";
import { DocumentRow, Dropzone, RowAction } from "@/components/shared/application-form/DocumentUpload";
import { FORM_LABEL } from "@/components/shared/application-form/Field";
import { reasonsFor, statusInfo, useApplicationStatuses, type StatusAction } from "@/lib/applicationStatuses";
import { letterValues, toBase64 } from "@/lib/offerLetters";
import { changeApplicationStatus, issueCoeVoe, offerLetterRecipient, type OfferRecipient } from "@/pages/agency/lib/portalApplications";
import { CcAgent } from "./CcAgent";
import { sendCc, useCcDefault } from "@/lib/ccAgent";

const INPUT = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";
export interface DialogApplication { id: string; reference: string; studentName: string }
export interface StatusResult { status: string; label: string; from?: string; undoable?: boolean }

/** A centred in-app dialog: fade and scale (150 ms); Esc or the backdrop cancel unless a request is running. */
function Modal({ title, busy, onClose, children, footer, testId }: { title: string; busy: boolean; onClose: () => void; children: ReactNode; footer: ReactNode; testId?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busyRef.current) closeRef.current(); };
    document.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>("select, textarea, input")?.focus();
    return () => { document.removeEventListener("keydown", onKey); opener?.focus?.(); };
  }, []);
  return createPortal(
    <div className="modal-backdrop-in fixed inset-0 z-[90] flex items-center justify-center bg-foreground-950/40 p-4" role="presentation" onClick={() => { if (!busy) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} data-testid={testId} onClick={(e) => e.stopPropagation()}
        className="modal-in w-full max-w-md rounded-xl border border-background-200 bg-background-50 shadow-xl">
        <div className="border-b border-background-200 px-5 py-3.5"><h2 className="font-heading text-base font-semibold text-foreground-950">{title}</h2></div>
        <div className="space-y-3 px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-background-200 px-5 py-3">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}
const Who = ({ application }: { application: DialogApplication }) => (
  <p className="text-sm text-foreground-700" data-testid="dialog-application">
    <span className="font-medium text-foreground-950">{application.studentName || "Application"}</span>
    <span className="text-foreground-500"> &middot; {application.reference || application.id.slice(0, 8)}</span>
  </p>
);
const cancelButton = (busy: boolean, onClose: () => void) => (
  <button type="button" onClick={onClose} disabled={busy} className="h-9 cursor-pointer rounded-lg border border-background-300 px-3 text-sm font-medium text-foreground-700 hover:bg-background-100 disabled:opacity-50">Cancel</button>
);
const notifyBox = (notify: boolean, setNotify: (v: boolean) => void) => (
  <label className="flex items-center gap-2 text-sm text-foreground-800">
    <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} data-testid="dialog-notify" className="h-4 w-4 accent-primary-600" />
    Notify student / agent
  </label>
);

/**
 * Reject, Withdraw, Action required (and any transition that needs a reason): the reasons of the target status from status_reasons,
 * "Other" with its text; an optional note; "Notify student / agent" (on by default). The button stays disabled until a reason is given.
 * Errors show here and the dialog stays open.
 */
export function ReasonDialog({ application, action, onClose, onDone }: { application: DialogApplication; action: StatusAction; onClose: () => void; onDone: (result: StatusResult) => void }) {
  const workflow = useApplicationStatuses();
  const reasons = reasonsFor(workflow, action.to);
  const [reasonId, setReasonId] = useState("");
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = reasons.find((r) => r.id === reasonId);
  const ready = Boolean(chosen) && (!chosen?.other || other.trim().length > 0) && !busy;
  const confirm = async () => {
    if (!ready) return;
    setBusy(true); setError("");
    try {
      const result = await changeApplicationStatus(application.id, action.action, { reason_id: reasonId, ...(chosen?.other ? { reason_text: other.trim() } : {}), note: note.trim(), notify });
      onDone(result);
    } catch (e) { setError(e instanceof Error ? e.message : "The change could not be saved."); setBusy(false); }
  };
  const danger = action.tone === "danger" || statusInfo(workflow, action.to ?? "").final;
  return (
    <Modal title={action.label} busy={busy} onClose={onClose} testId="reason-dialog"
      footer={<>{cancelButton(busy, onClose)}
        <button type="button" onClick={() => void confirm()} disabled={!ready} data-testid="reason-confirm"
          className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-background-50 disabled:cursor-not-allowed disabled:opacity-60 ${danger ? "bg-red-600 hover:bg-red-700" : "bg-primary-500 hover:bg-primary-600"}`}>
          {busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : null}{action.label}
        </button></>}>
      <Who application={application} />
      <div>
        <label htmlFor="status-reason" className={`${FORM_LABEL} mb-1 block`}>Reason <span className="text-red-600" aria-hidden="true">*</span></label>
        <select id="status-reason" value={reasonId} onChange={(e) => setReasonId(e.target.value)} data-testid="reason-select" className={`${INPUT} h-10 py-0`}>
          <option value="">Choose a reason</option>
          {reasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </div>
      {chosen?.other ? (
        <div className="fade-in">
          <label htmlFor="status-reason-other" className={`${FORM_LABEL} mb-1 block`}>Describe the reason <span className="text-red-600" aria-hidden="true">*</span></label>
          <input id="status-reason-other" value={other} maxLength={500} onChange={(e) => setOther(e.target.value)} data-testid="reason-other" className={INPUT} />
        </div>
      ) : null}
      <div>
        <label htmlFor="status-note" className={`${FORM_LABEL} mb-1 block`}>Note (optional)</label>
        <textarea id="status-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} />
      </div>
      {notifyBox(notify, setNotify)}
      {error ? <p className="text-sm text-red-700" role="alert" data-testid="dialog-error">{error}</p> : null}
    </Modal>
  );
}

/** Enrol: the enrolment date (the intake's start date by default) and an optional note. */
export function EnrolDialog({ application, action, onClose, onDone }: { application: DialogApplication; action: StatusAction; onClose: () => void; onDone: (result: StatusResult) => void }) {
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void letterValues(application.id).then((v) => { const start = v?.values["course.start_date"]?.raw ?? ""; setDate((prev) => prev || (/^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : new Date().toISOString().slice(0, 10))); },
      () => setDate((prev) => prev || new Date().toISOString().slice(0, 10)));
  }, [application.id]);
  const confirm = async () => {
    if (!date || busy) return;
    setBusy(true); setError("");
    try { onDone(await changeApplicationStatus(application.id, action.action, { enrolment_date: date, note: note.trim(), notify })); }
    catch (e) { setError(e instanceof Error ? e.message : "The student could not be enrolled."); setBusy(false); }
  };
  return (
    <Modal title={action.label} busy={busy} onClose={onClose} testId="enrol-dialog"
      footer={<>{cancelButton(busy, onClose)}
        <button type="button" onClick={() => void confirm()} disabled={!date || busy} data-testid="enrol-confirm"
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-graduation-cap-line" aria-hidden="true" />}{action.label}
        </button></>}>
      <Who application={application} />
      <div>
        <label htmlFor="enrol-date" className={`${FORM_LABEL} mb-1 block`}>Enrolment date</label>
        <input id="enrol-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="enrol-date" className={INPUT} />
        <p className="mt-1 text-xs text-foreground-500">The intake&rsquo;s start date unless you change it.</p>
      </div>
      <div>
        <label htmlFor="enrol-note" className={`${FORM_LABEL} mb-1 block`}>Note (optional)</label>
        <textarea id="enrol-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} />
      </div>
      {notifyBox(notify, setNotify)}
      {error ? <p className="text-sm text-red-700" role="alert" data-testid="dialog-error">{error}</p> : null}
    </Modal>
  );
}

/**
 * Issue CoE / VoE (right-side drawer): CoE or VoE, its number, the issue date, the PDF, an optional note and who is told; Confirm stores
 * the document and moves the application to CoE / VoE issued (issue_coe_voe; the registration must be verified, as before).
 */
export function CoeVoeDrawer({ application, action, onClose, onDone }: { application: DialogApplication; action: StatusAction; onClose: () => void; onDone: (result: StatusResult) => void }) {
  const [kind, setKind] = useState<"coe" | "voe">("coe");
  const [number, setNumber] = useState("");
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [recipient, setRecipient] = useState<OfferRecipient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cc = useCcDefault(application.id);
  const [ccOn, setCcOn] = useState(true);
  useEffect(() => { void offerLetterRecipient(application.id).then(setRecipient, () => setRecipient(null)); }, [application.id]);
  const pick = (files: FileList | null) => {
    const picked = files?.[0];
    setError("");
    if (!picked) return;
    if (!/\.pdf$/i.test(picked.name) && picked.type !== "application/pdf") { setError("Upload the CoE / VoE as a PDF."); return; }
    if (picked.size > 3 * 1024 * 1024) { setError("The PDF must be 3 MB or smaller."); return; }
    setFile(picked);
  };
  const ready = Boolean(number.trim() && issueDate && file) && !busy;
  const confirm = async () => {
    if (!ready || !file) return;
    setBusy(true); setError("");
    try {
      const result = await issueCoeVoe({ applicationId: application.id, kind, number: number.trim(), issueDate, fileName: file.name.replace(/[^A-Za-z0-9 ._()-]+/g, " ").trim() || "CoE.pdf",
        contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())), note: note.trim(), notify });
      if (ccOn && notify) await sendCc(application.id, "coe_voe_issued", cc);
      onDone({ status: result.status ?? action.to ?? "", label: result.label ?? action.label });
    } catch (e) { setError(e instanceof Error ? e.message : "The CoE / VoE could not be issued."); setBusy(false); }
  };
  return (
    <ActionDrawer title={action.label} testId="coe-drawer" busy={busy} onClose={onClose}
      subtitle={<>{application.studentName || "Application"}{application.reference ? <> &middot; {application.reference}</> : null}</>}
      footer={<>{cancelButton(busy, onClose)}
        <button type="button" onClick={() => void confirm()} disabled={!ready} data-testid="coe-confirm"
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-500 px-3 text-sm font-medium text-background-50 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-award-line" aria-hidden="true" />}Issue {kind === "coe" ? "CoE" : "VoE"}
        </button></>}>
      <div className="space-y-4">
        <SegmentedControl<"coe" | "voe"> label="Document" value={kind} onChange={setKind} testId="coe-kind"
          options={[{ value: "coe", label: "CoE", icon: "ri-award-line" }, { value: "voe", label: "VoE", icon: "ri-file-shield-2-line" }]} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="coe-number" className={`${FORM_LABEL} mb-1 block`}>{kind === "coe" ? "CoE" : "VoE"} number <span className="text-red-600" aria-hidden="true">*</span></label>
            <input id="coe-number" value={number} maxLength={40} onChange={(e) => setNumber(e.target.value)} data-testid="coe-number" className={INPUT} />
          </div>
          <div>
            <label htmlFor="coe-date" className={`${FORM_LABEL} mb-1 block`}>Issue date <span className="text-red-600" aria-hidden="true">*</span></label>
            <input id="coe-date" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} data-testid="coe-date" className={INPUT} />
          </div>
        </div>
        {file ? (
          <DocumentRow filename={file.name} pill={{ text: "Ready", tone: "ready" }} actions={<RowAction title="Remove" icon="ri-delete-bin-line" label={`Remove ${file.name}`} onClick={() => setFile(null)} />} />
        ) : <Dropzone id="coe-upload" label="Choose the CoE / VoE PDF or drop it here" hint="PDF · max 3 MB" accept=".pdf,application/pdf" onFiles={pick} testId="coe-dropzone" />}
        <div>
          <label htmlFor="coe-note" className={`${FORM_LABEL} mb-1 block`}>Note (optional)</label>
          <textarea id="coe-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} />
        </div>
        <div className="rounded-lg border border-background-200 bg-background-100/60 px-3 py-2.5" data-testid="coe-recipient">
          <p className={FORM_LABEL}>Sends to</p>
          <p className="mt-1 text-sm text-foreground-900">{recipient ? <>{recipient.name || "Unnamed"} <span className="text-foreground-500">&lt;{recipient.email || "no email"}&gt;</span> ({recipient.kind})</> : "Working out the recipient…"}</p>
          <CcAgent cc={cc} on={ccOn} onChange={setCcOn} recipientEmail={recipient?.email} />
        </div>
        {notifyBox(notify, setNotify)}
        {error ? <p className="text-sm text-red-700" role="alert" data-testid="dialog-error">{error}</p> : null}
      </div>
    </ActionDrawer>
  );
}
