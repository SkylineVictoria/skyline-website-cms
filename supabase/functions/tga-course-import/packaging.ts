// Elective packaging rules of a qualification, read from the official packaging text, and the check of a course's
// electives against them. Pure (no network, no Deno API): the Edge Function enforces it on save and the CMS shows the
// same result while units are picked.

export interface GroupRule { groups: string[]; count: number; text: string }
export interface ElectiveRules {
  /** Electives the qualification needs ("7 elective units"), when the text states it. */
  required: number | null;
  /** "at least 2 must be chosen from Group A". */
  groupMin: GroupRule[];
  /** "1 unit only from Group A", "up to 2 units from Groups A-C". */
  groupMax: GroupRule[];
  /** Units from outside the qualification's own lists ("no more than 2 units from elsewhere"); 0 when the text allows none. */
  outsideMax: number;
  outsideText: string;
  /** Lines that read like a rule but could not be understood: staff must confirm them by hand. */
  unchecked: string[];
}
/** One elective on the course: `groups` null = not in the qualification's own lists (imported from elsewhere). */
export interface ElectiveUnit { code: string; groups: string[] | null }
export interface RuleLine { label: string; state: "met" | "pending" | "broken"; detail: string }
export interface RuleCheck { ok: boolean; complete: boolean; lines: RuleLine[] }

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, a: 1, an: 1,
};
const NUMBER = "(\\d+|" + Object.keys(WORDS).filter(word => word.length > 2).join("|") + "|an?)(?:\\s*\\(\\d+\\))?";
const number = (value: string) => /^\d+$/.test(value) ? Number(value) : WORDS[value.toLowerCase()] ?? NaN;

/** "Groups B, C, D or E", "Group A", "Groups A–C" → group letters (a range is expanded with the known groups). */
function groupList(text: string, known: string[]): string[] {
  const match = /\b[Gg]roups?\s+((?:[A-Z]{1,2}\b)(?:\s*(?:,|or|and|and\/or|&|[–—-]|to)\s*(?:[A-Z]{1,2}\b))*)/.exec(text);
  if (!match) return [];
  const range = /^([A-Z]{1,2})\s*(?:[–—-]|to)\s*([A-Z]{1,2})$/.exec(match[1].trim());
  if (range) {
    const inside = known.filter(key => key.length === range[1].length && range[1] <= key && key <= range[2]);
    return inside.length ? inside : [range[1], range[2]];
  }
  return [...new Set(match[1].match(/[A-Z]{1,2}\b/g) ?? [])];
}

const unitLine = /^[A-Z]{3,}[A-Z0-9]*\d{3}[A-Z]?\b/;
// The rules come before the unit lists; specialisation rules (after them, or under "Specialisations") are not checked here.
const stop = /^(?:core units?(?: of competency)?\s*(?:\(\d+\))?\s*:?|specialisations?)$/i;
const outside = /\b(?:elsewhere|training packages?|accredited course|imported|not listed)\b/i;
const upTo = new RegExp(`\\b(?:up to|no more than|not more than|a maximum of|maximum of)\\s+${NUMBER}\\b`, "i");
const atLeast = new RegExp(`\\b(?:at least|a minimum of|minimum of)\\s+${NUMBER}\\b`, "i");
const exact = new RegExp(`^${NUMBER}\\s+(?:elective\\s+)?units?\\s+only\\b`, "i");
const between = new RegExp(`^${NUMBER}\\s*(?:to|or|[–—-])\\s*${NUMBER}\\s+(?:elective\\s+)?units?\\b`, "i");
const mustFrom = new RegExp(`^${NUMBER}\\s+(?:elective\\s+)?units?\\s+must be (?:selected|chosen)\\s+from\\b`, "i");
// "1 from any endorsed Training Package", "plus one unit selected from any current training package",
// "One elective unit may be from any training package".
const fromOutside = new RegExp(`${NUMBER}\\s+(?:elective\\s+)?(?:units?\\s+)?(?:(?:may|can)\\s+be\\s+)?(?:selected\\s+|chosen\\s+)?(?:from\\s+(?:any|another|elsewhere|outside)|not listed)`, "i");
const anyNumber = new RegExp(`\\b${NUMBER}\\b`, "gi");
// Statements that are not a count to check.
const general = /\b(?:must (?:reflect|be relevant|still be met|ensure|be met|be complied|not|be assessed|be demonstrated|demonstrate)|care must be taken|prerequisite|specialisation|total number of units|consisting of|to achieve this qualification|following provides)\b/i;

