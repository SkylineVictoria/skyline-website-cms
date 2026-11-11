import { useEffect, useState } from "react";
import { Button, Card } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { createStudentOffice365, studentOffice365State, type StudentOffice365State } from "@/pages/admin/lib/studentOffice365";
import { formatDate } from "@/pages/agency/lib/portalData";

/** Student page: create the student's Office 365 email (firstname.lastname@ student domain) and send the login to their personal email. */
export default function StudentOffice365Panel({ studentId, personalEmail }: { studentId: string; personalEmail: string }) {
  const { push } = useToast();
  const [state, setState] = useState<StudentOffice365State | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
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

  const account = state?.account ?? null;
  const active = account?.status === "active";
  const failed = account?.status === "failed";

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
        </div>
        {state && !active && account?.status !== "creating" ? (
          <Button icon="ri-microsoft-line" disabled={busy || !state.configured || !personalEmail} onClick={() => void create()}>
            {busy ? "Creating…" : failed ? "Retry" : "Create Office 365 email"}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
