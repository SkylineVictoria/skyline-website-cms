import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import EnrolMailboxDialog from "@/components/shared/application-status/EnrolMailboxDialog";
import { fetchEnrolledWithoutMailbox, type EnrolledWithoutMailbox as Row } from "@/pages/admin/lib/microsoft365";

/**
 * Email Management > Email Accounts > Enrolled, no mailbox yet (2026-11-21): students with an Enrolled application and no active Microsoft
 * 365 account, with the last skip or failure logged on the application. Create email opens the same dialog as "Mark as enrolled".
 */
const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-AU", { timeZone: "Australia/Melbourne", day: "2-digit", month: "short", year: "numeric" }) : "";

export default function EnrolledWithoutMailbox() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Row | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    void fetchEnrolledWithoutMailbox().then((r) => { if (live) { setRows(r); setError(""); } }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : "The list could not be loaded."); });
    return () => { live = false; };
  }, [reload]);
  if (!error && (!rows || !rows.length)) return null;
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-5 sm:p-6" data-testid="enrolled-no-mailbox">
      <h2 className="text-lg font-semibold">Enrolled, no mailbox yet{rows ? ` (${rows.length})` : ""}</h2>
      <p className="mt-1 text-sm text-foreground-600">Students marked as enrolled whose Microsoft 365 mailbox was skipped, failed or not made yet.</p>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : <ul className="mt-4 divide-y divide-amber-100">
        {(rows ?? []).map((r) => <li key={r.studentId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm" data-testid="enrolled-no-mailbox-row">
          <span className="min-w-0 flex-1">
            <span className="font-medium text-foreground-950">{r.name}</span>
            <span className="text-foreground-500"> · <Link className="underline-offset-2 hover:underline" to={`/admin/applications/${r.applicationId}`}>{r.reference || r.applicationId.slice(0, 8)}</Link>{r.enrolledAt ? ` · enrolled ${when(r.enrolledAt)}` : ""}</span>
            <span className="block text-xs text-foreground-600">{r.mailboxStatus === "failed" || r.last?.outcome === "failed"
              ? `Failed${r.last?.outcome === "failed" && r.last.reason ? `: ${r.last.reason}` : r.mailboxError ? `: ${r.mailboxError}` : ""}`
              : r.last?.outcome === "skipped" ? `Skipped${r.last.by ? ` by ${r.last.by}` : ""} ${when(r.last.at)}` : r.mailboxStatus === "creating" ? "Being created" : "Not made yet"}</span>
          </span>
          <button type="button" onClick={() => setOpen(r)} data-testid="enrolled-no-mailbox-create"
            className="rounded-lg border border-background-300 bg-white px-3 py-1.5 text-sm font-medium text-foreground-800 hover:bg-background-100">Create email</button>
        </li>)}
      </ul>}
      {open ? <EnrolMailboxDialog applicationId={open.applicationId} studentId={open.studentId} studentName={open.name} reference={open.reference ?? undefined}
        onClose={() => { setOpen(null); setReload((n) => n + 1); }} /> : null}
    </section>
  );
}
