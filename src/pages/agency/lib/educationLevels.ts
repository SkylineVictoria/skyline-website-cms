/** University levels offered above the school levels. Each counts as "Year 12 or equivalent" for reporting. */
export const DEGREE_LEVELS = ["Doctorate (PhD)", "Master's degree", "Bachelor's degree"];
const YEAR_12 = "Year 12 or equivalent - 12";

/** The school level reported for a chosen education level: any degree means school was completed to Year 12. */
export function schoolLevelFor(choice: string): string {
  return DEGREE_LEVELS.includes(choice) ? YEAR_12 : choice;
}

/**
 * Owner 2026-11-25: the About the student answers come from the academic files already uploaded (read into academic_qualification /
 * academic_program / academic_institution / academic_year). Each file gives at most one AVETMISS prior education row (level code,
 * Australian or international, name); a school certificate (Year 10 / 12, SSC / HSC, matriculation, A / O levels) gives only the
 * school level. Any degree, diploma or certificate means school was completed to Year 12 unless a school file says otherwise.
 */
export interface AcademicPrefill {
  schoolLevel: string;
  priorRows: { code: string; recognition: string; name: string }[];
  /** Files with a qualification that could be read, school ones included. */
  readable: number;
}

const AUSTRALIAN = /\b(australia|australian|tafe|aqf|new south wales|nsw|victoria|vic|queensland|qld|tasmania|south australia|western australia|northern territory|canberra|melbourne|sydney|brisbane|perth|adelaide|hobart|darwin)\b/i;

function priorCode(t: string): string {
  if (/\b(ph\.?\s?d|doctor(ate)?|master'?s?|m\.?\s?(sc|tech|com|ba|e|a|phil|ed)\b|mba|bachelor'?s?|b\.?\s?(sc|tech|com|e|a|ed|ba|pharm|arch|des|ca)\b|bba|bca|llb|mbbs|graduate (certificate|diploma)|post\s?graduate|degree|honours)\b/i.test(t)) return "008";
  if (/\b(advanced diploma|associate degree)\b/i.test(t)) return "410";
  if (/\bdiploma\b/i.test(t)) return "420";
  if (/\bcertificate\s+(iv|4)\b/i.test(t)) return "511";
  if (/\bcertificate\s+(iii|3)\b/i.test(t)) return "514";
  if (/\bcertificate\s+(ii|2)\b/i.test(t)) return "521";
  if (/\bcertificate\s+(i|1)\b/i.test(t)) return "524";
  return "";
}

function schoolYear(t: string): number {
  if (/\b(year\s?12|12th|xii|hsc|higher secondary|senior secondary|intermediate|plus two|\+2|a[- ]levels?|grade\s?12|class\s?12|pre[- ]university|puc)\b/i.test(t)) return 12;
  if (/\b(year\s?11|11th|grade\s?11|class\s?11)\b/i.test(t)) return 11;
  if (/\b(year\s?10|10th|ssc|sslc|secondary school (leaving )?certificate|matric(ulation)?|o[- ]levels?|grade\s?10|class\s?10|high school)\b/i.test(t)) return 10;
  return 0;
}

export function academicPrefill(docs: { category?: string; filename?: string; extracted?: Record<string, unknown> | null }[]): AcademicPrefill {
  const rows: AcademicPrefill["priorRows"] = [];
  let school = 0; let higher = false; let readable = 0;
  for (const doc of docs) {
    if (doc.category !== "Academic") continue;
    const x = doc.extracted ?? {};
    const get = (k: string) => String(x[k] ?? "").trim();
    const qualification = get("academic_qualification"); const program = get("academic_program"); const institution = get("academic_institution");
    const text = [qualification, program].filter(Boolean).join(" ") || String(doc.filename ?? "");
    if (!text.trim()) continue;
    const code = priorCode(text);
    if (code) {
      readable += 1; higher = true;
      // One row per level and place (the AVETMISS check refuses duplicate pairs); the first file's name is kept.
      const recognition = AUSTRALIAN.test(`${institution} ${text}`) ? "A" : "I";
      if (!rows.some((r) => r.code === code && r.recognition === recognition)) {
        const name = [qualification, program && program !== qualification ? program : ""].filter(Boolean).join(", ").slice(0, 200);
        rows.push({ code, recognition, name });
      }
      continue;
    }
    const year = schoolYear(`${text} ${institution}`);
    if (year) { readable += 1; school = Math.max(school, year); }
  }
  const level = school || (higher ? 12 : 0);
  const schoolLevel = level === 12 ? YEAR_12 : level === 11 ? "Year 11 or equivalent - 11" : level === 10 ? "Year 10 or equivalent - 10" : "";
  return { schoolLevel, priorRows: rows, readable };
}
