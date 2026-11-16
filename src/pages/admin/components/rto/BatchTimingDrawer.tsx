// Add a batch, or change a batch's class timing: a week strip (Mon–Sun), each day's classes (morning / afternoon / evening with
// editable times, theory / practical / assessment, a room picked by location), "Use course timetable" and "Copy timing from G1"
// in one click, and a live warning when a room is already taken.
import { useEffect, useMemo, useState } from "react";
import { Button, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import { supabase } from "@/pages/admin/lib/supabase";
import { loadClosedDays, loadCourseNeed, planCourse, splitText, typeLabel, weeklyHoursNeeded, type CourseNeed } from "@/pages/admin/lib/coursePlan";
import {
  DAYS, SESSION_TYPES, SLOTS, WEEKDAYS, clashText, shortDate, generateClassSessions, nextBatchName, rto, rtoFlow, slotOf, timeRange, type BatchSession, type Clash, type CourseTiming, type GenerateResult,
  type IntakeDetail, type LocationRooms, type RtoBatch, type RtoIntake, type SessionType, type StaffOption,
} from "@/pages/admin/lib/rto";

type Draft = { key: number; weekday: number; startTime: string; endTime: string; type: SessionType; roomId: string };
let seq = 0;
const toDraft = (s: BatchSession): Draft => ({ key: ++seq, weekday: s.weekday, startTime: s.startTime.slice(0, 5), endTime: s.endTime.slice(0, 5), type: s.type, roomId: s.roomId ?? "" });
const toSession = (d: Draft) => ({ weekday: d.weekday, startTime: d.startTime, endTime: d.endTime, type: d.type, roomId: d.roomId || null });
/** The list with one more class: on a day that has classes, the next part of the day; on a new day, the same times as the last class; else a morning. */
const withClass = (list: Draft[], weekday: number): Draft[] => {
  const sameDay = list.filter((r) => r.weekday === weekday).pop();
  const last = list[list.length - 1];
  let start = SLOTS[0].start, end = SLOTS[0].end;
  if (sameDay) { const next = SLOTS[Math.min(SLOTS.length - 1, SLOTS.findIndex((s) => s.id === slotOf(sameDay.startTime)) + 1)]; start = next.start; end = next.end; }
  else if (last) { start = last.startTime; end = last.endTime; }
  const like = sameDay ?? last;
  return [...list, { key: ++seq, weekday, startTime: start, endTime: end, type: like?.type ?? "theory", roomId: like?.roomId ?? "" }]
    .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
};
export type BatchSaved = IntakeDetail & { batchId: string; clashes: Clash[]; generated?: GenerateResult | null };

export default function BatchTimingDrawer({ intake, batches: given, batch, onClose, onSaved, startDay, showTemplates = false, startManual = false }: {
  intake: Pick<RtoIntake, "id" | "courseId" | "name">;
  /** The intake's batches (to copy timing from and to name a new batch); loaded when not given. */
  batches?: RtoBatch[];
  /** Change this batch's timing; without it a new batch is added. */
  batch?: RtoBatch | null;
  onClose: () => void;
  /** After saving; `previous` is the timing before (for Undo) when a batch was changed. */
  onSaved: (out: BatchSaved, previous?: BatchSession[]) => void;
  /** Opens with a new class on this weekday (1 Monday … 7 Sunday). */
  startDay?: number;
  /** Opens with the course timetables list showing. */
  showTemplates?: boolean;
  /** Opens straight on the days and times, skipping the template / by hand choice. */
  startManual?: boolean;
}) {
  const adding = !batch;
  const [batches, setBatches] = useState<RtoBatch[]>(given ?? []);
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [timings, setTimings] = useState<CourseTiming[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [intakeDates, setIntakeDates] = useState<{ start: string; end: string | null } | null>(null);
  const [need, setNeed] = useState<CourseNeed | null>(null);
  const [closed, setClosed] = useState<((day: string) => boolean) | null>(null);
  const [rows, setRows] = useState<Draft[]>(() => { const base = (batch?.sessions ?? []).map(toDraft); return startDay ? withClass(base, startDay) : base; });
  const [name, setName] = useState(batch?.name ?? "");
  const [capacity, setCapacity] = useState(batch?.capacity ? String(batch.capacity) : "");
  const [trainerIds, setTrainerIds] = useState<string[]>(() => (batch?.trainers ?? []).map((t) => t.id));
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<"" | "timetable" | "copy">("");
  // An empty timing first asks how to set the hours: from a template, or by hand.
  const [manual, setManual] = useState(!!startManual && !showTemplates);

  useEffect(() => {
    let live = true;
    void Promise.all([
      rtoFlow<LocationRooms[]>("locations_rooms"),
      rtoFlow<CourseTiming[]>("timing_list", { courseId: intake.courseId }),
      rto<StaffOption[]>("staff_list"),
      rto<IntakeDetail>("intake_get", { intakeId: intake.id }),
    ]).then(([l, t, s, d]) => {
      if (!live) return;
      setLocations(l); setTimings(t); setStaff(s);
      if (d) {
        setIntakeDates({ start: d.intake.startDate, end: d.intake.endDate }); if (!given) setBatches(d.batches);
        void loadClosedDays(d.intake.startDate).then((f) => { if (live) setClosed(() => f); });
      }
    }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Rooms and timing did not load."); });
    void loadCourseNeed(intake.courseId).then((n) => { if (live) setNeed(n); }).catch(() => undefined);
    return () => { live = false; };
  }, [intake.id, intake.courseId, given]);

  const newName = useMemo(() => nextBatchName(batches.map((b) => b.name)), [batches]);
  const shownName = adding ? (name.trim() || newName) : batch.name;
  // The course timetable for this batch: the timing with the same name (G1 for G1), else the only one.
  const ownTiming = timings.find((t) => t.name.toLowerCase() === shownName.toLowerCase()) ?? (timings.length === 1 ? timings[0] : null);
  const copyFrom = batches.filter((b) => b.id !== batch?.id && (b.sessions ?? []).length > 0);

  // ---- edits
  const set = (key: number, patch: Partial<Draft>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addClass = (weekday: number) => setRows((list) => withClass(list, weekday));
  const toggleDay = (weekday: number) => { if (rows.some((r) => r.weekday === weekday)) setRows((list) => list.filter((r) => r.weekday !== weekday)); else addClass(weekday); };
  const applyTiming = (t: CourseTiming) => {
    setRows(t.sessions.map(toDraft)); setMenu("");
    if (t.trainerStaffId && trainerIds.length === 0) setTrainerIds([t.trainerStaffId]);
  };
  const deleteTemplate = async (t: CourseTiming) => {
    if (!window.confirm(`Delete the course timetable "${t.name}"? Batches already using its times keep them.`)) return;
    const { error: e } = await supabase.from("course_timing_templates").delete().eq("id", t.id);
    if (e) { setError(e.message); return; }
    setTimings((list) => list.filter((x) => x.id !== t.id)); setMenu("");
  };
  const copyTiming = (b: RtoBatch) => { setRows((b.sessions ?? []).map(toDraft)); setMenu(""); };

  // ---- checks: classes of this batch overlapping each other, and rooms already taken (asked as the timing changes)
  const invalid = rows.find((r) => !r.startTime || !r.endTime || r.endTime <= r.startTime);
  const overlap = rows.find((r, i) => rows.some((o, j) => j !== i && o.weekday === r.weekday && o.startTime < r.endTime && r.startTime < o.endTime));
  const sessionsKey = JSON.stringify(rows.map(toSession));
  useEffect(() => {
    const sessions = rows.map(toSession).filter((s) => s.roomId && s.endTime > s.startTime);
    if (!sessions.length) { setClashes([]); return; }
    let live = true;
    const t = window.setTimeout(() => {
      rtoFlow<Clash[]>("clash_check", { batchId: batch?.id ?? null, intakeId: intake.id, sessions })
        .then((c) => { if (live) setClashes(c); }).catch(() => undefined);
    }, 400);
    return () => { live = false; window.clearTimeout(t); };
  }, [sessionsKey, batch?.id, intake.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const clashLines = [...new Set(clashes.sort((a, b) => a.weekday - b.weekday || a.otherStart.localeCompare(b.otherStart)).map(clashText))];

  const save = async () => {
    setBusy(true); setError("");
    try {
      const out = await rtoFlow<BatchSaved>("batch_setup", {
        batchId: batch?.id ?? null, intakeId: intake.id, sessions: rows.map(toSession),
        ...(adding ? { name: name.trim() || newName, capacity, trainerIds } : {}),
      });
      const before = (batch?.trainers ?? []).map((t) => t.id).sort().join();
      if (!adding && before !== [...trainerIds].sort().join()) await rtoFlow("batch_trainers_set", { batchId: out.batchId, trainerIds });
      // Classes that run past the intake end move the intake end to the last class (into the next year if needed).
      if (extendsIntake && plan?.lastDate) await rto("intake_save", { id: intake.id, endDate: plan.lastDate });
      // The dated classes follow the saved timing automatically (term breaks and public holidays skipped).
      let generated: GenerateResult | null = null;
      if (rows.length) generated = await generateClassSessions(out.batchId).catch(() => null);
      onSaved({ ...out, generated }, adding ? undefined : batch?.sessions ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Not saved."); }
    finally { setBusy(false); }
  };

  const days = [...new Set(rows.map((r) => r.weekday))].sort((a, b) => a - b);
  // Does this week cover the course's SLIT hours by the intake end? (the same rules as the class generator)
  const ready = need && closed && intakeDates && need.total > 0;
  const plan = ready ? planCourse(intakeDates.start, rows, need, closed) : null;
  const perWeek = ready && intakeDates.end ? weeklyHoursNeeded(intakeDates.start, intakeDates.end, need.total, closed) : null;
  const finishesInTime = !!plan && !!plan.lastDate && (!intakeDates?.end || plan.lastDate <= intakeDates.end);
  const extendsIntake = !!plan?.lastDate && !!intakeDates?.end && plan.lastDate > intakeDates.end;
  const short = !!plan && rows.length > 0 && !plan.lastDate;
  const planFor = (sessions: BatchSession[]) => (ready ? planCourse(intakeDates.start, sessions, need, closed) : null);
  const fitHint = (sessions: BatchSession[]) => {
    const p = planFor(sessions);
    if (!p) return "";
    return !p.lastDate ? " · ✗ never finishes" : intakeDates?.end && p.lastDate > intakeDates.end ? ` · ⚠ ends ${shortDate(p.lastDate)}, extends the intake` : ` · ✓ ends ${shortDate(p.lastDate)}`;
  };
  const roomOptions = (selected: string) => locations.map((l) => (
    <optgroup key={l.id ?? "other"} label={l.name}>
      {l.rooms.filter((r) => r.isActive || r.id === selected).map((r) => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` (${r.capacity})` : ""}</option>)}
    </optgroup>
  ));

  return (
    <Drawer open width="max-w-2xl" title={adding ? `Add batch ${shownName}` : `Class timing · ${batch.name}`} onClose={onClose}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !!invalid || !!overlap || short} onClick={() => void save()}>{busy ? "Saving…" : adding ? `Add ${shownName}` : "Save timing"}</Button></>}>
      <ErrorNote text={error} />
      {adding ? (
        <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_7rem]">
          <Field label="Name" hint="G1, G2 … by default"><TextInput value={name} placeholder={newName} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Trainer">
            <Select value="" onChange={(e) => { const id = e.target.value; if (id) setTrainerIds((t) => (t.includes(id) ? t : [...t, id])); }}>
              <option value="">{trainerIds.length ? "Add another trainer" : "Choose a trainer"}</option>
              {staff.filter((s) => !trainerIds.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Places"><TextInput inputMode="numeric" value={capacity} placeholder="e.g. 25" onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ""))} /></Field>
          {trainerIds.length ? (
            <div className="flex flex-wrap gap-1.5 sm:col-span-3">
              {trainerIds.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-secondary-100 py-0.5 pl-2.5 pr-1 text-xs font-medium text-secondary-900">
                  {staff.find((s) => s.id === id)?.name ?? "Trainer"}
                  <button type="button" aria-label="Remove trainer" className="rounded-full p-0.5 hover:bg-secondary-200" onClick={() => setTrainerIds((t) => t.filter((x) => x !== id))}><i className="ri-close-line" aria-hidden="true" /></button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <Field label="Trainer">
          <div className="space-y-2">
            {trainerIds.length ? <div className="flex flex-wrap gap-1.5">
              {trainerIds.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-secondary-100 py-1 pl-3 pr-1 text-sm font-medium text-secondary-900">
                  <i className="ri-user-line" aria-hidden="true" />{staff.find((s) => s.id === id)?.name ?? batch.trainers.find((t) => t.id === id)?.name ?? "Trainer"}
                  <button type="button" aria-label="Remove trainer" className="rounded-full p-0.5 hover:bg-secondary-200" onClick={() => setTrainerIds((t) => t.filter((x) => x !== id))}><i className="ri-close-line" aria-hidden="true" /></button>
                </span>
              ))}
            </div> : null}
            <Select value="" onChange={(e) => { const id = e.target.value; if (id) setTrainerIds((t) => (t.includes(id) ? t : [...t, id])); }}>
              <option value="">{trainerIds.length ? "Add another trainer" : "Choose a trainer"}</option>
              {staff.filter((s) => !trainerIds.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
        </Field>
      )}

      {rows.length === 0 && !manual ? (
        <div className="space-y-3">
          <p className="text-label font-medium text-foreground-800">How do you want to set the class hours?</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border-2 border-primary-200 p-4">
              <p className="flex items-center gap-2 font-heading text-base font-bold text-foreground-950"><i className="ri-file-copy-2-line text-xl text-primary-600" aria-hidden="true" />Use a course template</p>
              <p className="mt-1 text-xs text-foreground-600">Copy the days, times, rooms and trainer from a saved template of this course.</p>
              {timings.length ? <div className="mt-3 space-y-2">
                {timings.map((t) => (
                  <button key={t.id} type="button" onClick={() => applyTiming(t)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-left text-sm hover:border-primary-500 hover:bg-primary-100">
                    <span className="font-semibold text-foreground-900">{t.name}</span>
                    <span className="truncate text-xs text-foreground-600">{t.sessions.length} classes{fitHint(t.sessions)}</span>
                  </button>
                ))}
              </div> : <p className="mt-3 rounded-lg bg-background-100 px-3 py-2 text-xs text-foreground-600">No template for this course yet. Create one under Timetable → Templates, or set the hours yourself.</p>}
            </div>
            <button type="button" onClick={() => setManual(true)} className="rounded-xl border-2 border-primary-200 p-4 text-left hover:border-primary-500 hover:bg-primary-50">
              <p className="flex items-center gap-2 font-heading text-base font-bold text-foreground-950"><i className="ri-edit-2-line text-xl text-primary-600" aria-hidden="true" />Set the hours myself</p>
              <p className="mt-1 text-xs text-foreground-600">Choose the days, then each class's time, type (theory, practical or assessment) and room.</p>
              <span className="mt-3 inline-flex items-center gap-1 rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white">Start<i className="ri-arrow-right-line" aria-hidden="true" /></span>
            </button>
          </div>
          {copyFrom.length ? <p className="text-xs text-foreground-600">Or copy another batch: {copyFrom.map((b) => <button key={b.id} type="button" className="ml-1 font-semibold text-primary-700 hover:underline" onClick={() => { copyTiming(b); }}>{b.name}</button>)}</p> : null}
        </div>
      ) : <>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-label font-medium text-foreground-800">Days and times</p>
          <div className="flex flex-wrap gap-1.5">
            <div className="relative">
              <Button size="sm" variant="outline" icon="ri-calendar-check-line"
                onClick={() => setMenu((m) => (m === "timetable" ? "" : "timetable"))}>
                Use a course template{timings.length ? ` (${timings.length})` : ""}
              </Button>
              {menu === "timetable" ? <PickList items={timings.map((t) => ({ id: t.id, label: t.name + (t.id === ownTiming?.id ? " ★" : ""), hint: `${t.sessions.length} classes${t.trainerName ? " · " + t.trainerName : ""}${fitHint(t.sessions)}` }))}
                empty="No template for this course yet. Create one under Timetable → Templates."
                onPick={(id) => { const t = timings.find((x) => x.id === id); if (t) applyTiming(t); }}
                onDelete={(id) => { const t = timings.find((x) => x.id === id); if (t) void deleteTemplate(t); }} onClose={() => setMenu("")} /> : null}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1" role="group" aria-label="Class days">
          {DAYS.map((d, i) => {
            const on = rows.some((r) => r.weekday === i + 1);
            return (
              <button key={d} type="button" aria-pressed={on} onClick={() => toggleDay(i + 1)} title={on ? `Remove ${WEEKDAYS[i]} classes` : `Add a class on ${WEEKDAYS[i]}`}
                className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-lg border-2 py-2.5 text-sm font-bold shadow-sm transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-primary-300 ${on ? "border-primary-600 bg-primary-600 text-background-50 hover:bg-primary-700" : "border-primary-200 bg-background-50 text-primary-700 hover:border-primary-500 hover:bg-primary-50"}`}>
                <i className={(on ? "ri-checkbox-circle-fill" : "ri-add-circle-line") + " text-base"} aria-hidden="true" />{d}</button>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs font-medium text-foreground-600">Click a day to add classes on it. Click a ticked day again to remove them.</p>
        {ready && rows.length ? <div role="status" className={`mt-3 rounded-lg border px-3 py-2 text-sm ${finishesInTime ? "border-emerald-200 bg-emerald-50 text-emerald-900" : extendsIntake ? "border-amber-300 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-800"}`}>
          <p className="font-semibold"><i className={(finishesInTime ? "ri-checkbox-circle-line" : "ri-error-warning-line") + " mr-1"} aria-hidden="true" />
            {!plan?.lastDate ? "These class times never cover the course hours."
              : finishesInTime ? `Covers the full course: last class ${shortDate(plan.lastDate)}${intakeDates.end ? `, intake ends ${shortDate(intakeDates.end)}` : ""}.`
              : `Runs past the intake end: the last class is ${shortDate(plan.lastDate)}, the intake ends ${shortDate(intakeDates.end)}. Saving extends the intake to ${shortDate(plan.lastDate)}${plan.lastDate.slice(0, 4) !== (intakeDates.end ?? "").slice(0, 4) ? `, into ${plan.lastDate.slice(0, 4)}` : ""}.`}</p>
          <p className="mt-0.5">Course: {need.total} SLIT hours ({splitText(need)}) over {need.units} units. This week: {plan?.weeklyTotal ?? 0} hours ({splitText(plan?.weekly ?? { theory: 0, practical: 0, assessment: 0 }) || "none"}).
            {perWeek && extendsIntake ? ` To finish by ${shortDate(intakeDates.end)} instead, you need about ${perWeek} hours a week.` : ""}</p>
          {plan?.folded.map((f) => <p key={f.from} className="mt-0.5 text-xs">No {typeLabel(f.from)} class in the week, so its hours are taught in the {typeLabel(f.into)} classes.</p>)}
        </div> : null}
      </div>

      {days.length === 0 ? (
        <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">No classes yet. Click a day above, or use a course template.</p>
      ) : days.map((d) => (
        <div key={d} className="rounded-md border border-background-200">
          <div className="flex items-center justify-between border-b border-background-200 bg-background-100/60 px-3 py-1.5">
            <p className="text-sm font-semibold text-foreground-900">{WEEKDAYS[d - 1]}</p>
            <button type="button" className="text-xs font-medium text-primary-600 hover:underline" onClick={() => addClass(d)}>+ Add a class</button>
          </div>
          <div className="divide-y divide-background-100">
            {rows.filter((r) => r.weekday === d).map((r) => {
              const slot = slotOf(r.startTime);
              return (
                <div key={r.key} className="space-y-2 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-md border border-background-300 p-0.5" role="radiogroup" aria-label="Part of the day">
                      {SLOTS.map((s) => (
                        <button key={s.id} type="button" role="radio" aria-checked={slot === s.id} onClick={() => set(r.key, { startTime: s.start, endTime: s.end })}
                          className={`rounded px-2 py-1 text-xs font-medium ${slot === s.id ? "bg-secondary-100 text-secondary-900" : "text-foreground-600 hover:bg-background-100"}`}>{s.label}</button>
                      ))}
                    </div>
                    <TextInput type="time" className="w-28" aria-label="Starts" value={r.startTime} onChange={(e) => set(r.key, { startTime: e.target.value })} />
                    <span className="text-foreground-400">–</span>
                    <TextInput type="time" className={`w-28 ${r.endTime <= r.startTime ? "border-primary-500" : ""}`} aria-label="Ends" value={r.endTime} onChange={(e) => set(r.key, { endTime: e.target.value })} />
                    <button type="button" aria-label="Remove this class" className="ml-auto rounded-md p-1.5 text-foreground-400 hover:bg-background-100 hover:text-foreground-700"
                      onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}><i className="ri-close-line" aria-hidden="true" /></button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    <Select aria-label="Kind of class" value={r.type} onChange={(e) => set(r.key, { type: e.target.value as SessionType })}>
                      {SESSION_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </Select>
                    <Select aria-label="Room" value={r.roomId} onChange={(e) => set(r.key, { roomId: e.target.value })}>
                      <option value="">No room yet</option>
                      {roomOptions(r.roomId)}
                    </Select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      </>}

      {invalid ? <p role="alert" className="text-sm text-primary-800">A class on {WEEKDAYS[invalid.weekday - 1]} ends before it starts.</p> : null}
      {overlap && !invalid ? <p role="alert" className="text-sm text-primary-800">Two classes on {WEEKDAYS[overlap.weekday - 1]} overlap ({timeRange(overlap.startTime, overlap.endTime)}).</p> : null}
      {clashLines.length ? (
        <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium"><i className="ri-error-warning-line mr-1" aria-hidden="true" />Room already taken</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{clashLines.map((t) => <li key={t}>{t}.</li>)}</ul>
          <p className="mt-1 text-xs text-amber-800">You can still save; the rooms board shows the clash in red until one batch moves.</p>
        </div>
      ) : null}
    </Drawer>
  );
}

function PickList({ items, onPick, onClose, onDelete, empty }: {
  items: { id: string; label: string; hint: string }[]; onPick: (id: string) => void; onClose: () => void;
  /** Shows a delete button on each item. */
  onDelete?: (id: string) => void; empty?: string;
}) {
  useEffect(() => {
    const close = () => onClose();
    const t = window.setTimeout(() => document.addEventListener("click", close), 0);
    return () => { window.clearTimeout(t); document.removeEventListener("click", close); };
  }, [onClose]);
  return (
    <div className="fade-in absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-background-200 bg-background-50 py-1 text-sm shadow-lg">
      {!items.length && empty ? <p className="px-3 py-2 text-xs text-foreground-600">{empty}</p> : null}
      {items.map((it) => (
        <div key={it.id} className="flex items-center hover:bg-background-100">
          <button type="button" className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left" onClick={() => onPick(it.id)}>
            <span className="font-medium text-foreground-900">{it.label}</span><span className="truncate text-xs text-foreground-500">{it.hint}</span>
          </button>
          {onDelete ? <button type="button" aria-label={`Delete ${it.label}`} title="Delete this course timetable" className="mr-1 rounded p-1.5 text-foreground-400 hover:bg-background-200 hover:text-red-700"
            onClick={() => onDelete(it.id)}><i className="ri-delete-bin-line" aria-hidden="true" /></button> : null}
        </div>
      ))}
    </div>
  );
}
