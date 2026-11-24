import { useCallback, useEffect, useSyncExternalStore } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/*
 * Microsoft 365 status (owner 2026-11-20): one check, one result, shown by Integrations > Connections > Microsoft 365 and by every
 * Administration > Email Management screen. The student-office365 function runs it (m365_status: real Microsoft Graph calls, app-only,
 * nothing changed) and sets the Connections entry's status from the same result.
 */

export type CheckState = "ok" | "missing" | "failed" | "not_checked";
export interface Microsoft365Status {
  configured: boolean; connected: boolean; ready: boolean;
  tenant: { id: string; name: string } | null; clientIdEnd: string | null;
  checks: { connection: CheckState; consent: CheckState; domain: CheckState; licence: CheckState };
  consent: { granted: string[]; missing: string[]; welcomeEmail: boolean };
  domains: Array<{ name: string; verified: boolean; found: boolean }>;
  licences: Array<{ sku: string; available: number; total: number; student: boolean; staff?: boolean }>;
  /** The login-email sender (EF_MICROSOFT365_WELCOME_SENDER): found in the tenant? null = not set or not checked. */
  sender?: { address: string; found: boolean; enabled: boolean; exchangeLicence: boolean; plans: string[] } | null;
  problems: string[]; checkedAt: string;
}
export type PersonType = "student" | "employee" | "trainer" | "agent";
export interface EmailPerson { id: string; name: string; email: string | null; status: string | null; mailbox: string | null; mailboxStatus: string | null }

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("student-office365", { body });
  if (error) {
    let message = error.message;
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) { try { const parsed = (await context.clone().json()) as { error?: string }; if (parsed?.error) message = parsed.error; } catch { /* generic */ } }
    throw new Error(message || "Microsoft 365 could not be checked.");
  }
  return data as T;
}
export const fetchMicrosoft365Status = () => call<Microsoft365Status>({ action: "m365_status" });
/** Create Email (2026-11-20): Student, Employee or Trainer (agents get no mailbox). */
export type MailboxKind = "student" | "employee" | "trainer" | "agent";
/** What happened to a person's account, step by step (resumable). */
export interface Office365Steps { accountCreatedAt: string | null; licenceAssignedAt: string | null; groupsAddedAt: string | null; groupsError: string | null; welcomeSentAt: string | null; welcomeError: string | null }
export interface Office365Existing { id: string; upn: string; mail: string | null; displayName: string; enabled: boolean; match: "linked" | "email" | "username" | "name" }
export interface Office365Lookup {
  person: { name: string; email: string | null }; plan: { domain: string; sku: string; licenceName: string };
  licence: { total: number; available: number } | null;
  account: null | { email: string; status: string; linked?: boolean; msUserId?: string | null; lastError?: string | null; licenceSku?: string | null; steps?: Office365Steps };
  existing: Office365Existing[]; address: string | null; blocked: string | null; domains?: string[]; groups?: number;
}
export type Office365CreateReply = { ok?: true; email?: string; welcomeSent?: boolean; warning?: string; dryRun?: true; sku?: string; welcomeTo?: string };
/** A refusal that carries the matches (already has / possible match), so the screen can offer to link. */
export class Office365Refusal extends Error {
  readonly code: string | null; readonly existing: Office365Existing[];
  constructor(message: string, code: string | null, existing: Office365Existing[]) { super(message); this.code = code; this.existing = existing; }
}
async function callWithBody<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("student-office365", { body });
  if (error) {
    let parsed: { error?: string; code?: string; existing?: Office365Existing[] } = {};
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) { try { parsed = (await context.clone().json()) as typeof parsed; } catch { /* generic */ } }
    throw new Office365Refusal(parsed.error || error.message || "That could not be done.", parsed.code ?? null, parsed.existing ?? []);
  }
  return data as T;
}
export const lookupOffice365 = (personType: MailboxKind, personId: string) => callWithBody<Office365Lookup>({ action: "lookup", personType, personId });
/** applicationId: made from an application's "Mark as enrolled" dialog; student-office365 logs the outcome on that application. */
export const createOffice365 = (personType: MailboxKind, personId: string, opts: { dryRun?: boolean; differentPerson?: boolean; domain?: string; username?: string; applicationId?: string } = {}) =>
  callWithBody<Office365CreateReply>({ action: "create", personType, personId, ...opts });
/** Create Email's live check (read-only): is username@domain free in Microsoft 365 (users, shared mailboxes, groups)? */
export const checkOffice365Address = (personType: MailboxKind, username: string, domain: string) =>
  callWithBody<{ available: boolean; address?: string; code?: string; reason?: string }>({ action: "check_address", personType, username, domain });
/**
 * The username (part before the @) rules; the same as usernameProblem in supabase/functions/_shared/office365-provision.ts, which
 * checks again on create. null = fine.
 */
