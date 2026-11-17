/** LMS-owned navigation and dependency metadata.
 * This file deliberately does not modify Master Data, CRM or HRMS.
 * All references resolve through existing authoritative APIs.
 */
export type LmsArea = "courses" | "units" | "intakes" | "batches" | "batch-allocation" | "attendance" | "completion" | "assessments" | "timetable" | "timetable-templates" | "term-breaks" | "locations";
export type LmsDependency = "course" | "intake" | "batch" | "unit" | "unitDelivery" | "session";
export interface LmsMenuEntry {
  id: LmsArea;
  label: string;
  route: string;
  icon: string;
  dependencies: readonly LmsDependency[];
  primaryAction?: string;
  /** Shown nested under this entry in the sidebar. */
  parent?: LmsArea;
}
export const LMS_MENU: readonly LmsMenuEntry[] = [
  { id: "courses", label: "Courses", route: "/admin/lms/courses", icon: "ri-book-open-line", dependencies: [], primaryAction: "Add Course" },
  { id: "intakes", label: "Intakes", route: "/admin/lms/intakes", icon: "ri-calendar-event-line", dependencies: ["course"], primaryAction: "Add Intake" },
  { id: "batches", label: "Batches", route: "/admin/lms/batches", icon: "ri-group-line", dependencies: ["course", "intake"], primaryAction: "Add Batch" },
  { id: "timetable-templates", label: "Templates", route: "/admin/lms/timetable-templates", icon: "ri-file-copy-2-line", dependencies: ["course"], parent: "timetable" },
  { id: "term-breaks", label: "Term breaks", route: "/admin/lms/term-breaks", icon: "ri-calendar-close-line", dependencies: [], parent: "timetable" },
  { id: "locations", label: "Locations & rooms", route: "/admin/lms/locations", icon: "ri-building-line", dependencies: [], parent: "timetable" },
  { id: "attendance", label: "Attendance", route: "/admin/lms/attendance", icon: "ri-checkbox-circle-line", dependencies: ["course", "intake", "batch", "session"], primaryAction: "Mark Attendance" },
  { id: "completion", label: "Completion", route: "/admin/lms/completion", icon: "ri-award-line", dependencies: ["course", "intake", "batch"] },
  { id: "assessments", label: "Assessments", route: "/admin/lms/assessments", icon: "ri-file-list-3-line", dependencies: ["course", "intake", "batch", "unit"], primaryAction: "Add Assessment" },
] as const;
/** A selected child must resolve all ancestor IDs without additional user selections.
 * Quick-create is allowed only through the authoritative entity's existing API.
 * Never create shadow course, unit, student or employee records in LMS.
 */
export function dependencyChain(area: LmsArea): readonly LmsDependency[] {
  return LMS_MENU.find(item => item.id === area)?.dependencies ?? [];
}
