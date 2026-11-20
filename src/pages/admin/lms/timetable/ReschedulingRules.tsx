// Administration › Business Rules & Policies › Timetable: what the system tries when a class can't run.
// Admins / RTO Managers set reasons, the steps for each reason in order with their limits, the general rules and the message.
// One default set for every course; a course can have its own set.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ruleList, ruleNumber, ruleObject, weekdayIndex } from "@/lib/businessRules";
import { Button, Select, TextInput } from "@/pages/admin/components/ui";
import { addDays, loadClassSessions, todayIso, type ClassSession } from "@/pages/admin/lib/rto";
import {
  candidateLine, candidateTitle, DAY, reschedule, STEP_HELP, STEP_LABEL,
  type Reason, type Rules, type RulesData, type Step, type StepType, type Suggestion,
} from "@/pages/admin/lib/reschedule";

const ALL_STEPS = Object.keys(STEP_LABEL) as StepType[];
/** A new step's starting limits come from Business Rules (lms.reschedule_new_day_*, _join_extra_seats, _spread_limits). */
const newStep = (t: StepType): Step => {
  const hours = ruleObject("lms.reschedule_new_day_hours", { earliest: "08:00", latest: "21:00" });
  const spread = ruleObject("lms.reschedule_spread_limits", { addAt: "end", classes: 4, extraMinutes: 60 });
  const days = ruleList("lms.reschedule_new_day_weekdays", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]).map(weekdayIndex).filter((d) => d >= 0).sort();
  const steps: Record<StepType, Step> = {
    other_trainer: { type: "other_trainer", on: true, onlyCourseTrainers: true },
    other_room: { type: "other_room", on: true, minSeats: "group" },
    same_day_other_time: { type: "same_day_other_time", on: true, earliest: String(hours.earliest), latest: String(hours.latest) },
    another_day: { type: "another_day", on: true, days, withinDays: ruleNumber("lms.reschedule_new_day_search_days", 14), earliest: String(hours.earliest), latest: String(hours.latest) },
    join_other_intake: { type: "join_other_intake", on: true, maxExtraSeats: ruleNumber("lms.reschedule_join_extra_seats", 6) },
    spread: { type: "spread", on: true, maxExtraMinutes: Number(spread.extraMinutes), maxClasses: Number(spread.classes), addAt: spread.addAt === "start" ? "start" : "end" },
    online: { type: "online", on: false, international: false },
  };
  return steps[t];
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `reason_${Date.now()}`;

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-emerald-500" : "bg-background-300"}`}>
    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} /></button>;
}
const num = "w-20";

