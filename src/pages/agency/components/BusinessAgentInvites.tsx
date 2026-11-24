import { useCallback, useEffect, useState } from "react";
import { agentInviteState, invokePortalUsers, listMyBusinessAgents, type BusinessAgentRow } from "@/pages/agency/lib/portalData";
import { portalPasswordResetUrl } from "@/pages/agency/lib/portalAuthContext";

const TONE: Record<ReturnType<typeof agentInviteState>["tone"], string> = {
  ok: "bg-secondary-50 text-secondary-800 border-secondary-200",
  wait: "bg-primary-50 text-primary-800 border-primary-200",
  warn: "bg-amber-50 text-amber-900 border-amber-200",
  off: "bg-background-100 text-foreground-600 border-background-200",
};

/**
 * Users › Your agents (2026-11-24): the business admin agent sees every agent of their business and sends each one their sign-in
 * invitation (or sends it again) with one tap. portal-admin-users and the database decide who may invite whom; this only lists and asks.
 */
export default function BusinessAgentInvites({ onSent }: { onSent?: (message: string) => void }) {
  const [agents, setAgents] = useState<BusinessAgentRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try { setAgents(await listMyBusinessAgents()); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "We could not load your agents."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const send = async (a: BusinessAgentRow, action: "invite" | "resend") => {
    setBusy(a.id); setError("");
    try {
      const data = action === "resend" && a.invitation
        ? await invokePortalUsers({ action: "resend", invitationId: a.invitation.id, redirectTo: portalPasswordResetUrl() })
        : await invokePortalUsers({ action: "invite", email: a.email, name: a.name, role: a.role, redirectTo: portalPasswordResetUrl() });
      onSent?.(data.warning ? String(data.warning) : `Sign-in invitation ${action === "resend" ? "sent again" : "sent"} to ${a.email}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The invitation could not be sent.");
    } finally { setBusy(""); }
  };

  const waiting = (agents ?? []).filter((a) => agentInviteState(a).action === "invite").length;
  return (
    <section className="mt-6 overflow-hidden rounded-card border border-background-200 bg-background-50" data-testid="business-agent-invites">
      <div className="flex flex-col gap-1 border-b border-background-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-heading text-base font-semibold text-foreground-950">Your agents</h2>
          <p className="text-sm text-foreground-600">Send each agent their sign-in invitation so they can use the workspace.{waiting ? ` ${waiting} not invited yet.` : ""}</p>
        </div>
      </div>
      {error ? <p role="alert" className="px-4 pt-3 text-sm text-red-700">{error}</p> : null}
      {agents === null ? <p className="px-4 py-3 text-sm text-foreground-500">{error ? "" : "Loading…"}</p>
        : !agents.length ? <p className="px-4 py-3 text-sm text-foreground-600">No agents yet. Use Add user to invite one.</p> : (
        <ul className="divide-y divide-background-100">
          {agents.map((a) => {
            const s = agentInviteState(a);
            return (
              <li key={a.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`business-agent-${a.id}`}>
                <div className="min-w-0">
                  <p className="font-medium text-foreground-950">{a.name}{a.role === "agency_admin" ? <span className="ml-2 text-xs font-normal text-foreground-500">Business admin agent</span> : null}</p>
                  <p className="break-all text-sm text-foreground-600">{a.email || "No email"}</p>
                  {a.invitation?.status === "pending" ? <p className="text-xs text-foreground-500">Last sent {new Date(a.invitation.lastSentAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[s.tone]}`}>{s.label}</span>
                  {s.action ? (
                    <button type="button" disabled={busy === a.id} onClick={() => void send(a, s.action!)} data-testid={`invite-agent-${a.id}`}
                      className="inline-flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary-500 px-3 py-1.5 text-sm font-semibold text-background-50 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none">
                      <i className={s.action === "resend" ? "ri-mail-send-line" : "ri-user-shared-line"} aria-hidden="true" />
                      {busy === a.id ? "Sending…" : s.action === "resend" ? "Resend" : "Invite"}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
