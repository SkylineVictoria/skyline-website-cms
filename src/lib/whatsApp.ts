import { toE164 } from "./staffPhone";
import { parseStoredPhone } from "../../supabase/functions/_shared/validation/identifiers";

/** Digits for https://wa.me/<digits> (country code first, no +), or null when the stored number is not understood. */
export function whatsAppDigits(phone: string | null | undefined): string | null {
  const parsed = parseStoredPhone(String(phone ?? ""));
  if (parsed) return `${parsed.dial}${parsed.national}`.replace(/\D/g, "") || null;
  const e164 = toE164(phone);
  return e164 ? e164.slice(1) : null;
}
