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

test("USI: format rules, forbidden characters, case, blank", async () => {
  const { validateUsi, normalizeUsi, hasForbiddenUsiCharacter, USI_FORMAT_MESSAGE } = await import("../supabase/functions/_shared/validation/identifiers.ts");
  assert.equal(validateUsi("ABCDEFGHJK"), "");
  assert.equal(validateUsi("abcdefghjk"), "");
  assert.equal(normalizeUsi("abcd-efgh jk99"), "ABCDEFGHJK");
  assert.equal(validateUsi(""), "");
  assert.equal(validateUsi("   "), "");
  assert.equal(validateUsi("ABCDEFGHJ"), USI_FORMAT_MESSAGE);
  assert.equal(validateUsi("ABCDEFGHJKL"), USI_FORMAT_MESSAGE);
  for (const bad of ["abcd1efghi", "ABCD0EFGHJ", "ABCDIEFGHJ", "ABCDOEFGHJ", "ABCD!EFGHJ"]) assert.equal(validateUsi(bad), USI_FORMAT_MESSAGE, bad);
  assert.equal(hasForbiddenUsiCharacter("abcd1efghi"), true);
  assert.equal(hasForbiddenUsiCharacter("abcdefghjk"), false);
});

test("phone: Australian normalisation, validation and display", async () => {
  const { normalizePhoneInput, validatePhone, formatPhone, parseStoredPhone, AU_PHONE_MESSAGE } = await import("../supabase/functions/_shared/validation/identifiers.ts");
  const check = (dial: string, typed: string) => { const n = normalizePhoneInput(dial, typed); return { e164: n.e164, message: validatePhone(n.dial, n.national) }; };
  assert.deepEqual(check("61", "0412345678"), { e164: "+61412345678", message: "" });
  assert.deepEqual(check("61", "+61412345678"), { e164: "+61412345678", message: "" });
  assert.deepEqual(check("61", "412345678"), { e164: "+61412345678", message: "" });
  assert.deepEqual(check("61", "0412 345 678"), { e164: "+61412345678", message: "" });
  assert.deepEqual(check("61", "0291234567"), { e164: "+61291234567", message: "" });
  assert.equal(check("61", "12345").message, AU_PHONE_MESSAGE);
  assert.equal(check("61", "0512345678").message, AU_PHONE_MESSAGE);
  assert.deepEqual(check("61", ""), { e164: "", message: "" });
  assert.equal(check("91", "9876543210").message, "");
  assert.equal(check("91", "+441234567890").e164, "+441234567890");
  assert.equal(formatPhone("+61412345678"), "+61 412 345 678");
  assert.equal(formatPhone("0412345678"), "+61 412 345 678");
  assert.equal(formatPhone("(03) 9123 4567"), "(03) 9123 4567");
  assert.equal(parseStoredPhone("(03) 9123 4567"), null);
});
