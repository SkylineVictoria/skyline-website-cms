import { createElement as h, useEffect, useId, useRef, useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes, type ReactNode } from "react";
import EmailInUseMessage from "./EmailInUseMessage";
import {
  EMAIL_CHECK_DEBOUNCE_MS,
  checkEmailAvailable,
  emailStatusBlocks,
  emailTakenFrom,
  normalizeEmail,
  shouldCheckEmail,
  type EmailAvailability,
  type EmailFieldContext,
  type EmailFieldStatus,
  type IdentityKind,
} from "../../lib/identity/email";

export type { EmailFieldStatus } from "../../lib/identity/email";

const inputBase =
  "w-full rounded-md border bg-background-50 px-3 py-2 text-sm text-foreground-900 outline-none transition-colors placeholder:text-foreground-400 focus:ring-2";

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">;

export interface EmailFieldProps extends InputProps {
  value: string;
  onChange: (value: string) => void;
  kind: IdentityKind;
  /** The record being edited: its own email is never flagged. */
  recordId?: string | null;
  /** The email the record is saved with; no check while the value equals it. */
  savedEmail?: string | null;
  /** admin = Admin CMS (sees which account holds the email); portal = agent / student portal; public = signed out (no live check). */
  context: EmailFieldContext;
  /** Status and whether Submit must stay disabled (taken, or still checking). */
  onStatusChange?: (status: EmailFieldStatus, isBlocking: boolean) => void;
  /** The error from the last submit; an email-taken error shows here exactly like the live check. */
  serverError?: unknown;
  /** The form's own input class (agency portal / public pages); the red border is added on top. */
  inputClassName?: string;
  /** Shown under the taken message. */
  takenAction?: ReactNode;
  /** Replaces the live check (the application step uses the scoped student lookup). Must resolve to the same shape. */
  checker?: (email: string) => Promise<EmailAvailability>;
  /** Shown instead of the "Email available" tick (e.g. "A student with this email already exists"). */
  availableNote?: ReactNode;
}

/**
 * The only input for a person's email (staff, agent, student). Signed-in forms get a debounced live check through
 * `email_available`; every form maps the trigger's 23505 / email_taken from the submit through `serverError`.
 * Written without JSX so the offline tests render it.
 */
export default function EmailField({
  value, onChange, kind, recordId, savedEmail, context, onStatusChange, serverError, inputClassName, takenAction, checker, availableNote,
  className = "", onBlur, id, ...rest
}: EmailFieldProps) {
  const autoId = useId();
  const inputId = id ?? `email-${autoId}`;
  const messageId = `${inputId}-message`;
  const normalized = normalizeEmail(value);
  const [live, setLive] = useState<{ value: string; status: EmailFieldStatus }>({ value: "", status: "idle" });
  // A submit error is pinned to the value that was submitted; typing a different email clears it.
  const pin = (err: unknown) => { const t = emailTakenFrom(err); return t ? { value: normalized, message: t.message, details: t.details } : null; };
  const [submitTaken, setSubmitTaken] = useState<{ value: string; message: string; details: string | null } | null>(() => pin(serverError));
  const valueRef = useRef(normalized);
  valueRef.current = normalized;
  const checkerRef = useRef(checker);
  checkerRef.current = checker;

  useEffect(() => {
    const t = emailTakenFrom(serverError);
    if (t) setSubmitTaken({ value: valueRef.current, message: t.message, details: t.details });
  }, [serverError]);

  const check = shouldCheckEmail(value, context, savedEmail);

  useEffect(() => {
    if (!check) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLive({ value: normalized, status: "checking" });
      (checkerRef.current ?? ((e: string) => checkEmailAvailable(e, kind, recordId)))(normalized)
        .then((r) => { if (!cancelled) setLive({ value: normalized, status: r.available ? "available" : "taken" }); })
        .catch(() => { if (!cancelled) setLive({ value: normalized, status: "error" }); });
    }, EMAIL_CHECK_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [check, normalized, kind, recordId]);

  const takenBySubmit = submitTaken !== null && submitTaken.value === normalized;
  // Until the debounced check has answered for this exact value, the field counts as "checking" (Submit disabled).
  const liveStatus: EmailFieldStatus = !check ? "idle" : live.value === normalized ? live.status : "checking";
  const status: EmailFieldStatus = takenBySubmit ? "taken" : liveStatus;
  const blocking = emailStatusBlocks(status);

  const reported = useRef("");
  useEffect(() => {
    const key = `${status}:${blocking}`;
    if (reported.current === key) return;
    reported.current = key;
    onStatusChange?.(status, blocking);
  }, [status, blocking, onStatusChange]);

  const taken = status === "taken";
  const border = taken ? "border-red-500 focus:border-red-500 focus:ring-red-100" : "border-background-300 focus:border-primary-400 focus:ring-primary-100";
  const describedBy = taken || status === "available" ? messageId : rest["aria-describedby"];

  return h("div", { className: "relative", "data-email-status": status },
    h("div", { className: "relative" },
      h("input", {
        ...rest,
        id: inputId,
        type: "email",
        value,
        onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
        onBlur: (e: FocusEvent<HTMLInputElement>) => { if (value !== normalized) onChange(normalized); onBlur?.(e); },
        "aria-invalid": taken || rest["aria-invalid"] ? true : undefined,
        "aria-describedby": describedBy,
        className: inputClassName ? `${inputClassName} ${taken ? "!border-red-500" : ""} pr-8 ${className}` : `${inputBase} ${border} pr-8 ${className}`,
      }),
      status === "checking"
        ? h("i", { className: "ri-loader-4-line absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-foreground-400", role: "status", "aria-label": "Checking email", "data-testid": "email-checking" })
        : status === "available"
          ? h("i", { className: "ri-check-line absolute right-2.5 top-1/2 -translate-y-1/2 text-emerald-600", "aria-hidden": "true" })
          : null),
    taken ? h(EmailInUseMessage, { id: messageId, context, message: takenBySubmit ? submitTaken?.message : null, details: takenBySubmit ? submitTaken?.details : null, action: takenAction }) : null,
    status === "available"
      ? h("div", { id: messageId, className: "mt-1 text-xs text-emerald-700", "data-testid": "email-available" }, availableNote ?? "Email available")
      : null);
}
