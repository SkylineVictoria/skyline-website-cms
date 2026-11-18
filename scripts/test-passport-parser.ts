import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-passport-parser"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const load = createJiti(import.meta.url, { alias: { "@": path.resolve("src") } });
const { parseDocument, diagnoseSyntheticPassportMrz } = await load.import<typeof import("../src/lib/docScan.ts")>("../src/lib/docScan.ts");

const weights = [7, 3, 1];
const check = (value: string) => value.split("").reduce((sum, char, i) => sum + (char === "<" ? 0 : /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 55) * weights[i % 3], 0) % 10;
function td3(name: string, nationality = "IND") {
  const line1 = (`P<${nationality}${name}`).padEnd(44, "<");
  const passport = "A1234567<";
  const dob = "900101";
  const expiry = "300101";
  const optional = "<<<<<<<<<<<<<<";
  const optionalCheck = check(optional);
  const composite = check(`${passport}${check(passport)}${dob}${check(dob)}${expiry}${check(expiry)}${optional}${optionalCheck}`);
  const line2 = `${passport}${check(passport)}${nationality}${dob}${check(dob)}M${expiry}${check(expiry)}${optional}${optionalCheck}${composite}`;
  return `${line1}\n${line2}`;
}

test("TD3 multiple given names retain surname and do not auto-fill middle name", () => {
  const result = parseDocument("passport", td3("AMIN<<MIHIR<HARNISHBHAI"));
  assert.equal(result.last_name, "AMIN");
  assert.equal(result.first_name, "MIHIR");
  assert.equal(result.passport_given_names, "MIHIR HARNISHBHAI");
  assert.equal(result.middle_name, undefined);
});

test("single-delimiter and repeated-letter OCR noise cannot poison names", () => {
  const noisy = td3("AMIN<MIHIR<HARNISHBHAI");
  const result = parseDocument("passport", noisy);
  assert.equal(result.last_name, undefined);
  assert.equal(result.first_name, undefined);
});

test("diagnostics expose only synthetic candidate MRZ evidence", () => {
  const diagnostic = diagnoseSyntheticPassportMrz(td3("KIM<<SEO<YUN", "KOR"));
  assert.equal(diagnostic.td3Lengths[0], 44);
  assert.equal(diagnostic.checksumScore >= 2, true);
  assert.equal(diagnostic.selectedFieldSources.names, "mrz");
});
