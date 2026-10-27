// Runtime-neutral validation of user-supplied account fields shared by the account-provisioning Edge Functions.
// eslint-disable-next-line no-control-regex -- control characters are never valid in names or addresses
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

export function cleanEmail(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const raw = String(value ?? "");
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: false, error: "Email is required." };
  if (CONTROL.test(email) || email.length > 254 || !EMAIL.test(email)) return { ok: false, error: "Enter a valid email address (254 characters at most)." };
  return { ok: true, value: email };
}

export function cleanName(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const raw = String(value ?? "");
  const name = raw.trim();
  if (!name) return { ok: false, error: "Full name is required." };
  if (CONTROL.test(raw.trim())) return { ok: false, error: "The name contains characters that are not allowed." };
  if (name.length < 2 || name.length > 100) return { ok: false, error: "The name must be 2 to 100 characters." };
  return { ok: true, value: name };
}
