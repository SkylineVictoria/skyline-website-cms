import { parseStoredPhone, validateStoredPhone } from "../../supabase/functions/_shared/validation/identifiers";

/** A usable mobile for a text message: a country code plus a number valid for that country. */
export const textableMobile = (e164: string) => Boolean(parseStoredPhone(e164)?.national) && !validateStoredPhone(e164);
