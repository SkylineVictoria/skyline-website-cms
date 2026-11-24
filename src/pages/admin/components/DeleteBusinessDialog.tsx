import { useState } from "react";
import { Button, Field, Modal, TextInput } from "@/pages/admin/components/ui";
import { deleteBusiness, deleteConfirmMatches } from "@/pages/admin/lib/businessData";

/**
 * Delete business (owner 2026-11-20): only offered to a SLIT administrator once the business is Inactive (or while its application is at "Application sent");
 * the database checks the same rules again. Everything of the business is removed permanently and silently (nobody is emailed).
 * The administrator types the business name or its ABN to confirm.
 */
export default function DeleteBusinessDialog({ business, onClose, onDeleted }: {
  business: { id: string; name: string; abn: string };
  onClose: () => void;
  onDeleted: (message: string) => void | Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const abn = business.abn.replace(/\D/g, "");
  const printedAbn = abn.length === 11 ? `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}` : business.abn || "none";
  const matches = deleteConfirmMatches(typed, business.name, business.abn);
  const remove = async () => {
    if (working || !matches) return;
    setWorking(true); setError("");
    try {
      const r = await deleteBusiness(business.id, typed);
      await onDeleted(`${r.name} was deleted permanently. Nobody was emailed.${r.filesLeft ? ` ${r.filesLeft} stored file${r.filesLeft === 1 ? "" : "s"} could not be removed; IT can clear ${r.filesLeft === 1 ? "it" : "them"}.` : ""}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The business could not be deleted.");
      setWorking(false);
    }
  };
  return <Modal open title="Delete business permanently" onClose={() => { if (!working) onClose(); }} width="max-w-xl"
    footer={<div className="flex justify-end gap-2">
      <Button variant="outline" disabled={working} onClick={onClose}>Cancel</Button>
      <Button variant="danger" icon="ri-delete-bin-line" disabled={working || !matches} onClick={() => void remove()} data-testid="delete-business-confirm">{working ? "Deleting…" : "Delete permanently"}</Button>
    </div>}>
    <div className="space-y-3 text-sm" data-testid="delete-business-dialog">
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 rounded-md border border-background-200 bg-background-50 p-3">
        <dt className="text-foreground-500">Business</dt><dd className="font-medium text-foreground-950" data-testid="delete-business-name">{business.name}</dd>
        <dt className="text-foreground-500">ABN</dt><dd className="font-medium text-foreground-950" data-testid="delete-business-abn">{printedAbn}</dd>
      </dl>
      <p className="text-foreground-700">Everything about this business is removed permanently and cannot be recovered: the business, its point of contact and any agents, their invitations, the application form and agreement sent for signing (its link stops working at once), anything the agency admin saved, the pre-send details and witness, and their files. Nobody is emailed. Only a note that you deleted it (name and ABN) is kept. The same ABN can be added again later.</p>
      <Field label="Type the business name or its ABN to confirm" required>
        <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder={business.name} data-testid="delete-business-typed" />
      </Field>
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-red-700">{error}</p> : null}
    </div>
  </Modal>;
}
