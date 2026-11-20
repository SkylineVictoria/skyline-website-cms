import { useEffect, useState } from "react";
import { Button, Card } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { createStudentOffice365, studentOffice365State, type StudentOffice365State } from "@/pages/admin/lib/studentOffice365";
import { resendOffice365 } from "@/pages/admin/lib/microsoft365";
import { formatDate } from "@/pages/agency/lib/portalData";

/**
 * Student page: create the student's Office 365 email (firstname.lastname@ student domain) and send the login to their personal email.
 * Once the Microsoft account exists (2026-11-21), the page never creates again: "Resend login email" sets a new temporary password
 * (the first one is never stored) and emails it, after saying so. "Retry" stays only for an attempt that stopped before the account existed.
 */
export default function StudentOffice365Panel({ studentId, personalEmail }: { studentId: string; personalEmail: string }) {
  const { push } = useToast();
  const [state, setState] = useState<StudentOffice365State | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmResend, setConfirmResend] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    studentOffice365State(studentId)
      .then((s) => { if (active) { setState(s); setLoadError(""); } })
      .catch((e) => { if (active) setLoadError(e instanceof Error ? e.message : "Office 365 status could not be loaded."); });
    return () => { active = false; };
  }, [studentId, reload]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await createStudentOffice365(studentId);
      push(r.warning ?? `Created ${r.email}. The login details were emailed to ${personalEmail}.`);
    } catch (e) {
      push(e instanceof Error ? e.message : "The Office 365 email could not be created.", "error");
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  };
  const resend = async () => {
    setBusy(true);
    try {
      const r = await resendOffice365("student", studentId);
      push(`Login email sent to ${r.welcomeTo ?? personalEmail} for ${r.email}. A new temporary password was set (change at next sign-in).`);
    } catch (e) {
      push(e instanceof Error ? e.message : "The login email could not be sent.", "error");
    } finally {
      setBusy(false);
      setConfirmResend(false);
      setReload((n) => n + 1);
    }
  };

  const account = state?.account ?? null;
  const active = account?.status === "active";
  const failed = account?.status === "failed";
  // The Microsoft account exists (made by Skyline): only Resend login email from here on.
  const created = !!account?.msUserId && !account.linked && !active;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-[15px] font-semibold text-foreground-900">Office 365 email</h2>
          {loadError ? <p role="alert" className="mt-1 text-sm text-red-700">{loadError}</p>
            : !state ? <p className="mt-1 text-sm text-foreground-600">Loading&hellip;</p>
            : active ? (
              <p className="mt-1 text-sm text-foreground-700">
                <span className="font-semibold text-foreground-900">{account!.email}</span>
                {account!.welcomeSentAt ? <> &middot; login sent {formatDate(account!.welcomeSentAt)}</> : null}
              </p>
            ) : created ? (
              <p role="alert" className="mt-1 text-sm text-red-700" data-testid="o365-created-not-sent">
                Created {account!.email}, but the login email has not been sent. {account!.message ?? ""}
              </p>
            ) : failed ? (
              <p role="alert" className="mt-1 text-sm text-red-700">
                Not finished for {account!.email}. {account!.message ?? "Retry to complete it."}
              </p>
            ) : account?.status === "creating" ? (
              <p className="mt-1 text-sm text-foreground-600">Creating {account.email}&hellip; reload in a moment.</p>
            ) : !state.configured ? (
              <p className="mt-1 text-sm text-foreground-600">Microsoft 365 is not set up for student emails yet.</p>
            ) : !personalEmail ? (
              <p className="mt-1 text-sm text-foreground-600">Add the student&apos;s personal email first; the login details are sent there.</p>
            ) : (
              <p className="mt-1 text-sm text-foreground-600">Creates firstname.lastname with an Office 365 A1 licence and emails the login to {personalEmail}.</p>
            )}
          {created && confirmResend ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm" data-testid="o365-resend-confirm">
              <span>Set a new temporary password for {account!.email} and email it to {personalEmail || "the student"}?</span>
              <Button disabled={busy} onClick={() => void resend()}>{busy ? "Sending…" : "Yes, resend"}</Button>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirmResend(false)}>Cancel</Button>
            </div>
          ) : null}
        </div>
        {state && created && !confirmResend ? (
          <Button icon="ri-mail-send-line" disabled={busy || !state.configured || !personalEmail} onClick={() => setConfirmResend(true)} data-testid="o365-resend">
            Resend login email
          </Button>
        ) : state && !active && !created && account?.status !== "creating" ? (
          <Button icon="ri-microsoft-line" disabled={busy || !state.configured || !personalEmail} onClick={() => void create()}>
            {busy ? "Creating…" : failed ? "Retry" : "Create Office 365 email"}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
