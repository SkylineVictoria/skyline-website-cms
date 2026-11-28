/** LMS-owned navigation and dependency metadata.
 * This file deliberately does not modify Master Data, CRM or HRMS.
 * All references resolve through existing authoritative APIs.
 */
export type LmsArea = "courses" | "units" | "master-calendar" | "weekly-calendar" | "intakes" | "batches" | "attendance" | "completion" | "assessments" | "timetable" | "timetable-create" | "timetable-settings" | "room-availability" | "trainer-availability" | "timetable-templates" | "term-breaks" | "locations" | "results"
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
  { id: "units", label: "Units", route: "/admin/lms/units", icon: "ri-stack-line", dependencies: ["course"] },
  // Owner 2026-11-28: each course's master calendar (cycles and unit dates) and weekly calendar (its intakes' week) as their own screens.
  { id: "master-calendar", label: "Master calendar", route: "/admin/lms/master-calendar", icon: "ri-calendar-schedule-line", dependencies: ["course"] },
  { id: "weekly-calendar", label: "Weekly calendar", route: "/admin/lms/weekly-calendar", icon: "ri-calendar-line", dependencies: ["course"] },
  // An intake is the class group (room, trainer, class times, students).
  { id: "intakes", label: "Intakes", route: "/admin/lms/intakes", icon: "ri-calendar-event-line", dependencies: ["course"], primaryAction: "Add Intake" },
  // LMS-BATCHES (owner 2026-11-25): the class batches B1 / B2 / B3 of an intake on their own page.
  { id: "batches", label: "Batches", route: "/admin/lms/batches", icon: "ri-group-2-line", dependencies: ["course", "intake"] },
  // Timetable: three links (owner, 2026-11-19: less clutter). Trainers, rooms, students and the intakes timeline are tabs of the
  // calendar; term breaks, locations and saved course timetables are tabs of Settings. Old addresses still open.
  { id: "tt-calendar", label: "Calendar", route: "/admin/lms/timetable", icon: "ri-calendar-2-line", dependencies: [], parent: "timetable" },
  { id: "timetable-create", label: "Create timetable", route: "/admin/lms/timetable-create", icon: "ri-add-circle-line", dependencies: ["course", "intake"], parent: "timetable" },
  // Room hours live in Bookings (one availability module for people and rooms); this is a shortcut to it.
  { id: "room-availability", label: "Room availability", route: "/admin/bookings?tab=availability&who=rooms", icon: "ri-door-open-line", dependencies: [], parent: "timetable" },
  { id: "trainer-availability", label: "Trainer availability", route: "/admin/bookings?tab=availability&who=trainers", icon: "ri-user-star-line", dependencies: [], parent: "timetable" },
  // Students' weeks, like the trainers': the Timetable's Students view.
  { id: "tt-students", label: "Student availability", route: "/admin/lms/timetable?view=students", icon: "ri-group-line", dependencies: [], parent: "timetable" },
  { id: "timetable-settings", label: "Settings", route: "/admin/lms/timetable-settings", icon: "ri-settings-3-line", dependencies: [], parent: "timetable" },
  { id: "attendance", label: "Attendance", route: "/admin/lms/attendance", icon: "ri-checkbox-circle-line", dependencies: ["course", "intake", "session"], primaryAction: "Mark Attendance" },
  // AVETMISS-UI (2026-11-25): each student's AVETMISS outcome per unit (outcome, actual dates, delivery, location, RPL evidence).
  { id: "results", label: "Results", route: "/admin/lms/results", icon: "ri-medal-line", dependencies: ["course", "intake", "unit"] },
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
