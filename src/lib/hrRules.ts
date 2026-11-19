// HR values from Administration › Business Rules (BUSINESS-RULES-LIVE, migration 20261121002517) for the browser-free HR
// libraries (staffStatus.ts, jobs.ts, employeeRules.ts). Those libraries are also loaded by the offline tests, where the
// Supabase client cannot start, so the rule getters arrive through a lazy import: until they have loaded (and in the tests)
// every getter returns its fallback, which is today's fixed value. The database checks the same rules again.

type Getters = typeof import("@/lib/businessRules");
let rules: Getters | null = null;
const listeners: (() => void)[] = [];

/** Runs now and again whenever the Business Rules values load. */
export function onHrRules(fn: () => void) {
  listeners.push(fn);
  try { fn(); } catch { /* keep the fixed values */ }
}

export const hrNumber = (id: string, fallback: number) => (rules ? rules.ruleNumber(id, fallback) : fallback);
export const hrText = (id: string, fallback: string) => (rules ? rules.ruleText(id, fallback) : fallback);
export const hrList = (id: string, fallback: string[]) => (rules ? rules.ruleList(id, fallback) : fallback);
export const hrObject = <T extends Record<string, unknown>>(id: string, fallback: T): T => (rules ? rules.ruleObject(id, fallback) : fallback);

/** "10 MB", "2.5 MB": a byte limit as the messages show it. */
export const megabytes = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

void import("@/lib/businessRules")
  .then((m) => m.onRules(() => {
    rules = m;
    listeners.forEach((fn) => { try { fn(); } catch { /* one bad listener must not stop the others */ } });
  }))
  .catch(() => undefined);
