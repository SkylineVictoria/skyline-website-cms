import { useState } from "react";
import { Button, Field, Modal } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";

/** Statuses a student may withdraw from (portal_student_withdraw checks the same; CoE / VoE issued and later go through SLIT). */
export const STUDENT_WITHDRAWABLE = new Set(["draft", "submitted", "under_review", "action_required", "offer_issued", "offer_accepted"]);

/**
 * STUDENT-WITHDRAW (owner, 2026-11-26): the student changes their own application's status the one way a student may: Withdraw, with a
 * short reason. SLIT and the agent are told (history, audit log, admission event).
 */
export default function StudentWithdraw({ applicationId, status, onDone }: { applicationId: string; status: string; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!STUDENT_WITHDRAWABLE.has(status)) return null;
  const withdraw = async () => {
    setBusy(true); setError("");
    const { error: rpcError } = await supabase.rpc("portal_student_withdraw", { p_application: applicationId, p_reason: reason.trim() });
    setBusy(false);
    if (rpcError) { setError(rpcError.message || "The application could not be withdrawn."); return; }
    setOpen(false); setReason("");
    onDone("Your application was withdrawn. SLIT and your agent have been told.");
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="student-withdraw"
        className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">
        <i className="ri-logout-box-r-line text-sm" aria-hidden="true" />
        Withdraw application
      </button>
      <Modal open={open} title="Withdraw your application?" onClose={() => { if (!busy) setOpen(false); }}
        footer={<>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Keep my application</Button>
          <Button type="button" variant="danger" disabled={busy || reason.trim().length < 5} onClick={() => void withdraw()} data-testid="student-withdraw-confirm">{busy ? "Withdrawing…" : "Withdraw"}</Button>
        </>}>
        <div className="space-y-3">
          <p className="text-sm text-foreground-700">The application status changes to Withdrawn and SLIT stops processing it. To study with us later, start a new application.</p>
          <Field label="Why are you withdrawing?" required>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} data-testid="student-withdraw-reason"
              className="w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm" />
          </Field>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </div>
      </Modal>
    </>
  );
}
