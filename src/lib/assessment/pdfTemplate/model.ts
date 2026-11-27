/**
 * ASM-PDF-TEMPLATE (owner 2026-11-26): an assessment is its workbook PDF, used as it is, like an offer letter / e-sign template.
 * The uploaded PDF is the document; the template only says where answers and marks go on it. Nothing is re-typed or rebuilt.
 *
 * Coordinates are fractions of the page (0..1, origin top-left), as in the e-sign templates (hr.sign_templates), so a field holds at any
 * zoom and in the stamped PDF. Pure data: shared by the admin screen, the detector, the Node tests and the database's validator
 * (public.asm_template_validate keeps the same rules).
 */

/** Who fills a field. auto = filled from the enrolment record (never typed; read-only in the wizard). */
export const FIELD_ROLES = ["student", "trainer", "auto"] as const;
export type FieldRole = typeof FIELD_ROLES[number];

/**
 * What a field is.
 *   text        free text (an answer box, a feedback box, a form value)
 *   table_cell  one cell of a table the student fills in (row / column kept)
 *   yes_no      one option of a two-way choice (Satisfactory Yes / No, S / NS, Competent / NYC): fields of one `group`, `option` yes | no
 *   checkbox    a tick on its own (a reasonable adjustment strategy, "Initial / Updated")
 *   signature   a signature (one student signature fills every student signature field; the trainer signs separately)
 *   date        a date
 *   rating      one option of a rating row (Appendix B): fields of one `group`, `option` 1..5
 *   auto        a value from the record (`dataKey`)
 */
export const FIELD_KINDS = ["text", "table_cell", "yes_no", "checkbox", "signature", "date", "rating", "auto"] as const;
export type FieldKind = typeof FIELD_KINDS[number];

/** Values an auto field takes from the enrolment / attempt (filled when the PDF is shown or stamped). */
export const AUTO_KEYS = {
  student_name: "Student name",
  student_id: "Student ID",
  student_email: "Student email",
  trainer_name: "Trainer / assessor name",
  unit_code: "Unit code",
  unit_name: "Unit name",
  unit_code_name: "Unit code and name",
  qualification_code: "Qualification code",
  qualification_name: "Qualification name",
  start_date: "Start date (attempt started)",
  end_date: "End date (attempt submitted)",
  submission_date: "Date submitted",
  signoff_date: "Date signed off",
  acknowledged_date: "Date the student acknowledged the result",
  /** The date the signature beside it was signed (field.slot names the signature). */
  signed_date: "Date of the signature beside it",
  today: "Today's date",
  /** A tick box of the "Assessment Submission Method" list: ticked when its option is how the work was submitted (always "lms": online). */
  submission_method: "Submission method (Online via LMS ticked)",
} as const;
export type AutoKey = keyof typeof AUTO_KEYS;
/** How an attempt is submitted here: online through the LMS (the "Online submission via LMS" box is ticked). */
export const SUBMISSION_METHOD = "lms";
export const SUBMISSION_OPTIONS = ["hand", "email", "lms", "other"] as const;

/**
 * When a student field is filled. submit (default): in the submission wizard. acknowledge: after the results are released, when the
 * student signs to acknowledge them (the summary sheet's student row; asm_sign student_acknowledgement of that attempt).
 */
export const FIELD_STEPS = ["submit", "acknowledge"] as const;
export type FieldStep = typeof FIELD_STEPS[number];

export interface Rect { page: number; x: number; y: number; w: number; h: number }

