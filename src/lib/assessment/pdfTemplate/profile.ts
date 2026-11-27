/**
 * ASM-ANY-LAYOUT (owner 2026-11-27): layout profiles. When an admin saves a workbook found by the generic rules, what they decided
 * (fields kept, changed, added on an empty area, rejected) is stored as a profile of that layout, recognised by the running header and
 * footer (numbers ignored, so another unit's workbook of the same design matches). On the next workbook of that layout the profile is
 * applied first, so its decisions need no AI. Pure (the signature uses Web Crypto, available in browsers and Node).
 */
import type { PageModel } from "./pageModel";
import { pageChrome, type Candidate } from "./candidates";
import type { GenericResult } from "./generic";
import type { AutoKey, FieldKind, FieldRole, PdfTemplate, TemplateField } from "./model";
import { toFraction } from "./model";

export interface Correction {
  /** The area, independent of its place: shape and the text printed around it (numbers ignored). */
  key: string;
  /** What the area is; null = not a field. */
  set: { role: FieldRole; kind: FieldKind; dataKey?: AutoKey | null; option?: string | null; checklist?: TemplateField["checklist"] } | null;
}
export interface LayoutProfile { signature: string; chrome: string[]; corrections: Correction[] }

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\S*\d\S*/g, "#").replace(/[^a-z#☐ ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

/** The running header / footer texts of the workbook (numbers as #), sorted: what identifies its layout. */
export function layoutChrome(models: PageModel[]): string[] {
  const chrome = pageChrome(models);
  const out = new Set<string>();
  models.forEach((m, i) => {
    for (const t of m.texts) if (t.y + t.h <= chrome[i].top + 1 || t.y >= chrome[i].bottom - 1) { const s = norm(t.s); if (s && s !== "#") out.add(s); }
  });
  return [...out].sort();
}

export async function layoutSignature(chrome: string[]): Promise<string> {
  const data = new TextEncoder().encode(`asm-layout/1\n${chrome.join("\n")}`);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An area's text key: shape and the words around it; an area with no words around it is known by its place (10 pt steps). */
export const areaKey = (c: Candidate) => {
  const ctx = [norm(c.left), norm(c.column), norm(c.tickLabel), c.left || c.column ? "" : norm(c.above)];
  return [c.shape, ...ctx, ctx.some(Boolean) ? "" : `@${Math.round(c.box.x / 10)},${Math.round(c.box.y / 10)}`].join("|");
};
/** Keys made unique: the n-th area with the same key in the document (page order) gets #n, so repeated rows keep their own decision. */
export function areaKeys(candidates: Candidate[]): Map<string, string> {
  const seen = new Map<string, number>(); const out = new Map<string, string>();
  for (const c of [...candidates].sort((a, b) => a.page - b.page || a.box.y - b.box.y || a.box.x - b.box.x)) {
    const k = areaKey(c); const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); out.set(c.id, `${k}#${n}`);
  }
  return out;
}

/** The candidate a field was made from (rules g<page>-<n>, AI ai<page>-<n>), else the candidate it covers. */
function candidateOf(f: TemplateField, byId: Map<string, Candidate>, result: GenericResult): Candidate | null {
  const m = /^(?:g|ai)(\d+)-(\d+)x*$/.exec(f.id);
  if (m) return byId.get(`p${m[1]}c${m[2]}`) ?? null;
  // a field added by hand on an empty area: the candidate it covers
  const size = result.sizes?.[f.page] ?? { W: 1, H: 1 };
  let best: Candidate | null = null; let bestIou = 0;
  for (const c of result.candidates) {
    if (c.page !== f.page) continue;
    const r = toFraction(c.page, size.W, size.H, c.box);
    const ix = Math.max(0, Math.min(r.x + r.w, f.x + f.w) - Math.max(r.x, f.x)); const iy = Math.max(0, Math.min(r.y + r.h, f.y + f.h) - Math.max(r.y, f.y));
    const inter = ix * iy; const iou = inter / (r.w * r.h + f.w * f.h - inter || 1);
    if (iou > bestIou) { bestIou = iou; best = c; }
  }
  return bestIou > 0.7 ? best : null;
}

/** What the admin decided, as corrections: every candidate whose final state is not what the rules alone gave. */
export function correctionsFrom(result: GenericResult, saved: PdfTemplate): Correction[] {
  const byId = new Map(result.candidates.map((c) => [c.id, c] as const));
  const final = new Map<string, TemplateField>();
  for (const f of saved.fields) { const c = candidateOf(f, byId, result); if (c) final.set(c.id, f); }
  const ruleFields = new Map<string, TemplateField>();
  for (const f of result.template.fields) { const c = candidateOf(f, byId, result); if (c && f.origin === "rules") ruleFields.set(c.id, f); }
  const out = new Map<string, Correction>();
  const keys = areaKeys(result.candidates);
  for (const c of result.candidates) {
    const f = final.get(c.id); const r = ruleFields.get(c.id);
    const set = f ? { role: f.role, kind: f.kind, dataKey: f.dataKey ?? null, option: f.option ?? null, checklist: f.checklist ?? null } : null;
    const same = r && f && r.role === f.role && r.kind === f.kind && (r.dataKey ?? null) === (f.dataKey ?? null);
    if (same) continue;
    if (!f && !r && result.settledBy[c.id] !== "none" && result.settledBy[c.id] !== "ai") continue; // never decided: nothing to keep
    out.set(keys.get(c.id)!, { key: keys.get(c.id)!, set });
  }
  return [...out.values()];
}

/**
 * Applies a profile before any AI: a candidate whose key has a correction becomes that field (origin "profile") or no field; its
 * rules field, if any, is replaced. Returns how many candidates it settled.
 */
export function applyProfile(result: GenericResult, profile: LayoutProfile | null): number {
  if (!profile?.corrections.length) return 0;
  const byKey = new Map(profile.corrections.map((c) => [c.key, c] as const));
  const t = result.template;
  let settled = 0;
  const keys = areaKeys(result.candidates);
  for (const c of result.candidates) {
    const corr = byKey.get(keys.get(c.id)!);
    if (!corr) continue;
    const own = (f: TemplateField) => { const m = /^(?:g|ai)(\d+)-(\d+)x*$/.exec(f.id); return !!m && `p${m[1]}c${m[2]}` === c.id; };
    const was = t.fields.find(own);
    t.fields = t.fields.filter((f) => !own(f));
    result.unresolved = result.unresolved.filter((u) => u.id !== c.id);
    settled++;
    if (!corr.set) { result.settledBy[c.id] = "none"; continue; }
    const size = result.sizes?.[c.page] ?? { W: 595.32, H: 841.92 };
    const label = [c.left, c.column].filter(Boolean).join(" · ").slice(0, 160) || c.above.slice(0, 160) || "Field";
    let id = `g${c.page}-${c.n}`; while (t.fields.some((f) => f.id === id)) id += "x";
    const field: TemplateField = { id, ...toFraction(c.page, size.W, size.H, c.box), role: corr.set.role, kind: corr.set.kind, questionKey: corr.set.role === "student" ? was?.questionKey ?? null : null, label: was?.label ?? label, origin: "profile" };
    if (was?.table && field.kind === "table_cell") field.table = was.table;
    if (corr.set.dataKey) field.dataKey = corr.set.dataKey;
    if (corr.set.option) field.option = corr.set.option;
    if (corr.set.checklist) field.checklist = corr.set.checklist;
    if (field.kind === "yes_no" || field.kind === "rating") field.group = `pf${c.page}-${Math.round(c.box.y / 4)}`;
    t.fields.push(field);
    result.settledBy[c.id] = "rules";
  }
  return settled;
}
