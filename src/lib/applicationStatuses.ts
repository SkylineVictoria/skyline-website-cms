import { useEffect, useState } from "react";

/**
 * Application statuses, their labels, order and badge tones, and what can be done from each status and by whom: all from the
 * database (application_statuses and application_status_actions, read through application_status_workflow()). Nothing about
 * statuses is written into the frontend; the database also enforces every move.
 */
export type StatusTone = "neutral" | "info" | "warning" | "success" | "danger" | "muted";
export interface StatusDefinition { value: string; label: string; sort: number; tone: StatusTone; hint: string; editable: boolean; legacy: boolean }
export type ActionKind = "status" | "offer_letter" | "coe" | "reminder" | "resend_offer" | "accept_offer" | "resubmit" | "submit";
export interface StatusAction {
  from: string; action: string; to: string | null; actor: "staff" | "applicant"; label: string; kind: ActionKind;
  note: "none" | "optional" | "required"; tone: "neutral" | "primary" | "danger"; sort: number;
}
export interface Workflow { statuses: StatusDefinition[]; actions: StatusAction[] }

export const EMPTY_WORKFLOW: Workflow = { statuses: [], actions: [] };

/** How each tone of the catalogue looks (the database picks the tone, the theme the colours). */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-background-100 text-foreground-700",
  info: "bg-secondary-100 text-secondary-900",
  warning: "bg-amber-100 text-amber-900",
  success: "bg-emerald-50 text-emerald-800",
  danger: "bg-red-50 text-red-700",
  muted: "bg-background-200 text-foreground-600",
};

/** The workflow as the RPC returns it, checked field by field. */
export function parseWorkflow(raw: unknown): Workflow {
  const r = (raw ?? {}) as { statuses?: unknown; actions?: unknown };
  const statuses = (Array.isArray(r.statuses) ? r.statuses : []).map((item) => {
    const s = (item ?? {}) as Record<string, unknown>;
    return { value: String(s.value ?? ""), label: String(s.label ?? s.value ?? ""), sort: Number(s.sort ?? 0), tone: String(s.tone ?? "neutral") as StatusTone,
      hint: String(s.hint ?? ""), editable: Boolean(s.editable), legacy: Boolean(s.legacy) };
  }).filter((s) => s.value).sort((a, b) => a.sort - b.sort);
  const actions = (Array.isArray(r.actions) ? r.actions : []).map((item) => {
    const x = (item ?? {}) as Record<string, unknown>;
    return { from: String(x.from ?? ""), action: String(x.action ?? ""), to: x.to ? String(x.to) : null, actor: x.actor === "applicant" ? "applicant" : "staff",
      label: String(x.label ?? x.action ?? ""), kind: String(x.kind ?? "status") as ActionKind, note: (["optional", "required"].includes(String(x.note)) ? x.note : "none") as StatusAction["note"],
      tone: (["primary", "danger"].includes(String(x.tone)) ? x.tone : "neutral") as StatusAction["tone"], sort: Number(x.sort ?? 0) } satisfies StatusAction;
  }).filter((x) => x.from && x.action);
  return { statuses, actions };
}

/** One status's definition; an unknown value reads as itself. */
export function statusInfo(workflow: Workflow, value: string): StatusDefinition {
  return workflow.statuses.find((s) => s.value === value) ?? { value, label: value ? value.replaceAll("_", " ") : "", sort: 0, tone: "neutral", hint: "", editable: false, legacy: false };
}
/** What `actor` can do from `status`, in order. */
export function actionsFor(workflow: Workflow, status: string, actor: StatusAction["actor"]): StatusAction[] {
  return workflow.actions.filter((x) => x.from === status && x.actor === actor).sort((a, b) => a.sort - b.sort || a.action.localeCompare(b.action));
}
/** The student or agent can still change the form in this status. */
export const isEditableStatus = (workflow: Workflow, status: string) => statusInfo(workflow, status).editable;
/** The applicant submits from this status (a draft). */
export const canSubmitFrom = (workflow: Workflow, status: string) => actionsFor(workflow, status, "applicant").some((x) => x.kind === "submit");
/** The statuses offered in filters and lists (the legacy ones only label existing rows). */
export const currentStatuses = (workflow: Workflow) => workflow.statuses.filter((s) => !s.legacy);

let cached: Workflow | null = null;
let pending: Promise<Workflow> | null = null;

/** Loads the workflow once per page load and shares it; an empty one (no labels, no actions) when it cannot be read. */
export function loadApplicationStatuses(): Promise<Workflow> {
  if (cached) return Promise.resolve(cached);
  pending ??= (async () => {
    const { supabase } = await import("@/pages/admin/lib/supabase");
    const { data, error } = await supabase.rpc("application_status_workflow");
    if (error || !data) return EMPTY_WORKFLOW;
    cached = parseWorkflow(data);
    return cached;
  })().catch(() => EMPTY_WORKFLOW).finally(() => { pending = null; });
  return pending;
}

/** The workflow from the database for components: `ready` once it has loaded. */
export function useApplicationStatuses(): Workflow & { ready: boolean } {
  const [workflow, setWorkflow] = useState<Workflow | null>(cached);
  useEffect(() => {
    let active = true;
    if (!cached) void loadApplicationStatuses().then((next) => { if (active) setWorkflow(next); });
    return () => { active = false; };
  }, []);
  return { ...(workflow ?? EMPTY_WORKFLOW), ready: workflow !== null };
}
