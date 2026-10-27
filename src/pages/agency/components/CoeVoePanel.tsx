import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/pages/agency/components/Dialog";
import { getCoeDocument, issueCoeVoe, readCoeDocumentContent, uploadCoeDocument, type CoeDocumentInfo } from "@/pages/agency/lib/portalRegistrations";
import { COE_KINDS, MAX_COE_BYTES, issueBlockers, validatePdfBytes, validatePdfFile, type CoeKind } from "@/pages/agency/lib/coeVoe";

const field = "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-950";
const primary = "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60";
const outline = "inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-800 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-60";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Manual CoE / VoE step (until the PRISMS API): upload the PDF, review it, then "Approve and issue". The database enforces every rule shown here. */
export default function CoeVoePanel({ registrationId, applicationId, applicationStatus, registrationState, onIssued }: {
  registrationId: string; applicationId: string; applicationStatus: string; registrationState: string; onIssued: () => void;
}) {
  const [doc, setDoc] = useState<CoeDocumentInfo | null>(null);
  const [kind, setKind] = useState<CoeKind>("coe");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try { setDoc(await getCoeDocument(applicationId)); } catch { setDoc(null); }
  }, [applicationId]);
  useEffect(() => { void load(); }, [load]);

  const issued = Boolean(doc?.issuedAt) || applicationStatus === "coe_issued" || applicationStatus === "enrolled";
  const blockers = issueBlockers({ applicationStatus, registrationState, hasDocument: Boolean(doc), issued });

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setMessage("");
    const nameProblem = validatePdfFile({ name: file.name, size: file.size });
    if (nameProblem) { setMessage(nameProblem); return; }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const contentProblem = validatePdfBytes(bytes);
      if (contentProblem) { setMessage(contentProblem); return; }
      await uploadCoeDocument(registrationId, kind, file.name.trim(), toBase64(bytes));
      await load();
      setMessage("PDF uploaded. Review it, then approve and issue.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "The PDF could not be uploaded.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const preview = async () => {
    setBusy(true); setMessage("");
    try {
      const content = await readCoeDocumentContent(applicationId);
      if (!content) return;
      const bytes = Uint8Array.from(atob(content.contentBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setMessage(e instanceof Error ? e.message : "The PDF could not be opened."); } finally { setBusy(false); }
  };

  const issue = async () => {
    setBusy(true);
    try {
      await issueCoeVoe(applicationId, note);
      setConfirm(false); setNote("");
      await load();
      onIssued();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "The CoE / VoE could not be issued.");
      setConfirm(false);
    } finally { setBusy(false); }
  };

  return (
    <section aria-label="CoE / VoE" className="space-y-2">
      <h3 className="font-semibold">CoE / VoE document</h3>
      {doc ? (
        <p className="text-foreground-800">
          {doc.kind.toUpperCase()} · {doc.fileName} · {Math.max(1, Math.round(doc.sizeBytes / 1024))} KB · {doc.issuedAt ? "issued" : "uploaded, not yet issued"}{" "}
          <button type="button" className="font-semibold text-primary-700 underline" disabled={busy} onClick={() => void preview()}>Open</button>
        </p>
      ) : <p className="text-foreground-500">Nothing uploaded yet.</p>}
      {!issued ? (
        <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
          <select aria-label="Document type" className={field} value={kind} onChange={(e) => setKind(e.target.value as CoeKind)}>{COE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
          <input ref={fileInput} aria-label="CoE or VoE PDF" type="file" accept="application/pdf,.pdf" className={field} disabled={busy || registrationState !== "verified" || applicationStatus !== "offer_accepted"} onChange={(e) => void upload(e.target.files?.[0])} />
        </div>
      ) : null}
      <p className="text-xs text-foreground-500">PDF only, up to {MAX_COE_BYTES / (1024 * 1024)} MB. It is stored privately and is emailed to the recipients configured for “CoE / VoE issued” when you issue it.</p>
      {message ? <p role="status" className="rounded-md bg-background-100 px-3 py-2 text-foreground-800">{message}</p> : null}
      {!issued ? (
        <>
          {blockers.length > 0 ? <ul className="list-disc pl-5 text-foreground-700">{blockers.map((b) => <li key={b}>{b}</li>)}</ul> : null}
          <button type="button" className={primary} disabled={busy || blockers.length > 0} onClick={() => setConfirm(true)}>Approve and issue</button>
        </>
      ) : <p className="font-medium text-accent-900">Issued.</p>}
      <Dialog
        open={confirm}
        busy={busy}
        onClose={() => setConfirm(false)}
        title="Approve and issue the CoE / VoE?"
        description="The application moves to “CoE / VoE issued” and the document is emailed to the configured recipients (student and agent by default). This cannot be undone."
        footer={<>
          <button type="button" className={outline} disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          <button type="button" className={primary} disabled={busy} onClick={() => void issue()}>{busy ? "Issuing…" : "Approve and issue"}</button>
        </>}
      >
        <label className="block text-xs font-semibold uppercase tracking-wide text-foreground-700" htmlFor="issue-note">Note (optional)</label>
        <input id="issue-note" className={field} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </section>
  );
}
