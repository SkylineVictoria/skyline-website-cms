// aXcelerate import from the browser (AXCELERATE-IMPORT, owner 2026-11-28). The browser never talks to aXcelerate and never sees
// the tokens: runs go through the Edge Function axcelerate-import; everything else is a database function that checks the
// "aXcelerate import" permission itself. The import controls are shown only to holders of that permission.
import { useEffect, useState } from 'react';
import { supabase } from '@/pages/admin/lib/supabase';
import { currentTenantSite } from '@/lib/tenantSite';

export type ImportEntity = 'locations' | 'courses' | 'trainers' | 'classes' | 'breaks' | 'agents' | 'students';
/** Every entity, in dependency order (what a record needs comes first): the dashboard's "Import everything". */
export const ALL_ENTITIES: ImportEntity[] = ['locations', 'courses', 'trainers', 'classes', 'breaks', 'agents', 'students'];
export const ENTITY_LABEL: Record<string, string> = {
  locations: 'Campuses', courses: 'Courses', agents: 'Agents', trainers: 'Trainers', classes: 'Classes', breaks: 'Breaks', students: 'Students',
  location: 'Locations', course: 'Courses', unit: 'Units', trainer: 'Trainers', class: 'Classes', class_unit: 'Class units', break: 'Breaks', student: 'Students', agent: 'Agents', agency: 'Agent businesses', qualification: 'Qualifications', unit_result: 'Unit results', master: 'CoE master timetables',
};
/** One student's outcome (AXCELERATE-STUDENTS). */
export type StudentResult = {
  contactId: string; action: string; name?: string; id?: string | null; warnings?: string[]; message?: string;
  agent?: { name?: string; action: string; student?: string; business?: string; message?: string };
  courses?: { name: string; status: string }[];
  qualifications?: { name: string; action: string; status?: string; message?: string; warnings?: string[]; units?: { code: string; outcome?: string; action: string; message?: string }[] }[];
};
/** The owner's wording for each outcome. */
export const STUDENT_OUTCOME: Record<string, string> = {
  created: 'Student imported', updated: 'Student updated', unchanged: 'Already up to date',
  duplicate: 'Needs review: possible duplicate', conflict: 'Needs review: changed in both systems',
  skipped: 'Not imported: this student was deleted in Skyline (undo in the Import centre)', error: 'Not imported',
};
export type ImportRun = {
  id: string; mode: 'page' | 'everything' | 'nightly'; entities: string[]; status: 'running' | 'done' | 'failed' | 'cancelled';
  counts: Record<string, Record<string, number>>;
  cursor: { stage?: string; notes?: string[]; scope?: 'one' | 'all'; results?: StudentResult[]; contacts?: string[]; contactIndex?: number; agentResult?: StudentResult['agent'] };
  started_at: string; finished_at: string | null;
  last_error: string | null; startedByName?: string | null; openErrors?: number; cancel_requested?: boolean;
};
export type ImportOverview = {
  connection: { id: string; status: string; lastSuccessAt: string | null; saved: boolean } | null;
  runs: ImportRun[];
  errors: { id: string; run_id: string; entity: string; axcelerate_id: string | null; label: string | null; message: string; created_at: string }[];
  conflicts: { id: string; field: string; skyline: unknown; axcelerate: unknown; entity: string; axcelerateId: string; targetTable: string; targetId: string; label: string; createdAt: string }[];
  reviews?: ImportReview[];
  studentsImportedAt?: string | null;
  skipped: { connection_id: string; entity: string; axcelerate_id: string; label: string | null; reason: string; skipped_at: string }[];
  linked: Record<string, number>;
  audit: { at: string; who: string; action: string; detail: Record<string, unknown> }[];
  permission: { userId: string; name: string; email: string; granted: boolean }[];
};
export type ImportReview = {
  id: string; entity: 'student'; axcelerateId: string; label: string | null; email: string | null; mobile: string | null; dob: string | null; createdAt: string;
  candidates: { id: string; name: string; email: string | null; phone: string | null; dob: string | null; studentNumber: string | null; reasons: string[]; linked: boolean }[];
};
export type StudentSearchResult = { contactId: string; name: string; email: string; mobile: string; dob: string; studentId: string | null };
export type Survey = { at: string; courses: number; workshops: number | null; deliveryLocations: number | null; customFields: { label: string; variable: string; type: string; linkTo: string }[] | null };

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('axcelerate-import', { body: { ...body, tenantId: currentTenantSite()?.tenantId ?? null } });
  if (error) {
    let message = error.message;
    if (error.context instanceof Response) { try { message = (await error.context.clone().json()).error || message; } catch { /* keep */ } }
    throw new Error(message);
  }
  if (data?.error && !data?.run) throw new Error(data.error);
  return data as T;
}

