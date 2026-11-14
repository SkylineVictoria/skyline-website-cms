/** LMS-owned navigation and dependency metadata.
 * This file deliberately does not modify Master Data, CRM or HRMS.
 * All references resolve through existing authoritative APIs.
 */
export type LmsArea = "dashboard" | "courses" | "units" | "intakes" | "batches" | "batch-allocation" | "attendance" | "assessments";
export type LmsDependency = "course" | "intake" | "batch" | "unit" | "unitDelivery" | "session";
export interface LmsMenuEntry {
  id: LmsArea;
  label: string;
  route: string;
  icon: string;
  dependencies: readonly LmsDependency[];
  primaryAction?: string;
}
export const LMS_MENU: readonly LmsMenuEntry[] = [
  { id: "dashboard", label: "Dashboard", route: "/admin/lms", icon: "ri-dashboard-3-line", dependencies: [] },
  { id: "courses", label: "Courses", route: "/admin/lms/courses", icon: "ri-book-open-line", dependencies: [], primaryAction: "Add Course" },
  { id: "units", label: "Units", route: "/admin/lms/units", icon: "ri-stack-line", dependencies: ["course"] },
  { id: "intakes", label: "Intakes", route: "/admin/lms/intakes", icon: "ri-calendar-event-line", dependencies: ["course"], primaryAction: "Add Intake" },
  { id: "batches", label: "Batches", route: "/admin/lms/batches", icon: "ri-group-line", dependencies: ["course", "intake"], primaryAction: "Add Batch" },
  { id: "batch-allocation", label: "Batch Allocation", route: "/admin/lms/batch-allocation", icon: "ri-user-follow-line", dependencies: ["course", "intake", "batch"] },
  { id: "attendance", label: "Attendance", route: "/admin/lms/attendance", icon: "ri-checkbox-circle-line", dependencies: ["course", "intake", "batch", "session"], primaryAction: "Mark Attendance" },
  { id: "assessments", label: "Assessments & Results", route: "/admin/lms/assessments", icon: "ri-file-list-3-line", dependencies: ["course", "intake", "batch", "unit"], primaryAction: "Add Assessment" },
] as const;
/** A selected child must resolve all ancestor IDs without additional user selections.
 * Quick-create is allowed only through the authoritative entity's existing API.
 * Never create shadow course, unit, student or employee records in LMS.
 */
export function dependencyChain(area: LmsArea): readonly LmsDependency[] {
  return LMS_MENU.find(item => item.id === area)?.dependencies ?? [];
}
