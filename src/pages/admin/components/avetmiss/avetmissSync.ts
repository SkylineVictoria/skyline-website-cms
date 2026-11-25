import { supabase } from "@/pages/admin/lib/supabase";
import { parseCodeList, parsePriorEducation, priorEducationProblem } from "./avetmissValues";

/**
 * AVETMISS-UI (2026-11-25): after the application wizard's "About the student" screen is saved, the AVETMISS answers are also
 * written to the student's own tables when the signed-in person may write them (SLIT staff: student_disabilities /
 * student_prior_education; SLIT or agency admin: enrollment_students). An agent's writes are refused by RLS: the answers then stay
 * in the application (data.values) and the CMS student page shows them as "not saved yet" with Save. Never throws.
 * Returns which parts were saved.
 */
export async function syncApplicationAvetmiss(studentId: string, values: Record<string, unknown>): Promise<{ english: boolean; disabilities: boolean; prior: boolean; language?: boolean }> {
  const saved: { english: boolean; disabilities: boolean; prior: boolean; language?: boolean } = { english: false, disabilities: false, prior: false };
  try {
    // AVETMISS-LANGUAGES (2026-11-25): the ASCL home language code from the wizard's Language screen.
    const language = String(values.language_code ?? "").trim();
    if (/^\d{4}$/.test(language)) {
      const { data, error } = await supabase.from("enrollment_students").update({ home_language_code: language }).eq("id", studentId).select("id");
      saved.language = !error && Array.isArray(data) && data.length > 0;
    }
    const english = String(values.english_proficiency_code ?? "").trim();
    if (english) {
      const { data, error } = await supabase.from("enrollment_students").update({ english_proficiency_code: english }).eq("id", studentId).select("id");
      saved.english = !error && Array.isArray(data) && data.length > 0;
    }
    if (values.disability === "Yes") {
      const codes = parseCodeList(values.disability_types);
      if (codes.length) {
        const ins = await supabase.from("student_disabilities").upsert(codes.map((code) => ({ student_id: studentId, disability_type_code: code })), { onConflict: "student_id,disability_type_code", ignoreDuplicates: true });
        if (!ins.error) {
          await supabase.from("student_disabilities").delete().eq("student_id", studentId).not("disability_type_code", "in", `(${codes.join(",")})`);
          saved.disabilities = true;
        }
      }
    }
    if (values.prior_ed === "Yes") {
      const rows = parsePriorEducation(values.prior_education);
      if (rows.length && !priorEducationProblem(rows)) {
        const ins = await supabase.from("student_prior_education").upsert(rows.map((r) => ({ student_id: studentId, prior_education_code: r.code, recognition_code: r.recognition, qualification_name: r.name.trim() || null })),
          { onConflict: "student_id,prior_education_code,recognition_code" });
        if (!ins.error) {
          const keep = new Set(rows.map((r) => `${r.code}|${r.recognition}`));
          const { data } = await supabase.from("student_prior_education").select("prior_education_code, recognition_code").eq("student_id", studentId);
          for (const row of (data ?? []) as { prior_education_code: string; recognition_code: string }[]) {
            if (!keep.has(`${row.prior_education_code}|${row.recognition_code}`)) {
              await supabase.from("student_prior_education").delete().eq("student_id", studentId).eq("prior_education_code", row.prior_education_code).eq("recognition_code", row.recognition_code);
            }
          }
          saved.prior = true;
        }
      }
    }
  } catch { /* best effort: the application keeps the answers */ }
  return saved;
}
