import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { HR_PAGE_SIZE, hrDate, type HistoryEvent, type PersonForm } from "@/lib/recruitmentApi";

export function HrNotice({ error, children }: { error?: boolean; children: ReactNode }) {
  if (!children) return null;
  return <p role={error ? "alert" : "status"} className={`mb-3 rounded-md border px-3 py-2 text-sm ${error ? "border-primary-200 bg-primary-50 text-primary-900" : "border-secondary-200 bg-secondary-50"}`}>{children}</p>;
}

export function HrPager({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  if (total <= HR_PAGE_SIZE && offset === 0) return null;
  return <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
    <span>{Math.min(offset + 1, total)}–{Math.min(offset + HR_PAGE_SIZE, total)} of {total}</span>
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => onChange(offset - HR_PAGE_SIZE)}>Previous</Button>
      <Button size="sm" variant="outline" disabled={offset + HR_PAGE_SIZE >= total} onClick={() => onChange(offset + HR_PAGE_SIZE)}>Next</Button>
    </div>
  </nav>;
}

export function HrFields({ value, onChange, linked }: { value: PersonForm; onChange: (value: PersonForm) => void; linked?: boolean }) {
  return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="First name" required><TextInput required maxLength={100} value={value.firstName} onChange={(e) => onChange({ ...value, firstName: e.target.value })} data-testid="hr-person-first" /></Field>
    <Field label="Last name" required><TextInput required maxLength={100} value={value.lastName} onChange={(e) => onChange({ ...value, lastName: e.target.value })} data-testid="hr-person-last" /></Field>
    <Field label="Email" required hint={linked ? "Managed through the linked sign-in account." : undefined}><TextInput required readOnly={linked} type="email" maxLength={254} value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} data-testid="hr-person-email" /></Field>
    <Field label="Mobile" required hint="Australian mobile, or with the country code."><TextInput required type="tel" value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} data-testid="hr-person-phone" /></Field>
  </div>;
}

export function HrValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs font-semibold text-foreground-500">{label}</dt><dd className="break-words whitespace-pre-wrap text-sm">{children || "—"}</dd></div>;
}

export function HrHistory({ events }: { events: HistoryEvent[] }) {
  if (!events.length) return <p className="text-sm text-foreground-500">No history recorded yet.</p>;
  return <ol className="space-y-2 text-sm">{events.map((e) => <li key={e.id} className="rounded-md border border-background-200 p-2">
    <p><strong>{e.action}</strong> <span className="text-xs text-foreground-500">{hrDate(e.at)}</span></p>
    {[e.details.stage ?? e.details.status, e.details.job_title, e.details.department, e.details.decision].filter(Boolean).join(" · ")}
    {e.details.fields?.length ? <p className="text-xs text-foreground-500">{e.details.fields.map((field) => field.replaceAll("_", " ")).join(", ")}</p> : null}
  </li>)}</ol>;
}

export function HrLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="font-medium text-primary-700 hover:underline">{children}</Link>;
}
