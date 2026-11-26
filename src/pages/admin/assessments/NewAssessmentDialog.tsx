/**
 * Add assessment (ASM-PDF-TEMPLATE phase 4, 2026-11-26): an assessment is its workbook PDF. Every "New assessment" / "Add assessment"
 * button opens this dialog: qualification and unit (pre-selected on LMS > Assessments and on a unit's Assessments tab) and a title,
 * then the assessment opens on its PDF template tab, where the workbook is uploaded, its fields found and checked, and published.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { asmAdmin } from "@/pages/admin/lib/assessments";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";

export default function NewAssessmentDialog({ courseId = "", unitId = "", courses: givenCourses, units: givenUnits, onClose, onSaved }: {
  courseId?: string;
  unitId?: string;
  /** Already loaded by the page (LMS > Assessments); else loaded here. */
  courses?: RtoCourse[];
  units?: RtoUnit[];
  onClose: () => void;
  onSaved: (assessmentId: string) => void;
}) {
  const [loaded, setLoaded] = useState<RtoCourse[] | null>(null);
  const courses = givenCourses?.length ? givenCourses : loaded;
  const [course, setCourse] = useState(courseId);
  const [units, setUnits] = useState<RtoUnit[] | null>(givenUnits && courseId ? givenUnits : null);
  const [unit, setUnit] = useState(unitId);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (givenCourses?.length || loaded) return;
    let live = true;
    rto<RtoCourse[]>("course_list").then((c) => { if (live) setLoaded(c); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The courses could not be loaded."); });
    return () => { live = false; };
  }, [givenCourses, loaded]);
  useEffect(() => {
    if (!course) { setUnits([]); return; }
    if (givenUnits && course === courseId) { setUnits(givenUnits); return; }
    let live = true; setUnits(null);
    rto<CourseDetail>("course_get", { courseId: course }).then((d) => { if (live) setUnits(d.units ?? []); }).catch(() => { if (live) setUnits([]); });
    return () => { live = false; };
  }, [course, courseId, givenUnits]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [busy, onClose]);

  const unitRow = useMemo(() => (units ?? []).find((u) => (u.id ?? "") === unit) ?? null, [units, unit]);
  const create = async () => {
    if (!course || !unit) return;
    setBusy(true); setError("");
    try {
      const out = await asmAdmin<{ id: string }>("assessment_create", { courseId: course, unitId: unit, title: title.trim() || (unitRow ? `${unitRow.code} ${unitRow.name}` : "Untitled assessment") });
      onSaved(out.id);
    } catch (e) { setError(e instanceof Error ? e.message : "The assessment was not created."); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground-950/40" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg rounded-card border border-background-200 bg-background-50 shadow-xl" role="dialog" aria-modal="true" aria-label="Add assessment">
        <div className="border-b border-background-200 px-5 py-3.5"><h2 className="font-heading text-base font-semibold text-foreground-950">Add assessment</h2>
          <p className="mt-0.5 text-xs text-foreground-600">Choose the unit; next you upload its workbook PDF, check the fields found on it and publish.</p></div>
        <div className="space-y-3 px-5 py-4">
          {error ? <p role="alert" className="text-sm text-primary-700">{error}</p> : null}
          <Field label="Qualification" required>
            <Select aria-label="Qualification" searchPlaceholder="Search qualifications…" noMatchText="No qualifications match" value={course} disabled={!courses || Boolean(courseId)} onChange={(e) => { setCourse(e.target.value); setUnit(""); }}>
              <option value="">{courses ? "Choose a qualification" : "Loading…"}</option>
              {(courses ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
            </Select>
          </Field>
          <Field label="Unit" required>
            <Select aria-label="Unit" searchPlaceholder="Search units…" noMatchText="No units match" value={unit} disabled={!course || !units || Boolean(unitId)} onChange={(e) => setUnit(e.target.value)}>
              <option value="">{course && !units ? "Loading…" : "Choose a unit"}</option>
              {(units ?? []).filter((u) => u.isActive && u.id).map((u) => <option key={u.id} value={u.id}>{u.code} {u.name}</option>)}
            </Select>
          </Field>
          <Field label="Title" hint="Optional: the unit's code and name when left empty.">
            <TextInput aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={unitRow ? `${unitRow.code} ${unitRow.name}` : ""} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-background-200 px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void create()} disabled={busy || !course || !unit} data-testid="create-assessment">{busy ? "Creating…" : "Create and upload the workbook"}</Button>
        </div>
      </div>
    </div>
  );
}
