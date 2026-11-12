import type { CcDefault } from "@/lib/ccAgent";

/**
 * "CC agent: <name> <email>", ticked by default when the application came through an agent; a warning when the agent has no email
 * (the agency's main email gets the copy) or there is none at all. Nothing for a direct student or when the agent is the recipient.
 */
export function CcAgent({ cc, on, onChange, recipientEmail }: { cc: CcDefault | null; on: boolean; onChange: (on: boolean) => void; recipientEmail?: string }) {
  if (!cc?.applies) return null;
  if (cc.email && recipientEmail && cc.email.toLowerCase() === recipientEmail.toLowerCase()) return null;
  const who = cc.agentEmail ? `${cc.agentName || "Agent"} <${cc.agentEmail}>` : cc.email ? `${cc.agencyName || "Agency"} <${cc.email}>` : "";
  return (
    <div className="mt-2 border-t border-background-200 pt-2" data-testid="cc-agent">
      {cc.email ? (
        <label className="flex items-start gap-2 text-sm text-foreground-800">
          <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-primary-600" data-testid="cc-agent-toggle" />
          <span>CC {cc.agentEmail ? "agent" : "agency"}: <span className="font-medium">{who}</span><span className="block text-xs text-foreground-500">Gets a copy and sees the status in the portal.</span></span>
        </label>
      ) : null}
      {cc.warning ? <p className="mt-1 flex items-start gap-1 text-xs text-amber-800" data-testid="cc-agent-warning"><i className="ri-error-warning-line" aria-hidden="true" />{cc.warning}</p> : null}
    </div>
  );
}
