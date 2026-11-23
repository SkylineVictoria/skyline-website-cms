// USI Web Services v5 client (2026-11-23). A port of the owner's known-good docs/usi/usi-test.js (PASSED against 3PT on 2026-11-20):
// the same MAS-ST WS-Trust request signed with RSA-SHA256, the same exclusive-c14n-shaped XML written byte for byte, the same RSTR
// parsing (the encrypted SAML assertion is copied verbatim, the proof key is the plain BinarySecret) and the same HMAC-SHA1 signature
// over the WS-Security timestamp. Only the configuration moved out (no hard-coded credential, org code or URLs) and the operations
// LocateUSI, CreateUSI and GetCountries were added. Runs in Deno (Edge Functions) and Node (tests).
// Never log or return: the keystore, the password, the token, the proof key, or any personal / document data. redactUsiXml() strips
// all of them from a request / response kept for a failure report.
import { createHash, createHmac, createPrivateKey, createPublicKey, randomUUID, sign, X509Certificate, type KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";
import { decryptPkcs12ShroudedKey } from "./pkcs12.ts";

export interface UsiConfig {
  environment: "test" | "production";
  keystoreXml: string;
  credentialId: string;
  password: string;
  orgCode: string;
  stsUrl: string;
  usiUrl: string;
}

const NS = {
  s: "http://www.w3.org/2003/05/soap-envelope",
  a: "http://www.w3.org/2005/08/addressing",
  u: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
  o: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  trust: "http://docs.oasis-open.org/ws-sx/ws-trust/200512",
  wsp: "http://schemas.xmlsoap.org/ws/2004/09/policy",
  wsid: "http://schemas.xmlsoap.org/ws/2005/05/identity",
  usi: "http://usi.gov.au/2022/ws",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
};
const C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const X509 = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3";
const B64 = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";
export const USI_ACTION_BASE = "http://usi.gov.au/2022/ws/";
const STS_ACTION = "http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue";

/* Hosts per environment: a test configuration can never reach production and the other way round. */
const HOSTS = {
  test: { sts: ["softwareauthorisations.evte.ato.gov.au"], usi: ["3pt.portal.usi.gov.au"] },
  production: { sts: ["softwareauthorisations.ato.gov.au"], usi: ["portal.usi.gov.au"] },
};
export function checkUsiConfig(c: UsiConfig): string {
  if (c.environment !== "test" && c.environment !== "production") return "EF_USI_ENVIRONMENT must be test or production";
  if (!c.keystoreXml || !c.credentialId || !c.password || !/^[A-Za-z0-9]{1,6}$/.test(c.orgCode)) return "USI credentials are not configured";
  const host = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" ? x.hostname.toLowerCase() : ""; } catch { return ""; } };
  if (!HOSTS[c.environment].sts.includes(host(c.stsUrl))) return `EF_USI_STS_URL is not a ${c.environment} MAS-ST address`;
  if (!HOSTS[c.environment].usi.includes(host(c.usiUrl))) return `EF_USI_SERVICE_URL is not a ${c.environment} USI address`;
  return "";
}

/* ------------------------------------------------------------------ helpers */
export const xmlEscape = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const b64 = (buf: Uint8Array) => Buffer.from(buf).toString("base64");
const uuidUrn = () => "urn:uuid:" + randomUUID();
const isoNow = (offsetMin = 0) => new Date(Date.now() + offsetMin * 60000).toISOString();

/* --------------------------------------------------------------- credential */
export interface UsiCredential { key: KeyObject; certDer: Buffer; validTo: string }

/** The keystore XML may arrive as the XML itself or base64 of it (a one-line secret). */
export function keystoreText(raw: string): string {
  const t = String(raw ?? "").trim();
  return t.startsWith("<") ? t : Buffer.from(t, "base64").toString("utf8");
}

export function loadUsiCredential(keystoreXml: string, id: string, password: string): UsiCredential {
  const xml = keystoreText(keystoreXml);
  const block = xml.split("<credential ").slice(1).find((b) => b.includes(`id="${id}"`));
  if (!block) throw new Error("The USI credential is not in the keystore");
  const tag = (t: string) => (block.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] ?? "";
  const encrypted = Buffer.from(tag("protectedPrivateKey").replace(/\s/g, ""), "base64");
  const pkcs8 = decryptPkcs12ShroudedKey(encrypted, password);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  // publicCertificate is a PKCS#7 bundle; pull out each embedded X.509 cert and pick the one matching the key (as usi-test.js).
  const p7 = Buffer.from(tag("publicCertificate").replace(/\s/g, ""), "base64");
  const pub = Buffer.from(createPublicKey(key).export({ type: "spki", format: "der" }) as Uint8Array);
  for (let i = 0; i < p7.length - 8; i++) {
    if (p7[i] === 0x30 && p7[i + 1] === 0x82 && p7[i + 4] === 0x30 && p7[i + 5] === 0x82) {
      const len = (p7[i + 2] << 8) + p7[i + 3] + 4;
      try {
        const der = Buffer.from(p7.subarray(i, i + len));
        const cert = new X509Certificate(der);
        if (Buffer.from(cert.publicKey.export({ type: "spki", format: "der" }) as Uint8Array).equals(pub)) return { key, certDer: der, validTo: cert.validTo };
      } catch { /* not a certificate at this offset */ }
    }
  }
  throw new Error("The keystore has no certificate for the USI credential");
}

/* -------------------------------------------------------------- XML signing */
// Elements are written directly in exclusive-c14n form (no whitespace, namespace decls first, explicit end tags), so the bytes we hash
// are the bytes we send (usi-test.js).
function timestampXml(id: string, created: string, expires: string) {
  return `<u:Timestamp xmlns:u="${NS.u}" u:Id="${id}"><u:Created>${created}</u:Created><u:Expires>${expires}</u:Expires></u:Timestamp>`;
}
function signedInfoXml(sigAlg: string, digestAlg: string, refId: string, digest: string) {
  return `<SignedInfo xmlns="${NS.ds}"><CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${sigAlg}"></SignatureMethod><Reference URI="#${refId}"><Transforms>` +
    `<Transform Algorithm="${C14N}"></Transform></Transforms><DigestMethod Algorithm="${digestAlg}"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
}

/* ------------------------------------------------------------ MAS-ST request */
export function buildStsRequest(cred: UsiCredential, stsUrl: string, appliesTo: string): string {
  const tsId = "_0", bstId = "uuid-" + randomUUID() + "-1";
  const created = isoNow(), expires = isoNow(5);
  const ts = timestampXml(tsId, created, expires);
  const digest = b64(createHash("sha256").update(ts).digest());
  const si = signedInfoXml("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", "http://www.w3.org/2001/04/xmlenc#sha256", tsId, digest);
  const sigVal = b64(sign("sha256", Buffer.from(si), cred.key));
  return `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:u="${NS.u}"><s:Header>` +
    `<a:Action s:mustUnderstand="1">${STS_ACTION}</a:Action>` +
    `<a:MessageID>${uuidUrn()}</a:MessageID>` +
    `<a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo>` +
    `<a:To s:mustUnderstand="1">${stsUrl}</a:To>` +
    `<o:Security s:mustUnderstand="1" xmlns:o="${NS.o}">${ts}` +
    `<o:BinarySecurityToken u:Id="${bstId}" ValueType="${X509}" EncodingType="${B64}">${b64(cred.certDer)}</o:BinarySecurityToken>` +
    `<Signature xmlns="${NS.ds}">${si}<SignatureValue>${sigVal}</SignatureValue>` +
    `<KeyInfo><o:SecurityTokenReference><o:Reference URI="#${bstId}" ValueType="${X509}"/></o:SecurityTokenReference></KeyInfo></Signature>` +
    `</o:Security></s:Header><s:Body>` +
    `<trust:RequestSecurityToken xmlns:trust="${NS.trust}">` +
    `<wsp:AppliesTo xmlns:wsp="${NS.wsp}"><a:EndpointReference><a:Address>${appliesTo}</a:Address></a:EndpointReference></wsp:AppliesTo>` +
    `<trust:Claims Dialect="${NS.wsid}" xmlns:wsid="${NS.wsid}">` +
    `<wsid:ClaimType Uri="http://vanguard.ebusiness.gov.au/2008/06/identity/claims/abn"/>` +
    `<wsid:ClaimType Uri="http://vanguard.ebusiness.gov.au/2008/06/identity/claims/credentialtype"/>` +
    `</trust:Claims>` +
    `<trust:KeyType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/SymmetricKey</trust:KeyType>` +
    `<trust:Lifetime><u:Created>${created}</u:Created><u:Expires>${isoNow(30)}</u:Expires></trust:Lifetime>` +
    `<trust:RequestType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/Issue</trust:RequestType>` +
    `<trust:TokenType>http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLV2.0</trust:TokenType>` +
    `<trust:KeySize>256</trust:KeySize>` +
    `<trust:KeyWrapAlgorithm>http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p</trust:KeyWrapAlgorithm>` +
    `<trust:EncryptWith>http://www.w3.org/2001/04/xmlenc#aes256-cbc</trust:EncryptWith>` +
    `<trust:SignWith>http://www.w3.org/2000/09/xmldsig#hmac-sha1</trust:SignWith>` +
    `<trust:CanonicalizationAlgorithm>${C14N}</trust:CanonicalizationAlgorithm>` +
    `<trust:EncryptionAlgorithm>http://www.w3.org/2001/04/xmlenc#aes256-cbc</trust:EncryptionAlgorithm>` +
    `</trust:RequestSecurityToken></s:Body></s:Envelope>`;
}

/* ------------------------------------------------------------ XML reading */
/** Find an element by local name (searching from `from`) and return its raw text plus its end index (usi-test.js). */
export function findElement(xml: string, localName: string, from = 0): { start: number; end: number; raw: string } | null {
  const open = new RegExp(`<([\\w.-]+:)?${localName}(?=[\\s>/])`, "g");
  open.lastIndex = from;
  const m = open.exec(xml);
  if (!m) return null;
  const qname = (m[1] || "") + localName;
  const re = new RegExp(`<(/?)${qname.replace(/\./g, "\\.")}(?=[\\s>/])[^>]*?(/?)>`, "g");
  re.lastIndex = m.index;
  let depth = 0, t: RegExpExecArray | null;
  while ((t = re.exec(xml))) {
    if (t[1]) depth--; else if (!t[2]) depth++;
    if (depth === 0) return { start: m.index, end: re.lastIndex, raw: xml.slice(m.index, re.lastIndex) };
  }
  return null;
}
/** Add namespace declarations an extracted element relies on (declared on ancestors in `doc`). */
function withAncestorNs(doc: string, el: string): string {
  const decls: Record<string, string> = {};
  for (const d of doc.matchAll(/xmlns:([\w.-]+)="([^"]*)"/g)) decls[d[1]] ??= d[2];
  const used = new Set([...el.matchAll(/<\/?([\w.-]+):/g), ...el.matchAll(/\s([\w.-]+):[\w.-]+=/g)]
    .map((x) => x[1]).filter((p) => p !== "xmlns" && p !== "xml"));
  const missing = [...used].filter((p) => decls[p] && !el.includes(`xmlns:${p}="`));
  return missing.length ? el.replace(/^<[\w.:-]+/, (s) => s + missing.map((p) => ` xmlns:${p}="${decls[p]}"`).join("")) : el;
}
const extractElement = (xml: string, name: string, from = 0) => { const e = findElement(xml, name, from); return e ? withAncestorNs(xml, e.raw) : null; };
const innerOf = (el: string) => el.replace(/^<[^>]*>/, "").replace(/<\/[^>]*>$/, "");
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
export const textOf = (xml: string, name: string, from = 0): string | null => {
  const e = findElement(xml, name, from);
  if (!e || e.raw.endsWith("/>") && !e.raw.includes("</")) return e ? "" : null;
  return unescapeXml(innerOf(e.raw).trim());
};
/** Every element with this local name (direct text), in document order. */
function allOf(xml: string, name: string): string[] {
  const out: string[] = [];
  for (let at = 0; ;) { const e = findElement(xml, name, at); if (!e) break; out.push(e.raw); at = e.end; }
  return out;
}

/* --------------------------------------------------------------------- faults */
/** A SOAP fault; detail* come from the USI ErrorInfo (e.g. 1002 Generic Validation "DVS document must be supplied ..."). */
export interface UsiFault { code: string; subcode: string; reason: string; detailCode: string; detailTitle: string; detailMessage: string }
export function parseFault(xml: string): UsiFault | null {
  if (!/:Fault[\s>]/.test(xml) && !/<Fault[\s>]/.test(xml)) return null;
  const strip = (s: string | null) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const code = findElement(xml, "Code");
  const sub = findElement(xml, "Subcode");
  const info = findElement(xml, "ErrorInfo")?.raw ?? "";
  return {
    code: strip(code ? textOf(code.raw, "Value") : null) || strip(textOf(xml, "faultcode")),
    subcode: strip(sub ? textOf(sub.raw, "Value") : null),
    reason: strip(textOf(xml, "Text") ?? textOf(xml, "faultstring")).slice(0, 300),
    detailCode: strip(info ? textOf(info, "Code") : null).slice(0, 20),
    detailTitle: strip(info ? textOf(info, "Title") : null).slice(0, 100),
    detailMessage: strip(info ? textOf(info, "Message") : null).slice(0, 300),
  };
}
/** A fault the token caused (expired / not accepted): drop the cached token and try once more. */
export const isTokenFault = (f: UsiFault | null) => !!f && !f.detailCode && /security|authentication|expired|token/i.test(`${f.code} ${f.subcode} ${f.reason}`);
/** The fault in one line for staff and the audit log (codes and the Registry's message; never personal data). */
export const faultText = (f: UsiFault | null | undefined) => !f ? "" : [f.detailCode && `USI ${f.detailCode}`, f.detailTitle, f.detailMessage || f.reason, f.subcode].filter(Boolean).join(" · ").slice(0, 400);

/* ----------------------------------------------------------------- the RSTR */
export interface UsiToken { token: string; key: Buffer; str: string; expiresAt: number }
export function parseRstr(xml: string): UsiToken {
  const fault = parseFault(xml);
  if (fault) throw new UsiError("token", `MAS-ST refused the token request${fault.subcode ? ` [${fault.subcode}]` : ""}`, fault);
  const rst = findElement(xml, "RequestedSecurityToken");
  if (!rst) throw new UsiError("token", "No RequestedSecurityToken in the MAS-ST response");
  // The token is the first child element (EncryptedAssertion / EncryptedData / Assertion), copied verbatim.
  const openEnd = xml.indexOf(">", rst.start) + 1;
  const childLocal = (xml.slice(openEnd).match(/^\s*<(?:[\w.-]+:)?([\w.-]+)/) || [])[1];
  const token = childLocal ? extractElement(xml, childLocal, openEnd) : null;
  const proof = findElement(xml, "RequestedProofToken");
  const secret = proof && textOf(proof.raw, "BinarySecret");
  if (!token || !secret) throw new UsiError("token", "No token or proof key in the MAS-ST response");
  const att = findElement(xml, "RequestedAttachedReference");
  const str = att && extractElement(xml, "SecurityTokenReference", att.start);
  if (!str) throw new UsiError("token", "No SecurityTokenReference in the MAS-ST response");
  const life = findElement(xml, "Lifetime");
  const expires = life ? Date.parse(textOf(life.raw, "Expires") ?? "") : NaN;
  // The service says a token lasts 30 minutes; never trust more than that.
  const cap = Date.now() + 30 * 60_000;
  return { token, key: Buffer.from(secret, "base64"), str, expiresAt: Number.isFinite(expires) ? Math.min(expires, cap) : cap };
}

/* ---------------------------------------------------------------- USI request */
export function buildUsiRequest(op: string, bodyXml: string, tok: Pick<UsiToken, "token" | "key" | "str">, usiUrl: string): string {
  const tsId = "_0";
  const ts = timestampXml(tsId, isoNow(), isoNow(5));
  const digest = b64(createHash("sha1").update(ts).digest());
  const si = signedInfoXml("http://www.w3.org/2000/09/xmldsig#hmac-sha1", "http://www.w3.org/2000/09/xmldsig#sha1", tsId, digest);
  const sigVal = b64(createHmac("sha1", tok.key).update(si).digest());
  return `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:u="${NS.u}"><s:Header>` +
    `<a:Action s:mustUnderstand="1">${USI_ACTION_BASE}${op}</a:Action>` +
    `<a:MessageID>${uuidUrn()}</a:MessageID>` +
    `<a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo>` +
    `<a:To s:mustUnderstand="1">${usiUrl}</a:To>` +
    `<o:Security s:mustUnderstand="1" xmlns:o="${NS.o}">${ts}${tok.token}` +
    `<Signature xmlns="${NS.ds}">${si}<SignatureValue>${sigVal}</SignatureValue><KeyInfo>${tok.str}</KeyInfo></Signature>` +
    `</o:Security></s:Header><s:Body>${bodyXml}</s:Body></s:Envelope>`;
}

/* ------------------------------------------------------------------- bodies */
const el = (name: string, value: unknown) => value === undefined || value === null || value === "" ? "" : `<${name}>${xmlEscape(value)}</${name}>`;

export interface UsiName { firstName?: string; middleName?: string; familyName?: string; singleName?: string }
const names = (n: UsiName, withMiddle: boolean) => n.singleName
  ? el("SingleName", n.singleName)
  : el("FirstName", n.firstName) + (withMiddle ? el("MiddleName", n.middleName) : "") + el("FamilyName", n.familyName);

export function verifyBody(orgCode: string, r: UsiName & { usi: string; dateOfBirth: string }): string {
  return `<VerifyUSI xmlns="${NS.usi}">${el("OrgCode", orgCode)}${el("USI", r.usi)}${names(r, false)}${el("DateOfBirth", r.dateOfBirth)}</VerifyUSI>`;
}

export interface UsiLocate extends UsiName { gender: "M" | "F" | "X"; dateOfBirth: string; townCityOfBirth?: string; email?: string; mobile?: string; userReference: string }
export function locateBody(orgCode: string, r: UsiLocate): string {
  return `<LocateUSI xmlns="${NS.usi}">${el("OrgCode", orgCode)}${el("UserReference", r.userReference)}` +
    `<PersonalDetails>${el("Gender", r.gender)}${names(r, true)}${el("DateOfBirth", r.dateOfBirth)}${el("TownCityOfBirth", r.townCityOfBirth)}</PersonalDetails>` +
    `<ContactDetails>${el("EmailAddress", r.email)}${r.mobile ? `<Phone>${el("Mobile", r.mobile)}</Phone>` : ""}</ContactDetails></LocateUSI>`;
}

export interface UsiAddress { address1: string; address2?: string; suburb: string; state: string; postcode: string }
export interface UsiCreate extends UsiName {
  requestId: string; applicationId: string; userReference: string;
  gender: "M" | "F" | "X"; dateOfBirth: string; countryOfBirthCode: string; townCityOfBirth: string;
  countryOfResidenceCode: string; email?: string; mobile?: string; homePhone?: string;
  nationalAddress?: UsiAddress; internationalAddress?: string;
  /** Required in every environment (owner, 2026-11-23): never the DVS override. Built by usiDocumentXml (validation/usi-documents.ts). */
  documentXml: string;
}
export function createBody(orgCode: string, r: UsiCreate): string {
  const phone = r.mobile || r.homePhone ? `<Phone>${el("Home", r.homePhone)}${el("Mobile", r.mobile)}</Phone>` : "";
  const address = r.nationalAddress
    ? `<NationalAddress>${el("Address1", r.nationalAddress.address1)}${el("Address2", r.nationalAddress.address2)}${el("SuburbTownCity", r.nationalAddress.suburb)}` +
      `${el("State", r.nationalAddress.state)}${el("PostCode", r.nationalAddress.postcode)}</NationalAddress>`
    : el("InternationalAddress", r.internationalAddress);
  return `<CreateUSI xmlns="${NS.usi}" xmlns:xsi="${NS.xsi}">${el("RequestId", r.requestId)}${el("OrgCode", orgCode)}<Application>` +
    `${el("ApplicationId", r.applicationId)}<DVSCheckRequired>true</DVSCheckRequired>${el("UserReference", r.userReference)}` +
    `<ContactDetails>${el("CountryOfResidenceCode", r.countryOfResidenceCode)}${el("EmailAddress", r.email)}${phone}${address}</ContactDetails>` +
    `<PersonalDetails>${el("Gender", r.gender)}${names(r, true)}${el("DateOfBirth", r.dateOfBirth)}${el("CountryOfBirthCode", r.countryOfBirthCode)}` +
    `${el("TownCityOfBirth", r.townCityOfBirth)}<IsPreferredName>false</IsPreferredName></PersonalDetails>` +
    `${r.documentXml}</Application></CreateUSI>`;
}
/** Create without any identity document: only for the self-test, to show the service itself refuses it (DVSCheckRequired stays true). */
export const createBodyWithoutDocument = (orgCode: string, r: Omit<UsiCreate, "documentXml">) => createBody(orgCode, { ...r, documentXml: "" });

export const countriesBody = (orgCode: string) => `<GetCountries xmlns="${NS.usi}">${el("OrgCode", orgCode)}</GetCountries>`;

/* ----------------------------------------------------------------- responses */
export type MatchResult = "Match" | "NoMatch" | null;
export interface VerifyResult { usiStatus: "Valid" | "Invalid" | "Deactivated" | string; firstName: MatchResult; familyName: MatchResult; singleName: MatchResult; dateOfBirth: MatchResult }
export function parseVerify(xml: string): VerifyResult {
  const body = findElement(xml, "VerifyUSIResponse")?.raw ?? "";
  if (!body) throw new UsiError("response", "No VerifyUSIResponse in the reply");
  const m = (n: string) => { const v = textOf(body, n); return v === "Match" || v === "NoMatch" ? v : null; };
  return { usiStatus: textOf(body, "USIStatus") ?? "", firstName: m("FirstName"), familyName: m("FamilyName"), singleName: m("SingleName"), dateOfBirth: m("DateOfBirth") };
}
export interface UsiErrorItem { code: string; message: string }
const errorsOf = (xml: string): UsiErrorItem[] => allOf(xml, "Error").map((e) => ({ code: (textOf(e, "Code") ?? "").slice(0, 60), message: (textOf(e, "Message") ?? "").slice(0, 300) }))
  .filter((e) => e.code || e.message);
export interface LocateResult { result: string; usi: string | null; message: string | null; errors: UsiErrorItem[] }
export function parseLocate(xml: string): LocateResult {
  const body = findElement(xml, "LocateUSIResponse")?.raw ?? "";
  if (!body) throw new UsiError("response", "No LocateUSIResponse in the reply");
  return { result: textOf(body, "Result") ?? "", usi: textOf(body, "USI") || null, message: textOf(body, "ContactDetailsMessage") || null, errors: errorsOf(body) };
}
export interface CreateResult { result: string; usi: string | null; identityDocumentVerified: string | null; errors: UsiErrorItem[] }
export function parseCreate(xml: string): CreateResult {
  const body = findElement(xml, "CreateUSIResponse")?.raw ?? "";
  if (!body) throw new UsiError("response", "No CreateUSIResponse in the reply");
  return { result: textOf(body, "Result") ?? "", usi: textOf(body, "USI") || null, identityDocumentVerified: textOf(body, "IdentityDocumentVerified") || null, errors: errorsOf(body) };
}
export interface Country { code: string; name: string; current: boolean }
export function parseCountries(xml: string): Country[] {
  return allOf(xml, "CountryDetails").map((c) => ({ code: textOf(c, "CountryCode") ?? "", name: textOf(c, "Name") ?? "", current: (textOf(c, "IsCurrent") ?? "true") !== "false" }))
    .filter((c) => c.code && c.name);
}

/* ----------------------------------------------------------------- redaction */
// Elements whose text is personal, document or secret data. A failure report keeps the structure and codes only.
const REDACT = ["FirstName", "MiddleName", "FamilyName", "SingleName", "DateOfBirth", "TownCityOfBirth", "EmailAddress", "Home", "Mobile",
  "Address1", "Address2", "SuburbTownCity", "PostCode", "InternationalAddress", "USI", "PreferredFirstName", "PreferredFamilyName", "PreferredSingleName",
  "LicenceNumber", "CardNumber", "DocumentNumber", "PassportNumber", "ImmiCardNumber", "MedicareCardNumber", "IndividualRefNumber", "NameLine1", "NameLine2",
  "NameLine3", "NameLine4", "CRN", "Name", "StockNumber", "RegistrationNumber", "CertificateNumber", "AcquisitionDate", "RegistrationDate", "DatePrinted",
  "ExpiryDate", "UserReference", "ContactDetailsMessage", "BinarySecret", "CipherValue", "SignatureValue", "DigestValue", "BinarySecurityToken",
  "KeyIdentifier"];
export function redactUsiXml(xml: string): string {
  let out = String(xml ?? "");
  for (const n of REDACT) out = out.replace(new RegExp(`(<(?:[\\w.-]+:)?${n}(?:\\s[^>]*)?>)([^<]*)(</(?:[\\w.-]+:)?${n}>)`, "g"), (_m, a, t, c) => `${a}${t ? "[redacted]" : ""}${c}`);
  return out;
}

/* ------------------------------------------------------------------ the client */
export class UsiError extends Error {
  constructor(public stage: "config" | "token" | "http" | "fault" | "response", message: string, public fault?: UsiFault | null, public httpStatus?: number) { super(message); }
}
export interface UsiExchange { request: string; response: string; status: number }

/**
 * One configured connection. The MAS-ST token is kept in memory and reused until two minutes before it expires (never stored anywhere),
 * fetched again once if the USI service rejects it. `onExchange` sees every request / response (for a redacted failure report).
 */
export class UsiClient {
  private tok: UsiToken | null = null;
  private cred: UsiCredential | null = null;
  constructor(private cfg: UsiConfig, private fetcher: typeof fetch = fetch, private onExchange?: (op: string, x: UsiExchange) => void) {
    const problem = checkUsiConfig(cfg);
    if (problem) throw new UsiError("config", problem);
  }
  get environment() { return this.cfg.environment; }
  get orgCode() { return this.cfg.orgCode; }
  get tokenCached() { return !!this.tok && this.tok.expiresAt - Date.now() > 120_000; }

  private async post(url: string, xml: string, action: string, op: string) {
    const res = await this.fetcher(url, {
      method: "POST",
      headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="${action}"` },
      body: xml,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    this.onExchange?.(op, { request: xml, response: text, status: res.status });
    return { status: res.status, text };
  }

  async token(): Promise<UsiToken> {
    if (this.tok && this.tok.expiresAt - Date.now() > 120_000) return this.tok;
    this.cred ??= loadUsiCredential(this.cfg.keystoreXml, this.cfg.credentialId, this.cfg.password);
    const req = buildStsRequest(this.cred, this.cfg.stsUrl, this.cfg.usiUrl);
    const res = await this.post(this.cfg.stsUrl, req, STS_ACTION, "Token");
    this.tok = parseRstr(res.text);
    return this.tok;
  }

  /** Calls one operation; returns the reply XML of a 200, throws UsiError otherwise. */
  async call(op: string, bodyXml: string): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await this.token();
      const res = await this.post(this.cfg.usiUrl, buildUsiRequest(op, bodyXml, tok, this.cfg.usiUrl), USI_ACTION_BASE + op, op);
      const fault = parseFault(res.text);
      if (res.status === 200 && !fault) return res.text;
      if (attempt === 0 && isTokenFault(fault)) { this.tok = null; continue; }
      throw new UsiError(fault ? "fault" : "http", fault ? (faultText(fault) || "The USI service returned a fault") : `The USI service answered HTTP ${res.status}`, fault, res.status);
    }
    throw new UsiError("http", "The USI service could not be reached");
  }

  verify(r: Parameters<typeof verifyBody>[1]) { return this.call("VerifyUSI", verifyBody(this.cfg.orgCode, r)).then(parseVerify); }
  locate(r: UsiLocate) { return this.call("LocateUSI", locateBody(this.cfg.orgCode, r)).then(parseLocate); }
  create(r: UsiCreate) {
    if (!r.documentXml) throw new UsiError("config", "An identity document is required to create a USI");
    return this.call("CreateUSI", createBody(this.cfg.orgCode, r)).then(parseCreate);
  }
  countries() { return this.call("GetCountries", countriesBody(this.cfg.orgCode)).then(parseCountries); }
}
