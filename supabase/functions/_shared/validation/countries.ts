// The country list every application country select uses, and the normaliser that maps what a document or a person wrote
// (ISO alpha-2 / alpha-3 codes, MRZ codes, demonyms, common spellings) to one of those exact option values. Pure: no I/O.

/** [option, ...codes and names it is also known by]. The option text is the exact value the form's selects hold. */
const COUNTRIES: Array<[string, ...string[]]> = [
  ["Australia", "au", "aus", "australian", "commonwealth of australia"],
  ["Afghanistan", "af", "afg", "afghan", "islamic republic of afghanistan"],
  ["Bangladesh", "bd", "bgd", "bangladeshi", "peoples republic of bangladesh"],
  ["Bhutan", "bt", "btn", "bhutanese", "kingdom of bhutan"],
  ["Brazil", "br", "bra", "brazilian", "federative republic of brazil"],
  ["Cambodia", "kh", "khm", "cambodian", "kampuchea", "kingdom of cambodia"],
  ["Canada", "ca", "can", "canadian"],
  ["China", "cn", "chn", "chinese", "peoples republic of china", "prc", "mainland china"],
  ["Colombia", "co", "col", "colombian", "republic of colombia"],
  ["Fiji", "fj", "fji", "fijian", "fiji islands", "republic of fiji"],
  ["France", "fr", "fra", "french", "french republic"],
  ["Germany", "de", "deu", "d", "ger", "german", "deutschland", "federal republic of germany"],
  ["Hong Kong", "hk", "hkg", "hong kong sar", "hong kong special administrative region", "hong konger", "hongkonger", "china hong kong sar"],
  ["India", "in", "ind", "indian", "bharat", "republic of india"],
  ["Indonesia", "id", "idn", "indonesian", "republic of indonesia"],
  ["Ireland", "ie", "irl", "irish", "eire", "republic of ireland"],
  ["Italy", "it", "ita", "italian", "italia", "italian republic"],
  ["Japan", "jp", "jpn", "japanese", "nippon"],
  ["Kenya", "ke", "ken", "kenyan", "republic of kenya"],
  ["Korea, Republic of", "kr", "kor", "korean", "south korean", "south korea", "republic of korea", "korea", "korea south", "korea republic of", "rok"],
  ["Kuwait", "kw", "kwt", "kuwaiti", "state of kuwait"],
  ["Malaysia", "my", "mys", "malaysian"],
  ["Maldives", "mv", "mdv", "maldivian", "republic of maldives", "republic of the maldives"],
  ["Mauritius", "mu", "mus", "mauritian", "republic of mauritius"],
  ["Mexico", "mx", "mex", "mexican", "united mexican states"],
  ["Myanmar", "mm", "mmr", "burmese", "burma", "myanma", "union of myanmar"],
  ["Nepal", "np", "npl", "nepali", "nepalese", "federal democratic republic of nepal"],
  ["Netherlands", "nl", "nld", "nld", "dutch", "holland", "netherlander", "kingdom of the netherlands"],
  ["New Zealand", "nz", "nzl", "new zealander", "kiwi"],
  ["Nigeria", "ng", "nga", "nigerian", "federal republic of nigeria"],
  ["Oman", "om", "omn", "omani", "sultanate of oman"],
  ["Pakistan", "pk", "pak", "pakistani", "islamic republic of pakistan"],
  ["Papua New Guinea", "pg", "png", "papua new guinean", "independent state of papua new guinea"],
  ["Peru", "pe", "per", "peruvian", "republic of peru"],
  ["Philippines", "ph", "phl", "filipino", "filipina", "philippine", "republic of the philippines"],
  ["Poland", "pl", "pol", "polish", "pole", "republic of poland"],
  ["Portugal", "pt", "prt", "portuguese", "portuguese republic"],
  ["Qatar", "qa", "qat", "qatari", "state of qatar"],
  ["Russian Federation", "ru", "rus", "russian", "russia"],
  ["Saudi Arabia", "sa", "sau", "saudi", "saudi arabian", "kingdom of saudi arabia", "ksa"],
  ["Singapore", "sg", "sgp", "singaporean", "republic of singapore"],
  ["South Africa", "za", "zaf", "rsa", "south african", "republic of south africa"],
  ["Spain", "es", "esp", "spanish", "espana", "kingdom of spain"],
  ["Sri Lanka", "lk", "lka", "sri lankan", "ceylon", "democratic socialist republic of sri lanka"],
  ["Sweden", "se", "swe", "swedish", "kingdom of sweden"],
  ["Switzerland", "ch", "che", "swiss", "swiss confederation"],
  ["Taiwan", "tw", "twn", "taiwanese", "chinese taipei", "taiwan province of china", "republic of china taiwan"],
  ["Tanzania, the United Republic of", "tz", "tza", "tanzanian", "tanzania", "united republic of tanzania"],
  ["Thailand", "th", "tha", "thai", "kingdom of thailand"],
  ["Turkey", "tr", "tur", "turkish", "turkiye", "republic of turkey", "republic of turkiye"],
  ["Uganda", "ug", "uga", "ugandan", "republic of uganda"],
  ["Ukraine", "ua", "ukr", "ukrainian"],
  ["United Arab Emirates", "ae", "are", "emirati", "emirian", "uae"],
  ["United Kingdom", "gb", "gbr", "gbd", "gbn", "gbo", "gbp", "gbs", "uk", "british", "great britain", "england", "scottish", "welsh", "northern irish", "united kingdom of great britain and northern ireland"],
  ["United States", "us", "usa", "american", "united states of america", "us citizen", "america"],
  ["Viet Nam", "vn", "vnm", "vietnam", "vietnamese", "socialist republic of viet nam", "socialist republic of vietnam"],
  ["Zimbabwe", "zw", "zwe", "zimbabwean", "republic of zimbabwe"],
];

