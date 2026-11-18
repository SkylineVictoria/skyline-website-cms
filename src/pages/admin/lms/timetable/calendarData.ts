// Data for LMS > Timetable views (migration 20261119061533_admin_class_calendar; Admins and RTO Managers).
import { supabase } from "@/pages/admin/lib/supabase";

export interface CalClass {
  id: string; date: string; start: string; end: string; type: string; status: string;
  batchId: string; batch: string; intakeId: string; intakeStart: string; intakeEnd: string | null;
  courseId: string; courseCode: string; courseName: string; unitId: string | null; unitCode: string | null; unitName: string | null;
  roomId: string | null; room: string | null; campus: string | null; trainers: { id: string; name: string }[];
  students: number; attendance: string | null;
}
export interface CalFilter { courseId?: string; intakeId?: string; batchId?: string; staffId?: string; roomId?: string; studentId?: string }
export interface CalPeople {
  courses: { id: string; code: string; name: string }[];
  intakes: { id: string; courseId: string; startDate: string; endDate: string | null; status: string }[];
  batches: { id: string; name: string; intakeId: string }[];
  trainers: { id: string; name: string }[];
  rooms: { id: string; name: string; campus: string | null }[];
  students: { id: string; name: string; email: string | null }[];
}
export interface ClassStudent { id: string; name: string; email: string | null; joined: string | null; carryOver: boolean; prereqFirst: boolean; status: string; mark: string | null }
export interface TimelineIntake {
  id: string; courseId: string; courseCode: string; courseName: string; startDate: string; endDate: string; status: string;
  studyLoad: string | null; autoCreated: boolean; batches: number; students: number; units: { code: string; name: string; start: string; end: string }[];
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
export const loadCalendar = (from: string, to: string, filter: CalFilter = {}) =>
  call<CalClass[]>("admin_class_calendar", { p_from: from, p_to: to, p_filter: Object.fromEntries(Object.entries(filter).filter(([, v]) => v)) });
export const loadPeople = () => call<CalPeople>("admin_calendar_people", {});
export const loadClassStudents = (id: string) => call<ClassStudent[]>("admin_class_session_students", { p_session: id });
export const loadTimeline = (from: string, to: string) => call<TimelineIntake[]>("admin_intakes_timeline", { p_from: from, p_to: to });

/** A steady colour per course (the same course is the same colour in every view). */
const PALETTE = [
  "bg-sky-100 text-sky-900 border-sky-300", "bg-amber-100 text-amber-900 border-amber-300", "bg-emerald-100 text-emerald-900 border-emerald-300",
  "bg-violet-100 text-violet-900 border-violet-300", "bg-rose-100 text-rose-900 border-rose-300", "bg-teal-100 text-teal-900 border-teal-300",
  "bg-orange-100 text-orange-900 border-orange-300", "bg-indigo-100 text-indigo-900 border-indigo-300",
];
const BARS = ["bg-sky-400", "bg-amber-400", "bg-emerald-400", "bg-violet-400", "bg-rose-400", "bg-teal-400", "bg-orange-400", "bg-indigo-400"];
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
export const courseColour = (courseId: string) => PALETTE[hash(courseId) % PALETTE.length];
export const courseBar = (courseId: string) => BARS[hash(courseId) % BARS.length];

/** Two classes of the same trainer (or room) on the same day whose times overlap. */
export const overlaps = (a: CalClass, b: CalClass) => a.id !== b.id && a.date === b.date && a.start < b.end && b.start < a.end;
export const trainerNames = (c: CalClass) => (c.trainers.length ? c.trainers.map((t) => t.name).join(", ") : "No trainer");
