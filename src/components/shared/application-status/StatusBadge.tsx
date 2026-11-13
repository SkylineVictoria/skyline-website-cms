import { badgeColors, useApplicationStatuses } from "@/lib/applicationStatuses";

/**
 * An application's status as a read-only badge: the label and colour from the database's status catalogue only. While it loads, a
 * placeholder; when the catalogue could not be read, "—" (the page shows "Couldn't load statuses · Retry"); never the raw key.
 */
export default function StatusBadge({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  const workflow = useApplicationStatuses();
  const info = workflow.statuses.find((s) => s.value === status);
  const colors = info ? badgeColors(info.color) : null;
  const sizeClass = size === "sm" ? "px-2 py-0.5 text-2xs" : "px-2.5 py-1 text-xs";
  if (!workflow.ready) {
    return workflow.error
      ? <span data-testid="status-badge" data-status={status} title="Couldn't load statuses" className={`inline-flex rounded-full border border-background-300 text-foreground-400 ${sizeClass}`}>—</span>
      : <span data-testid="status-badge" data-status={status} className={`inline-flex rounded-full border border-background-200 ${sizeClass}`}><span className="inline-block h-3 w-14 animate-pulse rounded bg-background-200" aria-label="Loading status" /></span>;
  }
  return (
    <span data-testid="status-badge" data-status={status} style={colors ?? undefined}
      className={`inline-flex items-center whitespace-nowrap rounded-full border font-semibold ${sizeClass} ${colors ? "" : "border-background-300 text-foreground-500"}`}>
      {info?.label ?? "—"}
    </span>
  );
}

/** "Final": a status no action leaves (Rejected, Withdrawn). */
export function FinalBadge() {
  return <span className="inline-flex items-center gap-1 rounded-full border border-background-300 px-2 py-0.5 text-2xs font-medium text-foreground-500" data-testid="final-badge"
    title="A final status: no further action"><i className="ri-lock-line" aria-hidden="true" />Final</span>;
}

/** The status configuration could not be read: say so where statuses and actions should be, with Retry. */
export function StatusConfigError({ compact = false }: { compact?: boolean }) {
  const workflow = useApplicationStatuses();
  if (!workflow.error) return null;
  return (
    <span role="alert" data-testid="status-config-error" title={workflow.error}
      className={`inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 text-red-800 ${compact ? "px-1.5 py-0.5 text-2xs" : "px-2.5 py-1 text-xs"}`}>
      <i className="ri-error-warning-line" aria-hidden="true" />Couldn&rsquo;t load statuses
      <span aria-hidden="true">&middot;</span>
      <button type="button" onClick={workflow.retry} className="cursor-pointer font-semibold underline underline-offset-2">Retry</button>
    </span>
  );
}
