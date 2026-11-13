import { Link } from "react-router-dom";
import { sortedStatusCounts } from "@/pages/admin/lib/agencyStatus";
import { STATUS_TONE_CLASS as TONE_CLASS, statusInfo, useApplicationStatuses } from "@/lib/applicationStatuses";
import StatusBadge from "@/components/shared/application-status/StatusBadge";

/** Active is green and Inactive is grey, so an active agency never reads as a warning. */
export function AgencyStatusBadge({ status, imported = false }: { status: string; imported?: boolean }) {
  if (imported) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-background-200 px-2.5 py-0.5 text-xs font-medium text-foreground-600">
        <span className="h-1.5 w-1.5 rounded-full bg-foreground-400" aria-hidden="true" />
        Not added
      </span>
    );
  }
  const active = status === "Active";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        active ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200" : "bg-background-200 text-foreground-600"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-foreground-400"}`} aria-hidden="true" />
      {active ? "Active" : "Inactive"}
    </span>
  );
}

/**
 * One small pill per application status with its count. With `hrefFor`, each pill links to the applications already
 * filtered to that status.
 */
export function ApplicationStatusPills({ counts, hrefFor, limit }: { counts: Record<string, number> | undefined; hrefFor?: (status: string) => string; limit?: number }) {
  const workflow = useApplicationStatuses();
  const entries = sortedStatusCounts(counts, workflow.statuses);
  if (entries.length === 0) return null;
  const shown = limit ? entries.slice(0, limit) : entries;
  const hidden = entries.length - shown.length;
  return (
    <ul className="flex flex-wrap gap-1">
      {shown.map(([status, count]) => {
        const meta = { label: statusInfo(workflow, status).label, className: TONE_CLASS[statusInfo(workflow, status).tone] };
        const pill = (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${meta.className}`}>
            <span className="tabular-nums font-semibold">{count}</span> {meta.label}
          </span>
        );
        return (
          <li key={status}>
            {hrefFor ? (
              <Link to={hrefFor(status)} className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400" title={`Show ${meta.label.toLowerCase()} applications`}>
                {pill}
              </Link>
            ) : pill}
          </li>
        );
      })}
      {hidden > 0 ? <li className="self-center text-2xs text-foreground-500">+{hidden} more</li> : null}
    </ul>
  );
}

/** One application status, coloured as everywhere else in the portal (labels and colours from the database). */
export function ApplicationStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={status} size="sm" />;
}

/** Completion bar with its percentage. */
export function CompletionBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-background-200" aria-hidden="true">
        <span className={`block h-full ${pct === 100 ? "bg-emerald-600" : "bg-primary-500"}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs tabular-nums">{pct}%</span>
    </span>
  );
}
