import type { ReactNode } from "react";
import InfoTip from "./InfoTip";

/** 12px uppercase muted label, as used above every control on the form (and for the page's own choice groups). */
export const FORM_LABEL = "text-xs font-medium uppercase tracking-wide text-foreground-500";

/**
 * One field on the compact form: the label row (label, required mark, an (i) for the help text, a small adornment such as an
 * expiry warning), the control, and its messages. An auto-filled value shows a small dot inside the control until it is edited.
 * `data-field` carries the field name, so a document fill can reveal the fields it filled one after another.
 */
export default function Field({ id, name, label, required, help, adornment, autoFilled, dotInset, full, hidden, messages, children }: {
  id: string;
  name: string;
  label: ReactNode;
  required?: boolean;
  /** Longer help text: moved into the (i) tooltip. */
  help?: string;
  adornment?: ReactNode;
  autoFilled?: boolean;
  /** Controls with their own icon at the right (select arrow, date picker): the dot sits left of it. */
  dotInset?: boolean;
  full?: boolean;
  hidden?: boolean;
  messages?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-scan-field data-field={name} hidden={hidden} className={full ? "md:col-span-2" : ""}>
      {label || help || adornment ? (
        <div className="mb-1 flex min-h-4 items-center gap-1.5">
          {label ? (
            <label htmlFor={id} className={FORM_LABEL}>
              {label}
              {required ? <span className="ml-0.5 text-red-600" aria-hidden="true">*</span> : null}
            </label>
          ) : null}
          {help ? <InfoTip text={help} /> : null}
          {adornment}
        </div>
      ) : null}
      <div className="relative">
        {children}
        {autoFilled ? (
          <span
            aria-hidden="true"
            title="Auto-filled from your document"
            className={`pointer-events-none absolute top-5 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-foreground-400 ${dotInset ? "right-9" : "right-3"}`}
          />
        ) : null}
      </div>
      {messages}
    </div>
  );
}

/**
 * A short message under a field (required, wrong format). `alert: false` for the many "required" marks shown at once;
 * `missingMarker` marks it as a missing answer that Next scrolls to and focuses.
 */
export function FieldMessage({ children, alert = true, missingMarker = false }: { children: ReactNode; alert?: boolean; missingMarker?: boolean }) {
  return (
    <p role={alert ? "alert" : undefined} data-field-missing={missingMarker ? "true" : undefined} className="fade-in mt-1 flex items-center gap-1 text-xs text-red-700">
      <i className="ri-error-warning-line text-base leading-none" aria-hidden="true" />
      {children}
    </p>
  );
}