export function parseElectiveRules(packagingRules: string, required: number | null, groups: string[]): ElectiveRules {
  const rules: ElectiveRules = { required, groupMin: [], groupMax: [], outsideMax: 0, outsideText: "", unchecked: [] };
  // After "for the remaining N elective units", an "up to N from Groups …" line is about those remaining units only.
  let remaining = false;
  for (const raw of packagingRules.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
    if (stop.test(line)) break;
    if (!line || unitLine.test(line)) continue;
    if (/^for the remaining\b/i.test(line)) { remaining = true; continue; }
    const max = upTo.exec(line), min = atLeast.exec(line), only = exact.exec(line), from = mustFrom.exec(line), range = between.exec(line);
    if (outside.test(line) && !min) {
      const single = fromOutside.exec(line);
      const numbers = [...new Set((line.match(anyNumber) ?? []).map(token => number(token.replace(/\s*\(\d+\)$/, ""))).filter(value => Number.isInteger(value) && value > 1))];
      const count = max ? number(max[1]) : single ? number(single[1]) : numbers.length === 1 ? numbers[0] : NaN;
      if (Number.isInteger(count)) {
        // Several lines can each allow outside units ("3 listed, or 2 listed and 1 from elsewhere"): the largest applies.
        if (count >= rules.outsideMax) { rules.outsideMax = count; rules.outsideText = line; }
      } else if (!general.test(line) && (line.match(anyNumber) ?? []).length) rules.unchecked.push(line);
      continue;
    }
    const named = groupList(line, groups);
    if (named.length) {
      if (/^all\b/i.test(line)) rules.unchecked.push(line);
      else if (only) {
        rules.groupMin.push({ groups: named, count: number(only[1]), text: line });
        rules.groupMax.push({ groups: named, count: number(only[1]), text: line });
      } else if (range) {
        rules.groupMin.push({ groups: named, count: number(range[1]), text: line });
        rules.groupMax.push({ groups: named, count: number(range[2]), text: line });
      } else if (min) rules.groupMin.push({ groups: named, count: number(min[1]), text: line });
      else if (max) { if (!remaining) rules.groupMax.push({ groups: named, count: number(max[1]), text: line }); }
      else if (from) rules.groupMin.push({ groups: named, count: number(from[1]), text: line });
      else if (/\b(?:must|only)\b/i.test(line) && !general.test(line)) rules.unchecked.push(line);
      continue;
    }
    if (general.test(line) || /\blisted\b/i.test(line) || /^\d+\s+(?:core|elective)/i.test(line) || /^\d+ units of competency$/i.test(line)) continue;
    if ((max || min || only || from || range) && /\b(?:units?|electives?)\b/i.test(line)) rules.unchecked.push(line);
  }
  for (const rule of [...rules.groupMin, ...rules.groupMax]) if (!Number.isInteger(rule.count)) rules.unchecked.push(rule.text);
  rules.groupMin = rules.groupMin.filter(rule => Number.isInteger(rule.count));
  rules.groupMax = rules.groupMax.filter(rule => Number.isInteger(rule.count));
  if (required === null) rules.unchecked.push("The packaging text does not state how many electives are needed.");
  rules.unchecked = [...new Set(rules.unchecked)];
  return rules;
}

const names = (groups: string[]) => (groups.length > 1 ? "Groups " : "Group ") + groups.join(", ");
const units = (count: number) => `${count} unit${count === 1 ? "" : "s"}`;

/** The course's electives (those already on it plus the ones being added) against the rules. `ok` false = a rule is
 *  broken and the units must not be saved; `complete` true = every rule is met in full. */
export function checkElectives(rules: ElectiveRules, electives: ElectiveUnit[]): RuleCheck {
  const lines: RuleLine[] = [];
  const total = electives.length;
  const inGroups = (groups: string[]) => electives.filter(unit => unit.groups?.some(group => groups.includes(group))).length;
  // Lines that could not be read (streams, "all of Group A" …) may change what the group counts mean: then only the
  // total blocks, the other lines are shown for information and staff confirm the selection by hand.
  const strict = rules.unchecked.length === 0;
  const broken = strict ? "broken" as const : "pending" as const;
  if (rules.required !== null) {
    lines.push({ label: `${rules.required} electives in total`,
      state: total > rules.required ? "broken" : total === rules.required ? "met" : "pending",
      detail: total > rules.required ? `${total} chosen: ${total - rules.required} too many` : total === rules.required ? `${total} of ${rules.required}` : `${total} of ${rules.required}: ${rules.required - total} more needed` });
  }
  let shortfall = 0;
  for (const rule of rules.groupMin) {
    const have = inGroups(rule.groups);
    shortfall += Math.max(0, rule.count - have);
    lines.push({ label: `At least ${rule.count} from ${names(rule.groups)}`, state: have >= rule.count ? "met" : "pending",
      detail: have >= rule.count ? `${have} chosen` : `${have} of ${rule.count}: ${rule.count - have} more needed` });
  }
  for (const rule of rules.groupMax) {
    const have = inGroups(rule.groups);
    lines.push({ label: `No more than ${rule.count} from ${names(rule.groups)}`, state: have > rule.count ? broken : "met",
      detail: have > rule.count ? `${have} chosen: ${have - rule.count} too many` : `${have} chosen` });
  }
  const imported = electives.filter(unit => unit.groups === null).length;
  if (imported || rules.outsideMax) {
    lines.push({ label: rules.outsideMax ? `No more than ${rules.outsideMax} from outside this qualification` : "No units from outside this qualification",
      state: imported > rules.outsideMax ? broken : "met",
      detail: imported > rules.outsideMax ? `${imported} chosen: ${imported - rules.outsideMax} too many` : `${imported} chosen` });
  }
  if (rules.required !== null && total <= rules.required && shortfall > rules.required - total) {
    lines.push({ label: "Places left for the group minimums", state: broken,
      detail: `${units(shortfall)} still needed from the groups above, but only ${rules.required - total} of ${rules.required} places are left` });
  }
  const ok = lines.every(line => line.state !== "broken");
  return { ok, complete: ok && lines.every(line => line.state === "met"), lines };
}

/** Unit codes named in a prerequisite text ("BSBWHS411 Implement …", "Nil" → none). */
export function prerequisiteCodes(text: string | null | undefined, self = ""): string[] {
  const found = (text ?? "").toUpperCase().match(/\b[A-Z]{3,}[A-Z0-9]*\d{3}[A-Z]?\b/g) ?? [];
  return [...new Set(found)].filter(code => code !== self.toUpperCase());
}
