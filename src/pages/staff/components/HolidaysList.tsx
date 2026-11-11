import { useEffect, useState } from "react";
import { listHolidays, type Holiday } from "@/lib/hrmsApi";
import { addDays, fmtDate } from "@/lib/hrTime";

/** My HR > Holidays: the next 12 months of Victorian public holidays (confirmed ones are paid days). */
export default function HolidaysList() {
  const [rows, setRows] = useState<Holiday[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    listHolidays(today, addDays(today, 365)).then(setRows, (e: unknown) => setError(e instanceof Error ? e.message : "The holidays could not be loaded."));
  }, []);
  return (
    <div data-testid="my-hr-holidays">
      {error ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{error}</p> : null}
      {!rows ? <p className="text-sm text-foreground-600">Loading…</p> : rows.length ? (
        <ul className="divide-y divide-background-200">
          {rows.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm" data-testid={`my-holiday-${h.date}`}>
              <span className="text-foreground-800">{fmtDate(h.date)} · {h.name}{h.isOptional ? " (optional: pick it under Optional holidays)" : ""}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${h.status === "confirmed" ? "bg-secondary-50 text-secondary-900" : "bg-background-200 text-foreground-700"}`}>{h.status === "confirmed" ? "Confirmed" : "To be confirmed"}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-foreground-600">No public holidays listed for the next 12 months.</p>}
    </div>
  );
}
