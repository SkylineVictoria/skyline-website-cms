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

/** The title when the admin types none: the workbook cover's title, else "<unit code> — <unit name>". */
export function autoTitle(workbookTitle: string | null | undefined, unit: { code: string; name: string } | null | undefined): string {
  const fromBook = (workbookTitle ?? "").trim();
  if (fromBook) return fromBook;
  return unit ? `${unit.code} — ${unit.name}`.trim() : "";
}