export const COUNTRY_OPTIONS = COUNTRIES.map(([option]) => option) as readonly string[];

/** Lower case, accents and punctuation removed, "&" read as "and", a leading "the" dropped, words separated by single spaces. */
function key(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
}

const INDEX = new Map<string, string>();
for (const [option, ...names] of COUNTRIES) for (const name of [option, ...names]) INDEX.set(key(name), option);

/** Words a document adds around the country (a passport reads "REPUBLIC OF INDIA", a form "Indian citizen"). */
const WRAPPERS = [/^(?:the )?(?:republic|kingdom|state|federation|commonwealth|union|sultanate|federal republic|peoples republic|democratic republic|islamic republic) of /, / (?:citizen|national|nationality|passport)$/];

/** The exact country option for a code, demonym or spelling, or null when it is not one of the form's countries. */
export function normaliseCountry(raw: string): string | null {
  let text = key(raw);
  if (!text) return null;
  for (let pass = 0; pass < 3; pass += 1) {
    const found = INDEX.get(text);
    if (found) return found;
    const stripped = WRAPPERS.reduce((current, pattern) => key(current.replace(pattern, "")), text);
    if (stripped === text) return null;
    text = stripped;
  }
  return INDEX.get(text) ?? null;
}

/** The fields of an extraction that hold a country the form selects from the list. */
export const COUNTRY_SELECT_FIELDS = ["nationality", "citizenship", "issuing_country", "birth_country", "au_country", "ov_country"] as const;

const FIELD_NAMES: Record<string, string> = { nationality: "Nationality", citizenship: "Citizenship", issuing_country: "Issuing country", birth_country: "Country of birth", au_country: "Country", ov_country: "Country" };

/**
 * Maps the country fields of an extraction to exact option values. A value that matches no option is taken out of the fields
 * (a select cannot hold it) and returned with a note, so it is shown for the agent to enter rather than silently lost.
 */
export function normaliseCountryFields(fields: Record<string, string>): { fields: Record<string, string>; unmatched: Record<string, string>; notes: string[] } {
  const out = { ...fields };
  const unmatched: Record<string, string> = {};
  const notes: string[] = [];
  for (const name of COUNTRY_SELECT_FIELDS) {
    const raw = out[name];
    if (raw === undefined) continue;
    const option = normaliseCountry(raw);
    if (option) out[name] = option;
    else {
      delete out[name];
      unmatched[name] = raw;
      notes.push(`${FIELD_NAMES[name]} "${raw}" was read from the document but is not in the country list. Choose it manually.`);
    }
  }
  return { fields: out, unmatched, notes };
}
