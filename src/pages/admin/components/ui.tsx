import { Toast, ToastContext, useToast } from "./toastContext";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
} from "react";
import { uploadCmsImage } from "@/pages/admin/lib/storage";

/* ------------------------------------------------------------------ Button */

type Variant = "primary" | "secondary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

const variantClass: Record<Variant, string> = {
  primary: "bg-primary-500 text-background-50 hover:bg-primary-600",
  secondary: "bg-secondary-100 text-foreground-900 hover:bg-secondary-200",
  outline: "border border-background-300 bg-background-50 text-foreground-800 hover:bg-background-100",
  ghost: "text-foreground-700 hover:bg-background-100",
  danger: "bg-foreground-900 text-background-50 hover:bg-foreground-950",
};

export function Button({
  variant = "primary",
  size = "md",
  icon,
  className = "",
  children,
  ...rest
}: {
  variant?: Variant;
  size?: Size;
  icon?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        size === "sm" ? "px-3 py-1.5 text-[13px]" : "px-4 py-2 text-sm"
      } ${variantClass[variant]} ${className}`}
      {...rest}
    >
      {icon ? <i className={`${icon} text-base`} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- Card */

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-card border border-background-200 bg-background-50 ${className}`}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- PageHeader */

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
}: {
  title: string;
  description?: string;
  breadcrumb?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-background-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div>
        {breadcrumb ? (
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-500">{breadcrumb}</p>
        ) : null}
        <h1 className="font-heading text-2xl font-bold text-foreground-950">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-sm text-foreground-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- Badge */

type Tone = "primary" | "accent" | "secondary" | "success" | "muted" | "warn";

const toneClass: Record<Tone, string> = {
  primary: "bg-primary-100 text-primary-800",
  accent: "bg-accent-100 text-accent-900",
  secondary: "bg-secondary-100 text-secondary-900",
  success: "bg-primary-100 text-primary-800",
  muted: "bg-background-200 text-foreground-600",
  warn: "bg-primary-50 text-primary-700",
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  if (status === "Published") return <Badge tone="primary">Published</Badge>;
  if (status === "Archived") return <Badge tone="muted">Archived</Badge>;
  return <Badge tone="warn">Draft</Badge>;
}

/* ------------------------------------------------------------ Form controls */

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-foreground-800">
        {label}
        {required ? <span className="text-primary-600"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-foreground-500">{hint}</span> : null}
    </label>
  );
}

const inputBase =
  "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 outline-none transition-colors placeholder:text-foreground-400 focus:border-primary-400 focus:ring-2 focus:ring-primary-100";

export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${inputBase} ${className}`} {...rest} />;
}

export function TextArea({ className = "", rows = 4, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={`${inputBase} ${className}`} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${inputBase} cursor-pointer ${className}`} {...rest}>
      {children}
    </select>
  );
}

/**
 * Media URL field — accepts a pasted URL OR a direct file upload (read as a
 * data URL for the prototype). Shows a live preview and a clear button.
 */
