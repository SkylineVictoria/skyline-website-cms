import { STATUS_TONE_CLASS as TONE_CLASS, statusInfo, useApplicationStatuses } from "@/lib/applicationStatuses";

/** An application's status as a read-only badge: label and colour from the database's status catalogue. */
export default function StatusBadge({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  const workflow = useApplicationStatuses();
  const info = statusInfo(workflow, status);
  return (
    <span data-testid="status-badge" data-status={status}
      className={`inline-flex items-center whitespace-nowrap rounded-full font-semibold ${size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"} ${TONE_CLASS[info.tone] ?? TONE_CLASS.neutral}`}>
      {workflow.ready ? info.label : <span className="inline-block h-3 w-14 animate-pulse rounded bg-current opacity-20" aria-label="Loading status" />}
    </span>
  );
}
