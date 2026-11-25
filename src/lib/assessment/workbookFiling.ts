/**
 * ASM-WIZARD: where an imported workbook is filed (course > unit). Pure, so the rule is tested without the screens.
 *
 * Rule (owner, 2026-11-23): the workbook's own qualification / unit wins over the unit selected on the page. A different unit is a
 * clear warning, never a silent filing under the page's selection; a course or unit the workbook names that is not in Skyline is
 * said so and left for the admin to pick.
 */

export interface FilingCourse { id: string; code: string }
export interface FilingUnit { id: string; code: string }

export interface FilingInput {
  /** What the workbook says (null when it names none). */
  workbook: { qualificationCode: string | null; unitCode: string | null };
  /** The course and unit selected on the LMS page when the wizard was opened. */
  page: { courseId: string; unitId: string; unitCode: string | null };
  courses: FilingCourse[];
  /** Units of the course chosen for the workbook (its qualification's course, else the page's course). */
  unitsOfCourse: FilingUnit[];
}

export type FilingSource = "workbook" | "page" | "pick";

export interface FilingDecision {
  courseId: string;
  unitId: string;
  /** Where the pre-selection came from: the workbook's own codes, the page (the workbook names no unit), or nobody (admin picks). */
  source: FilingSource;
  /** The page's unit is not the workbook's unit (e.g. CPCCCM2008 selected, RIICWD525E in the file). */
  mismatch: boolean;
  courseMissing: boolean;
  unitMissing: boolean;
  /** One plain sentence for the screen. */
  message: string;
}

const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.trim().toUpperCase() === b.trim().toUpperCase());

/** The course whose units should be loaded first for the workbook: its qualification's course when Skyline has it. */
export function filingCourseId(input: Pick<FilingInput, "workbook" | "page" | "courses">): string {
  const byCode = input.workbook.qualificationCode ? input.courses.find((c) => same(c.code, input.workbook.qualificationCode)) : undefined;
  return byCode?.id ?? input.page.courseId;
}

export function decideFiling(input: FilingInput): FilingDecision {
  const { workbook, page, courses, unitsOfCourse } = input;
  const course = workbook.qualificationCode ? courses.find((c) => same(c.code, workbook.qualificationCode)) : undefined;
  const courseMissing = Boolean(workbook.qualificationCode) && !course;
  const unit = workbook.unitCode ? unitsOfCourse.find((u) => same(u.code, workbook.unitCode)) : undefined;
  const mismatch = Boolean(workbook.unitCode && page.unitCode && !same(workbook.unitCode, page.unitCode));

  if (!workbook.unitCode) {
    return { courseId: course?.id ?? page.courseId, unitId: page.unitId, source: "page", mismatch: false, courseMissing, unitMissing: false,
      message: "The workbook does not name its unit: it is set to the unit selected on the page. Check it before you continue." };
  }
  if (unit) {
    return { courseId: course?.id ?? page.courseId, unitId: unit.id, source: "workbook", mismatch, courseMissing, unitMissing: false,
      message: mismatch ? `The workbook is for ${workbook.unitCode}, not ${page.unitCode} selected on the page: it will be filed under ${workbook.unitCode}.` : `Filed under ${workbook.unitCode}, as the workbook says.` };
  }
  // the workbook names a unit Skyline does not have in that course: nothing is pre-selected
  return { courseId: course?.id ?? "", unitId: "", source: "pick", mismatch, courseMissing, unitMissing: true,
    message: `${courseMissing ? `The qualification ${workbook.qualificationCode} is not in Skyline, and ` : ""}${workbook.unitCode} is not a unit of ${course ? "that course" : "a course found for it"} in Skyline: choose where to file it.` };
}

/**
 * ASM-WIZARD-SKIP (owner, 2026-11-23): is the "Qualification & unit" step shown? The LMS page already has a course and unit
 * selected, so the step is skipped unless the admin asked to change it, the page has no unit, or an uploaded workbook would be
 * filed anywhere else than the page's selection (another unit, another course, or a course / unit Skyline does not have).
 * A workbook that has not been read yet (decision null) does not show it.
 */
export function needsUnitStep(input: { page: { courseId: string; unitId: string }; decision: FilingDecision | null; changeRequested: boolean }): boolean {
  const { page, decision, changeRequested } = input;
  if (changeRequested || !page.courseId || !page.unitId) return true;
  if (!decision) return false;
  return decision.mismatch || decision.courseMissing || decision.unitMissing || decision.courseId !== page.courseId || decision.unitId !== page.unitId;
}

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

/** The title when the admin types none: the workbook cover's title, else "<unit code> — <unit name>". */
export function autoTitle(workbookTitle: string | null | undefined, unit: { code: string; name: string } | null | undefined): string {
  const fromBook = (workbookTitle ?? "").trim();
  if (fromBook) return fromBook;
  return unit ? `${unit.code} — ${unit.name}`.trim() : "";
}
