// Offline checks of src/lib/holidayImport.ts (Public Holidays > Import from Excel). Run: npx jiti scripts/test-holiday-import.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeXlsxFile from "write-excel-file/node";
import { readSheet } from "read-excel-file/node";
import { holidayDate, parseCsv, parseHolidaySheet, HOLIDAY_TEMPLATE_HEADER } from "../src/lib/holidayImport";
import { completeVictorianDays, normaliseVicName, parseDataGovRecords, parseNagerRows, pickDataGovResource, runSync, type FetchJson } from "../supabase/functions/holiday-sync/core";

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { passed++; }, (e) => { console.error(`FAIL ${name}`); throw e; });

await check("dates", () => {
  assert.equal(holidayDate("2027-01-26"), "2027-01-26");
  assert.equal(holidayDate("26/01/2027"), "2027-01-26");
  assert.equal(holidayDate("6.4.2027"), "2027-04-06");
  assert.equal(holidayDate(new Date(Date.UTC(2027, 10, 2))), "2027-11-02");
  assert.equal(holidayDate(46777), "2028-01-25"); // Excel serial
  assert.equal(holidayDate("31/02/2027"), null);
  assert.equal(holidayDate("26/01/27"), null);
  assert.equal(holidayDate("01/26/2027"), null); // US order is refused (month 26)
});
await check("csv with quotes", () => {
  assert.deepEqual(parseCsv('﻿Date,Holiday\r\n2027-01-01,"New Year\'s Day, observed"\n'), [["Date", "Holiday"], ["2027-01-01", "New Year's Day, observed"]]);
});
await check("sheet ok, columns in any order, blank rows skipped", () => {
  const r = parseHolidaySheet([["Holiday", "Optional", "date", "Note"], ["Labour Day", "no", "08/03/2027", ""], [null, null, null, null], ["Christmas Eve", "Yes", "2027-12-24", "afternoon"]]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.rows, [{ date: "2027-03-08", name: "Labour Day", isOptional: false }, { date: "2027-12-24", name: "Christmas Eve", isOptional: true, note: "afternoon" }]);
});
await check("problems by row number, duplicates", () => {
  const r = parseHolidaySheet([["Date", "Holiday", "Optional", "State"], ["2027-13-01", "", "maybe", "Victoria"], ["2027-01-01", "NY", "", ""], ["2027-01-01", "ny", "", ""]]);
  assert.equal(r.rows.length, 1);
  assert.match(r.problems[0], /^Row 2: .*date.*name.*Optional.*State/);
  assert.match(r.problems[1], /^Row 4: the same holiday is listed twice/);
});
await check("missing headings", () => {
  assert.match(parseHolidaySheet([["When", "What"], ["2027-01-01", "x"]]).problems[0], /Date and Holiday/);
  assert.match(parseHolidaySheet([]).problems[0], /empty/);
});
await check("real xlsx round trip (template layout)", async () => {
  // A fresh folder under the OS temp dir (never the repo), removed afterwards even when an assertion fails.
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "skyline-holiday-"));
  const file = join(dir, "holiday-test.xlsx");
  try {
  await writeXlsxFile([
    HOLIDAY_TEMPLATE_HEADER.map((value) => ({ value })),
    [{ type: Date, value: new Date("2027-01-26T00:00:00Z"), format: "dd/mm/yyyy" }, { type: String, value: "Australia Day" }, { type: String, value: "No" }, { type: String, value: "VIC" }, null],
    [{ type: String, value: "02/11/2027" }, { type: String, value: "Melbourne Cup Day" }, { type: String, value: "No" }, null, null],
  ]).toFile(file);
  const r = parseHolidaySheet((await readSheet(file)) as never);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.rows, [{ date: "2027-01-26", name: "Australia Day", isOptional: false, state: "VIC" }, { date: "2027-11-02", name: "Melbourne Cup Day", isOptional: false }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- holiday-sync core (supabase/functions/holiday-sync/core.ts), offline with fake fetchers
// Shapes copied from the real answers of 2026-11-11: Nager.Date 2026 / 2027 (AU), data.gov.au datastore rows (2025, vic).
const NAGER_2026 = [
  { date: "2026-01-01", name: "New Year's Day", counties: null, types: ["Public"] }, { date: "2026-01-26", name: "Australia Day", counties: null, types: ["Public"] },
  { date: "2026-03-02", name: "Labour Day", counties: ["AU-WA"], types: ["Public"] }, { date: "2026-03-09", name: "Labour Day", counties: ["AU-VIC"], types: ["Public"] },
  { date: "2026-04-03", name: "Good Friday", counties: null, types: ["Public"] }, { date: "2026-04-04", name: "Holy Saturday", counties: ["AU-ACT", "AU-NSW", "AU-NT", "AU-QLD", "AU-SA", "AU-VIC"], types: ["Public"] },
  { date: "2026-04-05", name: "Easter Sunday", counties: ["AU-ACT", "AU-NSW", "AU-VIC", "AU-WA"], types: ["Public"] }, { date: "2026-04-06", name: "Easter Monday", counties: null, types: ["Public"] },
  { date: "2026-04-25", name: "Anzac Day", counties: ["AU-SA", "AU-TAS", "AU-VIC"], types: ["Public"] }, { date: "2026-04-27", name: "Anzac Day", counties: ["AU-ACT", "AU-NSW"], types: ["Public"] },
  { date: "2026-06-08", name: "King's Birthday", counties: ["AU-ACT", "AU-NSW", "AU-VIC"], types: ["Public"] }, { date: "2026-09-25", name: "Friday before AFL Grand Final", counties: ["AU-VIC"], types: ["Public"] },
  { date: "2026-11-03", name: "Melbourne Cup", counties: ["AU-VIC"], types: ["Public"] }, { date: "2026-12-25", name: "Christmas Day", counties: null, types: ["Public"] },
  { date: "2026-12-28", name: "St. Stephen's Day", counties: null, types: ["Public"] }, { date: "2026-12-24", name: "Christmas Eve", counties: ["AU-NT"], types: ["Bank"] },
];
const NAGER_2027 = [
  { date: "2027-01-01", name: "New Year's Day", counties: null, types: ["Public"] }, { date: "2027-03-27", name: "Holy Saturday", localName: "Easter Eve", counties: ["AU-VIC"], types: ["Public"] },
  { date: "2027-09-24", name: "Friday before AFL Grand Final (Tentative Date)", counties: ["AU-VIC"], types: ["Public"] }, { date: "2027-11-02", name: "Melbourne Cup", counties: ["AU-VIC"], types: ["Public"] },
  { date: "2027-12-27", name: "Christmas Day", counties: null, types: ["Public"] }, { date: "2027-12-28", name: "St. Stephen's Day", localName: "Boxing Day", counties: null, types: ["Public"] },
];
const DGA_2025 = [
  { _id: 81, Date: "20250101", "Holiday Name": "New Year's Day", Information: null, Jurisdiction: "vic" },
  { _id: 82, Date: "20250127", "Holiday Name": "Australia Day", Information: "As Australia Day falls on a Sunday, the public holiday is on the following Monday.", Jurisdiction: "vic" },
  { _id: 90, Date: null, "Holiday Name": "Friday before the AFL Grand Final", Information: "The Business Victoria website will be updated with the exact date.", Jurisdiction: "vic" },
  { _id: 91, Date: "20251104", "Holiday Name": "Melbourne Cup", Information: "Melbourne Cup Day is a public holiday across all of Victoria.", Jurisdiction: "vic" },
  { _id: 93, Date: "20251226", "Holiday Name": "Boxing Day", Information: null, Jurisdiction: "vic" }, { _id: 99, Date: "20251226", "Holiday Name": "Boxing Day", Information: null, Jurisdiction: "nsw" },
];
const RESOURCES = [{ id: "combined", name: "Australian public holidays combined (2021-2025)", datastore_active: true }, { id: "r2025", name: "Australian Public Holidays 2025", datastore_active: true }, { id: "r2024", name: "Australian Public Holidays 2024", datastore_active: true }];
const line = (h: { date: string; name: string; tentative: boolean }) => `${h.date} ${h.name}${h.tentative ? " ?" : ""}`;

await check("names normalised to Business Victoria wording", () => {
  assert.deepEqual(normaliseVicName("Holy Saturday"), { name: "Saturday before Easter Sunday", tentative: false });
  assert.deepEqual(normaliseVicName("Anzac Day"), { name: "ANZAC Day", tentative: false });
  assert.deepEqual(normaliseVicName("Melbourne Cup"), { name: "Melbourne Cup Day", tentative: false });
  assert.deepEqual(normaliseVicName("Friday before AFL Grand Final (Tentative Date)"), { name: "Friday before the AFL Grand Final", tentative: true });
  assert.deepEqual(normaliseVicName("St. Stephen's Day"), { name: "Boxing Day", tentative: false });
  assert.deepEqual(normaliseVicName("Boxing Day (additional day)"), { name: "Boxing Day (additional day)", tentative: false });
  assert.deepEqual(normaliseVicName("  Picnic   Day "), { name: "Picnic Day", tentative: false });
});
await check("Nager 2026 -> Victoria: state filter, weekend Boxing Day added back, substitute named, Grand Final Friday confirmed", () => {
  const rows = parseNagerRows(NAGER_2026, 2026, "VIC");
  assert.deepEqual(rows.map(line), [
    "2026-01-01 New Year's Day", "2026-01-26 Australia Day", "2026-03-09 Labour Day", "2026-04-03 Good Friday", "2026-04-04 Saturday before Easter Sunday", "2026-04-05 Easter Sunday",
    "2026-04-06 Easter Monday", "2026-04-25 ANZAC Day", "2026-06-08 King's Birthday", "2026-09-25 Friday before the AFL Grand Final", "2026-11-03 Melbourne Cup Day",
    "2026-12-25 Christmas Day", "2026-12-26 Boxing Day", "2026-12-28 Boxing Day (additional day)",
  ]);
  assert.equal(rows.find((h) => h.date === "2026-12-28")!.note, "Additional public holiday for Boxing Day falling on a weekend");
});
await check("Nager 2027 -> Victoria: Christmas and Boxing Day on the weekend keep both days, tentative Grand Final Friday flagged", () => {
  const rows = parseNagerRows(NAGER_2027, 2027, "VIC");
  assert.deepEqual(rows.map(line), [
    "2027-01-01 New Year's Day", "2027-03-27 Saturday before Easter Sunday", "2027-09-24 Friday before the AFL Grand Final ?", "2027-11-02 Melbourne Cup Day",
    "2027-12-25 Christmas Day", "2027-12-26 Boxing Day", "2027-12-27 Christmas Day (additional day)", "2027-12-28 Boxing Day (additional day)",
  ]);
  assert.match(rows.find((h) => h.tentative)!.note, /^Tentative date/);
  assert.deepEqual(completeVictorianDays([{ date: "2028-01-03", name: "New Year's Day", note: "", tentative: false }], 2028).map(line), ["2028-01-01 New Year's Day", "2028-01-03 New Year's Day (additional day)"]);
});
await check("data.gov.au rows: jurisdiction filter, undated row skipped and reported, Information becomes the note", () => {
  const r = parseDataGovRecords(DGA_2025 as never, 2025, "VIC");
  assert.deepEqual(r.holidays.map(line), ["2025-01-01 New Year's Day", "2025-01-27 Australia Day", "2025-11-04 Melbourne Cup Day", "2025-12-26 Boxing Day"]);
  assert.equal(r.holidays[1].note, "As Australia Day falls on a Sunday, the public holiday is on the following Monday.");
  assert.deepEqual(r.skipped, ["2025: Friday before the AFL Grand Final has no date yet in data.gov.au"]);
  assert.equal(pickDataGovResource(RESOURCES, 2025)!.id, "r2025");
  assert.equal(pickDataGovResource(RESOURCES, 2023)!.id, "combined");
  assert.equal(pickDataGovResource(RESOURCES, 2026), null);
});
await check("runSync: data.gov.au first, Nager.Date when the year is missing, failures recorded per year", async () => {
  const fetcher = (nagerDown: boolean): FetchJson => async (url) => {
    if (url.includes("package_show")) return { success: true, result: { resources: RESOURCES } };
    if (url.includes("datastore_search")) return { success: true, result: { records: url.includes("r2025") ? DGA_2025 : [] } };
    if (url.includes("/PublicHolidays/2026/AU")) { if (nagerDown) throw new Error("date.nager.at answered 503"); return NAGER_2026; }
    if (url.includes("/PublicHolidays/2027/AU")) throw new Error("date.nager.at answered 503");
    throw new Error(`unexpected ${url}`);
  };
  const r = await runSync([2025, 2026, 2027], "VIC", fetcher(false), { dataGov: "http://dga.test", nager: "http://nager.test" });
  assert.equal(r.ok, true);
  assert.equal((r.years["2025"] as { source: string }).source, "data.gov.au");
  assert.equal((r.years["2026"] as { source: string }).source, "nager");
  assert.match((r.years["2026"] as { fallbackReason: string }).fallbackReason, /data\.gov\.au has no 2026 holidays dataset yet/);
  assert.match((r.years["2027"] as { error: string }).error, /data\.gov\.au: .*2027.*; Nager\.Date: date\.nager\.at answered 503/);
  assert.deepEqual(r.detail.skipped, ["2025: Friday before the AFL Grand Final has no date yet in data.gov.au"]);
  const down = await runSync([2026, 2027], "VIC", fetcher(true), { dataGov: "http://dga.test", nager: "http://nager.test" });
  assert.equal(down.ok, false);
  assert.match(down.error!, /^2026: data\.gov\.au: .*\| 2027: /);
  assert.equal(Object.keys(down.years).length, 2);
});
console.log(`holiday import + sync core: ${passed}/11 passed`);
