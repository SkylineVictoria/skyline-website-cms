// The institution time zone on the screens: Business Rule general.time_zone (Administration › Business Rules). Every date or
// time a screen shows or compares ("today", signed times, timesheets, due dates) uses institutionTimeZone(). The value is held
// by the shared module the Edge Functions use (supabase/functions/_shared/time-zone.ts), so the browser-side PDF and signing
// helpers follow it too. This file is also loaded by the offline tests, where the Supabase client cannot start: the rule
// arrives through a lazy import (as in hrRules.ts), and until it has loaded (and in the tests) Melbourne is used.
import { FALLBACK_TIME_ZONE, institutionTimeZone, setInstitutionTimeZone, TIME_ZONE_RULE } from "../../supabase/functions/_shared/time-zone";

export { FALLBACK_TIME_ZONE, institutionTimeZone, TIME_ZONE_RULE };

/** Today's date (yyyy-mm-dd) in the institution time zone. */
export const institutionToday = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: institutionTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

void import("@/lib/businessRules")
  .then((m) => m.onRules(() => setInstitutionTimeZone(m.ruleText(TIME_ZONE_RULE, FALLBACK_TIME_ZONE))))
  .catch(() => undefined);
