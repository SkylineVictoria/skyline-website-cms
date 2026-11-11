// Course intakes for staff (INT-01, CMS > Courses > a course > Intakes). The database does every check (public.course_intakes_admin,
// CMS staff only) and returns the course's intakes after each action, with their labels made there: no month name or year is written here.
import { supabase } from "@/pages/admin/lib/supabase";

export interface CourseIntake {
  id: string; courseId: string; startDate: string; endDate: string | null; label: string; isActive: boolean;
  name: string; display: string; open: boolean; applications: number;
}
export interface IntakeInput { startDate: string; endDate?: string; label?: string; isActive?: boolean }

async function call(action: "list" | "save" | "delete", courseId: string, id: string | null = null, data: IntakeInput | Record<string, never> = {}): Promise<CourseIntake[]> {
  const { data: rows, error } = await supabase.rpc("course_intakes_admin", { p_action: action, p_course: courseId, p_id: id, p_data: data });
  if (error) throw new Error(error.message);
  return (rows ?? []) as CourseIntake[];
}
export const listCourseIntakes = (courseId: string) => call("list", courseId);
export const saveCourseIntake = (courseId: string, id: string | null, input: IntakeInput) => call("save", courseId, id, input);
export const deleteCourseIntake = (courseId: string, id: string) => call("delete", courseId, id);
