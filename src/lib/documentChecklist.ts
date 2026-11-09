// Document checklist rules shared by DocumentWizard (staff today; the student ApplicationWizard can move onto it later).
// Pure and browser-free so it is tested offline (scripts/test-staff-registration.ts).

export type ExpiryRule = "required" | "optional" | "none";
export type ReviewState = "pending" | "approved" | "rejected";

/** One kind of document a wizard asks for. */
export interface DocumentKind {
  category: string;
  label: string;
  /** Counted in x/N and needed for submit; an optional kind is shown and reviewed but never blocks anything. */
  required: boolean;
  expiry: ExpiryRule;
  /** Several current files (e.g. academic results); otherwise a new file replaces the current one. */
  multiple: boolean;
}

export const EXPIRING_SOON_DAYS = 30;

/** Today in the browser's calendar, as YYYY-MM-DD. */
export const todayIso = (now = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export function daysUntil(dateIso: string, today = todayIso()): number {
  return Math.round((Date.parse(`${dateIso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export type ExpiryState = "none" | "ok" | "soon" | "expired";
/** Expiring within 30 days (or already expired) is flagged, the same window as hr.staff_doc_summary. */
export function expiryState(dateIso: string | null | undefined, today = todayIso()): ExpiryState {
  if (!dateIso) return "none";
  const days = daysUntil(dateIso, today);
  return days < 0 ? "expired" : days <= EXPIRING_SOON_DAYS ? "soon" : "ok";
}

export interface DocLike { category: string; status: ReviewState; expiryDate: string | null; reviewNote?: string }

export interface ChecklistItem {
  kind: DocumentKind;
  files: number;
  /** missing: nothing uploaded; rejected: any current file rejected; approved: every current file approved; else pending. */
  state: "missing" | "pending" | "approved" | "rejected";
  expiry: ExpiryState;
  /** The earliest expiry date among the current files. */
  expiryDate: string | null;
  notes: string[];
}

export function checklist(kinds: readonly DocumentKind[], docs: readonly DocLike[], today = todayIso()): ChecklistItem[] {
  return kinds.map((kind) => {
    const mine = docs.filter((d) => d.category === kind.category);
    const state: ChecklistItem["state"] = !mine.length ? "missing" : mine.some((d) => d.status === "rejected") ? "rejected" : mine.every((d) => d.status === "approved") ? "approved" : "pending";
    const dates = mine.map((d) => d.expiryDate).filter((d): d is string => !!d).sort();
    return { kind, files: mine.length, state, expiryDate: dates[0] ?? null, expiry: expiryState(dates[0], today),
      notes: mine.filter((d) => d.status === "rejected" && d.reviewNote).map((d) => d.reviewNote as string) };
  });
}

/** x/N: required kinds that have files and every current file approved, out of the required kinds. */
export function approvedCount(items: readonly ChecklistItem[]): { approved: number; required: number } {
  const required = items.filter((i) => i.kind.required);
  return { approved: required.filter((i) => i.state === "approved").length, required: required.length };
}
