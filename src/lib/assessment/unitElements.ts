/**
 * ASM-BUILDER (2026-11-25): the unit's elements, performance criteria, performance evidence, knowledge evidence and assessment
 * conditions loaded from training.gov.au (tga-course-import "unit_content", cached per unit code) and merged into the unit's
 * own list (asm_unit_elements through asm_admin unit_elements_save), and the AI mapping suggestions grouped per requirement.
 *
 * The merge never drops what staff added by hand: a training.gov.au row updates the row with the same kind and code (or, without
 * a code, the same text); rows not on training.gov.au stay, after them. A new performance criterion needs its element's id, so
 * when its element is new too the merge is run a second time on the saved list (`pending` says so).
 */
export interface TgaElement { kind: string; code: string; text: string; parent?: string }
export interface UnitElementRow { id: string; kind: string; parentId: string | null; code: string; text: string; sort: number; isActive?: boolean }
export interface ElementSaveItem { id?: string; kind: string; parentId?: string; code: string; text: string; sort: number }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const keyOf = (kind: string, code: string, text: string) => `${kind}|${code.trim() ? norm(code) : norm(text)}`;
/** The kinds a question can give evidence for (an element is covered through its performance criteria). */
export const MAPPABLE_KINDS = ["performance_criterion", "performance_evidence", "knowledge_evidence", "assessment_condition"];

export function tgaMerge(existing: UnitElementRow[], tga: TgaElement[]): { items: ElementSaveItem[]; pending: number; added: number; updated: number } {
  const active = existing.filter((e) => e.isActive !== false);
  const byKey = new Map(active.map((e) => [keyOf(e.kind, e.code, e.text), e]));
  const elementId = (code: string | undefined) => (code ? active.find((e) => e.kind === "element" && norm(e.code) === norm(code))?.id : undefined);
  const used = new Set<string>();
  const items: ElementSaveItem[] = [];
  let pending = 0; let added = 0; let updated = 0;
  tga.forEach((t, i) => {
    const hit = byKey.get(keyOf(t.kind, t.code, t.text));
    const parentId = t.kind === "performance_criterion" ? elementId(t.parent) : undefined;
    if (hit && !used.has(hit.id)) {
      used.add(hit.id);
      if (hit.text !== t.text || (parentId && hit.parentId !== parentId)) updated += 1;
      items.push({ id: hit.id, kind: t.kind, parentId: parentId ?? hit.parentId ?? undefined, code: t.code, text: t.text, sort: i });
      return;
    }
    if (t.kind === "performance_criterion" && t.parent && !parentId) { pending += 1; return; }
    added += 1;
    items.push({ kind: t.kind, parentId, code: t.code, text: t.text, sort: i });
  });
  active.filter((e) => !used.has(e.id)).forEach((e, j) => items.push({ id: e.id, kind: e.kind, parentId: e.parentId ?? undefined, code: e.code, text: e.text, sort: tga.length + j }));
  return { items, pending, added: added + pending, updated };
}

export interface MappingSuggestionRow {
  id: string; questionId: string; elementId: string; confidence: number; reason: string; model: string | null;
  state: "suggested" | "confirmed" | "dismissed"; suggestedAt: string; decidedAt: string | null; decidedBy: string | null;
}

/** Open and confirmed suggestions per requirement, in the unit's order; dismissed ones and unknown requirements left out. */
export function suggestionsByElement<E extends { id: string }>(rows: MappingSuggestionRow[], elements: E[]): { element: E; rows: MappingSuggestionRow[] }[] {
  const by = new Map<string, MappingSuggestionRow[]>();
  for (const r of rows) {
    if (r.state === "dismissed") continue;
    by.set(r.elementId, [...(by.get(r.elementId) ?? []), r]);
  }
  return elements.filter((e) => by.has(e.id)).map((e) => ({ element: e, rows: (by.get(e.id) ?? []).sort((a, b) => b.confidence - a.confidence) }));
}
