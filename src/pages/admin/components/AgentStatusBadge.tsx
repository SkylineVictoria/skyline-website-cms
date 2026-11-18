import type { AgentStatus } from "@/pages/admin/lib/businessData";

/** Active green, Invited amber (approved, waiting to accept), Onboarding blue (shown as "Invite held": their business is still onboarding), Declined red, Inactive grey. */
export default function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const style = status === "Active" ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200"
    : status === "Invited" ? "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-200"
    : status === "Onboarding" ? "bg-sky-50 text-sky-900 ring-1 ring-inset ring-sky-200"
    : status === "Declined" ? "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200" : "bg-background-200 text-foreground-600";
  const dot = status === "Active" ? "bg-emerald-500" : status === "Invited" ? "bg-amber-500" : status === "Onboarding" ? "bg-sky-500" : status === "Declined" ? "bg-red-500" : "bg-foreground-400";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />{status === "Onboarding" ? "Invite held" : status}
    </span>
  );
}
