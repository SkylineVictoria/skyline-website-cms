// Offline checks of src/lib/holidayImport.ts (Public Holidays > Import from Excel). Run: npx jiti scripts/test-holiday-import.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeXlsxFile from "write-excel-file/node";
import { readSheet } from "read-excel-file/node";
import { holidayDate, parseCsv, parseHolidaySheet, HOLIDAY_TEMPLATE_HEADER } from "../src/lib/holidayImport";

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
console.log(`holiday import: ${passed}/6 passed`);
