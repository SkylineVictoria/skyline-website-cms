// LMS › Courses › a course › Weekly TimeTable (owner, 2026-11-20): the weekly timetable made for each of the course's intakes
// (rooms, trainers and class times from the intake's Select weekly timetable), Monday to Sunday, read only. "Change" opens the
// intake. The late joiners' (prerequisite) class setup stays below it.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DAYS, loadIntakeLoads, rto, shortDate, type BatchSession, type IntakeDetail, type RtoIntake, type StaffOption, type StudyLoad } from "@/pages/admin/lib/rto";
import PrerequisiteClassTab from "./PrerequisiteClassTab";
import BatchCourseCalendar from "./BatchCourseCalendar";

const LOOK: Record<string, string> = {
  theory: "border-l-sky-500 bg-sky-50",
  practical: "border-l-amber-500 bg-amber-50",
  assessment: "border-l-emerald-500 bg-emerald-50",
};
const TYPE: Record<string, string> = { theory: "Theory", practical: "Practical", assessment: "Assessment" };
const clock = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "pm" : "am"}`; };
const hours = (list: BatchSession[]) => list.reduce((sum, s) => { const [a, b] = [s.startTime, s.endTime].map((t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; }); return sum + Math.max(0, b - a) / 60; }, 0);

export default function CourseWeeklyTimetable({ courseId, intakes, canEdit }: { courseId: string; intakes: RtoIntake[]; canEdit: boolean }) {
  const open = intakes.filter((i) => i.status !== "closed");
  const [weeks, setWeeks] = useState<Record<string, BatchSession[]> | null>(null);
  const [groups, setGroups] = useState<Record<string, string>>({});
  /** Each intake shows its week (the classes by weekday) or its whole calendar; the week first (owner 2026-11-28: weekly calendar). */
  const [view, setView] = useState<Record<string, "calendar" | "week">>({});
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [error, setError] = useState("");
  const ids = open.map((i) => i.id).join(",");

  useEffect(() => {
    let live = true;
    setWeeks(null); setError("");
    void Promise.all([Promise.all(open.map((i) => rto<IntakeDetail>("intake_get", { intakeId: i.id }))), rto<StaffOption[]>("staff_list").catch(() => [])])
      .then(([details, s]) => {
        if (!live) return;
        setStaff(s);
        setWeeks(Object.fromEntries(details.map((d) => [d.intake.id, d.batches[0]?.sessions ?? []])));
        setGroups(Object.fromEntries(details.filter((d) => d.batches[0]).map((d) => [d.intake.id, d.batches[0].id])));
      }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "The timetables did not load."); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the intakes
  }, [ids]);

  const trainer = (id?: string | null) => (id ? staff.find((x) => x.id === id)?.name ?? "Trainer" : "");

  return <div className="space-y-5">
    {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    {!open.length ? <div className="rounded-xl border border-dashed border-background-300 p-6 text-center text-sm text-foreground-600">
      No intake yet. The weekly timetable is made with the intake (new course wizard, steps 5–7).</div>
      : !weeks ? <p className="text-sm text-foreground-500">Loading the weekly timetables…</p>
      : open.map((i) => {
        const list = [...(weeks[i.id] ?? [])].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
        return <section key={i.id} className="overflow-hidden rounded-xl border border-background-200 bg-background-50">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-background-200 bg-background-100 px-4 py-3">
            <div className="min-w-0">
              <h3 className="truncate font-heading text-base font-bold text-foreground-950">{i.customName || i.name}</h3>
              <p className="text-xs text-foreground-600">{shortDate(i.startDate)}{i.endDate ? ` – ${shortDate(i.endDate)}` : ""} · {list.length ? `${list.length} class time${list.length === 1 ? "" : "s"} · ${Math.round(hours(list) * 10) / 10} hrs a week` : "no weekly timetable yet"}</p>
            </div>
            <span className="flex flex-wrap items-center gap-2">
            {list.length && groups[i.id] ? <span className="inline-flex overflow-hidden rounded-lg border border-background-300 text-xs font-semibold" role="group" aria-label="View">
              {(["calendar", "week"] as const).map((v) => <button key={v} type="button" aria-pressed={(view[i.id] ?? "week") === v} onClick={() => setView((m) => ({ ...m, [i.id]: v }))}
                className={`px-3 py-1.5 ${(view[i.id] ?? "week") === v ? "bg-primary-600 text-white" : "bg-background-50 text-foreground-700 hover:bg-background-100"}`}>{v === "calendar" ? "Calendar" : "Week"}</button>)}
            </span> : null}
            {canEdit ? <Link to={`/admin/lms/intakes#${i.id}`} className="rounded-lg border border-background-300 px-3 py-1.5 text-sm font-semibold text-foreground-800 hover:bg-background-200">
              <i className="ri-edit-line mr-1" aria-hidden="true" />{list.length ? "Change" : "Make it"}</Link> : null}
            </span>
          </header>
          {list.length && groups[i.id] && (view[i.id] ?? "week") === "calendar" ? <div className="p-3">
            <BatchCourseCalendar batchId={groups[i.id]} courseId={courseId} intakeStart={i.startDate} intakeEnd={i.endDate} hasSlots canManage={canEdit} reloadKey={0} />
          </div> : list.length ? <div className="overflow-x-auto">
            <div className="grid min-w-[700px] grid-cols-7 divide-x divide-background-200">
              {DAYS.map((d, n) => {
                const today = list.filter((s) => s.weekday === n + 1);
                return <div key={d} className="min-h-28">
                  <p className="border-b border-background-200 py-1.5 text-center text-xs font-semibold uppercase tracking-wide text-foreground-600">{d}</p>
                  <div className="space-y-1.5 p-1.5">{today.length ? today.map((s, k) => (
                    <div key={k} className={`rounded border-l-4 px-1.5 py-1.5 text-[11px] leading-snug ${LOOK[s.type] ?? "border-l-background-400 bg-background-100"}`}>
                      <p className="font-semibold text-foreground-950">{clock(s.startTime.slice(0, 5))} – {clock(s.endTime.slice(0, 5))}</p>
                      <p className="text-foreground-700">{TYPE[s.type] ?? s.type}</p>
                      <p className="break-words text-foreground-700"><i className="ri-door-open-line mr-1" aria-hidden="true" />{s.room ?? "No room"}</p>
                      <p className={`break-words ${s.trainerId ? "text-foreground-700" : "font-semibold text-red-700"}`}><i className="ri-user-line mr-1" aria-hidden="true" />{trainer(s.trainerId) || "No trainer"}</p>
                    </div>)) : <p className="py-4 text-center text-xs text-foreground-400">No class</p>}</div>
                </div>;
              })}
            </div>
          </div> : null}
        </section>;
      })}
    <details className="rounded-xl border border-background-200">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-foreground-800">Late joiners' class (prerequisite units)</summary>
      <div className="border-t border-background-200 p-4"><PrerequisiteClassTab courseId={courseId} canEdit={canEdit} /></div>
    </details>
  </div>;
}

