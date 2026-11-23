/**
 * ASM-WIZARD: LMS › Assessments › Add assessment as a step wizard in the application wizard's frame (WizardShell, step bars, the
 * same step transitions, focus trap, Back / Next).
 *
 * ASM-REVIEW (owner, 2026-11-23): four steps, three for a manual one:
 *   Start (upload a workbook, or create manually) · Upload (the drop zone, then what the workbook is for and, when it is not the
 *   unit selected on the page, the mismatch warning) · [Qualification & unit, only when the workbook is not the page's unit or the
 *   admin pressed Change] · Review (one step with three views: Edit = the draft laid out like the workbook and edited in place,
 *   Student view = the student renderer, Workbook (PDF) view = the blank workbook from "Export as workbook PDF") · Save.
 * Nothing is written to the database before Save. Model answers / guidance stay in the keys (asm_question_keys).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import WizardShell, { WIZARD_PRIMARY_CLASS, WizardBackButton, WizardLock, WizardNotice } from "@/components/shared/wizard/WizardShell";
import WizardStages, { type WizardStage } from "@/components/shared/wizard/WizardStages";
import { ConfirmDialog } from "@/components/shared/application-status/ActionDrawer";
import { DocumentRow, Dropzone } from "@/components/shared/application-form/DocumentUpload";
import DocumentReadingState from "@/components/shared/application-form/DocumentReadingState";
import AssessmentRenderer, { AssessmentInfo } from "@/components/assessment/AssessmentRenderer";
import PdfPages from "@/components/signing/PdfPages";
import ReviewDocument, { type ReviewActions } from "./ReviewDocument";
import { flattenQuestions, moveItem, newSection, newTask, removeQuestion, updateQuestion } from "@/lib/assessment/definition";
import { isAnswerable, newQuestion, withSchema } from "@/lib/assessment/registry";
import type { Definition, Question, QuestionKey, Section, Task } from "@/lib/assessment/types";
import type { ImportResult } from "@/lib/assessment/workbookImport";
import { readWorkbook } from "@/lib/assessment/workbookFile";
import { blankWorkbookPdf, workbookLetterhead, type WorkbookLetterhead } from "@/lib/assessment/workbookExport";
import { autoTitle, decideFiling, filingCourseId, needsUnitStep, type FilingDecision } from "@/lib/assessment/workbookFiling";
import { asmAdmin, type Settings } from "@/pages/admin/lib/assessments";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";

type Mode = "workbook" | "manual";
type StepId = "start" | "upload" | "unit" | "review" | "save";
type View = "edit" | "student" | "pdf";
const STEP_TITLE: Record<StepId, string> = { start: "Start", upload: "Upload workbook", unit: "Qualification & unit", review: "Review", save: "Save" };
const VIEW_LABEL: Record<View, string> = { edit: "Edit", student: "Student view", pdf: "Workbook (PDF) view" };

const FIELD = "h-10 w-full rounded-lg border border-background-300 bg-background-50 px-3 text-sm text-foreground-900 focus:border-primary-400 focus:outline-none";
const SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2.5 text-sm font-semibold text-foreground-700 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-60";

const blankDefinition = (): Definition => ({ instructions: "", tasks: [{ ...newTask("Task 1"), sections: [newSection("Questions")] }] });

function StepHeading({ icon, title, text }: { icon: string; title: string; text: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background-100 text-foreground-600"><i className={`${icon} text-xl`} aria-hidden="true" /></span>
      <div className="min-w-0">
        <p className="font-heading text-sm font-semibold text-foreground-950">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-foreground-600">{text}</p>
      </div>
    </div>
  );
}

export default function AssessmentWizard({ courses, pageCourseId, pageUnitId, pageUnits, onClose, onSaved }: {
  courses: RtoCourse[];
  pageCourseId: string;
  pageUnitId: string;
  /** Units of the page's course (already loaded by the page). */
  pageUnits: RtoUnit[];
  onClose: () => void;
  /** The assessment was created (draft or published): the page opens the builder. */
  onSaved: (assessmentId: string) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");

  // upload
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [replaceWith, setReplaceWith] = useState<File | null>(null);
  // qualification & unit
  const [courseId, setCourseId] = useState(pageCourseId);
  const [unitId, setUnitId] = useState(pageUnitId);
  const [units, setUnits] = useState<RtoUnit[]>(pageUnits);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [decision, setDecision] = useState<FilingDecision | null>(null);
  /** The admin pressed Change in the header: the Qualification & unit step is shown even though the page chose the unit. */
  const [changeRequested, setChangeRequested] = useState(false);
  // the draft
  const [definition, setDefinition] = useState<Definition>(blankDefinition);
  const [keys, setKeys] = useState<QuestionKey[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // review
  const [view, setView] = useState<View>("edit");
  const [previewTask, setPreviewTask] = useState(0);
  const [trainerView, setTrainerView] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [letterhead, setLetterhead] = useState<WorkbookLetterhead | null>(null);
  const [pdf, setPdf] = useState<{ bytes: Uint8Array; key: string } | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState("");
  // save
  const [title, setTitle] = useState("");
  /** The admin typed a title; until then it follows the workbook cover / the unit. */
  const [titleTouched, setTitleTouched] = useState(false);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  // confirmations
  const [ask, setAsk] = useState<null | "discard" | "publish">(null);

  const pageCourse = courses.find((c) => c.id === pageCourseId) ?? null;
  const pageUnit = pageUnits.find((u) => u.id === pageUnitId) ?? null;
  // the step bars: the Qualification & unit step only when the page's selection is not where this assessment goes (ASM-WIZARD-SKIP)
  const stepsFor = (m: Mode | null, change: boolean): StepId[] => {
    const unitStep = needsUnitStep({ page: { courseId: pageCourseId, unitId: pageUnitId }, decision: m === "workbook" ? decision : null, changeRequested: change });
    return ["start", ...(m === "manual" ? [] : ["upload" as const]), ...(unitStep ? ["unit" as const] : []), "review", "save"];
  };
  const steps = stepsFor(mode, changeRequested);
  const current = steps[Math.min(step, steps.length - 1)];
  const chosenCourse = courses.find((c) => c.id === courseId) ?? null;
  const chosenUnit = units.find((u) => u.id && u.id === unitId) ?? null;
  const suggestedTitle = autoTitle(mode === "workbook" ? result?.title : null, chosenUnit);
  const shownTitle = titleTouched ? title : suggestedTitle;
  const finalTitle = shownTitle.trim() || suggestedTitle || "Untitled assessment";
  const editTitle = (t: string) => { setTitle(t); setTitleTouched(true); };
  const openChange = () => {
    setChangeRequested(true);
    if (!mode) return;
    const target = stepsFor(mode, true).indexOf("unit");
    if (target >= 0 && target !== step) { setDirection(target > step ? "forward" : "back"); setStep(target); }
  };
  const dirty = mode !== null;
  const flat = useMemo(() => flattenQuestions(definition), [definition]);
  const flagged = flat.filter((f) => f.question.importMeta?.confidence === "low");
  const questionCount = flat.filter((f) => isAnswerable(f.question)).length;
  // the unit and qualification the workbook pages print: the workbook's own, else where it is filed
  const docUnit = definition.source?.unit ?? (chosenUnit ? { code: chosenUnit.code, name: chosenUnit.name } : null);
  const docQualification = definition.source?.qualification ?? (chosenCourse ? { code: chosenCourse.code, name: chosenCourse.name } : null);
  const docDefinition = useMemo<Definition>(() => ({ ...definition, source: { ...(definition.source ?? {}), unit: docUnit, qualification: docQualification } }), [definition, docUnit?.code, docUnit?.name, docQualification?.code, docQualification?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void asmAdmin<Settings>("settings_get").then(setSettings).catch(() => setSettings(null)); }, []);
  useEffect(() => { void workbookLetterhead().then(setLetterhead).catch(() => setLetterhead(null)); }, []);

  // the Workbook (PDF) view: the blank workbook, built again when the draft changed since the last one
  const pdfKey = useMemo(() => JSON.stringify([docDefinition, finalTitle]), [docDefinition, finalTitle]);
  useEffect(() => {
    if (current !== "review" || view !== "pdf" || pdf?.key === pdfKey) return;
    let live = true;
    setPdfBusy(true); setPdfError("");
    blankWorkbookPdf(docDefinition, finalTitle)
      .then((bytes) => { if (live) setPdf({ bytes, key: pdfKey }); })
      .catch((e) => { if (live) setPdfError(e instanceof Error ? e.message : "The workbook PDF could not be made."); })
      .finally(() => { if (live) setPdfBusy(false); });
    return () => { live = false; };
  }, [current, view, pdfKey, pdf?.key, docDefinition, finalTitle]);
  const downloadPdf = () => {
    if (!pdf) return;
    const url = URL.createObjectURL(new Blob([pdf.bytes as unknown as ArrayBuffer], { type: "application/pdf" }));
    const link = document.createElement("a"); link.href = url; link.download = `${docUnit?.code ?? "assessment"}_workbook.pdf`;
    document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // units of the chosen course
  const loadUnits = async (id: string): Promise<RtoUnit[]> => {
    if (!id) { setUnits([]); return []; }
    if (id === pageCourseId && pageUnits.length) { setUnits(pageUnits); return pageUnits; }
    setUnitsLoading(true);
    try { const d = await rto<CourseDetail>("course_get", { courseId: id }); setUnits(d.units ?? []); return d.units ?? []; }
    catch { setUnits([]); return []; }
    finally { setUnitsLoading(false); }
  };

  const goTo = (target: number) => {
    if (target < 0 || target >= steps.length || target === step) return;
    // forward only through the steps already allowed
    if (target > step) for (let k = step; k < target; k++) if (!canLeave(steps[k])) return;
    setDirection(target > step ? "forward" : "back");
    setStep(target);
  };
  const canLeave = (id: StepId): boolean => {
    if (id === "start") return mode !== null;
    if (id === "upload") return Boolean(result) && !reading;
    if (id === "unit") return Boolean(courseId && unitId);
    if (id === "review") return definition.tasks.length > 0;
    return true;
  };

  const choose = (m: Mode) => {
    if (m !== mode) {
      setMode(m); setResult(null); setFile(null); setReadError(""); setDecision(null); setKeys([]); setSelected(null); setView("edit"); setPdf(null);
      setDefinition(blankDefinition()); setCourseId(pageCourseId); setUnitId(pageUnitId); setUnits(pageUnits); setTitle(""); setTitleTouched(false);
    }
    setDirection("forward"); setStep(1);
  };

  const read = async (f: File) => {
    setFile(f); setReading(true); setReadError(""); setResult(null); setDecision(null);
    try {
      const r = await readWorkbook(f);
      setResult(r);
      setDefinition(r.definition); setKeys(r.keys); setSelected(null); setPdf(null);
      setTitle(""); setTitleTouched(false);
      // where to file it: the workbook's own qualification / unit first, checked against the unit selected on the page
      const workbook = { qualificationCode: r.qualification?.code ?? null, unitCode: r.unit?.code ?? r.unitCode };
      const page = { courseId: pageCourseId, unitId: pageUnitId, unitCode: pageUnit?.code ?? null };
      const cid = filingCourseId({ workbook, page, courses: courses.map((c) => ({ id: c.id, code: c.code })) });
      const list = await loadUnits(cid);
      const d = decideFiling({ workbook, page, courses: courses.map((c) => ({ id: c.id, code: c.code })), unitsOfCourse: list.filter((u) => u.id).map((u) => ({ id: u.id as string, code: u.code })) });
      setDecision(d); setCourseId(d.courseId); setUnitId(d.unitId);
      if (d.courseId && d.courseId !== cid) await loadUnits(d.courseId);
    } catch (e) {
      setFile(null); setReadError(e instanceof Error ? e.message : "The workbook could not be read.");
    } finally { setReading(false); }
  };
  const pick = (files: FileList | null) => {
    const f = files?.[0]; if (!f) return;
    if (result) { setReplaceWith(f); return; }
    void read(f);
  };

  /* ---------------- draft editing (the builder's helpers) ---------------- */
  const mapSection = (taskId: string, sectionId: string, fn: (s: Section) => Section) => setDefinition((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id !== taskId ? t : { ...t, sections: t.sections.map((s) => (s.id === sectionId ? fn(s) : s)) })) }));
  const actions: ReviewActions = {
    patchQuestion: (id, patch) => setDefinition((d) => updateQuestion(d, id, (q) => ({ ...q, ...patch }))),
    changeType: (q: Question, type: string) => {
      if (type === q.type) return;
      const fresh = newQuestion(type);
      setDefinition((d) => updateQuestion(d, q.id, () => ({ ...fresh, id: q.id, label: q.label, helpText: q.helpText, required: q.required, ...(q.importMeta ? { importMeta: q.importMeta } : {}) })));
    },
    remove: (id) => { setDefinition((d) => removeQuestion(d, id)); setKeys((list) => list.filter((k) => k.questionId !== id)); if (selected === id) setSelected(null); },
    move: (taskId, sectionId, parentId, from, to) => {
      if (parentId) setDefinition((d) => updateQuestion(d, parentId, (p) => ({ ...p, children: moveItem(p.children ?? [], from, to) })));
      else mapSection(taskId, sectionId, (s) => ({ ...s, questions: moveItem(s.questions, from, to) }));
      window.setTimeout(() => document.getElementById(`wq-${selected}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
    },
    add: (taskId, sectionId, type) => {
      const q = withSchema(newQuestion(type));
      mapSection(taskId, sectionId, (s) => ({ ...s, questions: [...s.questions, q] }));
      setSelected(q.id);
      window.setTimeout(() => document.getElementById(`wq-${q.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
    },
    addTask: () => setDefinition((d) => ({ ...d, tasks: [...d.tasks, { ...newTask(`Task ${d.tasks.length + 1}`), sections: [newSection("Questions")] }] })),
    patchTask: (taskId, patch) => setDefinition((d) => ({ ...d, tasks: d.tasks.map((t: Task) => (t.id === taskId ? { ...t, ...patch } : t)) })),
    patchSection: (taskId, sectionId, patch) => mapSection(taskId, sectionId, (s) => ({ ...s, ...patch })),
    setInstructions: (html) => setDefinition((d) => ({ ...d, instructions: html })),
    keyOf: (id) => keys.find((k) => k.questionId === id),
    patchKey: (id, patch) => setKeys((list) => (list.some((k) => k.questionId === id) ? list.map((k) => (k.questionId === id ? { ...k, ...patch } : k)) : [...list, { questionId: id, ...patch }])),
  };
  /** "Mark all as reviewed": every "check this" is cleared; the page each block came from stays as its grey label. */
  const markAllReviewed = () => {
    const clear = (q: Question): Question => ({ ...q, ...(q.importMeta?.confidence === "low" ? { importMeta: { ...q.importMeta, confidence: "high" as const, note: undefined } } : {}), ...(q.children ? { children: q.children.map(clear) } : {}) });
    setDefinition((d) => ({ ...d, tasks: d.tasks.map((t) => ({ ...t, sections: t.sections.map((s) => ({ ...s, questions: s.questions.map(clear) })) })) }));
  };
  const openQuestion = (id: string) => {
    setView("edit"); setSelected(id);
    window.setTimeout(() => document.getElementById(`wq-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  /* ---------------- save ---------------- */
  const save = async (publish: boolean) => {
    setSaving(true); setSaveError("");
    try {
      const ids = new Set(flat.map((f) => f.question.id));
      const keyList = keys.filter((k) => ids.has(k.questionId) && (k.modelAnswer || k.assessorGuidance || (k.answerKey !== undefined && k.answerKey !== null) || k.rubricLevels));
      let id = createdId;
      if (!id) {
        const out = await asmAdmin<{ id?: string; ok?: boolean; errors?: { message: string }[] }>("assessment_create", {
          courseId, unitId, title: finalTitle, code: code.trim() || null, description,
          // the draft definition; model answers / guidance only as assessor keys (asm_question_keys)
          import: { title: finalTitle, definition, keys: keyList },
        });
        if (out.ok === false || !out.id) throw new Error(out.errors?.map((e) => e.message).join(" ") || "The assessment was not created.");
        id = out.id; setCreatedId(id);
      }
      if (publish) {
        const pub = await asmAdmin<{ ok: boolean; errors?: { message: string }[] }>("version_publish", { assessmentId: id });
        if (!pub.ok) { setSaveError(`Saved as a draft, but not published: ${pub.errors?.map((e) => e.message).join(" ") ?? ""} Open the draft to fix it.`); return; }
      }
      onSaved(id);
    } catch (e) { setSaveError(e instanceof Error ? e.message : "The assessment was not saved."); }
    finally { setSaving(false); }
  };

  const requestClose = () => { if (createdId) { onSaved(createdId); return; } if (dirty) setAsk("discard"); else onClose(); };
  const next = () => { setSelected(null); goTo(step + 1); };

  /* ---------------- the Upload step's check: what the workbook is for, against the unit selected on the page ---------------- */
  const filingCheck = (): ReactNode => {
    if (!result || !decision) return null;
    const wbUnit = result.unit ?? (result.unitCode ? { code: result.unitCode, name: "" } : null);
    const target = chosenCourse && chosenUnit ? `${chosenCourse.code} › ${chosenUnit.code}` : null;
    let tone: "warn" | "ok" | "info" = "ok"; let text: ReactNode;
    if (decision.mismatch) {
      tone = "warn";
      text = <><strong>This workbook is for {wbUnit?.code}{wbUnit?.name ? ` ${wbUnit.name}` : ""}, not {pageUnit?.code}{pageUnit?.name ? ` ${pageUnit.name}` : ""}</strong> (selected on the page). {decision.unitMissing
        ? <>{decision.courseMissing ? `The qualification ${result.qualification?.code ?? ""} is not in Skyline, and ` : ""}{wbUnit?.code} is not a unit {decision.courseMissing ? "of a course" : "of that course"} in Skyline: choose where to file it in the next step.</>
        : <>It will be filed under {target ?? wbUnit?.code}. The next step lets you check or change it.</>}</>;
    } else if (decision.unitMissing || decision.courseMissing) {
      tone = "warn"; text = decision.message;
    } else if (decision.source === "page") {
      tone = "info"; text = decision.message;
    } else {
      text = <>Matches the unit selected on the page{target ? ` (${target})` : ""}.</>;
    }
    const style = tone === "warn" ? "border-amber-300 bg-amber-50 text-amber-900" : tone === "info" ? "border-background-200 bg-background-100 text-foreground-700" : "border-green-200 bg-green-50 text-green-900";
    return (
      <div className="space-y-2" data-testid="filing-check">
        <dl className="grid gap-2 rounded-lg border border-background-200 p-3 text-sm sm:grid-cols-2">
          <div><dt className="text-2xs font-semibold uppercase tracking-wide text-foreground-500">The workbook is for</dt>
            <dd className="mt-0.5 text-foreground-900">{wbUnit ? <><strong>{wbUnit.code}</strong> {wbUnit.name}</> : <span className="text-foreground-500">No unit named</span>}{result.qualification ? <span className="block text-xs text-foreground-600">{result.qualification.code} {result.qualification.name}</span> : null}</dd></div>
          <div><dt className="text-2xs font-semibold uppercase tracking-wide text-foreground-500">Selected on the page</dt>
            <dd className="mt-0.5 text-foreground-900">{pageUnit ? <><strong>{pageUnit.code}</strong> {pageUnit.name}</> : <span className="text-foreground-500">No unit</span>}{pageCourse ? <span className="block text-xs text-foreground-600">{pageCourse.code} {pageCourse.name}</span> : null}</dd></div>
        </dl>
        <p role={tone === "warn" ? "alert" : "status"} data-testid={tone === "warn" ? "filing-mismatch" : "filing-match"} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${style}`}>
          <i className={`${tone === "warn" ? "ri-error-warning-line" : tone === "ok" ? "ri-checkbox-circle-line" : "ri-information-line"} mt-0.5`} aria-hidden="true" /><span>{text}</span>
        </p>
      </div>
    );
  };

  /* ---------------- steps ---------------- */
  const body = (): ReactNode => {
    if (current === "start") return (
      <div className="space-y-4">
        <StepHeading icon="ri-file-list-3-line" title="How do you want to start?" text="Upload the unit's student workbook to build the questions for you, or start from an empty assessment." />
        <div className="grid gap-3 sm:grid-cols-2">
          {([["workbook", "ri-file-upload-line", "Upload workbook (Word or PDF)", "We read the tasks and questions. You check them before saving."], ["manual", "ri-edit-box-line", "Create manually", "Start empty and add the questions yourself."]] as const).map(([m, icon, label, text]) => (
            <button key={m} type="button" onClick={() => choose(m)} aria-pressed={mode === m}
              className={`flex cursor-pointer flex-col items-start gap-2 rounded-xl border p-5 text-left transition-colors ${mode === m ? "border-primary-400 bg-primary-50" : "border-background-200 bg-background-50 hover:border-primary-300"}`}>
              <i className={`${icon} text-2xl text-primary-600`} aria-hidden="true" />
              <span className="font-heading text-base font-semibold text-foreground-950">{label}</span>
              <span className="text-sm text-foreground-600">{text}</span>
            </button>
          ))}
        </div>
      </div>
    );

    if (current === "upload") return (
      <div className="space-y-3">
        <StepHeading icon="ri-file-word-line" title="Student workbook" text="The Word file, or a PDF with selectable text. It is read in your browser; nothing is saved yet." />
        {!file && !reading ? <Dropzone label="Upload workbook" hint="Word (.docx) or PDF · read in your browser" accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onFiles={pick} /> : null}
        <div aria-live="polite" className="space-y-1.5">
          {reading && file ? <DocumentReadingState filename={file.name} file={file} phase="processing" /> : null}
          {!reading && file && result ? (
            <DocumentRow filename={file.name} pill={{ text: "Read", tone: "ready" }}
              actions={<label title="Replace" className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-600 transition-colors duration-150 hover:bg-background-100 hover:text-foreground-900">
                <i className="ri-upload-2-line text-base leading-none" aria-hidden="true" /><span className="sr-only">Replace {file.name}</span>
                <input type="file" accept=".docx,.pdf" className="sr-only" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
              </label>}>
              <p className="mt-1.5 px-1 text-xs text-foreground-600">{result.stats.tasks} task{result.stats.tasks === 1 ? "" : "s"} · {result.stats.topLevelQuestions} questions{result.stats.lowConfidence ? ` · ${result.stats.lowConfidence} to check` : ""}</p>
            </DocumentRow>
          ) : null}
        </div>
        {!reading ? filingCheck() : null}
      </div>
    );

    if (current === "unit") {
      const course = courses.find((c) => c.id === courseId);
      return (
        <div className="space-y-4">
          <StepHeading icon="ri-graduation-cap-line" title="Qualification & unit" text={mode === "workbook" ? "Where this assessment is filed. The workbook's own unit comes first." : "Choose where this assessment is filed."} />
          {mode === "workbook" && result ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-background-200 p-3">
                <p className="text-2xs font-semibold uppercase tracking-wide text-foreground-500">Found in the workbook</p>
                <p className="mt-1 text-sm text-foreground-900">{result.qualification ? <><strong>{result.qualification.code}</strong> {result.qualification.name}</> : <span className="text-foreground-500">No qualification named</span>}</p>
                <p className="mt-0.5 text-sm text-foreground-900">{result.unit ? <><strong>{result.unit.code}</strong> {result.unit.name}</> : <span className="text-foreground-500">No unit named</span>}</p>
              </div>
              <div className="rounded-lg border border-background-200 p-3">
                <p className="text-2xs font-semibold uppercase tracking-wide text-foreground-500">Will be filed under</p>
                <p className="mt-1 text-sm text-foreground-900">{course ? <><strong>{course.code}</strong> {course.name}</> : <span className="text-foreground-500">Choose a course</span>}</p>
                <p className="mt-0.5 text-sm text-foreground-900">{chosenUnit ? <><strong>{chosenUnit.code}</strong> {chosenUnit.name}</> : <span className="text-foreground-500">Choose a unit</span>}</p>
              </div>
            </div>
          ) : null}
          {decision && (decision.mismatch || decision.source !== "workbook" || decision.courseMissing) ? (
            <p role="alert" className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${decision.source === "pick" || decision.mismatch ? "border-amber-300 bg-amber-50 text-amber-900" : "border-background-200 bg-background-100 text-foreground-700"}`}>
              <i className="ri-error-warning-line mt-0.5" aria-hidden="true" />{decision.mismatch && pageUnit && !decision.message.includes(pageUnit.code) ? `The workbook is not for ${pageUnit.code} (selected on the page). ` : ""}{decision.message}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-foreground-800">Qualification
              <select className={`${FIELD} mt-1`} value={courseId} onChange={(e) => { const id = e.target.value; setCourseId(id); setUnitId(""); void loadUnits(id); }}>
                <option value="">Choose…</option>
                {courses.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
              </select>
            </label>
            <label className="block text-sm font-semibold text-foreground-800">Unit
              <select className={`${FIELD} mt-1`} value={unitId} disabled={!courseId || unitsLoading} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">{unitsLoading ? "Loading units…" : "Choose…"}</option>
                {units.filter((u) => u.id).map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}{u.isActive === false ? " (inactive)" : ""}</option>)}
              </select>
            </label>
          </div>
        </div>
      );
    }

    if (current === "review") {
      const task = definition.tasks[Math.min(previewTask, definition.tasks.length - 1)];
      return (
        <div className="space-y-3">
          <div className="sticky -top-5 z-20 -mx-1 flex flex-wrap items-center justify-between gap-2 border-b border-background-200 bg-background-50/95 px-1 py-2 backdrop-blur md:-top-6">
            <div role="tablist" aria-label="Review view" className="inline-flex rounded-lg border border-background-300 bg-background-100 p-0.5">
              {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => { setView(v); setSelected(null); }}
                  className={`cursor-pointer rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${view === v ? "bg-background-50 text-foreground-950 shadow-sm" : "text-foreground-600 hover:text-foreground-900"}`}>{VIEW_LABEL[v]}</button>
              ))}
            </div>
            {view === "edit" && flagged.length ? (
              <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="review-flagged">
                <button type="button" onClick={() => openQuestion(flagged[0].question.id)} className="cursor-pointer rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-200" title="Go to the first one">{flagged.length} marked “Check this”</button>
                <button type="button" onClick={markAllReviewed} className={SECONDARY.replace("px-4 py-2.5", "px-3 py-1.5")}><i className="ri-check-double-line" aria-hidden="true" />Mark all as reviewed</button>
              </div>
            ) : view === "edit" && mode === "workbook" ? <span className="text-xs text-foreground-500" data-testid="review-all-reviewed"><i className="ri-check-double-line mr-1" aria-hidden="true" />All reviewed</span> : null}
            {view === "student" ? <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground-800"><input type="checkbox" checked={trainerView} onChange={(e) => setTrainerView(e.target.checked)} />Trainer view</label> : null}
            {view === "pdf" ? <button type="button" className={SECONDARY.replace("px-4 py-2.5", "px-3 py-1.5")} disabled={!pdf || pdfBusy} onClick={downloadPdf}><i className="ri-download-2-line" aria-hidden="true" />Download PDF</button> : null}
          </div>

          {view === "edit" ? <>
            <p className="text-xs text-foreground-600">Click any part of the page to change it. Nothing is saved until the last step.</p>
            <ReviewDocument definition={definition} title={shownTitle} onTitle={editTitle} unit={docUnit} qualification={docQualification} version={definition.source?.version ?? null}
              letterhead={letterhead} selected={selected} onSelect={setSelected} actions={actions} />
          </> : null}

          {view === "student" ? (
            <div className="space-y-4" data-testid="review-student-view">
              <p className="text-xs text-foreground-600">{trainerView ? "As the trainer sees it: the assessor checklists are shown." : "Exactly what the student sees. Answers typed here are not kept."}</p>
              {definition.instructions ? <AssessmentInfo text={definition.instructions} /> : settings?.instructions ? <div className="rounded-card border border-background-200 bg-background-100 p-4 text-sm text-foreground-800 whitespace-pre-wrap">{settings.instructions}</div> : null}
              {definition.tasks.length > 1 ? <div className="flex flex-wrap gap-2">{definition.tasks.map((x, i) => <button key={x.id} type="button" onClick={() => setPreviewTask(i)} className={`rounded-full border px-3.5 py-1.5 text-label font-medium ${x.id === task?.id ? "border-primary-500 bg-primary-50 text-primary-700" : "border-background-200 text-foreground-700 hover:bg-background-100"}`}>Task {i + 1}: {x.title}</button>)}</div> : null}
              {task ? <AssessmentRenderer definition={definition} responses={{}} onChange={() => undefined} mode="student" taskId={task.id} evidence={[]} onUpload={async () => undefined} disabled declarationText={settings?.declaration_text ?? ""} showAssessor={trainerView} /> : <p className="text-sm text-foreground-600">There is nothing to preview yet.</p>}
            </div>
          ) : null}

          {view === "pdf" ? (
            <div className="space-y-2 rounded-lg bg-background-200/60 p-3 sm:p-5" data-testid="review-pdf-view">
              <p className="text-xs text-foreground-600">The blank workbook as “Export as workbook PDF” prints it. A marked submission adds the student's answers, the ticks and the results.</p>
              {pdfError ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{pdfError}</p> : null}
              {pdfBusy || !pdf ? <p role="status" className="p-6 text-center text-sm text-foreground-600"><i className="ri-loader-4-line mr-1.5 animate-spin" aria-hidden="true" />Making the workbook PDF…</p>
                : <PdfPages source={pdf.bytes} maxWidth={820} />}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <StepHeading icon="ri-save-3-line" title="Save" text={`${questionCount} question${questionCount === 1 ? "" : "s"} in ${definition.tasks.length} task${definition.tasks.length === 1 ? "" : "s"}. Save it as a draft to keep working in the builder, or publish it to assign it.`} />
        {flagged.length ? <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"><i className="ri-error-warning-line mr-1" aria-hidden="true" />{flagged.length} item{flagged.length === 1 ? " is" : "s are"} still marked “Check this”. You can save anyway, or go back to Review.</p> : null}
        <label className="block text-sm font-semibold text-foreground-800">Title<input className={`${FIELD} mt-1`} value={shownTitle} onChange={(e) => editTitle(e.target.value)} placeholder={suggestedTitle || "Assessment title"} /></label>
        <label className="block text-sm font-semibold text-foreground-800">Code <span className="font-normal text-foreground-500">(optional)</span><input className={`${FIELD} mt-1`} value={code} onChange={(e) => setCode(e.target.value)} /></label>
        <label className="block text-sm font-semibold text-foreground-800">Description <span className="font-normal text-foreground-500">(optional)</span><textarea className="mt-1 w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 focus:border-primary-400 focus:outline-none" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        {createdId && saveError ? <button type="button" className={SECONDARY} onClick={() => onSaved(createdId)}>Open the draft in the builder</button> : null}
      </div>
    );
  };

  const stages: WizardStage[] = steps.map((id, i) => ({ id, title: STEP_TITLE[id], from: i, to: i, busy: id === "upload" && reading }));
  const isLast = current === "save";

  return (
    <WizardShell
      wide={current === "review"}
      title="Add assessment"
      subtitle={chosenCourse && chosenUnit ? (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span data-testid="wizard-filing"><strong className="font-semibold text-foreground-800">{chosenCourse.code}</strong> › <strong className="font-semibold text-foreground-800">{chosenUnit.code}</strong> — {chosenUnit.name}</span>
          {current !== "unit" && !saving && !createdId ? <button type="button" onClick={openChange} className="cursor-pointer text-xs font-semibold text-primary-700 underline-offset-2 hover:underline">Change</button> : null}
        </span>
      ) : mode === "workbook" ? "From the unit's student workbook" : mode === "manual" ? "Created manually" : "Upload a workbook or create one manually"}
      icon="ri-file-list-3-line"
      onClose={requestClose}
      closeLabel="Close the wizard"
      stepper={<WizardStages stages={stages} current={step} total={steps.length} stepTitle={STEP_TITLE[current]} onSelect={goTo} />}
      footerStart={
        <>
          <button type="button" onClick={requestClose} className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium text-foreground-500 transition-colors hover:text-foreground-800"><i className="ri-close-line" aria-hidden="true" />Cancel</button>
          {step > 0 ? <WizardBackButton onClick={() => { setSelected(null); goTo(step - 1); }} disabled={saving || reading} /> : null}
        </>
      }
      footerEnd={
        current === "start" ? null : isLast ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <button type="button" className={SECONDARY} disabled={saving || Boolean(createdId && saveError)} onClick={() => void save(false)}>{saving ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-draft-line" aria-hidden="true" />}Save as draft</button>
            <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={saving || Boolean(createdId && saveError)} onClick={() => setAsk("publish")}>Publish<i className="ri-send-plane-line" aria-hidden="true" /></button>
          </div>
        ) : (
          <button type="button" className={WIZARD_PRIMARY_CLASS} disabled={!canLeave(current) || reading} onClick={next}>Next<i className="ri-arrow-right-line" aria-hidden="true" /></button>
        )
      }
      notices={
        <>
          {current === "upload" && readError ? <WizardNotice tone="error">{readError}</WizardNotice> : null}
          {current === "upload" && !result && !readError && !reading ? <WizardNotice tone="info">Upload the workbook to continue.</WizardNotice> : null}
          {current === "unit" && !(courseId && unitId) ? <WizardNotice tone="info">Choose the qualification and the unit to continue.</WizardNotice> : null}
          {saveError ? <WizardNotice tone="error">{saveError}</WizardNotice> : null}
          <div className="border-t border-background-200 px-5 py-3 text-center md:px-6"><p className="text-2xs text-foreground-400">Nothing is saved until you press Save as draft or Publish. Model answers stay visible to assessors only.</p></div>
        </>
      }
      overlay={reading ? <WizardLock quiet>Reading the workbook…</WizardLock> : saving ? <WizardLock>Saving…</WizardLock> : null}
    >
      <div key={current} className={direction === "back" ? "step-in-back" : "step-in-forward"}>{body()}</div>

      {replaceWith ? <ConfirmDialog title="A workbook is already read. Replace it?" confirmLabel="Replace workbook"
        body={`${replaceWith.name} is read instead, and the questions and edits from ${file?.name ?? "the current file"} are discarded.`}
        onClose={() => setReplaceWith(null)} onConfirm={() => { const f = replaceWith; setReplaceWith(null); void read(f); }} /> : null}
      {ask === "discard" ? <ConfirmDialog title={mode === "workbook" ? "Discard this import?" : "Discard this assessment?"} confirmLabel="Discard" tone="danger"
        body="Nothing has been saved. The questions and your edits are lost." onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); onClose(); }} /> : null}
      {ask === "publish" ? <ConfirmDialog title="Publish this assessment?" confirmLabel="Publish"
        body="Once published it can be assigned to intakes and students will see it when it is assigned. Later changes make a new version." onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); void save(true); }} /> : null}
    </WizardShell>
  );
}
