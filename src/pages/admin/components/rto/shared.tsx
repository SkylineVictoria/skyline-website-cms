import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Select, TextInput } from "@/pages/admin/components/ui";
import { FEE_TYPES, STATUS_TONE, depositOf, feeTotal, includedByDefault, initials, isIncluded, money, phase, progress, shortDate, toCents, type FeeItem, type FeeType, type RtoIntake } from "@/pages/admin/lib/rto";

/** A panel that slides in from the right; used instead of new pages for create and edit. */
export function Drawer({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="absolute inset-0 cursor-default bg-foreground-950/30" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-lg flex-col bg-background-50 shadow-xl">
        <div className="flex items-center justify-between border-b border-background-200 px-5 py-4">
          <h2 className="font-heading text-lg font-semibold text-foreground-950">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-foreground-500 hover:bg-background-100" aria-label="Close"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-background-200 px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ErrorNote({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{text}</p> : null;
}

export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-md bg-background-100 px-3 py-2 text-xs text-foreground-600"><i className="ri-lock-line mr-1" aria-hidden="true" />{children}</p>;
}

/** Line-item fee editor with a live total. Amounts are typed in dollars and kept in cents. */
export function FeesEditor({ items, onSave, readOnly, busy, saveLabel = "Save fees" }: {
  items: FeeItem[]; onSave: (items: FeeItem[]) => void; readOnly?: boolean; busy?: boolean; saveLabel?: string;
}) {
  const toRows = (list: FeeItem[]) => list.map((i) => ({ type: i.type, label: i.label, amount: (i.amountCents / 100).toFixed(2), included: isIncluded(i) }));
  const [rows, setRows] = useState(() => toRows(items));
  useEffect(() => { setRows(toRows(items)); }, [items]);
  const parsed = rows.map((r) => ({ type: r.type, label: r.label.trim(), amountCents: toCents(r.amount), includedInTotal: r.included }));
  const invalid = parsed.some((r) => r.amountCents === null);
  const total = feeTotal(parsed.map((r) => ({ ...r, amountCents: r.amountCents ?? 0 })));
  const deposit = depositOf(parsed.map((r) => ({ ...r, amountCents: r.amountCents ?? 0 })));
  const set = (index: number, patch: Partial<(typeof rows)[number]>) => setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3">
      {rows.length === 0 ? <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">No fees yet. Add the first line item.</p> : null}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_8rem_5.5rem_auto] items-center gap-2">
          <Select value={r.type} disabled={readOnly} onChange={(e) => set(i, { type: e.target.value as FeeType, included: includedByDefault(e.target.value as FeeType) })} aria-label="Fee type">
            {FEE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
          <TextInput value={r.label} disabled={readOnly} placeholder="Label shown on letters" onChange={(e) => set(i, { label: e.target.value })} aria-label="Label" />
          <TextInput value={r.amount} disabled={readOnly} inputMode="decimal" className={`text-right tabular-nums ${toCents(r.amount) === null ? "border-primary-500" : ""}`}
            onChange={(e) => set(i, { amount: e.target.value })} aria-label="Amount (AUD)" />
          <label className="flex items-center gap-1.5 text-xs text-foreground-600" title="Counted in the total"><input type="checkbox" disabled={readOnly} checked={r.included} onChange={(e) => set(i, { included: e.target.checked })} />In total</label>
          {readOnly ? <span /> : <Button variant="ghost" size="sm" aria-label="Remove fee" icon="ri-delete-bin-line" onClick={() => setRows((list) => list.filter((_, x) => x !== i))} />}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-background-200 pt-3">
        {readOnly ? <span /> : <Button variant="outline" size="sm" icon="ri-add-line" onClick={() => setRows((list) => [...list, { type: "tuition", label: "", amount: "0.00", included: true }])}>Add line</Button>}
        <div className="text-right">
          <p className="font-heading text-lg font-semibold tabular-nums text-foreground-950">Total {money(total)}</p>
          {deposit ? <p className="text-sm tabular-nums text-foreground-600">Initial deposit (part of total) {money(deposit)}</p> : null}
        </div>
      </div>
      {readOnly ? null : (
        <div className="flex justify-end">
          <Button disabled={busy || invalid} onClick={() => onSave(parsed.map((r) => ({ type: r.type, label: r.label, amountCents: r.amountCents ?? 0, includedInTotal: r.includedInTotal })))}>{busy ? "Saving…" : saveLabel}</Button>
        </div>
      )}
    </div>
  );
}

export function Avatars({ names, max = 4 }: { names: string[]; max?: number }) {
  if (!names.length) return <span className="text-xs text-foreground-400">No trainer</span>;
  return (
    <span className="flex -space-x-2" title={names.join(", ")}>
      {names.slice(0, max).map((n) => (
        <span key={n} className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background-50 bg-secondary-100 text-[11px] font-semibold text-secondary-900">{initials(n)}</span>
      ))}
      {names.length > max ? <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background-50 bg-background-200 text-[11px] text-foreground-600">+{names.length - max}</span> : null}
    </span>
  );
}

export function IntakeStatusChip({ status }: { status: RtoIntake["status"] }) {
  return <Badge tone={STATUS_TONE[status]}>{status[0].toUpperCase() + status.slice(1)}</Badge>;
}

/** One compact intake row: course, date range with progress, enrolled / capacity, trainers, status. */
export function IntakeRow({ intake, showCourse = true }: { intake: RtoIntake; showCourse?: boolean }) {
  const pct = Math.round(progress(intake) * 100);
  const when = phase(intake);
  return (
    <Link to={`/admin/intakes/${intake.id}`} className="grid grid-cols-1 items-center gap-3 rounded-card border border-background-200 bg-background-50 px-4 py-3 transition-colors hover:border-primary-300 hover:bg-background-100 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_6rem_7rem_6rem]"
      data-testid="intake-row">
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground-900">{intake.name}</p>
        {showCourse ? <p className="truncate text-xs text-foreground-500">{intake.courseCode} {intake.courseName}{intake.campus ? ` · ${intake.campus}` : ""}</p> : intake.campus ? <p className="text-xs text-foreground-500">{intake.campus}</p> : null}
      </div>
      <div>
        <div className="flex justify-between text-xs text-foreground-500"><span>{shortDate(intake.startDate)}</span><span>{when === "running" ? `${pct}%` : when}</span><span>{shortDate(intake.endDate)}</span></div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-background-200"><div className="h-full rounded-full bg-primary-500" style={{ width: `${pct}%` }} /></div>
      </div>
      <p className="text-sm tabular-nums text-foreground-700"><i className="ri-group-line mr-1 text-foreground-400" aria-hidden="true" />{intake.enrolled}{intake.capacity ? ` / ${intake.capacity}` : ""}</p>
      <Avatars names={intake.trainers} />
      <span className="md:text-right"><IntakeStatusChip status={intake.status} /></span>
    </Link>
  );
}

export function ChipFilter<T extends string>({ label, value, options, onChange }: { label: string; value: T | ""; options: { id: T; label: string }[]; onChange: (v: T | "") => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="mr-1 text-xs font-medium text-foreground-500">{label}</span>
      {[{ id: "" as const, label: "All" }, ...options].map((o) => (
        <button key={o.id || "all"} type="button" onClick={() => onChange(o.id as T | "")}
          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${value === o.id ? "border-primary-500 bg-primary-500 text-background-50" : "border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