export interface TemplateField extends Rect {
  /** Unique in the template (letters, digits, dot, dash, underscore). */
  id: string;
  role: FieldRole;
  kind: FieldKind;
  /** The question the field answers or marks (its printed number), or null (sheets, cover). */
  questionKey: string | null;
  /** What the field is for, in the PDF's words ("Student Signature", "Characteristics · Buckets"). */
  label: string;
  dataKey?: AutoKey | null;
  /** yes_no: "yes" | "no"; rating: "1".."5". */
  option?: string | null;
  /** The fields of one choice (yes_no / rating): exactly one is picked. */
  group?: string | null;
  /** Results / summary sheets: which attempt column (1..3) the field belongs to. */
  attempt?: number | null;
  table?: { row: number; col: number; rowLabel?: string; column?: string; group?: string; rowKey?: string; fixed?: boolean } | null;
  required?: boolean;
  /** Student signatures and their dates: "acknowledge" = signed after the results are released, not in the submission wizard. */
  step?: FieldStep | null;
  /**
   * Which signature a signature field (and the date beside it) shows: "decl:<task>" the student's declaration of a task, "pack" the
   * student's declaration of the whole pack (signed on the submit step), "ack" the student's acknowledgement of the attempt's result,
   * "signoff" the assessor's sign-off of the attempt.
   */
  slot?: string | null;
  /**
   * A row of a marking checklist or evidence list: "evidence" the trainer ticks, "performance" filled from the mark of its question
   * (questionKey), "written" ticked Yes when the student answered its question (questionKey), the trainer can change it.
   */
  checklist?: "evidence" | "performance" | "written" | null;
  /**
   * ASM-ANY-LAYOUT: how the field was found: "rules" (code), "ai" (the classifier, for areas the rules could not settle), "profile" (a
   * saved layout profile's correction), "admin" (added by hand). The SLIT design's detector leaves it out.
   */
  origin?: "rules" | "ai" | "profile" | "admin" | null;
  /** An AI-set field waits for the admin's Accept (or Reject, which removes it). */
  review?: "pending" | "accepted" | null;
}
export const SIGNATURE_SLOT = /^(decl:\d{1,2}|pack|ack|signoff)$/;

/** A question of the workbook: its printed number, where it is printed and where it is answered (pages it continues on included). */
export interface TemplateQuestion {
  /** The printed number as the key ("2.1.8", else the printed "Q3"): mappings and marks are keyed by it. */
  key: string;
  /** The workbook's running number ("Q8"). */
  seq: string;
  /** The question's name exactly as its header row prints it ("Q2.1.8", "References", else the running number "Q3"); never invented. */
  display?: string;
  /** The question's own text, as printed (for lists; the wizard shows the cropped PDF). */
  label: string;
  task: number | null;
  /** The header row: number, question text, Satisfactory Yes / No (what the wizard crops and shows). */
  header: Rect;
  /** The header without the trainer's Satisfactory Yes / No column: what the student's wizard shows. */
  prompt?: Rect;
  /** Where the answer goes, page by page. */
  areas: Rect[];
}

export const PAGE_KINDS = ["cover", "details", "info", "task_start", "question", "continuation", "marking_checklist", "evidence_checklist", "results_sheet", "declaration", "summary", "appendix_a", "appendix_b"] as const;
export type PageKind = typeof PAGE_KINDS[number];

export interface TemplatePage {
  page: number;
  kind: PageKind;
  /** trainer = never shown to the student (marking checklist, results sheet, summary sheet, Appendix A). */
  audience: "student" | "trainer";
  task: number | null;
}
export interface TemplateTask { number: string; title: string; firstPage: number; lastPage: number }

export interface PdfTemplate {
  version: 1;
  pdf: { path: string; sha256: string; pages: number; fileName?: string | null };
  pages: TemplatePage[];
  tasks: TemplateTask[];
  questions: TemplateQuestion[];
  fields: TemplateField[];
  /** Each task's student declaration as printed (its text is kept with the submission). */
  declarations?: { task: number | null; page: number; text: string; rect: Rect; kind?: "task" | "pack"; rects?: Rect[] }[];
  /** How the fields were found (detector version, when). */
  detected?: { by: string; at: string } | null;
}

/** Trainer-only page kinds: never shown to the student. */
/** The name a question is shown by: as printed on its header row. */
export const questionName = (q: Pick<TemplateQuestion, "display" | "seq">) => q.display || q.seq;

