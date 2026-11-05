// Runtime-neutral E.164 normalisation for staff registration. Twin of hr.phone_e164() in the database and of
// src/lib/staffPhone.ts; all three are tested against the same vectors (scripts/test-staff-registration.ts, hr_staff_registration.sql).
// Accepts "+<country><number>" (8 to 15 digits), a "00" international prefix, and Australian national numbers (04xx, 02/03/07/08).
// Anything else (no "+" and not Australian) is ambiguous and returns null.
export function toE164(input: unknown): string | null {
  const raw = String(input ?? "").replace(/\(0\)/g, "").replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  if (/^00[1-9]\d{7,14}$/.test(raw)) return `+${raw.slice(2)}`;
  if (/^04\d{8}$/.test(raw) || /^0[2378]\d{8}$/.test(raw)) return `+61${raw.slice(1)}`;
  return null;
}
