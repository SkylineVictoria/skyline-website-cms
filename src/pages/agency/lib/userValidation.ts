/** Pure validation for the add / edit / deactivate user dialogs. Mirrors, never replaces, the server rules (portal-admin-users + RLS). */

export type UserRole = "agent" | "agency_admin";
export interface UserFormValues { name: string; email: string; role: string; agencyId: string }
export type UserFormErrors = Partial<Record<keyof UserFormValues, string>>;

// eslint-disable-next-line no-control-regex -- control characters are never valid in names or addresses
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

export const normaliseEmail = (raw: string) => raw.trim().toLowerCase();

export function validateName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Enter the person's full name.";
  if (CONTROL.test(raw)) return "The name contains characters that are not allowed.";
  if (name.length < 2) return "The name must be at least 2 characters.";
  if (name.length > 100) return "The name must be 100 characters or fewer.";
  return null;
}

export function validateEmail(raw: string, existing: readonly string[] = []): string | null {
  const email = normaliseEmail(raw);
  if (!email) return "Enter an email address.";
  if (CONTROL.test(raw) || email.length > 254 || !EMAIL.test(email)) return "Enter a valid email address.";
  if (existing.some((other) => normaliseEmail(other) === email)) return "This email is already in the list.";
  return null;
}

export function validateRole(raw: string, allowed: readonly string[]): string | null {
  if (!raw) return "Choose a role.";
  return allowed.includes(raw) ? null : "Choose one of the available roles.";
}

export interface UserFormContext { mode: "add" | "edit"; existingEmails: readonly string[]; allowedRoles: readonly string[]; needsAgency: boolean; nameEditable: boolean }

export function validateField(field: keyof UserFormValues, values: UserFormValues, ctx: UserFormContext): string | null {
  switch (field) {
    case "name": return ctx.nameEditable ? validateName(values.name) : null;
    case "email": return ctx.mode === "edit" ? null : validateEmail(values.email, ctx.existingEmails);
    case "role": return validateRole(values.role, ctx.allowedRoles);
    case "agencyId": return ctx.needsAgency && !values.agencyId ? "Choose an agency." : null;
  }
}

export function validateUserForm(values: UserFormValues, ctx: UserFormContext): UserFormErrors {
  const errors: UserFormErrors = {};
  for (const field of ["name", "email", "role", "agencyId"] as const) {
    const message = validateField(field, values, ctx);
    if (message) errors[field] = message;
  }
  return errors;
}

/** Why deactivating this user must be refused, or null. `activeAdmins` counts active agency administrators of the target's agency. */
export function deactivationBlock(input: { isSelf: boolean; targetRole: string | null; targetActive: boolean; activeAdmins: number }): string | null {
  if (!input.targetActive) return null;
  if (input.isSelf) return "You cannot deactivate your own account. Ask another administrator.";
  if (input.targetRole === "agency_admin" && input.activeAdmins <= 1) return "This is the last active agency administrator. Add another administrator first.";
  return null;
}

/** Demoting the last active agency administrator is refused for the same reason. */
export function roleChangeBlock(input: { currentRole: string | null; newRole: string; targetActive: boolean; activeAdmins: number }): string | null {
  if (input.targetActive && input.currentRole === "agency_admin" && input.newRole !== "agency_admin" && input.activeAdmins <= 1) return "This is the last active agency administrator. Add another administrator before changing the role.";
  return null;
}

export interface MappedError { field?: keyof UserFormValues; message: string }
const GENERIC = "We could not complete that. Please try again.";

/** Server text -> a fixed, safe message (and the field it belongs to). Raw server text, ids and stack traces are never shown. */
export function mapServerError(raw: unknown): MappedError {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  const rules: [RegExp, MappedError][] = [
    [/already belongs to an active portal user/i, { field: "email", message: "This email already belongs to an active user." }],
    [/already been invited|pending invitation/i, { field: "email", message: "This email has already been invited. Resend or revoke the pending invitation." }],
    [/expired/i, { field: "email", message: "An earlier invitation for this email has expired. Resend it instead." }],
    [/valid email/i, { field: "email", message: "Enter a valid email address." }],
    [/Organization administrators cannot be invited/i, { field: "email", message: "This email belongs to an organization administrator and cannot be invited here." }],
    [/Role must be/i, { field: "role", message: "Choose one of the available roles." }],
    [/agency must be selected|agency is not active/i, { field: "agencyId", message: "Choose an active agency." }],
    [/last active agency administrator/i, { message: "This is the last active agency administrator. Add another administrator first." }],
    [/own agency|only an organization administrator|inviting agency administrator/i, { message: "You do not have permission to do that for this user." }],
    [/not authenticated|authorization|access required|permission/i, { message: "You do not have permission to do that." }],
    [/non-2xx|failed to send|network|fetch/i, { message: "We could not reach the server. Check your connection and try again." }],
  ];
  for (const [pattern, mapped] of rules) if (pattern.test(text)) return mapped;
  return { message: GENERIC };
}
