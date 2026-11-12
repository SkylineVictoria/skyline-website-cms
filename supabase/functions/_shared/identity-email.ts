// An email is unique within a role (migrations 20261112042544 / 20261112042642). The database triggers raise SQLSTATE 23505
// with hint `email_taken` (same-role duplicate) or `login_role_conflict` (a portal invite to a login with the other role).
// Edge Functions never swallow these: they answer HTTP 409 with this body, which the frontend maps to the email field
// (src/lib/identity/email.ts). No other duplicate (mobile, ABN, ...) is reported this way.

export const EMAIL_TAKEN_MESSAGE = "This email is already in use. Please use a different email address.";

export type EmailConflictBody = { code: "email_taken" | "login_role_conflict"; message: string; details: string | null; error: string };

type DbError = { code?: string | null; hint?: string | null; message?: string | null; details?: string | null } | null | undefined;

/** Signed-out screens (sign-up, careers): never says which kind of account holds the email. */
export const PUBLIC_EMAIL_TAKEN_MESSAGE = "An account with this email already exists. Sign in or reset your password.";

/** The 409 body for a signed-out screen: code email_taken, the public sentence, no details. */
export function publicEmailTakenBody(): EmailConflictBody {
  return { code: "email_taken", message: PUBLIC_EMAIL_TAKEN_MESSAGE, details: null, error: PUBLIC_EMAIL_TAKEN_MESSAGE };
}

/** The 409 body for a trigger's email refusal, or null for any other error. `error` repeats the message for older callers. */
export function emailConflictBody(error: DbError): EmailConflictBody | null {
  if (!error || error.code !== "23505") return null;
  if (error.hint === "email_taken") {
    // The trigger's detail names the role; a function's own refusal ("This email has already been invited. Resend…") has no
    // detail, so its sentence is kept there. The frontend shows details to Admin CMS users only.
    const own = error.message && error.message !== EMAIL_TAKEN_MESSAGE ? error.message : null;
    return { code: "email_taken", message: EMAIL_TAKEN_MESSAGE, details: error.details || own, error: EMAIL_TAKEN_MESSAGE };
  }
  if (error.hint === "login_role_conflict") {
    const message = error.message || EMAIL_TAKEN_MESSAGE;
    return { code: "login_role_conflict", message, details: null, error: message };
  }
  return null;
}
