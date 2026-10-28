export interface Qualification {
  institution: string;
  qualification: string;
  program: string;
  year: string;
  result: string;
  /** Files that created the entry; empty for an entry made by hand. */
  documentIds: string[];
}

const PARTS = ["institution", "qualification", "program", "year", "result"] as const;

/** Entries in data.academicQualifications; older entries used academic_* keys. */
export function readQualifications(data: Record<string, unknown> | undefined): Qualification[] {
  const list = data?.academicQualifications;
  if (!Array.isArray(list)) return [];
  const text = (entry: Record<string, unknown>, key: string) => String(entry[key] ?? entry[`academic_${key}`] ?? "").trim();
  return list.map((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    return {
      institution: text(entry, "institution"),
      qualification: text(entry, "qualification"),
      program: text(entry, "program"),
      year: text(entry, "year"),
      result: text(entry, "result"),
      documentIds: Array.isArray(entry.documentIds) ? entry.documentIds.map(String) : [],
    };
  });
}

export function qualificationTitle(item: Qualification): string {
  return item.qualification || item.program || "Qualification";
}

export function qualificationDetail(item: Qualification): string {
  return [item.institution, item.program !== item.qualification ? item.program : "", item.year, item.result].filter(Boolean).join(" · ");
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The qualifications to submit: the list, plus the single institution / qualification / year
 * fields when they describe something the list does not already hold (all of it when the list is empty).
 */
export function submittedQualifications(list: Qualification[], values: Record<string, unknown>): Qualification[] {
  const field = (key: string) => (typeof values[`academic_${key}`] === "string" ? (values[`academic_${key}`] as string).trim() : "");
  const single: Qualification = { institution: field("institution"), qualification: field("qualification"), program: field("program"), year: field("year"), result: field("result"), documentIds: [] };
  const entries = list.filter((item) => PARTS.some((part) => item[part]));
  if (PARTS.some((part) => single[part]) && !entries.some((item) => same(item.institution, single.institution) && same(item.qualification, single.qualification) && same(item.year, single.year))) {
    entries.push(single);
  }
  return entries;
}
