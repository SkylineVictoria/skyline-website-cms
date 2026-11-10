import { useCallback, useEffect, useState } from "react";
import { Button, Card, Modal } from "@/pages/admin/components/ui";
import BankDetailsFields from "@/pages/admin/components/hrms/BankDetailsFields";
import { EMPTY_BANK, bankProblems, formatBsb, getEmployeeBank, saveEmployeeBank, type EmployeeBank } from "@/lib/employeesApi";

const mask = (n: string) => (n.length > 3 ? `${"•".repeat(n.length - 3)}${n.slice(-3)}` : n);

/** Bank details for pay on an employee's page: shown with the account number masked; Edit opens the four fields. Admin only. */
export default function BankDetailsCard({ profileId }: { profileId: string }) {
  const [bank, setBank] = useState<EmployeeBank | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<EmployeeBank | null>(null);
  const [problems, setProblems] = useState<Partial<Record<keyof EmployeeBank, string>>>({});
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);

  const load = useCallback(async () => {
    try { setBank(await getEmployeeBank(profileId)); setError(""); }
    catch (e) { setBank(null); setError(e instanceof Error ? e.message : "The bank details could not be loaded."); }
  }, [profileId]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!editing) return;
    const found = bankProblems(editing);
    setProblems(found);
    if (Object.keys(found).length) return;
    setBusy(true); setError("");
    try { setBank(await saveEmployeeBank(profileId, editing)); setEditing(null); }
    catch (e) { setError(e instanceof Error ? e.message : "The bank details could not be saved."); }
    finally { setBusy(false); }
  };

  return (
    <Card className="mb-4 p-5" data-testid="bank-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground-950">Bank details (for pay)</h2>
        <Button size="sm" variant="outline" icon="ri-bank-line" onClick={() => { setEditing(bank ? { ...bank } : { ...EMPTY_BANK }); setProblems({}); setError(""); }} data-testid="bank-edit">
          {bank ? "Edit" : "Add bank details"}</Button>
      </div>
      {bank === undefined ? <p role="status" className="text-sm">Loading…</p> : bank ? (
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs uppercase text-foreground-500">Account name</dt><dd className="mt-1">{bank.accountName}</dd></div>
          <div><dt className="text-xs uppercase text-foreground-500">Bank</dt><dd className="mt-1">{bank.bankName || "—"}</dd></div>
          <div><dt className="text-xs uppercase text-foreground-500">BSB</dt><dd className="mt-1">{formatBsb(bank.bsb)}</dd></div>
          <div><dt className="text-xs uppercase text-foreground-500">Account number</dt><dd className="mt-1">
            <span data-testid="bank-account-number">{reveal ? bank.accountNumber : mask(bank.accountNumber)}</span>
            <button type="button" className="ml-2 cursor-pointer text-xs font-medium text-primary-700 hover:underline" onClick={() => setReveal((v) => !v)}>{reveal ? "Hide" : "Show"}</button></dd></div>
        </dl>
      ) : <p className="text-sm text-foreground-500">No bank details yet. Add them so pay can be set up in Xero.</p>}
      {error && !editing ? <p role="alert" className="mt-3 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {editing ? (
        <Modal open title="Bank details" onClose={() => { if (!busy) setEditing(null); }}
          footer={<><Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void save()} data-testid="bank-save">{busy ? "Saving…" : "Save"}</Button></>}>
          <div className="space-y-3">
            <p className="text-sm text-foreground-700">The account the employee is paid into. Leave every field blank and save to remove them.</p>
            <BankDetailsFields value={editing} problems={problems} disabled={busy} onChange={(next) => { setEditing(next); if (Object.keys(problems).length) setProblems(bankProblems(next)); }} />
            {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}
