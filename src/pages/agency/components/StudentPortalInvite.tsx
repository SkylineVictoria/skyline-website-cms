import { useCallback, useEffect, useState } from "react";
import { invokePortalUsers } from "@/pages/agency/lib/portalData";
import { portalPasswordResetUrl } from "@/pages/agency/lib/portalAuthContext";
import { getStudentPortalState, studentPortalLabel, type StudentPortalState } from "@/pages/agency/lib/portalApplications";

/**
 * STUDENT-PORTAL-INVITE (2026-11-24, owner): on an application, the student's agent, the business admin agent or SLIT sends the student
 * their portal invitation by hand (or sends it again). The email links to /agency/accept-invite, where the student creates a password and
 * then signs in to their workspace. The database decides who may invite which student; this only shows the state and asks.
 */
export default function StudentPortalInvite({ studentId, studentName, onMessage }: { studentId: string; studentName: string; onMessage?: (text: string) => void }) {
  const [state, setState] = useState<StudentPortalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setState(await getStudentPortalState(studentId)); setError(""); } catch { setState(null); }
  }, [studentId]);
  useEffect(() => { void load(); }, [load]);
  if (!state) return null; // not allowed to see it, or the database function is not there yet

  const { label, action } = studentPortalLabel(state.status);
  const send = async () => {
    if (!action) return;
    setBusy(true); setError("");
    try {
      const data = action === "resend" && state.invitationId
        ? await invokePortalUsers({ action: "resend", invitationId: state.invitationId, redirectTo: portalPasswordResetUrl() })
        : await invokePortalUsers({ action: "invite", role: "student", studentId, email: state.email, name: studentName || state.email, redirectTo: portalPasswordResetUrl() });
      onMessage?.(data.warning ? String(data.warning) : `Portal invitation ${action === "resend" ? "sent again" : "sent"} to ${state.email}. The student creates a password, then signs in.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The invitation could not be sent.");
    } finally { setBusy(false); }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="student-portal-invite">
      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${state.status === "active" ? "border-secondary-200 bg-secondary-50 text-secondary-800" : "border-background-300 bg-background-50 text-foreground-700"}`}>{label}</span>
      {action ? (
        <button type="button" disabled={busy || !state.email} onClick={() => void send()} data-testid="student-portal-invite-send"
          title={state.email ? `Send the portal invitation to ${state.email}` : "Add the student's email first"}
          className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3.5 py-2 text-xs font-semibold text-foreground-800 hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-60">
          <i className={action === "resend" ? "ri-mail-send-line" : "ri-user-shared-line"} aria-hidden="true" />
          {busy ? "Sending…" : action === "resend" ? "Resend portal invite" : "Invite to portal"}
        </button>
      ) : null}
      {error ? <span role="alert" className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
