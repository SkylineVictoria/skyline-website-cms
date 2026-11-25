/**
 * ASM-AI-IMPORT (owner, 2026-11-25; mockups docs/mockups/assessment-flow-mockups.pdf pages 1-2): Add assessment = Upload -> Check
 * -> Publish. The workbook layout appears only behind "Preview PDF".
 *
 *  Upload  two drop zones (workbook, answer guide). Each PDF is read by the AI import (server, asm-import) and by the standard reader
 *          at the same time; "Here's what we found" fills in live. The standard reader's result is used when the AI fails, times out
 *          or is skipped ("Read without AI"); the card says which reader was used.
 *  [Qualification & unit]  only when opened from Master Data (no unit chosen) or the workbook is for another unit.
 *  Check   only the flagged items, one line each; a row opens inline (question text, what the trainer should look for), "Save & next";
 *          done rows are struck through. "Browse all questions" lists everything as compact rows, edited inline. An edit keeps the
 *          original ("Show original"), who and when; publishing with edits bumps the version (1.0 -> 1.1, printed in the PDF footer).
 *  Publish asm_admin assessment_create + asm_import_key_trace + version_publish.
 * Answers only ever go to asm_question_keys (assessors), never into the definition.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import PdfPages from "@/components/signing/PdfPages";
import SearchableSelect from "@/components/ui/SearchableSelect";
import { ConfirmDialog } from "@/components/shared/application-status/ActionDrawer";
import { flattenQuestions, updateQuestion } from "@/lib/assessment/definition";
import { isAnswerable, newId } from "@/lib/assessment/registry";
import type { Definition, Question, QuestionKey } from "@/lib/assessment/types";
import type { ImportResult } from "@/lib/assessment/workbookImport";
import { readWorkbook, renderRegions } from "@/lib/assessment/workbookFile";
import { blankWorkbookPdf } from "@/lib/assessment/workbookExport";
import { workbookNumbering } from "@/lib/assessment/workbookLayout";
import { useWorkbookLetterhead } from "@/components/assessment/useWorkbookLetterhead";
import WorkbookHeaderPicker from "@/components/assessment/WorkbookHeaderPicker";
import { autoTitle, decideFiling, filingCourseId, needsUnitStep, type FilingDecision } from "@/lib/assessment/workbookFiling";
import {
  applyGuide, chooseImportPath, definitionFromAi, guideAnswersFromAi, guideAnswersFromParser, mergeParserExtras, prepare, startAiImport, watchImport,
  type GuideApplied, type ImportStatus, type Prepared,
} from "@/lib/assessment/aiImport";
import { bumpVersion } from "../../../../supabase/functions/_shared/asm-import/match.ts";
import type { GuideAnswer } from "../../../../supabase/functions/_shared/asm-import/match.ts";
import { asmAdmin } from "@/pages/admin/lib/assessments";
import { supabase } from "@/pages/admin/lib/supabase";
import { useAuth } from "@/pages/admin/lib/authContext";
import { rto, type CourseDetail, type RtoCourse, type RtoUnit } from "@/pages/admin/lib/rto";

type StepId = "upload" | "unit" | "check" | "done";
type Path = "ai" | "parser";
interface DocState {
  file: File;
  phase: "reading" | "ai" | "ready" | "error";
  prepared: Prepared | null;
  status: ImportStatus | null;
  path: Path | null;
  reason: string | null;
  error: string | null;
  /** The standard reader's result (also for Word files). */
  parser: ImportResult | null;
}
type TraceKey = QuestionKey & { originalModelAnswer?: string | null; originalGuidance?: string | null; source?: "ai" | "parser" | "content_match" | "manual"; edited?: boolean };
interface CheckRow { id: string; number: string; label: string; reason: string; tag: "Answer missing" | "Import check" | "Answer check"; parentId: string | null }
type DoneHow = "Looks good" | "Edited" | "No answer";

const PRIMARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY = "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-background-300 bg-white px-4 py-2.5 text-sm font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "w-full rounded-lg border border-background-300 bg-white px-3 py-2 text-sm text-foreground-900 focus:border-primary-400 focus:outline-none";
const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function StepPills({ steps, current }: { steps: { id: StepId; label: string }[]; current: StepId }) {
  const at = steps.findIndex((s) => s.id === current);
  return (
    <ol className="flex shrink-0 items-center gap-1.5 text-xs font-semibold sm:text-sm" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s.id} aria-current={i === at ? "step" : undefined}
          className={i === at ? "rounded-full bg-primary-600 px-3 py-1 text-white" : i < at ? "px-2 py-1 text-green-700" : "px-2 py-1 text-foreground-500"}>
          {i < at ? "✓ " : `${i + 1} `}{s.label}
        </li>
      ))}
    </ol>
  );
}

