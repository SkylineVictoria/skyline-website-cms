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
  licences: Array<{ sku: string; available: number; total: number; student: boolean }>;
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
