// The part of the application form definition the submission PDF needs, and how a stored value decides whether a field or section is shown.

export interface PdfCondition { field: string; equals: string[] }
export interface PdfField { name: string; label: string; type: string; format?: string; showIf?: PdfCondition; options?: string[] }
export interface PdfSection { title: string; showIf?: PdfCondition; fields: PdfField[] }

interface SourceField { name: string; label: string; type: string; format?: string; showIf?: PdfCondition; options?: string[] }
interface SourceSection { title?: string; showIf?: PdfCondition; fields: SourceField[] }

/** "12. APPLICATION CHECKLIST" -> "Application checklist"; titles that are already mixed case are kept. */
export function sectionTitle(raw: string | undefined): string {
  const text = String(raw ?? "").replace(/^\s*\d+[a-z]?\.\s*/i, "").trim();
  if (!text || text !== text.toUpperCase()) return text;
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Types that carry no answer. */
export const NON_ANSWER_TYPES = new Set(["static", "file", "table"]);

/** Reduces the application form definition to what the PDF prints (file, note and table fields stay listed so their keys are never mistaken for unknown answers) (option lists are kept only where the option text is the printed answer). */
export function toPdfSections(sections: readonly SourceSection[]): PdfSection[] {
  return sections.map((section) => ({
    title: sectionTitle(section.title),
    ...(section.showIf ? { showIf: section.showIf } : {}),
    fields: section.fields.map((f) => ({
      name: f.name, label: f.label, type: f.type,
      ...(f.format ? { format: f.format } : {}),
      ...(f.showIf ? { showIf: f.showIf } : {}),
      ...((f.type === "terms" || (f.type === "checkbox" && (f.options?.length ?? 0) <= 6)) && f.options ? { options: f.options } : {}),
    })),
  }));
}

const same = (a: unknown, b: string) => String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/** A field or section with a condition is shown only while the controlling answer is one of the listed values. */
export function conditionMet(condition: PdfCondition | undefined, values: Record<string, unknown>): boolean {
  if (!condition) return true;
  const answer = values[condition.field];
  const list = Array.isArray(answer) ? answer : [answer];
  return condition.equals.some((expected) => list.some((a) => same(a, expected)));
}
