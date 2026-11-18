/** LMS-owned navigation and dependency metadata.
 * This file deliberately does not modify Master Data, CRM or HRMS.
 * All references resolve through existing authoritative APIs.
 */
export type LmsArea = "courses" | "units" | "intakes" | "attendance" | "completion" | "assessments" | "timetable" | "timetable-create" | "timetable-settings" | "timetable-templates" | "term-breaks" | "locations"
  // Timetable views (LMS > Timetable tabs, ?view=), listed under Timetable in the sidebar.
  | "tt-calendar" | "tt-trainers" | "tt-rooms" | "tt-students" | "tt-intakes" | "tt-setup";
export type LmsDependency = "course" | "intake" | "unit" | "unitDelivery" | "session";
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
  // An intake is the class group (room, trainer, class times, students).
  { id: "intakes", label: "Intakes", route: "/admin/lms/intakes", icon: "ri-calendar-event-line", dependencies: ["course"], primaryAction: "Add Intake" },
  // Timetable: three links (owner, 2026-11-19: less clutter). Trainers, rooms, students and the intakes timeline are tabs of the
  // calendar; term breaks, locations and saved course timetables are tabs of Settings. Old addresses still open.
  { id: "tt-calendar", label: "Calendar", route: "/admin/lms/timetable", icon: "ri-calendar-2-line", dependencies: [], parent: "timetable" },
  { id: "timetable-create", label: "Create timetable", route: "/admin/lms/timetable-create", icon: "ri-add-circle-line", dependencies: ["course", "intake"], parent: "timetable" },
  { id: "timetable-settings", label: "Settings", route: "/admin/lms/timetable-settings", icon: "ri-settings-3-line", dependencies: [], parent: "timetable" },
  { id: "attendance", label: "Attendance", route: "/admin/lms/attendance", icon: "ri-checkbox-circle-line", dependencies: ["course", "intake", "session"], primaryAction: "Mark Attendance" },
  { id: "completion", label: "Completion", route: "/admin/lms/completion", icon: "ri-award-line", dependencies: ["course", "intake"] },
  { id: "assessments", label: "Assessments", route: "/admin/lms/assessments", icon: "ri-file-list-3-line", dependencies: ["course", "intake", "unit"], primaryAction: "Add Assessment" },
] as const;
/** A selected child must resolve all ancestor IDs without additional user selections.
 * Quick-create is allowed only through the authoritative entity's existing API.
 * Never create shadow course, unit, student or employee records in LMS.
 */
export function dependencyChain(area: LmsArea): readonly LmsDependency[] {
  return LMS_MENU.find(item => item.id === area)?.dependencies ?? [];
}
