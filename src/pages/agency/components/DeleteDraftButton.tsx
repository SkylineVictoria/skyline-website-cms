import { useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import { deleteDraftApplication } from "@/pages/agency/lib/portalApplications";

/**
 * DRAFT-DELETE for the student (owner 2026-11-27): a draft never submitted is deleted with its documents (portal-application-delete:
 * drafts only, the caller must be able to edit it). A submitted application is withdrawn instead.
 */
export default function DeleteDraftButton({ applicationId, onDeleted }: { applicationId: string; onDeleted: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setBusy(true); setError("");
    try { await deleteDraftApplication(applicationId); setOpen(false); onDeleted("Application deleted."); }
    catch (e) { setError(e instanceof Error ? e.message : "The application could not be deleted."); }
    finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="draft-delete"
        className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">
        <i className="ri-delete-bin-line text-sm" aria-hidden="true" />
        Delete application
      </button>
      <Modal open={open} title="Delete this application?" onClose={() => { if (!busy) setOpen(false); }}
        footer={<>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Keep it</Button>
          <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()} data-testid="draft-delete-confirm">{busy ? "Deleting…" : "Delete application"}</Button>
        </>}>
        <p className="text-sm text-foreground-700">This draft and its documents are deleted. This cannot be undone. Your details stay on your student record for a new application.</p>
        {error ? <p role="alert" className="mt-3 text-sm text-red-800">{error}</p> : null}
      </Modal>
    </>
  );
}
