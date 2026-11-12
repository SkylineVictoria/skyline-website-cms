import { STATUS_TONE_CLASS as TONE_CLASS, badgeColors, statusInfo, useApplicationStatuses } from "@/lib/applicationStatuses";

/** An application's status as a read-only badge: the label and colour from the database's status catalogue, never the raw key. */
export default function StatusBadge({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  const workflow = useApplicationStatuses();
  const info = statusInfo(workflow, status);
  const colors = workflow.ready ? badgeColors(info.color) : null;
  return (
    <span data-testid="status-badge" data-status={status} style={colors ?? undefined}
      className={`inline-flex items-center whitespace-nowrap rounded-full border font-semibold ${size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"} ${colors ? "" : `border-transparent ${TONE_CLASS[info.tone] ?? TONE_CLASS.neutral}`}`}>
      {workflow.ready ? info.label : <span className="inline-block h-3 w-14 animate-pulse rounded bg-current opacity-20" aria-label="Loading status" />}
    </span>
  );
}

/** "Final": a status no action leaves (Rejected, Withdrawn). */
export function FinalBadge() {
  return <span className="inline-flex items-center gap-1 rounded-full border border-background-300 px-2 py-0.5 text-[11px] font-medium text-foreground-500" data-testid="final-badge"
    title="A final status: no further action"><i className="ri-lock-line" aria-hidden="true" />Final</span>;
}
