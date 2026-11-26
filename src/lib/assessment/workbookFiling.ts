/**
 * ASM-UNIT-CHECK: the unit a workbook PDF names against the assessment's unit (pure, so the rule is tested without the screens).
 * Used by the PDF template tab when a workbook is uploaded; the decision is audited by asm_import_unit_check.
 */

/* ------------------------------------------------------------------ ASM-UNIT-CHECK: the workbook's unit against the selected unit */

export interface UnitRef { code: string | null; name: string | null }
export interface UnitCheck {
  /** match: same code (or, without a code in the PDF, the same title); mismatch: blocking until switched or kept with a reason. */
  status: "match" | "mismatch" | "unknown";
  /** The unit the PDF names, as found on its cover / headers. */
  found: UnitRef;
  selected: UnitRef;
  message: string | null;
}

const words = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2);
/** Share of the shorter title's words found in the other (0..1). */
export function titleOverlap(a: string | null | undefined, b: string | null | undefined): number {
  const x = new Set(words(a)); const y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].filter((w) => big.has(w)).length / small.size;
}

/**
 * The unit code and title found in the PDF compared with the selected unit. Same code = match (whatever the title says); no code in
 * the PDF = compared by title (less than half the words in common = mismatch); nothing found or nothing selected = unknown (no block).
 */
export function checkUnit(found: UnitRef, selected: UnitRef): UnitCheck {
  const fc = (found.code ?? "").trim().toUpperCase(); const sc = (selected.code ?? "").trim().toUpperCase();
  const label = (u: UnitRef) => (u.code ? u.code.trim().toUpperCase() : (u.name ?? "").trim());
  if (!sc || (!fc && !(found.name ?? "").trim())) return { status: "unknown", found, selected, message: null };
  const mismatch = fc ? fc !== sc : titleOverlap(found.name, selected.name) < 0.5;
  return { status: mismatch ? "mismatch" : "match", found, selected, message: mismatch ? `This workbook looks like ${label(found)} but you selected ${label(selected)}` : null };
}

/** The admin's way out of a mismatch: switch to the workbook's unit, or keep the selected one with a reason (at least 5 characters). */
export interface UnitDecision { kind: "switched" | "kept"; reason: string; foundCode: string | null; foundTitle: string | null; selectedCode: string | null; selectedTitle: string | null }
export const UNIT_REASON_MIN = 5;
export function unitDecisionError(d: Pick<UnitDecision, "kind" | "reason">): string | null {
  if (d.kind === "kept" && d.reason.trim().length < UNIT_REASON_MIN) return "Say why this workbook belongs to the selected unit.";
  return null;
}
