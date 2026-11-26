/**
 * Add assessment (ASM-PDF-TEMPLATE phase 4, 2026-11-26; UPLOAD-FIRST, owner 2026-11-26): an assessment is its workbook PDF. Every
 * "New assessment" / "Add assessment" button opens this dialog. Its first step is the workbook PDF: the qualification and unit codes
 * printed on its first pages (the same reading as the unit-mismatch check) prefill Qualification and Unit when they are a qualification
 * and one of its units in Skyline; the admin confirms or changes them (a code not found or not in Skyline leaves the box empty with a
 * short note). Create opens the assessment on its PDF template tab with the workbook already attached (its fields found there, the
 * unit check there: a workbook naming another unit than the one selected asks for Switch or Keep). Opened from a unit (pre-selected,
 * locked), the workbook is still read first. "Choose the unit first" keeps the old order (the PDF is uploaded on the tab).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { asmAdmin } from "@/pages/admin/lib/assessments";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";
import { codesInWorkbook } from "@/lib/assessment/pdfTemplate/api";
import { setPendingWorkbook } from "@/lib/assessment/pdfTemplate/pending";

type Found = { qualification: string | null; unit: string | null };

export default function NewAssessmentDialog({ courseId = "", unitId = "", courses: givenCourses, units: givenUnits, onClose, onSaved }: {
  courseId?: string;
  unitId?: string;
  /** Already loaded by the page (LMS > Assessments); else loaded here. */
  courses?: RtoCourse[];
  units?: RtoUnit[];
  onClose: () => void;
  /** `workbook`: a workbook PDF was chosen here and waits on the new assessment's PDF template tab. */
  onSaved: (assessmentId: string, opts: { workbook: boolean }) => void;
}) {
  const [loaded, setLoaded] = useState<RtoCourse[] | null>(null);
  const courses = givenCourses?.length ? givenCourses : loaded;
  const [course, setCourse] = useState(courseId);
  // the units and the course they belong to (prefilling waits for the units of the course it chose)
  const [units, setUnits] = useState<{ course: string; list: RtoUnit[] } | null>(givenUnits && courseId ? { course: courseId, list: givenUnits } : null);
  const [unit, setUnit] = useState(unitId);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState<"upload" | "details">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const prefilled = useRef<{ course: boolean; unit: boolean; target?: string }>({ course: false, unit: false });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (givenCourses?.length || loaded) return;
    let live = true;
    rto<RtoCourse[]>("course_list").then((c) => { if (live) setLoaded(c); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The courses could not be loaded."); });
    return () => { live = false; };
  }, [givenCourses, loaded]);
  useEffect(() => {
    if (!course) { setUnits({ course: "", list: [] }); return; }
    if (givenUnits && course === courseId) { setUnits({ course, list: givenUnits }); return; }
    let live = true; setUnits(null);
    rto<CourseDetail>("course_get", { courseId: course }).then((d) => { if (live) setUnits({ course, list: d.units ?? [] }); }).catch(() => { if (live) setUnits({ course, list: [] }); });
    return () => { live = false; };
  }, [course, courseId, givenUnits]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy && !reading) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [busy, reading, onClose]);

  const unitList = useMemo(() => (units && units.course === course ? units.list : null), [units, course]);
  const matchingCourses = useMemo(() => (found?.qualification && courses ? courses.filter((c) => c.code.trim().toUpperCase() === found.qualification) : []), [found, courses]);
  const matchingUnit = useMemo(() => (found?.unit && unitList ? unitList.find((u) => u.isActive && u.id && u.code.trim().toUpperCase() === found.unit) ?? null : null), [found, unitList]);

  // prefill once per workbook: the qualification when exactly one in Skyline has the code, then the unit among its active units
  useEffect(() => {
    if (!found || !courses || prefilled.current.course) return;
    prefilled.current.course = true;
    const target = !courseId && matchingCourses.length === 1 ? matchingCourses[0].id : course;
    prefilled.current.target = target;
    if (target !== course) { setCourse(target); setUnit(""); }
  }, [found, courses, courseId, matchingCourses, course]);
  // the unit once the units of the course chosen above have loaded (never from the list of the course shown before)
  useEffect(() => {
    if (!found || !prefilled.current.course || prefilled.current.unit || !unitList || course !== prefilled.current.target) return;
    prefilled.current.unit = true;
    if (!unitId && matchingUnit?.id) setUnit(matchingUnit.id);
  }, [found, unitList, unitId, matchingUnit, course]);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { setError("Choose the workbook as a PDF file."); return; }
    setReading(true); setFile(f);
    let codes: Found = { qualification: null, unit: null };
    try { codes = await codesInWorkbook(new Uint8Array(await f.arrayBuffer())); } catch { /* unreadable here: the PDF template tab says why */ }
    prefilled.current = { course: false, unit: false };
    setFound(codes); setReading(false); setStep("details");
  };

  const unitRow = useMemo(() => (unitList ?? []).find((u) => (u.id ?? "") === unit) ?? null, [unitList, unit]);
  const courseRow = (courses ?? []).find((c) => c.id === course) ?? null;
  const notes: string[] = [];
  if (found) {
    if (!found.qualification) notes.push(courseId ? "" : "No qualification code was found in the workbook: choose the qualification.");
    else if (!courseId && matchingCourses.length === 0 && courses) notes.push(`${found.qualification} (read from the workbook) is not a qualification in Skyline: choose the qualification.`);
    else if (!courseId && matchingCourses.length > 1) notes.push(`More than one qualification in Skyline has the code ${found.qualification}: choose the right one.`);
    if (!found.unit) notes.push(unitId ? "No unit code was found in the workbook." : "No unit code was found in the workbook: choose the unit.");
    else if (unitId && unitRow && unitRow.code.trim().toUpperCase() !== found.unit) notes.push(`This workbook names ${found.unit}, not the selected ${unitRow.code}. After creating, choose Switch or Keep on the PDF template tab.`);
    else if (!unitId && unitList && course && !matchingUnit) notes.push(`${found.unit} (read from the workbook) is not a unit of ${courseRow?.code ?? "this qualification"} in Skyline: choose the unit.`);
    else if (!unitId && unit && unitRow && unitRow.code.trim().toUpperCase() !== found.unit) notes.push(`The workbook names ${found.unit}. You chose ${unitRow.code}: you will be asked to Switch or Keep on the PDF template tab.`);
  }
  const shownNotes = notes.filter(Boolean);
  const prefilledOk = Boolean(found?.unit && unitRow && unitRow.code.trim().toUpperCase() === found.unit && (!found.qualification || courseRow?.code.trim().toUpperCase() === found.qualification || Boolean(courseId)));

  const create = async () => {
    if (!course || !unit) return;
    setBusy(true); setError("");
    try {
      const out = await asmAdmin<{ id: string }>("assessment_create", { courseId: course, unitId: unit, title: title.trim() || (unitRow ? `${unitRow.code} ${unitRow.name}` : "Untitled assessment") });
      if (file) setPendingWorkbook(out.id, file);
      onSaved(out.id, { workbook: Boolean(file) });
    } catch (e) { setError(e instanceof Error ? e.message : "The assessment was not created."); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground-950/40" onClick={busy || reading ? undefined : onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg rounded-card border border-background-200 bg-background-50 shadow-xl" role="dialog" aria-modal="true" aria-label="Add assessment">
        <div className="border-b border-background-200 px-5 py-3.5"><h2 className="font-heading text-base font-semibold text-foreground-950">Add assessment</h2>
          <p className="mt-0.5 text-xs text-foreground-600">{step === "upload" ? "Start with the unit's workbook PDF: its qualification and unit are read from its first pages." : "Check the qualification and unit; next you check the fields found on the workbook and publish."}</p></div>
        <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" data-testid="new-assessment-file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        {step === "upload" ? (
          <div className="space-y-3 px-5 py-4" data-testid="new-assessment-upload">
            {error ? <p role="alert" className="text-sm text-primary-700">{error}</p> : null}
            <button type="button" disabled={reading} onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files?.[0]); }}
              className="flex w-full cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed border-background-300 bg-white px-4 py-8 text-center hover:border-primary-400 disabled:cursor-wait">
              <i className={`${reading ? "ri-loader-4-line animate-spin" : "ri-file-pdf-2-line"} text-2xl text-primary-700`} aria-hidden="true" />
              <span className="text-sm font-semibold text-foreground-900">{reading ? "Reading the workbook…" : "Upload workbook PDF"}</span>
              <span className="text-xs text-foreground-600">{reading ? "Looking for the qualification and unit codes on its first pages" : "Click or drop the PDF here (up to 50 MB)"}</span>
            </button>
          </div>
        ) : (
          <div className="space-y-3 px-5 py-4">
            {error ? <p role="alert" className="text-sm text-primary-700">{error}</p> : null}
            {file ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-background-200 bg-white px-3 py-2 text-sm" data-testid="new-assessment-workbook">
                <span className="flex min-w-0 items-center gap-2"><i className="ri-file-pdf-2-line text-primary-700" aria-hidden="true" /><span className="truncate">{file.name}</span></span>
                <button type="button" className="shrink-0 text-xs font-semibold text-primary-700 hover:underline" disabled={busy || reading} onClick={() => fileInput.current?.click()}>Change</button>
              </div>
            ) : null}
            {found && prefilledOk && !shownNotes.length ? <p className="text-xs text-green-800" role="status" data-testid="new-assessment-found">Read from the workbook: {[found.qualification, found.unit].filter(Boolean).join(" · ")}. Check them before creating.</p> : null}
            {shownNotes.length ? <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="new-assessment-note">{shownNotes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
            <Field label="Qualification" required>
              <Select aria-label="Qualification" searchPlaceholder="Search qualifications…" noMatchText="No qualifications match" value={course} disabled={!courses || Boolean(courseId)} onChange={(e) => { setCourse(e.target.value); setUnit(""); }}>
                <option value="">{courses ? "Choose a qualification" : "Loading…"}</option>
                {(courses ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
              </Select>
            </Field>
            <Field label="Unit" required>
              <Select aria-label="Unit" searchPlaceholder="Search units…" noMatchText="No units match" value={unit} disabled={!course || !unitList || Boolean(unitId)} onChange={(e) => setUnit(e.target.value)}>
                <option value="">{course && !unitList ? "Loading…" : "Choose a unit"}</option>
                {(unitList ?? []).filter((u) => u.isActive && u.id).map((u) => <option key={u.id} value={u.id}>{u.code} {u.name}</option>)}
              </Select>
            </Field>
            <Field label="Title" hint="Optional: the unit's code and name when left empty.">
              <TextInput aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={unitRow ? `${unitRow.code} ${unitRow.name}` : ""} />
            </Field>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-background-200 px-5 py-3">
          {step === "upload"
            ? <button type="button" className="mr-auto text-xs font-semibold text-primary-700 hover:underline" disabled={reading} onClick={() => setStep("details")} data-testid="new-assessment-skip">Choose the unit first</button>
            : !file ? <button type="button" className="mr-auto text-xs font-semibold text-primary-700 hover:underline" disabled={busy} onClick={() => setStep("upload")}>Upload the workbook first</button> : null}
          <Button variant="outline" onClick={onClose} disabled={busy || reading}>Cancel</Button>
          {step === "details" ? <Button onClick={() => void create()} disabled={busy || !course || !unit} data-testid="create-assessment">{busy ? "Creating…" : file ? "Create and open the workbook" : "Create and upload the workbook"}</Button> : null}
        </div>
      </div>
    </div>
  );
}