export function usernameProblem(raw: string): string | null {
  const u = raw.trim().toLowerCase();
  if (!u) return "Enter a username.";
  if (u.length > 64) return "Use at most 64 characters.";
  if (/\s/.test(u)) return "No spaces.";
  if (!/^[a-z0-9._-]+$/.test(u)) return "Use only letters, numbers, dots, hyphens and underscores.";
  if (u.startsWith(".") || u.endsWith(".")) return "It cannot start or end with a dot.";
  if (u.includes("..")) return "No two dots in a row.";
  return null;
}
/** Resend login email: a new temporary password (change at next sign-in), any missing licence / group step finished; never a second account. */
export const resendOffice365 = (personType: MailboxKind, personId: string, opts: { dryRun?: boolean } = {}) =>
  callWithBody<{ ok?: true; email: string; welcomeSent?: boolean; welcomeTo?: string; dryRun?: true }>({ action: "resend", personType, personId, ...opts });
export const linkOffice365 = (personType: MailboxKind, personId: string, msUserId: string) => callWithBody<{ ok: true; email: string }>({ action: "link", personType, personId, msUserId });
/** Account directory (2026-11-21): one Microsoft 365 user as student-office365 `directory` gives it. */
export type DirectoryType = "student" | "employee" | "trainer" | "agent" | "not_linked" | "shared";
export interface DirectoryRow {
  id: string; name: string; upn: string; mail: string | null; enabled: boolean; type: DirectoryType;
  person: { kind: "student" | "employee" | "trainer" | "agent"; id: string; name: string } | null;
  licences: Array<{ sku: string; name: string; skyline: boolean }>; exchange: boolean; admin: boolean | null; self: boolean; createdAt: string | null;
  canRemove: boolean; removeBlocked: string | null; assign: { sku: string; name: string } | null;
  /** Block / allow sign-in: allowed unless signinBlocked says why not (own account, admin role, shared mailbox). */
  canBlock: boolean; canAllow: boolean; signinBlocked: string | null;
}
export interface DirectoryPage {
  rows: DirectoryRow[]; total: number; page: number; pageSize: number; pages: number;
  counts: { accounts: number; activeMailboxes: number; byType: Record<DirectoryType, number> };
  adminRolesReadable: boolean; adminRolePermission: string;
}
export const fetchDirectory = (q: { q?: string; type?: string; status?: string; page?: number; fresh?: boolean }) => callWithBody<DirectoryPage>({ action: "directory", ...q });
export const removeLicences = (userIds: string[]) =>
  callWithBody<{ results: Array<{ id: string; upn: string; ok: boolean; error?: string; removed?: string[]; row?: DirectoryRow }>; removed: number; refused: number }>({ action: "licence_remove", userIds });
export const assignLicence = (userId: string) => callWithBody<{ ok: true; upn: string; licence: string; row?: DirectoryRow }>({ action: "licence_assign", userId });
/** Block (enabled false) or allow (true) sign-in; every account answered on its own, success only once Microsoft shows the change. */
export const setSignin = (userIds: string[], enabled: boolean) =>
  callWithBody<{ results: Array<{ id: string; upn: string; ok: boolean; error?: string; row?: DirectoryRow }>; changed: number; refused: number }>({ action: "signin_set", userIds, enabled });
export interface EmailAuditRow { id: number; at: string; actor: string; action: "licence_assigned" | "licence_removed" | "signin_blocked" | "signin_allowed"; account: string; sku: string | null; licence: string | null; result: "ok" | "refused" | "failed"; detail: Record<string, unknown> }
export async function fetchEmailAudit(): Promise<EmailAuditRow[]> {
  const { data, error } = await supabase.rpc("email_account_audit_list", { p_limit: 200 });
  if (error) throw new Error(error.message || "The audit log could not be loaded.");
  return (data as EmailAuditRow[] | null) ?? [];
}
/** Email Management > Email Accounts: students with an Enrolled application and no active mailbox (email_mgmt_enrolled_without_mailbox). */
export interface EnrolledWithoutMailbox { studentId: string; name: string; email: string | null; applicationId: string; reference: string | null; enrolledAt: string | null;
  mailboxStatus: string | null; mailbox: string | null; mailboxError: string | null; last: { outcome: "skipped" | "failed"; at: string; by: string | null; reason: string | null; code: string | null } | null }
