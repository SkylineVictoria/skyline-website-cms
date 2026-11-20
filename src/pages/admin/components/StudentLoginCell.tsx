import { studentLoginLabel, type StudentLogin } from "@/pages/admin/lib/businessData";
import { formatDate } from "@/pages/agency/lib/portalData";

const BADGE: Record<string, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-800",
  invited: "border-amber-200 bg-amber-50 text-amber-900",
  expired: "border-amber-200 bg-amber-50 text-amber-900",
  disabled: "border-background-300 bg-background-100 text-foreground-600",
  none: "border-background-300 bg-background-100 text-foreground-600",
};
// Portal access (2026-11-21): Not invited / Invited / Active / Disabled; an expired invitation is still "Invited" (with the date it ran out).
const SHORT: Record<string, string> = { active: "Active", invited: "Invited", expired: "Invited (expired)", disabled: "Disabled", none: "Not invited" };

/**
 * A student's sign-in state with its action: Invite to sign in (none / expired with no record), Resend invite (invited,
 * expired). Nothing to do once they can sign in. `disabled` is the student's own status: a disabled student cannot be invited.
 */
export default function StudentLoginCell({ login, access, email, busy, disabled = false, onInvite }: {
  login: StudentLogin | undefined;
  /** The database's portal access (2026-11-21): a disabled student shows Disabled whatever the login says. */
  access?: "not_invited" | "invited" | "active" | "disabled";
  email: string;
  busy: boolean;
  disabled?: boolean;
  onInvite: () => void;
}) {
  const status = access === "disabled" || disabled ? "disabled" : login?.status ?? "none";
  const canAct = status !== "active" && status !== "disabled" && !disabled && Boolean(email);
  return (
    <div className="flex flex-col items-start gap-1">
      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${BADGE[status] ?? BADGE.none}`} title={studentLoginLabel(login)}>
        {SHORT[status] ?? SHORT.none}
      </span>
      {status === "invited" && login?.expiresAt ? <span className="text-2xs text-foreground-500">Expires {formatDate(login.expiresAt)}</span> : null}
      {!email && status === "none" ? <span className="text-2xs text-foreground-500">Add an email to invite</span> : null}
      {canAct ? (
        <button type="button" disabled={busy} onClick={onInvite}
          className="flex cursor-pointer items-center gap-1 whitespace-nowrap text-xs font-semibold text-primary-700 hover:underline disabled:cursor-not-allowed disabled:opacity-60">
          <i className="ri-mail-send-line" aria-hidden="true" /> {busy ? "Sending…" : login?.invitationId ? "Resend invite" : "Invite to sign in"}
        </button>
      ) : null}
    </div>
  );
}
