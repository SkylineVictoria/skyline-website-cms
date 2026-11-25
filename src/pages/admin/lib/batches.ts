// LMS-BATCHES (2026-11-25): class batches B1 / B2 / B3 inside an intake (public.rto_batches). Batches control delivery and attendance;
// the intake's Master (CoE / VoE) controls unit dates and assessment windows.
import { supabase } from "@/pages/admin/lib/supabase";
import { friendlyDbError } from "@/pages/admin/lib/rto";

export interface BatchClassTime { id?: string; weekday: number; start: string; end: string; sessionType: "theory" | "practical" | "assessment"; roomId: string | null; trainerId: string | null }
export interface IntakeBatch {
  id: string; intakeId: string; code: string; name: string | null; roomId: string | null; room: string | null; capacity: number | null;
  defaultTrainerId: string | null; trainer: string | null; sort: number; archivedAt: string | null;
  students: number; upcoming: number; weeklyHours: number; classTimes: BatchClassTime[];
}
export interface BatchSessionRow {
  id: string; batchId: string; batch: string; date: string; start: string; end: string; sessionType: string; status: string;
  unitCode: string | null; unitName: string | null; room: string | null; trainer: string | null; delivery: string | null;
}
export interface BatchMember {
  enrolmentId: string; studentId: string; name: string; status: string; courseStart: string | null; courseEnd: string | null;
  batches: { batchId: string; unitId: string | null; unitCode: string | null }[];
}
export interface GenerateResult { created?: number; short?: { code: string; hoursShort: number }[]; clashes?: unknown[]; endDate?: string | null }

export async function rtoBatches<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const { data: out, error } = await supabase.rpc("rto_batches", { p_action: action, p_data: data });
  if (error) throw new Error(friendlyDbError(error.message));
  return out as T;
}

export const listBatches = (intakeId: string, includeArchived = false) => rtoBatches<IntakeBatch[]>("list", { intakeId, includeArchived });
export const batchSessions = (q: { intakeId?: string; batchId?: string; from: string; to: string }) => rtoBatches<BatchSessionRow[]>("sessions", q);
export const batchMembers = (intakeId: string) => rtoBatches<BatchMember[]>("members", { intakeId });
export const saveBatch = (b: { id?: string; intakeId?: string; code?: string; name?: string; roomId?: string | null; capacity?: number | null; defaultTrainerId?: string | null }) =>
  rtoBatches<{ id: string }>("save", b);
export const archiveBatch = (id: string, reason: string) => rtoBatches<{ archived: boolean }>("archive", { id, reason });
export const saveBatchTimes = (batchId: string, times: BatchClassTime[]) =>
  rtoBatches<{ times: number; classes: GenerateResult }>("times_save", { batchId, times });
export const assignBatches = (enrolmentId: string, batches: { batchId: string; unitId?: string | null }[], reason?: string) =>
  rtoBatches<{ ok: boolean }>("assign", { enrolmentId, batches, reason });

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const batchLabel = (b: Pick<IntakeBatch, "code" | "name">) => (b.name ? `${b.code} · ${b.name}` : b.code);
