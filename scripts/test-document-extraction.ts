import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-document-extraction"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import assert from "node:assert/strict";
import test from "node:test";
import { formatExtractionCandidates, hasLegacyExtractionOnly, reprocessedExtractionMetadata } from "../src/pages/agency/lib/documentExtraction.ts";

const legacy = { kind: "licence", extractedAt: "2026-10-14T08:44:58.506Z", extractedFields: ["dob"] };

test("legacy names are unavailable values, not an extraction", () => {
  assert.equal(hasLegacyExtractionOnly(legacy), true);
});

test("reprocessing preserves historical metadata and starts unreviewed", () => {
  const metadata = reprocessedExtractionMetadata(legacy, { dob: "2001-02-03" }, "2026-10-14T10:00:00.000Z");
  assert.equal(metadata.kind, "licence");
  assert.deepEqual(metadata.extractedFields, ["dob"]);
  assert.deepEqual((metadata.extraction as { extracted: unknown }).extracted, { dob: "2001-02-03" });
  assert.equal((metadata.extraction as { status: string }).status, "unreviewed");
});

test("persisted reprocess envelope survives reload and keeps confirmation separate from OCR", () => {
  const metadata = reprocessedExtractionMetadata(legacy, { dob: "2001-02-03" }, "2026-10-14T10:00:00.000Z");
  const extraction = metadata.extraction as { extracted: Record<string, string>; confirmed: Record<string, string>; status: string };
  const reloaded = JSON.parse(JSON.stringify(metadata)) as typeof metadata;
  assert.deepEqual((reloaded.extraction as typeof extraction).extracted, { dob: "2001-02-03" });
  assert.deepEqual((reloaded.extraction as typeof extraction).confirmed, {});
  assert.equal((reloaded.extraction as typeof extraction).status, "unreviewed");
});

test("failed retry preserves confirmed values and mirrors safe diagnostics", () => {
  const prior = { ...legacy, extraction: { extracted: { dob: "2001-02-03" }, confirmed: { dob: "2001-02-03" }, status: "confirmed", source: { engine: "tesseract.js", parser: "parseDocument", extractedAt: "x" } } };
  const metadata = reprocessedExtractionMetadata(prior, {}, "2026-10-14T10:00:00.000Z", { pagesProcessed: 1, recognizedCharacterCount: 0 });
  const extraction = metadata.extraction as { confirmed: Record<string, string>; status: string };
  assert.deepEqual(extraction.confirmed, { dob: "2001-02-03" });
  assert.equal(extraction.status, "confirmed");
  assert.equal((metadata.diagnostics as { pagesProcessed: number }).pagesProcessed, 1);
});

test("passport candidates retain all persisted fields and format wizard values", () => {
  const fields = formatExtractionCandidates({
    first_name: "Mihir", middle_name: "Kumar", last_name: "Example", dob: "03/02/2001",
    gender: "M", nationality: "Indian", birth_country: "India", passport_number: "A1234567", passport_expiry: "2032-12-31",
  });
  assert.deepEqual(fields, {
    first_name: "Mihir", middle_name: "Kumar", last_name: "Example", dob: "2001-02-03",
    gender: "Male", nationality: "India", birth_country: "India", passport_number: "A1234567", passport_expiry: "2032-12-31",
  });
});

test("normalises supported aliases and document-specific field names", () => {
  assert.deepEqual(formatExtractionCandidates({
    passport_issuing_country: "USA", citizenship: "GBR", nationality: "IND",
    birth_country: "Viet Nam", au_state: "New South Wales", address_type: "Australian Address",
    gender: "F",
  }), {
    issuing_country: "United States", citizenship: "United Kingdom", nationality: "India",
    birth_country: "Viet Nam", au_state: "NSW", address_type: "Australian Address", gender: "Female",
  });
});

test("unrecognised select candidates are retained for manual correction only", () => {
  assert.deepEqual(formatExtractionCandidates({ nationality: "Atlantis", gender: "X", au_state: "North", address_type: "Local" }), {});
});

