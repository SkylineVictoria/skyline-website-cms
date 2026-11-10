import { useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { StaffAdminError, staffAdminActions, type StaffAdminResult, type StaffListRow } from "@/lib/staffApi";
import { linkActionFor } from "@/lib/staffStatus";

/**
 * HRMS > Employees > Onboarding table: Send link / Resend link for the document link, the same staff-admin actions as the person's page
 * (send_documents for Applied; send_invite "documents" for Invited, which stops the earlier link at once). With email switched off the
 * link is shown once here to copy and pass on.
 */
export default function ResendLinkButton({ row, onDone }: { row: StaffListRow; onDone: (message: string) => void }) {
  const kind = linkActionFor(row.status);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<{ link: string; expiresAt?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (!kind) return null;
  const name = row.name || row.email;

  const send = async () => {
    setBusy(true); setError("");
    try {
      const result: StaffAdminResult = kind === "send" ? await staffAdminActions.sendDocuments(row.id) : await staffAdminActions.sendLink(row.id, "documents");
      if (result.link) { setShown({ link: result.link, expiresAt: result.expiresAt }); onDone(`A new link was made for ${name}. Email is switched off: copy it from the window.`); return; }
      setOpen(false);
      onDone(result.emailSent === false ? `The link could not be emailed to ${row.email}.` : `A new document link was emailed to ${row.email}.`);
    } catch (e) {
      const cancelled = e instanceof StaffAdminError && e.result.linkCancelled;
      setError(cancelled ? `The email to ${row.email} could not be sent, so that link was cancelled. Try again later.` : e instanceof Error ? e.message : "The link could not be sent.");
    } finally { setBusy(false); }
  };
  const close = () => { if (busy) return; setOpen(false); setShown(null); setError(""); setCopied(false); };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} icon="ri-mail-send-line" data-testid={`resend-link-${row.id}`}>
        {kind === "send" ? "Send link" : "Resend link"}
      </Button>
      {open ? (
        <Modal open title={`${kind === "send" ? "Send document link" : "Resend document link"}: ${name}`} onClose={close}
          footer={shown ? <Button onClick={close}>Done</Button> : <>
            <Button variant="outline" disabled={busy} onClick={close}>Cancel</Button>
            <Button disabled={busy} onClick={() => void send()} data-testid="resend-link-confirm">{busy ? "Sending…" : kind === "send" ? "Send link" : "Send a new link"}</Button></>}>
          {shown ? (
            <div className="space-y-3" data-testid="resend-link-shown">
              <p className="text-sm text-foreground-700">Email is switched off, so nothing was sent. Copy this private link and send it to {name} yourself. It is shown only once{shown.expiresAt ? ` and works until ${new Date(shown.expiresAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}` : ""}.</p>
              <div className="flex gap-2">
                <input readOnly value={shown.link} onFocus={(e) => e.target.select()} aria-label="Document link" className="min-w-0 flex-1 rounded-md border border-background-300 bg-background-100 px-3 py-2 text-xs" />
                <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(shown.link).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy"}</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-foreground-700">{kind === "send" ? "Emails a private link where they upload their documents and details." : "Emails a new private link. The earlier link stops working at once."}</p>
              <p className="text-foreground-800">An email goes to <strong>{row.email}</strong>.</p>
              {row.inviteExpiresAt ? <p className="text-xs text-foreground-600">The current link {new Date(row.inviteExpiresAt) < new Date() ? "expired" : "expires"} on {new Date(row.inviteExpiresAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}.</p> : null}
              {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-primary-900">{error}</p> : null}
            </div>
          )}
        </Modal>
      ) : null}
    </>
  );
}
