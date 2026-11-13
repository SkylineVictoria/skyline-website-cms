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
}
export interface BatchStudent { enrolmentId: string; id: string; name: string; email: string; type: EnrolmentType; status: string; enrolledOn: string }
export type EnrolmentType = "CoE" | "VoE" | "Domestic";
export interface RtoBatch {
  id: string; intakeId: string; intakeName?: string; name: string; classroomId: string | null; classroom: string | null; classDays: string[];
  startTime: string | null; endTime: string | null; capacity: number | null; isActive: boolean;
  trainers: { id: string; name: string }[]; students: BatchStudent[];
}
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