let allowedCache: Promise<boolean> | null = null;
/** Whether the signed-in user holds the aXcelerate import permission (asked once per page load). */
export function importAllowed(): Promise<boolean> {
  allowedCache ??= rpc<boolean>('axcelerate_import_allowed').then((v) => v === true).catch(() => false);
  return allowedCache;
}
export function useImportAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => { let live = true; void importAllowed().then((v) => { if (live) setAllowed(v); }); return () => { live = false; }; }, []);
  return allowed;
}

/**
 * Starts an import (or retries one) and keeps it going until it finishes: each call works for up to about 100 seconds, then
 * the run is continued. `onProgress` gets the run after every call.
 */
export async function runAxcelerateImport(start: { entities: ImportEntity[]; mode: 'page' | 'everything'; students?: { scope: 'one'; contactId: string } | { scope: 'all'; changedOnly: boolean };
  courses?: { courseId: string }; agents?: { contactId: string } } | { retry: string }, onProgress?: (run: ImportRun) => void): Promise<ImportRun> {
  let answer = await invoke<{ run: ImportRun; error?: string }>('retry' in start ? { action: 'retry', runId: start.retry } : { action: 'start', ...start });
  onProgress?.(answer.run);
  for (let guard = 0; answer.run?.status === 'running' && guard < 200; guard++) {
    answer = await invoke<{ run: ImportRun; error?: string }>({ action: 'continue', runId: answer.run.id });
    onProgress?.(answer.run);
  }
  if (answer.run?.status === 'failed') throw new Error(answer.run.last_error || answer.error || 'The import stopped.');
  return answer.run;
}
export const continueAxcelerateImport = async (runId: string, onProgress?: (run: ImportRun) => void) => {
  let answer = await invoke<{ run: ImportRun }>({ action: 'continue', runId });
  onProgress?.(answer.run);
  for (let guard = 0; answer.run?.status === 'running' && guard < 200; guard++) { answer = await invoke<{ run: ImportRun }>({ action: 'continue', runId }); onProgress?.(answer.run); }
  return answer.run;
};
export const surveyAxcelerate = () => invoke<{ survey: Survey }>({ action: 'survey' }).then((r) => r.survey);
/** aXcelerate contacts matching a name, email or mobile (at least 3 letters), with the Skyline student when already imported. */
export const searchAxcelerateStudents = (query: string) => invoke<{ results: StudentSearchResult[] }>({ action: 'search_students', query }).then((r) => r.results ?? []);
export type CourseSearchResult = { courseId: string; code: string; name: string };
export const searchAxcelerateCourses = (query: string) => invoke<{ results: CourseSearchResult[] }>({ action: 'search_courses', query }).then((r) => r.results ?? []);
export const searchAxcelerateAgents = (query: string) => invoke<{ results: StudentSearchResult[] }>({ action: 'search_agents', query }).then((r) => r.results ?? []);
/** A possible duplicate: link to one of the students listed, create a new student, or dismiss. */
export const decideReview = (reviewId: string, action: 'link' | 'create' | 'dismiss', studentId?: string) =>
  rpc<{ action: string; id: string | null; warnings?: string[] }>('axcelerate_review_decide', { p_review: reviewId, p_action: action, p_student: studentId ?? null });
export const importOverview = () => rpc<ImportOverview>('axcelerate_import_overview', { p_connection: null });
export const cancelImport = (runId: string) => rpc('axcelerate_run_cancel', { p_run: runId });
export const decideConflict = (conflictId: string, takeAxcelerate: boolean) => rpc('axcelerate_conflict_decide', { p_conflict: conflictId, p_take_axcelerate: takeAxcelerate });
export const undoSkip = (connectionId: string, entity: string, axcelerateId: string) => rpc('axcelerate_skip_undo', { p_connection: connectionId, p_entity: entity, p_ax: axcelerateId });
export const resolveImportError = (errorId: string) => rpc('axcelerate_error_resolve', { p_error: errorId });
export const setImportPermission = (userId: string, grant: boolean) => rpc('cms_permission_set', { p_user: userId, p_permission: 'axcelerate.import', p_grant: grant });
export const recordBadge = (table: string, id: string) => rpc<{ importedAt: string; lastImportedAt: string; editedInSkylineAt: string | null; axcelerateId?: string; entity?: string } | null>('axcelerate_record_badge', { p_table: table, p_id: id }).catch(() => null);

/** "12 created, 3 updated, 1 error" for one entity's counts. */
export function countsText(c: Record<string, number> | undefined): string {
  if (!c) return 'nothing';
  const order = ['created', 'updated', 'linked', 'unchanged', 'moved', 'duplicate', 'conflict', 'kept', 'open', 'skipped', 'error'];
  const label: Record<string, string> = { created: 'created', updated: 'updated', linked: 'matched', unchanged: 'unchanged', kept: 'kept from Skyline', open: 'no result yet', duplicate: 'possible duplicate (needs review)', conflict: 'kept (edited in Skyline)', skipped: 'skipped', error: 'error' };
  const parts = order.filter((k) => c[k]).map((k) => `${c[k]} ${label[k]}${k === 'error' && c[k] > 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'nothing';
}
