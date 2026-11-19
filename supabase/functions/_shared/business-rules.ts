// Live Business Rules values for Edge Functions (BUSINESS-RULES-LIVE). SLIT sets them on Administration › Business Rules;
// public.business_rule_values returns the published value of every live rule asked for. A rule that is not live yet,
// switched off or unreadable is simply missing, and the caller's fallback (the old fixed value) is used.

// deno-lint-ignore no-explicit-any
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: unknown }> };

export type RuleValues = Record<string, unknown>;

/** Reads several rules at once. Never throws: on any problem the fallbacks apply. */
export async function loadRules(client: RpcClient, ids: string[]): Promise<RuleValues> {
  try {
    const { data, error } = await client.rpc("business_rule_values", { p_ids: ids });
    if (error || !data || typeof data !== "object") return {};
    return data as RuleValues;
  } catch {
    return {};
  }
}

export function ruleNumber(values: RuleValues, id: string, fallback: number): number {
  const v = values[id];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
export function ruleText(values: RuleValues, id: string, fallback: string): string {
  const v = values[id];
  return typeof v === "string" && v.trim() ? v : fallback;
}
export function ruleBool(values: RuleValues, id: string, fallback: boolean): boolean {
  const v = values[id];
  return typeof v === "boolean" ? v : fallback;
}
export function ruleList(values: RuleValues, id: string, fallback: string[]): string[] {
  const v = values[id];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;
}
export function ruleObject<T extends Record<string, unknown>>(values: RuleValues, id: string, fallback: T): T {
  const v = values[id];
  return v && typeof v === "object" && !Array.isArray(v) ? { ...fallback, ...(v as Partial<T>) } : fallback;
}
