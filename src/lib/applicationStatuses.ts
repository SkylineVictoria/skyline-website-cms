import { useEffect, useState } from "react";

/**
 * Application statuses, their labels, order and colours; what can be done from each status, by which roles; the reasons offered for
 * Reject / Withdraw / Action required. All from the database (application_statuses, application_status_transitions, status_reasons,
 * read through application_status_workflow()), cached once per page and refreshed live when an admin changes them (realtime, and at
 * once after a save on Settings › Application statuses). Nothing about statuses is written into the frontend; the database enforces
 * every move (change_application_status).
 */
export type StatusTone = "neutral" | "info" | "warning" | "success" | "danger" | "muted";
export interface StatusDefinition {
  value: string; label: string; sort: number; tone: StatusTone; hint: string; editable: boolean; legacy: boolean;
  /** #rrggbb from the settings page. */ color: string; final: boolean; active: boolean;
}
export type ActionKind = "status" | "enrol" | "offer_letter" | "coe" | "reminder" | "resend_offer" | "accept_offer" | "resubmit" | "submit";
export interface StatusAction {
  from: string; action: string; to: string | null; actor: "staff" | "applicant"; label: string; kind: ActionKind;
  note: "none" | "optional" | "required"; tone: "neutral" | "primary" | "danger"; sort: number;
  /** null when the backend does not say (an older one): not filtered here, the backend still checks. */
  primary: boolean; automatic: boolean; requiresReason: boolean; roles: string[] | null; icon: string;
}
export interface StatusReason { id: string; status: string; label: string; other: boolean }
/** roles: the signed-in user's role names; null when the backend does not report them (then only the backend filters by role). */
export interface Workflow { statuses: StatusDefinition[]; actions: StatusAction[]; reasons: StatusReason[]; roles: string[] | null }

export const EMPTY_WORKFLOW: Workflow = { statuses: [], actions: [], reasons: [], roles: [] };

/** How each tone looks where no colour is set (the database picks the tone, the theme the colours). */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-background-100 text-foreground-700",
  info: "bg-secondary-100 text-secondary-900",
  warning: "bg-amber-100 text-amber-900",
  success: "bg-emerald-50 text-emerald-800",
  danger: "bg-red-50 text-red-700",
  muted: "bg-background-200 text-foreground-600",
};

/** A badge's colours from one #rrggbb: a light tint behind, the colour darkened for the text (readable on white and in dark mode). */
export function badgeColors(hex: string): { backgroundColor: string; color: string; borderColor: string } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const dark = (c: number) => Math.round(c * 0.62);
  return { backgroundColor: `rgba(${r}, ${g}, ${b}, 0.12)`, color: `rgb(${dark(r)}, ${dark(g)}, ${dark(b)})`, borderColor: `rgba(${r}, ${g}, ${b}, 0.28)` };
}

const str = (v: unknown, fallback = "") => (v === null || v === undefined ? fallback : String(v));
/** The workflow as the RPC returns it, checked field by field. */
export function parseWorkflow(raw: unknown): Workflow {
  const r = (raw ?? {}) as { statuses?: unknown; actions?: unknown; reasons?: unknown; roles?: unknown };
  const statuses = (Array.isArray(r.statuses) ? r.statuses : []).map((item) => {
    const s = (item ?? {}) as Record<string, unknown>;
    return { value: str(s.value), label: str(s.label ?? s.value), sort: Number(s.sort ?? 0), tone: str(s.tone, "neutral") as StatusTone,
      hint: str(s.hint), editable: Boolean(s.editable), legacy: Boolean(s.legacy), color: str(s.color, "#64748b"), final: Boolean(s.final), active: s.active !== false };
  }).filter((s) => s.value).sort((a, b) => a.sort - b.sort);
  const actions = (Array.isArray(r.actions) ? r.actions : []).map((item) => {
    const x = (item ?? {}) as Record<string, unknown>;
    return { from: str(x.from), action: str(x.action), to: x.to ? str(x.to) : null, actor: x.actor === "applicant" ? "applicant" : "staff",
      label: str(x.label ?? x.action), kind: str(x.kind, "status") as ActionKind, note: (["optional", "required"].includes(str(x.note)) ? x.note : "none") as StatusAction["note"],
      tone: (["primary", "danger"].includes(str(x.tone)) ? x.tone : "neutral") as StatusAction["tone"], sort: Number(x.sort ?? 0),
      primary: Boolean(x.primary), automatic: Boolean(x.automatic) || x.actor === "applicant", requiresReason: Boolean(x.requiresReason),
      roles: Array.isArray(x.roles) ? x.roles.map((v) => str(v)) : null, icon: str(x.icon) } satisfies StatusAction;
  }).filter((x) => x.from && x.action);
  const reasons = (Array.isArray(r.reasons) ? r.reasons : []).map((item) => {
    const x = (item ?? {}) as Record<string, unknown>;
    return { id: str(x.id), status: str(x.status), label: str(x.label), other: Boolean(x.other) };
  }).filter((x) => x.id && x.status);
  const roles = Array.isArray(r.roles) ? r.roles.map((v) => str(v)) : null;
  return { statuses, actions, reasons, roles };
}