/** Course › CoE Daily Timetable / VoE Daily Timetable (owner, 2026-11-20): the timetable booked in course setup for the course's
 *  CoE intakes, or for its VoE intakes (the intake's study load says which). */
export function DailyTimetableTab({ courseId, intakes, canEdit, load }: { courseId: string; intakes: RtoIntake[]; canEdit: boolean; load: StudyLoad }) {
  const [loads, setLoads] = useState<Record<string, StudyLoad> | null>(null);
  useEffect(() => {
    let live = true;
    void loadIntakeLoads(courseId).then(m => { if (live) setLoads(m); }).catch(() => { if (live) setLoads({}); });
    return () => { live = false; };
  }, [courseId, intakes.length]);
  if (!loads) return <p className="text-sm text-foreground-500">Loading the timetables…</p>;
  const mine = intakes.filter(i => (loads[i.id] ?? "coe") === load);
  const name = load === "coe" ? "CoE" : "VoE";
  if (!mine.some(i => i.status !== "closed")) return <p className="rounded-lg border border-background-200 bg-background-100/60 px-3 py-4 text-sm text-foreground-600">
    No open {name} intake yet. Finish course setup ({name} weekly classes) to book its daily timetable.</p>;
  return <CourseWeeklyTimetable courseId={courseId} intakes={mine} canEdit={canEdit} />;
}
