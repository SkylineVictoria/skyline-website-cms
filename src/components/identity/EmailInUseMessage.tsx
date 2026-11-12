import { createElement as h, type ReactNode } from "react";
import { EMAIL_TAKEN_MESSAGE, PUBLIC_EMAIL_TAKEN_MESSAGE, takenDetailsFor, type EmailFieldContext } from "../../lib/identity/email";

/**
 * The one "email already in use" message (Google-style, under the field).
 * - admin: also shows which kind of account holds the email (the trigger's detail).
 * - portal: the generic sentence only (or the server's sentence for login_role_conflict).
 * - public (signed out): "An account with this email already exists…" with Sign in and Forgot password links; never the role.
 * Written without JSX so the offline tests render it.
 */
export default function EmailInUseMessage({ id, context, message, details, action }: {
  id?: string;
  context: EmailFieldContext;
  /** The server's own sentence for login_role_conflict; the generic message otherwise. */
  message?: string | null;
  details?: string | null;
  action?: ReactNode;
}) {
  const shown = takenDetailsFor(context, details);
  const text = context === "public" ? PUBLIC_EMAIL_TAKEN_MESSAGE : message || EMAIL_TAKEN_MESSAGE;
  const link = (href: string, label: string) => h("a", { href, className: "font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-800" }, label);
  return h("div", { id, role: "alert", className: "mt-1.5 text-xs", "data-testid": "email-in-use" },
    h("p", { className: "flex items-start gap-1 font-medium text-red-600" },
      h("i", { className: "ri-error-warning-fill mt-px", "aria-hidden": "true" }),
      h("span", null, text)),
    shown ? h("p", { className: "mt-0.5 pl-4 text-foreground-500", "data-testid": "email-in-use-details" }, shown) : null,
    context === "public"
      ? h("p", { className: "mt-1 flex gap-3 pl-4", "data-testid": "email-in-use-links" }, link("/login", "Sign in"), link("/forgot-password", "Forgot password"))
      : null,
    action ? h("div", { className: "mt-1.5 pl-4" }, action) : null);
}