export async function fetchEnrolledWithoutMailbox(): Promise<EnrolledWithoutMailbox[]> {
  const { data, error } = await supabase.rpc("email_mgmt_enrolled_without_mailbox");
  if (error) throw new Error(error.message || "The list could not be loaded.");
  return (data as EnrolledWithoutMailbox[] | null) ?? [];
}
/** The application's audit log: the mailbox was skipped (created / failed are logged by student-office365). */
export async function logApplicationMailbox(applicationId: string, outcome: "skipped" | "failed", detail: { reason?: string; code?: string } = {}): Promise<void> {
  const { error } = await supabase.rpc("application_mailbox_log", { p_application: applicationId, p_outcome: outcome, p_detail: detail });
  if (error) throw new Error(error.message || "The audit log could not be written.");
}
export const fetchEmailPeople =(personType: PersonType, q = "") => call<{ people: EmailPerson[] }>({ action: "people", personType, q }).then((r) => r.people ?? []);

/** The checklist both screens show, in the order to fix things. */
export function m365Checklist(s: Microsoft365Status | null): Array<{ key: string; label: string; state: CheckState; detail: string }> {
  const slit = s?.domains.find((d) => d.name === "slit.edu.au");
  const student = s?.licences.find((l) => l.student);
  return [
    { key: "connection", label: "Microsoft 365 connection", state: s?.checks.connection ?? "not_checked",
      detail: !s ? "Checking…" : s.connected ? `Signed in to ${s.tenant?.name ?? "the tenant"} as the Skyline app${s.clientIdEnd ? ` (…${s.clientIdEnd})` : ""}` : s.configured ? "The app could not sign in" : "Not set up" },
    { key: "domain", label: "Verified slit.edu.au domain", state: s?.checks.domain ?? "not_checked",
      detail: !s?.connected ? "Needs the connection" : s.domains.map((d) => `${d.name}: ${d.verified ? "verified" : d.found ? "not verified" : "not added"}`).join(" · ") || (slit ? "" : "Not checked") },
    { key: "consent", label: "Admin consent", state: s?.checks.consent ?? "not_checked",
      detail: !s?.connected ? "Needs the connection" : s.consent.missing.length ? `Missing: ${s.consent.missing.join(", ")}` : `Granted: ${s.consent.granted.join(", ")}` },
    { key: "licence", label: "Available licence", state: s?.checks.licence ?? "not_checked",
      detail: !s?.connected ? "Needs the connection" : student ? `${student.sku}: ${student.available} of ${student.total} free` : s.licences.length ? "No student licence in the tenant" : "No licences found" },
    { key: "sender", label: "Login email sender", state: senderState(s),
      detail: !s?.connected ? "Needs the connection" : !s.sender ? "Not set (EF_MICROSOFT365_WELCOME_SENDER)"
        : !s.sender.found ? `${s.sender.address} does not exist in Microsoft 365`
        : s.sender.exchangeLicence ? `${s.sender.address}: mailbox found` : !s.sender.enabled ? `${s.sender.address}: shared mailbox found` : `${s.sender.address}: found, but no Exchange licence` },
  ];
}
/** The sender's check: ok when the mailbox exists (a licensed user, or a shared mailbox with sign-in blocked). */
function senderState(s: Microsoft365Status | null): CheckState {
  if (!s?.connected) return "not_checked";
  if (!s.sender) return "missing";
  if (!s.sender.found) return "failed";
  return s.sender.exchangeLicence || !s.sender.enabled ? "ok" : "missing";
}
/** Create Email and the student page refuse to create while the sender mailbox is missing (nothing could be emailed). */
export function senderBlock(s: Microsoft365Status | null): string | null {
  return s?.connected && s.sender && !s.sender.found ? `Login emails are sent from ${s.sender.address}, which does not exist in Microsoft 365. Create it (a shared mailbox is enough), then press Check again.` : null;
}
export const m365Label = (s: Microsoft365Status | null, loading: boolean) => loading && !s ? "Checking…" : !s ? "Not checked" : s.ready ? "Connected" : s.connected ? "Needs attention" : "Not connected";

// One result per browser session, shared by every screen (so the two places can never disagree).
let current: { status: Microsoft365Status | null; loading: boolean; error: string } = { status: null, loading: false, error: "" };
const listeners = new Set<() => void>();
const set = (next: Partial<typeof current>) => { current = { ...current, ...next }; listeners.forEach((l) => l()); };
let inflight: Promise<void> | null = null;
export function refreshMicrosoft365(): Promise<void> {
  if (inflight) return inflight;
  set({ loading: true, error: "" });
  inflight = fetchMicrosoft365Status().then((status) => set({ status, loading: false }), (e: unknown) => set({ loading: false, error: e instanceof Error ? e.message : "Microsoft 365 could not be checked." }))
    .finally(() => { inflight = null; });
  return inflight;
}
/** The shared status; checks once when first used (or when `auto` and nothing is known yet). */
export function useMicrosoft365(auto = true) {
  const snap = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current);
  useEffect(() => { if (auto && !current.status && !current.loading && !current.error) void refreshMicrosoft365(); }, [auto]);
  const refresh = useCallback(() => refreshMicrosoft365(), []);
  return { ...snap, refresh };
}
