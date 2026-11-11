import { supabase } from "@/pages/admin/lib/supabase";

/** A student's Office 365 mailbox, created by the student-office365 Edge Function. The temporary password never comes back. */
export type StudentOffice365Account = {
  email: string;
  status: "creating" | "active" | "failed";
  lastError: string | null;
  message: string | null;
  welcomeSentAt: string | null;
  createdAt: string;
};
export type StudentOffice365State = { configured: boolean; account: StudentOffice365Account | null };
export type StudentOffice365Created = { ok: true; email: string; welcomeSent: boolean; warning?: string };

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("student-office365", { body });
  if (error) {
    let message = error.message;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try { const parsed = (await context.clone().json()) as { error?: string }; if (parsed?.error) message = parsed.error; } catch { /* keep the generic message */ }
    }
    throw new Error(message || "That could not be done.");
  }
  return data as T;
}

export const studentOffice365State = (studentId: string) => call<StudentOffice365State>({ action: "state", studentId });
/** Creates the mailbox, or retries a failed attempt (new temporary password, licence, login email). */
export const createStudentOffice365 = (studentId: string) => call<StudentOffice365Created>({ action: "create", studentId });