/** One status's definition; an unknown value reads as itself in sentence case (never the raw key). */
export function statusInfo(workflow: Workflow, value: string): StatusDefinition {
  const label = value ? value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()) : "";
  return workflow.statuses.find((s) => s.value === value) ?? { value, label, sort: 0, tone: "neutral", hint: "", editable: false, legacy: false, color: "#64748b", final: false, active: true };
}
/** Every transition from `status` taken by `actor` (staff, or the applicant's automatic ones), in order. */
export function actionsFor(workflow: Workflow, status: string, actor: StatusAction["actor"]): StatusAction[] {
  return workflow.actions.filter((x) => x.from === status && x.actor === actor).sort((a, b) => a.sort - b.sort || a.action.localeCompare(b.action));
}
/**
 * What a user with `roles` may choose from `status`: the active, non-automatic transitions whose allowed roles include one of theirs
 * (the database checks the same). The primary one first, Reject / Withdraw (danger) last.
 */
export function getAllowedActions(workflow: Workflow, status: string, roles: readonly string[] | null = workflow.roles): StatusAction[] {
  return workflow.actions
    .filter((x) => x.from === status && !x.automatic && (roles === null || x.roles === null || x.roles.some((role) => roles.includes(role))))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || Number(a.tone === "danger") - Number(b.tone === "danger") || a.sort - b.sort || a.action.localeCompare(b.action));
}
/** The reasons for moving to `status` ("Other" last). */
export const reasonsFor = (workflow: Workflow, status: string | null) =>
  workflow.reasons.filter((r) => r.status === status).sort((a, b) => Number(a.other) - Number(b.other));
/** The student or agent can still change the form in this status. */
export const isEditableStatus = (workflow: Workflow, status: string) => statusInfo(workflow, status).editable;
/** The applicant submits from this status (a draft). */
export const canSubmitFrom = (workflow: Workflow, status: string) => actionsFor(workflow, status, "applicant").some((x) => x.kind === "submit");
/** The statuses offered in filters and lists: active ones in order (the legacy ones only label existing rows). */
export const currentStatuses = (workflow: Workflow) => workflow.statuses.filter((s) => !s.legacy && s.active);

let cached: Workflow | null = null;
let pending: Promise<Workflow> | null = null;
const listeners = new Set<(workflow: Workflow) => void>();
let channel: { unsubscribe: () => unknown } | null = null;

async function fetchWorkflow(): Promise<Workflow> {
  const { supabase } = await import("@/pages/admin/lib/supabase");
  const { data, error } = await supabase.rpc("application_status_workflow");
  if (error || !data) return cached ?? EMPTY_WORKFLOW;
  return parseWorkflow(data);
}

/** Loads the workflow once per page load and shares it; an empty one (no labels, no actions) when it cannot be read. */
export function loadApplicationStatuses(): Promise<Workflow> {
  if (cached) return Promise.resolve(cached);
  pending ??= fetchWorkflow().then((next) => { if (next !== EMPTY_WORKFLOW) cached = next; return next; })
    .catch(() => EMPTY_WORKFLOW).finally(() => { pending = null; });
  return pending;
}

/** Reads the workflow again and gives it to every mounted component (after a settings save, or a realtime change). */
export async function refreshApplicationStatuses(): Promise<Workflow> {
  const next = await fetchWorkflow().catch(() => cached ?? EMPTY_WORKFLOW);
  cached = next;
  listeners.forEach((listener) => listener(next));
  return next;
}

/** One realtime subscription per page to the three configuration tables (each change re-reads the workflow). */
async function subscribe() {
  if (channel) return;
  try {
    const { supabase } = await import("@/pages/admin/lib/supabase");
    let timer: number | undefined;
    const onChange = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void refreshApplicationStatuses(), 300); };
    const ch = supabase.channel("application-status-config");
    for (const table of ["application_statuses", "application_status_transitions", "status_reasons"]) ch.on("postgres_changes", { event: "*", schema: "public", table }, onChange);
    ch.subscribe();
    channel = ch;
  } catch { /* live refresh is a convenience; the next page load reads the new configuration */ }
}

/** The workflow from the database for components: `ready` once it has loaded; it follows configuration changes live. */
export function useApplicationStatuses(): Workflow & { ready: boolean } {
  const [workflow, setWorkflow] = useState<Workflow | null>(cached);
  useEffect(() => {
    let active = true;
    const listener = (next: Workflow) => { if (active) setWorkflow(next); };
    listeners.add(listener);
    if (!cached) void loadApplicationStatuses().then((next) => { if (active) setWorkflow(next); });
    void subscribe();
    return () => { active = false; listeners.delete(listener); };
  }, []);
  return { ...(workflow ?? EMPTY_WORKFLOW), ready: workflow !== null };
}