test("English scores retain component notation without score conversion", () => {
  assert.deepEqual(formatExtractionCandidates({
    english_type: "IELTS General Training", english_score: "7.0", english_components: "L 7.5, R 7.0, W 6.5, S 7.0",
  }), {
    english_type: "IELTS General Training", english_score: "7.0 (Overall) · L 7.5, R 7.0, W 6.5, S 7.0",
  });
});

test("English test aliases select the actual wizard options", () => {
  assert.deepEqual(formatExtractionCandidates({ english_type: "TOEFL iBT" }), { english_type: "TOEFL iBT" });
  assert.deepEqual(formatExtractionCandidates({ english_type: "Pearson PTE" }), { english_type: "PTE Academic" });
});

test("document expiry: expired, valid, expiring soon, English +2 years, missing, invalid, today", async () => {
  const { getDocumentExpiryStatus, expiryMessage, expiryLabel } = await import("../src/pages/agency/lib/documentExpiry.ts");
  const today = new Date(2026, 9, 28, 23, 59);
  assert.deepEqual(getDocumentExpiryStatus("passport", { passport_expiry: "2025-03-12" }, today), { status: "expired", date: "2025-03-12", expiresToday: false });
  assert.equal(getDocumentExpiryStatus("passport", { passport_expiry: "2030-01-01" }, today).status, "valid");
  assert.equal(getDocumentExpiryStatus("passport", { passport_expiry: "2027-03-28" }, today).status, "expiring_soon");
  assert.equal(getDocumentExpiryStatus("passport", { passport_expiry: "2027-04-29" }, today).status, "valid");
  assert.equal(getDocumentExpiryStatus("visa", { visa_stay_until: "2027-01-12" }, today).status, "expiring_soon");
  assert.equal(getDocumentExpiryStatus("visa", { visa_stay_until: "2026-10-27" }, today).status, "expired");
  assert.deepEqual(getDocumentExpiryStatus("english", { english_date: "2024-10-27" }, today), { status: "expired", date: "2026-10-27", expiresToday: false });
  assert.deepEqual(getDocumentExpiryStatus("english", { english_date: "2025-01-01" }, today), { status: "valid", date: "2027-01-01", expiresToday: false });
  assert.equal(getDocumentExpiryStatus("english", { english_date: "2024-10-28", english_valid_until: "2030-01-01" }, today).status, "valid");
  assert.equal(getDocumentExpiryStatus("english", { english_date: "2026-11-01" }, today).status, "valid");
  assert.equal(getDocumentExpiryStatus("passport", {}, today).status, "unknown");
  assert.equal(getDocumentExpiryStatus("english", {}, today).status, "unknown");
  assert.equal(getDocumentExpiryStatus("passport", { passport_expiry: "2026-02-30" }, today).status, "unknown");
  assert.equal(getDocumentExpiryStatus("visa", { visa_stay_until: "soon" }, today).status, "unknown");
  const expiresToday = getDocumentExpiryStatus("passport", { passport_expiry: "2026-10-28" }, today);
  assert.deepEqual(expiresToday, { status: "expiring_soon", date: "2026-10-28", expiresToday: true });
  assert.equal(expiryMessage("passport", expiresToday), "This passport expires today.");
  assert.equal(expiryLabel(expiresToday), "Expires today");
  assert.equal(expiryLabel(getDocumentExpiryStatus("visa", { visa_stay_until: "2027-01-12" }, today)), "Expiring soon");
  assert.equal(getDocumentExpiryStatus("english", { english_date: "2024-10-28" }, today).status, "valid");
});

