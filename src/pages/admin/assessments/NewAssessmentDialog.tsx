/**
 * ASM-ONE-FLOW (owner, 2026-11-23): the only way to add an assessment. Every "New assessment" / "Add assessment" button opens this
 * dialog, which loads the courses (and the units of the pre-selected course) and shows the ImportWizard (Upload -> Check -> Publish):
 *   - LMS > Assessments and LMS > Units > a unit > Assessments: course and unit pre-selected, so Qualification & unit is skipped
 *     (unless an uploaded workbook names another unit);
 *   - Master Data > Assessments: nothing pre-selected, so the wizard shows Qualification & unit.
 */
import { useEffect, useState } from "react";
import { WizardLock } from "@/components/shared/wizard/WizardShell";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";
import ImportWizard from "./ImportWizard";

export default function NewAssessmentDialog({ courseId = "", unitId = "", courses: givenCourses, units: givenUnits, onClose, onSaved }: {
  courseId?: string;
  unitId?: string;
  /** Already loaded by the page (LMS > Assessments); else loaded here. */
  courses?: RtoCourse[];
  units?: RtoUnit[];
  onClose: () => void;
  onSaved: (assessmentId: string) => void;
}) {
  const [courses, setCourses] = useState<RtoCourse[] | null>(givenCourses ?? null);
  const [units, setUnits] = useState<RtoUnit[] | null>(givenUnits ?? (courseId ? null : []));
  const [error, setError] = useState("");

  useEffect(() => {
    if (courses) return;
    let live = true;
    rto<RtoCourse[]>("course_list").then((c) => { if (live) setCourses(c); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The courses could not be loaded."); });
    return () => { live = false; };
  }, [courses]);
  useEffect(() => {
    if (units || !courseId) return;
    let live = true;
    rto<CourseDetail>("course_get", { courseId }).then((d) => { if (live) setUnits(d.units ?? []); }).catch(() => { if (live) setUnits([]); });
    return () => { live = false; };
  }, [units, courseId]);

  if (error) return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground-950/55 p-4" role="alertdialog" aria-label="Add assessment">
      <div className="max-w-sm rounded-xl bg-background-50 p-5 text-sm text-foreground-800">
        <p role="alert">{error}</p>
        <button type="button" className="mt-3 cursor-pointer rounded-md border border-background-300 px-3 py-1.5 font-semibold" onClick={onClose}>Close</button>
      </div>
    </div>
  );
  if (!courses || !units) return <div className="fixed inset-0 z-[80] bg-foreground-950/30"><WizardLock>Loading courses…</WizardLock></div>;
  return <ImportWizard courses={courses} pageCourseId={courseId} pageUnitId={unitId} pageUnits={units} onClose={onClose} onSaved={onSaved} />;
}