export const TRAINER_PAGES: ReadonlySet<PageKind> = new Set(["marking_checklist", "evidence_checklist", "results_sheet", "summary", "appendix_a"]);

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
/** The same rules the database checks (asm_template_validate): what a saved template must satisfy. */
export function templateProblems(t: PdfTemplate): string[] {
  const out: string[] = [];
  if (!t || t.version !== 1) return ["The template version is not supported."];
  if (!t.pdf?.path || !/^[a-f0-9]{64}$/.test(t.pdf.sha256 ?? "") || !Number.isInteger(t.pdf.pages) || t.pdf.pages < 1 || t.pdf.pages > 600) out.push("The template's PDF is missing or unreadable.");
  if (t.fields.length > 4000) out.push("Too many fields (4000 at most).");
  const ids = new Set<string>();
  const keys = new Set(t.questions.map((q) => q.key));
  if (keys.size !== t.questions.length) out.push("Two questions have the same number.");
  for (const q of t.questions) if (!ID_RE.test(q.key)) out.push(`Question "${q.key}": a number of letters, digits, dot, dash or underscore.`);
  for (const f of t.fields) {
    const where = `Field ${f.id} (page ${f.page})`;
    if (!ID_RE.test(f.id) || ids.has(f.id)) out.push(`${where}: its id is missing or used twice.`);
    ids.add(f.id);
    if (!Number.isInteger(f.page) || f.page < 1 || f.page > t.pdf.pages) out.push(`${where}: not on a page of the PDF.`);
    if (![f.x, f.y, f.w, f.h].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || f.x + f.w > 1.0001 || f.y + f.h > 1.0001 || f.w <= 0 || f.h <= 0) out.push(`${where}: outside the page.`);
    if (!(FIELD_ROLES as readonly string[]).includes(f.role)) out.push(`${where}: unknown role.`);
    if (!(FIELD_KINDS as readonly string[]).includes(f.kind)) out.push(`${where}: unknown kind.`);
    if ((f.role === "auto") !== (f.kind === "auto")) out.push(`${where}: an auto field is filled from the record (role and kind auto together).`);
    if (f.kind === "auto" && !(f.dataKey && f.dataKey in AUTO_KEYS)) out.push(`${where}: choose which record value fills it.`);
    if (f.questionKey && !keys.has(f.questionKey)) out.push(`${where}: its question ${f.questionKey} is not in the template.`);
    if ((f.kind === "yes_no" || f.kind === "rating") && (!f.group || !f.option)) out.push(`${where}: a choice needs its group and option.`);
    if (f.dataKey === "submission_method" && !(SUBMISSION_OPTIONS as readonly string[]).includes(f.option ?? "")) out.push(`${where}: say which submission method this box is.`);
    if (f.step && !(FIELD_STEPS as readonly string[]).includes(f.step)) out.push(`${where}: unknown step.`);
    if (f.step === "acknowledge" && !(f.role === "student" && f.kind === "signature") && f.dataKey !== "acknowledged_date" && f.dataKey !== "signed_date") out.push(`${where}: only the student's signature and its date are filled when the result is acknowledged.`);
    if (f.slot && !SIGNATURE_SLOT.test(f.slot)) out.push(`${where}: unknown signature.`);
    if (f.dataKey === "signed_date" && !f.slot) out.push(`${where}: say which signature this date belongs to.`);
  }
  return out;
}

/** Points (PDF, top-left origin) to a fractional rect. */
export const toFraction = (page: number, W: number, H: number, b: { x: number; y: number; w: number; h: number }): Rect => ({
  page, x: round(b.x / W), y: round(b.y / H), w: round(Math.min(b.w, W - b.x) / W), h: round(Math.min(b.h, H - b.y) / H),
});
const round = (v: number) => Math.max(0, Math.min(1, Math.round(v * 1e5) / 1e5));