test("USI: format rules, forbidden characters, case, blank, check character", async () => {
  const { validateUsi, normalizeUsi, hasForbiddenUsiCharacter, usiCheckCharacter, USI_FORMAT_MESSAGE } = await import("../supabase/functions/_shared/validation/identifiers.ts");
  // Every USI in the USI Developers Kit V5 (test outlines, Generic USI Test Data, spec samples) passes the Registry's check character.
  for (const kit of ["BNGH7C75FN", "BP6LKB3C7X", "RVJ5DM8LXJ", "PDGGW5XLXW", "DG6K5YHPP3", "U6Q8JN6UD9", "QFJEGFSBC4", "9FZSH4B7KN", "R5HQLSWS9Y", "JXH6XLHLNU",
    "4BPKTANV6J", "HB4PJBFP6Z", "K49YCFFTQG", "3TTJN9GVLQ", "4N4XCTEP9Z", "HTSU3ZNMEB", "GHACP8URE8", "UDMAWRUMPG", "UDNM3W6KUS", "HEY5DBYZHX"]) assert.equal(validateUsi(kit), "", kit);
  assert.equal(validateUsi("bngh7c75fn"), "");
  assert.equal(usiCheckCharacter("BNGH7C75F"), "N");
  assert.equal(validateUsi("BNGH7C75FM"), "");   // check character not enforced (owner, 2026-11-23)
  assert.equal(validateUsi("BNHG7C75FN"), "");   // check character not enforced
  assert.equal(validateUsi("ABCDEFGHJK"), "");
  assert.equal(validateUsi("M23U923423"), "");
  assert.equal(normalizeUsi("abcd-efgh jk99"), "ABCDEFGHJK");
  assert.equal(validateUsi(""), "");
  assert.equal(validateUsi("   "), "");
  assert.equal(validateUsi("ABCDEFGHJ"), USI_FORMAT_MESSAGE);
  assert.equal(validateUsi("ABCDEFGHJKL"), USI_FORMAT_MESSAGE);
  for (const bad of ["abcd1efghi", "ABCD0EFGHJ", "ABCDIEFGHJ", "ABCDOEFGHJ", "ABCD!EFGHJ"]) assert.equal(validateUsi(bad), USI_FORMAT_MESSAGE, bad);
  assert.equal(hasForbiddenUsiCharacter("abcd1efghi"), true);
  assert.equal(hasForbiddenUsiCharacter("abcdefghjk"), false);
});

test("USI service: TypeScript DES / TDEA against the published vectors and Node's des-ede3-cbc", async () => {
  const tdes = await import("../supabase/functions/_shared/usi/tdes.ts");
  const { createCipheriv, randomBytes } = await import("node:crypto");
  const hex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/\s/g, ""), "hex"));
  const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex").toUpperCase();
  // DES known answers: the FIPS 46 worked example, FIPS 81 ("Now is t"), NIST SP 800-17 variable-plaintext KAT (round 1).
  for (const [key, pt, ct] of [["133457799BBCDFF1", "0123456789ABCDEF", "85E813540F0AB405"], ["0123456789ABCDEF", "4E6F772069732074", "3FA40E8A984D4815"],
    ["0101010101010101", "8000000000000000", "95F8A5E5DD31D900"]]) {
    assert.equal(toHex(tdes.desEncryptBlock(hex(key), hex(pt))), ct, `DES E ${key}`);
    assert.equal(toHex(tdes.desDecryptBlock(hex(key), hex(ct))), pt, `DES D ${key}`);
  }
  // TDEA known answer: NIST SP 800-67 Rev. 1 Appendix B ("The qufck brown fox jump", three independent keys).
  const k = hex("0123456789ABCDEF 23456789ABCDEF01 456789ABCDEF0123");
  const blocks = [["5468652071756663", "A826FD8CE53B855F"], ["6B2062726F776E20", "CCE21C8112256FE6"], ["666F78206A756D70", "68D5C05DD9B6B900"]];
  for (const [pt, ct] of blocks) {
    assert.equal(toHex(tdes.tdeaEncryptBlock(k, hex(pt))), ct, `TDEA E ${pt}`);
    assert.equal(toHex(tdes.tdeaDecryptBlock(k, hex(ct))), pt, `TDEA D ${ct}`);
  }
  // CBC + PKCS#7 against Node's des-ede3-cbc: random keys, IVs and lengths (0 to 40 bytes, so 1 to 6 blocks).
  for (let i = 0; i < 60; i++) {
    const key = randomBytes(24), iv = randomBytes(8), data = randomBytes(i % 41);
    const c = createCipheriv("des-ede3-cbc", key, iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    assert.equal(Buffer.from(tdes.tdeaCbcDecrypt(key, iv, enc)).equals(data), true, `CBC round ${i}`);
  }
  assert.throws(() => tdes.tdeaCbcDecrypt(randomBytes(24), randomBytes(8), randomBytes(12)), /whole 8-byte blocks/);
});

