// Offline checks of src/lib/holidayImport.ts (Public Holidays > Import from Excel). Run: npx jiti scripts/test-holiday-import.ts
import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-holiday-import"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import writeXlsxFile from "write-excel-file/node";
import { readSheet } from "read-excel-file/node";
import { holidayDate, parseCsv, parseHolidaySheet, HOLIDAY_TEMPLATE_HEADER } from "../src/lib/holidayImport";
import { courseStartFor, courseStartForEnd, cyclesUntil, teachingDays, voeLayout, voeWeeks } from "../src/pages/admin/lib/masterDates";
import { fetchVicTerms, newBreaks, parseVicTerms, schoolBreaks, termsUntil } from "../src/pages/admin/lib/schoolTerms";
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
// Term breaks from the Victorian school calendar (Important Dates open data; one row per term start / end day).
const VIC_TERMS = [
  ["Term 1 2029 -Start date", "30/01/2029"], ["Term 1 2029 -End date", "29/03/2029"], ["Term 2 2029 - Start date", "16/04/2029"],
  ["Term 2 2029 - End date", "29/06/2029"], ["Term 3 2029 - Start date", "16/07/2029"], ["Term 3 2029-End date", "21/09/2029"],
  ["Term 4 2029 -Start date", "8/10/2029"], ["Term 4  2029 End date", "21/12/2029"], ["Term 1 2030 - Start date", "29/01/2030"],
  ["Term 1 2030 - End date", "5/04/2030"], ["Term 2 2030 - Start date", "23/04/2030"], ["Term 2 2030 - End date", "28/06/2030"],
  ["Term 3 2030 - Start date", "15/07/2030"], ["Term 3 2030 - End date", "20/09/2030"], ["Term 4 2030 - Start date", "7/10/2030"],
  ["Term 4 2030 - End date", "20/12/2030"], ["Term 3 2020 - End date", "18/09/2020"], ["Term 3 2020 - End date", "11/09/2020"],
].map(([name, important_date]) => ({ dateType: "SCHOOL_TERM", name, important_date }));
await check("school terms: parsed from the dataset names, a term listed twice keeps its latest end", () => {
  const terms = parseVicTerms([...VIC_TERMS, { dateType: "PUBLIC_HOLIDAY", name: "Term 1 2030 - Start date", important_date: "1/01/2030" }]);
  assert.equal(terms.length, 8); // Term 3 2020 has no start date: left out
  assert.deepEqual(terms[0], { year: 2029, term: 1, start: "2029-01-30", end: "2029-03-29" });
  assert.equal(terms.at(-1)!.end, "2030-12-20");
});
await check("school breaks: Monday to Sunday between terms; later years predicted by whole weeks", () => {
  const terms = parseVicTerms(VIC_TERMS);
  const breaks = schoolBreaks(terms, "2029-01-01", "2031-12-31");
  assert.deepEqual(breaks[0], { label: "Term 1 break 2029", startDate: "2029-04-02", endDate: "2029-04-15", predicted: false });
  assert.deepEqual(breaks.find(b => b.label.startsWith("Summer break 2029")), { label: "Summer break 2029–30", startDate: "2029-12-24", endDate: "2030-01-27", predicted: false });
  const summer30 = breaks.find(b => b.label.startsWith("Summer break 2030"))!;
  assert.equal(summer30.predicted, true);
  assert.match(summer30.label, /predicted: check/);
  assert.equal(summer30.startDate, "2030-12-23");
  const predicted = termsUntil(terms, 2031).filter(t => t.predicted);
  assert.equal(predicted.length, 4);
  assert.ok(predicted.every(t => new Date(t.start + "T00:00:00Z").getUTCDay() === new Date(terms.find(x => x.term === t.term && x.year === 2030)!.start + "T00:00:00Z").getUTCDay()));
  for (const b of breaks) { assert.equal(new Date(b.startDate + "T00:00:00Z").getUTCDay(), 1); assert.equal(new Date(b.endDate + "T00:00:00Z").getUTCDay(), 0); }
});
await check("school breaks: breaks already entered are kept, overlapping ones skipped", () => {
  const breaks = schoolBreaks(parseVicTerms(VIC_TERMS), "2029-01-01", "2030-12-31");
  const kept = newBreaks(breaks, [{ startDate: "2029-12-20", endDate: "2030-01-20" }]);
  assert.equal(kept.length, breaks.length - 1);
  assert.ok(!kept.some(b => b.label.startsWith("Summer break 2029")));
});
await check("school terms: fetch uses the SCHOOL_TERM filter and refuses an empty or failed answer", async () => {
  let asked = "";
  const ok = (async (url: string) => { asked = url; return new Response(JSON.stringify({ success: true, result: { records: VIC_TERMS } })); }) as typeof fetch;
  assert.equal((await fetchVicTerms(ok)).length, 8);
  assert.match(decodeURIComponent(asked), /resource_id=caaa47de-8626-46a6-aa28-3d948c15c5d9.*"dateType":"SCHOOL_TERM"/);
  await assert.rejects(fetchVicTerms((async () => new Response("{}", { status: 503 })) as typeof fetch), /HTTP 503/);
  await assert.rejects(fetchVicTerms((async () => new Response(JSON.stringify({ success: true, result: { records: [] } }))) as typeof fetch), /no school terms/);
});
await check("master dates: a unit's chosen start or end date gives the course start (weeks fixed, breaks skipped)", () => {
  const breaks = [["2026-12-21", "2027-01-17"], ["2027-03-29", "2027-04-11"]];
  const isBreak = (d: string) => breaks.some(([a, b]) => d >= a && d <= b);
  const next = (d: string) => new Date(Date.parse(d + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  // public.course_master_layout, forwards.
  const layout = (start: string, weeks: number[]) => { let d = start; return weeks.map(w => { let left = teachingDays(w), from = ""; for (;;) { if (!isBreak(d)) { from ||= d; if (--left === 0) break; } d = next(d); } const out = { from, to: d }; d = next(d); return out; }); };
  const weeks = [3, 1, 5, 0.5, 4.5];
  for (const [index, date] of [[2, "2027-01-18"], [4, "2027-04-12"], [1, "2026-12-07"], [0, "2026-11-02"]] as const) {
    assert.equal(layout(courseStartFor(date, index, weeks, isBreak), weeks)[index].from, date, `start of unit ${index}`);
  }
  for (const [index, date] of [[2, "2027-02-14"], [3, "2027-04-15"]] as const) {
    assert.equal(layout(courseStartForEnd(date, index, weeks, isBreak), weeks)[index].to, date, `end of unit ${index}`);
  }
  const endOf = (cycles: number) => new Date(Date.parse("2026-11-01T00:00:00Z") + (cycles * 546 - 1) * 86400000).toISOString().slice(0, 10);
  assert.equal(cyclesUntil("2026-11-01", endOf(6), 546), 6); // the last day of cycle 6
  assert.equal(cyclesUntil("2026-11-01", next(endOf(6)), 546), 7); // one day more needs a 7th cycle
  assert.equal(cyclesUntil("2026-11-01", "2027-01-01", 546), 1);
});
await check("VoE calendar, manual: two units at once, never over 40 h a week, prerequisites first", () => {
  const isBreak = (d: string) => d >= "2026-12-21" && d <= "2027-01-17";
  const u = (code: string, hours: number, rate: number, prerequisites: string[] = []) => ({ unitId: code, code, hours, rate, prerequisites });
  const plan = voeLayout([u("WHS", 20, 20), u("CA2002", 96, 20), u("CA3007", 60, 20, ["WHS"]), u("CA2011", 16, 20)], "2026-11-02", isBreak, "manual");
  const at = (code: string) => plan.rows.find(r => r.code === code)!;
  assert.equal(at("WHS").startDate, "2026-11-02");
  assert.equal(at("CA2002").startDate, "2026-11-02"); // 20 h + 20 h
  assert.ok(at("CA3007").startDate > at("WHS").endDate); // waits for its prerequisite
  assert.ok(voeWeeks(plan, "2026-11-02", isBreak).every(w => w.ok));
  // 30 h + 20 h = 50 h is blocked: the 20 h unit waits; 20 h + 15 h = 35 h runs together.
  const p2 = voeLayout([u("A", 60, 30), u("B", 40, 20), u("C", 30, 15)], "2027-02-01", isBreak, "manual");
  const a = p2.rows.find(r => r.code === "A")!, b = p2.rows.find(r => r.code === "B")!, c = p2.rows.find(r => r.code === "C")!;
  assert.ok(b.startDate > a.endDate, "30 h + 20 h never together");
  assert.ok(c.startDate > a.endDate, "30 h + 15 h = 45 h never together");
  assert.ok(c.startDate <= b.endDate && b.startDate <= c.endDate, "20 h + 15 h = 35 h together");
  assert.ok(voeWeeks(p2, "2027-02-01", isBreak).every(w => w.ok && w.total <= 40));
  // Term breaks are skipped.
  assert.ok(voeLayout([u("X", 100, 20)], "2026-12-07", isBreak, "manual").rows[0].endDate > "2027-01-17");
});
await check("VoE calendar, automatic: every week 40 h, one unit at 40 h or two at 20 h + 20 h", () => {
  const none = () => false;
  const u = (code: string, hours: number, prerequisites: string[] = []) => ({ unitId: code, code, hours, rate: 20, prerequisites });
  const solo = voeLayout([u("A", 80)], "2027-02-01", none, "automatic");
  assert.deepEqual([solo.rows[0].rates, solo.rows[0].days], [[40], 14]); // 80 h at 40 h a week: 2 weeks
  const pair = voeLayout([u("A", 40), u("B", 40)], "2027-02-01", none, "automatic");
  assert.deepEqual(pair.rows.map(r => [r.rates, r.days]), [[[20], 14], [[20], 14]]); // 20 h + 20 h: both 2 weeks
  // B needs A: A runs alone at 40 h, then B alone at 40 h; C runs beside A at 20 h + 20 h.
  const chain = voeLayout([u("A", 40), u("B", 40, ["A"]), u("C", 20)], "2027-02-01", none, "automatic");
  const weeks = voeWeeks(chain, "2027-02-01", none);
  assert.ok(weeks.every(w => w.ok && w.total === 40), weeks.map(w => w.total).join(","));
  assert.ok(chain.rows.find(r => r.code === "B")!.startDate > chain.rows.find(r => r.code === "A")!.endDate);
});
console.log(`holiday import + sync core + school terms + master dates + VoE: ${passed}/18 passed`);
