// An intake's unit schedule: a two-column grid (units on the left, a timeline on the right that fits the width and scrolls on its
// own when long), month axis with gridlines, today and public holidays, drag a bar to move it (later units follow) or its right
// edge to change its length, dates in a small popover, a header with the labelled totals, term breaks shaded. With `autosave` a change
// is saved as soon as it is dropped (the parent offers Undo); otherwise a sticky Save / Regenerate footer.
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmDialog, TextInput } from "@/pages/admin/components/ui";
import { listHolidays } from "@/lib/hrmsApi";
import { addDays, daysBetween, listBreaks, parseDay, registeredWeeks, shortDate, todayIso, weeksOf, type AcademicBreak, type IntakeDetail, type ScheduleRow } from "@/pages/admin/lib/rto";

const ROW = 56; // px, the same in both columns
const AXIS = 32;
const MIN_PX_PER_DAY = 0.9; // below this the timeline scrolls inside its own box

const dayMonth = (iso: string) => new Date(parseDay(iso)).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });

export default function SchedulePanel({ detail, courseDuration, unitWeeks = {}, readOnly, busy, onSave, onRegenerate, onDirtyChange, autosave = false }: {
  detail: IntakeDetail;
  /** The course's duration as registered, e.g. "52 Weeks" (for the CoE length check). */
  courseDuration?: string | null;
  /** Each unit's default weeks (master timetable), to tell whether the schedule was changed by hand. */
  unitWeeks?: Record<string, number>;
  readOnly: boolean; busy: boolean;
  /** Saves the rows; `previous` (autosave) is what Undo puts back. */
  onSave: (rows: ScheduleRow[], previous?: ScheduleRow[]) => void;
  onRegenerate: (fitEnd?: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Save each change when it is dropped (no Save button). */
  autosave?: boolean;
}) {
  const [rows, setRows] = useState<ScheduleRow[]>(detail.schedule);
  useEffect(() => { setRows(detail.schedule); }, [detail.schedule]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(detail.schedule);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const [confirm, setConfirm] = useState<null | { fitEnd?: string; text: string }>(null);
  const [popover, setPopover] = useState<number | null>(null);
  const [holidays, setHolidays] = useState<{ date: string; name: string }[]>([]);
  const [breaks, setBreaks] = useState<AcademicBreak[]>([]);
  useEffect(() => { let live = true; listBreaks().then((b) => { if (live) setBreaks(b); }).catch(() => undefined); return () => { live = false; }; }, []);

  // ---- range and scale
  const first = rows.length ? rows.reduce((m, r) => (r.startDate < m ? r.startDate : m), rows[0].startDate) : detail.intake.startDate;
  const last = rows.length ? rows.reduce((m, r) => (r.endDate > m ? r.endDate : m), rows[0].endDate) : detail.intake.endDate ?? detail.intake.startDate;
  const span = Math.max(1, daysBetween(first, last) + 1);
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(600);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setBoxWidth(Math.max(200, e.contentRect.width)));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const width = Math.max(boxWidth, Math.ceil(span * MIN_PX_PER_DAY));
  const px = width / span;
  const at = (iso: string) => daysBetween(first, iso) * px;

  useEffect(() => {
    let live = true;
    listHolidays(first, last).then((list) => { if (live) setHolidays(list.filter((h) => h.status === "confirmed" && !h.isOptional).map((h) => ({ date: h.date, name: h.name }))); }).catch(() => undefined);
    return () => { live = false; };
  }, [first, last]);

  const months = useMemo(() => {
    const out: { label: string; iso: string }[] = [];
    let d = new Date(parseDay(first)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    while (d.getTime() <= parseDay(last)) {
      const iso = d.toISOString().slice(0, 10);
      out.push({ iso: iso < first ? first : iso, label: d.toLocaleDateString("en-AU", { month: "short", ...(d.getUTCMonth() === 0 || out.length === 0 ? { year: "numeric" } : {}), timeZone: "UTC" }) });
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
    return out;
  }, [first, last]);
  const today = todayIso();
  const axisLabels = useMemo(() => {
    const out: { iso: string; label: string }[] = [];
    let lastRight = -Infinity;
    for (const m of months) {
      const d = new Date(parseDay(m.iso));
      const label = d.toLocaleDateString("en-AU", { month: "short", ...(out.length === 0 || d.getUTCMonth() === 0 ? { year: "numeric" } : {}), timeZone: "UTC" });
      const left = daysBetween(first, m.iso) * px;
      if (left < lastRight + 6) continue;
      out.push({ iso: m.iso, label }); lastRight = left + label.length * 6.2 + 6;
    }
    return out;
  }, [months, first, px]);

  // ---- edits: move a unit (later units follow) or change its end (later units follow)
  const shift = (index: number, startDays: number, endDays: number) => setRows((list) => list.map((r, x) => {
    if (x < index) return r;
    if (x === index) return { ...r, startDate: addDays(r.startDate, startDays), endDate: addDays(r.endDate, endDays) };
    return { ...r, startDate: addDays(r.startDate, endDays), endDate: addDays(r.endDate, endDays) };
  }));
  const setStart = (i: number, v: string) => { if (v) { const d = daysBetween(rows[i].startDate, v); shift(i, d, d); } };
  const setEnd = (i: number, v: string) => { if (v && v >= rows[i].startDate) shift(i, 0, daysBetween(rows[i].endDate, v)); };

  const drag = useRef<{ index: number; mode: "move" | "resize"; x: number; days: number } | null>(null);
  const [preview, setPreview] = useState<{ index: number; mode: "move" | "resize"; days: number } | null>(null);
  const startDrag = (index: number, mode: "move" | "resize", e: React.PointerEvent) => {
    if (readOnly || busy) return;
    e.preventDefault(); e.stopPropagation();
    drag.current = { index, mode, x: e.clientX, days: 0 };
    const move = (ev: PointerEvent) => {
      const g = drag.current; if (!g) return;
      let days = Math.round((ev.clientX - g.x) / px);
      if (g.mode === "resize") days = Math.max(days, -daysBetween(rows[g.index].startDate, rows[g.index].endDate));
      if (days !== g.days) { g.days = days; setPreview({ index: g.index, mode: g.mode, days }); }
    };
    const up = () => {
      const g = drag.current; drag.current = null; setPreview(null);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      if (g && g.days) { if (g.mode === "move") shift(g.index, g.days, g.days); else shift(g.index, 0, g.days); }
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const shown = (r: ScheduleRow, i: number) => {
    if (!preview || i < preview.index) return { start: r.startDate, end: r.endDate };
    if (i === preview.index) return preview.mode === "move" ? { start: addDays(r.startDate, preview.days), end: addDays(r.endDate, preview.days) } : { start: r.startDate, end: addDays(r.endDate, preview.days) };
    return { start: addDays(r.startDate, preview.days), end: addDays(r.endDate, preview.days) };
  };

  // ---- autosave: a finished change (no drag in progress, popover closed) is saved once
  const sentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autosave || readOnly || !dirty || preview || popover !== null) return;
    const key = JSON.stringify(rows);
    if (sentRef.current === key) return;
    const t = window.setTimeout(() => { sentRef.current = key; onSave(rows, detail.schedule); }, 350);
    return () => window.clearTimeout(t);
  }, [autosave, readOnly, dirty, preview, popover, rows, detail.schedule, onSave]);

  // ---- popover: closes on outside click
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (popover === null) return;
    const close = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setPopover(null); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, [popover]);

  // ---- header facts and the registered-duration check
  const i = detail.intake;
  const label = i.courseName.toUpperCase().startsWith((i.courseCode || "").toUpperCase()) && i.courseCode ? i.courseName : `${i.courseCode} ${i.courseName}`.trim();
  const weeks = rows.length ? weeksOf(first, last) : 0;
  const hours = rows.reduce((s, r) => s + (r.hours ?? 0), 0);
  const registered = registeredWeeks(courseDuration);
  const intakeDiffers = rows.length > 0 && (i.startDate !== first || (i.endDate ?? last) !== last);
  const manual = dirty || rows.some((r) => unitWeeks[r.unitId] !== undefined && weeksOf(r.startDate, r.endDate) !== unitWeeks[r.unitId]);
  const regenerate = (fitEnd?: string) => {
    const text = fitEnd ? `Every unit date is laid out again so the schedule ends on ${shortDate(fitEnd)} (${registered} weeks).` : "Every unit date is laid out again from the master timetable.";
    if (manual || fitEnd) setConfirm({ fitEnd, text: `${text}${manual ? " Changes made by hand are replaced." : ""}` });
    else onRegenerate();
  };

  if (!rows.length) {
    return (
      <div className="min-w-0 rounded-card border border-background-200 bg-background-50 p-6 text-center">
        <p className="font-medium text-foreground-900">No schedule yet</p>
        <p className="mt-1 text-sm text-foreground-500">{readOnly ? "An RTO Manager generates the schedule." : "Generate it from the course's master timetable."}</p>
        {readOnly ? null : <div className="mt-3"><Button disabled={busy} onClick={() => onRegenerate()}>Generate schedule</Button></div>}
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 rounded-card border border-background-200 bg-background-50">
      {/* Header */}
      <div className="min-w-0 border-b border-background-200 px-4 py-3">
        <p className="break-words font-heading text-sm font-semibold text-foreground-950">{label}</p>
        <p className="mt-0.5 text-xs text-foreground-600">
          {shortDate(first)} – {shortDate(last)} · {weeks} weeks · {rows.length} units · {i.enrolled}{i.capacity ? ` / ${i.capacity}` : ""} enrolled{hours ? ` · ${hours} hours` : ""}
          {intakeDiffers ? <span className="text-foreground-500"> · intake dates {shortDate(i.startDate)} – {shortDate(i.endDate)}</span> : null}
        </p>
        {registered && weeks && registered !== weeks ? (
          <div role="status" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span><i className="ri-error-warning-line mr-1" aria-hidden="true" />Schedule is {weeks} weeks; course duration is {registered} weeks. CoE dates should match the registered duration.</span>
            {readOnly ? null : <Button size="sm" variant="outline" disabled={busy} onClick={() => regenerate(addDays(first, registered * 7 - 1))}>Fit to {registered} weeks</Button>}
          </div>
        ) : null}
      </div>

      {/* Units | timeline */}
      <div className="grid min-w-0 grid-cols-1 min-[900px]:grid-cols-[clamp(240px,24vw,360px)_minmax(0,1fr)]">
        <div className="min-w-0 border-b border-background-200 min-[900px]:border-b-0 min-[900px]:border-r">
          <div className="flex items-center px-4 text-xs font-medium text-foreground-500" style={{ height: AXIS }}>Unit</div>
          {rows.map((r, idx) => {
            const s = shown(r, idx);
            return (
              <div key={r.id} className="relative flex min-w-0 flex-col justify-center border-t border-background-100 px-4" style={{ height: ROW }}>
                <p className="line-clamp-2 min-w-0 text-label leading-tight text-foreground-800" title={`${r.code} ${r.name}`}><strong className="font-semibold text-foreground-950">{r.code}</strong> {r.name}</p>
                <button type="button" disabled={readOnly} onClick={() => setPopover((p) => (p === idx ? null : idx))}
                  className={`mt-0.5 self-start text-xs tabular-nums ${readOnly ? "text-foreground-500" : "text-primary-700 hover:underline"}`}>
                  {dayMonth(s.start)} – {shortDate(s.end)} · {weeksOf(s.start, s.end)} wks
                </button>
                {popover === idx ? (
                  <div ref={popRef} className="absolute left-4 top-full z-20 mt-1 w-64 rounded-md border border-background-200 bg-background-50 p-3 shadow-lg">
                    <p className="mb-2 text-xs font-medium text-foreground-700">{r.code} dates</p>
                    <label className="mb-2 block text-xs text-foreground-600">Starts<TextInput type="date" value={r.startDate} onChange={(e) => setStart(idx, e.target.value)} /></label>
                    <label className="block text-xs text-foreground-600">Ends<TextInput type="date" value={r.endDate} min={r.startDate} onChange={(e) => setEnd(idx, e.target.value)} /></label>
                    <p className="mt-2 text-2xs text-foreground-500">Later units move by the same number of days.</p>
                    <div className="mt-2 flex justify-end"><Button size="sm" variant="outline" onClick={() => setPopover(null)}>Done</Button></div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div ref={box} className="min-w-0 overflow-x-auto">
          <div className="relative" style={{ width }}>
            {/* axis */}
            <div className="relative border-b border-background-200 text-2xs text-foreground-500" style={{ height: AXIS }}>
              {axisLabels.map((m) => <span key={m.iso} className="absolute top-2 whitespace-nowrap pl-1" style={{ left: at(m.iso) }}>{m.label}</span>)}
            </div>
            {/* rows with gridlines, holidays and today */}
            <div className="relative" style={{ height: rows.length * ROW }}>
              {months.map((m) => <div key={`g${m.iso}`} className="absolute bottom-0 top-0 border-l border-background-200" style={{ left: at(m.iso) }} aria-hidden="true" />)}
              {holidays.filter((h) => h.date >= first && h.date <= last).map((h) => (
                <div key={`h${h.date}`} title={`${shortDate(h.date)}: ${h.name}`} className="absolute bottom-0 top-0 bg-amber-200/50" style={{ left: at(h.date), width: Math.max(2, px) }} />
              ))}
              {breaks.filter((b) => b.endDate >= first && b.startDate <= last).map((b) => {
                const s0 = b.startDate < first ? first : b.startDate, e0 = b.endDate > last ? last : b.endDate;
                return <div key={`b${b.startDate}`} title={`${b.label}: ${shortDate(b.startDate)} – ${shortDate(b.endDate)}`} className="absolute bottom-0 top-0 bg-sky-200/40" style={{ left: at(s0), width: Math.max(2, (daysBetween(s0, e0) + 1) * px) }} />;
              })}
              {today >= first && today <= last ? <div className="absolute bottom-0 top-0 border-l-2 border-red-400" style={{ left: at(today) }} title="Today" aria-hidden="true" /> : null}
              {rows.map((r, idx) => {
                const s = shown(r, idx);
                const left = at(s.start), w = Math.max(6, (daysBetween(s.start, s.end) + 1) * px);
                // The code goes inside the bar when it fits, else just after it when there is room, else only in the tooltip.
                const labelW = r.code.length * 6.4 + 12, inside = w >= labelW, after = !inside && left + w + labelW + 4 <= width;
                return (
                  <div key={r.id} className="absolute left-0 right-0" style={{ top: idx * ROW, height: ROW }}>
                    <div onPointerDown={(e) => startDrag(idx, "move", e)} title={`${r.code}: ${shortDate(s.start)} – ${shortDate(s.end)} (${weeksOf(s.start, s.end)} weeks)`}
                      className={`absolute top-4 flex h-6 items-center overflow-hidden rounded text-2xs font-medium text-background-50 ${r.unitType === "elective" ? "bg-secondary-500" : "bg-primary-500"} ${readOnly ? "" : "cursor-grab touch-none active:cursor-grabbing"}`}
                      style={{ left, width: w }}>
                      {inside ? <span className="truncate px-1.5">{r.code}</span> : null}
                      {readOnly ? null : <span onPointerDown={(e) => startDrag(idx, "resize", e)} className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize bg-foreground-950/20" aria-label={`Change the length of ${r.code}`} />}
                    </div>
                    {after ? <span className="pointer-events-none absolute top-4 flex h-6 items-center whitespace-nowrap text-2xs font-medium text-foreground-700" style={{ left: left + w + 4 }}>{r.code}</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-background-200 px-4 py-2 text-xs text-foreground-600">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded bg-primary-500" />Core unit</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded bg-secondary-500" />Elective unit</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2 bg-amber-200" />Public holiday</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-3 bg-sky-200" />Term break</span>
        <span className="flex items-center gap-1.5"><span className="h-3 border-l-2 border-red-400" />Today</span>
        {readOnly ? null : <span className="text-foreground-500">Drag a bar to move it, its right edge to change its length; later units follow.{autosave ? " Changes save when you let go." : ""}</span>}
      </div>

      {/* sticky footer */}
      {readOnly ? null : (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-b-card border-t border-background-200 bg-background-50/95 px-4 py-2.5 backdrop-blur">
          <Button variant="outline" size="sm" icon="ri-refresh-line" disabled={busy} onClick={() => regenerate()}>Regenerate</Button>
          {autosave ? <span className="text-xs text-foreground-500">{busy ? "Saving…" : "Changes save automatically"}</span> : <div className="flex items-center gap-2">
            {dirty ? <span className="text-xs font-medium text-amber-800">Unsaved changes</span> : null}
            {dirty ? <Button variant="ghost" size="sm" onClick={() => setRows(detail.schedule)}>Undo</Button> : null}
            <Button size="sm" disabled={busy || !dirty} onClick={() => onSave(rows)}>{busy ? "Saving…" : "Save schedule"}</Button>
          </div>}
        </div>
      )}
      <ConfirmDialog open={confirm !== null} title={confirm?.fitEnd ? `Fit the schedule to ${registered} weeks?` : "Regenerate the schedule?"} message={confirm?.text ?? ""}
        confirmLabel={confirm?.fitEnd ? "Fit schedule" : "Regenerate"} onCancel={() => setConfirm(null)}
        onConfirm={() => { const fit = confirm?.fitEnd; setConfirm(null); onRegenerate(fit); }} />
    </div>
  );
}
