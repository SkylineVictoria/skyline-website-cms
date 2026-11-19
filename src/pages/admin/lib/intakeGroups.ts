// Intake groups (INTAKE-GROUPS): one per intake. Microsoft 365 group, WhatsApp group link, text list (public.intake_group).
import { supabase } from "@/pages/admin/lib/supabase";
import { friendlyDbError } from "@/pages/admin/lib/rto";

export interface GroupRow {
  intakeId: string; title: string; courseId: string; courseName: string; startDate: string; endDate: string | null; status: "active" | "closed";
  m365Status: "pending" | "ready" | "not_configured" | "failed"; m365Address: string | null; m365Error: string | null; mailNickname: string;
  whatsappLink: string | null; smsEnabled: boolean; welcomeEnabled: boolean;
  students: number; trainers: number; m365Members: number; whatsappJoined: number; textable: number;
  lastMessage: { at: string; by: string; text: string } | null;
}
export interface GroupMember {
  kind: "student" | "staff"; id: string; name: string | null; email: string | null; phone: string | null;
  m365Status: "pending" | "member" | "no_account" | "removed" | "failed"; m365Error: string | null;
  whatsappInvitedAt: string | null; whatsappJoined: boolean; smsOptOut: boolean; addedAt: string;
}
export interface GroupMessage {
  id: string; kind: "message" | "welcome" | "invite"; at: string; by: string | null; channels: string[]; subject: string | null; body: string;
  emailSent: number; emailFailed: number; emailQueued: number; smsQueued: number; smsNotConnected: number; skipped: number;
}
export interface GroupDetail extends GroupRow { canManage: boolean; members: GroupMember[]; history: GroupMessage[]; smsConnected: boolean }

export async function intakeGroup<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const { data: out, error } = await supabase.rpc("intake_group", { p_action: action, p_data: data });
  if (error) throw new Error(friendlyDbError(error.message));
  return out as T;
}

/** Creates / updates the Microsoft 365 group now (otherwise it happens within 15 minutes). */
export async function syncMicrosoftGroup(intakeId: string): Promise<{ synced?: number; notConfigured?: number; error?: string }> {
  const { data, error } = await supabase.functions.invoke("intake-groups", { body: { intakeId } });
  if (error) {
    let message = error.message;
    try { const body = await (error as { context?: Response }).context?.json(); if (body?.error) message = body.error; } catch { /* keep message */ }
    throw new Error(message);
  }
  return data ?? {};
}
