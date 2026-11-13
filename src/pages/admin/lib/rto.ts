// Courses, units, fees, intakes (the master timetable), classrooms and batches. Every read and write goes through
// public.rto_admin, which checks the role (RTO Manager edits; Admin enrols; any CMS user reads and edits website settings).
import { supabase } from "@/pages/admin/lib/supabase";

export type FeeType = "application" | "registration" | "enrolment" | "material" | "tuition" | "other" | "oshc" | "initial_deposit";
export type GstTreatment = "gst_free" | "inclusive" | "exclusive";
export interface FeeItem { id?: string; type: FeeType; label: string; amountCents: number; includedInTotal?: boolean; refundable?: boolean; gstTreatment?: GstTreatment }
/** The default for a new line: every fee counts towards the total; an initial deposit is part of the tuition, so it does not. */
export const includedByDefault = (type: FeeType) => type !== "initial_deposit" && type !== "oshc";
/** Application and registration fees are non-refundable unless a line says otherwise ("(Non-Refundable)" is printed from this flag). */
export const refundableByDefault = (type: FeeType) => !["application", "registration", "enrolment"].includes(type);
export const isRefundable = (item: FeeItem) => item.refundable ?? refundableByDefault(item.type);
/** The offer letter's order: application, registration, material, tuition (then other), total; the deposit after it. */
export const FEE_RANK: Record<FeeType, number> = { application: 1, enrolment: 1, registration: 2, material: 3, tuition: 4, other: 5, oshc: 6, initial_deposit: 7 };
/** The amount a new line starts with: application $250, registration $0, initial deposit $1,500. */
export const DEFAULT_FEE_CENTS: Partial<Record<FeeType, number>> = { application: 25000, registration: 0, initial_deposit: 150000 };
/** The pre-paid limit the offer letter states; a larger deposit needs the student's election to pay more. */
export const DEPOSIT_LIMIT_CENTS = 150000;
/** GST: exclusive adds 10% to the line; inclusive already contains 1/11; GST-free adds nothing (same rule as the database). */
export const lineTotal = (item: FeeItem) => (item.gstTreatment === "exclusive" ? item.amountCents + Math.round(item.amountCents / 10) : item.amountCents);
export const lineGst = (item: FeeItem) => (item.gstTreatment === "exclusive" ? Math.round(item.amountCents / 10) : item.gstTreatment === "inclusive" ? Math.round(item.amountCents / 11) : 0);
export const isIncluded = (item: FeeItem) => item.includedInTotal ?? includedByDefault(item.type);
export interface RtoCourse {
  id: string; slug: string; code: string; name: string; variantLabel: string | null; label: string; depositCents: number | null; cricos: string; category: string; trainingPackage: string; duration: string; mode: string;
  campus: string | null; tgaUrl: string | null; isActive: boolean; status: string; featured: boolean; homepageCarousel: boolean; displayOrder: number;
  showFees: boolean; feeNote: string | null; seoTitle: string | null; seoDescription: string | null; image: string; shortDescription: string;
  totalCents: number; units: number; activeUnits: number; openIntakes: number; nextIntake: string | null;
}
export interface RtoUnit {
  id?: string; code: string; name: string; unitType: "core" | "elective"; category?: string; defaultWeeks: number; nominalHours: number | null;
  isActive: boolean; scheduled?: boolean;
}
export type IntakeStatus = "draft" | "open" | "full" | "closed";
export interface RtoIntake {
  id: string; courseId: string; courseCode: string; courseName: string; name: string; customName: string | null; startDate: string; endDate: string | null;
  campus: string | null; capacity: number | null; status: IntakeStatus; enrolled: number; batches: number; units: number; trainers: string[]; hasFeeOverride: boolean;
  /** Teaching hours (sum of the units'), the course's registered duration ("52 Weeks") and the batches, for the intake cards. */
  hours?: number | null; courseDuration?: string | null; batchList?: IntakeBatchChip[];
}
export interface IntakeBatchChip { id: string; name: string; capacity: number | null; isActive: boolean; enrolled: number; days: string[] }
export interface BatchStudent { enrolmentId: string; id: string; name: string; email: string; type: EnrolmentType; status: string; enrolledOn: string }
export type EnrolmentType = "CoE" | "VoE" | "Domestic";
export interface RtoBatch {
  id: string; intakeId: string; intakeName?: string; name: string; classroomId: string | null; classroom: string | null; classDays: string[];
  startTime: string | null; endTime: string | null; capacity: number | null; isActive: boolean;
  trainers: { id: string; name: string }[]; students: BatchStudent[];
  /** The intake's unit dates, or the batch's own where staff changed them (overridden). */
  schedule?: BatchScheduleRow[];
  /** The batch's weekly classes, and the days it runs (its unit dates). */
  sessions?: BatchSession[]; startDate?: string; endDate?: string;
}
export type SessionType = "theory" | "practical" | "assessment";
export type Slot = "morning" | "afternoon" | "evening";
export interface BatchSession {
  id?: string; weekday: number; slot?: Slot; startTime: string; endTime: string; type: SessionType; roomId: string | null;
  room?: string | null; locationId?: string | null; location?: string | null;
}
export interface Room { id: string; name: string; capacity: number | null; isActive: boolean }
export interface LocationRooms { id: string | null; name: string; address: string | null; kind: "theory" | "practical"; rooms: Room[] }
/** Another batch in the same room at an overlapping time on the same weekday, while both run. */
export interface Clash {
  roomId: string; room: string; weekday: number; startTime: string; endTime: string;
  otherBatchId: string; otherBatch: string; otherCourseCode: string; otherIntakeId: string; otherStart: string; otherEnd: string;
}
/** A course's class timing from the master timetable (one per batch name: G1, G2 ...). */
export interface CourseTiming { id: string; name: string; trainerName: string | null; trainerStaffId: string | null; sessions: BatchSession[] }
export interface SiblingBatch { id: string; name: string; capacity: number | null; enrolled: number }
export interface BatchPageData { batch: RtoBatch; intake: RtoIntake; siblings: SiblingBatch[]; clashes: Clash[]; rtoManager: boolean; admin: boolean }
export interface BoardSession {
  id: string; batchId: string; batch: string; intakeId: string; intakeName: string; courseId: string; courseCode: string; weekday: number; slot: Slot;
  startTime: string; endTime: string; type: SessionType; roomId: string | null; batchStart: string; batchEnd: string; trainers: string[];
}
export interface RoomsBoardData { locations: LocationRooms[]; sessions: BoardSession[]; batches: { id: string; name: string; courseCode: string; intakeId: string; intakeName: string }[] }
export interface AcademicBreak { label: string; startDate: string; endDate: string }
export interface BatchScheduleRow { intakeUnitId: string; code: string; name: string; startDate: string; endDate: string; intakeStartDate: string; intakeEndDate: string; overridden: boolean }
export interface ScheduleRow { id: string; unitId: string; code: string; name: string; unitType: string; startDate: string; endDate: string; hours: number | null }
export interface CourseDetail { course: RtoCourse; units: RtoUnit[]; fees: FeeItem[]; intakes: RtoIntake[]; batches: RtoBatch[] }
export interface IntakeDetail { intake: RtoIntake; schedule: ScheduleRow[]; batches: RtoBatch[]; fees: FeeItem[]; courseFees: FeeItem[] }
export interface Classroom { id: string; name: string; campus: string | null; capacity: number | null; isActive: boolean }
export interface StaffOption { id: string; name: string; email: string }
export interface StudentOption { id: string; name: string; email: string; linked?: boolean }
export interface StudyRow {
  enrolmentId: string; type: EnrolmentType; status: string; enrolledOn: string; batchId: string; batch: string; intakeId: string; intake: string;
  startDate: string; endDate: string | null; courseId: string; course: string; courseCode: string;
}
export interface StudyOption { courseId: string; course: string; courseCode: string; linked?: boolean; intakes: { id: string; name: string; status: IntakeStatus; batches: { id: string; name: string }[] }[] }

