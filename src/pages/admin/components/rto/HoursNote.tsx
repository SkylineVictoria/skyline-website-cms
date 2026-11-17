import type { HoursCheck } from "@/pages/admin/lib/rto";

/** A warning when a batch's weekly classes cannot fit the course hours by the intake's end. Nothing is shown when they fit. */
export default function HoursNote({ check, compact = false }: { check?: HoursCheck; compact?: boolean }) {
  if (!check || check.fits || !check.message) return null;
  return (
    <p role="status" className={`${compact ? "mt-2 text-xs" : "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm"} text-amber-900`} data-testid="hours-warning">
      <i className="ri-error-warning-line mr-1" aria-hidden="true" />{check.message}
    </p>
  );
}
