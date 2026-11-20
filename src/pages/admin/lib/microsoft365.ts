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
export const createOffice365 = (personType: MailboxKind, personId: string, opts: { dryRun?: boolean; differentPerson?: boolean; domain?: string; username?: string } = {}) =>
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
export const fetchEmailPeople = (personType: PersonType, q = "") => call<{ people: EmailPerson[] }>({ action: "people", personType, q }).then((r) => r.people ?? []);

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
  ];
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