/** The guided course flow's own actions (duplicate an intake, batch unit date overrides): public.rto_course_flow. */
/** The course wizard's steps and their addresses (/admin/courses/:id/:step). */
export type CourseStep = "details" | "timetable" | "fees" | "intakes" | "website";
export const stepPath = (courseId: string, step: CourseStep) => `/admin/courses/${encodeURIComponent(courseId)}/${step}`;

export async function rtoFlow<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const { data: out, error } = await supabase.rpc("rto_course_flow", { p_action: action, p_data: data });
  if (error) throw new Error(error.message);
  return out as T;
}

export async function rto<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const { data: out, error } = await supabase.rpc("rto_admin", { p_action: action, p_data: data });
  if (error) throw new Error(error.message);
  return out as T;
}

/** The fee lines staff can add, in the letter's order (OSHC is not a fee line; "enrolment" is the application fee). */
export const FEE_TYPES: { id: FeeType; label: string }[] = [
  { id: "application", label: "Application fee" }, { id: "registration", label: "Registration fee" }, { id: "material", label: "Material fee" },
  { id: "tuition", label: "Tuition fee" }, { id: "other", label: "Other" }, { id: "initial_deposit", label: "Initial deposit" },
];
/** The one total rule (same as public.course_fee_total_cents): the sum of the items included in the total. */
export const feeTotal = (items: FeeItem[]) => items.filter(isIncluded).reduce((sum, i) => sum + (lineTotal(i) || 0), 0);
export const feeGst = (items: FeeItem[]) => items.filter(isIncluded).reduce((sum, i) => sum + (lineGst(i) || 0), 0);
export const depositOf = (items: FeeItem[]) => items.filter((i) => i.type === "initial_deposit").reduce((sum, i) => sum + (Number(i.amountCents) || 0), 0);
export const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "—" : `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "1234.5" or "$1,234.50" to cents; null when it is not a non-negative amount. */
export function toCents(value: string): number | null {
  const clean = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const STATUS_TONE: Record<IntakeStatus, "primary" | "accent" | "warn" | "muted"> = { open: "primary", full: "accent", draft: "warn", closed: "muted" };

const day = 86_400_000;
export const parseDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoDay(parseDay(iso) + n * day);
export const daysBetween = (a: string, b: string) => Math.round((parseDay(b) - parseDay(a)) / day);
export const shortDate = (iso: string | null) =>
  iso ? new Date(parseDay(iso)).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
export function todayIso() {
  const now = new Date();
  return isoDay(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}
/** upcoming / running / finished, from today's date. */
export function phase(i: Pick<RtoIntake, "startDate" | "endDate">): "upcoming" | "running" | "finished" {
  const today = todayIso();
  if (i.startDate > today) return "upcoming";
  if (i.endDate && i.endDate < today) return "finished";
  return "running";
}
/** 0..1 of the way through the intake today. */
export function progress(i: Pick<RtoIntake, "startDate" | "endDate">) {
  if (!i.endDate) return 0;
  const total = daysBetween(i.startDate, i.endDate);
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, daysBetween(i.startDate, todayIso()) / total));
}
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");

// ---- class timing, rooms and the academic calendar
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
/** The three parts of the day and the times a new class in each starts with (editable). */
export const SLOTS: { id: Slot; label: string; start: string; end: string }[] = [
  { id: "morning", label: "Morning", start: "09:00", end: "13:00" },
  { id: "afternoon", label: "Afternoon", start: "13:00", end: "17:00" },
  { id: "evening", label: "Evening", start: "17:00", end: "21:00" },
];
/** Morning / afternoon / evening from the start time (the same rule as public.rto_slot). */
export const slotOf = (start: string): Slot => (start < "12:00" ? "morning" : start < "16:00" ? "afternoon" : "evening");
export const SESSION_TYPES: { id: SessionType; label: string }[] = [
  { id: "theory", label: "Theory" }, { id: "practical", label: "Practical" }, { id: "assessment", label: "Assessment" },
];
export const sessionTypeLabel = (t: SessionType) => SESSION_TYPES.find((x) => x.id === t)?.label ?? t;
/** "16:30" -> "4:30 PM". */
export function clock(t: string | null | undefined) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
/** "12:00–4:00 PM", or "9:00 AM – 1:00 PM" across midday. */
export function timeRange(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return clock(start || end);
  const a = clock(start), b = clock(end);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a} – ${b}`;
}
/** "Room 8.2 is already used by BSB80120 G2 on Monday 12:00–4:00 PM". */
export const clashText = (c: Clash) => `${c.room} is already used by ${c.otherCourseCode} ${c.otherBatch} on ${WEEKDAYS[c.weekday - 1]} ${timeRange(c.otherStart, c.otherEnd)}`;
/** One line per kind of class and room: "Theory · Mon, Tue · 12:00 PM – 8:30 PM · King Street campus, Room 8.2". */
export function timingLines(sessions: BatchSession[]) {
  const groups = new Map<string, BatchSession[]>();
  for (const s of sessions) { const k = `${s.type}|${s.roomId ?? ""}`; groups.set(k, [...(groups.get(k) ?? []), s]); }
  return [...groups.values()].map((list) => {
    const days = [...new Set(list.map((s) => s.weekday))].sort((a, b) => a - b).map((d) => DAYS[d - 1]).join(", ");
    const start = list.reduce((m, s) => (s.startTime < m ? s.startTime : m), list[0].startTime);
    const end = list.reduce((m, s) => (s.endTime > m ? s.endTime : m), list[0].endTime);
    const where = list[0].room ? [list[0].location, list[0].room].filter(Boolean).join(", ") : "No room yet";
    return { type: list[0].type, days, time: `${clock(start)} – ${clock(end)}`, where, text: `${sessionTypeLabel(list[0].type)} · ${days} · ${clock(start)} – ${clock(end)} · ${where}` };
  });
}
/** The batch card's short line: "Mon Tue Wed · 12:00–8:30 PM · Room 8.2". */
export function timingShort(b: Pick<RtoBatch, "sessions" | "classDays" | "startTime" | "endTime" | "classroom">) {
  const s = b.sessions ?? [];
  if (!s.length) return [b.classDays.join(" "), b.startTime && timeRange(b.startTime, b.endTime), b.classroom].filter(Boolean).join(" · ");
  const days = [...new Set(s.map((x) => x.weekday))].sort((a, c) => a - c).map((d) => DAYS[d - 1]).join(" ");
  const start = s.reduce((m, x) => (x.startTime < m ? x.startTime : m), s[0].startTime), end = s.reduce((m, x) => (x.endTime > m ? x.endTime : m), s[0].endTime);
  const rooms = [...new Set(s.map((x) => x.room).filter(Boolean))].join(", ");
  return [days, timeRange(start, end), rooms].filter(Boolean).join(" · ");
}
/** Term breaks (the academic calendar); public holidays come from HR. */
export async function listBreaks(): Promise<AcademicBreak[]> {
  const { data, error } = await supabase.from("academic_breaks").select("label, start_date, end_date").order("start_date");
  if (error) throw new Error(error.message);
  return (data ?? []).map((b: { label: string; start_date: string; end_date: string }) => ({ label: b.label, startDate: b.start_date, endDate: b.end_date }));
}
/** "52 Weeks" -> 52 (the course's registered duration), else null. */
export const registeredWeeks = (duration: string | null | undefined) => { const m = /(\d+)\s*weeks?/i.exec(duration ?? ""); return m ? Number(m[1]) : null; };
export const weeksOf = (start: string, end: string) => Math.max(1, Math.round((daysBetween(start, end) + 1) / 7));
/** "2027-05-03" -> "May 2027". */
export const monthYear = (iso: string) => new Date(parseDay(iso)).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
/** Monday of the week the day is in. */
export const mondayOf = (iso: string) => addDays(iso, -((new Date(parseDay(iso)).getUTCDay() + 6) % 7));
/** The next free G-number in a list of batch names. */
export const nextBatchName = (names: string[]) => `G${Math.max(0, ...names.map((n) => Number(/^G(\d+)$/i.exec(n.trim())?.[1] ?? 0))) + 1}`;
/** Typing in a text field, a select or an editor: keyboard shortcuts stay quiet. */
export const typingIn = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) || e.metaKey || e.ctrlKey || e.altKey;
};

/** Running and upcoming intakes first (soonest first), then finished ones (latest first). */
export function sortIntakes(list: RtoIntake[]) {
  const rank = { running: 0, upcoming: 1, finished: 2 } as const;
  return [...list].sort((a, b) => {
    const pa = phase(a), pb = phase(b);
    if (pa !== pb) return rank[pa] - rank[pb];
    return pa === "finished" ? b.startDate.localeCompare(a.startDate) : a.startDate.localeCompare(b.startDate);
  });
}
