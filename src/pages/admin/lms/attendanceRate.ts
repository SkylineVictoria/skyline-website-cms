import { onRules, ruleNumber, ruleObject } from "@/lib/businessRules";
/** Attendance below this share of classes is flagged (the CRICOS standard for international students). */
export let ATTENDANCE_THRESHOLD = 80;
let treatment = { countsAsPresent: ["present", "late"], excluded: ["excused"] };
onRules(() => {
  ATTENDANCE_THRESHOLD = ruleNumber("lms.attendance_alert_threshold", 80);
  treatment = ruleObject("lms.attendance_mark_treatment", { countsAsPresent: ["present", "late"], excluded: ["excused"] });
});

export type AttendanceCounts = { classes: number; present: number; late: number; absent: number; excused: number };

/** Present and late count as attended; excused classes are left out. Null until a class is marked. */
export function attendanceRate(c: AttendanceCounts): number | null {
  const part = (names: string[]) => names.reduce((t, n) => t + (n in c && n !== "classes" ? Number(c[n as keyof AttendanceCounts]) || 0 : 0), 0);
  const counted = c.classes - part(treatment.excluded);
  return counted > 0 ? Math.round((part(treatment.countsAsPresent) / counted) * 100) : null;
}
