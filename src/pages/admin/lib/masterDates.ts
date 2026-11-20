// Pure date rules of the master timetable plan (no database): CoE weeks, cycles, Calendar till, and the layout run backwards.
export interface CyclePlan {
  courseId: string; saved: boolean; cyclesPlanned: number; currentCycle: number; planEnd: string | null; locked: boolean; canEdit: boolean;
  cycles: { cycle: number; startDate: string; endDate: string }[];
}

/** CoE class hours a week: the master timetable is CoE only (owner, 2026-11-20). */
export const COE_HOURS = 20;
/** A unit's fixed weeks: its SLIT hours ÷ 20, rounded up to the half week (0.5 to 104); without hours, the weeks it has. */
export const fixedWeeks = (hours: number | null | undefined, current: number) =>
  (hours && hours > 0 ? Math.min(104, Math.max(0.5, Math.ceil((hours / COE_HOURS) * 2) / 2)) : current);
/** The calendar is planned at most 10 years ahead (owner, 2026-11-20: "remove the 5 limit, 10 years is allowed"). */
export const MAX_YEARS = 10;
const DAY = 86400000;
/** The most cycles that fit in MAX_YEARS from `start`, each `cycleDays` long (at least 1). */
export const maxCyclesFor = (cycleDays: number) => (cycleDays > 0 ? Math.max(1, Math.floor((MAX_YEARS * 365.25) / cycleDays)) : 1);
/** The cycles needed to reach `till` from `start` (rounded up to whole cycles). */
export const cyclesUntil = (start: string, till: string, cycleDays: number) =>
  cycleDays > 0 ? Math.max(1, Math.ceil((Math.round((Date.parse(till) - Date.parse(start)) / DAY) + 1) / cycleDays)) : 1;
/** The plan's last day: the saved one when the saved plan has this many cycles, else estimated (every cycle as long as the one on screen). */
export function planTill(start: string, cycleEnd: string | null, cycles: number, plan?: CyclePlan | null) {
  const cycleDays = start && cycleEnd ? Math.round((Date.parse(cycleEnd) - Date.parse(start)) / DAY) + 1 : 0;
  const saved = plan?.saved && plan.cyclesPlanned === cycles ? plan.planEnd : null;
  const estimated = cycleDays ? new Date(Date.parse(start + "T00:00:00Z") + (cycles * cycleDays - 1) * DAY).toISOString().slice(0, 10) : null;
  return { cycleDays, till: saved ?? estimated, exact: !!saved };
}

