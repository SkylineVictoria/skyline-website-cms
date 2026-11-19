import { DOMParser, type Element } from "npm:@xmldom/xmldom@0.9.12";

// Contract: TrainingComponentServiceV13.svc?singleWsdl (SOAP 1.1 Training
// binding and embedded V13 data-contract XSD). The SDK resolves ReleaseFile
// paths relative to /TrainingComponentFiles/ on the register's web host.
const namespace = "http://training.gov.au/services/13/";
const endpoint = "https://ws.sandbox.training.gov.au/Deewr.Tga.WebServices/TrainingComponentServiceV13.svc/Training";
const soapNamespace = "http://schemas.xmlsoap.org/soap/envelope/";
const authorIt = "http://www.authorit.com/xml/authorit";
const codePattern = /^[A-Z][A-Z0-9]{4,19}$/;
const xmlEscape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const children = (parent: Element | undefined, name?: string, ns = namespace) =>
  Array.from(parent?.childNodes ?? []).filter((node): node is Element =>
    node.nodeType === 1 && (node as Element).namespaceURI === ns && (!name || (node as Element).localName === name));
const child = (parent: Element | undefined, name: string, ns = namespace) => children(parent, name, ns)[0];
const content = (node?: Element) => normalize(node?.textContent ?? "");
const field = (parent: Element | undefined, name: string, ns = namespace) => content(child(parent, name, ns));

export class ImportError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

function parseXml(xml: string) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new ImportError("The government service returned prohibited XML markup.");
  try {
    return new DOMParser({ onError: () => { throw new Error("Invalid XML"); } }).parseFromString(xml.replace(/^\uFEFF/, ""), "application/xml").documentElement;
  } catch {
    throw new ImportError("The government service returned invalid XML.");
  }
}

async function readXml(response: Response, source: string) {
  const reader = response.body?.getReader();
  if (!reader) throw new ImportError(`${source} returned an empty response.`);
  let phase = "download";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value: bytes, done } = await reader.read();
      if (done) break;
      size += bytes.byteLength;
      if (size > 5_000_000) throw new ImportError("The government XML response exceeded the import size limit.");
      // Own the bytes before another read can reuse the runtime buffer.
      chunks.push(bytes.slice());
    }
    phase = "assemble";
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    phase = "decode";
    // XML encoding is determined by BOM, HTTP charset, then XML signature.
    // WCF may return UTF-16 even when the request is UTF-8.
    const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
    const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le"
      : data[0] === 0xfe && data[1] === 0xff ? "utf-16be"
      : data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? "utf-8"
      : charset || (data[0] === 0 && data[1] === 0x3c ? "utf-16be"
        : data[0] === 0x3c && data[1] === 0 ? "utf-16le" : "utf-8");
    if (!/^(utf-?8|utf-?16(le|be)?|us-ascii)$/i.test(encoding)) {
      throw new ImportError(`${source} returned an unsupported XML character encoding.`);
    }
    const decoded = new TextDecoder(encoding, { fatal: true }).decode(data);
    phase = "parse";
    return parseXml(decoded) ?? undefined;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    // Only fixed diagnostics: never log response bodies or credentials.
    const kind = error instanceof Error && ["TypeError", "RangeError", "AbortError", "TimeoutError"].includes(error.name)
      ? error.name : "Error";
    const detail = error instanceof Error ? error.message : "";
    const reason = /detach/i.test(detail) ? "detached-buffer"
      : /decompress|gzip|brotli|deflate/i.test(detail) ? "compression"
      : /premature|unexpected.*eof|end of file|incomplete/i.test(detail) ? "incomplete-body"
      : /abort|timeout/i.test(detail) ? "timeout"
      : /reset|closed|connection/i.test(detail) ? "connection-closed" : "unclassified";
    console.warn("tga-course-import response failure", { phase, bytes: size, status: response.status, kind, reason });
    throw new ImportError(phase === "download"
      ? `${source} response download failed (${kind}; ${reason}; ${size} bytes received).`
      : `${source} XML ${phase} failed (${kind}; ${reason}; ${size} bytes received).`);
  } finally {
    // Supabase's runtime may close a response stream as soon as it is
    // consumed. Cleanup should never replace the response or original error.
    try { await reader.cancel(); } catch { /* Already closed. */ }
  }
}

async function discardResponse(response: Response) {
  try { await response.body?.cancel(); } catch { /* Already closed. */ }
}

