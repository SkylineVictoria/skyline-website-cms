/** Attendance below this share of classes is flagged (the CRICOS standard for international students). */
export const ATTENDANCE_THRESHOLD = 80;

export type AttendanceCounts = { classes: number; present: number; late: number; absent: number; excused: number };

/** Present and late count as attended; excused classes are left out. Null until a class is marked. */
export function attendanceRate(c: AttendanceCounts): number | null {
  const counted = c.classes - c.excused;
  return counted > 0 ? Math.round(((c.present + c.late) / counted) * 100) : null;
}
