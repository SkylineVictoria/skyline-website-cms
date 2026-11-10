import type { ReactNode } from "react";

/** The plain controls a wizard screen is made of: the same label, input and error line for students and staff. */

export const WIZARD_INPUT = "w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";
export const WIZARD_LABEL = "mb-1.5 block text-[13px] font-medium text-foreground-800";

export function WizardLabel({ htmlFor, children, required = true }: { htmlFor: string; children: ReactNode; required?: boolean }) {
  return required
    ? <label htmlFor={htmlFor} className={WIZARD_LABEL}>{children} <span className="text-primary-600">*</span></label>
    : <label htmlFor={htmlFor} className={WIZARD_LABEL}>{children}</label>;
}

/** The message under a field. */
export function FieldError({ text }: { text?: string }) {
  return text ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{text}</p> : null;
}

/** A labelled text input with its error line. `children` goes between the input and the error (a hint, a source label). */
export function WizardTextField({ id, name, label, value, error, onChange, onBlur, required = true, placeholder, maxLength = 200, upper, type, inputMode, min, max, autoComplete = "off", testId, children }: {
  id: string;
  name: string;
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
  /** Typed letters become capitals (a USI, a passport number). */
  upper?: boolean;
  type?: string;
  inputMode?: "numeric" | "text";
  min?: string;
  max?: string;
  autoComplete?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div>
      <WizardLabel htmlFor={id} required={required}>{label}</WizardLabel>
      <input id={id} name={name} value={value} maxLength={maxLength} placeholder={placeholder} autoComplete={autoComplete}
        aria-invalid={Boolean(error)} className={WIZARD_INPUT} type={type} inputMode={inputMode} min={min} max={max} data-testid={testId}
        onChange={(e) => onChange(upper ? e.target.value.toUpperCase() : e.target.value)} onBlur={onBlur} />
      {children}
      <FieldError text={error} />
    </div>
  );
}
