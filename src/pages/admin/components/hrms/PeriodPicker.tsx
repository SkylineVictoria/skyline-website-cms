import { Field, Select } from "@/pages/admin/components/ui";
import type { PayPeriod, PaySchedule } from "@/lib/hrmsApi";
import { PERIOD_STATUS_LABEL, fmtRange } from "@/lib/hrTime";



/** Picks a schedule and one of its periods (shared by Timesheets, Xero export and the team pages). */
export default function PeriodPicker({ schedules, scheduleId, periodId, onSchedule, onPeriod, testId = "period" }: {
  schedules: (PaySchedule & { periods?: PayPeriod[] })[]; scheduleId: string; periodId: string;
  onSchedule: (id: string) => void; onPeriod: (id: string) => void; testId?: string;
}) {
  const schedule = schedules.find((s) => s.id === scheduleId) ?? schedules[0];
  const periods = [...(schedule?.periods ?? [])].sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Pay schedule">
        <Select value={schedule?.id ?? ""} onChange={(e) => onSchedule(e.target.value)} data-testid={`${testId}-schedule`}>
          {schedules.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.frequency})</option>)}
        </Select>
      </Field>
      <Field label="Pay period">
        <Select value={periodId} onChange={(e) => onPeriod(e.target.value)} data-testid={`${testId}-period`}>
          {periods.map((p) => <option key={p.id} value={p.id}>{fmtRange(p.startDate, p.endDate)} · {PERIOD_STATUS_LABEL[p.status]}</option>)}
        </Select>
      </Field>
    </div>
  );
}
