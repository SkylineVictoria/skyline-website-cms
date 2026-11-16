/** Presentation-only views. These values never authorize a database request. */
export const PORTAL_VIEWS = [
  { id: "admin", label: "Admin View", icon: "ri-shield-user-line" },
  { id: "student", label: "Student View", icon: "ri-graduation-cap-line" },
  { id: "agent", label: "Agent View", icon: "ri-building-2-line" },
  { id: "staff", label: "Staff View", icon: "ri-team-line" },
] as const;
export type PreviewView = "student" | "agent" | "staff";
export function previewView(value: string | undefined): PreviewView | null {
  return value === "student" || value === "agent" || value === "staff" ? value : null;
}
export const PREVIEW_READ_ONLY = "Read-only preview: changes, uploads and submissions are disabled.";
export const previewFrameView = () => typeof window === "undefined" ? null : previewView(window.location.pathname.match(/^\/portal-preview\/(student|agent|staff)\/?$/)?.[1]);