test("USI service: keystore key decryption (PKCS#12 3DES) matches Node", async (t) => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { createPrivateKey } = await import("node:crypto");
  const { decryptPkcs12ShroudedKey } = await import("../supabase/functions/_shared/usi/pkcs12.ts");
  const { loadUsiCredential } = await import("../supabase/functions/_shared/usi/soap.ts");
  // The kit keystore is never in the repo (gitignored): USI_KEYSTORE, docs/usi/keystore-usi.xml or the owner's download folder.
  const file = [process.env.USI_KEYSTORE, "docs/usi/keystore-usi.xml", `${process.env.USERPROFILE ?? ""}/Downloads/usi-api-test/keystore-usi.xml`].find((f) => f && existsSync(f));
  if (!file) { t.skip("kit keystore not on this machine (set USI_KEYSTORE)"); return; }
  const xml = readFileSync(file, "utf8");
  const block = xml.split("<credential ").slice(1).find((b) => b.includes('id="ABRD:27809366375_USIMachine"'))!;
  const encrypted = Buffer.from(block.match(/<protectedPrivateKey>([\s\S]*?)<\/protectedPrivateKey>/)![1].replace(/\s/g, ""), "base64");
  const kitPassword = "Password1!"; // the kit's published test password (USI Developers Kit V5)
  const mine = decryptPkcs12ShroudedKey(encrypted, kitPassword);
  const node = createPrivateKey({ key: encrypted, format: "der", type: "pkcs8", passphrase: kitPassword }).export({ type: "pkcs8", format: "der" });
  assert.equal(mine.equals(node as Buffer), true);
  assert.throws(() => decryptPkcs12ShroudedKey(encrypted, "wrong"), /password/);
  const cred = loadUsiCredential(Buffer.from(xml).toString("base64"), "ABRD:27809366375_USIMachine", kitPassword);   // base64 secret form
  assert.match(cred.validTo, /20\d\d/);
});

