import { useCallback, useEffect, useMemo, useState } from "react";
import ListPane from "@/pages/admin/components/ListPane";
import { useListPane } from "@/pages/admin/lib/listPane";
import { Button, Field, Select, TextInput } from "@/pages/admin/components/ui";
import { Drawer, ErrorNote } from "@/pages/admin/components/rto/shared";
import { supabase } from "@/pages/admin/lib/supabase";
import { loadCourseNeed, splitText, weeklyHours, type CourseNeed } from "@/pages/admin/lib/coursePlan";
import {
  DAYS, SESSION_TYPES, SLOTS, TEMPLATE_MIN_HOURS, WEEKDAYS, rto, rtoFlow, slotOf,
  type CourseTiming, type LocationRooms, type RtoCourse, type SessionType, type StaffOption,
} from "@/pages/admin/lib/rto";

type Row = { key: number; weekday: number; startTime: string; endTime: string; type: SessionType; roomId: string };
let seq = 0;
const card = "rounded-2xl border border-background-200 bg-background-50 shadow-sm";
const short = (t: string) => t.slice(0, 5);

/**
 * Timetable templates: each course's weekly class times (days, times, class type, room, trainer).
 * A batch picks one with "Use course timetable" in its class timing on the Batch calendar.
 */
export default function LmsTimetableTemplatesPage() {
  const pane = useListPane("timetable-templates");
  const [courses, setCourses] = useState<RtoCourse[]>([]);
  const [courseId, setCourseId] = useState("");
  const [courseSearch, setCourseSearch] = useState("");
  const [templates, setTemplates] = useState<CourseTiming[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<CourseTiming | "new" | null>(null);
  const [need, setNeed] = useState<CourseNeed | null>(null);
  useEffect(() => { setNeed(null); if (courseId) loadCourseNeed(courseId).then(setNeed).catch(() => undefined); }, [courseId]);

  useEffect(() => {
    Promise.all([rto<RtoCourse[]>("course_list"), rto<{ rtoManager: boolean }>("me"),
      supabase.from("course_timing_templates").select("course_id")])
      .then(([cs, me, all]) => {
        setCourses(cs); setCanEdit(me.rtoManager);
        const c: Record<string, number> = {};
        for (const r of (all.data ?? []) as { course_id: string }[]) c[r.course_id] = (c[r.course_id] ?? 0) + 1;
        setCounts(c);
        setCourseId(prev => prev || cs.find(x => c[x.id])?.id || cs[0]?.id || "");
      })
      .catch(e => setError(e instanceof Error ? e.message : "Unable to load courses"))
      .finally(() => setLoading(false));
  }, []);
  const loadTemplates = useCallback(async () => {
    if (!courseId) { setTemplates([]); return; }
    try {
      const list = await rtoFlow<CourseTiming[]>("timing_list", { courseId });
      setTemplates(list); setCounts(c => ({ ...c, [courseId]: list.length })); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load templates"); }
  }, [courseId]);
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  const remove = async (t: CourseTiming) => {
    if (!window.confirm(`Delete the template "${t.name}"? Batches already using its times keep them.`)) return;
    const { error: e } = await supabase.from("course_timing_templates").delete().eq("id", t.id);
    if (e) { setError(e.message); return; }
    setNotice(`Template ${t.name} deleted.`); void loadTemplates();
  };

  const course = courses.find(c => c.id === courseId);
  const visible = courses.filter(c => (c.code + " " + c.name).toLowerCase().includes(courseSearch.toLowerCase()));
  return <div className="mx-auto max-w-[1500px] space-y-5 pb-12">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground-950">Timetable templates</h1>
        <p className="text-sm text-foreground-500">Each course's weekly class times. On the Batch calendar, open a batch's class timing and click <strong>Use course timetable</strong> to copy one.</p>
      </div>
      {canEdit && course && <button type="button" onClick={() => { setNotice(""); setEditing("new"); }}
        className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-5 py-3 text-base font-semibold text-white shadow-sm hover:bg-primary-700">
        <i className="ri-add-line text-lg" aria-hidden="true" />New template</button>}
    </header>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
    <div className={"grid items-start gap-5 " + pane.grid}>
      <ListPane pane={pane} label="Courses">
      <aside className={card + " p-3"}>
        <label className="relative block"><span className="sr-only">Search courses</span>
          <i className="ri-search-line absolute left-3 top-2.5 text-foreground-400" aria-hidden="true" />
          <input className="w-full rounded-lg border border-background-300 bg-background-50 py-2 pl-9 pr-2 text-sm" placeholder="Search course" value={courseSearch} onChange={e => setCourseSearch(e.target.value)} />
        </label>
        <div className="mt-3 max-h-[70vh] space-y-1 overflow-auto">{loading ? <p className="p-3 text-sm text-foreground-500">Loading…</p> : visible.map(c =>
          <button type="button" key={c.id} aria-pressed={courseId === c.id} onClick={() => { setCourseId(c.id); setNotice(""); }}
            className={"flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors " + (courseId === c.id ? "bg-primary-50 ring-1 ring-primary-300" : "hover:bg-background-100")}>
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-foreground-950">{c.code}</span>
              <span className="block truncate text-xs text-foreground-600">{c.name}</span></span>
            <span className="shrink-0 text-xs text-foreground-500" title={`${counts[c.id] ?? 0} templates`}>{counts[c.id] ?? 0}</span>
          </button>)}</div>
      </aside>
      </ListPane>
      <section className={card + " min-w-0 p-5"}>
        {!course ? <p className="py-10 text-center text-sm text-foreground-500">Select a course.</p> : <>
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{course.code}</p>
          <h2 className="font-heading text-xl font-bold text-foreground-950">{course.name}</h2>
          {need ? <p className="mt-1 text-sm text-foreground-600">The course needs <strong>{need.total} SLIT hours</strong>{need.total ? ` (${splitText(need)})` : ""} over {need.units} units. A template must give enough hours a week to finish them by the intake end; the Batch calendar checks this against each intake's dates.</p> : null}
          {!templates.length ? <div className="py-10 text-center">
            <p className="text-sm text-foreground-500">No templates for this course yet.</p>
            {canEdit && <button type="button" onClick={() => setEditing("new")} className="mt-3 inline-flex items-center gap-2 rounded-lg border-2 border-dashed border-primary-300 px-4 py-2 text-sm font-semibold text-primary-700 hover:border-primary-500 hover:bg-primary-50">
              <i className="ri-add-line" aria-hidden="true" />Create the first template</button>}
          </div> : <div className="mt-4 space-y-4">{templates.map(t => <article key={t.id} className="rounded-xl border border-background-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-heading text-lg font-bold text-foreground-950">{t.name}</h3>
                <p className="text-xs text-foreground-600"><i className="ri-user-line mr-1" aria-hidden="true" />{t.trainerName || "No trainer"} · {t.sessions.length} class{t.sessions.length === 1 ? "" : "es"} a week · {(() => { const w = weeklyHours(t.sessions); const total = w.theory + w.practical + w.assessment; return <>{total} hours a week{need?.total && total ? <> · <strong>about {Math.ceil(need.total / total)} teaching weeks</strong> for the course</> : null}</>; })()}</p>
              </div>
              {canEdit && <div className="flex gap-2">
                <button type="button" onClick={() => { setNotice(""); setEditing(t); }} className="inline-flex items-center gap-1 rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-100"><i className="ri-pencil-line" aria-hidden="true" />Edit</button>
                <button type="button" onClick={() => void remove(t)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50"><i className="ri-delete-bin-line" aria-hidden="true" />Delete</button>
              </div>}
            </div>
            <div className="mt-3 overflow-x-auto"><div className="grid min-w-[700px] grid-cols-7 divide-x divide-background-200 rounded-lg border border-background-200">
              {DAYS.map((d, i) => <div key={d} className="min-h-20 p-1.5">
                <p className="mb-1 text-center text-xs font-semibold uppercase text-foreground-500">{d}</p>
                <div className="space-y-1">{t.sessions.filter(s => s.weekday === i + 1).map((s, j) => <div key={j} className="rounded bg-primary-50 px-1.5 py-1 text-xs ring-1 ring-primary-200">
                  <strong className="block">{short(s.startTime)} – {short(s.endTime)}</strong>
                  <span className="block capitalize text-foreground-700">{s.type}</span>
                  <span className="block truncate text-foreground-600">{s.room || "No room"}</span>
                </div>)}</div>
              </div>)}
            </div></div>
          </article>)}</div>}
        </>}
      </section>
    </div>
    {editing && course && <TemplateDrawer course={course} need={need} template={editing === "new" ? null : editing} others={templates}
      onClose={() => setEditing(null)} onSaved={name => { setEditing(null); setNotice(`Template ${name} saved.`); void loadTemplates(); }} />}
  </div>;
}

function TemplateDrawer({ course, template, others, onClose, onSaved, need }: {
  course: RtoCourse; template: CourseTiming | null; others: CourseTiming[]; onClose: () => void; onSaved: (name: string) => void; need: CourseNeed | null;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [trainerId, setTrainerId] = useState(template?.trainerStaffId ?? "");
  const [rows, setRows] = useState<Row[]>(() => (template?.sessions ?? []).map(s => ({ key: ++seq, weekday: s.weekday, startTime: short(s.startTime), endTime: short(s.endTime), type: s.type, roomId: s.roomId ?? "" })));
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [locations, setLocations] = useState<LocationRooms[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([rto<StaffOption[]>("staff_list"), rtoFlow<LocationRooms[]>("locations_rooms")])
      .then(([s, l]) => { setStaff(s); setLocations(l); })
      .catch(e => setError(e instanceof Error ? e.message : "Trainers and rooms did not load."));
  }, []);

  const nextName = useMemo(() => { for (let n = 1; ; n++) if (!others.some(o => o.name.toLowerCase() === `g${n}`)) return `G${n}`; }, [others]);
  const label = name.trim() || nextName;
  const duplicate = others.find(o => o.id !== template?.id && o.name.toLowerCase() === label.toLowerCase());
  const set = (key: number, patch: Partial<Row>) => setRows(list => list.map(r => r.key === key ? { ...r, ...patch } : r));
  const addClass = (weekday: number) => setRows(list => {
    const sameDay = list.filter(r => r.weekday === weekday).pop();
    const last = list[list.length - 1];
    let start = SLOTS[0].start, end = SLOTS[0].end;
    if (sameDay) { const next = SLOTS[Math.min(SLOTS.length - 1, SLOTS.findIndex(s => s.id === slotOf(sameDay.startTime)) + 1)]; start = next.start; end = next.end; }
    else if (last) { start = last.startTime; end = last.endTime; }
    const like = sameDay ?? last;
    return [...list, { key: ++seq, weekday, startTime: start, endTime: end, type: like?.type ?? "theory", roomId: like?.roomId ?? "" }]
      .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
  });
  const toggleDay = (weekday: number) => rows.some(r => r.weekday === weekday) ? setRows(list => list.filter(r => r.weekday !== weekday)) : addClass(weekday);
  const invalid = rows.find(r => !r.startTime || !r.endTime || r.endTime <= r.startTime);
  const overlap = rows.find((r, i) => rows.some((o, j) => j !== i && o.weekday === r.weekday && o.startTime < r.endTime && r.startTime < o.endTime));
  const days = [...new Set(rows.map(r => r.weekday))].sort((a, b) => a - b);
  const weekly = weeklyHours(rows);
  const weekTotal = weekly.theory + weekly.practical + weekly.assessment;
  const tooFew = weekTotal < TEMPLATE_MIN_HOURS;

  const save = async () => {
    if (busy || !rows.length || invalid || overlap || duplicate || tooFew || label.length > 40) return;
    setBusy(true); setError("");
    const trainer = staff.find(s => s.id === trainerId);
    const values = {
      course_id: course.id, name: label, trainer_staff_id: trainer?.id ?? null, trainer_name: trainer?.name ?? (trainerId ? template?.trainerName ?? null : null),
      sessions: rows.map(r => ({ weekday: r.weekday, slot: slotOf(r.startTime), start: r.startTime, end: r.endTime, type: r.type, roomId: r.roomId || null })),
      source: "Timetable templates",
    };
    const { error: e } = template
      ? await supabase.from("course_timing_templates").update(values).eq("id", template.id)
      : await supabase.from("course_timing_templates").insert(values);
    setBusy(false);
    if (e) { setError(e.message); return; }
    onSaved(label);
  };

  return <Drawer open width="max-w-2xl" title={template ? `Edit template · ${template.name}` : `New template · ${course.code}`} onClose={onClose}
    footer={<><Button variant="outline" onClick={onClose}>Cancel</Button>
      <Button disabled={busy || !rows.length || !!invalid || !!overlap || !!duplicate || tooFew || label.length > 40} onClick={() => void save()}>{busy ? "Saving…" : "Save template"}</Button></>}>
    <ErrorNote text={error} />
    <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <Field label="Name" hint="G1, Weekend, Evening …"><TextInput value={name} placeholder={nextName} maxLength={40} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Trainer">
        <Select value={trainerId} onChange={e => setTrainerId(e.target.value)}>
          <option value="">No trainer</option>
          {trainerId && !staff.some(s => s.id === trainerId) ? <option value={trainerId}>{template?.trainerName ?? "Trainer"}</option> : null}
          {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
    </div>
    {duplicate ? <p role="alert" className="text-sm text-primary-800">This course already has a template called {duplicate.name}.</p> : null}
    <div>
      <p className="mb-2 text-label font-medium text-foreground-800">Days and times</p>
      <div className="grid grid-cols-7 gap-1" role="group" aria-label="Class days">
        {DAYS.map((d, i) => {
          const on = rows.some(r => r.weekday === i + 1);
          return <button key={d} type="button" aria-pressed={on} onClick={() => toggleDay(i + 1)} title={on ? `Remove ${WEEKDAYS[i]} classes` : `Add a class on ${WEEKDAYS[i]}`}
            className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-lg border-2 py-2.5 text-sm font-bold shadow-sm transition-colors duration-150 ${on ? "border-primary-600 bg-primary-600 text-background-50 hover:bg-primary-700" : "border-primary-200 bg-background-50 text-primary-700 hover:border-primary-500 hover:bg-primary-50"}`}>
            <i className={(on ? "ri-checkbox-circle-fill" : "ri-add-circle-line") + " text-base"} aria-hidden="true" />{d}</button>;
        })}
      </div>
      <p className="mt-1.5 text-xs font-medium text-foreground-600">Click a day to add classes on it. Click a ticked day again to remove them.</p>
    </div>
    {days.length === 0 ? <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">No classes yet. Click a day above.</p>
    : days.map(d => <div key={d} className="rounded-md border border-background-200">
      <div className="flex items-center justify-between border-b border-background-200 bg-background-100/60 px-3 py-1.5">
        <p className="text-sm font-semibold text-foreground-900">{WEEKDAYS[d - 1]}</p>
        <button type="button" className="text-xs font-medium text-primary-600 hover:underline" onClick={() => addClass(d)}>+ Add a class</button>
      </div>
      <div className="divide-y divide-background-100">{rows.filter(r => r.weekday === d).map(r => <div key={r.key} className="space-y-2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-background-300 p-0.5" role="radiogroup" aria-label="Part of the day">
            {SLOTS.map(s => <button key={s.id} type="button" role="radio" aria-checked={slotOf(r.startTime) === s.id} onClick={() => set(r.key, { startTime: s.start, endTime: s.end })}
              className={`rounded px-2 py-1 text-xs font-medium ${slotOf(r.startTime) === s.id ? "bg-secondary-100 text-secondary-900" : "text-foreground-600 hover:bg-background-100"}`}>{s.label}</button>)}
          </div>
          <TextInput type="time" className="w-28" aria-label="Starts" value={r.startTime} onChange={e => set(r.key, { startTime: e.target.value })} />
          <span className="text-foreground-400">–</span>
          <TextInput type="time" className="w-28" aria-label="Ends" value={r.endTime} onChange={e => set(r.key, { endTime: e.target.value })} />
          <button type="button" aria-label="Remove this class" className="ml-auto rounded-md p-1.5 text-foreground-400 hover:bg-background-100 hover:text-foreground-700"
            onClick={() => setRows(list => list.filter(x => x.key !== r.key))}><i className="ri-close-line" aria-hidden="true" /></button>
        </div>
        <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <Select aria-label="Kind of class" value={r.type} onChange={e => set(r.key, { type: e.target.value as SessionType })}>
            {SESSION_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
          <Select aria-label="Room" value={r.roomId} onChange={e => set(r.key, { roomId: e.target.value })}>
            <option value="">No room yet</option>
            {locations.map(l => <optgroup key={l.id ?? "other"} label={l.name}>
              {l.rooms.filter(x => x.isActive || x.id === r.roomId).map(x => <option key={x.id} value={x.id}>{x.name}{x.capacity ? ` (${x.capacity})` : ""}</option>)}
            </optgroup>)}
          </Select>
        </div>
      </div>)}</div>
    </div>)}
    {rows.length && need?.total ? (() => { const w = weeklyHours(rows); const total = w.theory + w.practical + w.assessment; return <p className="rounded-lg border border-background-200 bg-background-100 px-3 py-2 text-sm text-foreground-800">
      This week gives <strong>{total} hours</strong> ({splitText(w) || "none"}). The course needs {need.total} SLIT hours, so it takes <strong>about {total ? Math.ceil(need.total / total) : "∞"} teaching weeks</strong>, plus term breaks and public holidays.</p>; })() : null}
    {rows.length && tooFew ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">A template needs at least {TEMPLATE_MIN_HOURS} class hours a week. This week has {weekTotal}; add {TEMPLATE_MIN_HOURS - weekTotal} more to save it.</p> : null}
    {invalid ? <p role="alert" className="text-sm text-primary-800">A class on {WEEKDAYS[invalid.weekday - 1]} ends before it starts.</p> : null}
    {overlap && !invalid ? <p role="alert" className="text-sm text-primary-800">Two classes on {WEEKDAYS[overlap.weekday - 1]} overlap.</p> : null}
  </Drawer>;
}
