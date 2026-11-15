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
    if (!elements.length) {
      const line = content(node);
      if (line) lines.push(line);
      return;
    }
    for (const element of elements) collectLines(element);
  }
  collectLines(packaging);
  const coreStart = lines.findIndex(line => /^core units:?$/i.test(line));
  const electiveStart = lines.findIndex(line => /^elective units:?$/i.test(line));
  const unitPattern = /^([A-Z][A-Z0-9]{4,19})\s+(.+)$/;
  if (!lines.length) throw new ImportError("The government release XML has no packaging rules.");

  const core: Unit[] = [];
  const electives = new Map<string, Unit>();
  const groups: Record<string, string> = {};
  let group = "";
  let complete = coreStart >= 0 && electiveStart > coreStart;
  for (const [index, line] of lines.entries()) {
    if (index <= coreStart || index === electiveStart) continue;
    const heading = /^Group ([A-Z])\s*[-–—:]\s*(.+)$/i.exec(line);
    if (index > electiveStart && heading) {
      group = heading[1].toUpperCase();
      groups[group] = heading[2];
      continue;
    }
    const unit = unitPattern.exec(line);
    if (!unit) { complete = false; continue; }
    if (index < electiveStart) {
      core.push({ code: unit[1], name: unit[2], groups: [] });
    } else {
      const existing = electives.get(unit[1]) ?? { code: unit[1], name: unit[2], groups: [] };
      if (existing.name !== unit[2]) complete = false;
      if (group && !existing.groups.includes(group)) existing.groups.push(group);
      electives.set(unit[1], existing);
    }
  }

  const heading = /^Total number of units\s*=\s*(\d+)$/i.exec(lines[0] ?? "");
  const coreCount = /^(\d+) core units? plus$/i.exec(lines[1] ?? "");
  const electiveCount = /^(\d+) elective units?(?:, of which:)?$/i.exec(lines[2] ?? "");
  const total = Number(heading?.[1]);
  const requiredElectives = Number(electiveCount?.[1]);
  const validCounts = total === Number(coreCount?.[1]) + requiredElectives && core.length === Number(coreCount?.[1])
    && new Set(core.map(unit => unit.code)).size === core.length && core.every(unit => !electives.has(unit.code))
    && electives.size >= requiredElectives;
  let minimumGroup: { group: string; count: number } | null = null;
  // Only enable saving for prose formats whose constraints are fully understood.
  const plain = coreStart === 3 && !Object.keys(groups).length && !lines[2]?.includes(",");
  const grouped = /^(\d+) elective units must be selected from Group ([A-Z])$/.exec(lines[3] ?? "");
  const remaining = /^(?:for the remaining )(\d+) elective units:$/.exec(lines[4] ?? "");
  const range = /^up to (\d+) units may be selected from Groups ([A-Z]) [–-] ([A-Z])$/.exec(lines[5] ?? "");
  const outsideRule = /^if not listed, up to \d+ units may be selected from a Certificate IV, Diploma or Advanced Diploma from this or any other currently endorsed Training Package qualification or accredited course\.$/.test(lines[6] ?? "");
  const relevanceRule = /^Elective units must be relevant to the work environment and the qualification, maintain the integrity of the AQF alignment and contribute to a valid, industry-supported vocational outcome\.$/.test(lines[7] ?? "");
  if (grouped && remaining && range && outsideRule && relevanceRule && lines[8] === "Specialisations" &&
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

export async function qualificationDetails(code: string) {
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
  const review = {
    ...rules,
    code, name, packageCode, packageName: field(result, "ParentTitle"),
    status: field(result, "CurrencyStatus"), releaseNumber, releaseDate: field(release, "ReleaseDate"),
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(review)));
  const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { ...review, revision };
}

export function selectedUnits(review: Awaited<ReturnType<typeof qualificationDetails>>, codes: unknown, attested: unknown) {
  if (!review.canValidate) throw new ImportError("This release's packaging could not be validated automatically.", 422);
  if (!Array.isArray(codes) || codes.length !== review.requiredElectives || new Set(codes).size !== codes.length) {
    throw new ImportError(`Select ${review.requiredElectives} distinct electives.`, 422);
  }
  const electives = review.electives.filter(unit => codes.includes(unit.code));
  if (electives.length !== codes.length) throw new ImportError("Select electives listed in this qualification release.", 422);
  const minimum = review.minimumGroup;
  if (minimum && electives.filter(unit => unit.groups.includes(minimum.group)).length < minimum.count) {
    throw new ImportError(`Select at least ${minimum.count} electives from Group ${minimum.group}.`, 422);
  }
  if (review.requiresElectiveAttestation && attested !== true) {
    throw new ImportError("Confirm the selected electives meet the qualification's relevance requirements.", 422);
  }
  return [
    ...review.core.map(unit => ({ code: unit.code, name: unit.name, type: "core" })),
    ...electives.map(unit => ({ code: unit.code, name: unit.name, type: "elective" })),
  ];
}
