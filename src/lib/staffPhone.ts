// E.164 normalisation for the staff registration form. Twin of supabase/functions/_shared/staff-phone.ts and of hr.phone_e164() in
// the database; all are tested against the same vectors (scripts/test-staff-registration.ts, supabase/tests/hr_staff_registration.sql).
// "+<country><number>", a "00" prefix and Australian national numbers are accepted; anything else is ambiguous and returns null.
export function toE164(input: unknown): string | null {
  const raw = String(input ?? "").replace(/\(0\)/g, "").replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  if (/^00[1-9]\d{7,14}$/.test(raw)) return `+${raw.slice(2)}`;
  if (/^04\d{8}$/.test(raw) || /^0[2378]\d{8}$/.test(raw)) return `+61${raw.slice(1)}`;
  return null;
}
