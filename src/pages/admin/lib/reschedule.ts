// Class rescheduling (CLASS-RESCHEDULE): no class is dropped. Rules set by admins decide what the system tries when a class
// can't run (public.class_reschedule).
import { supabase } from "@/pages/admin/lib/supabase";
import { friendlyDbError } from "@/pages/admin/lib/rto";

export type StepType = "other_trainer" | "other_room" | "same_day_other_time" | "another_day" | "join_other_intake" | "spread" | "online";
export interface Step {
  type: StepType; on: boolean;
  onlyCourseTrainers?: boolean; minSeats?: "group" | "any";
  earliest?: string; latest?: string; days?: number[]; withinDays?: number;
  maxExtraSeats?: number; maxExtraMinutes?: number; maxClasses?: number; addAt?: "end" | "start";
  international?: boolean;
}
export interface Reason { key: string; label: string; steps: Step[] }
export interface Rules {
  general: { allowCancel: boolean; who: "rto_manager" | "rto_manager_and_trainers"; mode: "suggest" | "apply"; unitFinishWithWaiting: boolean };
  notify: { students: boolean; trainers: boolean; email: boolean; sms: boolean; subject: string; body: string; waitingSubject: string; waitingBody: string };
  reasons: Reason[];
}
export interface RulesData {
  canEdit: boolean; default: Rules; factory: Rules;
  courses: { courseId: string; code: string; name: string; rules: Rules | null; own: boolean }[];
}
export interface SessionInfo {
  id: string; intakeId: string; date: string; start: string; end: string; roomId: string | null; roomName: string | null;
  trainerId: string | null; trainerName: string | null; unitCode: string | null; unitName: string | null;
  status: "scheduled" | "cancelled"; delivery: "face_to_face" | "online"; needsReschedule: boolean; reason: string | null; note: string | null;
  courseId: string; courseCode: string | null; intakeName: string; unitEnds: string | null;
}
export interface Candidate {
  step: StepType | "manual"; date: string; start: string; end: string; roomId: string | null; trainerId: string | null;
  roomName?: string | null; trainerName?: string | null; joinSessionId?: string; joinGroup?: string; freeSeats?: number | null;
  minutesEach?: number; classes?: { id: string; date: string; start: string; end: string; newStart: string; newEnd: string }[];
}
export interface Suggestion {
  candidates: Candidate[]; tried: { step: StepType; found: number; why: string | null }[]; mode: "suggest" | "apply"; groupSize: number; session: SessionInfo;
}
export interface Change {
  kind: "moved" | "waiting" | "trainer" | "room" | "joined" | "spread" | "online" | "extended";
  reason: string | null; note: string | null; step: string | null;
  old: { date?: string; start?: string; end?: string } | null; new: Record<string, unknown> | null; notified: number; by: string | null; at: string;
}
export interface History { session: SessionInfo; reasons: { key: string; label: string }[]; canReschedule: boolean; history: Change[] }

export const STEP_LABEL: Record<StepType, string> = {
  other_trainer: "Same time, another trainer",
  other_room: "Same time, another room",
  same_day_other_time: "Same day, another time",
  another_day: "Another day",
  join_other_intake: "Join another intake's class",
  spread: "Spread over next classes",
  online: "Online at the same time",
};
export const STEP_HELP: Record<StepType, string> = {
  other_trainer: "Keeps the time and room; another trainer teaches.",
  other_room: "Keeps the time and trainer; a free room with enough seats.",
  same_day_other_time: "Same day, a free time between the earliest and latest times.",
  another_day: "A free day before the unit ends, on the allowed weekdays.",
  join_other_intake: "The group joins another intake's class of the same unit, if it has free seats.",
  spread: "The hours are added to the next classes of this unit.",
  online: "The class runs online at the same time, with no room.",
};
export const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function reschedule<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const { data: out, error } = await supabase.rpc("class_reschedule", { p_action: action, p_data: data });
  if (error) throw new Error(/class_reschedule|schema cache|does not exist/i.test(error.message)
    ? "Class rescheduling needs the database update CLASS-RESCHEDULE (migration 20261120211741) first." : friendlyDbError(error.message));
  return out as T;
}

export const hhmm = (t: string | null | undefined) => (t ?? "").slice(0, 5);
export const dayText = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const whenText = (date: string, start: string, end: string) => `${dayText(date)} ${hhmm(start)}–${hhmm(end)}`;

export function candidateTitle(c: Candidate): string {
  if (c.step === "spread") return `${c.minutesEach} extra minutes on ${c.classes?.length ?? 0} class${c.classes?.length === 1 ? "" : "es"}`;
  return whenText(c.date, c.start, c.end);
}
export function candidateLine(c: Candidate): string {
  if (c.step === "spread") return (c.classes ?? []).map((x) => whenText(x.date, x.newStart, x.newEnd)).join(" · ");
  const parts = [c.step === "online" ? "Online" : c.roomName ?? "No room", c.trainerName ?? "No trainer"];
  if (c.step === "join_other_intake") parts.push(`with ${c.joinGroup ?? "another intake"}${c.freeSeats != null ? ` (${c.freeSeats} seats free)` : ""}`);
  return parts.join(" · ");
}
