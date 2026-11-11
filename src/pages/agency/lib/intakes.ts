// The intakes of a course for the enrolment form (INT-01). The database lists the open ones (active, starting today or later in
// Melbourne, earliest first) with the label the form shows; nothing here makes up a month or a year. The server checks the chosen
// intake again when the draft is saved and when it is submitted.
import { supabase } from "@/pages/admin/lib/supabase";

export interface OpenIntake { id: string; courseId: string; startDate: string; endDate: string | null; name: string; display: string }

const cache = new Map<string, Promise<OpenIntake[]>>();
/** Open intakes of a course (its CMS id, or its slug for the static course list). Cached per page load; a failure is not cached. */
export function openIntakes(courseId: string): Promise<OpenIntake[]> {
  const key = courseId.trim();
  if (!key) return Promise.resolve([]);
  if (!cache.has(key)) {
    const request = (async () => {
      const { data, error } = await supabase.rpc("course_intakes_open", { p_course: key });
      if (error) throw new Error("The intakes could not be loaded. Check your connection and try again.");
      return (data ?? []) as OpenIntake[];
    })();
    request.catch(() => cache.delete(key));
    cache.set(key, request);
  }
  return cache.get(key)!;
}
