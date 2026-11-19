// Weekly hours and time off: the same two cards for a person's own availability and a room's (Bookings › Availability).
import type { ReactNode } from "react";
import { Button, Card } from "@/pages/admin/components/ui";
import { WEEKDAYS, type AvailabilityRow, type TimeOffRow } from "@/lib/bookingApi";

const INPUT = "rounded-md border border-background-300 bg-background-50 px-2 py-1.5 text-sm disabled:opacity-70";

export function HoursCard({ rows, onChange, title, intro, emptyLabel, extra, readOnly }: {
  rows: AvailabilityRow[]; onChange: (rows: AvailabilityRow[]) => void; title: ReactNode; intro: ReactNode; emptyLabel: string;
  /** Shown beside a day's hours (a room: the intakes using it that day). */
  extra?: (weekday: number) => ReactNode; readOnly?: boolean;
}) {
  const patch = (index: number, p: Partial<AvailabilityRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...p } : r)));
  // Monday first, Sunday last.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <Card className="p-5">
      <h2 className="font-heading text-base font-bold text-foreground-950">{title}</h2>
      <p className="text-sm text-foreground-600">{intro}</p>
      <div className="mt-3 divide-y divide-background-200">
        {order.map((weekday) => {
          const label = WEEKDAYS[weekday];
          const mine = rows.map((r, index) => ({ r, index })).filter((x) => x.r.weekday === weekday);
          return (
            <div key={label} className="flex flex-wrap items-start gap-3 py-2.5">
              <span className="w-24 pt-2 text-sm font-medium text-foreground-900">{label}</span>
              <div className="min-w-0 flex-1 space-y-2">
                {mine.length === 0 ? <p className="pt-2 text-sm text-foreground-500">{emptyLabel}</p> : mine.map(({ r, index }) => (
                  <div key={index} className="flex items-center gap-2">
                    <input type="time" aria-label={`${label} from`} value={r.start} disabled={readOnly} onChange={(e) => patch(index, { start: e.target.value })} className={INPUT} />
                    <span className="text-sm text-foreground-600">to</span>
                    <input type="time" aria-label={`${label} to`} value={r.end} disabled={readOnly} onChange={(e) => patch(index, { end: e.target.value })} className={INPUT} />
                    {readOnly ? null : <Button size="sm" variant="ghost" aria-label={`Remove ${label} hours`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><i className="ri-close-line" aria-hidden="true" /></Button>}
                  </div>
                ))}
                {extra ? extra(weekday) : null}
              </div>
              {readOnly ? null : <Button size="sm" variant="outline" onClick={() => onChange([...rows, { weekday, start: "09:00", end: "17:00" }])}>Add hours</Button>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function TimeOffCard({ rows, onChange, intro, notePlaceholder, readOnly }: {
  rows: TimeOffRow[]; onChange: (rows: TimeOffRow[]) => void; intro: string; notePlaceholder: string; readOnly?: boolean;
}) {
  const patch = (index: number, p: Partial<TimeOffRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...p } : r)));
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="font-heading text-base font-bold text-foreground-950">Time off</h2><p className="text-sm text-foreground-600">{intro}</p></div>
        {readOnly ? null : <Button size="sm" variant="outline" onClick={() => onChange([...rows, { start: "", end: "", note: "" }])}>Add time off</Button>}
      </div>
      {rows.length === 0 ? <p className="mt-3 text-sm text-foreground-500">None.</p> : rows.map((o, index) => (
        <div key={index} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="date" aria-label="First day" value={o.start} disabled={readOnly} onChange={(e) => patch(index, { start: e.target.value, end: o.end && o.end >= e.target.value ? o.end : e.target.value })} className={INPUT} />
          <span className="text-sm text-foreground-600">to</span>
          <input type="date" aria-label="Last day" value={o.end} min={o.start} disabled={readOnly} onChange={(e) => patch(index, { end: e.target.value })} className={INPUT} />
          <input type="text" aria-label="Note" placeholder={notePlaceholder} maxLength={200} value={o.note} disabled={readOnly} onChange={(e) => patch(index, { note: e.target.value })} className={`min-w-[10rem] flex-1 ${INPUT}`} />
          {readOnly ? null : <Button size="sm" variant="ghost" aria-label="Remove time off" onClick={() => onChange(rows.filter((_, i) => i !== index))}><i className="ri-close-line" aria-hidden="true" /></Button>}
        </div>
      ))}
    </Card>
  );
}
