/**
 * The three assessment RPCs and the calendar, as the CMS, the staff workspace and the student portal call them. Every role check is
 * in the database (DECISIONS.md D-04); a thrown error carries the database's message.
 */
import { supabase } from "@/pages/admin/lib/supabase";
import { institutionTimeZone } from "@/lib/timeZone";
import type { AttemptHistory } from "./resultsSheet";

async function call<T>(fn: "asm_admin" | "asm_trainer" | "asm_student", action: string, data: Record<string, unknown>): Promise<T> {
  const { data: out, error } = await supabase.rpc(fn, { p_action: action, p_data: data });
  if (error) throw new Error(error.message);
  return out as T;
}
export const asmAdmin = <T,>(action: string, data: Record<string, unknown> = {}) => call<T>("asm_admin", action, data);
export const asmTrainer = <T,>(action: string, data: Record<string, unknown> = {}) => call<T>("asm_trainer", action, data);
export const asmStudent = <T,>(action: string, data: Record<string, unknown> = {}) => call<T>("asm_student", action, data);

export interface CalendarEvent {
  kind: "assessment_due" | "assessment_practical" | "assessment_observation" | "assessment_other" | "class";
  title: string; startsAt: string; endsAt?: string | null; room?: string | null; trainer?: string | null; notes?: string;
  assignmentId?: string; assessmentTitle?: string; batchId?: string; batchName?: string; sessionType?: string;
}
export async function asmCalendar(from: string, to: string, batchId?: string | null): Promise<CalendarEvent[]> {
  const { data, error } = await supabase.rpc("asm_calendar", { p_from: from, p_to: to, p_batch: batchId ?? null });
  if (error) throw new Error(error.message);
  return (data as CalendarEvent[] | null) ?? [];
}

/**
 * ASM-WORKBOOK: every attempt of the attempt's student on its assignment, with assessor names and cover details (results sheet, PDF
 * export). null while the database does not have asm_attempt_history yet (migration 20261123234517 not released): callers fall back
 * to the attempts they already have.
 */
export async function attemptHistory(attemptId: string): Promise<AttemptHistory | null> {
  const { data, error } = await supabase.rpc("asm_attempt_history", { p_attempt: attemptId });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") return null;
    throw new Error(error.message);
  }
  const d = (data ?? {}) as Partial<AttemptHistory>;
  return { student: d.student ?? null, trainers: d.trainers ?? [], assessment: d.assessment ?? null, attempts: d.attempts ?? [], complete: true };
}

export const EVIDENCE_BUCKET = "assessment-evidence";
/** Uploads one evidence file under the attempt (the bucket's policy allows the student's own draft attempt, or an assessor's folder). */
export async function uploadEvidence(attemptId: string, questionId: string, file: File, byAssessor = false): Promise<{ path: string; sha256: string | null }> {
  const safe = file.name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(-120) || "file";
  const path = `${attemptId}/${byAssessor ? "assessor" : questionId}/${Date.now().toString(36)}-${safe}`;
  const { error } = await supabase.storage.from(EVIDENCE_BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (error) throw new Error(error.message);
  let sha256: string | null = null;
  try { const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""); } catch { sha256 = null; }
  return { path, sha256 };
}
export async function evidenceUrl(path: string, seconds = 60): Promise<string> {
  const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? "The file could not be opened.");
  return data.signedUrl;
}
export async function removeEvidenceObject(path: string): Promise<void> {
  await supabase.storage.from(EVIDENCE_BUCKET).remove([path]);
}

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: institutionTimeZone() }) : "";
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: institutionTimeZone() }) : "";
/** A datetime-local value (Melbourne wall time) from an ISO instant, and back. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: institutionTimeZone(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}
export function fromLocalInput(local: string): string | null {
  if (!local) return null;
  // Melbourne offset for that wall time (AEST +10 / AEDT +11), found by probing.
  const guess = new Date(`${local}:00+10:00`);
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: institutionTimeZone(), timeZoneName: "shortOffset" }).formatToParts(guess);
  const off = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+10";
  const m = off.match(/([+-]\d+)/); const hours = m ? Number(m[1]) : 10;
  return new Date(`${local}:00${hours >= 0 ? "+" : "-"}${String(Math.abs(hours)).padStart(2, "0")}:00`).toISOString();
}
export const STATE_LABEL: Record<string, string> = { draft: "In progress", submitted: "Submitted", marking: "Being marked", returned: "Returned", final: "Final", void: "Void" };
export const OUTCOME_LABEL: Record<string, string> = { S: "Satisfactory", NYS: "Not Yet Satisfactory", C: "Competent", NYC: "Not Yet Competent" };

/* ASM-AI-IMPORT stage 3: signatures on an attempt (migration 20261125120517) and a person's saved signature. */
export type SignatureKind = "student_declaration" | "assessor_signoff" | "student_acknowledgement";
export type SignatureMethod = "drawn" | "uploaded" | "saved" | "typed";
export interface AttemptSignature { id: string; attemptId: string; attemptNo?: number; kind: SignatureKind; signerRole: "student" | "assessor"; signerName: string; method: SignatureMethod; signaturePng: string | null; statement: string; signedAt: string; signerUser: string }
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message || "The request failed.");
  return data as T;
}
export const asmSign = (attemptId: string, kind: SignatureKind, method: SignatureMethod, png: string | null, statement = "") =>
  rpc<AttemptSignature>("asm_sign", { p_attempt: attemptId, p_kind: kind, p_method: method, p_png: png, p_statement: statement });
/** Every signature of this student on this assignment (all attempts); [] while the database does not have them yet. */
export async function asmSignatures(attemptId: string): Promise<AttemptSignature[]> {
  try { return await rpc<AttemptSignature[]>("asm_signatures", { p_attempt: attemptId }); } catch { return []; }
}
export interface SavedSignature { signaturePng: string | null; name: string | null; updatedAt: string | null }
export async function mySignature(): Promise<SavedSignature> {
  try { return await rpc<SavedSignature>("asm_my_signature", {}); } catch { return { signaturePng: null, name: null, updatedAt: null }; }
}
export const saveMySignature = (png: string | null, method: "drawn" | "uploaded" = "drawn") => rpc<SavedSignature>("asm_my_signature_save", { p_png: png, p_method: method });

export interface SignatureValue { method: SignatureMethod; png: string | null; /** Keep it as the person's saved signature once signed. */ keep?: boolean }

/** After a successful signature: keeps a new drawing / picture as the person's saved signature when they ticked it. */
export async function keepSignature(v: SignatureValue | null): Promise<void> {
  if (v?.keep && v.png && (v.method === "drawn" || v.method === "uploaded")) { try { await saveMySignature(v.png, v.method); } catch { /* the signature itself is recorded; saving it for next time is optional */ } }
}

