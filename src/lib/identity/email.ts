/**
 * An email is unique WITHIN a role (20261112042544 email_unique_per_role, 20261112042642 portal_invite_single_login_role).
 * One person may be a student, a staff member and an agent with one email; there can't be two students, two agents
 * (agent + agency admin = one role), two CMS users or two HR staff profiles with one email, and an agent can't be invited
 * into a second agency. The database triggers are the rule; this module only reads their answer:
 *   - `identity_email_guard`: SQLSTATE 23505, hint `email_taken` (same-role duplicate), generic message.
 *   - `portal_invite_login_role_guard`: 23505, hint `login_role_conflict` (the email already signs in to the portal with
 *     the other role); its message is shown as-is.
 * Edge Functions return the same as HTTP 409 `{ code, message, details }`.
 */

export const EMAIL_TAKEN_MESSAGE = "This email is already in use. Please use a different email address.";
/** Signed-out screens (sign-up, careers): never says which kind of account holds the email (owner decision 2026-11-12). */
export const PUBLIC_EMAIL_TAKEN_MESSAGE = "An account with this email already exists. Sign in or reset your password.";
export const EMAIL_TAKEN_CODE = "email_taken";
export const LOGIN_ROLE_CONFLICT_CODE = "login_role_conflict";

/** 'staff' = CMS user, 'hr_staff' = HR staff profile. */
export type IdentityKind = "staff" | "hr_staff" | "agent" | "student";
export type EmailConflictReason = typeof EMAIL_TAKEN_CODE | typeof LOGIN_ROLE_CONFLICT_CODE;

/** The answer the forms show: the message, and (admins only) the trigger's detail naming the role. */
export interface EmailTaken { reason: EmailConflictReason; message: string; details: string | null }

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parsed(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return null; }
}

/** The email-taken answer inside any error or response body, or null. Looks at the object itself, then `error`, `body`, `data`. */
export function emailTakenFrom(err: unknown): EmailTaken | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): EmailTaken | null => {
    const o = parsed(value);
    if (!o || seen.has(o) || depth > 3) return null;
    seen.add(o);
    const code = typeof o.code === "string" ? o.code : "";
    const hint = typeof o.hint === "string" ? o.hint : "";
    const reason: EmailConflictReason | null =
      (code === "23505" && hint === EMAIL_TAKEN_CODE) || code === EMAIL_TAKEN_CODE || o.error === EMAIL_TAKEN_CODE ? EMAIL_TAKEN_CODE
        : (code === "23505" && hint === LOGIN_ROLE_CONFLICT_CODE) || code === LOGIN_ROLE_CONFLICT_CODE || o.error === LOGIN_ROLE_CONFLICT_CODE ? LOGIN_ROLE_CONFLICT_CODE
          : null;
    if (reason) {
      const serverMessage = typeof o.message === "string" ? o.message.trim() : "";
      // The trigger's detail names the role; a function's own refusal ("This email has already been invited. Resend…") has no
      // detail, so its sentence is kept as the detail. Both are shown to admins only (takenDetailsFor).
      const details = typeof o.details === "string" && o.details.trim() ? o.details.trim()
        : typeof o.detail === "string" && o.detail.trim() ? o.detail.trim()
          : reason === EMAIL_TAKEN_CODE && serverMessage && serverMessage !== EMAIL_TAKEN_MESSAGE && serverMessage !== PUBLIC_EMAIL_TAKEN_MESSAGE ? serverMessage : null;
      // login_role_conflict: the trigger's own sentence ("…already signs in to the portal as an agent…") is shown as-is.
      const message = reason === LOGIN_ROLE_CONFLICT_CODE && serverMessage ? serverMessage : EMAIL_TAKEN_MESSAGE;
      return { reason, message, details };
    }
    for (const key of ["error", "body", "data", "cause"]) {
      const hit = visit(o[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return visit(err, 0);
}

/** True for 23505 with hint email_taken or login_role_conflict, from PostgREST, an RPC or an Edge Function JSON body. */
export function isEmailTakenError(err: unknown): boolean {
  return emailTakenFrom(err) !== null;
}

/**
 * For `supabase.functions.invoke` failures: the 409 body sits unread in `error.context` (a Response). Reads it once and
 * returns the email-taken answer, or null for any other failure.
 */
export async function emailTakenFromFunctionError(err: unknown): Promise<EmailTaken | null> {
  const direct = emailTakenFrom(err);
  if (direct) return direct;
  const context = record(err)?.context;
  if (context && typeof (context as Response).clone === "function") {
    try {
      const response = (context as Response).clone();
      if (response.status !== 409) return null;
      return emailTakenFrom(await response.text());
    } catch { return null; }
  }
  return null;
}

/* ------------------------------------------------------------ EmailField rules (pure, shared by the component and the tests) */

export type EmailFieldContext = "admin" | "portal" | "public";
export type EmailFieldStatus = "idle" | "checking" | "available" | "taken" | "error";

export const EMAIL_CHECK_DEBOUNCE_MS = 400;

/** Loose shape check only; the forms keep their own validation. Avoids asking the database about "jo@". */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

/** A live check runs only for signed-in contexts, for a plausible email, and never for the record's own saved email. */
export function shouldCheckEmail(value: string, context: EmailFieldContext, savedEmail?: string | null): boolean {
  if (context === "public") return false;
  const v = normalizeEmail(value);
  if (!looksLikeEmail(v)) return false;
  return !(savedEmail && normalizeEmail(savedEmail) === v);
}

/** Submit stays disabled while the email is taken or still being checked. A failed check does not block: the trigger decides on save. */
export function emailStatusBlocks(status: EmailFieldStatus): boolean {
  return status === "taken" || status === "checking";
}

/** Only the Admin CMS may see which kind of account holds the email. */
export function takenDetailsFor(context: EmailFieldContext, details: string | null | undefined): string | null {
  return context === "admin" && details ? details : null;
}

export type EmailAvailability ={ available: true; message: null } | { available: false; message: string };

/** Live check for signed-in forms. `ref` is the record being edited, so a person's own email is not flagged. */
export async function checkEmailAvailable(email: string, kind: IdentityKind, ref?: string | null): Promise<EmailAvailability> {
  // Loaded on first use so the pure rules above stay importable in the offline tests (no Vite env there).
  const { supabase } = await import("@/pages/admin/lib/supabase");
  const { data, error } = await supabase.rpc("email_available", { p_email: normalizeEmail(email), p_kind: kind, p_ref: ref ?? null });
  if (error) throw error;
  const row = record(data);
  if (row?.available === true) return { available: true, message: null };
  return { available: false, message: typeof row?.message === "string" && row.message ? row.message : EMAIL_TAKEN_MESSAGE };
}
