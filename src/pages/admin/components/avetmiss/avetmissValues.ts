/**
 * AVETMISS-UI (2026-11-25): the disability types and prior education inputs shared by the application wizard and the student's
 * AVETMISS panel. In an application the answers are kept as strings in data.values (the wizard's answers are strings):
 *   disability_types  comma-separated disability_type codes, e.g. "11,13"
 *   prior_education   JSON array of { code, recognition, name }
 *   english_proficiency_code  one english_proficiency code
 */
export interface PriorEducationRow { code: string; recognition: string; name: string }

export const parseCodeList = (value: unknown): string[] =>
  (Array.isArray(value) ? value.map(String) : String(value ?? "").split(",")).map((c) => c.trim()).filter(Boolean);
export const serializeCodeList = (codes: string[]): string => [...new Set(codes)].join(",");

export function parsePriorEducation(value: unknown): PriorEducationRow[] {
  let list: unknown = value;
  if (typeof value === "string") { try { list = value.trim() ? JSON.parse(value) : []; } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  return list.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    return { code: String(row.code ?? row.prior_education_code ?? ""), recognition: String(row.recognition ?? row.recognition_code ?? ""), name: String(row.name ?? row.qualification_name ?? "") };
  });
}
export const serializePriorEducation = (rows: PriorEducationRow[]): string => JSON.stringify(rows);

/** The first problem with prior education rows, or "" (each row needs a level and a recognition; no duplicate pairs). */
export function priorEducationProblem(rows: PriorEducationRow[]): string {
  if (!rows.length) return "Add at least one qualification.";
  if (rows.some((r) => !r.code || !r.recognition)) return "Choose the level and where it was completed for each qualification.";
  const keys = rows.map((r) => `${r.code}|${r.recognition}`);
  if (new Set(keys).size !== keys.length) return "The same level and recognition is listed twice.";
  if (rows.some((r) => r.name.length > 200)) return "Keep each qualification name under 200 characters.";
  return "";
}

