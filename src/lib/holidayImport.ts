/**
 * Public holidays import (20261110220000 hr_admin_holidays_import): turns the rows of an Excel (.xlsx) or CSV sheet into holidays.
 * No network here, so it is tested offline. The first row is the header; columns are matched by name, in any order:
 *   Date (required) · Holiday / Name (required) · Optional (yes/no) · State (e.g. VIC; blank = the HR setting) · Note
 * Dates may be real Excel dates, YYYY-MM-DD, or Australian D/M/YYYY (also with "-" or "."). Two-digit years are refused.
 */

export interface HolidayImportRow { date: string; name: string; isOptional: boolean; state?: string; note?: string }
export interface HolidayImportResult { rows: HolidayImportRow[]; problems: string[] }
type Cell = string | number | boolean | Date | null | undefined;

export const HOLIDAY_TEMPLATE_HEADER = ["Date", "Holiday", "Optional", "State", "Note"] as const;
export const HOLIDAY_IMPORT_MAX = 500;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100 ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** A cell as a YYYY-MM-DD date, or null. */
export function holidayDate(cell: Cell): string | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : iso(cell.getUTCFullYear(), cell.getUTCMonth() + 1, cell.getUTCDate());
  if (typeof cell === "number") {
    // An Excel serial day number (1900 date system) that the reader left as a number.
    if (cell < 36526 || cell > 73415) return null;
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(cell) * 86400000);
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const text = String(cell ?? "").trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

function yesNo(cell: Cell): boolean | null {
  if (typeof cell === "boolean") return cell;
  const v = String(cell ?? "").trim().toLowerCase();
  if (["", "no", "n", "false", "0"].includes(v)) return false;
  if (["yes", "y", "true", "1", "optional"].includes(v)) return true;
  return null;
}

const key = (cell: Cell) => String(cell ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
const COLUMN: Record<string, keyof HolidayImportRow> = {
  date: "date", holidaydate: "date", day: "date",
  holiday: "name", name: "name", holidayname: "name", description: "name",
  optional: "isOptional", isoptional: "isOptional",
  state: "state",
  note: "note", notes: "note", comment: "note",
};

/** Rows of a sheet (header first) as holidays, with every problem by spreadsheet row number. Blank rows are skipped. */
export function parseHolidaySheet(sheet: Cell[][]): HolidayImportResult {
  const problems: string[] = [];
  const headerIndex = sheet.findIndex((row) => row.some((c) => String(c ?? "").trim() !== ""));
  if (headerIndex < 0) return { rows: [], problems: ["The file is empty."] };
  const columns = new Map<keyof HolidayImportRow, number>();
  sheet[headerIndex].forEach((cell, i) => { const k = COLUMN[key(cell)]; if (k && !columns.has(k)) columns.set(k, i); });
  if (!columns.has("date") || !columns.has("name")) {
    return { rows: [], problems: ["The first row must have the column headings Date and Holiday (download the template to see the layout)."] };
  }
  const at = (row: Cell[], k: keyof HolidayImportRow): Cell => (columns.has(k) ? row[columns.get(k)!] : null);
  const rows: HolidayImportRow[] = [];
  const seen = new Set<string>();
  sheet.slice(headerIndex + 1).forEach((row, i) => {
    const line = headerIndex + i + 2;
    if (!row.some((c) => String(c ?? "").trim() !== "")) return;
    const date = holidayDate(at(row, "date"));
    const name = String(at(row, "name") ?? "").trim();
    const optional = yesNo(at(row, "isOptional"));
    const state = String(at(row, "state") ?? "").trim().toUpperCase();
    const note = String(at(row, "note") ?? "").trim();
    const rowProblems: string[] = [];
    if (!date) rowProblems.push("the date is missing or not a date (use YYYY-MM-DD or DD/MM/YYYY)");
    if (!name) rowProblems.push("the holiday name is missing");
    else if (name.length > 120) rowProblems.push("the holiday name is longer than 120 characters");
    if (optional === null) rowProblems.push("Optional must be Yes or No");
    if (state && !/^[A-Z]{2,3}$/.test(state)) rowProblems.push("State must be like VIC");
    if (note.length > 500) rowProblems.push("the note is longer than 500 characters");
    if (rowProblems.length) { problems.push(`Row ${line}: ${rowProblems.join("; ")}.`); return; }
    const dup = `${state}|${date}|${name.toLowerCase()}`;
    if (seen.has(dup)) { problems.push(`Row ${line}: the same holiday is listed twice.`); return; }
    seen.add(dup);
    rows.push({ date: date!, name, isOptional: optional ?? false, ...(state ? { state } : {}), ...(note ? { note } : {}) });
  });
  if (!rows.length && !problems.length) problems.push("The file has no holidays under the heading row.");
  if (rows.length > HOLIDAY_IMPORT_MAX) problems.push(`Import up to ${HOLIDAY_IMPORT_MAX} holidays at a time.`);
  return { rows, problems };
}

/** A small CSV reader (quotes, commas and new lines inside quotes; a UTF-8 BOM is ignored). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); out.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

/** Reads an .xlsx (first sheet) or .csv file into holidays. The Excel reader is loaded only when needed. */
export async function readHolidayFile(file: File): Promise<HolidayImportResult> {
  const name = file.name.toLowerCase();
  if (file.size > 2 * 1024 * 1024) return { rows: [], problems: ["The file must be 2 MB or smaller."] };
  if (name.endsWith(".csv")) return parseHolidaySheet(parseCsv(await file.text()));
  if (name.endsWith(".xlsx")) {
    try {
      const { readSheet } = await import("read-excel-file/browser");
      return parseHolidaySheet((await readSheet(file)) as Cell[][]);
    } catch {
      return { rows: [], problems: ["The Excel file could not be read. Save it as .xlsx (Excel Workbook) or .csv and try again."] };
    }
  }
  return { rows: [], problems: ["Choose an Excel (.xlsx) or CSV (.csv) file."] };
}

/** Downloads the Excel template, with two example rows for the given year. */
export async function downloadHolidayTemplate(year: number): Promise<void> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const header = HOLIDAY_TEMPLATE_HEADER.map((value) => ({ value, fontWeight: "bold" as const }));
  const example = (d: string, n: string, o: string, note = "") => [
    { type: Date, value: new Date(`${d}T00:00:00Z`), format: "dd/mm/yyyy" }, { type: String, value: n }, { type: String, value: o },
    { type: String, value: "VIC" }, { type: String, value: note },
  ];
  await writeXlsxFile([header, example(`${year}-01-01`, "New Year's Day", "No"), example(`${year}-12-24`, "Christmas Eve (afternoon)", "Yes", "Example of an optional day")],
    { columns: [{ width: 14 }, { width: 36 }, { width: 10 }, { width: 8 }, { width: 40 }] }).toFile(`public-holidays-template-${year}.xlsx`);
}
