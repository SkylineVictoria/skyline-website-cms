// training.gov.au public API: one unit of competency's release, mapping and published content (application, unit
// sector, prerequisites, elements and performance criteria, foundation skills, assessment requirements).
// The HTML parsers are pure so they can be tested without the network.

const API = "https://training.gov.au/api/training/";
type Json = Record<string, unknown>;
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === "object") : [];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
export function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Block-level text lines of an HTML fragment: paragraphs, list items, rows and headings each start a line. */
export function lines(html: string): string[] {
  return decode(html.replace(/<(?:p|li|tr|h\d|div|ul|ol)\b[^>]*>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}
const text = (html: string) => lines(html).join("\n");

/** Table body rows as arrays of cell HTML (header cells are skipped). */
export function rows(html: string): string[][] {
  return html.split(/<tr\b[^>]*>/i).slice(1).map(row =>
    [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1])).filter(cells => cells.length > 0);
}

export type ElementKind = "element" | "performance_criterion" | "performance_evidence" | "knowledge_evidence" | "assessment_condition" | "foundation_skill";
export interface UnitElement { kind: ElementKind; code: string; text: string; parent?: string }

const guidance = /^(?:elements describe|performance criteria describe|this section describes)/i;
/** "1 Plan work" + "1.1 Identify…" rows → elements with their performance criteria (parent = element code). */
export function parseElements(html: string): UnitElement[] {
  const out: UnitElement[] = [];
  rows(html).forEach((cells, index) => {
    const [elementLines, criteriaLines] = [lines(cells[0] ?? ""), lines(cells[1] ?? "")];
    if (!elementLines.length || guidance.test(elementLines[0])) return;
    const element = /^(\d+)\.?\s+(.+)$/.exec(elementLines.join(" "));
    const code = element?.[1] ?? String(index);
    out.push({ kind: "element", code, text: element?.[2] ?? elementLines.join(" ") });
    for (const line of criteriaLines) {
      if (guidance.test(line)) continue;
      const criterion = /^(\d+\.\d+)\.?\s+(.+)$/.exec(line);
      out.push({ kind: "performance_criterion", code: criterion?.[1] ?? "", text: criterion?.[2] ?? line, parent: code });
    }
  });
  return out;
}

/** Skill | description table → one row per description line, coded by the skill ("Reading"). Prose → one row. */
export function parseFoundationSkills(html: string): UnitElement[] {
  const table = rows(html).filter(cells => cells.length >= 2);
  if (!table.length) return lines(html).filter(line => !guidance.test(line)).map(line => ({ kind: "foundation_skill", code: "", text: line }));
  return table.flatMap(cells => {
    const skill = lines(cells[0]).join(" ");
    return lines(cells[1]).map(line => ({ kind: "foundation_skill" as const, code: skill.slice(0, 40), text: line }));
  }).filter(row => row.code && !guidance.test(row.code)
    // Some releases repeat the "Skill | Description" header as a body row (sometimes spaced, e.g. "S KILL").
    && row.code.replace(/\s+/g, "").toLowerCase() !== "skill" && row.text.toLowerCase() !== "description");
}

export const parseList = (kind: ElementKind, html: string): UnitElement[] => lines(html).map(line => ({ kind, code: "", text: line }));

export interface UnitDetails {
  releaseNumber: string | null; releaseDate: string | null; usage: string | null; developer: string | null;
  supersedesCode: string | null; supersedesTitle: string | null; supersedesEquivalent: boolean | null; companionUrl: string | null;
  application: string | null; sector: string | null; prerequisites: string | null; elements: UnitElement[];
}

/** Content bundle items by lower-cased title (Default + Assessment Requirements bundles). */
export function unitContent(items: { title: string; content: string }[]) {
  const by = (pattern: RegExp) => items.find(item => pattern.test(item.title))?.content ?? "";
  const elements = [
    ...parseElements(by(/^elements and performance criteria$/i)),
    ...parseFoundationSkills(by(/^foundation skills$/i)),
    ...parseList("performance_evidence", by(/^performance evidence$/i)),
    ...parseList("knowledge_evidence", by(/^knowledge evidence$/i)),
    ...parseList("assessment_condition", by(/^assessment conditions$/i)),
  ].map(row => ({ ...row, text: row.text.slice(0, 4000) })).filter(row => row.text.trim());
  const prerequisites = text(by(/pre-?requisite/i));
  return { application: text(by(/^application$/i)) || null, sector: text(by(/^unit sector$/i)) || null,
    prerequisites: prerequisites || null, elements };
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(12_000), headers: { Accept: "application/json" } });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`); }
  return await response.json();
}

export interface UnitSummary { code: string; title: string; usage: string; current: boolean; packageCode: string; packageTitle: string }
/** What a code is on training.gov.au: null when it is not there or is not a unit of competency. */
export async function unitSummary(code: string): Promise<UnitSummary | null> {
  let main: Json;
  try {
    main = await getJson(`${API}${encodeURIComponent(code)}`) as Json;
  } catch (error) {
    if (error instanceof Error && error.message === "HTTP 404") return null;
    throw error;
  }
  if (String(main.type ?? "").toLowerCase() !== "unit" || String(main.code ?? "").toUpperCase() !== code.toUpperCase()) return null;
  const parent = (main.parent ?? {}) as Json;
  const usage = String(main.usageRecommendationLabel ?? main.usageRecommendation ?? "");
  return { code: String(main.code).toUpperCase(), title: text(String(main.title ?? "")), usage,
    current: String(main.usageRecommendation ?? usage).toLowerCase() === "current",
    packageCode: String(parent.code ?? ""), packageTitle: String(parent.title ?? "") };
}

export async function unitDetails(code: string): Promise<UnitDetails> {
  const main = await getJson(`${API}${encodeURIComponent(code)}`) as Json;
  const releases = list(main.releases);
  const current = releases.find(release => release.currency === "current") ?? releases[0];
  const releaseNumber = current ? String(current.releaseNumber ?? "") : "";
  const mapping = list(main.mappingInformation).find(item => item.code === code && item.mapsToCode && item.mapsToCode !== code);
  const developer = (main.trainingPackageDeveloper ?? {}) as Json;
  let items: { title: string; content: string }[] = [];
  let companionUrl: string | null = null;
  if (releaseNumber) {
    const release = await getJson(`${API}${encodeURIComponent(code)}/releases/${encodeURIComponent(releaseNumber)}?include=All`) as Json;
    companionUrl = String(list(release.externalLinks)[0]?.url ?? "") || null;
    const bundles = await Promise.all(list(release.contentBundles).map(bundle => {
      const href = list(bundle.links).find(link => link.rel === "self")?.href;
      return typeof href === "string" && href.startsWith("https://training.gov.au/api/") ? getJson(href).catch(() => null) : Promise.resolve(null);
    }));
    items = bundles.flatMap(bundle => list((bundle as Json | null)?.items))
      .map(item => ({ title: String(item.title ?? ""), content: String(item.content ?? "") }));
  }
  return {
    releaseNumber: releaseNumber || null, releaseDate: current ? String(current.releaseDate ?? "").slice(0, 10) || null : null,
    usage: String(main.usageRecommendationLabel ?? main.usageRecommendation ?? "") || null, developer: String(developer.name ?? "") || null,
    supersedesCode: mapping ? String(mapping.mapsToCode) : null, supersedesTitle: mapping ? String(mapping.mapsToTitle ?? "") || null : null,
    supersedesEquivalent: typeof mapping?.isEquivalent === "boolean" ? mapping.isEquivalent : null, companionUrl,
    ...unitContent(items),
  };
}
