import type { Condition, Responses } from "./types";

/** Mirrors `public.asm_condition_met` (migration 20261113440000): the same answer on both sides of the wire. */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function conditionMet(cond: Condition | undefined | null, responses: Responses): boolean {
  if (!cond || typeof cond !== "object") return true;
  if ("all" in cond) return (cond.all ?? []).every((c) => conditionMet(c, responses));
  if ("any" in cond) { const list = cond.any ?? []; return list.length === 0 || list.some((c) => conditionMet(c, responses)); }
  const v = responses[cond.questionId];
  const want = cond.value;
  switch (cond.op ?? "eq") {
    case "empty": return isEmptyValue(v);
    case "notEmpty": return !isEmptyValue(v);
    case "eq": return v !== undefined && v !== null && same(v, want);
    case "neq": return v === undefined || v === null || !same(v, want);
    case "in": return v !== undefined && Array.isArray(want) && want.some((w) => same(w, v));
    case "notIn": return v === undefined || v === null || !Array.isArray(want) || !want.some((w) => same(w, v));
    case "contains":
      if (Array.isArray(v)) return v.some((x) => same(x, want));
      return typeof v === "string" && typeof want === "string" && v.includes(want);
    case "gt": return typeof v === "number" && typeof want === "number" && v > want;
    case "gte": return typeof v === "number" && typeof want === "number" && v >= want;
    case "lt": return typeof v === "number" && typeof want === "number" && v < want;
    case "lte": return typeof v === "number" && typeof want === "number" && v <= want;
    default: return true;
  }
}
