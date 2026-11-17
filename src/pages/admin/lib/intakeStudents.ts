import { supabase } from "./supabase";

export interface IntakeStudent {
  id: string;
  name: string;
  email: string | null;
  plan?: {
    unitId: string; code: string; intakeId: string; intakeStart: string;
    startDate: string | null; endDate: string | null; carried: boolean; completed: boolean;
  }[];
}

export interface AllocationUnit {
  id: string;
  code: string;
  name: string;
  count: number;
}

export interface IntakeStudentScope {
  courseId: string;
  intakeId?: string;
  unitId?: string;
}

export async function intakeStudents<T>(
  action: "counts" | "units" | "roster" | "search" | "add",
  scope: IntakeStudentScope,
  options: { ids?: string[]; search?: string } = {},
): Promise<T> {
  const { data, error } = await supabase.rpc("lms_intake_students", {
    p_action: action,
    p_course_id: scope.courseId,
    p_intake_id: scope.intakeId ?? null,
    p_unit_id: scope.unitId ?? null,
    p_student_ids: options.ids ?? null,
    p_search: options.search ?? "",
  });
  if (error) throw new Error(error.message);
  return data as T;
}
