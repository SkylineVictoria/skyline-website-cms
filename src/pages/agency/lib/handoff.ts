import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/**
 * APPLICATION-STUDENT-SIGNS (owner, 2026-11-25): an agent fills an application, only the student signs (and a parent / guardian
 * when the student is under 18). The database decides who may edit and sign (migration 20261125190517); these are its calls.
 */
export type HandoffState = "with_agent" | "with_student" | "change_requested" | "waiting_guardian" | "submitted";

export interface Declaration { key: string; title: string; body: string; version: string; hash: string }
export interface HandoffEvent { event: string; at: string; actorRole: string; actorName: string; detail: Record<string, unknown> }
export interface Handoff {
  state: HandoffState | null;
  role: "student" | "agent";
  sentAt: string | null;
  openedAt: string | null;
  lastSavedAt: string | null;
  changeNote: string | null;
  changeRequestedAt: string | null;
  signedAt: string | null;
  submittedAt: string | null;
  takenBackAt: string | null;
  viewOnlyFields: string[];
  invite: { state: string; recipient: string; expiresAt: string; sentAt: string | null } | null;
  guardian: { state: string; name: string; relationship: string; email: string; sentAt: string | null; signedAt: string | null; expiresAt: string } | null;
  events: HandoffEvent[];
}
export interface HandoffChange { field: string; before: unknown; after: unknown; by: "student" }
export interface HandoffDiff { source: "submitted" | "current" | null; sentAt?: string; submittedAt?: string | null; changes: HandoffChange[] }

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const getDeclarations = () => rpc<Declaration[]>("portal_application_declarations");
export const getHandoff = (applicationId: string) => rpc<Handoff | null>("portal_application_handoff", { p_application: applicationId });
export const getHandoffDiff = (applicationId: string) => rpc<HandoffDiff>("portal_application_handoff_diff", { p_application: applicationId });
export const takeBackApplication = (applicationId: string) => rpc<{ state: HandoffState }>("portal_application_take_back", { p_application: applicationId });
export const requestApplicationChange = (applicationId: string, note: string) =>
  rpc<{ state: HandoffState }>("portal_application_request_change", { p_application: applicationId, p_note: note });

/** The ticked declarations as the server records them: { key: hash of the exact text shown }. */
export const declarationConsent = (ticked: Record<string, string>) => ({ declarations: ticked });

async function invokeInvite<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke("student-application-invite", { body });
  if (error) {
    const detail = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
    throw new Error(detail?.error ?? fallback);
  }
  return data as T;
}

/** The student (under 18) asks a parent / guardian to sign: they get an email link. */
export const sendGuardianRequest = (applicationId: string, guardian: { name: string; relationship: string; email: string; mobile: string }) =>
  invokeInvite<{ ok: true }>({ action: "guardian_send", applicationId, ...guardian }, "The email to your parent or guardian could not be sent. Try again.");

export interface GuardianView {
  studentName: string; reference: string | null; guardianName: string; relationship: string; email: string;
  verified: boolean; expiresAt: string; declarations: Declaration[];
}
/** The parent / guardian's page (no account: the link token and a one-time code). */
export const guardianOpen = (token: string) => invokeInvite<GuardianView>({ action: "guardian_open", token }, "This link is invalid, expired, or no longer available.");
export const guardianSendCode = (token: string) => invokeInvite<{ ok: true }>({ action: "guardian_code", token }, "A code could not be sent. Try again in a minute.");
export const guardianVerify = (token: string, code: string) => invokeInvite<{ ok: boolean; error?: string }>({ action: "guardian_verify", token, code }, "The code could not be checked.");
export const guardianSign = (token: string, declarations: Record<string, string>) =>
  invokeInvite<{ ok: true }>({ action: "guardian_sign", token, declarations }, "The signature could not be saved. Try again.");

/** Plain words for the timeline. */
export const HANDOFF_EVENT_LABEL: Record<string, string> = {
  sent: "Sent to the student", resent: "Link sent again", accepted: "Opened by the student", change_requested: "Change requested",
  taken_back: "Taken back by the agent", signed: "Signed by the student", guardian_sent: "Sent to the parent / guardian",
  guardian_verified: "Parent / guardian verified their email", guardian_signed: "Signed by the parent / guardian", submitted: "Submitted",
};

export const HANDOFF_STATE_LABEL: Record<HandoffState, string> = {
  with_agent: "With agent", with_student: "With student", change_requested: "Change requested",
  waiting_guardian: "Waiting for guardian", submitted: "Submitted",
};

/** The handoff of one application, reloaded on demand (null while loading or when nothing was ever sent). */
export function useHandoff(applicationId: string) {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try { setHandoff(await getHandoff(applicationId)); } catch { setHandoff(null); } finally { setLoaded(true); }
  }, [applicationId]);
  useEffect(() => { void reload(); }, [reload]);
  return { handoff, loaded, reload };
}


/** APPLICATION-INVITE-GUEST-START: what the invite link opens (an existing account signs in; a first-time email starts as a guest). */
export interface InviteCheck { valid: boolean; email?: string; account?: "login" | "new"; google?: boolean; studentName?: string }
export const inviteCheck = (token: string) => invokeInvite<InviteCheck>({ action: "invite_check", token }, "The invitation could not be checked. Try again.");
/** First time: a one-time sign-in for the invited email (the link proves it); the password is created when the student signs. */
export const inviteSession = (token: string) => invokeInvite<{ tokenHash: string; email: string }>({ action: "invite_session", token }, "Your application could not be opened. Try again.");
/** The signed-in student's account has a password or Google (needed before signing). */
export async function hasPortalLogin(): Promise<boolean> {
  const { data } = await supabase.auth.getUser();
  if (data.user?.identities?.some((identity) => identity.provider === "google")) return true;
  const { data: set, error } = await supabase.rpc("portal_my_password_set");
  return error ? true : set === true;
}

/** Saves the guest student's new password (before the signature, which needs it). */
export async function saveSignPassword(value: { needed: boolean; password: string }): Promise<void> {
  if (!value.needed) return;
  const { error } = await supabase.auth.updateUser({ password: value.password });
  if (error) throw new Error(error.message || "Your password could not be saved. Try another one.");
}