function Limits({ s, set }: { s: Step; set: (s: Step) => void }) {
  const lab = "flex items-center gap-1.5 text-xs text-foreground-700";
  const times = <>
    <label className={lab}>From<TextInput type="time" className="w-28" value={s.earliest ?? "08:00"} onChange={(e) => set({ ...s, earliest: e.target.value })} /></label>
    <label className={lab}>to<TextInput type="time" className="w-28" value={s.latest ?? "21:00"} onChange={(e) => set({ ...s, latest: e.target.value })} /></label>
  </>;
  switch (s.type) {
    case "other_trainer": return <label className={lab}><input type="checkbox" checked={s.onlyCourseTrainers ?? true} onChange={(e) => set({ ...s, onlyCourseTrainers: e.target.checked })} />Only trainers on this course or unit</label>;
    case "other_room": return <label className={lab}>Seats<Select value={s.minSeats ?? "group"} onChange={(e) => set({ ...s, minSeats: e.target.value as "group" | "any" })}><option value="group">Enough for the group</option><option value="any">Any room</option></Select></label>;
    case "same_day_other_time": return times;
    case "another_day": return <>
      <span className="flex flex-wrap gap-1">{DAY.map((d, i) => { const on = (s.days ?? []).includes(i); return <button key={d} type="button" aria-pressed={on}
        onClick={() => set({ ...s, days: on ? (s.days ?? []).filter((x) => x !== i) : [...(s.days ?? []), i].sort() })}
        className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${on ? "border-primary-500 bg-primary-50 text-primary-700" : "border-background-300 text-foreground-500"}`}>{d}</button>; })}</span>
      <label className={lab}>Within<TextInput type="number" min={1} max={90} className={num} value={s.withinDays ?? 14} onChange={(e) => set({ ...s, withinDays: Number(e.target.value) })} />days</label>
      {times}
      <span className="text-xs text-foreground-500">Always before the unit ends.</span>
    </>;
    case "join_other_intake": return <label className={lab}>Group of up to<TextInput type="number" min={1} className={num} value={s.maxExtraSeats ?? 6} onChange={(e) => set({ ...s, maxExtraSeats: Number(e.target.value) })} />students</label>;
    case "spread": return <>
      <label className={lab}>Up to<TextInput type="number" min={15} step={15} className={num} value={s.maxExtraMinutes ?? 60} onChange={(e) => set({ ...s, maxExtraMinutes: Number(e.target.value) })} />extra minutes a class</label>
      <label className={lab}>over the next<TextInput type="number" min={1} max={20} className={num} value={s.maxClasses ?? 4} onChange={(e) => set({ ...s, maxClasses: Number(e.target.value) })} />classes</label>
      <label className={lab}>Add time<Select value={s.addAt ?? "end"} onChange={(e) => set({ ...s, addAt: e.target.value as "end" | "start" })}><option value="end">at the end</option><option value="start">at the start</option></Select></label>
    </>;
    case "online": return <label className={lab}><input type="checkbox" checked={s.international ?? false} onChange={(e) => set({ ...s, international: e.target.checked })} />Allowed when the group has international students</label>;
  }
}

export default function ReschedulingRules() {
  const [data, setData] = useState<RulesData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [course, setCourse] = useState("");
  const [rules, setRules] = useState<Rules | null>(null);
  const [own, setOwn] = useState(false);
  const [sel, setSel] = useState(0);
  const [tab, setTab] = useState<"steps" | "message">("steps");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tryOpen, setTryOpen] = useState(false);

  const load = () => reschedule<RulesData>("rules_get").then((d) => { setData(d); setError(""); }).catch((e) => setError(e instanceof Error ? e.message : "The rules did not load."));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!data) return;
    const c = course ? data.courses.find((x) => x.courseId === course) : null;
    setRules(clone(c?.own && c.rules ? c.rules : data.default));
    setOwn(course ? !!c?.own : true);
    setSel(0); setDirty(false);
  }, [data, course]);

  const update = (fn: (r: Rules) => void) => { if (!rules) return; const r = clone(rules); fn(r); setRules(r); setDirty(true); setNotice(""); };
  const reason: Reason | undefined = rules?.reasons[sel];
  const unused = useMemo(() => ALL_STEPS.filter((t) => !reason?.steps.some((s) => s.type === t)), [reason]);

  const save = async () => {
    if (!rules) return;
    setBusy(true); setError("");
    try {
      await reschedule("rules_save", { courseId: course || null, rules });
      setNotice(course ? "Saved: this course now uses its own rules." : "Saved: every course without its own rules uses these.");
      setDirty(false); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "The rules were not saved."); }
    finally { setBusy(false); }
  };
  const removeOverride = async () => {
    if (!course || !window.confirm("Remove this course's own rules? It will use the default rules.")) return;
    setBusy(true);
    try { await reschedule("rules_save", { courseId: course, remove: true }); setNotice("This course uses the default rules again."); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not removed."); } finally { setBusy(false); }
  };

  if (error && !data) return <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!data || !rules) return <p role="status" className="text-sm text-foreground-500">Loading rules…</p>;
  const canEdit = data.canEdit && (own || !course);
  const steps = reason?.steps ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold text-foreground-950">Class rescheduling rules</h2>
          <p className="text-sm text-foreground-600">Choose what the timetable tries when a class cannot run. Saving applies your changes immediately.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setTryOpen(true)}>Try on a class…</Button>
          {canEdit ? <Button disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save rules"}</Button> : null}
        </div>
      </div>
      {notice ? <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[230px_1fr_320px]">
        <aside className="space-y-3 rounded-xl border border-background-200 bg-background-50 p-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-foreground-500">Rule set
            <Select className="mt-1 w-full" value={course} onChange={(e) => { if (dirty && !window.confirm("Leave without saving?")) return; setCourse(e.target.value); }}>
              <option value="">Default (all courses)</option>
              {data.courses.map((c) => <option key={c.courseId} value={c.courseId}>{c.code} {c.own ? "· own rules" : ""}</option>)}
            </Select></label>
          {course && !own ? <div className="rounded-lg bg-background-100 p-2 text-xs text-foreground-600">This course uses the default rules.
            {data.canEdit ? <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => { setOwn(true); setDirty(true); }}>Give it its own rules</Button> : null}</div> : null}
          {course && own && data.courses.find((c) => c.courseId === course)?.own ? <Button size="sm" variant="ghost" className="w-full text-red-700" onClick={() => void removeOverride()}>Use the default rules</Button> : null}
          <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-foreground-500">Reasons</p>
          <ul className="space-y-1">
            {rules.reasons.map((r, i) => <li key={r.key}>
              <button type="button" onClick={() => setSel(i)} className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm ${i === sel ? "bg-primary-50 font-semibold text-primary-700" : "text-foreground-700 hover:bg-background-100"}`}>
                <span className="truncate">{r.label}</span><span className="text-xs text-foreground-500">{r.steps.filter((s) => s.on).length} steps</span></button></li>)}
          </ul>
          {canEdit ? <Button size="sm" variant="outline" className="w-full" icon="ri-add-line" onClick={() => {
            const label = window.prompt("Name of the reason (e.g. Trainer at training)")?.trim();
            if (!label) return;
            update((r) => { r.reasons.push({ key: keyOf(label) + (r.reasons.some((x) => x.key === keyOf(label)) ? `_${r.reasons.length}` : ""), label, steps: [newStep("another_day")] }); });
            setSel(rules.reasons.length);
          }}>Add reason</Button> : null}
        </aside>

        <section className="rounded-xl border border-background-200 bg-background-50 p-4">
          {reason ? <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {canEdit ? <TextInput aria-label="Reason name" className="max-w-xs font-semibold" value={reason.label} onChange={(e) => update((r) => { r.reasons[sel].label = e.target.value; })} />
                : <h3 className="font-semibold">{reason.label}</h3>}
              {canEdit && rules.reasons.length > 1 ? <Button size="sm" variant="ghost" className="text-red-700" onClick={() => {
                if (!window.confirm(`Remove the reason ${reason.label}?`)) return; update((r) => { r.reasons.splice(sel, 1); }); setSel(0); }}>Remove reason</Button> : null}
            </div>
            <div role="tablist" className="mt-3 flex gap-1 border-b border-background-200">
              {(["steps", "message"] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-semibold ${tab === t ? "border-primary-500 text-primary-700" : "border-transparent text-foreground-600"}`}>{t === "steps" ? "Steps tried in order" : "Message"}</button>)}
            </div>
            {tab === "steps" ? <div className="mt-3 space-y-2">
              <p className="text-xs text-foreground-500">The first step that finds a time is used. Every step checks the room, trainer, group, holidays, term breaks, time off and the unit's dates.</p>
              {steps.map((st, i) => <div key={st.type} className={`rounded-lg border p-3 ${st.on ? "border-background-200 bg-white" : "border-dashed border-background-300 bg-background-100/50"}`}>
                <div className="flex items-center gap-3">
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${st.on ? "bg-primary-500" : "bg-background-400"}`}>{st.on ? steps.slice(0, i + 1).filter((x) => x.on).length : "–"}</span>
                  <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground-950">{STEP_LABEL[st.type]}</p><p className="text-xs text-foreground-500">{STEP_HELP[st.type]}</p></div>
                  {canEdit ? <div className="flex items-center gap-1">
                    <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => update((r) => { const s = r.reasons[sel].steps; [s[i - 1], s[i]] = [s[i], s[i - 1]]; })} className="rounded p-1 text-foreground-500 hover:bg-background-100 disabled:opacity-30"><i className="ri-arrow-up-line" aria-hidden="true" /></button>
                    <button type="button" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => update((r) => { const s = r.reasons[sel].steps; [s[i + 1], s[i]] = [s[i], s[i + 1]]; })} className="rounded p-1 text-foreground-500 hover:bg-background-100 disabled:opacity-30"><i className="ri-arrow-down-line" aria-hidden="true" /></button>
                    <button type="button" aria-label="Remove step" onClick={() => update((r) => { r.reasons[sel].steps.splice(i, 1); })} className="rounded p-1 text-foreground-500 hover:bg-background-100"><i className="ri-delete-bin-line" aria-hidden="true" /></button>
                    <Toggle on={st.on} label={`${STEP_LABEL[st.type]} on`} onChange={(v) => update((r) => { r.reasons[sel].steps[i].on = v; })} />
                  </div> : null}
                </div>
                {st.on ? <fieldset disabled={!canEdit} className="mt-2 flex flex-wrap items-center gap-3 pl-10"><Limits s={st} set={(n) => update((r) => { r.reasons[sel].steps[i] = n; })} /></fieldset> : null}
              </div>)}
              {canEdit && unused.length ? <Select aria-label="Add step" value="" onChange={(e) => { const t = e.target.value as StepType; if (t) update((r) => { r.reasons[sel].steps.push(newStep(t)); }); }}>
                <option value="">+ Add step…</option>{unused.map((t) => <option key={t} value={t}>{STEP_LABEL[t]}</option>)}</Select> : null}
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"><span className="font-semibold">Nothing works:</span> the class goes on <span className="font-semibold">Classes to reschedule</span> and a person picks the time. Always last.</div>
            </div> : <fieldset disabled={!canEdit} className="mt-3 space-y-3">
              <p className="text-xs text-foreground-500">The same message is used for every reason. Words in double braces are filled in: {"{{unit}} {{old}} {{new}} {{room}} {{note}}"}.</p>
              <label className="block text-xs font-semibold">When a class moves: subject<TextInput className="mt-1 w-full" value={rules.notify.subject} onChange={(e) => update((r) => { r.notify.subject = e.target.value; })} /></label>
              <label className="block text-xs font-semibold">Message<textarea rows={5} className="mt-1 w-full rounded-md border border-background-300 bg-background-50 p-2 text-sm" value={rules.notify.body} onChange={(e) => update((r) => { r.notify.body = e.target.value; })} /></label>
              <label className="block text-xs font-semibold">When it waits for a new time: subject<TextInput className="mt-1 w-full" value={rules.notify.waitingSubject} onChange={(e) => update((r) => { r.notify.waitingSubject = e.target.value; })} /></label>
              <label className="block text-xs font-semibold">Message<textarea rows={4} className="mt-1 w-full rounded-md border border-background-300 bg-background-50 p-2 text-sm" value={rules.notify.waitingBody} onChange={(e) => update((r) => { r.notify.waitingBody = e.target.value; })} /></label>
            </fieldset>}
          </> : null}
        </section>

        <aside className="space-y-4">
          <fieldset disabled={!canEdit} className="rounded-xl border border-background-200 bg-background-50 p-4">
            <legend className="px-1 font-semibold">General rules</legend>
            {([
              ["Cancel a class without a make-up", <Select key="c" value={rules.general.allowCancel ? "yes" : "no"} onChange={(e) => update((r) => { r.general.allowCancel = e.target.value === "yes"; })}><option value="no">Never allowed</option><option value="yes">Allowed</option></Select>],
              ["The intake end date may move", <span key="e" className="text-sm font-semibold text-foreground-700">No, never</span>],
              ["Who can reschedule", <Select key="w" value={rules.general.who} onChange={(e) => update((r) => { r.general.who = e.target.value as Rules["general"]["who"]; })}><option value="rto_manager">RTO Managers</option><option value="rto_manager_and_trainers">RTO Managers and the class's trainers</option></Select>],
              ["When a step finds a time", <Select key="m" value={rules.general.mode} onChange={(e) => update((r) => { r.general.mode = e.target.value as Rules["general"]["mode"]; })}><option value="suggest">Suggest it, staff click Accept</option><option value="apply">Apply it straight away</option></Select>],
              ["A course can be completed with classes waiting", <Select key="u" value={rules.general.unitFinishWithWaiting ? "yes" : "no"} onChange={(e) => update((r) => { r.general.unitFinishWithWaiting = e.target.value === "yes"; })}><option value="no">No</option><option value="yes">Yes</option></Select>],
            ] as [string, ReactNode][]).map(([label, ctl]) => <div key={label} className="border-b border-background-100 py-2 last:border-0"><p className="mb-1 text-sm text-foreground-700">{label}</p>{ctl}</div>)}
          </fieldset>
          <fieldset disabled={!canEdit} className="rounded-xl border border-background-200 bg-background-50 p-4">
            <legend className="px-1 font-semibold">Tell people</legend>
            {([["Students", "students"], ["Trainers", "trainers"], ["By email", "email"], ["By text (when connected)", "sms"]] as const).map(([label, k]) =>
              <div key={k} className="flex items-center justify-between border-b border-background-100 py-2 text-sm last:border-0">{label}
                <Toggle label={label} on={rules.notify[k]} onChange={(v) => update((r) => { r.notify[k] = v; })} /></div>)}
          </fieldset>
        </aside>
      </div>
      {tryOpen ? <TryOnClass reasons={rules.reasons} dirty={dirty} onClose={() => setTryOpen(false)} /> : null}
    </div>
  );
}