async function soap(op: "Search" | "GetDetails", request: string) {
  const username = Deno.env.get("EF_TGA_SANDBOX_USERNAME");
  const password = Deno.env.get("EF_TGA_SANDBOX_PASSWORD");
  if (!username || !password) throw new ImportError("The Training.gov.au sandbox credentials have not been configured on the server.", 503);
  const now = Date.now();
  const envelope = `<s:Envelope xmlns:s="${soapNamespace}" xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
<s:Header><o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
<u:Timestamp u:Id="_0"><u:Created>${new Date(now).toISOString()}</u:Created><u:Expires>${new Date(now + 300_000).toISOString()}</u:Expires></u:Timestamp>
<o:UsernameToken u:Id="token"><o:Username>${xmlEscape(username)}</o:Username><o:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${xmlEscape(password)}</o:Password></o:UsernameToken>
</o:Security></s:Header><s:Body><${op} xmlns="${namespace}"><request>${request}</request></${op}></s:Body></s:Envelope>`;
  const response = await fetch(endpoint, {
    method: "POST", body: envelope, redirect: "error", signal: AbortSignal.timeout(18_000),
    headers: { "Accept-Encoding": "identity", "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${namespace}ITrainingComponentService/${op}"` },
  }).catch(() => { throw new ImportError(`The Training.gov.au sandbox did not respond to ${op}.`); });

  const source = `Training.gov.au sandbox ${op}`;
  if (!response.ok && response.status !== 500) {
    await discardResponse(response);
    throw new ImportError(`${source} returned HTTP ${response.status}.`);
  }
  const root = await readXml(response, source).catch((error: unknown) => {
    if (response.ok) throw error;
    throw new ImportError(`${source} returned HTTP ${response.status}.`);
  });
  const body = child(root, "Body", soapNamespace);
  const fault = child(body, "Fault", soapNamespace);
  if (fault) {
    const reason = Array.from(fault.childNodes).find(node =>
      node.nodeType === 1 && (node as Element).localName === "faultstring")?.textContent ?? "";
    if (/security token|authentication|invalid credentials|username.*password/i.test(reason)) {
      throw new ImportError(`${source} rejected the WS-Security credentials.`);
    }
    if (/deserializ|serializ|invalid.*request|required member/i.test(reason)) {
      throw new ImportError(`${source} rejected the SOAP request format.`);
    }
    throw new ImportError(`${source} returned a SOAP fault (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new ImportError(`${source} returned HTTP ${response.status}.`);
  const result = child(child(body, op + "Response"), op + "Result");
  if (!result) throw new ImportError(`Training.gov.au returned an unexpected ${op} response.`);
  return result;
}

export async function searchQualifications(query: string) {
  const result = await soap("Search", `<PageNumber>1</PageNumber><PageSize>25</PageSize>
<Filter>${xmlEscape(query)}</Filter><SearchCode>true</SearchCode><SearchTitle>true</SearchTitle>
<TrainingComponentTypes><IncludeQualification>true</IncludeQualification></TrainingComponentTypes>`);
  const rows = children(child(result, "Results"), "TrainingComponentSummary")
    .filter(row => field(row, "ComponentType") === "Qualification")
    .map(row => ({ code: field(row, "Code"), name: field(row, "Title"), status: field(row, "CurrencyStatus") }));
  return rows.filter(row => codePattern.test(row.code) && row.name);
}


// NCVER publishes a tab-delimited national reporting dataset, not a live hours API.
// Unknown and ambiguous unit codes remain null; never manufacture hours.
const NCVER_HOURS_URL = "https://www.ncver.edu.au/sites/default/files/ncver-documents/Nationally-agreed-hours.txt";
let hoursCache: { expires: number; values: Map<string, number> } | null = null;
async function nationallyAgreedHours(): Promise<Map<string, number>> {
  if (hoursCache && hoursCache.expires > Date.now()) return hoursCache.values;
  const response = await fetch(NCVER_HOURS_URL, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("NCVER hours unavailable");
  const data = await response.text();
  if (data.length > 3_000_000 || !data.startsWith("Subject Id")) throw new Error("Invalid NCVER hours file");
  const values = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const line of data.split(/\r?\n/).slice(1)) {
    const [code, flag, raw] = line.split("\t");
    const hours = Number(raw);
    if (!code || !/^[A-Z][A-Z0-9]{4,19}$/.test(code) || !/^[A-Z]$/.test(flag ?? "") ||
        !Number.isInteger(hours) || hours < 0 || hours > 10000) continue;
    if (values.has(code) && values.get(code) !== hours) ambiguous.add(code);
    else values.set(code, hours);
  }
  for (const code of ambiguous) values.delete(code);
  hoursCache = { expires: Date.now() + 86400000, values };
  return values;
}
/** Hours by unit code from the database copy of the NCVER file (public.tga_nominal_hours). */
export type HoursLookup = (codes: string[]) => Promise<Map<string, number>>;
async function attachNominalHours<T extends { code: string }>(units: T[], lookup: HoursLookup | null): Promise<(T & { nominalHours: number | null; hoursSource: string | null })[]> {
  let hours = new Map<string, number>();
  // The Edge runtime often cannot download the NCVER file in time; the database copy is the primary source.
  if (lookup && units.length) { try { hours = await lookup(units.map(unit => unit.code)); } catch { /* Fall back to the file. */ } }
  if (!hours.size) { try { hours = await nationallyAgreedHours(); } catch { hours = new Map(); } }
  return units.map(unit => ({ ...unit, nominalHours: hours.get(unit.code) ?? null,
    hoursSource: hours.has(unit.code) ? "NCVER nationally agreed nominal hours (2026)" : null }));
}

// Public, unauthenticated registers. Every source is optional: a failure is reported in `sources` and the import continues.
const TGA_API = "https://training.gov.au/api/";
const CRICOS_API = "https://data.gov.au/data/api/3/action/datastore_search";
const CRICOS_COURSES = "48cacf69-2082-415e-9595-f17d0c3a4af0";
const CRICOS_COURSE_LOCATIONS = "4cd2de02-8ba3-4eb2-bac2-fe272cae3f5f";
type Json = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? normalize(value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")) : "";
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === "object") : [];

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(12_000), headers: { Accept: "application/json" } });
  if (!response.ok) { await discardResponse(response); throw new Error(`HTTP ${response.status}`); }
  const body = await response.text();
  if (body.length > 3_000_000) throw new Error("response too large");
  return JSON.parse(body);
}

export type Source = { name: string; ok: boolean; detail: string };
async function attempt<T>(sources: Source[], name: string, run: () => Promise<T>): Promise<T | null> {
  try { const value = await run(); sources.push({ name, ok: true, detail: "" }); return value; }
  catch (error) { sources.push({ name, ok: false, detail: error instanceof Error ? error.message.slice(0, 120) : "failed" }); return null; }
}
const money = (value: unknown) => {
  const amount = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return String(value ?? "").trim() && Number.isFinite(amount) ? amount : null;
};

/** training.gov.au public API: classification, mapping, developer, occupations, specialisations, unit grid, documents. */
async function publicQualification(code: string, releaseNumber: string, sources: Source[]) {
  const base = `${TGA_API}training/${encodeURIComponent(code)}`;
  const [summary, classes, release, grid] = await Promise.all([
    attempt(sources, "Training.gov.au qualification", () => getJson(base)),
    attempt(sources, "Training.gov.au classification", () => getJson(`${base}/classification`)),
    attempt(sources, "Training.gov.au release", () => getJson(`${base}/releases/${encodeURIComponent(releaseNumber)}?include=All`)),
    attempt(sources, "Training.gov.au unit grid", () => getJson(`${base}/releases/${encodeURIComponent(releaseNumber)}/unitgrid`)),
  ]);
  const main = (summary ?? {}) as Json;
  const rel = (release ?? {}) as Json;
  const scheme = (code: string) => list(classes).find(item => item.schemeCode === code);
  const anzsco = scheme("01"), field = scheme("04"), level = scheme("05");
  const mapping = list(main.mappingInformation).find(item => item.code === code && item.mapsToCode);
  const developer = (main.trainingPackageDeveloper ?? {}) as Json;
  const taxonomy = (main.taxonomy ?? {}) as Json;
  const overview = list(rel.links).find(link => link.rel === "content-overview")?.href;
  const bundle = typeof overview === "string" && overview.startsWith(TGA_API)
    ? await attempt(sources, "Training.gov.au content", () => getJson(overview)) : null;
  const items = list((bundle as Json | null)?.items);
  const item = (title: string) => text(items.find(entry => String(entry.title ?? "").toLowerCase() === title)?.content);
  return {
    government: {
      anzscoCode: String(anzsco?.valueCode ?? ""), anzscoTitle: text(anzsco?.valueDescription ?? anzsco?.value),
      fieldOfEducationCode: String(field?.valueCode ?? ""), fieldOfEducation: text(field?.valueDescription ?? field?.value),
      qualificationLevel: text(level?.value),
      developer: text(developer.name), developerUrl: Array.isArray(developer.webAddresses) ? String(developer.webAddresses[0] ?? "") : "",
      usageRecommendation: text(main.usageRecommendationLabel ?? main.usageRecommendation),
      supersedesCode: String(mapping?.mapsToCode ?? ""), supersedesTitle: text(mapping?.mapsToTitle),
      supersedesEquivalent: typeof mapping?.isEquivalent === "boolean" ? mapping.isEquivalent : null,
      occupations: list(taxonomy.occupations).map(entry => text(entry.occupation)).filter(Boolean),
      industrySectors: list(taxonomy.industrySectors).map(entry => text(entry.industrySector)).filter(Boolean),
      foundationSkills: item("foundation skills outcomes"),
      documents: list(rel.assets).filter(asset => asset.isAvailable !== false && typeof asset.url === "string")
        .map(asset => ({ name: String(asset.name ?? ""), url: String(asset.url), type: String(asset.type ?? "") })),
      companionUrl: String(list(rel.externalLinks)[0]?.url ?? ""),
    },
    description: item("qualification description"),
    /** The release's unit counts ({ core: 1, elective: 9 }), when the public API gives them. */
    packagingCounts: { core: Number(((rel.packagingInformation ?? {}) as Json).core) || null, elective: Number(((rel.packagingInformation ?? {}) as Json).elective) || null },
    specialisations: list(rel.specializations).map(entry => {
      const packaging = (entry.packagingInformation ?? {}) as Json;
      return { code: String(entry.code ?? ""), title: text(entry.title), core: Number(packaging.core) || 0, elective: Number(packaging.elective) || 0 };
    }).filter(entry => entry.code && entry.elective > 0),
    unitGrid: new Map(list(grid).map(unit => [String(unit.code ?? "").toUpperCase(), {
      title: text(unit.title), essential: unit.isEssential === true, hasPrerequisites: unit.hasPreRequisites === true,
      usage: text(unit.usageRecommendationLabel ?? unit.usageRecommendation),
    }])),
  };
}

/** CRICOS register (data.gov.au): this provider's registration of the qualification, with fees, duration and locations. */
async function cricosCourse(code: string, providerCode: string | null, sources: Source[]) {
  if (!providerCode || !/^[0-9]{5}[A-Z]$/.test(providerCode)) {
    sources.push({ name: "CRICOS register", ok: false, detail: "No CRICOS provider code in Settings" });
    return null;
  }
  const search = (resource: string, filters: Json) =>
    getJson(`${CRICOS_API}?resource_id=${resource}&limit=20&filters=${encodeURIComponent(JSON.stringify(filters))}`)
      .then(data => list(((data as Json).result as Json | undefined)?.records));
  const rows = await attempt(sources, "CRICOS register", () => search(CRICOS_COURSES, { "CRICOS Provider Code": providerCode, "VET National Code": code }));
  if (!rows) return null;
  const row = rows.find(entry => entry.Expired !== "Yes") ?? rows[0];
  if (!row) return { registered: false as const, providerCode };
  const courseCode = String(row["CRICOS Course Code"] ?? "");
  const locations = await attempt(sources, "CRICOS locations", () =>
    search(CRICOS_COURSE_LOCATIONS, { "CRICOS Provider Code": providerCode, "CRICOS Course Code": courseCode }));
  const work = row["Work Component"] === "Yes"
    ? [row["Work Component Total Hours"] && `${row["Work Component Total Hours"]} hours`, row["Work Component Weeks"] && `${row["Work Component Weeks"]} weeks`].filter(Boolean).join(", ") || "Yes"
    : "No";
  return {
    registered: true as const, providerCode, courseCode, courseName: text(row["Course Name"]),
    durationWeeks: Number.isInteger(Number(row["Duration (Weeks)"])) ? Number(row["Duration (Weeks)"]) : null,
    tuitionFee: money(row["Tuition Fee"]), nonTuitionFee: money(row["Non Tuition Fee"]), totalCost: money(row["Estimated Total Course Cost"]),
    courseLevel: text(row["Course Level"]),
    fieldOfEducation: [row["Field of Education 1 Detailed Field"], row["Field of Education 2 Detailed Field"]].map(text).filter(Boolean).join("; "),
    workComponent: work, language: text(row["Course Language"]), dualQualification: row["Dual Qualification"] === "Yes",
    expired: row.Expired === "Yes",
    locations: (locations ?? []).map(entry => ({ name: text(entry["Location Name"]), city: text(entry["Location City"]), state: text(entry["Location State"]) })),
  };
}

type Unit = { code: string; name: string; groups: string[] };
const parts = (parent: Element | undefined, name: string) => children(parent, name, authorIt);
const part = (parent: Element | undefined, name: string) => child(parent, name, authorIt);
const value = (parent: Element | undefined, name: string) => field(parent, name, authorIt);

function releaseVariables(book: Element) {
  return new Map(parts(part(book, "VariableAssignments"), "VariableAssignment")
    .map(assignment => [value(assignment, "Name"), value(assignment, "Value")]));
}

export function parseQualificationRelease(xml: string, code: string, releaseNumber: string) {
  return parseRelease(parseXml(xml) ?? undefined, code, releaseNumber);
}

function parseRelease(root: Element | undefined, code: string, releaseNumber: string) {
  const objects = part(root, "Objects");
  const variables = parts(objects, "Book").map(releaseVariables)
    .find(book => book.get("Code") === code && book.get("ReleaseNumber") === releaseNumber);
  if (!variables) throw new ImportError("The government release XML does not identify the requested qualification and release.");
  const topics = parts(objects, "Topic");
  const section = (heading: string) => part(topics.find(topic =>
    value(part(topic, "Headings"), "PrintHeading").toLowerCase() === heading), "Text");
  const packaging = section("packaging rules");
  // Author-it releases nest paragraphs, tables and unit lists inside formatting
  // elements. Reading only direct children loses those units (often showing 0/0).
  // Extract text from leaf blocks while retaining the document's order.
  const lines: string[] = [];
  function collectLines(node: Element | undefined) {
    if (!node) return;
    const elements = Array.from(node.childNodes).filter(
      (item): item is Element => item.nodeType === 1,
    );
    // A paragraph with its own words beside inline markup ("<b>1</b> core unit, plus <b>9</b> elective units") is one line:
    // reading only its elements kept the bold numbers and lost the words (AUR40226 showed "1", "9", "9", "2").
    const ownText = Array.from(node.childNodes).some(item => item.nodeType === 3 && (item.textContent ?? "").trim());
    if (!elements.length || ownText) {
      const line = content(node);
      if (line) lines.push(line);
      return;
    }
    for (const element of elements) collectLines(element);
  }
  collectLines(packaging);
  // Reassemble code/title cells split by Author-it table markup.
  const normalizedLines: string[] = [];
  const codeOnly = /^[A-Z]{2,10}[A-Z0-9]*\d[A-Z0-9]*$/;
  // A "*" after the code marks a unit with prerequisites; it can be its own cell between the code and the title.
  const unmark = (line: string) => line.replace(/\s*\*+$/, "");
  const cells = lines.filter(line => !/^\*+$/.test(line));
  lines.splice(0, lines.length, ...cells);
  for (let i = 0; i < lines.length; i++) {
    const line = unmark(lines[i]);
    if (codeOnly.test(line) && i + 1 < lines.length && !codeOnly.test(unmark(lines[i + 1])) &&
        !/^(?:core|elective) units?\b|^electives?\b|^group\s/i.test(lines[i + 1])) {
      normalizedLines.push(line + " " + lines[++i]);
    } else normalizedLines.push(line);
  }
  lines.splice(0, lines.length, ...normalizedLines);
  // Headings vary by release: "Core units", "Core units (8):", "Core units of competency"; "Elective units", "Electives".
  const coreStart = lines.findIndex(line => /^core units?(?: of competency)?\s*(?:\(\d+\))?\s*:?$/i.test(line));
  const electiveHeading = lines.findIndex(line => /^(?:elective units?(?: of competency)?|electives)\s*(?:\(\d+\))?\s*:?$/i.test(line));
  // Some releases have no electives heading: the first "Group A …" heading after the core list starts the electives.
  const electiveStart = electiveHeading >= 0 || coreStart < 0 ? electiveHeading
    : lines.findIndex((line, index) => index > coreStart && /^Group [A-Z]{1,2}(?:\s*[-–—:]\s*|\s+)\S/.test(line));
  const unitPattern = /^([A-Z]{2,10}[A-Z0-9]*\d[A-Z0-9]*)\s+(.+)$/;
  if (!lines.length) throw new ImportError("The government release XML has no packaging rules.");

  const core: Unit[] = [];
  const electives = new Map<string, Unit>();
  const groups: Record<string, string> = {};
  let group = "";
  let complete = coreStart >= 0 && electiveStart > coreStart;
  for (const [index, line] of lines.entries()) {
    if (index <= coreStart || index === electiveHeading || index < coreStart) continue;
    // Specialisations and following prose are not part of the unit grid.
    if (index > electiveStart && /^(?:Specialisations|Qualification Mapping|Links|Companion Volumes)$/i.test(line)) break;
    // "Group A – Title", "Group A: Title" or "Group A Asphalt Surfacing"; specialisation groups can be two letters (YA–YK).
    const heading = /^Group ([A-Z]{1,2})(?:\s*[-–—:]\s*|\s+)(.+)$/.exec(line);
    if (index >= electiveStart && heading) {
      group = heading[1].toUpperCase();
      groups[group] = heading[2];
      continue;
    }
    // "General Electives": units after it belong to no lettered group (GEN), not to the group above them.
    if (index >= electiveStart && /^General electives?(?:\s+units?)?$/i.test(line)) {
      group = "GEN";
      groups[group] = "General electives";
      continue;
    }
    const unit = unitPattern.exec(line);
    if (!unit) {
      // Formatting, headings and prose in the official release are not units.
      // Do not treat these as corrupt unit records.
      continue;
    }
    if (index < electiveStart) {
      core.push({ code: unit[1], name: unit[2], groups: [] });
    } else {
      const existing = electives.get(unit[1]) ?? { code: unit[1], name: unit[2], groups: [] };
      if (existing.name !== unit[2]) complete = false;
      if (group && !existing.groups.includes(group)) existing.groups.push(group);
      electives.set(unit[1], existing);
    }
  }

  const heading = lines.map(line => /^Total number of units\s*[:=]\s*(\d+)\b/i.exec(line)).find(Boolean);
  const coreCount = lines.map(line => /^(\d+)\s+core units?\b/i.exec(line)).find(Boolean);
  // "9 elective units", or "1 core unit, plus 9 elective units, of which:".
  const electiveCount = lines.map(line => /^(\d+)\s+elective(?:s|\s+units?)\b/i.exec(line) ?? /^\d+\s+core units?,?\s+plus\s+(\d+)\s+elective(?:s|\s+units?)\b/i.exec(line)).find(Boolean);
  const total = Number(heading?.[1]);
  const requiredElectives = Number(electiveCount?.[1]);
  const validCounts = total === Number(coreCount?.[1]) + requiredElectives && core.length === Number(coreCount?.[1])
    && new Set(core.map(unit => unit.code)).size === core.length && core.every(unit => !electives.has(unit.code))
    && electives.size >= requiredElectives;
  let minimumGroup: { group: string; count: number } | null = null;
  // Only enable saving for prose formats whose constraints are fully understood.
  // The allowance for units from other qualifications ("up to 6 units may be from … another Training Package") is not a rule
  // on the listed electives, so it does not stop the check.
  const plain = coreStart >= 0 && !Object.keys(groups).length && !lines.some(line => !/(?:training package|accredited course)/i.test(line) && /\b(?:must be selected from|up to \d+ units|at least \d+ units|specialisation|must be selected from the list|must be imported)\b/i.test(line));
  const grouped = /^(?:at least )?(\d+) elective units must be selected from Group ([A-Z])\b/i.exec(lines.find(line => /elective units must be selected from Group/i.test(line)) ?? "");
  const remaining = /^(?:for the remaining )(\d+) elective units\b/i.exec(lines.find(line => /for the remaining \d+ elective units/i.test(line)) ?? "");
  const range = /^up to (\d+) units may be selected from Groups ([A-Z])\s*[–-]\s*([A-Z])\b/i.exec(lines.find(line => /units may be selected from Groups/i.test(line)) ?? "");
  const outsideRule = lines.some(line => /^if not listed, up to \d+ units may be selected from a Certificate IV, Diploma or Advanced Diploma from this or any other currently endorsed Training Package qualification or accredited course\.?$/i.test(line));
  const relevanceRule = lines.some(line => /^Elective units must be relevant to the work environment and the qualification, maintain the integrity of the AQF alignment and contribute to a valid, industry-supported vocational outcome\.?$/i.test(line));
  if (grouped && remaining && range && outsideRule && relevanceRule &&
      Number(grouped[1]) + Number(remaining[1]) === requiredElectives && Number(range[1]) === Number(remaining[1]) &&
      Object.hasOwn(groups, grouped[2]) && Object.keys(groups).every(key => range[2] <= key && key <= range[3]) &&
      [...electives.values()].every(unit => unit.groups.length > 0)) {
    minimumGroup = { count: Number(grouped[1]), group: grouped[2] };
  }

  return {
    aqf: variables.get("AqfAlignment") ?? "",
    description: children(section("qualification description"), undefined, authorIt).map(content).filter(Boolean).join("\n\n"),
    entryRequirements: children(section("entry requirements"), undefined, authorIt).map(content).filter(Boolean).join("\n"),
    packagingRules: lines.join("\n"), core, electives: [...electives.values()], groups, minimumGroup,
    requiredElectives: Number.isInteger(requiredElectives) ? requiredElectives : null,
    canValidate: complete && validCounts && (plain || minimumGroup !== null),
    requiresElectiveAttestation: minimumGroup !== null,
  };
}

export async function qualificationDetails(code: string, providerCode: string | null = null, hoursLookup: HoursLookup | null = null) {
  if (!codePattern.test(code)) throw new ImportError("Enter a valid qualification code.", 400);
  const result = await soap("GetDetails", `<Code>${code}</Code><InformationRequest>
<ShowFiles>true</ShowFiles><ShowReleases>true</ShowReleases><ShowUnitGrid>true</ShowUnitGrid></InformationRequest>`);
  const name = field(result, "Title");
  if (field(result, "Code") !== code || field(result, "ComponentType") !== "Qualification" || !name) {
    throw new ImportError("Training.gov.au did not return this qualification.", 404);
  }

  const releases = children(child(result, "Releases"), "Release");
  const current = releases.filter(release => /^current$/i.test(field(release, "Currency")));
  if (current.length !== 1) throw new ImportError("Training.gov.au did not return one current release for this qualification.");
  const release = current[0];
  const releaseNumber = field(release, "ReleaseNumber");
  const packageCode = field(result, "ParentCode");
  const filePaths = children(child(release, "Files"), "ReleaseFile")
    .map(file => field(file, "RelativePath").replaceAll("\\", "/").replace(/^\/+/, ""));
  const path = filePaths.find(item => /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.xml$/i.test(item));
  if (!path || !releaseNumber) throw new ImportError("The current SOAP release has no supported qualification XML file.");
  const response = await fetch(`https://training.gov.au/TrainingComponentFiles/${path}`, {
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new ImportError("The published Training.gov.au qualification XML could not be reached."); });
  if (!response.ok) {
    await discardResponse(response);
    throw new ImportError(`The government qualification XML returned HTTP ${response.status}.`);
  }
  const rules = parseRelease(await readXml(response, "The published Training.gov.au qualification XML"), code, releaseNumber);
  const sources: Source[] = [];
  const [registry, cricos] = await Promise.all([publicQualification(code, releaseNumber, sources), cricosCourse(code, providerCode, sources)]);
  const grid = registry.unitGrid;
  // The public unit grid is authoritative for core/elective when the release XML layout could not be read.
  const fromGrid = (essential: boolean) => [...grid.entries()].filter(([, unit]) => unit.essential === essential)
    .map(([unitCode, unit]) => ({ code: unitCode, name: unit.title, groups: [] as string[] }));
  const coreUnits = rules.core.length ? rules.core : fromGrid(true);
  const electiveUnits = rules.electives.length ? rules.electives : fromGrid(false);
  if (!coreUnits.length && !electiveUnits.length) {
    throw new ImportError("The official packaging rules loaded, but no core or elective units could be extracted from the release. Import is blocked to prevent an incomplete course.", 422);
  }
  const withGrid = <T extends { code: string }>(units: T[]) => units.map(unit => ({
    ...unit, hasPrerequisites: grid.get(unit.code)?.hasPrerequisites ?? null, usageRecommendation: grid.get(unit.code)?.usage ?? "",
  }));
  const [core, electives] = await Promise.all([attachNominalHours(withGrid(coreUnits), hoursLookup), attachNominalHours(withGrid(electiveUnits), hoursLookup)]);
  const review = {
    ...rules, core, electives,
    // The packaging text's elective count, else the release's count on training.gov.au.
    requiredElectives: rules.requiredElectives ?? registry.packagingCounts.elective,
    description: rules.description || registry.description,
    // A fallback unit list from the grid has no packaging text to check, so it always needs manual confirmation.
    canValidate: rules.canValidate && coreUnits === rules.core,
    government: registry.government, specialisations: registry.specialisations, cricos,
    code, name, packageCode, packageName: field(result, "ParentTitle"),
    status: field(result, "CurrencyStatus"), releaseNumber, releaseDate: field(release, "ReleaseDate"),
  };
  // Source diagnostics vary between calls, so they are not part of the revision the save is checked against.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(review)));
  const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { ...review, sources: sources.sort((a, b) => a.name.localeCompare(b.name)), revision };
}

export function selectedUnits(review: Awaited<ReturnType<typeof qualificationDetails>>, codes: unknown, attested: unknown, specialisation: unknown = null) {
  if (!Array.isArray(codes) || new Set(codes).size !== codes.length) throw new ImportError("Select distinct electives.", 422);
  const electives = review.electives.filter(unit => codes.includes(unit.code));
  if (electives.length !== codes.length) throw new ImportError("Select electives listed in this qualification release.", 422);
  const spec = review.specialisations.find(item => item.code === specialisation) ?? null;
  if (specialisation && !spec) throw new ImportError("Choose a specialisation listed for this release.", 422);
  // A specialisation is optional; without one the release-level rules below apply.
  const units = () => ({
    specialisation: spec,
    units: [
      ...review.core.map(unit => ({ ...row(unit), type: "core" })),
      ...electives.map(unit => ({ ...row(unit), type: "elective" })),
    ],
  });
  if (spec) {
    // Training.gov.au publishes the core and elective counts of each specialisation; group rules are confirmed by the user.
    if (codes.length !== spec.elective) throw new ImportError(`${spec.title} needs ${spec.elective} electives.`, 422);
    if (spec.core && review.core.length !== spec.core) throw new ImportError(`${spec.title} needs ${spec.core} core units; the release lists ${review.core.length}.`, 422);
    if (attested !== true) throw new ImportError("Confirm the selected units meet the official packaging rules.", 422);
    return units();
  }
  if (!review.canValidate) {
    // Rules the importer cannot check: the RTO Manager reviews them against the official packaging rules and confirms.
    if (review.electives.length && !codes.length) throw new ImportError("Select the electives for this course.", 422);
    if (attested !== true) throw new ImportError("Confirm the selected units meet the official packaging rules.", 422);
    return units();
  }
  if (codes.length !== review.requiredElectives) throw new ImportError(`Select ${review.requiredElectives} distinct electives.`, 422);
  const minimum = review.minimumGroup;
  if (minimum && electives.filter(unit => unit.groups.includes(minimum.group)).length < minimum.count) {
    throw new ImportError(`Select at least ${minimum.count} electives from Group ${minimum.group}.`, 422);
  }
  if (review.requiresElectiveAttestation && attested !== true) {
    throw new ImportError("Confirm the selected electives meet the qualification's relevance requirements.", 422);
  }
  return units();
}

type ReviewUnit = Awaited<ReturnType<typeof qualificationDetails>>["core"][number];
const row = (unit: ReviewUnit) => ({
  code: unit.code, name: unit.name, nominalHours: unit.nominalHours, hoursSource: unit.hoursSource,
  hasPrerequisites: unit.hasPrerequisites, usageRecommendation: unit.usageRecommendation, groups: unit.groups.join(", "),
});

// ---- An RTO's scope of registration (training.gov.au public API): the qualifications it may deliver.
export type ScopeQualification = { code: string; title: string; status: string; endDate: string; current: boolean };
const QUALIFICATION_CODE = /^[A-Z]{3}\d{5}$/;
const CODE_KEYS = ["code", "trainingComponentCode", "nrtCode", "componentCode"];
const TITLE_KEYS = ["title", "name", "trainingComponentTitle", "componentTitle"];
const END_KEYS = ["endDate", "scopeEndDate", "extentEndDate", "registrationEndDate"];
const STATUS_KEYS = ["status", "scopeStatus", "currencyStatus", "usageRecommendation"];
const firstString = (item: Json, keys: string[]) => {
  for (const key of keys) { const v = item[key]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return "";
};

/** Every qualification found anywhere in a scope response (field names vary between API versions). */
export function scopeQualifications(body: unknown, today = new Date().toISOString().slice(0, 10)): ScopeQualification[] {
  const found = new Map<string, ScopeQualification>();
  const walk = (value: unknown, inherited: { endDate: string; status: string }, depth: number) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item, inherited, depth + 1); return; }
    const item = value as Json;
    const endDate = firstString(item, END_KEYS).slice(0, 10) || inherited.endDate;
    const status = firstString(item, STATUS_KEYS) || inherited.status;
    const code = firstString(item, CODE_KEYS).toUpperCase();
    const title = text(firstString(item, TITLE_KEYS));
    if (QUALIFICATION_CODE.test(code) && title) {
      const current = (!endDate || endDate >= today) && !/superseded|deleted|expired|non.?current/i.test(status);
      const prev = found.get(code);
      if (!prev || (current && !prev.current)) found.set(code, { code, title, status, endDate, current });
    }
    for (const nested of Object.values(item)) walk(nested, { endDate, status }, depth + 1);
  };
  walk(body, { endDate: "", status: "" }, 0);
  return [...found.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** A short description of a response with no qualifications, so the endpoint can be adjusted. */
function shape(body: unknown) {
  if (Array.isArray(body)) return `array of ${body.length}${body[0] && typeof body[0] === "object" ? ` (${Object.keys(body[0] as Json).slice(0, 12).join(", ")})` : ""}`;
  if (body && typeof body === "object") return `object (${Object.keys(body as Json).slice(0, 12).join(", ")})`;
  return typeof body;
}

export async function rtoScope(rtoCode: string) {
  const code = rtoCode.trim();
  if (!/^\d{4,6}$/.test(code)) throw new ImportError("Set the RTO code (4 to 6 digits) in Settings first.", 422);
  const urls = [
    `${TGA_API}organisation/${code}/scope`,
    `${TGA_API}organisation/${code}/scope?includeImplicit=false`,
    `${TGA_API}organisation/${code}`,
  ];
  const tried: string[] = [];
  for (const url of urls) {
    try {
      const body = await getJson(url);
      const items = scopeQualifications(body);
      if (items.length) return { rto: code, source: url, items };
      tried.push(`${url.replace(TGA_API, "")}: no qualifications (${shape(body)})`);
    } catch (error) {
      tried.push(`${url.replace(TGA_API, "")}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  throw new ImportError(`Training.gov.au did not return the scope of RTO ${code}. ${tried.join("; ")}`.slice(0, 600), 502);
}

/** Core units of a release, ready for rto_tga_import_save (electives are chosen later on the course). */
export function coreUnits(review: Awaited<ReturnType<typeof qualificationDetails>>) {
  return review.core.map((unit) => ({ ...row(unit), type: "core" }));
}
