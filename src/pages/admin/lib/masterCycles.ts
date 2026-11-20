// Qualification cycles of a course's master timetable (rto_master_cycles) and filling term breaks from the Victorian school calendar.
import { supabase } from "@/pages/admin/lib/supabase";
import { fetchVicTerms, newBreaks, schoolBreaks } from "@/pages/admin/lib/schoolTerms";

import type { CyclePlan } from "./masterDates";
export * from "./masterDates";


/** The database has no cycle plan yet (migration 20261121020000 not installed): the master timetable still saves one cycle. */
export class CyclesUnavailable extends Error {}

export async function cyclesCall(action: "get" | "set" | "rebuild", data: Record<string, unknown>): Promise<CyclePlan> {
  const { data: out, error } = await supabase.rpc("rto_master_cycles", { p_action: action, p_data: data });
  if (error?.code === "PGRST202") throw new CyclesUnavailable("Qualification cycles are not installed on this database yet: only the current cycle was saved.");
  if (error) throw new Error(error.message);
  return out as CyclePlan;
}

/** Fills the Victorian school breaks for [from, to] as term breaks for every course; returns how many were added. */
/** Adds the Victorian school holidays for [from, to] as term breaks of THIS course only (owner, 2026-11-20: "not in all courses").
 *  A break already on the course (its own or one for every course) keeps those days. */
export async function fillSchoolBreaks(courseId: string, from: string, to: string): Promise<{ added: number; predicted: number; kept: number }> {
  const wanted = schoolBreaks(await fetchVicTerms(), from, to);
  const { data, error } = await supabase.from("academic_breaks").select("start_date,end_date").or(`course_id.is.null,course_id.eq.${courseId}`)
    .lte("start_date", to).gte("end_date", from);
  if (error) throw new Error(error.message);
  const existing = ((data ?? []) as { start_date: string; end_date: string }[]).map(b => ({ startDate: b.start_date, endDate: b.end_date }));
  const adding = newBreaks(wanted, existing);
  if (adding.length) {
    const rows = adding.map(b => ({ label: b.label.slice(0, 80), start_date: b.startDate, end_date: b.endDate, course_id: courseId, source: b.predicted ? "predicted" : "vic_school" }));
    let { error: insertError } = await supabase.from("academic_breaks").insert(rows);
    // Before migration 20261121020000 there is no source column: the label still says "(predicted: check)".
    if (insertError?.code === "PGRST204") ({ error: insertError } = await supabase.from("academic_breaks").insert(rows.map(({ source: _source, ...row }) => row)));
    if (insertError) throw new Error(insertError.message);
  }
  return { added: adding.length, predicted: adding.filter(b => b.predicted).length, kept: wanted.length - adding.length };
}