function FileCard({ kind, doc, onPick, onRemove }: { kind: "workbook" | "guide"; doc: DocState | null; onPick: (f: File) => void; onRemove: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const label = kind === "workbook" ? "Workbook" : "Answer guide";
  const pick = (files: FileList | null) => { const f = files?.[0]; if (f) onPick(f); };
  if (!doc) return (
    <button type="button" onClick={() => input.current?.click()} data-testid={`drop-${kind}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
      className={`flex min-h-[96px] w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-4 text-center transition-colors ${over ? "border-primary-400 bg-primary-50" : "border-background-300 bg-white hover:border-primary-300"}`}>
      <i className="ri-upload-cloud-2-line text-2xl text-primary-600" aria-hidden="true" />
      <span className="text-sm font-semibold text-foreground-900">{label}{kind === "guide" ? <span className="font-normal text-foreground-500"> (optional)</span> : null}</span>
      <span className="text-xs text-foreground-500">{kind === "workbook" ? "PDF (or Word) · drop it here or click" : "The assessor / marking guide · PDF"}</span>
      <input ref={input} type="file" accept={kind === "workbook" ? ".pdf,.docx,application/pdf" : ".pdf,.docx,application/pdf"} className="sr-only" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
    </button>
  );
  const tone = doc.phase === "error" ? "border-red-200 bg-red-50" : doc.phase === "ready" ? "border-green-200 bg-green-50/70" : "border-background-200 bg-white";
  const status = doc.phase === "reading" ? "Reading…" : doc.phase === "ai" ? (doc.status?.progress?.label ?? "Reading with AI…") : doc.phase === "error" ? "Not read" : kind === "workbook" ? "Read" : "Matched";
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 ${tone}`} data-testid={`file-${kind}`}>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-background-200 bg-white text-xs font-bold text-red-600">{doc.file.name.toLowerCase().endsWith(".docx") ? "DOC" : "PDF"}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-2xs font-bold uppercase tracking-wide ${doc.phase === "error" ? "text-red-700" : doc.phase === "ready" ? "text-green-700" : "text-foreground-500"}`}>{label} · {status}</p>
        <p className="truncate text-sm font-semibold text-foreground-950" title={doc.file.name}>{doc.file.name}</p>
        <p className="text-xs text-foreground-600">
          {doc.prepared ? `${doc.prepared.pages.length} pages` : doc.parser ? "Word file" : "…"}
          {doc.phase === "ready" ? ` · Version ${(doc.path === "ai" ? doc.status?.result?.version : doc.parser?.version) ?? "not printed"}` : ""}
        </p>
        {doc.phase === "ai" && doc.status?.progress?.total ? (
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-background-200" aria-hidden="true">
            <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${Math.round(100 * Math.min(1, (doc.status.progress.done || 0) / doc.status.progress.total))}%` }} />
          </div>
        ) : null}
      </div>
      {doc.phase === "reading" || doc.phase === "ai" ? <i className="ri-loader-4-line animate-spin text-lg text-foreground-500" aria-label="Working" />
        : <button type="button" onClick={onRemove} className="cursor-pointer rounded-md p-1.5 text-foreground-500 hover:bg-background-100 hover:text-foreground-900" aria-label={`Remove ${label.toLowerCase()}`}><i className="ri-close-line text-lg" aria-hidden="true" /></button>}
    </div>
  );
}

function Stat({ n, of, label }: { n: number | string; of?: number; label: string }) {
  return (
    <div className="rounded-xl border border-background-200 bg-white px-3 py-2.5">
      <p className="font-heading text-2xl font-bold leading-none text-foreground-950">{n}{of !== undefined ? <span className="text-sm font-semibold text-foreground-500">/{of}</span> : null}</p>
      <p className="mt-1 text-xs text-foreground-600">{label}</p>
    </div>
  );
}

export default function ImportWizard({ courses, pageCourseId, pageUnitId, pageUnits, onClose, onSaved }: {
  courses: RtoCourse[];
  pageCourseId: string;
  pageUnitId: string;
  pageUnits: RtoUnit[];
  onClose: () => void;
  onSaved: (assessmentId: string) => void;
}) {
  const { user } = useAuth();
  // ASM-HEADER: the header picture of the workbook PDF, asked once while none is set (Assessments > Settings)
  const { head: letterhead, setting: headerSetting } = useWorkbookLetterhead();
  const headerMissing = Boolean(headerSetting?.available && !headerSetting.url);
  const [step, setStep] = useState<StepId>("upload");
  const [wb, setWb] = useState<DocState | null>(null);
  const [guide, setGuide] = useState<DocState | null>(null);
  const [skipAi, setSkipAi] = useState(false);
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [keys, setKeys] = useState<TraceKey[]>([]);
  const [applied, setApplied] = useState<GuideApplied | null>(null);
  // filing
  const [courseId, setCourseId] = useState(pageCourseId);
  const [unitId, setUnitId] = useState(pageUnitId);
  const [units, setUnits] = useState<RtoUnit[]>(pageUnits);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [decision, setDecision] = useState<FilingDecision | null>(null);
  // check
  const [open, setOpen] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, DoneHow>>({});
  const [browse, setBrowse] = useState(false);
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  // publish
  const [ask, setAsk] = useState<null | "discard" | "publish">(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [published, setPublished] = useState<{ id: string; version: string | null; draft: boolean } | null>(null);
  // preview
  const [preview, setPreview] = useState<{ bytes: Uint8Array | null; busy: boolean; error: string } | null>(null);
  const aborts = useRef<AbortController[]>([]);
  useEffect(() => () => { aborts.current.forEach((a) => a.abort()); }, []);

  const pageUnit = pageUnits.find((u) => u.id === pageUnitId) ?? null;
  const chosenCourse = courses.find((c) => c.id === courseId) ?? null;
  const chosenUnit = units.find((u) => u.id && u.id === unitId) ?? null;
  const unitStep = needsUnitStep({ page: { courseId: pageCourseId, unitId: pageUnitId }, decision, changeRequested: false });
  const steps: { id: StepId; label: string }[] = [{ id: "upload", label: "Upload" }, ...(unitStep || step === "unit" ? [{ id: "unit" as const, label: "Unit" }] : []), { id: "check", label: "Check" }, { id: "done", label: "Publish" }];

  const loadUnits = async (id: string): Promise<RtoUnit[]> => {
    if (!id) { setUnits([]); return []; }
    if (id === pageCourseId && pageUnits.length) { setUnits(pageUnits); return pageUnits; }
    setUnitsLoading(true);
    try { const d = await rto<CourseDetail>("course_get", { courseId: id }); setUnits(d.units ?? []); return d.units ?? []; }
    catch { setUnits([]); return []; } finally { setUnitsLoading(false); }
  };

  /** Reads one document with both readers; resolves with the finished state. */
  const readDoc = async (kind: "workbook" | "guide", file: File, set: (d: DocState) => void, force = false): Promise<DocState> => {
    let state: DocState = { file, phase: "reading", prepared: null, status: null, path: null, reason: null, error: null, parser: null };
    const put = (patch: Partial<DocState>) => { state = { ...state, ...patch }; set(state); };
    put({});
    let prepared: Prepared | null = null;
    try { prepared = await prepare(file, renderRegions as (doc: unknown, r: Parameters<typeof renderRegions>[1]) => ReturnType<typeof renderRegions>); }
    catch (e) {
      if (!(e instanceof Error && e.message === "not-pdf")) { put({ phase: "error", error: e instanceof Error ? e.message : "The file could not be read." }); return state; }
    }
    if (!prepared) {
      // Word: the standard reader only
      try { const r = await readWorkbook(file); put({ phase: "ready", parser: r, path: "parser", reason: "Word files use the standard reader (the AI reads PDFs)." }); }
      catch (e) { put({ phase: "error", error: e instanceof Error ? e.message : "The file could not be read." }); }
      return state;
    }
    put({ prepared, parser: prepared.parser });
    const noText = prepared.pages.every((p) => p.scanned);
    if (skipAi) { put({ phase: noText ? "error" : "ready", path: "parser", reason: "Read without AI (as you asked).", error: noText ? "This PDF has no readable text (a scan): the standard reader cannot read it. Use the AI reader." : null }); return state; }
    put({ phase: "ai" });
    const ctrl = new AbortController(); aborts.current.push(ctrl);
    let watched: { status: ImportStatus | null; timedOut: boolean } | null = null;
    try {
      const started = await startAiImport(kind, prepared, { force });
      put({ status: started });
      watched = started.state === "done" || started.state === "failed" ? { status: started, timedOut: false } : await watchImport(started.id, (s) => put({ status: s }), ctrl.signal);
    } catch (e) { watched = { status: null, timedOut: false }; put({ reason: e instanceof Error ? e.message : null }); }
    if (ctrl.signal.aborted) return state;
    const choice = chooseImportPath(watched);
    if (choice.path === "parser" && noText) { put({ phase: "error", path: "parser", reason: choice.reason, error: `${choice.reason ?? "The AI reader failed."} This PDF is a scan, so the standard reader cannot read it either.` }); return state; }
    put({ phase: "ready", path: choice.path, reason: choice.reason ?? state.reason, status: watched?.status ?? state.status });
    return state;
  };

  /** The draft from the workbook, and where it is filed. */
  const adoptWorkbook = async (d: DocState) => {
    const ai = d.path === "ai" && d.status?.result ? d.status.result : null;
    const def = ai ? mergeParserExtras(definitionFromAi(ai, d.prepared?.images ?? []), d.parser?.definition ?? { tasks: [] }, ai.tasks) : d.parser?.definition ?? null;
    if (!def) return;
    const viaParser = d.path === "parser";
    const source = { ...(def.source ?? {}), fileName: d.file.name, ...(viaParser ? { unit: d.parser?.unit ?? null, qualification: d.parser?.qualification ?? null, version: d.parser?.version ?? null } : {}) };
    const full: Definition = { ...def, source };
    setDefinition(full);
    setKeys((d.parser && viaParser ? d.parser.keys : []).map((k) => ({ ...k, originalModelAnswer: k.modelAnswer ?? null, originalGuidance: k.assessorGuidance ?? null, source: "parser" })));
    setDone({}); setOpen(null);
    const workbook = { qualificationCode: source.qualification?.code ?? null, unitCode: source.unit?.code ?? d.parser?.unitCode ?? null };
    const page = { courseId: pageCourseId, unitId: pageUnitId, unitCode: pageUnit?.code ?? null };
    const cs = courses.map((c) => ({ id: c.id, code: c.code }));
    const cid = filingCourseId({ workbook, page, courses: cs });
    const list = await loadUnits(cid);
    const dec = decideFiling({ workbook, page, courses: cs, unitsOfCourse: list.filter((u) => u.id).map((u) => ({ id: u.id as string, code: u.code })) });
    setDecision(dec); setCourseId(dec.courseId); setUnitId(dec.unitId);
    if (dec.courseId && dec.courseId !== cid) await loadUnits(dec.courseId);
    setTitle(autoTitle(d.path === "ai" ? d.status?.result?.title : d.parser?.title, list.find((u) => u.id === dec.unitId) ?? null));
  };

  const pickWorkbook = async (file: File, force = false) => {
    setDefinition(null); setApplied(null);
    const d = await readDoc("workbook", file, setWb, force);
    if (d.phase === "ready") await adoptWorkbook(d);
  };
  const pickGuide = async (file: File, force = false) => { setApplied(null); await readDoc("guide", file, setGuide, force); };

  // the guide is applied whenever both documents are ready (again after the workbook changes)
  const guideAnswers = useMemo<{ unitCode: string | null; version: string | null; answers: GuideAnswer[] } | null>(() => {
    if (!guide || guide.phase !== "ready") return null;
    if (guide.path === "ai" && guide.status?.result) return { unitCode: guide.status.result.unit?.code ?? null, version: guide.status.result.version, answers: guideAnswersFromAi(guide.status.result) };
    if (guide.parser) return { unitCode: guide.parser.unit?.code ?? guide.parser.unitCode, version: guide.parser.version, answers: guideAnswersFromParser(guide.parser) };
    return null;
  }, [guide]);
  useEffect(() => {
    if (!definition || !guideAnswers) return;
    const a = applyGuide(definition, guideAnswers);
    setApplied(a);
    const source = guide?.path === "ai" ? "ai" : "parser";
    setKeys((prev) => {
      const map = new Map(prev.map((k) => [k.questionId, k]));
      for (const k of a.keys) map.set(k.questionId, { ...k, originalModelAnswer: k.modelAnswer ?? null, originalGuidance: k.assessorGuidance ?? null, source: a.review.has(k.questionId) && /content/.test(a.review.get(k.questionId) ?? "") ? "content_match" : source });
      return [...map.values()];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideAnswers, definition?.tasks]);

  /* ---------------- counts for "Here's what we found" ---------------- */
  const flat = useMemo(() => (definition ? flattenQuestions(definition) : []), [definition]);
  const numbers = useMemo(() => (definition ? workbookNumbering(definition) : new Map()), [definition]);
  const keyOf = (id: string) => keys.find((k) => k.questionId === id);
  const hasAnswer = (q: Question) => { const k = keyOf(q.id); return Boolean(k?.modelAnswer || k?.assessorGuidance) || (q.children ?? []).some((c) => { const ck = keyOf(c.id); return Boolean(ck?.modelAnswer || ck?.assessorGuidance); }); };
  const topQuestions = flat.filter((f) => !f.parent && isAnswerable(f.question) && !["declaration", "adjustment_record", "observation_checklist"].includes(f.question.type));
  const stats = definition ? {
    tasks: definition.tasks.length,
    questions: topQuestions.filter((f) => f.question.type !== "file_upload").length,
    evidence: flat.filter((f) => f.question.type === "file_upload" || f.question.config?.allowAttachment === true).length,
    drawings: flat.filter((f) => f.question.type === "instruction" && /<img\b/i.test(String(f.question.config?.html ?? ""))).reduce((n, f) => n + (String(f.question.config?.html ?? "").match(/<img\b/gi)?.length ?? 0), 0),
  } : null;
  const live = wb?.phase === "ai" ? wb.status?.summary : null;
  const answerable = topQuestions.filter((f) => f.question.type !== "file_upload");

  /* ---------------- the Check list ---------------- */
  /** Rows already listed stay listed (in their place) until the import changes, so answering one does not make it vanish. */
  const listed = useRef<{ key: string; rows: CheckRow[] }>({ key: "", rows: [] });
  const listKey = `${wb?.file.name ?? ""}|${wb?.status?.id ?? ""}|${wb?.path ?? ""}|${guide?.status?.id ?? guide?.file.name ?? ""}|${applied ? "g" : ""}`;
  const computedRows: CheckRow[] = useMemo(() => {
    if (!definition) return [];
    const out: CheckRow[] = [];
    for (const f of flat) {
      const q = f.question;
      const num = q.importMeta?.number ?? numbers.get(q.id)?.number ?? (f.parent ? `${numbers.get(f.parent.id)?.number ?? ""}${String.fromCharCode(97 + Math.max(0, (f.parent.children ?? []).indexOf(q)))}` : "");
      const label = q.type === "instruction" ? plain(String(q.config?.html ?? "")) || "Instruction" : q.label;
      const flags = q.importMeta?.flags ?? (q.importMeta?.confidence === "low" && q.importMeta.note ? [q.importMeta.note] : []);
      if (flags.length && !q.importMeta?.reviewedAt) out.push({ id: q.id, number: num, label, reason: flags[0], tag: "Import check", parentId: f.parent?.id ?? null });
      if (!f.parent && applied && !applied.check.block && isAnswerable(q) && !["declaration", "adjustment_record", "observation_checklist", "file_upload"].includes(q.type)) {
        if (!hasAnswer(q)) out.push({ id: `${q.id}#answer`, number: num, label, reason: "No answer found in the guide", tag: "Answer missing", parentId: null });
        else if (applied.review.has(q.id)) out.push({ id: `${q.id}#answer`, number: num, label, reason: applied.review.get(q.id) ?? "Check the answer", tag: "Answer check", parentId: null });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, applied, keys, flat, numbers]);
  const rows: CheckRow[] = useMemo(() => {
    if (listed.current.key !== listKey) listed.current = { key: listKey, rows: [] };
    const seen = new Map(listed.current.rows.map((r) => [r.id, r]));
    const fresh = new Map(computedRows.map((r) => [r.id, r]));
    const merged = listed.current.rows.map((r) => fresh.get(r.id) ?? r);
    for (const r of computedRows) if (!seen.has(r.id)) merged.push(r);
    listed.current.rows = merged;
    return merged;
  }, [computedRows, listKey]);
  const left = rows.filter((r) => !done[r.id]).length;
  const answersMissing = rows.filter((r) => r.tag === "Answer missing").length;
  const importChecks = rows.length - answersMissing;

  /* ---------------- editing ---------------- */
  const questionId = (rowId: string) => rowId.replace(/#answer$/, "");
  const editLabel = (id: string, text: string) => setDefinition((d) => d && updateQuestion(d, id, (q) => {
    const original = q.importMeta?.original ?? q.label;
    const changed = text !== original;
    return { ...q, label: text, importMeta: { ...(q.importMeta ?? { confidence: "high" }), original, editedAt: changed ? new Date().toISOString() : null, editedBy: changed ? user?.id ?? null : null, editedByName: changed ? user?.name ?? null : null } };
  }));
  const editAnswer = (id: string, text: string) => setKeys((list) => {
    const k = list.find((x) => x.questionId === id);
    if (!k) return [...list, { questionId: id, modelAnswer: text, originalModelAnswer: null, originalGuidance: null, source: "manual", edited: true }];
    return list.map((x) => (x.questionId === id ? { ...x, modelAnswer: text, edited: (x.originalModelAnswer ?? "") !== text || x.source === "manual" } : x));
  });
  const markReviewed = (id: string) => setDefinition((d) => d && updateQuestion(d, id, (q) => ({ ...q, importMeta: { ...(q.importMeta ?? { confidence: "high" }), reviewedAt: new Date().toISOString() } })));
  const finishRow = (row: CheckRow, how: DoneHow) => {
    if (row.tag === "Import check") markReviewed(row.id);
    setDone((m) => ({ ...m, [row.id]: how }));
    const next = rows.find((r) => r.id !== row.id && !done[r.id]);
    setOpen(next?.id ?? null);
  };
  const edits = useMemo(() => flat.filter((f) => f.question.importMeta?.editedAt).length + keys.filter((k) => k.edited).length, [flat, keys]);

  /* ---------------- preview / publish ---------------- */
  const docDefinition = useMemo<Definition | null>(() => {
    if (!definition) return null;
    const unit = definition.source?.unit ?? (chosenUnit ? { code: chosenUnit.code, name: chosenUnit.name } : null);
    const qualification = definition.source?.qualification ?? (chosenCourse ? { code: chosenCourse.code, name: chosenCourse.name } : null);
    const version = edits ? bumpVersion(definition.source?.version ?? "1.0") : (definition.source?.version ?? null);
    return { ...definition, source: { ...(definition.source ?? {}), unit, qualification, version } };
  }, [definition, chosenUnit, chosenCourse, edits]);
  const openPreview = async () => {
    if (!docDefinition) return;
    setPreview({ bytes: null, busy: true, error: "" });
    try { setPreview({ bytes: await blankWorkbookPdf(docDefinition, title || autoTitle(null, chosenUnit) || "Assessment"), busy: false, error: "" }); }
    catch (e) { setPreview({ bytes: null, busy: false, error: e instanceof Error ? e.message : "The PDF could not be made." }); }
  };
  /** No workbook: an empty draft opened in the builder (the unit is chosen first when the page has none). */
  const [manual, setManual] = useState(false);
  const createEmpty = async (cid = courseId, uid = unitId) => {
    setSaving(true); setSaveError("");
    try {
      const unit = units.find((u) => u.id === uid) ?? null;
      const out = await asmAdmin<{ id?: string; ok?: boolean; errors?: { message: string }[] }>("assessment_create", {
        courseId: cid, unitId: uid, title: autoTitle(null, unit) || "Untitled assessment", code: null, description: "",
        import: { definition: { instructions: "", tasks: [{ id: newId("t"), title: "Task 1", instructions: "", sections: [{ id: newId("s"), title: "Questions", questions: [] }] }] }, keys: [] },
      });
      if (out.ok === false || !out.id) throw new Error(out.errors?.map((e) => e.message).join(" ") || "The assessment was not created.");
      onSaved(out.id);
    } catch (e) { setSaveError(e instanceof Error ? e.message : "The assessment was not created."); }
    finally { setSaving(false); }
  };
  const startEmpty = () => { if (pageCourseId && pageUnitId) void createEmpty(pageCourseId, pageUnitId); else { setManual(true); setStep("unit"); } };
  const save = async (publish: boolean) => {
    if (!docDefinition) return;
    setSaving(true); setSaveError("");
    try {
      const ids = new Set(flat.map((f) => f.question.id));
      const keyList = keys.filter((k) => ids.has(k.questionId) && (k.modelAnswer || k.assessorGuidance));
      const out = await asmAdmin<{ id?: string; ok?: boolean; errors?: { message: string }[] }>("assessment_create", {
        courseId, unitId, title: title.trim() || autoTitle(null, chosenUnit) || "Untitled assessment", code: null, description: "",
        import: { title, definition: docDefinition, keys: keyList.map(({ questionId, modelAnswer, assessorGuidance }) => ({ questionId, modelAnswer, assessorGuidance })) },
      });
      if (out.ok === false || !out.id) throw new Error(out.errors?.map((e) => e.message).join(" ") || "The assessment was not created.");
      const trace = keyList.map((k) => ({ questionId: k.questionId, originalModelAnswer: k.originalModelAnswer ?? null, originalGuidance: k.originalGuidance ?? null, source: k.source ?? "manual", edited: Boolean(k.edited) }));
      if (trace.length) { const t = await supabase.rpc("asm_import_key_trace", { p_assessment: out.id, p_traces: trace }); if (t.error) console.warn("asm_import_key_trace", t.error.message); }
      if (publish) {
        const pub = await asmAdmin<{ ok: boolean; errors?: { message: string }[] }>("version_publish", { assessmentId: out.id });
        if (!pub.ok) { setPublished({ id: out.id, version: docDefinition.source?.version ?? null, draft: true }); setSaveError(`Saved as a draft, not published: ${pub.errors?.map((e) => e.message).join(" ") ?? ""}`); setStep("done"); return; }
      }
      setPublished({ id: out.id, version: docDefinition.source?.version ?? null, draft: !publish }); setStep("done");
    } catch (e) { setSaveError(e instanceof Error ? e.message : "The assessment was not saved."); }
    finally { setSaving(false); }
  };

  const requestClose = () => { if (published) { onSaved(published.id); return; } if (wb || guide) setAsk("discard"); else onClose(); };
  const busy = wb?.phase === "reading" || wb?.phase === "ai" || guide?.phase === "reading" || guide?.phase === "ai";
  const guideBlocked = Boolean(applied?.check.block);
  const canCheck = Boolean(definition && wb?.phase === "ready" && !busy && !headerMissing);
  const goCheck = () => { setStep(unitStep && !(courseId && unitId) ? "unit" : unitStep && step === "upload" ? "unit" : "check"); setOpen(rows.find((r) => !done[r.id])?.id ?? null); };

  /* ---------------- views ---------------- */
  const pathLine = (d: DocState | null, what: string): ReactNode => {
    if (!d || d.phase !== "ready") return null;
    const usage = d.status?.usage;
    const tokens = usage && (usage.input_tokens || usage.output_tokens) ? ` · ${((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)).toLocaleString()} tokens${usage.cost_usd != null ? ` · US$${usage.cost_usd.toFixed(3)}` : ""}` : "";
    return d.path === "ai"
      ? <li className="flex items-start gap-2" data-testid={`path-${what}`}><i className="ri-sparkling-2-line mt-0.5 text-primary-600" aria-hidden="true" /><span>{what} read by the AI reader{d.status?.model ? ` (${d.status.model})` : ""}{d.status?.cached ? " · read before, no cost" : tokens}</span></li>
      : <li className="flex items-start gap-2" data-testid={`path-${what}`}><i className="ri-file-search-line mt-0.5 text-foreground-500" aria-hidden="true" /><span>{what} read with the standard reader{d.reason ? `: ${d.reason}` : ""}</span></li>;
  };

  const uploadView = (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <FileCard kind="workbook" doc={wb} onPick={(f) => void pickWorkbook(f)} onRemove={() => { setWb(null); setDefinition(null); setKeys([]); setApplied(null); setDecision(null); }} />
        <FileCard kind="guide" doc={guide} onPick={(f) => void pickGuide(f)} onRemove={() => { setGuide(null); setApplied(null); setKeys((k) => k.filter((x) => x.source === "manual" || x.source === "parser")); }} />
      </div>
      {wb?.error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{wb.error}</p> : null}
      {definition && headerMissing ? <WorkbookHeaderPicker head={letterhead} current={null} title="Choose the workbook header (asked once)" /> : null}
      {guide?.error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">Answer guide: {guide.error}</p> : null}
      {wb ? (
        <section className="rounded-2xl bg-background-100 p-4 sm:p-5" aria-live="polite" data-testid="found-card">
          <h3 className="font-heading text-sm font-semibold text-foreground-950">Here’s what we found{busy ? <span className="ml-2 text-xs font-normal text-foreground-500">reading… {wb.phase === "ai" ? wb.status?.progress?.label : ""}</span> : null}</h3>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat n={stats?.tasks ?? live?.tasks ?? "–"} label="tasks" />
            <Stat n={stats?.questions ?? live?.questions ?? "–"} label="questions" />
            <Stat n={stats?.evidence ?? live?.evidence ?? "–"} label="evidence uploads" />
            <Stat n={stats?.drawings ?? live?.drawings ?? "–"} label="drawings" />
            {applied && !guideBlocked ? <Stat n={applied.outcome.matched} of={applied.outcome.total} label="answers matched" /> : <Stat n={guide ? (guide.phase === "ready" ? "–" : "…") : "–"} label={guide ? "answers matched" : "no answer guide"} />}
          </div>
          <ul className="mt-3 space-y-1.5 text-sm text-foreground-800">
            {definition ? (decision?.mismatch
              ? <li className="flex items-start gap-2 text-amber-900"><i className="ri-error-warning-line mt-0.5" aria-hidden="true" /><span>The workbook is for <strong>{definition.source?.unit?.code}</strong>, not {pageUnit?.code}: you choose where to file it next.</span></li>
              : <li className="flex items-start gap-2"><i className="ri-check-line mt-0.5 text-green-700" aria-hidden="true" /><span>{applied && applied.check.unit === "same" ? <>Workbook and answer guide are both for <strong>{definition.source?.unit?.code}</strong>{pageUnit ? ", the unit you selected" : ""}</> : <>Workbook is for <strong>{definition.source?.unit?.code ?? chosenUnit?.code ?? "a unit it does not print"}</strong>{pageUnit && !decision?.mismatch ? ", the unit you selected" : ""}</>}</span></li>) : null}
            {applied?.check.messages.map((m) => (
              <li key={m} className={`flex items-start gap-2 ${applied.check.block ? "text-red-800" : "text-amber-900"}`} role={applied.check.block ? "alert" : undefined}>
                <i className={`${applied.check.block ? "ri-close-circle-line" : "ri-error-warning-line"} mt-0.5`} aria-hidden="true" /><span>{m}{applied.check.block ? " The answer guide is not used." : ""}</span>
              </li>
            ))}
            {applied && applied.check.version === "same" ? <li className="flex items-start gap-2"><i className="ri-check-line mt-0.5 text-green-700" aria-hidden="true" /><span>Same version ({definition?.source?.version}) on both documents</span></li> : null}
            {definition && !busy ? (rows.length
              ? <li className="flex items-start gap-2 text-primary-800"><i className="ri-error-warning-line mt-0.5" aria-hidden="true" /><span><strong>{rows.length} item{rows.length === 1 ? "" : "s"}</strong> need{rows.length === 1 ? "s" : ""} a quick look ({[answersMissing ? `${answersMissing} answer${answersMissing === 1 ? "" : "s"} missing` : "", importChecks ? `${importChecks} import check${importChecks === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")})</span></li>
              : <li className="flex items-start gap-2"><i className="ri-check-double-line mt-0.5 text-green-700" aria-hidden="true" /><span>Nothing needs a look</span></li>) : null}
            {pathLine(wb, "Workbook")}{pathLine(guide, "Answer guide")}
          </ul>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-500">
        <label className="inline-flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={skipAi} disabled={busy} onChange={(e) => setSkipAi(e.target.checked)} data-testid="skip-ai" />Read without AI (standard reader)</label>
        {wb?.phase === "ready" && wb.prepared && !skipAi ? <button type="button" className="cursor-pointer underline-offset-2 hover:underline" onClick={() => void pickWorkbook(wb.file, true)}>Read the workbook again</button> : null}
        <span>Only the workbook and answer guide are read; never student work. The AI does not mark.</span>
        {!wb ? <button type="button" className="cursor-pointer font-semibold text-primary-700 underline-offset-2 hover:underline" onClick={startEmpty} data-testid="start-empty">No workbook? Start an empty assessment</button> : null}
      </div>
    </div>
  );

  const unitView = (
    <div className="space-y-4">
      {decision && (decision.mismatch || decision.source !== "workbook" || decision.courseMissing) ? <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"><i className="ri-error-warning-line mt-0.5" aria-hidden="true" />{decision.message}</p> : null}
      <p className="text-sm text-foreground-700">{manual ? "Choose the qualification and unit of the new assessment." : <>The workbook is for <strong>{definition?.source?.unit?.code ?? "a unit it does not name"}</strong> {definition?.source?.unit?.name}. Choose where to file it.</>}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold text-foreground-800">Qualification
          <SearchableSelect className={`${FIELD} mt-1 h-10`} noMatchText="No qualifications match" searchPlaceholder="Search by code or name…" value={courseId} onChange={(e) => { const id = e.target.value; setCourseId(id); setUnitId(""); void loadUnits(id); }}>
            <option value="">Choose…</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
          </SearchableSelect>
        </label>
        <label className="block text-sm font-semibold text-foreground-800">Unit
          <SearchableSelect className={`${FIELD} mt-1 h-10`} noMatchText="No units match" searchPlaceholder="Search by code or name…" value={unitId} disabled={!courseId || unitsLoading} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">{unitsLoading ? "Loading units…" : "Choose…"}</option>
            {units.filter((u) => u.id).map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}
          </SearchableSelect>
        </label>
      </div>
    </div>
  );

  const editor = (rowId: string, tag: CheckRow["tag"] | null) => {
    const id = questionId(rowId);
    const q = flat.find((f) => f.question.id === id)?.question;
    if (!q) return null;
    const k = keyOf(id);
    const isText = q.type !== "instruction";
    const row = rows.find((r) => r.id === rowId) ?? null;
    return (
      <div className="space-y-3 border-t border-primary-100 bg-primary-50/40 px-3 pb-3 pt-2 sm:px-4" data-testid="row-editor">
        {isText ? (
          <label className="block">
            <span className="text-2xs font-bold uppercase tracking-wide text-foreground-600">Question</span>
            <textarea className={`${FIELD} mt-1`} rows={3} value={q.label} onChange={(e) => editLabel(q.id, e.target.value)} aria-label="Question text" />
          </label>
        ) : <p className="rounded-lg border border-background-200 bg-white px-3 py-2 text-sm text-foreground-800">{plain(String(q.config?.html ?? "")) || "A picture from the workbook"}{/<img\b/.test(String(q.config?.html ?? "")) ? <span className="ml-1 text-xs text-foreground-500">(with its drawing)</span> : null}</p>}
        {q.importMeta?.pdfText && q.importMeta.pdfText !== q.label ? (
          <div className="rounded-lg border border-background-200 bg-white px-3 py-2 text-sm">
            <p className="text-2xs font-bold uppercase tracking-wide text-foreground-500">The PDF says</p>
            <p className="mt-0.5 text-foreground-800">{q.importMeta.pdfText}</p>
            <button type="button" className="mt-1 cursor-pointer text-xs font-semibold text-primary-700 hover:underline" onClick={() => editLabel(q.id, q.importMeta?.pdfText ?? q.label)}>Use the PDF wording</button>
          </div>
        ) : null}
        {isText && q.type !== "declaration" && !(q.children?.length) ? (
          <label className="block">
            <span className="text-2xs font-bold uppercase tracking-wide text-foreground-600">What the trainer should look for</span>
            <textarea className={`${FIELD} mt-1 ${tag === "Answer missing" ? "border-primary-400" : ""}`} rows={3} placeholder="Type or paste the model answer…" value={k?.modelAnswer ?? ""} onChange={(e) => editAnswer(q.id, e.target.value)} aria-label="Model answer" />
            {k?.assessorGuidance ? <span className="mt-1 block text-xs text-foreground-600">Benchmark from the guide: {k.assessorGuidance}</span> : null}
          </label>
        ) : null}
        {row ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY.replace("px-4 py-2.5", "px-3 py-2")} onClick={() => finishRow(row, q.importMeta?.editedAt || keyOf(q.id)?.edited ? "Edited" : row.tag === "Answer missing" && !keyOf(q.id)?.modelAnswer ? "No answer" : "Looks good")}>Save &amp; next</button>
            {row.tag === "Answer missing" ? <button type="button" className={SECONDARY.replace("px-4 py-2.5", "px-3 py-2")} onClick={() => finishRow(row, "No answer")}>Leave without answer</button>
              : <button type="button" className={SECONDARY.replace("px-4 py-2.5", "px-3 py-2")} onClick={() => finishRow(row, "Looks good")}>Looks good</button>}
          </div>
        ) : <button type="button" className={SECONDARY.replace("px-4 py-2.5", "px-3 py-1.5")} onClick={() => setOpen(null)}>Done</button>}
      </div>
    );
  };

  const checkView = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground-900">Needs a look <span className="font-normal text-foreground-500">· {left} of {rows.length} left</span></p>
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-background-200 sm:w-40" aria-hidden="true"><div className="h-full rounded-full bg-green-600 transition-all" style={{ width: `${rows.length ? Math.round(100 * (rows.length - left) / rows.length) : 100}%` }} /></div>
      </div>
      {rows.length ? (
        <ul className="divide-y divide-background-200 overflow-hidden rounded-xl border border-background-200 bg-white" data-testid="check-list">
          {rows.map((r) => {
            const how = done[r.id];
            const isOpen = open === r.id;
            return (
              <li key={r.id} className={isOpen ? "bg-primary-50/30" : ""}>
                <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen} className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left sm:px-4">
                  {how ? <i className="ri-check-line text-green-700" aria-hidden="true" /> : <span className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${isOpen ? "border-primary-600 bg-primary-600" : "border-background-400"}`} aria-hidden="true" />}
                  <span className="w-12 shrink-0 text-sm font-semibold text-foreground-900">{r.number || "–"}</span>
                  <span className={`min-w-0 flex-1 truncate text-sm ${how ? "text-foreground-500 line-through" : "text-foreground-800"}`}>{r.reason}{!isOpen ? <span className="ml-2 hidden text-foreground-500 sm:inline">{short(r.label, 60)}</span> : null}</span>
                  {how ? <span className="shrink-0 text-xs text-foreground-500">{how}</span>
                    : <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold ${r.tag === "Answer missing" ? "bg-amber-100 text-amber-900" : r.tag === "Answer check" ? "bg-sky-100 text-sky-900" : "bg-indigo-100 text-indigo-900"}`}>{r.tag}</span>}
                </button>
                {isOpen ? editor(r.id, r.tag) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"><i className="ri-check-double-line mr-1" aria-hidden="true" />Nothing was flagged. Browse the questions if you want to look anyway.</p>}
      <button type="button" className="cursor-pointer text-sm font-semibold text-primary-700 hover:underline" onClick={() => setBrowse((b) => !b)} aria-expanded={browse}>{browse ? "Hide the questions" : `Browse all ${answerable.length} questions ›`}</button>
      {browse ? (
        <ul className="divide-y divide-background-200 overflow-hidden rounded-xl border border-background-200 bg-white" data-testid="browse-list">
          {flat.filter((f) => isAnswerable(f.question)).map((f) => {
            const q = f.question; const id = `browse:${q.id}`; const isOpen = open === id;
            const num = q.importMeta?.number ?? numbers.get(q.id)?.number ?? (f.parent ? `${numbers.get(f.parent.id)?.number ?? ""}${String.fromCharCode(97 + Math.max(0, (f.parent.children ?? []).indexOf(q)))}` : "");
            const edited = Boolean(q.importMeta?.editedAt);
            return (
              <li key={q.id}>
                <button type="button" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen} className={`flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left sm:px-4 ${f.parent ? "pl-8 sm:pl-10" : ""}`}>
                  <span className="w-14 shrink-0 text-sm font-semibold text-foreground-900">{num}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground-800">{showOriginal[q.id] && q.importMeta?.original ? q.importMeta.original : q.label}</span>
                  {keyOf(q.id)?.modelAnswer ? <i className="ri-key-2-line text-foreground-400" title="Has a model answer" aria-label="Has a model answer" /> : null}
                  {edited ? <span className="shrink-0 rounded-full bg-primary-100 px-2 py-0.5 text-2xs font-semibold text-primary-800">Edited</span> : null}
                </button>
                {edited ? <p className="px-4 pb-1 text-xs text-foreground-500">Edited{q.importMeta?.editedByName ? ` by ${q.importMeta.editedByName}` : ""}{q.importMeta?.editedAt ? ` · ${new Date(q.importMeta.editedAt).toLocaleString()}` : ""} · <button type="button" className="cursor-pointer font-semibold text-primary-700 hover:underline" onClick={() => setShowOriginal((m) => ({ ...m, [q.id]: !m[q.id] }))}>{showOriginal[q.id] ? "Show edited" : "Show original"}</button></p> : null}
                {isOpen ? editor(q.id, null) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );

  const doneView = published ? (
    <div className="space-y-3 py-4 text-center" data-testid="published">
      <i className={`${published.draft ? "ri-draft-line text-foreground-600" : "ri-checkbox-circle-line text-green-600"} text-5xl`} aria-hidden="true" />
      <p className="font-heading text-lg font-semibold text-foreground-950">{published.draft ? "Saved as a draft" : "Published"}{published.version ? ` · version ${published.version}` : ""}</p>
      <p className="text-sm text-foreground-600">{published.draft ? "Open it to finish and publish." : "It can now be assigned to intakes."}{edits ? ` ${edits} edit${edits === 1 ? "" : "s"} recorded.` : ""}</p>
      {saveError ? <p role="alert" className="text-sm text-red-700">{saveError}</p> : null}
      <button type="button" className={PRIMARY} onClick={() => onSaved(published.id)}>Open the assessment<i className="ri-arrow-right-line" aria-hidden="true" /></button>
    </div>
  ) : null;

  const footer = step === "done" ? null : (
    <div className="flex flex-col-reverse items-stretch gap-2 border-t border-background-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      {step === "upload" ? <button type="button" className="cursor-pointer px-2 py-2 text-sm font-semibold text-foreground-600 hover:text-foreground-900" onClick={requestClose}>Cancel</button>
        : <button type="button" className="cursor-pointer px-2 py-2 text-sm font-semibold text-foreground-600 hover:text-foreground-900" onClick={() => { if (step === "unit") setManual(false); setStep(step === "check" && unitStep ? "unit" : "upload"); }}>← Back</button>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <button type="button" className={SECONDARY} disabled={!definition || busy} onClick={() => void openPreview()} data-testid="preview-pdf">Preview PDF</button>
        {step === "upload" ? <button type="button" className={PRIMARY} disabled={!canCheck} onClick={goCheck} data-testid="go-check">{rows.length ? `Check ${rows.length} item${rows.length === 1 ? "" : "s"} →` : "Continue →"}</button> : null}
        {step === "unit" ? <button type="button" className={PRIMARY} disabled={!(courseId && unitId) || saving} onClick={() => (manual ? void createEmpty() : setStep("check"))}>{manual ? "Create and open the builder" : "Continue →"}</button> : null}
        {step === "check" ? <button type="button" className={PRIMARY} disabled={!(courseId && unitId) || saving} onClick={() => setAsk("publish")} data-testid="publish">Publish</button> : null}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[80] flex items-stretch justify-center overflow-y-auto bg-background-200/80 backdrop-blur-sm sm:items-start sm:p-6" role="dialog" aria-modal="true" aria-label="Add assessment">
      <div className="flex w-full max-w-3xl flex-col bg-white shadow-xl sm:my-4 sm:rounded-2xl">
        <header className="flex flex-col gap-3 border-b border-background-200 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
          <div className="min-w-0">
            <h2 className="font-heading text-xl font-bold text-foreground-950">Add assessment</h2>
            <p className="mt-0.5 truncate text-sm text-foreground-600">{chosenCourse ? <>{chosenCourse.code} › <strong className="text-foreground-900">{chosenUnit?.code ?? "choose a unit"}</strong>{chosenUnit ? ` · ${chosenUnit.name}` : ""}</> : "Upload the unit’s workbook and answer guide"}</p>
          </div>
          <div className="flex items-center justify-between gap-2"><StepPills steps={steps} current={step} />
            <button type="button" onClick={requestClose} className="cursor-pointer rounded-md p-1 text-foreground-500 hover:bg-background-100 hover:text-foreground-900 sm:ml-2" aria-label="Close"><i className="ri-close-line text-xl" aria-hidden="true" /></button></div>
        </header>
        <div className="flex-1 px-4 py-4 sm:px-6 sm:py-5">
          {step === "upload" ? uploadView : step === "unit" ? unitView : step === "check" ? checkView : doneView}
          {saveError && step !== "done" ? <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{saveError}</p> : null}
        </div>
        {footer}
      </div>

      {preview ? (
        <div className="fixed inset-0 z-[90] flex items-stretch justify-center bg-foreground-950/60 sm:p-6" role="dialog" aria-modal="true" aria-label="Preview PDF">
          <div className="flex w-full max-w-4xl flex-col bg-background-100 sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-background-200 bg-white px-4 py-3 sm:rounded-t-2xl">
              <p className="font-heading text-sm font-semibold text-foreground-950">Preview PDF{docDefinition?.source?.version ? ` · version ${docDefinition.source.version}` : ""}</p>
              <button type="button" className="cursor-pointer rounded-md p-1 text-foreground-500 hover:bg-background-100" onClick={() => setPreview(null)} aria-label="Close the preview"><i className="ri-close-line text-xl" aria-hidden="true" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 sm:p-5">
              {preview.error ? <p role="alert" className="text-sm text-red-700">{preview.error}</p> : preview.busy || !preview.bytes ? <p role="status" className="p-6 text-center text-sm text-foreground-600"><i className="ri-loader-4-line mr-1.5 animate-spin" aria-hidden="true" />Making the workbook PDF…</p> : <PdfPages source={preview.bytes} maxWidth={820} />}
            </div>
          </div>
        </div>
      ) : null}
      {ask === "discard" ? <ConfirmDialog title="Discard this import?" confirmLabel="Discard" tone="danger" body="Nothing has been saved. The questions and your edits are lost." onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); onClose(); }} /> : null}
      {ask === "publish" ? (
        <ConfirmDialog title="Publish this assessment?" confirmLabel="Publish"
          body={<div className="space-y-3 text-left">
            <label className="block text-sm font-semibold text-foreground-800">Title<input className={`${FIELD} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={autoTitle(null, chosenUnit) || "Assessment title"} /></label>
            {left ? <p className="text-sm text-amber-900">{left} flagged item{left === 1 ? " is" : "s are"} not checked yet.</p> : null}
            {edits ? <p className="text-sm text-foreground-700">You edited {edits} item{edits === 1 ? "" : "s"}: it is published as version {docDefinition?.source?.version}.</p> : null}
            <button type="button" className="cursor-pointer text-sm font-semibold text-primary-700 hover:underline" onClick={() => { setAsk(null); void save(false); }}>Save as a draft instead</button>
          </div>}
          onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); void save(true); }} />
      ) : null}
      {saving ? <div className="fixed inset-0 z-[95] flex items-center justify-center bg-white/60"><p role="status" className="rounded-lg bg-white px-4 py-3 text-sm shadow"><i className="ri-loader-4-line mr-1.5 animate-spin" aria-hidden="true" />Saving…</p></div> : null}
    </div>
  );
}
