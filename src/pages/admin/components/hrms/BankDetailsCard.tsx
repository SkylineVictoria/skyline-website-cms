import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Card, Modal } from "@/pages/admin/components/ui";
import BankDetailsFields from "@/pages/admin/components/hrms/BankDetailsFields";
import { EMPTY_BANK, bankIsEmpty, bankProblems, bsbBank, formatBsb, getEmployeeBank, revealEmployeeBank, saveEmployeeBank, type EmployeeBank } from "@/lib/employeesApi";

/**
 * Bank details for pay on a person's page. Admins only (the database refuses an Editor). They are stored encrypted and arrive
 * MASKED (BSB 06••••, account •••• 4321). "Reveal" fetches them in full for this screen only and is written to the person's
 * history (who looked and when); they are hidden again with "Hide" or when the page is left. "Edit" asks for the new details
 * from scratch (the saved numbers are never loaded into a form); "Remove" deletes them.
 * `footer` sits under the details (the onboarding page puts its "Verified by admin" tick there); `onChanged` runs after a save,
 * a removal or a reveal so the page can refresh its history and ticks.
 */
export default function BankDetailsCard({ profileId, footer, onChanged }: { profileId: string; footer?: ReactNode; onChanged?: () => void }) {
  const [bank, setBank] = useState<EmployeeBank | null | undefined>(undefined);
  const [full, setFull] = useState<EmployeeBank | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<EmployeeBank | null>(null);
  const [problems, setProblems] = useState<Partial<Record<keyof EmployeeBank, string>>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try { setBank(await getEmployeeBank(profileId)); setError(""); }
    catch (e) { setBank(null); setError(e instanceof Error ? e.message : "The bank details could not be loaded."); }
  }, [profileId]);
  useEffect(() => { setFull(null); void load(); }, [load]);

  const reveal = async () => {
    setBusy(true); setError("");
    try { setFull(await revealEmployeeBank(profileId)); onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "The bank details could not be shown."); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!editing) return;
    // Everything is needed here: a blank form is not a way to delete (Remove is).
    const found = bankIsEmpty(editing) ? { accountName: "Enter the account name.", bsb: "The BSB must be 6 digits, for example 062-000.", accountNumber: "The account number must be 4 to 10 digits." } : bankProblems(editing);
    setProblems(found);
    if (Object.keys(found).length) return;
    setBusy(true); setError("");
    try { setBank(await saveEmployeeBank(profileId, { ...editing, bankName: editing.bankName.trim() || bsbBank(editing.bsb) })); setFull(null); setEditing(null); onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "The bank details could not be saved."); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setError("");
    try { await saveEmployeeBank(profileId, EMPTY_BANK); setBank(null); setFull(null); setRemoving(false); onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "The bank details could not be removed."); }
    finally { setBusy(false); }
  };

  const shown = full ?? bank;
  return (
    <Card className="mb-4 p-5" data-testid="bank-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground-950">Bank details (for pay)</h2>
        <span className="flex flex-wrap gap-2">
          {bank ? (full
            ? <Button size="sm" variant="outline" icon="ri-eye-off-line" onClick={() => setFull(null)} data-testid="bank-hide">Hide</Button>
            : <Button size="sm" variant="outline" icon="ri-eye-line" disabled={busy} onClick={() => void reveal()} data-testid="bank-reveal">{busy ? "Opening…" : "Reveal"}</Button>) : null}
          <Button size="sm" variant="outline" icon="ri-bank-line" onClick={() => { setEditing({ ...EMPTY_BANK }); setProblems({}); setError(""); }} data-testid="bank-edit">{bank ? "Edit" : "Add bank details"}</Button>
          {bank ? <Button size="sm" variant="outline" onClick={() => { setRemoving(true); setError(""); }} data-testid="bank-remove">Remove</Button> : null}
        </span>
      </div>
      {bank === undefined ? <p role="status" className="text-sm">Loading…</p> : shown ? (
        <>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs uppercase text-foreground-500">Account name</dt><dd className="mt-1">{shown.accountName}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">Bank</dt><dd className="mt-1">{shown.bankName || "—"}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">BSB</dt><dd className="mt-1" data-testid="bank-bsb">{full ? formatBsb(full.bsb) : shown.bsb}</dd></div>
            <div><dt className="text-xs uppercase text-foreground-500">Account number</dt><dd className="mt-1" data-testid="bank-account-number">{shown.accountNumber}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-foreground-500" data-testid="bank-state">
            {full ? "Shown in full. This view was recorded in the history below." : "Stored encrypted and shown masked. Reveal shows them in full and is recorded in the history (who and when)."}
          </p>
        </>
      ) : <p className="text-sm text-foreground-500">No bank details yet. The person adds them in the onboarding wizard, or add them here so pay can be set up in Xero.</p>}
      {footer ? <div className="mt-3 border-t border-background-200 pt-3">{footer}</div> : null}
      {error && !editing && !removing ? <p role="alert" className="mt-3 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {editing ? (
        <Modal open title="Bank details" onClose={() => { if (!busy) setEditing(null); }}
          footer={<><Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void save()} data-testid="bank-save">{busy ? "Saving…" : "Save"}</Button></>}>
          <div className="space-y-3">
            <p className="text-sm text-foreground-700">{bank ? "Type the new details. They replace the saved ones, which are not shown here." : "The account the employee is paid into."}</p>
            <BankDetailsFields value={editing} problems={problems} disabled={busy} onChange={(next) => { setEditing(next); if (Object.keys(problems).length) setProblems(bankProblems(next)); }} />
            {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
          </div>
        </Modal>
      ) : null}
      {removing ? (
        <Modal open title="Remove the bank details?" onClose={() => { if (!busy) setRemoving(false); }}
          footer={<><Button variant="outline" disabled={busy} onClick={() => setRemoving(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()} data-testid="bank-remove-confirm">{busy ? "Removing…" : "Remove"}</Button></>}>
          <p className="text-sm text-foreground-700">The saved account is deleted and cannot be brought back. Add the details again when you have them.</p>
          {error ? <p role="alert" className="mt-3 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
        </Modal>
      ) : null}
    </Card>
  );
}