/** Runs the saved rules on a real upcoming class without changing anything. */
function TryOnClass({ reasons, dirty, onClose }: { reasons: Reason[]; dirty: boolean; onClose: () => void }) {
  const [classes, setClasses] = useState<ClassSession[] | null>(null);
  const [id, setId] = useState("");
  const [reason, setReason] = useState(reasons[0]?.key ?? "");
  const [out, setOut] = useState<Suggestion | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadClassSessions(null, addDays(todayIso(), 1), addDays(todayIso(), 42)).then((r) => setClasses(r.filter((c) => c.status === "scheduled").slice(0, 300))).catch(() => setClasses([])); }, []);
  const go = async () => {
    setBusy(true); setError(""); setOut(null);
    try { setOut(await reschedule<Suggestion>("suggest", { sessionId: id, reason })); }
    catch (e) { setError(e instanceof Error ? e.message : "Did not run."); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-foreground-950/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Try the rules on a class" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-background-50 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between"><h3 className="font-heading text-lg font-semibold">Try the rules on a class</h3>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button></div>
        <p className="text-sm text-foreground-600">Shows what would happen. Nothing is changed and nobody is told.</p>
        {dirty ? <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Uses the saved rules: save your changes first to try them.</p> : null}
        <label className="mt-3 block text-xs font-semibold">Class (next 6 weeks)
          <Select className="mt-1 w-full" value={id} onChange={(e) => { setId(e.target.value); setOut(null); }}>
            <option value="">{classes ? "Choose a class…" : "Loading…"}</option>
            {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.date} {c.startTime.slice(0, 5)} · {c.courseCode} {c.unitCode ?? ""} · {c.batch}</option>)}
          </Select></label>
        <label className="mt-3 block text-xs font-semibold">Reason
          <Select className="mt-1 w-full" value={reason} onChange={(e) => { setReason(e.target.value); setOut(null); }}>{reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select></label>
        <Button className="mt-3" disabled={!id || !reason || busy} onClick={() => void go()}>{busy ? "Trying…" : "Try"}</Button>
        {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
        {out ? <div className="mt-3 space-y-2 text-sm">
          {out.tried.map((t, i) => <p key={i} className={t.found ? "font-semibold text-emerald-700" : "text-red-700"}>{t.found ? "✓" : "✕"} {STEP_LABEL[t.step]}{t.found ? `: ${t.found} found` : `: ${t.why ?? "nothing free"}`}</p>)}
          {out.candidates[0] ? <div className="rounded-lg border-2 border-emerald-400 bg-emerald-50 p-3"><p className="text-xs font-semibold uppercase text-emerald-700">Would suggest</p>
            <p className="font-semibold">{candidateTitle(out.candidates[0])}</p><p className="text-foreground-700">{candidateLine(out.candidates[0])}</p></div>
            : <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Nothing found: the class would go on Classes to reschedule.</p>}
        </div> : null}
      </div>
    </div>
  );
}