// The master timetable's layout (public.course_master_layout) run backwards. A unit takes round(weeks × 7) teaching days in a row,
// term-break days skipped; its start is its first teaching day. So a unit's start or end date can be chosen while every unit
// keeps its weeks: the course start that puts it there is worked out, and every other unit moves with it (owner, 2026-11-20).
export type IsBreak = (iso: string) => boolean;
const shift = (iso: string, days: number) => new Date(Date.parse(iso + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
/** Teaching days of a unit of `weeks` weeks (as the server counts them). */
export const teachingDays = (weeks: number) => Math.max(1, Math.round(weeks * 7));
/** The first teaching day of the `days` teaching days that end on `last` (a teaching day). */
export function backDays(last: string, days: number, isBreak: IsBreak): string {
  let d = last, left = days, first = last;
  for (let guard = 0; left > 0 && guard < 20000; guard++, d = shift(d, -1)) if (!isBreak(d)) { first = d; left--; }
  return first;
}
/** The course start that makes the unit at `index` (0-based, in `weeks` order) start on `unitStart`. */
export function courseStartFor(unitStart: string, index: number, weeks: number[], isBreak: IsBreak): string {
  const before = weeks.slice(0, index).reduce((t, w) => t + teachingDays(w), 0);
  return before ? backDays(shift(unitStart, -1), before, isBreak) : unitStart;
}
/** The course start that makes the unit at `index` end on `unitEnd`. */
export function courseStartForEnd(unitEnd: string, index: number, weeks: number[], isBreak: IsBreak): string {
  return courseStartFor(backDays(unitEnd, teachingDays(weeks[index]), isBreak), index, weeks, isBreak);
}

// ------------------------------------------------------------------ VoE weekly calendar (owner, 2026-11-20)
// A VoE student may study up to 40 hours a week: at most two units at the same time, their weekly hours adding up to 40 or less.
// Two ways to allocate the hours:
//  * automatic: every week is filled to 40 hours: a unit running alone takes 40 h a week, two units together 20 h + 20 h;
//  * manual: staff give each unit its hours a week (20, 30, 20 + 15 ...).
// Anything above 40 hours a week is blocked either way. Units keep the CoE calendar's order, start date and term breaks; a unit
// starts on the first teaching day with room for it, once every prerequisite on the course has ended. Hours are used day by day
// (a week's hours spread over its 7 days, as the CoE calendar counts whole 7-day weeks); term-break days are skipped.
export const VOE_MAX_HOURS = 40;
export const VOE_MAX_UNITS = 2;
export type VoeMethod = "automatic" | "manual";
export interface VoeUnit { unitId: string; code: string; hours: number; rate: number; prerequisites: string[] }
export interface VoeRow { unitId: string; code: string; hours: number; prerequisites: string[]; startDate: string; endDate: string; days: number; rates: number[]; alongside: string[] }
export interface VoeWeek { from: string; to: string; units: { code: string; rate: number }[]; total: number; ok: boolean; teaching: boolean }
export interface VoePlan { rows: VoeRow[]; log: Map<string, { code: string; rate: number }[]> }

export function voeLayout(units: VoeUnit[], start: string, isBreak: IsBreak, method: VoeMethod = "manual"): VoePlan {
  const codes = new Set(units.map(u => u.code.toUpperCase()));
  const left = units.map(u => ({ ...u, needs: u.prerequisites.map(c => c.toUpperCase()).filter(c => codes.has(c) && c !== u.code.toUpperCase()) }));
  const done = new Map<string, string>(); // code -> end date
  type Active = { unit: (typeof left)[number]; startDate: string; remaining: number; days: number; rates: Set<number> };
  const active: Active[] = [];
  const rows: VoeRow[] = [];
  const log = new Map<string, { code: string; rate: number }[]>();
  const rateOf = (a: Active, count: number) => (method === "automatic" ? VOE_MAX_HOURS / count : a.unit.rate);
  let d = start;
  for (let guard = 0; (left.length || active.length) && guard < 20000; guard++, d = shift(d, 1)) {
    if (isBreak(d)) continue;
    for (let i = 0; i < left.length && active.length < VOE_MAX_UNITS;) {
      const u = left[i];
      const ready = u.needs.every(c => { const end = done.get(c); return !!end && end < d; });
      const used = method === "automatic" ? 0 : active.reduce((t, a) => t + a.unit.rate, 0);
      const fits = method === "automatic" || used + u.rate <= VOE_MAX_HOURS;
      if (ready && fits) { active.push({ unit: u, startDate: d, remaining: u.hours, days: 0, rates: new Set() }); left.splice(i, 1); }
      else i++;
    }
    if (!active.length && left.length) {
      // Nothing fits (a rate above 40, or a prerequisite missing from the course): run the next unit alone so the plan always ends.
      const u = left.shift()!;
      active.push({ unit: u, startDate: d, remaining: u.hours, days: 0, rates: new Set() });
    }
    const today = active.map(a => ({ a, rate: rateOf(a, active.length) }));
    log.set(d, today.map(t => ({ code: t.a.unit.code, rate: t.rate })));
    for (const { a, rate } of today) {
      a.days++; a.rates.add(rate);
      a.remaining -= rate / 7;
      if (a.remaining > 1e-9) continue;
      active.splice(active.indexOf(a), 1);
      done.set(a.unit.code.toUpperCase(), d);
      rows.push({ unitId: a.unit.unitId, code: a.unit.code, hours: a.unit.hours, prerequisites: a.unit.prerequisites, startDate: a.startDate, endDate: d, days: a.days, rates: [...a.rates].sort((x, y) => y - x), alongside: [] });
    }
  }
  for (const r of rows) r.alongside = rows.filter(o => o !== r && o.startDate <= r.endDate && o.endDate >= r.startDate).map(o => o.code);
  rows.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate));
  return { rows, log };
}

/** Week by week (7 days from the start): the units running and the busiest teaching day's hours; allowed when ≤ 2 units and ≤ 40 h. */
export function voeWeeks(plan: VoePlan, start: string, isBreak: IsBreak): VoeWeek[] {
  const last = plan.rows.reduce((m, r) => (r.endDate > m ? r.endDate : m), start);
  const out: VoeWeek[] = [];
  for (let from = start; from <= last; from = shift(from, 7)) {
    const to = shift(from, 6);
    const days = Array.from({ length: 7 }, (_, i) => shift(from, i)).filter(day => !isBreak(day));
    const units = new Map<string, number>();
    let total = 0, count = 0;
    for (const day of days) {
      const on = plan.log.get(day) ?? [];
      for (const u of on) units.set(u.code, Math.max(units.get(u.code) ?? 0, u.rate));
      total = Math.max(total, on.reduce((t, u) => t + u.rate, 0)); count = Math.max(count, on.length);
    }
    out.push({ from, to, units: [...units].map(([code, rate]) => ({ code, rate })), total, ok: total <= VOE_MAX_HOURS && count <= VOE_MAX_UNITS, teaching: days.length > 0 });
  }
  return out;
}
