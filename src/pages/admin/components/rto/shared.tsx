import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { mayRefresh, useAutosave } from "@/pages/admin/lib/useAutosave";
import { Badge, Button, Select, TextInput } from "@/pages/admin/components/ui";
import {
  DEFAULT_FEE_CENTS, DEPOSIT_LIMIT_CENTS, FEE_RANK, FEE_TYPES, STATUS_TONE, depositOf, feeGst, feeTotal, includedByDefault, initials, isIncluded, isRefundable, money, phase, progress,
  refundableByDefault, shortDate, toCents, type FeeItem, type FeeType, type GstTreatment, type RtoIntake,
} from "@/pages/admin/lib/rto";

/** A panel that slides in from the right; used instead of new pages for create and edit. */
export function Drawer({ open, title, onClose, children, footer, width = "max-w-lg" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Esc closes the top-most dialog only (a drawer opened from a sheet or from another drawer).
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const all = [...document.querySelectorAll('[role="dialog"], .z-\\[80\\]')];
      if (all[all.length - 1] === ref.current) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);
  if (!open) return null;
  // Rendered on <body>, so a drawer opened from a sliding sheet covers the screen, not the sheet.
  return createPortal(
    <div ref={ref} className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="modal-backdrop-in absolute inset-0 cursor-default bg-foreground-950/30" onClick={onClose} />
      <div className={`drawer-in relative flex h-full w-full ${width} flex-col bg-background-50 shadow-xl`}>
        <div className="flex items-center justify-between border-b border-background-200 px-5 py-4">
          <h2 className="font-heading text-lg font-semibold text-foreground-950">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-foreground-500 hover:bg-background-100" aria-label="Close"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-background-200 px-5 py-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ErrorNote({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{text}</p> : null;
}

export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-md bg-background-100 px-3 py-2 text-xs text-foreground-600"><i className="ri-lock-line mr-1" aria-hidden="true" />{children}</p>;
}

