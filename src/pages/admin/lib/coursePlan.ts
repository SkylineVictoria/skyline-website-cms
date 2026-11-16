// Will a weekly timing cover a course's SLIT hours, and when is the last class? The same rules as the class generator
// (rto_class_sessions_generate): every weekly class is held on each teaching day (not in a term break, not a confirmed public
// holiday), weekends included; hours of a class type the week has no slot for are taught in the first type it has
// (theory, then practical, then assessment).
import { listHolidays } from "@/lib/hrmsApi";
import { addDays, listBreaks, loadUnitHours, rto, shownHours, type CourseDetail, type SessionType, type UnitHours } from "@/pages/admin/lib/rto";

export type HoursByType = Record<SessionType, number>;
export interface CourseNeed extends HoursByType { total: number; units: number }
export interface WeeklySlot { weekday: number; startTime: string; endTime: string; type: SessionType }
export interface PlanResult {
  weekly: HoursByType; weeklyTotal: number;
  /** The date of the last class, or null when the timing has no classes or cannot finish in four years. */
  lastDate: string | null;
  /** Class types the week has no slot for, and the type that teaches their hours instead. */
  folded: { from: SessionType; into: SessionType }[];
}

const TYPES: SessionType[] = ["theory", "practical", "assessment"];
const hoursOf = (s: { startTime: string; endTime: string }) => {
  const [a, b] = [s.startTime, s.endTime].map((t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; });
  return Math.max(0, (b - a) / 60);
};

/** The course's active units' hours: the accepted SLIT split, else 40 / 40 / 20 of the nominal hours. */
export async function loadCourseNeed(courseId: string): Promise<CourseNeed> {
  const [detail, saved] = await Promise.all([rto<CourseDetail>("course_get", { courseId }), loadUnitHours(courseId).catch((): UnitHours[] => [])]);
  const byId = new Map<string, UnitHours>(saved.map((h) => [h.unitId, h] as const));
  const need: CourseNeed = { theory: 0, practical: 0, assessment: 0, total: 0, units: 0 };
  for (const u of detail.units.filter((x) => x.isActive)) {
    const h = shownHours(u.id ? byId.get(u.id) : undefined, u.nominalHours);
    if (!h || h.slitHours <= 0) continue;
    need.theory += h.theoryHours; need.practical += h.practicalHours; need.assessment += h.assessmentHours; need.total += h.slitHours; need.units += 1;
  }
  return need;
}

/** Days with no classes from `from` for three years: term breaks and confirmed, non-optional public holidays. */
export async function loadClosedDays(from: string, courseId?: string | null): Promise<(day: string) => boolean> {
  const [breaks, holidays] = await Promise.all([listBreaks(courseId).catch(() => []), listHolidays(from, addDays(from, 1095)).catch(() => [])]);
  const off = new Set(holidays.filter((h) => h.status === "confirmed" && !h.isOptional).map((h) => h.date));
  return (day) => off.has(day) || breaks.some((b) => day >= b.startDate && day <= b.endDate);
}

export function weeklyHours(slots: WeeklySlot[]): HoursByType {
  const w: HoursByType = { theory: 0, practical: 0, assessment: 0 };
  for (const s of slots) w[s.type] += hoursOf(s);
  return w;
}

export function planCourse(start: string, slots: WeeklySlot[], need: HoursByType, closed: (day: string) => boolean): PlanResult {
  const weekly = weeklyHours(slots);
  const weeklyTotal = weekly.theory + weekly.practical + weekly.assessment;
  const has = (t: SessionType) => slots.some((s) => s.type === t);
  const fallback: SessionType = has("theory") ? "theory" : has("practical") ? "practical" : "assessment";
  const left: HoursByType = { ...need };
  const folded: PlanResult["folded"] = [];
  for (const t of TYPES) {
    if (has(t) || left[t] <= 0 || !slots.length) continue;
    const into: SessionType = t === "theory" ? (fallback === "practical" ? "practical" : "assessment") : fallback === "theory" ? "theory" : t === "practical" ? "assessment" : "practical";
    left[into] += left[t]; left[t] = 0; folded.push({ from: t, into });
  }
  if (!slots.length) return { weekly, weeklyTotal, lastDate: null, folded };
  const byDay = new Map<number, WeeklySlot[]>();
  for (const s of slots) byDay.set(s.weekday, [...(byDay.get(s.weekday) ?? []), s].sort((a, b) => a.startTime.localeCompare(b.startTime)));
  let day = start, last: string | null = null;
  for (let guard = 0; guard <= 1500; guard++) {
    if (left.theory <= 0 && left.practical <= 0 && left.assessment <= 0) return { weekly, weeklyTotal, lastDate: last, folded };
    if (!closed(day)) {
      const weekday = ((new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;
      for (const s of byDay.get(weekday) ?? []) {
        if (left[s.type] <= 0) continue;
        left[s.type] -= hoursOf(s); last = day;
      }
    }
    day = addDays(day, 1);
  }
  return { weekly, weeklyTotal, lastDate: null, folded };
}

/** Hours a week needed to finish by `end`: the hours over the weeks that have teaching days. */
export function weeklyHoursNeeded(start: string, end: string, total: number, closed: (day: string) => boolean) {
  let open = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (!closed(d)) open += 1;
  return open ? Math.ceil(total / (open / 7)) : null;
}

export const typeLabel = (t: SessionType) => t === "theory" ? "theory" : t === "practical" ? "practical" : "assessment";
export const splitText = (h: HoursByType) => TYPES.filter((t) => h[t] > 0).map((t) => `${Math.round(h[t] * 10) / 10} ${typeLabel(t)}`).join(" · ");