test("USI service: requests, replies, faults, redaction and configuration", async () => {
  const soap = await import("../supabase/functions/_shared/usi/soap.ts");
  const { createHash, createHmac } = await import("node:crypto");
  // The HMAC-SHA1 signature is over the exact SignedInfo bytes, whose digest is over the exact Timestamp bytes (as usi-test.js).
  const key = Buffer.alloc(32, 7);
  const req = soap.buildUsiRequest("VerifyUSI", soap.verifyBody("VA1803", { usi: "BNGH7C75FN", firstName: "Maryam", familyName: "O'Fredrick & Co", dateOfBirth: "1966-05-25" }),
    { token: "<saml:Assertion xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\" ID=\"_t\"/>", key, str: "<o:SecurityTokenReference xmlns:o=\"x\"/>" }, "https://3pt.portal.usi.gov.au/service/v5/usiservice.svc");
  const ts = req.match(/<u:Timestamp[\s\S]*?<\/u:Timestamp>/)![0];
  const si = req.match(/<SignedInfo[\s\S]*?<\/SignedInfo>/)![0];
  assert.equal(si.match(/<DigestValue>([^<]+)</)![1], createHash("sha1").update(ts).digest("base64"));
  assert.equal(req.match(/<SignatureValue>([^<]+)</)![1], createHmac("sha1", key).update(si).digest("base64"));
  assert.match(req, /<FamilyName>O'Fredrick &amp; Co<\/FamilyName>/);
  assert.match(req, /<a:Action s:mustUnderstand="1">http:\/\/usi.gov.au\/2022\/ws\/VerifyUSI<\/a:Action>/);
  // Replies saved from 3PT (usi-test.js, 2026-11-20).
  const env = (b: string) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${b}</s:Body></s:Envelope>`;
  assert.deepEqual(soap.parseVerify(env('<VerifyUSIResponse xmlns="http://usi.gov.au/2022/ws"><USIStatus>Valid</USIStatus><FirstName>Match</FirstName><FamilyName>NoMatch</FamilyName><DateOfBirth>Match</DateOfBirth></VerifyUSIResponse>')),
    { usiStatus: "Valid", firstName: "Match", familyName: "NoMatch", singleName: null, dateOfBirth: "Match" });
  assert.equal(soap.parseVerify(env('<VerifyUSIResponse xmlns="http://usi.gov.au/2022/ws"><USIStatus>Valid</USIStatus><SingleName>Match</SingleName><DateOfBirth>Match</DateOfBirth></VerifyUSIResponse>')).singleName, "Match");
  assert.deepEqual(soap.parseLocate(env('<LocateUSIResponse xmlns="http://usi.gov.au/2022/ws"><Result>Exact</Result><USI>HEY5DBYZHX</USI><ContactDetailsMessage>x</ContactDetailsMessage></LocateUSIResponse>')),
    { result: "Exact", usi: "HEY5DBYZHX", message: "x", errors: [] });
  const failed = soap.parseCreate(env('<CreateUSIResponse xmlns="http://usi.gov.au/2022/ws"><Application><ProcessedDate>2026-11-23T00:00:00Z</ProcessedDate><ApplicationId>1</ApplicationId><Result>Failure</Result><IdentityDocumentVerified>False</IdentityDocumentVerified><Errors><Error><Code>2005</Code><Message>Failed to create USI record, multiple existing records were found.</Message></Error></Errors></Application></CreateUSIResponse>'));
  assert.deepEqual(failed, { result: "Failure", usi: null, identityDocumentVerified: "False", errors: [{ code: "2005", message: "Failed to create USI record, multiple existing records were found." }] });
  // The fault 3PT returns for a Create without a document (2026-11-23).
  const fault = soap.parseFault(env('<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en-AU">The creator of this fault did not specify a Reason.</s:Text></s:Reason><s:Detail><ErrorInfo xmlns="http://usi.gov.au/2020/ws"><Code>1002</Code><Title>Generic Validation</Title><Message>DVS document must be supplied when DVS check is requested.</Message></ErrorInfo></s:Detail></s:Fault>'));
  assert.equal(fault?.code, "s:Sender");
  assert.equal(fault?.detailCode, "1002");
  assert.equal(soap.isTokenFault(fault), false);
  assert.match(soap.faultText(fault), /^USI 1002 · Generic Validation · DVS document must be supplied/);
  assert.equal(soap.isTokenFault(soap.parseFault(env('<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>a:InvalidSecurity</s:Value></s:Subcode></s:Code><s:Reason><s:Text>x</s:Text></s:Reason></s:Fault>'))), true);
  // Redaction keeps structure and codes, drops personal, document and token data.
  const red = soap.redactUsiXml(req.replace("</VerifyUSI>", "<DVSDocument><PassportNumber>N1234567</PassportNumber></DVSDocument></VerifyUSI>"));
  for (const gone of ["Maryam", "Fredrick", "1966-05-25", "BNGH7C75FN", "N1234567", req.match(/<SignatureValue>([^<]+)</)![1]]) assert.equal(red.includes(gone), false, gone);
  assert.match(red, /<OrgCode>VA1803<\/OrgCode>/);
  // A test configuration can only reach 3PT; production only production.
  const cfg = { environment: "test" as const, keystoreXml: "<x/>", credentialId: "c", password: "p", orgCode: "VA1803",
    stsUrl: "https://softwareauthorisations.evte.ato.gov.au/R3.0/S007v1.3/service.svc", usiUrl: "https://3pt.portal.usi.gov.au/service/v5/usiservice.svc" };
  assert.equal(soap.checkUsiConfig(cfg), "");
  assert.match(soap.checkUsiConfig({ ...cfg, usiUrl: "https://portal.usi.gov.au/service/v5/usiservice.svc" }), /not a test USI address/);
  assert.match(soap.checkUsiConfig({ ...cfg, environment: "production" }), /not a production MAS-ST address/);
  assert.match(soap.checkUsiConfig({ ...cfg, orgCode: "" }), /not configured/);
  // Create always carries DVSCheckRequired true and refuses to run without a document.
  const body = soap.createBody("VA1803", { requestId: "R1", applicationId: "1", userReference: "u", firstName: "A", familyName: "B", gender: "X", dateOfBirth: "1990-01-01",
    countryOfBirthCode: "7103", townCityOfBirth: "Mumbai", countryOfResidenceCode: "1101", email: "a@b.co", mobile: "0412345678",
    nationalAddress: { address1: "1 Collins St", suburb: "MELBOURNE", state: "VIC", postcode: "3000" }, documentXml: '<DVSDocument xsi:type="VisaDocumentType"><PassportNumber>1</PassportNumber></DVSDocument>' });
  assert.match(body, /<DVSCheckRequired>true<\/DVSCheckRequired>/);
  assert.match(body, /<ContactDetails><CountryOfResidenceCode>1101<\/CountryOfResidenceCode><EmailAddress>a@b.co<\/EmailAddress><Phone><Mobile>0412345678<\/Mobile><\/Phone><NationalAddress>/);
  const client = new soap.UsiClient(cfg, (() => { throw new Error("no network in tests"); }) as typeof fetch);
  assert.throws(() => client.create({ requestId: "R", applicationId: "1", userReference: "u", gender: "X", dateOfBirth: "1990-01-01", countryOfBirthCode: "1101", townCityOfBirth: "X", countryOfResidenceCode: "1101", documentXml: "" }), /identity document is required/);
});

test("USI service: identity documents and the application's answers", async () => {
  const docs = await import("../supabase/functions/_shared/validation/usi-documents.ts");
  const person = await import("../supabase/functions/_shared/usi/person.ts");
  assert.deepEqual(docs.usiDocumentProblems("", {}), { _type: "Choose the identity document." });
  assert.equal(docs.usiDocumentXml("visa", { PassportNumber: " n 123 4567 " }), '<DVSDocument xsi:type="VisaDocumentType"><PassportNumber>N1234567</PassportNumber></DVSDocument>');
  assert.equal(docs.usiDocumentXml("visa", {}), "");
  assert.deepEqual(Object.keys(docs.usiDocumentProblems("drivers_licence", { LicenceNumber: "111111", State: "ACT" })), ["CardNumber"]);
  assert.match(docs.usiDocumentProblems("passport", { DocumentNumber: "123" }).DocumentNumber, /letters then 7 digits/);
  // Birth certificate: the state decides which dates are needed and sent.
  assert.deepEqual(Object.keys(docs.usiDocumentProblems("birth_certificate", { RegistrationNumber: "1234", RegistrationState: "QLD" })), ["RegistrationDate"]);
  assert.equal(docs.usiDocumentXml("birth_certificate", { RegistrationNumber: "1234", RegistrationState: "VIC", RegistrationDate: "2001-01-01" }),
    '<DVSDocument xsi:type="BirthCertificateDocumentType"><RegistrationNumber>1234</RegistrationNumber><RegistrationState>VIC</RegistrationState></DVSDocument>');
  assert.match(docs.usiDocumentXml("medicare", { MedicareCardNumber: "1111111111", IndividualRefNumber: "1", ExpiryDate: "2027-05", CardColour: "Green", NameLine1: "MARYAM FREDRICK" }), /<NameLine1>MARYAM FREDRICK<\/NameLine1>/);
  assert.equal(docs.USI_DOCUMENTS.length, 9);
  // Answers -> USI fields.
  assert.deepEqual(person.usiNames({ first_name: "José Maria", middle_name: "", last_name: "O’Brien-Smith" }), { firstName: "Jose Maria", middleName: undefined, familyName: "O'Brien-Smith" });
  assert.deepEqual(person.usiNames({ first_name: "", last_name: "Testsinglename" }), { singleName: "Testsinglename" });
  assert.equal(person.usiGender({ gender: "Female" }), "F");
  assert.equal(person.usiGender({ gender: "Prefer not to say" }), "X");
  assert.equal(person.usiDate("1966-05-25"), "1966-05-25");
  assert.equal(person.usiDate("25/05/1966"), "1966-05-25");
  assert.equal(person.usiDate("2001-02-30"), "");
  assert.equal(person.usiAustralianMobile("+61412345678"), "0412345678");
  assert.equal(person.usiAustralianMobile("+919876543210"), null);
  assert.equal(person.usiCreateMobile("+919876543210"), "919876543210");
  assert.equal(person.usiTownOfBirth({ place_of_birth: "Ahmedabad, Gujarat" }), "Ahmedabad");
  assert.equal(person.usiState("Victoria"), "VIC");
  const list = [{ code: "1101", name: "Australia" }, { code: "7103", name: "India" }, { code: "2102", name: "United Kingdom, Channel Islands and Isle of Man" }];
  assert.equal(person.usiCountryCode("india", list), "7103");
  assert.equal(person.usiCountryCode("United Kingdom", list), "2102");
  assert.equal(person.usiCountryCode("Atlantis", list), "");
  assert.deepEqual(person.usiVerifyInput({ first_name: "A", last_name: "", dob: "" }).problems, ["the date of birth"]);
});

test("phone: Australian normalisation, validation and display", async () => {
  const { normalizePhoneInput, validatePhone, formatPhone, formatNational, parseStoredPhone, AU_PHONE_MESSAGE } = await import("../supabase/functions/_shared/validation/identifiers.ts");
  const check = (dial: string, typed: string) => { const n = normalizePhoneInput(dial, typed); return { e164: n.e164, message: validatePhone(n.dial, n.national) }; };
  assert.deepEqual(check("61", "0412345678"), { e164: "+61412345678", message: "" });
  assert.deepEqual(check("61", "+61412345678"), { e164: "+61412345678", message: "" });
  assert.deepEqual(check("61", "412345678"), { e164: "+61412345678", message: "" });
  assert.deepEqual(check("61", "0412 345 678"), { e164: "+61412345678", message: "" });
  assert.deepEqual(check("61", "0291234567"), { e164: "+61291234567", message: "" });
  assert.equal(check("61", "12345").message, AU_PHONE_MESSAGE);
  assert.deepEqual(check("61", "0505345678"), { e164: "+61505345678", message: "" });
  assert.equal(check("61", "05053456").message, AU_PHONE_MESSAGE);
  assert.deepEqual(check("61", ""), { e164: "", message: "" });
  assert.equal(check("91", "9876543210").message, "");
  assert.equal(check("91", "+441234567890").e164, "+441234567890");
  assert.equal(formatPhone("+61412345678"), "041 234 5678");
  assert.equal(formatPhone("0412345678"), "041 234 5678");
  assert.deepEqual(check("61", "041 234 5678"), { e164: "+61412345678", message: "" });
  assert.equal(formatPhone("+919876543210"), "+91 987 654 321 0");
  assert.equal(formatPhone("(03) 9123 4567"), "(03) 9123 4567");
  assert.equal(parseStoredPhone("(03) 9123 4567"), null);
  // Australian digits format live with the trunk 0 added, grouped 3-3-4.
  assert.equal(formatNational("61", "4"), "04");
  assert.equal(formatNational("61", "4123"), "041 23");
  assert.equal(formatNational("61", "291234567"), "029 123 4567");
});
