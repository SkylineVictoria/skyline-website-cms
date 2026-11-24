// A FICTIONAL specimen passport data page for USI testing (2026-11-23, owner). Not a real person and not a real document: the page
// carries "SPECIMEN" across it and "FICTIONAL TEST DOCUMENT - NOT VALID FOR TRAVEL OR IDENTITY" at the foot, and it uses no national
// emblem, seal, security pattern or official design. The machine-readable zone (ICAO 9303 TD3) has correct check digits so the
// passport reader can parse it.
// Writes scripts/e2e/fixtures/specimen-passport-usi.png:  npx jiti scripts/e2e/fixtures/specimen-passport.ts
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SPECIMEN = {
  givenNames: "TESTMKPA",
  surname: "SKYLINEZVBQ",
  sex: "F",
  dateOfBirth: "1998-03-09",
  placeOfBirth: "PUNE, MAHARASHTRA",
  nationality: "INDIAN",
  countryCode: "IND",
  number: "Z1234567",
  issued: "2024-01-15",
  expires: "2034-01-14",
  placeOfIssue: "PUNE",
} as const;

/** ICAO 9303 check digit: weights 7, 3, 1; 0-9 as themselves, A-Z as 10-35, "<" as 0. */
export function mrzCheckDigit(text: string): string {
  const value = (c: string) => c === "<" ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
  return String([...text].reduce((sum, c, i) => sum + value(c) * [7, 3, 1][i % 3], 0) % 10);
}

const yymmdd = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
const pad = (text: string, size: number) => (text + "<".repeat(size)).slice(0, size);

/** The two 44-character TD3 lines. */
export function specimenMrz(p = SPECIMEN): [string, string] {
  const line1 = pad(`P<${p.countryCode}${p.surname}<<${p.givenNames.replace(/ /g, "<")}`, 44);
  const number = pad(p.number, 9), dob = yymmdd(p.dateOfBirth), expiry = yymmdd(p.expires), personal = "<".repeat(14);
  const parts = [number + mrzCheckDigit(number), p.countryCode, dob + mrzCheckDigit(dob), p.sex, expiry + mrzCheckDigit(expiry), personal + mrzCheckDigit(personal)];
  // Composite: number + check, DOB + check, expiry + check, personal number + check.
  const composite = parts[0] + parts[2] + parts[4] + parts[5];
  const line2 = parts.join("") + mrzCheckDigit(composite);
  if (line1.length !== 44 || line2.length !== 44) throw new Error("MRZ lines must be 44 characters");
  return [line1, line2];
}

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function specimenPassportPng(p = SPECIMEN): Buffer {
  const W = 1500, H = 1060;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext("2d");
  g.fillStyle = "#f4f1ea"; g.fillRect(0, 0, W, H);
  g.strokeStyle = "#8a8f98"; g.lineWidth = 4; g.strokeRect(20, 20, W - 40, H - 40);
  g.fillStyle = "#3a3f47"; g.font = "bold 34px Arial";
  g.fillText("PASSPORT  ·  SPECIMEN  ·  FICTIONAL TEST DOCUMENT", 70, 90);
  // Photo area: an empty placeholder (no face).
  g.strokeStyle = "#9aa0a8"; g.lineWidth = 3; g.strokeRect(70, 150, 330, 420);
  g.fillStyle = "#9aa0a8"; g.font = "28px Arial"; g.fillText("NO PHOTO", 165, 370); g.fillText("(SPECIMEN)", 155, 410);
  const rows: [string, string][] = [
    ["Type / Type", "P"], ["Country Code / Code du pays", p.countryCode], ["Passport No. / No. du passeport", p.number],
    ["Surname / Nom", p.surname], ["Given Name(s) / Prénoms", p.givenNames], ["Nationality / Nationalité", p.nationality],
    ["Sex / Sexe", p.sex], ["Date of Birth / Date de naissance", dmy(p.dateOfBirth)], ["Place of Birth / Lieu de naissance", p.placeOfBirth],
    ["Place of Issue / Lieu de délivrance", p.placeOfIssue], ["Date of Issue / Date de délivrance", dmy(p.issued)], ["Date of Expiry / Date d'expiration", dmy(p.expires)],
  ];
  // Two columns of label / value pairs.
  rows.forEach(([label, value], i) => {
    const x = i < 6 ? 450 : 980, y = 150 + (i % 6) * 110;
    g.fillStyle = "#5b616b"; g.font = "22px Arial"; g.fillText(label, x, y);
    g.fillStyle = "#111418"; g.font = "bold 34px Arial"; g.fillText(value, x, y + 40);
  });
  // Watermark across the page.
  g.save(); g.translate(W / 2, H / 2 - 60); g.rotate(-0.32);
  g.fillStyle = "rgba(200, 30, 30, 0.22)"; g.font = "bold 190px Arial"; g.textAlign = "center"; g.fillText("SPECIMEN", 0, 60);
  g.restore();
  // MRZ.
  const [l1, l2] = specimenMrz(p);
  g.fillStyle = "#ffffff"; g.fillRect(40, 830, W - 80, 170);
  g.fillStyle = "#000000"; g.font = "bold 44px 'Courier New', monospace";
  g.fillText(l1, 60, 895); g.fillText(l2, 60, 965);
  g.fillStyle = "#b42318"; g.font = "bold 22px Arial";
  g.fillText("FICTIONAL TEST DOCUMENT - NOT VALID FOR TRAVEL OR IDENTITY - SKYLINE USI TESTING ONLY", 70, 1025);
  return canvas.toBuffer("image/png");
}

export const SPECIMEN_FILE = fileURLToPath(new URL("./specimen-passport-usi.png", import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].replace(/\//g, "\\").toLowerCase()) {
  writeFileSync(SPECIMEN_FILE, specimenPassportPng());
  console.log(`written ${SPECIMEN_FILE}\n${specimenMrz().join("\n")}`);
}