export function MediaUrlInput({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const upload = uploadCmsImage;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Images must be 5 MB or smaller.");
      return;
    }
    setUploading(true);
    try {
      // Assets are stored in the public `cms-media` Supabase Storage bucket and
      // served from a unique filename, so an update is never served from cache.
      const url = await upload(file);
      onChange(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Image upload failed.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-medium text-foreground-800">{label}</span>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <i className="ri-link absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
          <TextInput aria-label={`${label} URL`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Paste a URL or upload a file" className="pl-9" />
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100">
            <i className={uploading ? "ri-loader-4-line animate-spin" : "ri-upload-2-line"} aria-hidden="true" />
            {uploading ? "Uploading…" : "Upload"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              aria-label={`${label} upload`}
              className="hidden"
              disabled={uploading}
              onChange={(e) => handleFile(e.target.files?.[0] ?? undefined)}
            />
          </label>
          {value ? (
            <button
              type="button"
              onClick={() => onChange("")}
              aria-label="Clear"
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-background-300 text-foreground-500 hover:bg-background-100"
            >
              <i className="ri-close-line" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {error ? <span className="mt-1 block text-xs text-primary-700">{error}</span> : null}
      {value ? (
        <div className="mt-2 inline-flex items-center gap-3 rounded-md border border-background-200 bg-background-100 px-3 py-2">
          <span className="flex h-10 w-16 items-center justify-center overflow-hidden rounded bg-background-50">
            <img src={value} alt={`${label} preview`} className="max-h-full max-w-full object-contain" />
          </span>
          <span className="max-w-[240px] truncate text-xs text-foreground-500">{value.startsWith("data:") ? "Uploaded file" : value}</span>
        </div>
      ) : null}
      {hint ? <span className="mt-1 block text-xs text-foreground-500">{hint}</span> : null}
    </div>
  );
}

/**
 * The single canonical switch used across the whole application.
 * Compact, fixed dimensions (36 × 20 track, 16 × 16 thumb) that never stretch
 * inside flex/grid rows. Accessible: role="switch", aria-checked, focus ring.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex shrink-0 cursor-pointer items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-primary-500" : "bg-background-300"}`}
      >
        <span
          className="pointer-events-none block h-4 w-4 rounded-full bg-background-50 transition-transform duration-200"
          style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
        />
      </span>
      {label ? <span className="text-sm text-foreground-700">{label}</span> : null}
    </button>
  );
}

/* -------------------------------------------------------------- Empty/Stat */

export function EmptyState({ icon = "ri-inbox-line", title, description }: { icon?: string; title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-background-100 text-foreground-400">
        <i className={`${icon} text-2xl`} aria-hidden="true" />
      </span>
      <p className="font-heading text-base font-semibold text-foreground-900">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-foreground-500">{description}</p> : null}
    </div>
  );
}

export function StatCard({ label, value, icon, hint }: { label: string; value: string | number; icon: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[13px] font-medium text-foreground-500">{label}</p>
          <p className="mt-1.5 font-heading text-2xl font-bold text-foreground-950">{value}</p>
          {hint ? <p className="mt-1 text-xs text-foreground-500">{hint}</p> : null}
        </div>
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
          <i className={`${icon} text-xl`} aria-hidden="true" />
        </span>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- SectionTabs */

export function SectionTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; icon?: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
            active === t.id
              ? "border-primary-500 bg-primary-500 text-background-50"
              : "border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100"
          }`}
        >
          {t.icon ? <i className={`${t.icon} text-sm`} aria-hidden="true" /> : null}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- Modal */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground-950/40" onClick={onClose} aria-hidden="true" />
      <div className={`relative w-full ${width} rounded-card border border-background-200 bg-background-50`}>
        <div className="flex items-center justify-between border-b border-background-200 px-5 py-3.5">
          <h2 className="font-heading text-base font-semibold text-foreground-950">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
          >
            <i className="ri-close-line text-lg" aria-hidden="true" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-background-200 px-5 py-3.5">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-foreground-700">{message}</p>
    </Modal>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-md border border-background-200 bg-background-50 px-4 py-3 shadow-lg animate-fade-in"
          >
            <i
              className={`${t.tone === "error" ? "ri-error-warning-line text-primary-600" : t.tone === "info" ? "ri-information-line text-foreground-500" : "ri-checkbox-circle-line text-primary-600"} mt-0.5 text-lg`}
              aria-hidden="true"
            />
            <span className="text-sm text-foreground-800">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* -------------------------------------------------------- Loading / Error */

export function AdminLoading({ label = "Loading your content…" }: { label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="mb-6 h-9 w-56 animate-pulse rounded-md bg-background-200" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-card bg-background-200" />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="h-64 animate-pulse rounded-card bg-background-200" />
        <div className="h-64 animate-pulse rounded-card bg-background-200 xl:col-span-2" />
      </div>
      <p className="mt-4 text-center text-sm text-foreground-500">{label}</p>
    </div>
  );
}

export function AdminError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center" role="alert">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-primary-600">
        <i className="ri-error-warning-line text-2xl" aria-hidden="true" />
      </span>
      <p className="font-heading text-base font-semibold text-foreground-900">Something went wrong loading the CMS</p>
      <p className="mt-1 max-w-sm text-sm text-foreground-500">
        {message || "We couldn't load your content. Please try again."}
      </p>
      <div className="mt-4">
        <Button icon="ri-refresh-line" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

export function InlineLoader({ label = "Saving…" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-foreground-500">
      <i className="ri-loader-4-line animate-spin" aria-hidden="true" />
      {label}
    </span>
  );
}