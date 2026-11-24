// The institution time zone: Business Rule general.time_zone (Administration › Business Rules). Every date or time an Edge
// Function prints or compares ("today", signing dates, PDF stamps, email dates) uses it. Entry points call
// loadInstitutionTimeZone (or setInstitutionTimeZone after their own loadRules) at the start of a request; until then, and
// when the rule is missing or not a real zone, Melbourne is used.
import { loadRules, ruleText, type RuleValues } from "./business-rules.ts";

export const TIME_ZONE_RULE = "general.time_zone";
export const FALLBACK_TIME_ZONE = "Australia/Melbourne";

let current = FALLBACK_TIME_ZONE;

const valid = (zone: string) => {
  try { new Intl.DateTimeFormat("en-AU", { timeZone: zone }); return true; } catch { return false; }
};

/** The institution time zone (IANA name). */
export function institutionTimeZone(): string { return current; }

/** Sets the zone from a rule value; anything that is not a real zone leaves Melbourne. */
export function setInstitutionTimeZone(zone: unknown): void {
  const z = typeof zone === "string" ? zone.trim() : "";
  current = z && valid(z) ? z : FALLBACK_TIME_ZONE;
}

/** Sets the zone from rules already loaded with loadRules (include TIME_ZONE_RULE in the ids). */
export function setInstitutionTimeZoneFrom(rules: RuleValues): void {
  setInstitutionTimeZone(ruleText(rules, TIME_ZONE_RULE, FALLBACK_TIME_ZONE));
}

// deno-lint-ignore no-explicit-any
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: unknown }> };

/** Reads the rule and sets the zone. Never throws. */
export async function loadInstitutionTimeZone(client: RpcClient): Promise<string> {
  setInstitutionTimeZoneFrom(await loadRules(client, [TIME_ZONE_RULE]));
  return current;
}
