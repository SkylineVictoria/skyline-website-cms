// Overlays and small pieces shared by the intake, batch and rooms screens: a right-hand sheet, a "⋯" menu, skeleton cards and
// keyboard shortcuts. Motion is 150–250 ms ease-out and is switched off for people who ask for reduced motion.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { STATUS_TONE, type IntakeStatus } from "@/pages/admin/lib/rto";

/** Another dialog is open above this one (a drawer or a confirm box): Esc belongs to it. */
const MODALS = '[role="dialog"], .z-\\[80\\]';
const otherDialogOpen = (self: HTMLElement | null) => [...document.querySelectorAll<HTMLElement>(MODALS)].some((d) => d !== self);

/** A panel from the right: about 70% wide, the whole screen on a phone. Esc or the backdrop closes it. */
export function Sheet({ open, label, onClose, children }: { open: boolean; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!open) { setShown(false); return; }
    const t = window.requestAnimationFrame(() => setShown(true));
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !otherDialogOpen(ref.current)) onClose(); };
    window.addEventListener("keydown", key);
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { window.cancelAnimationFrame(t); window.removeEventListener("keydown", key); document.body.style.overflow = overflow; };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[45] flex justify-end">
      <button type="button" aria-label="Close" onClick={onClose}
        className={`absolute inset-0 cursor-default bg-foreground-950/30 transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label}
        className={`relative flex h-full w-full flex-col bg-background-100 shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none min-[1281px]:w-[85%] min-[1441px]:w-[70%] min-[1281px]:max-w-[1400px] ${shown ? "translate-x-0" : "translate-x-full"}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem { label: string; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean }
/** The "⋯" button with secondary actions. */
export function MoreMenu({ label, items, size = "sm" }: { label: string; items: MenuItem[]; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key, true); };
  }, [open]);
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={`flex items-center justify-center rounded-md text-foreground-500 transition-colors duration-150 hover:bg-background-200 hover:text-foreground-800 ${size === "sm" ? "h-8 w-8" : "h-9 w-9"}`}>
        <i className="ri-more-2-fill text-lg" aria-hidden="true" />
      </button>
      {open ? (
        <div role="menu" className="fade-in absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-background-200 bg-background-50 py-1 text-sm shadow-lg">
          {shown.map((it) => (
            <button key={it.label} type="button" role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick(); }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left disabled:opacity-50 ${it.danger ? "text-red-700 hover:bg-red-50" : "text-foreground-800 hover:bg-background-100"}`}>
              {it.icon ? <i className={it.icon} aria-hidden="true" /> : null}{it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Grey placeholders while a list loads. */
export function SkeletonCards({ count = 6, className = "h-44" }: { count?: number; className?: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => <div key={i} className={`animate-pulse rounded-card border border-background-200 bg-background-50 motion-reduce:animate-none ${className}`} />)}
    </div>
  );
}
export function SkeletonLines({ lines = 4 }: { lines?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="h-10 animate-pulse rounded-md bg-background-200/70 motion-reduce:animate-none" />)}
    </div>
  );
}

/** A friendly empty state with one action. */
export function Empty({ icon, title, text, action }: { icon: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-dashed border-background-300 bg-background-50 px-6 py-10 text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-primary-600"><i className={`${icon} text-2xl`} aria-hidden="true" /></span>
      <p className="font-heading text-base font-semibold text-foreground-950">{title}</p>
      {text ? <p className="mt-1 max-w-sm text-sm text-foreground-600">{text}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** A numbered section of a page with its helper line. */
export function Section({ n, title, helper, action, children }: { n?: number; title: string; helper: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-card border border-background-200 bg-background-50">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-background-200 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="font-heading text-base font-semibold text-foreground-950">{n ? <span className="mr-1.5 text-foreground-400">{n}</span> : null}{title}</h2>
          <p className="text-sm text-foreground-600">{helper}</p>
        </div>
        {action}
      </div>
      <div className="px-4 py-3 sm:px-5">{children}</div>
    </section>
  );
}

const STATUSES: { id: IntakeStatus; label: string; hint: string }[] = [
  { id: "draft", label: "Draft", hint: "Not offered yet" }, { id: "open", label: "Open", hint: "Offered on the website and forms" },
  { id: "full", label: "Full", hint: "No more students" }, { id: "closed", label: "Closed", hint: "Finished or cancelled" },
];
const TONE: Record<string, string> = {
  primary: "border-primary-200 bg-primary-50 text-primary-800", accent: "border-accent-200 bg-accent-50 text-accent-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900", muted: "border-background-300 bg-background-100 text-foreground-600",
};

/** The status as a chip; an RTO Manager clicks it to change it. */
export function StatusPicker({ status, canEdit, onChange }: { status: IntakeStatus; canEdit: boolean; onChange: (s: IntakeStatus) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const label = STATUSES.find((s) => s.id === status)?.label ?? status;
  const chip = `inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE[STATUS_TONE[status]]}`;
  if (!canEdit) return <span className={chip}>{label}</span>;
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`${chip} transition-shadow duration-150 hover:shadow-sm`} aria-haspopup="listbox" aria-expanded={open} aria-label={`Status: ${label}. Change`} onClick={() => setOpen((o) => !o)}>
        {label}<i className="ri-arrow-down-s-line" aria-hidden="true" />
      </button>
      {open ? (
        <div role="listbox" className="fade-in absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-background-200 bg-background-50 py-1 shadow-lg">
          {STATUSES.map((s) => (
            <button key={s.id} type="button" role="option" aria-selected={s.id === status} onClick={() => { setOpen(false); onChange(s.id); }}
              className={`flex w-full flex-col px-3 py-1.5 text-left hover:bg-background-100 ${s.id === status ? "bg-background-100" : ""}`}>
              <span className="text-sm font-medium text-foreground-900">{s.label}</span><span className="text-xs text-foreground-500">{s.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