/** Line-item fee editor with a live total. Amounts are typed in dollars and kept in cents. */
export function FeesEditor({ items, onSave, readOnly, busy, saveLabel = "Save fees", autosave = false }: {
  items: FeeItem[]; onSave: (items: FeeItem[]) => void; readOnly?: boolean; busy?: boolean; saveLabel?: string; autosave?: boolean;
}) {
  const toRows = (list: FeeItem[]) => [...list].sort((a, b) => (FEE_RANK[a.type] ?? 9) - (FEE_RANK[b.type] ?? 9)).map((i) => ({
    type: i.type, label: i.label, amount: (i.amountCents / 100).toFixed(2), included: isIncluded(i), refundable: isRefundable(i), gst: (i.gstTreatment ?? "gst_free") as GstTreatment,
  }));
  const [rows, setRows] = useState(() => toRows(items));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (mayRefresh(autoSent, rowsRef.current)) setRows(toRows(items)); autoSent.current = null; }, [items]);
  const parsed = rows.map((r) => ({ type: r.type, label: r.label.trim(), amountCents: toCents(r.amount), includedInTotal: r.included, refundable: r.refundable, gstTreatment: r.gst }));
  const invalid = parsed.some((r) => r.amountCents === null);
  const total = feeTotal(parsed.map((r) => ({ ...r, amountCents: r.amountCents ?? 0 })));
  const deposit = depositOf(parsed.map((r) => ({ ...r, amountCents: r.amountCents ?? 0 })));
  const gst = feeGst(parsed.map((r) => ({ ...r, amountCents: r.amountCents ?? 0 })));
  const overLimit = parsed.some((r) => r.type === "initial_deposit" && (r.amountCents ?? 0) > DEPOSIT_LIMIT_CENTS);
  /** A new line: the first of the letter's lines this course does not have yet, with its default amount. */
  const nextLine = () => {
    const type = (["application", "registration", "material", "tuition", "initial_deposit"] as FeeType[]).find((t) => !rows.some((r) => r.type === t)) ?? "other";
    return { type, label: "", amount: ((DEFAULT_FEE_CENTS[type] ?? 0) / 100).toFixed(2), included: includedByDefault(type), refundable: refundableByDefault(type), gst: "gst_free" as GstTreatment };
  };
  const set = (index: number, patch: Partial<(typeof rows)[number]>) => setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const toItems = (list: typeof rows) => list.map((r) => ({ type: r.type, label: r.label.trim(), amountCents: toCents(r.amount) ?? 0, includedInTotal: r.included, refundable: r.refundable, gstTreatment: r.gst }));
  const autoSent = useAutosave(rows, { enabled: autosave && !readOnly, dirty: JSON.stringify(rows) !== JSON.stringify(toRows(items)), valid: !invalid, save: (v) => onSave(toItems(v)) });
  return (
    <div className="space-y-3">
      {rows.length === 0 ? <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">No fees yet. Add the first line item.</p> : null}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_7rem] items-center gap-2 border-b border-background-100 pb-2 md:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_7rem_7.5rem_4.5rem_6.5rem_auto] md:border-0 md:pb-0">
          <Select value={r.type} disabled={readOnly} aria-label="Fee type" onChange={(e) => {
            const type = e.target.value as FeeType;
            set(i, { type, included: includedByDefault(type), refundable: refundableByDefault(type), ...(toCents(r.amount) === 0 && DEFAULT_FEE_CENTS[type] !== undefined ? { amount: ((DEFAULT_FEE_CENTS[type] ?? 0) / 100).toFixed(2) } : {}) });
          }}>
            {FEE_TYPES.some((t) => t.id === r.type) ? null : <option value={r.type}>{r.type}</option>}
            {FEE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
          <TextInput value={r.label} disabled={readOnly} placeholder="Label shown on letters" onChange={(e) => set(i, { label: e.target.value })} aria-label="Label" />
          <TextInput value={r.amount} disabled={readOnly} inputMode="decimal" className={`text-right tabular-nums ${toCents(r.amount) === null ? "border-primary-500" : ""}`}
            onChange={(e) => set(i, { amount: e.target.value })} aria-label="Amount (AUD)" />
          <Select value={r.gst} disabled={readOnly} aria-label="GST" className="text-xs" onChange={(e) => set(i, { gst: e.target.value as GstTreatment })}>
            <option value="gst_free">GST-free</option><option value="inclusive">GST incl.</option><option value="exclusive">+ GST</option>
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-foreground-600" title="Counted in the total fee"><input type="checkbox" disabled={readOnly} checked={r.included} onChange={(e) => set(i, { included: e.target.checked })} />In total</label>
          <label className="flex items-center gap-1.5 text-xs text-foreground-600" title="Unticked prints “(Non-Refundable)” on the letter"><input type="checkbox" disabled={readOnly} checked={r.refundable} onChange={(e) => set(i, { refundable: e.target.checked })} />Refundable</label>
          {readOnly ? <span /> : <Button variant="ghost" size="sm" aria-label="Remove fee" icon="ri-delete-bin-line" onClick={() => setRows((list) => list.filter((_, x) => x !== i))} />}
        </div>
      ))}
      {overLimit ? <p role="alert" className="rounded-md border border-accent-200 bg-accent-50 px-3 py-2 text-sm text-accent-900"><i className="ri-error-warning-line mr-1" aria-hidden="true" />Above the $1,500 pre-paid limit stated in the offer letter; the student must elect to pay more.</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-background-200 pt-3">
        {readOnly ? <span /> : <Button variant="outline" size="sm" icon="ri-add-line" onClick={() => setRows((list) => [...list, nextLine()])}>Add line</Button>}
        <div className="text-right">
          <p className="font-heading text-lg font-semibold tabular-nums text-foreground-950">Total {money(total)}</p>
          {gst ? <p className="text-sm tabular-nums text-foreground-600">GST included: {money(gst)}</p> : null}
          {deposit ? <p className="text-sm tabular-nums text-foreground-600">Initial deposit (part of total) {money(deposit)}</p> : null}
        </div>
      </div>
      {readOnly ? null : (
        <div className="flex justify-end">
          <Button disabled={busy || invalid} onClick={() => onSave(parsed.map((r) => ({ type: r.type, label: r.label, amountCents: r.amountCents ?? 0, includedInTotal: r.includedInTotal, refundable: r.refundable, gstTreatment: r.gstTreatment })))}>{busy ? "Saving…" : saveLabel}</Button>
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
